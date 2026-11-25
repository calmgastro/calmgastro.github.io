/* A purchase (or the opening balance) was recorded in the wrong warehouse: correct where it was received.
   It is a correction of history, not a move of boxes (that is a transfer): after it, everything is as if the purchase had been
   received in the other warehouse. Nothing is sold, bought or re-priced; the two warehouses together keep the same boxes.

   Purchase B goes from warehouse A to warehouse W:
   · its boxes still in A go to W; boxes of it already in W (transferred) stay there;
   · boxes of it used by A's orders / adjustments are charged to A's other purchases instead (oldest first);
   · before the two warehouses were separated (migration 0015) there was one common stock, so W's orders delivered then may be
     charged to A's purchases («borrowed»): those are charged to B first, and A gets its boxes back;
   · when A cannot spare the boxes, uses from before the separation stay as they are; more than that → 409 purchase_warehouse_short.
   Costs follow the purchase that is charged (COGS of the orders concerned is recomputed; unchanged when the unit costs are equal). */
import { HttpError } from "./orders.js";
import { auditStmt } from "./auth.js";
import { batchOut, batchIn, getBalance, checkAlert } from "./inventory.js";
import { isWarehouse, whOf } from "./warehouses.js";

const pieceCost = (b, q) => b.unit_cost_halalas != null ? b.unit_cost_halalas * q : b.total_cost_halalas == null ? null : Math.round(b.total_cost_halalas * q / b.quantity_received);
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);

async function plan(db, b, to) {
  const from = whOf(b), product = b.product_id;
  const [balFrom, balTo, batches, stock, uses, base] = await Promise.all([
    getBalance(db, product, from), getBalance(db, product, to),
    db.prepare("SELECT * FROM inventory_batches WHERE product_id = ? ORDER BY received_at, id").bind(product).all(),
    db.prepare("SELECT s.batch_id, s.quantity FROM inventory_batch_stock s JOIN inventory_batches x ON x.id = s.batch_id WHERE x.product_id = ? AND s.warehouse_id = ? AND s.quantity > 0").bind(product, from).all(),
    db.prepare(`SELECT c.*, COALESCE(o.warehouse_id, a.warehouse_id) warehouse_id FROM inventory_consumptions c JOIN inventory_batches x ON x.id = c.batch_id
      LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN inventory_adjustments a ON a.id = c.adjustment_id WHERE x.product_id = ? AND c.reversed_at IS NULL ORDER BY c.created_at, c.id`).bind(product).all(),
    db.prepare("SELECT MAX(created_at) at FROM inventory_baselines WHERE product_id = ?").bind(product).first()
  ]);
  if (!balFrom || !balTo) throw new HttpError(409, { error: "not_initialized" });
  const byId = new Map(batches.results.map(x => [x.id, x])), legacy = c => !!base.at && c.created_at < base.at;
  const inFrom = sum(stock.results.filter(s => s.batch_id === b.id), s => s.quantity);
  const usedHere = uses.results.filter(c => c.batch_id === b.id && whOf(c) === from);
  const borrowed = uses.results.filter(c => c.batch_id !== b.id && whOf(c) === to && legacy(c) && whOf(byId.get(c.batch_id)) === from);
  const used = sum(usedHere, c => c.quantity), available = balFrom.on_hand - balFrom.reserved, m = inFrom + used;
  let swap = Math.min(sum(borrowed, c => c.quantity), m), keep = 0;
  if (m - swap > available) keep = Math.min(sum(usedHere.filter(legacy), c => c.quantity), m - swap - available);
  swap = Math.min(swap, m - keep);
  const moved = m - keep - swap;
  if (moved > available) throw new HttpError(409, { error: "purchase_warehouse_short", warehouse: from, needed: moved, available });

  // each row of `changes` is a use (consumption) and the purchases it is charged to
  const changes = [], freed = new Map(), taken = new Map();
  let left = swap;
  for (const c of borrowed) {                        // W's old orders: charged to B, the boxes of A's purchase come back
    const q = Math.min(left, c.quantity);
    if (!q) break;
    freed.set(c.batch_id, (freed.get(c.batch_id) || 0) + q);
    left -= q;
    changes.push({ c, parts: [{ batch: b.id, q }, ...(q < c.quantity ? [{ batch: c.batch_id, q: c.quantity - q }] : [])] });
  }
  const pool = batches.results.filter(x => x.id !== b.id)
    .map(x => ({ batch: x.id, q: (freed.get(x.id) || 0) + sum(stock.results.filter(s => s.batch_id === x.id), s => s.quantity) })).filter(x => x.q > 0);
  let stay = keep;
  for (const c of usedHere) {
    const k = legacy(c) ? Math.min(stay, c.quantity) : 0;
    let need = c.quantity - k;
    stay -= k;
    if (!need) continue;
    const parts = k ? [{ batch: b.id, q: k }] : [];
    for (const p of pool) {
      const q = Math.min(need, p.q);
      if (!q) continue;
      p.q -= q; need -= q;
      parts.push({ batch: p.batch, q });
      taken.set(p.batch, (taken.get(p.batch) || 0) + q);
    }
    if (need) throw new HttpError(409, { error: "purchase_warehouse_short", warehouse: from, needed: moved, available });
    changes.push({ c, parts });
  }
  const cost = list => list.some(x => x == null) ? null : sum(list, x => x);
  const before = cost(changes.map(x => x.c.cost_halalas)), after = cost(changes.flatMap(x => x.parts.map(p => pieceCost(byId.get(p.batch), p.q))));
  // a total-only purchase spreads its rounding over its units: the same cost up to a halala is the same cost
  const costChange = !changes.length ? 0 : before == null || after == null ? null : after - before;
  return { from, byId, balFrom, balTo, inFrom, used, keep, swap, moved, replaced: used - keep, changes, freed, taken, costChange };
}

