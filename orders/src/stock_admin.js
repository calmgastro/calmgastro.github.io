/* Admin → المخزون: overview, receipts, adjustments, shortages, settings, opening balance, integrity check.
   Stock movements themselves are built by inventory.js; this file validates input, checks permissions and shapes output.
   Purchase costs and stock value are returned only to admins with finance.view. */
import { HttpError, normalizeOrderNumber } from "./orders.js";
import { auditStmt } from "./auth.js";
import { DEFAULT_PRODUCT, SETTINGS, getSettings, getBalance, levelFor, fifoPlan, fifoPieceCost, checkAlert, runWithRetry,
         initializeInventory, ruleOf, toHalalas, riyadhDay, addDays, periodOf, validDay, NO_GUARD } from "./inventory.js";

const need = (ctx, perm) => { if (!ctx.perms.has(perm)) throw new HttpError(403, { error: "forbidden", permission: perm }); };
const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
export const sar = h => h == null ? null : Math.round(h) / 100;
// exact unit cost when stored; for an older total-only batch, total ÷ quantity
const unitCost = b => b.unit_cost_halalas != null ? sar(b.unit_cost_halalas) : b.total_cost_halalas == null ? null : sar(b.total_cost_halalas / b.quantity_received);
// value of the units still in a batch, consistent with how FIFO charges consumed units
export const remainingValue = b => b.total_cost_halalas == null ? null : b.total_cost_halalas - Math.round(b.total_cost_halalas * (b.quantity_received - b.quantity_remaining) / b.quantity_received);

export async function stockSummary(env, ctx) {
  const db = env.DB, fin = ctx.perms.has("finance.view");
  const b = await getBalance(db), s = await getSettings(db);
  if (!b) {
    const first = await db.prepare("SELECT MIN(created_at) first, COUNT(*) n FROM orders").first();
    const firstDay = first.first ? riyadhDay(first.first) : null;
    return { initialized: false, settings: s, firstOrderDay: firstDay, suggestedOpeningDate: firstDay ? addDays(firstDay, -1) : riyadhDay(now()), existingOrders: first.n };
  }
  const available = b.on_hand - b.reserved;
  const [sh, batches, alert] = await Promise.all([
    db.prepare("SELECT COUNT(*) n, COALESCE(SUM(shortage_qty), 0) units FROM inventory_reservations WHERE status = 'SHORTAGE'").first(),
    fin ? db.prepare("SELECT * FROM inventory_batches WHERE product_id = ? AND quantity_remaining > 0").bind(DEFAULT_PRODUCT).all() : Promise.resolve({ results: [] }),
    db.prepare("SELECT * FROM inventory_alerts WHERE acknowledged_at IS NULL AND level <> 'NONE' ORDER BY id DESC LIMIT 1").first()
  ]);
  const values = batches.results.map(remainingValue);
  return {
    initialized: true, product: DEFAULT_PRODUCT, onHand: b.on_hand, reserved: b.reserved, available, sold: b.sold, flow: await stockFlow(db),
    level: levelFor(available, s), lowStockThreshold: s.lowStockThreshold, criticalStockThreshold: s.criticalStockThreshold,
    shortageOrders: sh.n, shortageUnits: sh.units, costingMethod: s.costingMethod, settings: s,
    stockValue: fin ? sar(values.reduce((a, v) => a + (v || 0), 0)) : undefined, stockValueComplete: fin ? values.every(v => v != null) : undefined,
    alert: alert ? { id: alert.id, level: alert.level, available: alert.available, at: alert.created_at } : null
  };
}

