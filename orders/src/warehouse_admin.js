/* Moving between the two warehouses: an order (it will be taken from the other one) or boxes (a recorded transfer).
   Stock movements are built by inventory.js; nothing here changes a cost: a transferred box keeps its batch and its cost. */
import { HttpError, loadOrder, normalizeOrderNumber } from "./orders.js";
import { auditStmt } from "./auth.js";
import { DEFAULT_PRODUCT, getBalance, fifoPlan, batchOut, batchIn, checkAlert, moveStmts, runWithRetry, ruleOf, isInitialized } from "./inventory.js";
import { stockFlow } from "./stock_admin.js";
import { RIYADH, isWarehouse, whOf, warehouseMode, warehouseFor, listWarehouses } from "./warehouses.js";

const need = (ctx, perm) => { if (!ctx.perms.has(perm)) throw new HttpError(403, { error: "forbidden", permission: perm }); };
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const activeShipment = (db, orderId) => db.prepare("SELECT b.batch_no FROM shipment_orders s JOIN shipment_batches b ON b.id = s.batch_id WHERE s.order_id = ? AND s.removed_at IS NULL LIMIT 1").bind(orderId).first();

/* manual: chosen by the team, so editing the city later does not move it back. Returns the order as it is after the move. */
export async function moveOrder(env, ctx, full, to, { manual = true, why = "" } = {}) {
  const db = env.DB, o = full.order, from = whOf(o);
  if (!isWarehouse(to)) throw new HttpError(422, { error: "validation", fields: { warehouse: "invalid" } });
  if (o.anonymized_at) throw new HttpError(409, { error: "anonymized" });
  if (from === to) {
    if (manual && !o.warehouse_manual) await db.prepare("UPDATE orders SET warehouse_id = ?, warehouse_manual = 1 WHERE id = ?").bind(to, o.id).run();
    return full;
  }
  if (await activeShipment(db, o.id)) throw new HttpError(409, { error: "order_in_shipment" });
  const t = new Date().toISOString();
  const g = { sql: "EXISTS (SELECT 1 FROM orders WHERE id = ? AND warehouse_id = ? AND updated_at = ?)", binds: [o.id, to, t] };
  const res = await runWithRetry(async () => [
    db.prepare("UPDATE orders SET warehouse_id = ?, warehouse_manual = CASE WHEN ? = 1 THEN 1 ELSE warehouse_manual END, updated_at = ? WHERE id = ? AND updated_at = ? AND status = ?")
      .bind(to, manual ? 1 : 0, t, o.id, o.updated_at, o.status),
    ...await moveStmts(db, { order: o, items: full.items, to, actor: ctx.user.username, userId: ctx.user.id, t, g }),
    auditStmt(env, ctx, "order_warehouse_changed", "order", o.order_number, { warehouse: from }, { warehouse: to, why: why || undefined },
      { sql: "EXISTS (SELECT 1 FROM orders WHERE id = ?11 AND warehouse_id = ?12 AND updated_at = ?13)", binds: g.binds })
  ], db);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "order_changed" });
  try { await checkAlert(db); } catch (e) { console.log("stock alert failed:", e.message); }
  return loadOrder(db, o.order_number);
}

export async function setOrderWarehouse(env, ctx, number, body) {
  if (!ctx.perms.has("inventory.manage") && !ctx.perms.has("orders.status") && !ctx.perms.has("orders.status.limited") && !ctx.perms.has("shipments.manage"))
    throw new HttpError(403, { error: "forbidden", permission: "orders.status" });
  const n = normalizeOrderNumber(number), full = n && await loadOrder(env.DB, n);
  if (!full) throw new HttpError(404, { error: "not_found" });
  await moveOrder(env, ctx, full, String(body && body.warehouse || ""), { why: "manual" });
  return { ok: true };
}

/* The city of an order not shipped yet was edited: its warehouse follows, unless the team chose one. */
export async function followCity(env, ctx, number) {
  const db = env.DB, full = await loadOrder(db, number), o = full && full.order;
  if (!o || o.warehouse_manual || o.anonymized_at || !["RECEIVED", "CONFIRMED", "PREPARING", "ON_HOLD"].includes(o.status)) return;
  const mode = await warehouseMode(db), to = warehouseFor(mode, o.city);
  if (mode !== "CITY" || to === whOf(o) || await activeShipment(db, o.id)) return;
  await moveOrder(env, ctx, full, to, { manual: false, why: "city" });
}

/* An order handed over by us (delivered without a SENA shipment) that is counted on SENA's warehouse: say which warehouse it
   left from first. body.warehouse answers; without it → 409 warehouse_confirmation_required. */