export async function movePurchase(env, ctx, id, body) {
  if (!ctx.perms.has("inventory.purchase.edit")) throw new HttpError(403, { error: "forbidden", permission: "inventory.purchase.edit" });
  const db = env.DB, to = String(body && body.warehouse || ""), fin = ctx.perms.has("finance.view");
  if (!isWarehouse(to)) throw new HttpError(422, { error: "validation", fields: { warehouse: "invalid" } });
  const b = await db.prepare("SELECT * FROM inventory_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  if (!["PURCHASE", "OPENING"].includes(b.source)) throw new HttpError(409, { error: "not_a_purchase" });
  if (b.voided_at) throw new HttpError(409, { error: "purchase_voided" });
  if (Number(body.version) !== b.version) throw new HttpError(409, { error: "record_changed", version: b.version });
  if (whOf(b) === to) return { ok: true, changed: false, version: b.version };
  const p = await plan(db, b, to), orders = new Set(p.changes.filter(x => x.c.order_id).map(x => x.c.order_id));
  const out = { from: p.from, to, quantity: b.quantity_received, moved: p.moved, chargedToOld: p.swap, replaced: p.replaced, kept: p.keep, ordersChanged: orders.size,
    ...(fin ? { costChange: p.costChange == null ? null : p.costChange / 100 } : {}), after: { [p.from]: p.balFrom.on_hand - p.moved, [to]: p.balTo.on_hand + p.moved } };
  if (body.preview === true) return { preview: true, version: b.version, ...out };

  const t = new Date().toISOString(), v = b.version + 1, actor = ctx.user.username, uid = ctx.user.id, product = b.product_id;
  // anything that moved since the plan was made aborts the whole transaction (CHECK on_hand >= 0)
  const same = bal => db.prepare("UPDATE inventory_balances SET on_hand = -1 WHERE product_id = ? AND warehouse_id = ? AND (on_hand <> ? OR reserved <> ? OR updated_at <> ?)")
    .bind(product, bal.warehouse_id, bal.on_hand, bal.reserved, bal.updated_at);
  const stmts = [
    same(p.balFrom), same(p.balTo),
    db.prepare("UPDATE inventory_batches SET warehouse_id = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?, version = ? WHERE id = ? AND version = ? AND voided_at IS NULL").bind(to, t, actor, uid, v, b.id, b.version),
    db.prepare("UPDATE inventory_balances SET on_hand = -1 WHERE product_id = ? AND warehouse_id = ? AND changes() = 0").bind(product, p.from)
  ];
  if (p.inFrom) stmts.push(batchOut(db, b.id, p.from, p.inFrom));
  if (p.moved) stmts.push(batchIn(db, b.id, to, p.moved));
  const remaining = new Map([[b.id, p.moved - p.inFrom]]);
  for (const [bid, q] of p.freed) { stmts.push(batchIn(db, bid, p.from, q)); remaining.set(bid, (remaining.get(bid) || 0) + q); }
  for (const [bid, q] of p.taken) { stmts.push(batchOut(db, bid, p.from, q)); remaining.set(bid, (remaining.get(bid) || 0) - q); }
  for (const [bid, d] of remaining) if (d) stmts.push(db.prepare("UPDATE inventory_batches SET quantity_remaining = quantity_remaining + ? WHERE id = ?").bind(d, bid));
  for (const { c, parts } of p.changes) parts.forEach((x, i) => {
    const cost = pieceCost(p.byId.get(x.batch), x.q);
    stmts.push(i ? db.prepare("INSERT INTO inventory_consumptions (order_id, adjustment_id, batch_id, quantity, cost_halalas, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(c.order_id, c.adjustment_id, x.batch, x.q, cost, c.created_at)
      : db.prepare("UPDATE inventory_consumptions SET batch_id = ?, quantity = ?, cost_halalas = ? WHERE id = ?").bind(x.batch, x.q, cost, c.id));
  });
  if (p.costChange !== 0) for (const oid of orders) stmts.push(db.prepare(`UPDATE inventory_reservations SET
      cogs_halalas = (SELECT SUM(cost_halalas) FROM inventory_consumptions WHERE order_id = ?1 AND reversed_at IS NULL),
      cogs_complete = (SELECT COUNT(*) = COUNT(cost_halalas) FROM inventory_consumptions WHERE order_id = ?1 AND reversed_at IS NULL), updated_at = ?2
    WHERE order_id = ?1 AND product_id = ?3 AND status = 'COMMITTED'`).bind(oid, t, product));
  const label = `${b.source === "OPENING" ? "الرصيد الافتتاحي" : "شراء #" + b.batch_no}: تصحيح المستودع`;
  for (const [wh, d] of [[p.from, -p.moved], [to, p.moved]]) {
    stmts.push(db.prepare("UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand + ?, updated_at = ? WHERE product_id = ? AND warehouse_id = ?").bind(d, d, t, product, wh));
    if (d) stmts.push(db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
        reference, notes, actor, user_id, idempotency_key, created_at, warehouse_id)
      SELECT ?, 'ADJUSTMENT', ?, ?, b.on_hand - ?, b.on_hand, b.reserved, b.reserved, b.on_hand - ? - b.reserved, b.on_hand - b.reserved, 'PURCHASE_WAREHOUSE', ?, ?, ?, ?, ?, b.warehouse_id
      FROM inventory_balances b WHERE b.product_id = ? AND b.warehouse_id = ?`)
      .bind(product, p.moved, b.id, d, d, label, actor, uid, `purchase-warehouse:${b.id}:${v}:${d < 0 ? "out" : "in"}`, t, product, wh));
  }
  stmts.push(auditStmt(env, ctx, "purchase_warehouse_changed", "inventory_batch", b.id, { batch: b.batch_no, warehouse: p.from, version: b.version },
    { batch: b.batch_no, warehouse: to, version: v, moved: p.moved, chargedToOld: p.swap, replaced: p.replaced, kept: p.keep, costChange: p.costChange == null ? undefined : p.costChange / 100 }));
  try { await db.batch(stmts); }
  catch (e) {
    if (/CHECK constraint failed/i.test(e.message)) throw new HttpError(409, { error: "record_changed" });
    throw e;
  }
  await checkAlert(db, product);
  return { ok: true, changed: true, version: v, ...out };
}