export async function inventoryPage(env, ctx, params) {
  need(ctx, "inventory.view");
  const db = env.DB, fin = ctx.perms.has("finance.view"), summary = await stockSummary(env, ctx);
  if (!summary.initialized) return { summary };
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1), per = 50;
  const type = params.get("type"), where = [], binds = [];
  if (/^[A-Z_]{3,20}$/.test(type || "")) { where.push("t.type = ?"); binds.push(type); }
  const num = normalizeOrderNumber(params.get("order") || "");
  if (num) { where.push("o.order_number = ?"); binds.push(num); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const [batches, tx, txCount, shortages, adjustments] = await Promise.all([
    db.prepare("SELECT * FROM inventory_batches WHERE product_id = ? ORDER BY received_at, id").bind(DEFAULT_PRODUCT).all(),
    db.prepare(`SELECT t.*, o.order_number FROM inventory_transactions t LEFT JOIN orders o ON o.id = t.order_id ${w} ORDER BY t.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    db.prepare(`SELECT COUNT(*) n FROM inventory_transactions t LEFT JOIN orders o ON o.id = t.order_id ${w}`).bind(...binds).first(),
    shortageRows(env),
    db.prepare("SELECT * FROM inventory_adjustments ORDER BY id DESC LIMIT 100").all()
  ]);
  return {
    summary,
    batches: batches.results.map(b => ({ id: b.id, batchNo: b.batch_no, source: b.source, receivedAt: b.received_at, quantityReceived: b.quantity_received,
      quantityRemaining: b.quantity_remaining, supplier: b.supplier, reference: b.reference, location: b.location, notes: b.notes, createdBy: b.created_by, createdAt: b.created_at,
      status: b.voided_at ? "VOIDED" : b.quantity_remaining === 0 ? "DEPLETED" : b.quantity_remaining === b.quantity_received ? "FULL" : "PARTIAL",
      ...(fin ? { unitCost: unitCost(b), totalCost: sar(b.total_cost_halalas), stockValue: sar(remainingValue(b)), costKnown: b.total_cost_halalas != null } : {}) })),
    transactions: tx.results.map(t => ({ id: t.id, at: t.created_at, type: t.type, quantity: t.quantity, orderNumber: t.order_number, batchId: t.batch_id,
      onHandBefore: t.on_hand_before, onHandAfter: t.on_hand_after, reservedBefore: t.reserved_before, reservedAfter: t.reserved_after,
      availableBefore: t.available_before, availableAfter: t.available_after, reference: t.reference, notes: t.notes, actor: t.actor,
      ...(fin ? { cost: sar(t.cost_halalas) } : {}) })),
    transactionsTotal: txCount.n, page, per,
    shortages,
    receipts: batches.results.filter(b => b.source !== "ADJUSTMENT").slice().reverse().slice(0, 30).map(b => ({ ...purchaseRow(b, fin), quantity: b.quantity_received, by: b.created_by, at: b.created_at })),
    adjustments: adjustments.results.map(a => ({ id: a.id, quantity: a.quantity, oldOnHand: a.old_on_hand, newOnHand: a.new_on_hand, reason: a.reason, notes: a.notes, by: a.created_by, at: a.created_at })),
    settingOptions: Object.fromEntries(Object.entries(SETTINGS).filter(([, v]) => v.type === "enum").map(([k, v]) => [k, v.values])),
    canManage: ctx.perms.has("inventory.manage"), canSeeCosts: fin, ...purchasePerms(ctx)
  };
}

export async function shortageRows(env) {
  const b = await getBalance(env.DB), available = b ? b.on_hand - b.reserved : 0;
  const rows = (await env.DB.prepare(`SELECT r.*, o.order_number, o.created_at order_created, o.customer_name, o.status order_status, o.source
    FROM inventory_reservations r JOIN orders o ON o.id = r.order_id WHERE r.status = 'SHORTAGE' ORDER BY o.created_at`).all()).results;
  return rows.map(r => ({ orderNumber: r.order_number, orderDate: r.order_created, customer: r.customer_name, source: r.source, requested: r.requested_qty,
    reserved: r.reserved_qty, shortage: r.shortage_qty, availableAtOrder: r.available_at_order, currentAvailable: available, orderStatus: r.order_status,
    inventoryStatus: r.status, canAllocate: available > 0 }));
}

/* ---------- opening balance (once) ---------- */
export async function initStock(env, ctx, body) {
  need(ctx, "inventory.manage");
  const r = await initializeInventory(env, ctx, body || {});
  const fin = ctx.perms.has("finance.view");
  return { ...r, totalCost: fin ? sar(r.totalCostHalalas) : undefined, unitCost: fin ? sar(r.unitCostHalalas) : undefined, totalCostHalalas: undefined, unitCostHalalas: undefined,
    orders: r.orders.map(o => ({ ...o, cogs: undefined })) };
}

/* ---------- receipt: a new batch; the unit cost is always computed here from the total ---------- */
export async function receiveStock(env, ctx, body) {
  need(ctx, "inventory.purchase.create");
  const db = env.DB, product = DEFAULT_PRODUCT;
  if (!(await getBalance(db, product))) throw new HttpError(409, { error: "not_initialized" });
  // the cost may be entered later (daily receipts): no unit cost / total stores the batch without cost, added later by editing it
  const qty = Number(body.quantity), date = String(body.receivedDate || "");
  const errors = {};
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) errors.quantity = "invalid";
  const c = receiptCost(body, Number.isInteger(qty) && qty > 0 ? qty : 1);
  if (c.error) errors[c.error] = "invalid";
  const total = c.total, unit = c.unit;
  if (!validDay(date)) errors.receivedDate = "invalid";
  const ordered = body.quantityOrdered == null || body.quantityOrdered === "" ? null : Number(body.quantityOrdered);
  if (ordered != null && (!Number.isInteger(ordered) || ordered < 1)) errors.quantityOrdered = "invalid";
  const key = String(body.requestId || "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) errors.requestId = "invalid";
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  const t = now(), actor = ctx.user.username, uid = ctx.user.id;
  const f = { supplier: clean(body.supplier, 120), reference: clean(body.reference, 120), location: clean(body.location, 120), notes: clean(body.notes, 500) };
  const batchId = "(SELECT MAX(id) FROM inventory_batches WHERE product_id = ?)";
  try {
    await db.batch([
      db.prepare(`INSERT INTO inventory_batches (product_id, batch_no, source, received_at, quantity_ordered, quantity_received, quantity_remaining, total_cost_halalas, unit_cost_halalas,
          supplier, reference, location, notes, created_by, user_id, created_at)
        SELECT ?, COALESCE(MAX(batch_no), 0) + 1, 'PURCHASE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM inventory_batches WHERE product_id = ?`)
        .bind(product, date, ordered, qty, qty, total, unit, f.supplier, f.reference, f.location, f.notes, actor, uid, t, product),
      db.prepare("UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand + ?, updated_at = ? WHERE product_id = ?").bind(qty, qty, t, product),
      db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
          cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
        SELECT ?, 'PURCHASE_RECEIPT', ?, ${batchId}, b.on_hand - ?, b.on_hand, b.reserved, b.reserved, b.on_hand - ? - b.reserved, b.on_hand - b.reserved, ?, ?, ?, ?, ?, ?, ?
        FROM inventory_balances b WHERE b.product_id = ?`)
        .bind(product, qty, product, qty, qty, total, f.reference, f.notes, actor, uid, "receipt:" + key, t, product),
      auditStmt(env, ctx, "stock_received", "inventory", product, null, { quantity: qty, unitCost: sar(unit), totalCost: sar(total), receivedDate: date, supplier: f.supplier || undefined, reference: f.reference || undefined })
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed: inventory_transactions\.idempotency_key/i.test(e.message)) return { replay: true };
    throw e;
  }
  await checkAlert(db, product);
  const b = await db.prepare("SELECT id FROM inventory_batches WHERE product_id = ? AND created_at = ? AND created_by = ? ORDER BY id DESC").bind(product, t, actor).first();
  return { replay: false, id: b && b.id, quantity: qty, unitCost: total == null ? null : sar(unit != null ? unit : total / qty), totalCost: sar(total) };
}

/* ---------- manual adjustment (never edits a number directly: always a ledger row) ---------- */
export const ADJUST_REASONS = ["DAMAGED", "EXPIRED", "COUNT_CORRECTION", "LOST", "FOUND", "OTHER"];
export async function adjustStock(env, ctx, body) {
  need(ctx, "inventory.manage");
  const db = env.DB, product = DEFAULT_PRODUCT;
  const bal = await getBalance(db, product);
  if (!bal) throw new HttpError(409, { error: "not_initialized" });
  const qty = Number(body.quantity), reason = String(body.reason || ""), notes = clean(body.notes, 500), key = String(body.requestId || "");
  const errors = {};
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 1000000) errors.quantity = "invalid";
  if (!ADJUST_REASONS.includes(reason)) errors.reason = "required";
  if (reason === "OTHER" && notes.length < 3) errors.notes = "required";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) errors.requestId = "invalid";
  const unitTotal = body.totalCost == null || body.totalCost === "" ? null : toHalalas(body.totalCost);
  if (unitTotal === undefined) errors.totalCost = "invalid";
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  if (qty < 0 && bal.on_hand - bal.reserved < -qty)
    throw new HttpError(409, { error: "adjustment_exceeds_available", available: bal.on_hand - bal.reserved, reserved: bal.reserved, onHand: bal.on_hand });
  const actor = ctx.user.username, uid = ctx.user.id, label = reason + (notes ? " · " + notes : "");
  const build = async () => {
    const t = now(), stmts = [
      db.prepare(`INSERT INTO inventory_adjustments (product_id, quantity, old_on_hand, new_on_hand, reason, notes, created_by, user_id, created_at)
        SELECT ?, ?, on_hand, on_hand + ?, ?, ?, ?, ?, ? FROM inventory_balances WHERE product_id = ?`).bind(product, qty, qty, reason, notes, actor, uid, t, product),
      db.prepare("UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand + ?, updated_at = ? WHERE product_id = ?").bind(qty, qty, t, product)
    ];
    const adj = "(SELECT MAX(id) FROM inventory_adjustments)";
    let cost = null, batchSql = "NULL", batchBinds = [];
    if (qty < 0) {
      const plan = await fifoPlan(db, product, -qty);
      cost = plan.some(p => p.cost == null) ? null : plan.reduce((a, p) => a + p.cost, 0);
      for (const p of plan) {
        stmts.push(db.prepare("UPDATE inventory_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ?").bind(p.q, p.batchId));
        stmts.push(db.prepare(`INSERT INTO inventory_consumptions (adjustment_id, batch_id, quantity, cost_halalas, created_at) VALUES (${adj}, ?, ?, ?, ?)`).bind(p.batchId, p.q, p.cost, t));
      }
    } else {
      stmts.push(db.prepare(`INSERT INTO inventory_batches (product_id, batch_no, source, received_at, quantity_received, quantity_remaining, total_cost_halalas, notes, created_by, user_id, created_at)
        SELECT ?, COALESCE(MAX(batch_no), 0) + 1, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?, ? FROM inventory_batches WHERE product_id = ?`)
        .bind(product, riyadhDay(t), qty, qty, unitTotal, label, actor, uid, t, product));
      batchSql = "(SELECT MAX(id) FROM inventory_batches WHERE product_id = ?)"; batchBinds = [product];
      cost = unitTotal;
    }
    stmts.push(db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, adjustment_id, on_hand_before, on_hand_after, reserved_before, reserved_after,
        available_before, available_after, cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
      SELECT ?, 'ADJUSTMENT', ?, ${batchSql}, ${adj}, b.on_hand - ?, b.on_hand, b.reserved, b.reserved, b.on_hand - ? - b.reserved, b.on_hand - b.reserved, ?, ?, ?, ?, ?, ?, ?
      FROM inventory_balances b WHERE b.product_id = ?`)
      .bind(product, Math.abs(qty), ...batchBinds, qty, qty, cost, reason, label, actor, uid, "adjust:" + key, t, product));
    stmts.push(auditStmt(env, ctx, "stock_adjusted", "inventory", product, { onHand: bal.on_hand }, { quantity: qty, reason, notes, newOnHand: bal.on_hand + qty }));
    return stmts;
  };
  try { await runWithRetry(build, db); }
  catch (e) {
    if (/UNIQUE constraint failed: inventory_transactions\.idempotency_key/i.test(e.message)) return { replay: true };
    if (e instanceof HttpError && e.body.error === "insufficient_stock") throw new HttpError(409, { error: "adjustment_exceeds_available" });
    throw e;
  }
  await checkAlert(db, product);
  return { replay: false, onHand: bal.on_hand + qty };
}