export async function deliveryWarehouse(env, ctx, full, to, chosen) {
  const db = env.DB, o = full.order;
  if (to !== "DELIVERED" || ruleOf(o.status) === "COMMIT" || !(await isInitialized(db)) || await activeShipment(db, o.id)) return full;
  if (chosen != null && chosen !== "") {
    // refuse before anything moves: the delivery itself would be refused for lack of boxes there
    if (isWarehouse(chosen) && chosen !== whOf(o)) {
      const there = Math.max(0, (await stockFlow(db, chosen)).inWarehouse);
      if (there < o.boxes) throw new HttpError(409, { error: "inventory_shortage", warehouse: chosen, requested: o.boxes, shortage: o.boxes - there });
    }
    return moveOrder(env, ctx, full, String(chosen), { why: "hand_delivery" });
  }
  if ((await warehouseMode(db)) !== "CITY") return full;
  const w = (await listWarehouses(db)).find(x => x.id === whOf(o));
  if (w && w.isCarrier) throw new HttpError(409, { error: "warehouse_confirmation_required", warehouse: w.id, suggested: RIYADH });
  return full;
}

/* ---------- transfer boxes from one warehouse to the other ---------- */
export async function transferStock(env, ctx, body) {
  need(ctx, "inventory.manage");
  const db = env.DB, product = DEFAULT_PRODUCT, from = String(body.from || ""), to = String(body.to || ""), qty = Number(body.quantity), key = String(body.requestId || ""), notes = clean(body.notes, 300);
  const errors = {};
  if (!isWarehouse(from)) errors.from = "invalid";
  if (!isWarehouse(to) || to === from) errors.to = "invalid";
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000000) errors.quantity = "invalid";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) errors.requestId = "invalid";
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  if (await db.prepare("SELECT id FROM warehouse_transfers WHERE request_id = ?").bind(key).first()) return { replay: true };
  const bal = await getBalance(db, product, from);
  if (!bal) throw new HttpError(409, { error: "not_initialized" });
  if (bal.on_hand - bal.reserved < qty) throw new HttpError(409, { error: "transfer_exceeds_available", available: bal.on_hand - bal.reserved, reserved: bal.reserved });
  const actor = ctx.user.username, uid = ctx.user.id, names = Object.fromEntries((await listWarehouses(db)).map(w => [w.id, w.name]));
  const label = `${names[from]} ← ${names[to]}`.replace("←", "→") + (notes ? " · " + notes : "");
  const tx = (wh, delta, t, dir) => db.prepare(`INSERT INTO inventory_transactions (product_id, warehouse_id, type, quantity, on_hand_before, on_hand_after, reserved_before, reserved_after,
      available_before, available_after, reference, notes, actor, user_id, idempotency_key, created_at)
    SELECT ?, b.warehouse_id, 'ADJUSTMENT', ?, b.on_hand - ?, b.on_hand, b.reserved, b.reserved, b.on_hand - ? - b.reserved, b.on_hand - b.reserved, ?, ?, ?, ?, ?, ?
    FROM inventory_balances b WHERE b.product_id = ? AND b.warehouse_id = ?`)
    .bind(product, qty, delta, delta, dir === "out" ? "TRANSFER_OUT" : "TRANSFER_IN", label, actor, uid, `transfer:${key}:${dir}`, t, product, wh);
  try {
    await runWithRetry(async () => {
      const t = new Date().toISOString(), plan = await fifoPlan(db, product, qty, from);
      const upd = (wh, delta) => db.prepare("UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand + ?, updated_at = ? WHERE product_id = ? AND warehouse_id = ?").bind(delta, delta, t, product, wh);
      return [
        db.prepare("INSERT INTO warehouse_transfers (product_id, from_warehouse, to_warehouse, quantity, notes, request_id, created_by, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(product, from, to, qty, notes, key, actor, uid, t),
        upd(from, -qty), upd(to, qty),
        ...plan.flatMap(p => [batchOut(db, p.batchId, from, p.q), batchIn(db, p.batchId, to, p.q)]),
        tx(from, -qty, t, "out"), tx(to, qty, t, "in"),
        auditStmt(env, ctx, "stock_transferred", "inventory", product, null, { from, to, quantity: qty, notes: notes || undefined })
      ];
    }, db);
  } catch (e) {
    if (/UNIQUE constraint failed: warehouse_transfers\.request_id/i.test(e.message)) return { replay: true };
    if (e instanceof HttpError && e.body.error === "insufficient_stock") throw new HttpError(409, { error: "transfer_exceeds_available" });
    throw e;
  }
  await checkAlert(db, product);
  return { replay: false, quantity: qty, from, to };
}

export async function listTransfers(db) {
  return (await db.prepare("SELECT * FROM warehouse_transfers ORDER BY id DESC LIMIT 100").all()).results
    .map(r => ({ id: r.id, from: r.from_warehouse, to: r.to_warehouse, quantity: r.quantity, notes: r.notes, by: r.created_by, at: r.created_at }));
}
