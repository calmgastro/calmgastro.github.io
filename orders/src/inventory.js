/* Inventory: the ONE place that moves stock. Website orders, admin orders, status changes, bulk changes and item edits
   all call these functions, and every movement is written in the same D1 transaction as the order change that caused it.

   Model (per product):  on_hand = physical units not yet sold · reserved = held for open orders · available = on_hand − reserved
   Every movement adds a row to inventory_transactions (append-only) with the balances before and after.
   Cost: FIFO over inventory_batches (one batch per receipt). COGS is stored on the reservation when the order is delivered
   and is never recalculated on page loads.

   Idempotency: status-change statements are guarded by the order's new (status, updated_at) pair written by the same
   transaction, so a retried or concurrent request that lost the race changes nothing. Order creation is protected by the
   order's idempotency key. CHECK constraints (on_hand ≥ reserved ≥ 0, batch remaining ≥ 0) abort the whole transaction
   instead of ever storing a negative balance. */
import { HttpError } from "./orders.js";
import { auditStmt } from "./auth.js";

export const DEFAULT_PRODUCT = "calmgastro";

/* What each existing order status means for stock (the only mapping in the system).
   RESERVE: units held for the order · COMMIT: units left the warehouse (sold, COGS recorded) · RELEASE: nothing held. */
export const ORDER_STATUS_INVENTORY_RULES = {
  RECEIVED: "RESERVE", CONFIRMED: "RESERVE", PREPARING: "RESERVE", SHIPPED: "RESERVE", OUT_FOR_DELIVERY: "RESERVE",
  ON_HOLD: "RESERVE",            // still an open order: keep its units until it is cancelled, failed or delivered
  DELIVERED: "COMMIT",
  CANCELLED: "RELEASE", FAILED: "RELEASE"
};
export const ruleOf = status => ORDER_STATUS_INVENTORY_RULES[status] || "RELEASE";

export const SETTINGS = {
  low_stock_threshold:      { type: "int", min: 0, max: 100000 },
  critical_stock_threshold: { type: "int", min: 0, max: 100000 },
  costing_method:           { type: "enum", values: ["FIFO"] },
  reservation_behavior:     { type: "enum", values: ["ON_ORDER_CREATED"] },
  shortage_policy:          { type: "enum", values: ["RESERVE_AVAILABLE", "RESERVE_NONE"] },
  return_policy:            { type: "enum", values: ["RESTOCK", "WRITE_OFF"] }
};

const nowIso = () => new Date().toISOString();

/* ---------- reading ---------- */
export async function getSettings(db) {
  const rows = (await db.prepare("SELECT key, value FROM inventory_settings").all()).results;
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    lowStockThreshold: Number(s.low_stock_threshold ?? 10), criticalStockThreshold: Number(s.critical_stock_threshold ?? 3),
    costingMethod: s.costing_method || "FIFO", reservationBehavior: s.reservation_behavior || "ON_ORDER_CREATED",
    shortagePolicy: s.shortage_policy || "RESERVE_AVAILABLE", returnPolicy: s.return_policy || "RESTOCK"
  };
}
export async function getBalance(db, product = DEFAULT_PRODUCT) {
  return db.prepare("SELECT * FROM inventory_balances WHERE product_id = ?").bind(product).first();
}
export const isInitialized = async (db, product = DEFAULT_PRODUCT) => !!(await getBalance(db, product));

// Units per product in an order. All current bundles are boxes of CalmGastro; a future catalog can map
// bundle → product here without touching the rest of the inventory code.
export function productOf(_itemProductId) { return DEFAULT_PRODUCT; }
export function unitsByProduct(items) {
  const m = new Map();
  for (const i of items) {
    const p = productOf(i.product_id ?? i.productId), u = (i.boxes_per_unit ?? i.boxesPerUnit) * i.quantity;
    m.set(p, (m.get(p) || 0) + u);
  }
  return m;
}

export function levelFor(available, s) {
  if (available <= 0) return "OUT";
  if (available <= s.criticalStockThreshold) return "CRITICAL";
  if (available <= s.lowStockThreshold) return "LOW";
  return "NONE";
}