/* ---------- a batch whose cost was not entered (typically the opening stock): set it once ----------
   COGS already stored for orders that consumed this batch is recalculated in the same transaction, and the change is a
   COST_UPDATE ledger row + audit entry — the only time a stored COGS changes. */
export async function setBatchCost(env, ctx, id, body) {
  need(ctx, "inventory.manage"); need(ctx, "finance.view");
  const db = env.DB, b = await db.prepare("SELECT * FROM inventory_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  if (b.total_cost_halalas != null) throw new HttpError(409, { error: "cost_already_set" });
  const total = toHalalas(body.totalCost);
  if (total === undefined) throw new HttpError(422, { error: "validation", fields: { totalCost: "invalid" } });
  const cons = (await db.prepare("SELECT * FROM inventory_consumptions WHERE batch_id = ? ORDER BY id").bind(b.id).all()).results;
  const t = now(), stmts = [db.prepare("UPDATE inventory_batches SET total_cost_halalas = ? WHERE id = ? AND total_cost_halalas IS NULL").bind(total, b.id)];
  let used = 0;
  for (const c of cons) {
    const cost = fifoPieceCost({ quantity_received: b.quantity_received, quantity_remaining: b.quantity_received - used, total_cost_halalas: total }, c.quantity);
    used += c.quantity;
    stmts.push(db.prepare("UPDATE inventory_consumptions SET cost_halalas = ? WHERE id = ?").bind(cost, c.id));
  }
  const orders = [...new Set(cons.filter(c => c.order_id).map(c => c.order_id))];
  for (const o of orders) stmts.push(db.prepare(`UPDATE inventory_reservations SET
      cogs_halalas = (SELECT SUM(cost_halalas) FROM inventory_consumptions WHERE order_id = ?1 AND reversed_at IS NULL),
      cogs_complete = (SELECT COUNT(*) = COUNT(cost_halalas) FROM inventory_consumptions WHERE order_id = ?1 AND reversed_at IS NULL), updated_at = ?2
    WHERE order_id = ?1 AND status = 'COMMITTED'`).bind(o, t));
  stmts.push(db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
      cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
    SELECT product_id, 'COST_UPDATE', 0, ?, on_hand, on_hand, reserved, reserved, on_hand - reserved, on_hand - reserved, ?, 'batch ' || ?, ?, ?, ?, ?, ? FROM inventory_balances WHERE product_id = ?`)
    .bind(b.id, total, b.batch_no, `cost set; ${orders.length} order(s) COGS recalculated`, ctx.user.username, ctx.user.id, `cost:${b.id}`, t, b.product_id));
  stmts.push(auditStmt(env, ctx, "batch_cost_set", "inventory_batch", b.id, { totalCostHalalas: null }, { totalCostHalalas: total, ordersRecalculated: orders.length }));
  await db.batch(stmts);
  return { ok: true, unitCost: sar(total / b.quantity_received), ordersRecalculated: orders.length };
}

/* ---------- stock by availability ----------
   Boxes are not promised to orders by date: whichever order is shipped first takes them. The only shortage shown is the
   total — what is in the warehouse against what the orders not shipped yet need (dashboard and stock page). */
const WITH_CARRIER = `(o.status IN ('SHIPPED','OUT_FOR_DELIVERY') OR (o.status = 'ON_HOLD' AND EXISTS (SELECT 1 FROM shipment_orders s WHERE s.order_id = o.id AND s.removed_at IS NULL)))`;
export async function stockFlow(db) {
  const b = await getBalance(db);
  if (!b) return null;
  const r = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${WITH_CARRIER} THEN o.boxes END), 0) cb, COALESCE(SUM(CASE WHEN ${WITH_CARRIER} THEN 1 END), 0) co,
      COALESCE(SUM(CASE WHEN NOT ${WITH_CARRIER} THEN o.boxes END), 0) pb, COALESCE(SUM(CASE WHEN NOT ${WITH_CARRIER} THEN 1 END), 0) po
    FROM orders o WHERE o.status IN ('RECEIVED','CONFIRMED','PREPARING','SHIPPED','OUT_FOR_DELIVERY','ON_HOLD')`).first();
  const inWarehouse = b.on_hand - r.cb, left = inWarehouse - r.pb;
  return { onHand: b.on_hand, inWarehouse, withCarrier: { orders: r.co, boxes: r.cb }, pending: { orders: r.po, boxes: r.pb },
    remaining: Math.max(0, left), short: Math.max(0, -left) };
}

/* An order that leaves (shipped / delivered) takes its boxes from the warehouse: free stock first, then boxes held for orders
   that have not shipped yet (newest first) — those simply wait for the next receipt. Called before the status change.
   Returns { taken, missing }: missing > 0 only when the warehouse itself holds fewer boxes than are leaving. */
export async function claimStock(env, ctx, o) {
  const db = env.DB;
  const r = await db.prepare("SELECT * FROM inventory_reservations WHERE order_id = ? AND status = 'SHORTAGE'").bind(o.id).first();
  if (!r) return { taken: 0, missing: 0 };
  const p = r.product_id, bal = await getBalance(db, p);
  const free = Math.max(0, Math.min(r.shortage_qty, bal.on_hand - bal.reserved));
  let need = r.shortage_qty - free;
  const donors = [];
  if (need > 0) {
    const rows = (await db.prepare(`SELECT r.id, r.order_id, r.reserved_qty, o.order_number FROM inventory_reservations r JOIN orders o ON o.id = r.order_id
      WHERE r.product_id = ? AND r.status IN ('RESERVED','SHORTAGE') AND r.reserved_qty > 0 AND r.order_id <> ? AND o.status IN ('RECEIVED','CONFIRMED','PREPARING','ON_HOLD')
        AND NOT EXISTS (SELECT 1 FROM shipment_orders s WHERE s.order_id = o.id AND s.removed_at IS NULL)
      ORDER BY o.created_at DESC, o.id DESC`).bind(p, o.id).all()).results;
    for (const d of rows) { if (!need) break; const q = Math.min(need, d.reserved_qty); donors.push({ ...d, q }); need -= q; }
  }
  const total = free + donors.reduce((a, d) => a + d.q, 0);
  if (!total) return { taken: 0, missing: r.shortage_qty };
  const t = now(), actor = ctx.user.username, uid = ctx.user.id;
  // aborts the whole batch (CHECK on_hand >= 0) when the statement before it changed nothing: someone else moved first
  const abort = () => db.prepare("UPDATE inventory_balances SET on_hand = -1 WHERE product_id = ? AND changes() = 0").bind(p);
  const tx = (type, qty, orderId, rBefore, note, key) => db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, order_id, on_hand_before, on_hand_after,
      reserved_before, reserved_after, available_before, available_after, reference, notes, actor, user_id, idempotency_key, created_at)
    SELECT ?, ?, ?, ?, b.on_hand, b.on_hand, b.reserved + ?, b.reserved, b.on_hand - b.reserved - ?, b.on_hand - b.reserved, 'reallocation', ?, ?, ?, ?, ?
    FROM inventory_balances b WHERE b.product_id = ?`).bind(p, type, qty, orderId, rBefore, rBefore, note, actor, uid, key, t, p);
  const stmts = [
    db.prepare("UPDATE orders SET updated_at = ? WHERE id = ? AND updated_at = ?").bind(t, o.id, o.updated_at), abort(),
    ...donors.flatMap(d => [
      db.prepare(`UPDATE inventory_reservations SET reserved_qty = reserved_qty - ?, shortage_qty = shortage_qty + ?, status = 'SHORTAGE', updated_at = ?
        WHERE id = ? AND reserved_qty >= ? AND status IN ('RESERVED','SHORTAGE')`).bind(d.q, d.q, t, d.id, d.q), abort(),
      db.prepare("UPDATE inventory_balances SET reserved = reserved - ?, updated_at = ? WHERE product_id = ?").bind(d.q, t, p),
      tx("RELEASE", d.q, d.order_id, d.q, `نُقل إلى ${o.order_number} (شُحن قبله)`, `realloc:${d.order_id}:${o.id}:${t}`)]),
    db.prepare("UPDATE inventory_balances SET reserved = reserved + ?, updated_at = ? WHERE product_id = ?").bind(total, t, p),
    db.prepare(`UPDATE inventory_reservations SET reserved_qty = reserved_qty + ?, shortage_qty = shortage_qty - ?,
        status = CASE WHEN shortage_qty - ? = 0 THEN 'RESERVED' ELSE 'SHORTAGE' END, updated_at = ? WHERE id = ? AND status = 'SHORTAGE' AND shortage_qty >= ?`)
      .bind(total, total, total, t, r.id, total), abort(),
    tx("RESERVATION", total, o.id, -total, [free ? `من المتوفر ${free}` : "", ...donors.map(d => `من ${d.order_number} (${d.q})`)].filter(Boolean).join("، "), `claim:${o.id}:${t}`),
    auditStmt(env, ctx, "stock_claimed", "order", o.order_number, { reserved: r.reserved_qty, missing: r.shortage_qty },
      { taken: total, free, from: donors.map(d => ({ order: d.order_number, boxes: d.q })) })
  ];
  try { await db.batch(stmts); }
  catch (e) { if (/CHECK constraint failed/i.test(e.message)) return { taken: 0, missing: r.shortage_qty }; throw e; }
  await checkAlert(db, p);
  return { taken: total, missing: r.shortage_qty - total };
}

/* ---------- shortage order: reserve what has arrived since (never changes the order status) ---------- */
export async function allocateOrder(env, ctx, number) {
  need(ctx, "inventory.manage");
  const n = normalizeOrderNumber(number);
  const o = n && await env.DB.prepare("SELECT * FROM orders WHERE order_number = ?").bind(n).first();
  if (!o) throw new HttpError(404, { error: "not_found" });
  return allocateShortage(env, ctx, o);
}
/* also used when a shipped shortage order is confirmed as delivered (permission checked by the caller) */
export async function allocateShortage(env, ctx, o) {
  const db = env.DB;
  if (ruleOf(o.status) !== "RESERVE") throw new HttpError(409, { error: "order_not_open" });
  const r = await db.prepare("SELECT * FROM inventory_reservations WHERE order_id = ? AND status = 'SHORTAGE'").bind(o.id).first();
  if (!r) throw new HttpError(409, { error: "no_shortage" });
  const bal = await getBalance(db, r.product_id);
  if (bal.on_hand - bal.reserved <= 0) throw new HttpError(409, { error: "insufficient_stock", available: 0, shortage: r.shortage_qty });
  const t = now(), g = { sql: "EXISTS (SELECT 1 FROM orders WHERE id = ? AND updated_at = ?)", binds: [o.id, t] }, p = r.product_id;
  const res = await db.batch([
    db.prepare("UPDATE orders SET updated_at = ? WHERE id = ? AND updated_at = ?").bind(t, o.id, o.updated_at),
    db.prepare(`UPDATE inventory_balances SET last_delta = MIN(?, on_hand - reserved), reserved = reserved + MIN(?, on_hand - reserved), updated_at = ? WHERE product_id = ? AND ${g.sql}`)
      .bind(r.shortage_qty, r.shortage_qty, t, p, ...g.binds),
    db.prepare(`UPDATE inventory_reservations SET reserved_qty = reserved_qty + (SELECT last_delta FROM inventory_balances WHERE product_id = ?),
        shortage_qty = shortage_qty - (SELECT last_delta FROM inventory_balances WHERE product_id = ?),
        status = CASE WHEN shortage_qty - (SELECT last_delta FROM inventory_balances WHERE product_id = ?) = 0 THEN 'RESERVED' ELSE 'SHORTAGE' END, updated_at = ?
      WHERE id = ? AND status = 'SHORTAGE' AND ${g.sql}`).bind(p, p, p, t, r.id, ...g.binds),
    db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, order_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
        reference, notes, actor, user_id, idempotency_key, created_at)
      SELECT ?, 'RESERVATION', b.last_delta, ?, b.on_hand, b.on_hand, b.reserved - b.last_delta, b.reserved, b.on_hand - b.reserved + b.last_delta, b.on_hand - b.reserved,
        'shortage_allocation', '', ?, ?, ?, ? FROM inventory_balances b WHERE b.product_id = ? AND ${g.sql}`)
      .bind(p, o.id, ctx.user.username, ctx.user.id, `allocate:${o.id}:${t}`, t, p, ...g.binds),
    auditStmt(env, ctx, "shortage_allocated", "order", o.order_number, { reserved: r.reserved_qty, shortage: r.shortage_qty }, { available: bal.on_hand - bal.reserved })
  ]);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "order_changed" });
  await checkAlert(db, p);
  const after = await db.prepare("SELECT * FROM inventory_reservations WHERE id = ?").bind(r.id).first();
  return { orderNumber: o.order_number, reserved: after.reserved_qty, shortage: after.shortage_qty, status: after.status };
}

