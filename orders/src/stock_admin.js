/* Admin → المخزون: overview, receipts, adjustments, shortages, settings, opening balance, integrity check.
   Stock movements themselves are built by inventory.js; this file validates input, checks permissions and shapes output.
   Purchase costs and stock value are returned only to admins with finance.view. */
import { HttpError, normalizeOrderNumber } from "./orders.js";
import { auditStmt } from "./auth.js";
import { DEFAULT_PRODUCT, SETTINGS, getSettings, getBalance, levelFor, fifoPlan, fifoPieceCost, checkAlert, runWithRetry,
         initializeInventory, ruleOf, toHalalas, riyadhDay, addDays, NO_GUARD } from "./inventory.js";

const need = (ctx, perm) => { if (!ctx.perms.has(perm)) throw new HttpError(403, { error: "forbidden", permission: perm }); };
const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
export const sar = h => h == null ? null : Math.round(h) / 100;
const unitCost = b => b.total_cost_halalas == null ? null : sar(b.total_cost_halalas / b.quantity_received);
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
    initialized: true, product: DEFAULT_PRODUCT, onHand: b.on_hand, reserved: b.reserved, available, sold: b.sold,
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
      status: b.quantity_remaining === 0 ? "DEPLETED" : b.quantity_remaining === b.quantity_received ? "FULL" : "PARTIAL",
      ...(fin ? { unitCost: unitCost(b), totalCost: sar(b.total_cost_halalas), stockValue: sar(remainingValue(b)), costKnown: b.total_cost_halalas != null } : {}) })),
    transactions: tx.results.map(t => ({ id: t.id, at: t.created_at, type: t.type, quantity: t.quantity, orderNumber: t.order_number, batchId: t.batch_id,
      onHandBefore: t.on_hand_before, onHandAfter: t.on_hand_after, reservedBefore: t.reserved_before, reservedAfter: t.reserved_after,
      availableBefore: t.available_before, availableAfter: t.available_after, reference: t.reference, notes: t.notes, actor: t.actor,
      ...(fin ? { cost: sar(t.cost_halalas) } : {}) })),
    transactionsTotal: txCount.n, page, per,
    shortages,
    adjustments: adjustments.results.map(a => ({ id: a.id, quantity: a.quantity, oldOnHand: a.old_on_hand, newOnHand: a.new_on_hand, reason: a.reason, notes: a.notes, by: a.created_by, at: a.created_at })),
    settingOptions: Object.fromEntries(Object.entries(SETTINGS).filter(([, v]) => v.type === "enum").map(([k, v]) => [k, v.values])),
    canManage: ctx.perms.has("inventory.manage"), canSeeCosts: fin
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
  need(ctx, "inventory.manage");
  const db = env.DB, product = DEFAULT_PRODUCT;
  if (!(await getBalance(db, product))) throw new HttpError(409, { error: "not_initialized" });
  const qty = Number(body.quantity), total = toHalalas(body.totalCost), date = String(body.receivedDate || "");
  const errors = {};
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000000) errors.quantity = "invalid";
  if (total === undefined) errors.totalCost = "invalid";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > riyadhDay(now())) errors.receivedDate = "invalid";
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
      db.prepare(`INSERT INTO inventory_batches (product_id, batch_no, source, received_at, quantity_ordered, quantity_received, quantity_remaining, total_cost_halalas,
          supplier, reference, location, notes, created_by, user_id, created_at)
        SELECT ?, COALESCE(MAX(batch_no), 0) + 1, 'PURCHASE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM inventory_batches WHERE product_id = ?`)
        .bind(product, date, ordered, qty, qty, total, f.supplier, f.reference, f.location, f.notes, actor, uid, t, product),
      db.prepare("UPDATE inventory_balances SET last_delta = ?, on_hand = on_hand + ?, updated_at = ? WHERE product_id = ?").bind(qty, qty, t, product),
      db.prepare(`INSERT INTO inventory_transactions (product_id, type, quantity, batch_id, on_hand_before, on_hand_after, reserved_before, reserved_after, available_before, available_after,
          cost_halalas, reference, notes, actor, user_id, idempotency_key, created_at)
        SELECT ?, 'PURCHASE_RECEIPT', ?, ${batchId}, b.on_hand - ?, b.on_hand, b.reserved, b.reserved, b.on_hand - ? - b.reserved, b.on_hand - b.reserved, ?, ?, ?, ?, ?, ?, ?
        FROM inventory_balances b WHERE b.product_id = ?`)
        .bind(product, qty, product, qty, qty, total, f.reference, f.notes, actor, uid, "receipt:" + key, t, product),
      auditStmt(env, ctx, "stock_received", "inventory", product, null, { quantity: qty, totalCostHalalas: total, receivedDate: date, supplier: f.supplier, reference: f.reference })
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed: inventory_transactions\.idempotency_key/i.test(e.message)) return { replay: true };
    throw e;
  }
  await checkAlert(db, product);
  return { replay: false, quantity: qty, unitCost: sar(total / qty), totalCost: sar(total) };
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

/* ---------- shortage order: reserve what has arrived since (never changes the order status) ---------- */
export async function allocateOrder(env, ctx, number) {
  need(ctx, "inventory.manage");
  const db = env.DB, n = normalizeOrderNumber(number);
  const o = n && await db.prepare("SELECT * FROM orders WHERE order_number = ?").bind(n).first();
  if (!o) throw new HttpError(404, { error: "not_found" });
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