/* FIFO cost of taking q units from a batch: the batch total is spread over its units without rounding drift
   (the last unit carries the remainder), so a batch's units always add up to exactly its total cost. */
export function fifoPieceCost(batch, q) {
  if (batch.total_cost_halalas == null) return null;
  const R = batch.quantity_received, before = R - batch.quantity_remaining, T = batch.total_cost_halalas;
  return Math.round(T * (before + q) / R) - Math.round(T * before / R);
}
export async function fifoPlan(db, product, qty) {
  const batches = (await db.prepare("SELECT * FROM inventory_batches WHERE product_id = ? AND quantity_remaining > 0 ORDER BY received_at, id").bind(product).all()).results;
  const plan = [];
  let left = qty;
  for (const b of batches) {
    if (!left) break;
    const q = Math.min(left, b.quantity_remaining);
    plan.push({ batchId: b.id, q, cost: fifoPieceCost(b, q) });
    left -= q;
  }
  if (left) throw new HttpError(409, { error: "insufficient_stock", product, requested: qty, missing: left });
  return plan;
}
const planCost = plan => plan.some(p => p.cost == null) ? { cost: plan.reduce((s, p) => s + (p.cost || 0), 0), complete: false } : { cost: plan.reduce((s, p) => s + p.cost, 0), complete: true };

/* ---------- statement builders ----------
   g = { sql, binds }: extra condition that must hold for the statements to apply (status-change guard), or a no-op guard.
   oid = { sql, binds }: SQL expression for the order id ("?" with the id, or a sub-select by idempotency key). */
export const NO_GUARD = { sql: "1", binds: [] };
export const orderGuard = (orderId, status, updatedAt) => ({ sql: "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = ? AND updated_at = ?)", binds: [orderId, status, updatedAt] });
export const orderIdLiteral = id => ({ sql: "?", binds: [id] });