/* ---------- settings ---------- */
export async function saveSettings(env, ctx, body) {
  need(ctx, "inventory.manage");
  const db = env.DB, old = await getSettings(db), t = now(), stmts = [], changed = {};
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (!(key in (body || {}))) continue;
    let v = body[key];
    if (def.type === "int") { v = Number(v); if (!Number.isInteger(v) || v < def.min || v > def.max) throw new HttpError(422, { error: "validation", fields: { [key]: "invalid" } }); }
    else if (!def.values.includes(v)) throw new HttpError(422, { error: "validation", fields: { [key]: "invalid" } });
    stmts.push(db.prepare("UPDATE inventory_settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?").bind(String(v), ctx.user.username, t, key));
    changed[key] = v;
  }
  const low = changed.low_stock_threshold ?? old.lowStockThreshold, crit = changed.critical_stock_threshold ?? old.criticalStockThreshold;
  if (crit > low) throw new HttpError(422, { error: "validation", fields: { critical_stock_threshold: "above_low" } });
  if (!stmts.length) return getSettings(db);
  stmts.push(auditStmt(env, ctx, "inventory_settings_changed", "inventory", DEFAULT_PRODUCT, old, changed));
  await db.batch(stmts);
  await checkAlert(db);
  return getSettings(db);
}