function txInsert(db, { product, type, qtySql, qtyBinds = [], oid, beforeAfter, cost = null, costSql = null, note = "", actor, userId, key, t, g, extraWhere = "", extraBinds = [], batchId = null, adjustmentId = null, reference = "" }) {
  // beforeAfter: SQL giving on_hand_before, on_hand_after, reserved_before, reserved_after from the balance row b AFTER the movement
  return db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, order_id, batch_id, adjustment_id, on_hand_before, on_hand_after,
      reserved_before, reserved_after, available_before, available_after, cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
    SELECT ?, ?, ${qtySql}, ${oid ? oid.sql : "NULL"}, ?, ?, ${beforeAfter.ohB}, b.on_hand, ${beforeAfter.rB}, b.reserved,
      (${beforeAfter.ohB}) - (${beforeAfter.rB}), b.on_hand - b.reserved, ${costSql || "?"}, ?, ?, ?, ?, ?, ?
    FROM inventory_balances b WHERE b.product_id = ? AND ${g.sql}${extraWhere}`)
    .bind(product, type, ...qtyBinds, ...(oid ? oid.binds : []), batchId, adjustmentId, ...(costSql ? [] : [cost]), reference, note, actor, userId ?? null, key, t, product, ...g.binds, ...extraBinds);
}

/* Reserve `qty` units of `product` for an order. With RESERVE_AVAILABLE a partial reservation is made and the rest is a
   shortage; with RESERVE_NONE nothing is held unless everything can be. Never makes available negative. */
export function reserveStmts(db, { product, qty, oid, policy, actor, userId, t, g = NO_GUARD, key, note = "" }) {
  const amt = policy === "RESERVE_NONE" ? "CASE WHEN on_hand - reserved >= ? THEN ? ELSE 0 END" : "MIN(?, on_hand - reserved)";
  const amtBinds = policy === "RESERVE_NONE" ? [qty, qty] : [qty];
  return [
    db.prepare(`UPDATE inventory_balances SET last_delta = ${amt}, reserved = reserved + ${amt}, updated_at = ? WHERE product_id = ? AND ${g.sql}`)
      .bind(...amtBinds, ...amtBinds, t, product, ...g.binds),
    db.prepare(`INSERT INTO inventory_reservations (order_id, product_id, requested_qty, reserved_qty, shortage_qty, status, available_at_order, available_after, reserved_at, updated_at)
      SELECT ${oid.sql}, ?, ?, b.last_delta, ? - b.last_delta, CASE WHEN b.last_delta = ? THEN 'RESERVED' ELSE 'SHORTAGE' END,
        b.on_hand - b.reserved + b.last_delta, b.on_hand - b.reserved, ?, ?
      FROM inventory_balances b WHERE b.product_id = ? AND ${g.sql}
      ON CONFLICT (order_id, product_id) DO UPDATE SET requested_qty = excluded.requested_qty, reserved_qty = excluded.reserved_qty, shortage_qty = excluded.shortage_qty,
        status = excluded.status, available_at_order = excluded.available_at_order, available_after = excluded.available_after, reserved_at = excluded.reserved_at,
        released_at = NULL, committed_at = NULL, cogs_halalas = NULL, cogs_complete = 0, updated_at = excluded.updated_at`)
      .bind(...oid.binds, product, qty, qty, qty, t, t, product, ...g.binds),
    txInsert(db, { product, type: "RESERVATION", qtySql: "b.last_delta", oid, beforeAfter: { ohB: "b.on_hand", rB: "b.reserved - b.last_delta" },
      note: note || "", actor, userId, key, t, g })
  ];
}

const activeRes = oid => `(SELECT reserved_qty FROM inventory_reservations WHERE order_id = ${oid.sql} AND product_id = ? AND status IN ('RESERVED','SHORTAGE'))`;

/* Release whatever the order holds (cancelled, failed, quantity edit). */
export function releaseStmts(db, { product, oid, actor, userId, t, g = NO_GUARD, key, note = "" }) {
  const sub = activeRes(oid);
  return [
    db.prepare(`UPDATE inventory_balances SET last_delta = COALESCE(${sub}, 0), reserved = reserved - COALESCE(${sub}, 0), updated_at = ? WHERE product_id = ? AND ${g.sql}`)
      .bind(...oid.binds, product, ...oid.binds, product, t, product, ...g.binds),
    txInsert(db, { product, type: "RELEASE", qtySql: "b.last_delta", oid, beforeAfter: { ohB: "b.on_hand", rB: "b.reserved + b.last_delta" }, note, actor, userId, key, t, g,
      extraWhere: ` AND EXISTS (SELECT 1 FROM inventory_reservations WHERE order_id = ${oid.sql} AND product_id = ? AND status IN ('RESERVED','SHORTAGE'))`, extraBinds: [...oid.binds, product] }),
    db.prepare(`UPDATE inventory_reservations SET status = 'RELEASED', released_at = ?, updated_at = ? WHERE order_id = ${oid.sql} AND product_id = ? AND status IN ('RESERVED','SHORTAGE') AND ${g.sql}`)
      .bind(t, t, ...oid.binds, product, ...g.binds)
  ];
}

/* Delivered: the reserved units leave stock for good, batches are consumed FIFO and COGS is stored on the reservation.
   fromReserved=false is used when the order held nothing (e.g. an override from Cancelled straight to Delivered). */
export function commitStmts(db, { product, qty, plan, oid, fromReserved, actor, userId, t, g = NO_GUARD, key, note = "" }) {
  const { cost, complete } = planCost(plan);
  const stmts = [
    db.prepare(`UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand - ?, reserved = reserved - ?, sold = sold + ?, updated_at = ? WHERE product_id = ? AND ${g.sql}`)
      .bind(qty, qty, fromReserved ? qty : 0, qty, t, product, ...g.binds),
    ...plan.map(p => db.prepare(`UPDATE inventory_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ? AND ${g.sql}`).bind(p.q, p.batchId, ...g.binds)),
    ...plan.map(p => db.prepare(`INSERT INTO inventory_consumptions (order_id, batch_id, quantity, cost_halalas, created_at) SELECT ${oid.sql}, ?, ?, ?, ? WHERE ${g.sql}`)
      .bind(...oid.binds, p.batchId, p.q, p.cost, t, ...g.binds)),
    txInsert(db, { product, type: "SALE", qtySql: "?", qtyBinds: [qty], oid, cost: complete ? cost : null,
      beforeAfter: { ohB: "b.on_hand + b.last_delta", rB: fromReserved ? "b.reserved + b.last_delta" : "b.reserved" }, note, actor, userId, key, t, g })
  ];
  stmts.push(fromReserved
    ? db.prepare(`UPDATE inventory_reservations SET status = 'COMMITTED', committed_at = ?, cogs_halalas = ?, cogs_complete = ?, updated_at = ?
        WHERE order_id = ${oid.sql} AND product_id = ? AND status = 'RESERVED' AND ${g.sql}`).bind(t, cost, complete ? 1 : 0, t, ...oid.binds, product, ...g.binds)
    : db.prepare(`INSERT INTO inventory_reservations (order_id, product_id, requested_qty, reserved_qty, shortage_qty, status, cogs_halalas, cogs_complete, reserved_at, committed_at, updated_at)
        SELECT ${oid.sql}, ?, ?, ?, 0, 'COMMITTED', ?, ?, ?, ?, ? WHERE ${g.sql}
        ON CONFLICT (order_id, product_id) DO UPDATE SET requested_qty = excluded.requested_qty, reserved_qty = excluded.reserved_qty, shortage_qty = 0, status = 'COMMITTED',
          cogs_halalas = excluded.cogs_halalas, cogs_complete = excluded.cogs_complete, committed_at = excluded.committed_at, released_at = NULL, updated_at = excluded.updated_at`)
        .bind(...oid.binds, product, qty, qty, cost, complete ? 1 : 0, t, t, t, ...g.binds));
  return stmts;
}

/* A delivered order goes back (status override out of Delivered). RESTOCK puts the units back into the same batches at the
   same cost; WRITE_OFF takes them out of the sale but not back into stock (damaged / not resellable). */
export function returnStmts(db, { product, qty, consumptions, policy, oid, actor, userId, t, g = NO_GUARD, key, note = "" }) {
  const cost = consumptions.some(c => c.cost_halalas == null) ? null : consumptions.reduce((s, c) => s + c.cost_halalas, 0);
  const restock = policy !== "WRITE_OFF";
  return [
    db.prepare(`UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand + ?, sold = sold - ?, updated_at = ? WHERE product_id = ? AND ${g.sql}`)
      .bind(qty, restock ? qty : 0, qty, t, product, ...g.binds),
    ...(restock ? consumptions.map(c => db.prepare(`UPDATE inventory_batches SET quantity_remaining = quantity_remaining + ? WHERE id = ? AND ${g.sql}`).bind(c.quantity, c.batch_id, ...g.binds)) : []),
    db.prepare(`UPDATE inventory_consumptions SET reversed_at = ? WHERE order_id = ${oid.sql} AND reversed_at IS NULL AND ${g.sql}`).bind(t, ...oid.binds, ...g.binds),
    txInsert(db, { product, type: restock ? "RETURN" : "WRITE_OFF", qtySql: "?", qtyBinds: [qty], oid, cost,
      beforeAfter: { ohB: restock ? "b.on_hand - b.last_delta" : "b.on_hand", rB: "b.reserved" }, note, actor, userId, key, t, g }),
    db.prepare(`UPDATE inventory_reservations SET status = 'RELEASED', released_at = ?, updated_at = ? WHERE order_id = ${oid.sql} AND product_id = ? AND status = 'COMMITTED' AND ${g.sql}`)
      .bind(t, t, ...oid.binds, product, ...g.binds)
  ];
}

/* ---------- order creation (website and admin use the same call) ---------- */
export async function creationStmts(db, { items, oid, actor, userId, t, key, label }) {
  if (!(await isInitialized(db))) return { stmts: [], preview: null };
  const s = await getSettings(db), stmts = [];
  for (const [product, qty] of unitsByProduct(items))
    stmts.push(...reserveStmts(db, { product, qty, oid, policy: s.shortagePolicy, actor, userId, t, key: `reserve:${key}:${product}`, note: label || "" }));
  return { stmts };
}

/* What creating an order for `units` would do right now (admin preview / confirmation). */
export async function reservationPreview(db, units) {
  const b = await getBalance(db);
  if (!b) return { initialized: false };
  const s = await getSettings(db), available = b.on_hand - b.reserved;
  const reserve = s.shortagePolicy === "RESERVE_NONE" ? (available >= units ? units : 0) : Math.min(units, Math.max(0, available));
  return { initialized: true, onHand: b.on_hand, reserved: b.reserved, available, requested: units, toReserve: reserve, shortage: units - reserve,
    availableAfter: available - reserve, reservedAfter: b.reserved + reserve, shortagePolicy: s.shortagePolicy };
}

/* ---------- status transition ----------
   Returns the inventory statements for moving an order from one status to another, guarded by g. The caller puts them in
   the same batch as the status update. Throws 409 when stock rules forbid the move (e.g. delivering a shortage order). */
export async function transitionStmts(db, { order, items, from, to, actor, userId, t, g }) {
  if (!(await isInitialized(db))) return [];
  const a = ruleOf(from), b = ruleOf(to);
  if (a === b) return [];
  const s = await getSettings(db), oid = orderIdLiteral(order.id), stmts = [];
  const res = new Map(((await db.prepare("SELECT * FROM inventory_reservations WHERE order_id = ?").bind(order.id).all()).results).map(r => [r.product_id, r]));
  const base = `${order.id}:${to}:${t}`;
  for (const [product, qty] of unitsByProduct(items)) {
    const r = res.get(product), k = (type) => `${type}:${base}:${product}`;
    const active = r && ["RESERVED", "SHORTAGE"].includes(r.status), committed = r && r.status === "COMMITTED";
    if (b === "RELEASE") {
      if (active) stmts.push(...releaseStmts(db, { product, oid, actor, userId, t, g, key: k("release"), note: to }));
      else if (committed) stmts.push(...await returnFor(db, s, order, product, r, { oid, actor, userId, t, g, key: k("return"), note: to }));
    } else if (b === "RESERVE") {
      if (committed) stmts.push(...await returnFor(db, s, order, product, r, { oid, actor, userId, t, g, key: k("return"), note: to }));
      if (!active) stmts.push(...reserveStmts(db, { product, qty, oid, policy: s.shortagePolicy, actor, userId, t, g, key: k("reserve"), note: to }));
    } else if (b === "COMMIT") {
      if (active && r.status === "SHORTAGE")
        throw new HttpError(409, { error: "inventory_shortage", requested: r.requested_qty, reserved: r.reserved_qty, shortage: r.shortage_qty });
      if (active && r.reserved_qty !== qty)
        throw new HttpError(409, { error: "reservation_mismatch", reserved: r.reserved_qty, units: qty });
      if (!active) {
        const bal = await getBalance(db, product);
        if (bal.on_hand - bal.reserved < qty) throw new HttpError(409, { error: "insufficient_stock", requested: qty, available: bal.on_hand - bal.reserved });
      }
      const plan = await fifoPlan(db, product, qty);
      stmts.push(...commitStmts(db, { product, qty, plan, oid, fromReserved: !!active, actor, userId, t, g, key: k("sale"), note: to }));
    }
  }
  return stmts;
}
async function returnFor(db, s, order, product, r, opts) {
  const consumptions = (await db.prepare("SELECT * FROM inventory_consumptions WHERE order_id = ? AND reversed_at IS NULL").bind(order.id).all()).results;
  const qty = consumptions.reduce((n, c) => n + c.quantity, 0) || r.reserved_qty;
  return returnStmts(db, { product, qty, consumptions, policy: s.returnPolicy, ...opts });
}

/* Quantity edit on an open order: release what it held and reserve the new quantity (same transaction). */
export async function requantityStmts(db, { order, oldItems, newItems, actor, userId, t, g }) {
  if (!(await isInitialized(db))) return [];
  const rule = ruleOf(order.status);
  const oldU = unitsByProduct(oldItems), newU = unitsByProduct(newItems);
  const products = new Set([...oldU.keys(), ...newU.keys()]);
  const changed = [...products].some(p => (oldU.get(p) || 0) !== (newU.get(p) || 0));
  if (!changed || rule === "RELEASE") return [];
  if (rule === "COMMIT") throw new HttpError(409, { error: "delivered_inventory_locked" });
  const s = await getSettings(db), oid = orderIdLiteral(order.id), stmts = [];
  for (const product of products) {
    const qty = newU.get(product) || 0, k = type => `${type}:${order.id}:edit:${t}:${product}`;
    stmts.push(...releaseStmts(db, { product, oid, actor, userId, t, g, key: k("release"), note: "quantity_edit" }));
    if (qty) stmts.push(...reserveStmts(db, { product, qty, oid, policy: s.shortagePolicy, actor, userId, t, g, key: k("reserve"), note: "quantity_edit" }));
  }
  return stmts;
}

/* Batches abort with a CHECK error when a FIFO plan went stale (another delivery took the same units first): rebuild and retry. */
export async function runWithRetry(build, db, tries = 3) {
  for (let i = 1; ; i++) {
    const stmts = await build();
    try { return await db.batch(stmts); }
    catch (e) {
      if (i < tries && /CHECK constraint failed: (inventory_batches|quantity_remaining)/i.test(e.message)) continue;
      if (/CHECK constraint failed/i.test(e.message) && /inventory_balances|reserved <= on_hand|on_hand >= 0/i.test(e.message))
        throw new HttpError(409, { error: "insufficient_stock" });
      throw e;
    }
  }
}

/* ---------- alerts: one row when the level changes, never on page loads ---------- */
export async function checkAlert(db, product = DEFAULT_PRODUCT) {
  const b = await getBalance(db, product);
  if (!b) return;
  const s = await getSettings(db), available = b.on_hand - b.reserved, level = levelFor(available, s);
  if (level === b.alert_level) return;
  const t = nowIso();
  await db.batch([
    db.prepare("UPDATE inventory_balances SET alert_level = ? WHERE product_id = ? AND alert_level = ?").bind(level, product, b.alert_level),
    db.prepare(`INSERT INTO inventory_alerts (product_id, level, available, threshold, created_at, acknowledged_by, acknowledged_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`).bind(product, level, available, s.lowStockThreshold, t, level === "NONE" ? "system" : null, level === "NONE" ? t : null)
  ]);
}

/* ---------- opening balance + reconciliation of existing orders ----------
   Runs once. In memory it replays every existing order, oldest first, against the opening stock according to its CURRENT
   status, then writes the opening batch, the ledger rows, the reservations and the final balance in one transaction.
   preview=true returns the same result without writing anything. */
export async function initializeInventory(env, ctx, body) {
  const db = env.DB, product = DEFAULT_PRODUCT;
  if (await isInitialized(db, product)) throw new HttpError(409, { error: "already_initialized" });
  const qty = Number(body.quantity);
  if (!Number.isInteger(qty) || qty < 0 || qty > 1000000) throw new HttpError(422, { error: "validation", fields: { quantity: "invalid" } });
  const totalCost = body.totalCost == null || body.totalCost === "" ? null : toHalalas(body.totalCost);
  if (totalCost === undefined) throw new HttpError(422, { error: "validation", fields: { totalCost: "invalid" } });
  const first = await db.prepare("SELECT MIN(created_at) first FROM orders").first();
  const firstDay = first && first.first ? riyadhDay(first.first) : null;
  const suggested = firstDay ? addDays(firstDay, -1) : riyadhDay(nowIso());
  const date = body.date ? String(body.date) : suggested;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, { error: "validation", fields: { date: "invalid" } });
  if (firstDay && date >= firstDay) throw new HttpError(422, { error: "validation", fields: { date: "must_be_before_first_order" }, firstOrderDay: firstDay });
  const s = await getSettings(db), notes = String(body.notes || "").slice(0, 500), actor = ctx.user.username, userId = ctx.user.id, t = nowIso();
  const openingAt = new Date(Date.parse(date + "T00:00:00+03:00")).toISOString();

  // replay
  const orders = (await db.prepare("SELECT id, order_number, status, created_at, boxes, source FROM orders ORDER BY created_at, id").all()).results;
  const items = (await db.prepare("SELECT order_id, product_id, boxes_per_unit, quantity FROM order_items").all()).results;
  const delivered = new Map((await db.prepare(`SELECT order_id, MAX(created_at) at FROM order_status_history WHERE new_status = 'DELIVERED' GROUP BY order_id`).all()).results.map(r => [r.order_id, r.at]));
  const batch = { quantity_received: qty, quantity_remaining: qty, total_cost_halalas: totalCost };
  let onHand = qty, reserved = 0, sold = 0;
  const rows = [], tx = [{ type: "OPENING_BALANCE", quantity: qty, order: null, ohB: 0, oh: qty, rB: 0, r: 0, cost: totalCost, at: openingAt, note: notes }];
  for (const o of orders) {
    const units = unitsByProduct(items.filter(i => i.order_id === o.id)).get(product) || 0;
    if (!units) continue;
    const rule = ruleOf(o.status), row = { orderId: o.id, orderNumber: o.order_number, status: o.status, rule, createdAt: o.created_at, units };
    if (rule === "RESERVE") {
      const avail = onHand - reserved;
      const take = s.shortagePolicy === "RESERVE_NONE" ? (avail >= units ? units : 0) : Math.min(units, Math.max(0, avail));
      Object.assign(row, { availableBefore: avail, reserved: take, shortage: units - take, effect: take === units ? "RESERVED" : "SHORTAGE" });
      tx.push({ type: "RESERVATION", quantity: take, order: o.id, ohB: onHand, oh: onHand, rB: reserved, r: reserved + take, at: o.created_at, note: take < units ? `shortage ${units - take}` : "" });
      reserved += take;
      row.availableAfter = onHand - reserved;
    } else if (rule === "COMMIT") {
      const avail = onHand - reserved;
      if (avail < units) { Object.assign(row, { availableBefore: avail, effect: "UNRECONCILED", shortage: units - avail }); rows.push(row); continue; }
      const cost = fifoPieceCost(batch, units);
      batch.quantity_remaining -= units;
      Object.assign(row, { availableBefore: avail, effect: "CONSUMED", cogs: cost });
      tx.push({ type: "SALE", quantity: units, order: o.id, ohB: onHand, oh: onHand - units, rB: reserved, r: reserved, cost, at: delivered.get(o.id) || o.created_at, note: "" });
      onHand -= units; sold += units;
      row.availableAfter = onHand - reserved;
    } else Object.assign(row, { effect: "NONE" });
    rows.push(row);
  }
  const unreconciled = rows.filter(r => r.effect === "UNRECONCILED");
  const summary = { product, openingQuantity: qty, openingDate: date, firstOrderDay: firstDay, suggestedDate: suggested, totalCostHalalas: totalCost,
    unitCostHalalas: totalCost == null || !qty ? null : totalCost / qty, ordersReviewed: orders.length,
    onHand, reserved, available: onHand - reserved, sold,
    reservedOrders: rows.filter(r => r.effect === "RESERVED").length, shortageOrders: rows.filter(r => r.effect === "SHORTAGE"),
    consumedOrders: rows.filter(r => r.effect === "CONSUMED").length, releasedOrders: rows.filter(r => r.effect === "NONE").length,
    unreconciled, orders: rows };
  if (body.preview === true) return { preview: true, ...summary };
  if (unreconciled.length) throw new HttpError(409, { error: "opening_stock_too_small", unreconciled: unreconciled.map(r => r.orderNumber) });

  const stmts = [
    db.prepare("INSERT INTO inventory_balances (product_id, on_hand, reserved, sold, last_delta, alert_level, initialized_at, updated_at) VALUES (?, ?, ?, ?, 0, 'NONE', ?, ?)")
      .bind(product, onHand, reserved, sold, t, t),
    db.prepare(`INSERT INTO inventory_batches (product_id, batch_no, source, received_at, quantity_received, quantity_remaining, total_cost_halalas, unit_cost_halalas, notes, created_by, user_id, created_at)
      VALUES (?, 1, 'OPENING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(product, date, qty, batch.quantity_remaining, totalCost,
        totalCost > 0 && totalCost % qty === 0 ? totalCost / qty : null, notes, actor, userId, t)
  ];
  const batchId = "(SELECT id FROM inventory_batches WHERE product_id = ? AND batch_no = 1)";
  for (const x of tx) {
    const recorded = x.type === "OPENING_BALANCE" ? notes : [x.note, `تسوية افتتاحية سُجّلت ${t}`].filter(Boolean).join(" · ");
    stmts.push(db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, order_id, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after,
        available_before, available_after, cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ${x.type === "RESERVATION" ? "NULL" : batchId}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(product, x.type, x.quantity, x.order, ...(x.type === "RESERVATION" ? [] : [product]), x.ohB, x.oh, x.rB, x.r, x.ohB - x.rB, x.oh - x.r,
        x.cost ?? null, x.type === "OPENING_BALANCE" ? "opening" : "reconciliation", recorded, actor, userId, `init:${product}:${x.type}:${x.order ?? 0}`, x.at));
  }
  for (const r of rows.filter(r => r.effect === "RESERVED" || r.effect === "SHORTAGE"))
    stmts.push(db.prepare(`INSERT INTO inventory_reservations (order_id, product_id, requested_qty, reserved_qty, shortage_qty, status, available_at_order, available_after, reserved_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.orderId, product, r.units, r.reserved, r.shortage, r.effect, r.availableBefore, r.availableAfter, r.createdAt, t));
  for (const r of rows.filter(r => r.effect === "CONSUMED")) {
    stmts.push(db.prepare(`INSERT INTO inventory_reservations (order_id, product_id, requested_qty, reserved_qty, shortage_qty, status, available_at_order, available_after, cogs_halalas, cogs_complete, reserved_at, committed_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 'COMMITTED', ?, ?, ?, ?, ?, ?, ?)`).bind(r.orderId, product, r.units, r.units, r.availableBefore, r.availableAfter, r.cogs ?? null, r.cogs == null ? 0 : 1, r.createdAt, delivered.get(r.orderId) || r.createdAt, t));
    stmts.push(db.prepare(`INSERT INTO inventory_consumptions (order_id, batch_id, quantity, cost_halalas, created_at) VALUES (?, ${batchId}, ?, ?, ?)`)
      .bind(r.orderId, product, r.units, r.cogs ?? null, t));
  }
  stmts.push(auditStmt(env, ctx, "inventory_initialized", "inventory", product, null,
    { quantity: qty, date, totalCostHalalas: totalCost, onHand, reserved, sold, shortageOrders: summary.shortageOrders.map(r => r.orderNumber) }));
  await db.batch(stmts);
  await checkAlert(db, product);
  return { preview: false, ...summary };
}

/* ---------- small helpers shared with finance / admin ---------- */
// "1,234.50" / 1234.5 / "١٢٣٤" → 123450 halalas; undefined when invalid
export function toHalalas(v) {
  const s = String(v ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return undefined;
  const [a, b = ""] = s.split(".");
  return Number(a) * 100 + Number((b + "00").slice(0, 2));
}
export const riyadhDay = iso => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// a real calendar day (no 2026-02-30), from 2020 up to today in Riyadh
export function validDay(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return false;
  const t = Date.parse(d + "T00:00:00Z");
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d && d >= "2020-01-01" && d <= riyadhDay(nowIso());
}

/* Riyadh calendar periods → [fromDay, toDay) as YYYY-MM-DD; the week starts on Sunday (Saudi working week).
   Shared by the finance summary, the expenses list and the purchases list so the same period always means the same rows. */
export function periodOf(params, fallback = "month") {
  const today = riyadhDay(nowIso()), range = params.get("range") || fallback;
  const [y, m] = today.split("-").map(Number), pad = n => String(n).padStart(2, "0");
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const ranges = {
    today: [today, addDays(today, 1)],
    week: [addDays(today, -dow), addDays(today, 7 - dow)],
    month: [`${y}-${pad(m)}-01`, m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`],
    last_month: [m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`, `${y}-${pad(m)}-01`],
    year: [`${y}-01-01`, `${y + 1}-01-01`],
    all: ["2000-01-01", addDays(today, 1)]
  };
  if (range === "custom") {
    const f = params.get("from"), t = params.get("to");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f || "") || !/^\d{4}-\d{2}-\d{2}$/.test(t || "") || f > t) throw new HttpError(422, { error: "validation", fields: { range: "invalid" } });
    return { range, from: f, to: addDays(t, 1) };
  }
  if (!ranges[range]) throw new HttpError(422, { error: "validation", fields: { range: "invalid" } });
  return { range, from: ranges[range][0], to: ranges[range][1] };
}