export async function ackAlert(env, ctx, id) {
  need(ctx, "inventory.view");
  // acknowledging the latest alert also closes the older ones it supersedes
  await env.DB.prepare("UPDATE inventory_alerts SET acknowledged_by = ?, acknowledged_at = ? WHERE id <= ? AND acknowledged_at IS NULL").bind(ctx.user.username, now(), Number(id)).run();
  return { ok: true };
}

/* ---------- integrity check: recompute everything from the ledger and the batches ---------- */
export async function reconcileStock(env, ctx) {
  need(ctx, "inventory.view");
  const db = env.DB, b = await getBalance(db);
  if (!b) return { initialized: false };
  const sums = await db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN type IN ('OPENING_BALANCE','PURCHASE_RECEIPT','RETURN') THEN quantity END), 0)
      + COALESCE(SUM(CASE WHEN type = 'ADJUSTMENT' THEN on_hand_after - on_hand_before END), 0)
      - COALESCE(SUM(CASE WHEN type = 'SALE' THEN quantity END), 0) on_hand,
      COALESCE(SUM(CASE WHEN type = 'SALE' THEN quantity END), 0) - COALESCE(SUM(CASE WHEN type IN ('RETURN','WRITE_OFF') THEN quantity END), 0) sold
    FROM inventory_transactions WHERE product_id = ?`).bind(DEFAULT_PRODUCT).first();
  const res = await db.prepare("SELECT COALESCE(SUM(reserved_qty), 0) n FROM inventory_reservations WHERE status IN ('RESERVED','SHORTAGE') AND product_id = ?").bind(DEFAULT_PRODUCT).first();
  const batches = await db.prepare("SELECT COALESCE(SUM(quantity_remaining), 0) n FROM inventory_batches WHERE product_id = ?").bind(DEFAULT_PRODUCT).first();
  const checks = {
    onHandFromLedger: { expected: sums.on_hand, actual: b.on_hand }, soldFromLedger: { expected: sums.sold, actual: b.sold },
    reservedFromReservations: { expected: res.n, actual: b.reserved }, onHandFromBatches: { expected: batches.n, actual: b.on_hand }
  };
  return { ok: Object.values(checks).every(c => c.expected === c.actual), checks, available: b.on_hand - b.reserved };
}

export { NO_GUARD };

/* ---------- stock purchases: list, edit, void ----------
   A purchase is its inventory batch (source PURCHASE, or the OPENING balance). Its value = quantity × unit cost: the API
   takes the unit cost and computes the total (a database trigger refuses any row where they disagree). Only an older
   batch recorded with an invoice total that does not divide evenly has no exact unit cost; editing it asks for one. */
const MAX_QTY = 1000000, MAX_UNIT = 10000000;     // 100,000 SAR a unit
const has = v => v != null && v !== "";
function receiptCost(body, qty) {
  if (has(body.unitCost)) {
    const u = toHalalas(body.unitCost);
    return u === undefined || u <= 0 || u > MAX_UNIT ? { error: "unitCost" } : { unit: u, total: u * qty };
  }
  if (has(body.totalCost)) {                       // older clients: a total; its unit cost is kept exact when it divides evenly
    const t = toHalalas(body.totalCost);
    return t === undefined || t > MAX_UNIT * qty ? { error: "totalCost" } : { unit: t > 0 && t % qty === 0 ? t / qty : null, total: t };
  }
  return { unit: null, total: null };
}
const purchasePerms = ctx => ({ canCreatePurchase: ctx.perms.has("inventory.purchase.create"), canEditPurchase: ctx.perms.has("inventory.purchase.edit"),
  canVoidPurchase: ctx.perms.has("inventory.purchase.void") });
function purchaseRow(b, fin) {
  return { id: b.id, batchNo: b.batch_no, source: b.source, product: b.product_id, productName: b.product_name, receivedAt: b.received_at,
    quantityReceived: b.quantity_received, remaining: b.quantity_remaining, used: b.voided_at ? 0 : b.quantity_received - b.quantity_remaining, quantityOrdered: b.quantity_ordered,
    supplier: b.supplier, reference: b.reference, location: b.location, notes: b.notes, createdBy: b.created_by, createdAt: b.created_at,
    updatedBy: b.updated_by, updatedAt: b.updated_at, version: b.version, voided: !!b.voided_at, voidedAt: b.voided_at, voidedBy: b.voided_by, voidReason: b.void_reason,
    ...(fin ? { unitCost: unitCost(b), unitCostExact: b.unit_cost_halalas != null, totalCost: sar(b.total_cost_halalas), costKnown: b.total_cost_halalas != null } : {}) };
}

const PURCHASE_STATUS = { active: "b.voided_at IS NULL", voided: "b.voided_at IS NOT NULL", all: "1" };
export async function listPurchases(env, ctx, params) {
  need(ctx, "inventory.view");
  const db = env.DB, fin = ctx.perms.has("finance.view"), where = ["b.source IN ('OPENING','PURCHASE')"], binds = [];
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1), per = 50;
  if (params.get("range")) { const p = periodOf(params); where.push("substr(b.received_at, 1, 10) >= ? AND substr(b.received_at, 1, 10) < ?"); binds.push(p.from, p.to); }
  const status = PURCHASE_STATUS[params.get("status")] ? params.get("status") : "active";
  where.push(PURCHASE_STATUS[status]);
  if (["OPENING", "PURCHASE"].includes(params.get("source"))) { where.push("b.source = ?"); binds.push(params.get("source")); }
  const product = params.get("product");
  if (/^[a-z0-9_-]{2,40}$/.test(product || "")) { where.push("b.product_id = ?"); binds.push(product); }
  const supplier = clean(params.get("supplier"), 120);
  if (supplier) { where.push("b.supplier = ?"); binds.push(supplier); }
  const q = clean(params.get("q"), 60);
  if (q) { const l = "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%"; where.push("(b.reference LIKE ? ESCAPE '\\' OR b.notes LIKE ? ESCAPE '\\' OR b.supplier LIKE ? ESCAPE '\\')"); binds.push(l, l, l); }
  if (fin) {                                       // value filters only for admins who may see costs
    const min = has(params.get("min")) ? toHalalas(params.get("min")) : null, max = has(params.get("max")) ? toHalalas(params.get("max")) : null;
    if (min === undefined || max === undefined || (min != null && max != null && min > max)) throw new HttpError(422, { error: "validation", fields: { valueRange: "invalid" } });
    if (min != null) { where.push("b.total_cost_halalas >= ?"); binds.push(min); }
    if (max != null) { where.push("b.total_cost_halalas <= ?"); binds.push(max); }
    if (params.get("cost") === "missing") where.push("b.total_cost_halalas IS NULL");
  }
  const w = "WHERE " + where.join(" AND ");
  const [rows, totals, suppliers, products] = await Promise.all([
    db.prepare(`SELECT b.*, p.name product_name FROM inventory_batches b JOIN products p ON p.id = b.product_id ${w}
      ORDER BY b.received_at DESC, b.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN b.voided_at IS NULL THEN b.quantity_received END), 0) units,
        COALESCE(SUM(CASE WHEN b.voided_at IS NULL THEN b.total_cost_halalas END), 0) value, COALESCE(SUM(b.voided_at IS NULL AND b.total_cost_halalas IS NULL), 0) missing
      FROM inventory_batches b ${w}`).bind(...binds).first(),
    db.prepare("SELECT DISTINCT supplier FROM inventory_batches WHERE supplier <> '' ORDER BY supplier").all(),
    db.prepare("SELECT id, name FROM products ORDER BY name").all()
  ]);
  return {
    purchases: rows.results.map(b => purchaseRow(b, fin)), total: totals.n, units: totals.units,
    // value = non-voided rows matching the filter; voided rows are listed (status voided / all) but never counted
    value: fin ? sar(totals.value) : undefined, missingCost: fin ? totals.missing : undefined, status, page, per,
    suppliers: suppliers.results.map(r => r.supplier), products: products.results, canSeeCosts: fin, ...purchasePerms(ctx)
  };
}

/* Edit a purchase. Everything happens in one transaction guarded by the row's version:
   · quantity: the difference goes into (or out of) stock, with a ledger row (ADJUSTMENT, reference PURCHASE_EDIT). It can
     never drop below what was already sold / used from the batch, nor take away units reserved for open orders.
   · unit cost: total = quantity × unit cost; every unit already used from this batch is re-costed (consumptions), the COGS
     of delivered orders that used it is recomputed, and a COST_UPDATE ledger row records the change.
   · date / supplier / reference / location / notes / quantity on the invoice: stored, nothing else moves.
   The audit log keeps the old and new value of each changed field. */
export async function editPurchase(env, ctx, id, body) {
  need(ctx, "inventory.purchase.edit");
  const db = env.DB, fin = ctx.perms.has("finance.view");
  const b = await db.prepare("SELECT * FROM inventory_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  if (!["PURCHASE", "OPENING"].includes(b.source)) throw new HttpError(409, { error: "not_a_purchase" });
  if (b.voided_at) throw new HttpError(409, { error: "purchase_voided" });
  if (Number(body && body.version) !== b.version) throw new HttpError(409, { error: "record_changed", version: b.version });
  const errors = {};
  const qty = has(body.quantity) ? Number(body.quantity) : b.quantity_received;
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) errors.quantity = "invalid";
  const date = has(body.receivedDate) ? String(body.receivedDate) : b.received_at;
  if (date !== b.received_at) {
    if (!validDay(date)) errors.receivedDate = "invalid";
    else if (b.source === "OPENING") {                       // the opening balance must stay before the first order
      const first = await db.prepare("SELECT MIN(created_at) first FROM orders").first();
      if (first.first && date >= riyadhDay(first.first)) errors.receivedDate = "must_be_before_first_order";
    }
  }
  const ordered = "quantityOrdered" in body ? (has(body.quantityOrdered) ? Number(body.quantityOrdered) : null) : b.quantity_ordered;
  if (ordered != null && (!Number.isInteger(ordered) || ordered < 1 || ordered > MAX_QTY)) errors.quantityOrdered = "invalid";
  // cost: unit cost given → total = unit × quantity. Not given → the stored unit cost carries over to the new quantity.
  let unit = b.unit_cost_halalas, total = b.total_cost_halalas;
  if ("unitCost" in body) {
    if (!fin) throw new HttpError(403, { error: "forbidden", permission: "finance.view" });
    if (has(body.unitCost)) {
      const u = toHalalas(body.unitCost);
      if (u === undefined || u <= 0 || u > MAX_UNIT) errors.unitCost = "invalid"; else unit = u;
    } else if (b.total_cost_halalas != null) errors.unitCost = "required";   // a known cost cannot be erased
  }
  if (unit != null) total = unit * qty;
  else if (total != null && qty !== b.quantity_received) errors.unitCost = "required";  // older total-only batch: say the unit cost
  const f = Object.fromEntries(["supplier", "reference", "location"].map(k => [k, k in body ? clean(body[k], 120) : b[k]]));
  f.notes = "notes" in body ? clean(body.notes, 500) : b.notes;
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });

  const used = b.quantity_received - b.quantity_remaining, delta = qty - b.quantity_received;
  if (qty < used) throw new HttpError(409, { error: "quantity_below_used", used });
  const bal = await getBalance(db, b.product_id);
  if (delta < 0 && bal.on_hand - bal.reserved < -delta) throw new HttpError(409, { error: "edit_exceeds_available", available: bal.on_hand - bal.reserved, reserved: bal.reserved });

  const FIELDS = [["quantity", b.quantity_received, qty], ["receivedDate", b.received_at, date], ["quantityOrdered", b.quantity_ordered, ordered],
    ["supplier", b.supplier, f.supplier], ["reference", b.reference, f.reference], ["location", b.location, f.location], ["notes", b.notes, f.notes],
    ["unitCost", sar(b.unit_cost_halalas), sar(unit)], ["totalCost", sar(b.total_cost_halalas), sar(total)]];
  const changed = FIELDS.filter(([, o, n]) => (o ?? null) !== (n ?? null));
  if (!changed.length) return { ok: true, changed: false, version: b.version };

  const t = now(), v = b.version + 1, actor = ctx.user.username, uid = ctx.user.id, product = b.product_id;
  const G = { sql: "EXISTS (SELECT 1 FROM inventory_batches WHERE id = ? AND version = ? AND updated_at = ?)", binds: [b.id, v, t] };
  const stmts = [
    db.prepare(`UPDATE inventory_batches SET quantity_received = ?, quantity_remaining = quantity_remaining + ?, unit_cost_halalas = ?, total_cost_halalas = ?, received_at = ?,
        quantity_ordered = ?, supplier = ?, reference = ?, location = ?, notes = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?, version = ?
      WHERE id = ? AND version = ? AND voided_at IS NULL`)
      .bind(qty, delta, unit, total, date, ordered, f.supplier, f.reference, f.location, f.notes, t, actor, uid, v, b.id, b.version)
  ];
  if (delta) {
    stmts.push(db.prepare(`UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand + ?, updated_at = ? WHERE product_id = ? AND ${G.sql}`).bind(delta, delta, t, product, ...G.binds));
    stmts.push(db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
        cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
      SELECT ?, 'ADJUSTMENT', ?, ?, b.on_hand - ?, b.on_hand, b.reserved, b.reserved, b.on_hand - ? - b.reserved, b.on_hand - b.reserved, ?, 'PURCHASE_EDIT', ?, ?, ?, ?, ?
      FROM inventory_balances b WHERE b.product_id = ? AND ${G.sql}`)
      .bind(product, Math.abs(delta), b.id, delta, delta, unit == null ? null : unit * Math.abs(delta),
        `${b.source === "OPENING" ? "الرصيد الافتتاحي" : "شراء #" + b.batch_no}: الكمية ${b.quantity_received} → ${qty}`, actor, uid, `purchase-edit:${b.id}:${v}`, t, product, ...G.binds));
  }
  const costChanged = total !== b.total_cost_halalas || (unit != null && delta);
  if (costChanged && unit != null) {
    // units already used from this batch now cost the new unit cost; delivered orders' COGS follow
    stmts.push(db.prepare(`UPDATE inventory_consumptions SET cost_halalas = quantity * ? WHERE batch_id = ? AND ${G.sql}`).bind(unit, b.id, ...G.binds));
    stmts.push(db.prepare(`UPDATE inventory_reservations SET
        cogs_halalas = (SELECT SUM(c.cost_halalas) FROM inventory_consumptions c WHERE c.order_id = inventory_reservations.order_id AND c.reversed_at IS NULL),
        cogs_complete = (SELECT COUNT(*) = COUNT(c.cost_halalas) FROM inventory_consumptions c WHERE c.order_id = inventory_reservations.order_id AND c.reversed_at IS NULL),
        updated_at = ?
      WHERE status = 'COMMITTED' AND order_id IN (SELECT order_id FROM inventory_consumptions WHERE batch_id = ? AND order_id IS NOT NULL) AND ${G.sql}`).bind(t, b.id, ...G.binds));
  }
  if (total !== b.total_cost_halalas) {
    stmts.push(db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
        cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
      SELECT product_id, 'COST_UPDATE', 0, ?, on_hand, on_hand, reserved, reserved, on_hand - reserved, on_hand - reserved, ?, 'batch ' || ?, ?, ?, ?, ?, ?
      FROM inventory_balances WHERE product_id = ? AND ${G.sql}`)
      .bind(b.id, total, b.batch_no, `تعديل قيمة الشراء: ${b.total_cost_halalas == null ? "بلا تكلفة" : sar(b.total_cost_halalas)} → ${sar(total)} ر.س`, actor, uid, `purchase-cost:${b.id}:${v}`, t, product, ...G.binds));
  }
  stmts.push(auditStmt(env, ctx, "purchase_edited", "inventory_batch", b.id,
    { batch: b.batch_no, ...Object.fromEntries(changed.map(([k, o]) => [k, o])), version: b.version },
    { batch: b.batch_no, ...Object.fromEntries(changed.map(([k, , n]) => [k, n])), version: v }, { sql: "EXISTS (SELECT 1 FROM inventory_batches WHERE id = ?11 AND version = ?12 AND updated_at = ?13)", binds: G.binds }));
  let res;
  try { res = await db.batch(stmts); }
  catch (e) {
    if (/CHECK constraint failed/i.test(e.message)) throw new HttpError(409, { error: "edit_exceeds_available" });
    throw e;
  }
  if (!res[0].meta.changes) throw new HttpError(409, { error: "record_changed" });
  await checkAlert(db, product);
  return { ok: true, changed: true, version: v, fields: changed.map(([k]) => k), quantity: qty, unitCost: sar(unit), totalCost: sar(total) };
}

/* Void a purchase entered by mistake: only while none of it has been used (sold or adjusted) and its units are not needed
   by reservations. Its stock leaves the balance with a ledger row (ADJUSTMENT, reference PURCHASE_VOID); the row stays
   with who / when / why and no longer counts anywhere. The opening balance cannot be voided (correct it by editing). */
export async function voidPurchase(env, ctx, id, body) {
  need(ctx, "inventory.purchase.void");
  const db = env.DB, reason = clean(body && body.reason, 200);
  if (reason.length < 3) throw new HttpError(422, { error: "validation", fields: { reason: "required" } });
  const b = await db.prepare("SELECT * FROM inventory_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  if (b.source === "OPENING") throw new HttpError(409, { error: "opening_cannot_void" });
  if (b.source !== "PURCHASE") throw new HttpError(409, { error: "not_a_purchase" });
  if (b.voided_at) throw new HttpError(409, { error: "already_voided" });
  if (body.version != null && Number(body.version) !== b.version) throw new HttpError(409, { error: "record_changed", version: b.version });
  if (b.quantity_remaining !== b.quantity_received) throw new HttpError(409, { error: "purchase_used", used: b.quantity_received - b.quantity_remaining });
  const bal = await getBalance(db, b.product_id), qty = b.quantity_received;
  if (bal.on_hand - bal.reserved < qty) throw new HttpError(409, { error: "edit_exceeds_available", available: bal.on_hand - bal.reserved, reserved: bal.reserved });
  const t = now(), v = b.version + 1, actor = ctx.user.username, uid = ctx.user.id, product = b.product_id;
  const G = { sql: "EXISTS (SELECT 1 FROM inventory_batches WHERE id = ? AND version = ? AND voided_at = ?)", binds: [b.id, v, t] };
  let res;
  try {
    res = await db.batch([
      db.prepare(`UPDATE inventory_batches SET quantity_remaining = 0, voided_at = ?, voided_by = ?, voided_by_user_id = ?, void_reason = ?, version = ?
        WHERE id = ? AND version = ? AND voided_at IS NULL AND quantity_remaining = quantity_received`).bind(t, actor, uid, reason, v, b.id, b.version),
      db.prepare(`UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand - ?, updated_at = ? WHERE product_id = ? AND ${G.sql}`).bind(qty, qty, t, product, ...G.binds),
      db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
          cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
        SELECT ?, 'ADJUSTMENT', ?, ?, b.on_hand + ?, b.on_hand, b.reserved, b.reserved, b.on_hand + ? - b.reserved, b.on_hand - b.reserved, ?, 'PURCHASE_VOID', ?, ?, ?, ?, ?
        FROM inventory_balances b WHERE b.product_id = ? AND ${G.sql}`)
        .bind(product, qty, b.id, qty, qty, b.total_cost_halalas, `إلغاء شراء #${b.batch_no}: ${reason}`, actor, uid, `purchase-void:${b.id}`, t, product, ...G.binds),
      auditStmt(env, ctx, "purchase_voided", "inventory_batch", b.id,
        { batch: b.batch_no, quantity: qty, totalCost: sar(b.total_cost_halalas), receivedDate: b.received_at, supplier: b.supplier || undefined }, { reason },
        { sql: "EXISTS (SELECT 1 FROM inventory_batches WHERE id = ?11 AND version = ?12 AND voided_at = ?13)", binds: G.binds })
    ]);
  } catch (e) {
    if (/CHECK constraint failed/i.test(e.message)) throw new HttpError(409, { error: "edit_exceeds_available" });
    throw e;
  }
  if (!res[0].meta.changes) throw new HttpError(409, { error: "record_changed" });
  await checkAlert(db, product);
  return { ok: true };
}
