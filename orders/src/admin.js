/* Admin API: every handler receives ctx = { user, perms, session, ip, ua } from an authenticated session.
   Permissions are checked here, on the server, for every action. */
import { STATUSES, FLOW, LABELS, LOCKED, allowedTransition, nextOptions, notifyMessage } from "./statuses.js";
import { loadOrder, localPhone, normalizeOrderNumber, normalizePhone, latinDigits, HttpError, validateOrderInput, findReplay, insertOrder, linesForBoxes, sha256 } from "./orders.js";
import { getCatalog, priceForBoxes, quote } from "./catalog.js";
import { transitionStmts, requantityStmts, runWithRetry, checkAlert, orderGuard, reservationPreview, ruleOf, isInitialized } from "./inventory.js";
import { stockSummary, sar } from "./stock_admin.js";
import { groupCities, citySpellings } from "./cities.js";
import { audit, auditStmt, hashPassword, verifyPassword, passwordProblem, validUsername, revokeAllStmt,
         encryptSecret, decryptSecret, verifyTotp, base32 } from "./auth.js";

export const need = (ctx, perm) => { if (!ctx.perms.has(perm)) throw new HttpError(403, { error: "forbidden", permission: perm }); };
const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanNote = v => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, 1000);
const DAY = 86400000;

/* ---------- navigation for the signed-in admin (sidebar shows only what the role may open) ---------- */
const NAV = [
  ["dashboard", "dashboard.view"], ["orders", "orders.view"], ["inventory", "inventory.view"], ["expenses", ["finance.view", "expenses.manage"]],
  ["customers", "customers.view"], ["products", "products.view"], ["reports", "reports.view"], ["audit", "audit.view"], ["users", "users.manage"], ["settings", null]
];
export function me(ctx) {
  return { user: ctx.user, permissions: [...ctx.perms].sort(), nav: NAV.filter(([, p]) => !p || [].concat(p).some(x => ctx.perms.has(x))).map(([k]) => k) };
}

/* ---------- filters shared by the list, "select all", bulk and export ---------- */
// Riyadh is UTC+3 all year; date filters are Riyadh calendar days.
const riyadhMidnight = (offsetDays = 0) => { const r = new Date(Date.now() + 3 * 3600e3); r.setUTCHours(0, 0, 0, 0); return new Date(r.getTime() - 3 * 3600e3 + offsetDays * DAY); };
const dayStart = d => new Date(Date.parse(d + "T00:00:00+03:00"));

// ?city=<key from /cities>: every spelling customers used for that city (see cities.js)
const cityKeyParam = params => { const c = String(params.get("city") || "").slice(0, 200); return c || null; };
async function filterFor(env, params) {
  const key = cityKeyParam(params);
  return orderFilter(params, key ? await citySpellings(env, key) : null);
}

function orderFilter(params, spellings = null) {
  const where = [], binds = [];
  const add = (sql, ...v) => where.push(sql.replace(/\?/g, () => `?${binds.push(v.shift())}`));
  const q = String(params.get("q") || "").trim().slice(0, 60);
  if (q) {
    const num = normalizeOrderNumber(q), digits = latinDigits(q).replace(/\D/g, "");
    const like = "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%";
    const parts = ["o.order_number LIKE ? ESCAPE '\\'", "o.customer_name LIKE ? ESCAPE '\\'"], vals = [like.toUpperCase(), like];
    if (num) { parts.push("o.order_number = ?"); vals.push(num); }
    if (digits.length >= 4) { parts.push("o.customer_phone LIKE ?"); vals.push("%" + digits.replace(/^0/, "").replace(/^966/, "") + "%"); }
    add("(" + parts.join(" OR ") + ")", ...vals);
  }
  const phone = normalizePhone(params.get("phone"));
  if (phone) add("o.customer_phone = ?", phone);
  const status = params.get("status");
  if (STATUSES.includes(status)) add("o.status = ?", status);
  else if (status === "OPEN") where.push("o.status IN ('RECEIVED','CONFIRMED','PREPARING','SHIPPED','OUT_FOR_DELIVERY','ON_HOLD')");
  const payment = params.get("payment");
  if (payment === "cod") add("o.payment_method = ?", payment);
  const source = params.get("source");
  if (source === "WEBSITE" || source === "ADMIN") add("o.source = ?", source);
  const inv = params.get("inv");
  if (["RESERVED", "SHORTAGE", "COMMITTED", "RELEASED"].includes(inv)) add("EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.order_id = o.id AND r.status = ?)", inv);
  else if (inv === "NONE") where.push("NOT EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.order_id = o.id)");
  const pay = params.get("pay");                                   // cash on delivery: collected once delivered
  if (pay === "collected") where.push("o.status = 'DELIVERED'");
  else if (pay === "outstanding") where.push("o.status NOT IN ('DELIVERED','CANCELLED','FAILED')");
  if (spellings) {
    if (spellings.length) add("o.city IN (" + spellings.map(() => "?").join(",") + ")", ...spellings);
    else where.push("0");                                   // a city with no orders (or an unknown key) matches nothing
  }
  const range = params.get("range");
  let from = null, to = null;
  if (range === "today") from = riyadhMidnight(0);
  else if (range === "yesterday") { from = riyadhMidnight(-1); to = riyadhMidnight(0); }
  else if (range === "7d") from = riyadhMidnight(-6);
  else if (range === "30d") from = riyadhMidnight(-29);
  else {
    if (/^\d{4}-\d{2}-\d{2}$/.test(params.get("from") || "")) from = dayStart(params.get("from"));
    if (/^\d{4}-\d{2}-\d{2}$/.test(params.get("to") || "")) to = new Date(dayStart(params.get("to")).getTime() + DAY);
  }
  if (from) add("o.created_at >= ?", from.toISOString());
  if (to) add("o.created_at < ?", to.toISOString());
  const archived = params.get("archived");
  if (archived === "1") where.push("o.archived_at IS NOT NULL");
  else if (archived !== "all") where.push("o.archived_at IS NULL");
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", binds };
}

export async function listOrders(env, ctx, params) {
  need(ctx, "orders.view");
  const f = await filterFor(env, params);
  const per = [25, 50, 100].includes(Number(params.get("per"))) ? Number(params.get("per")) : 25;
  const page = Math.max(1, Math.min(100000, parseInt(params.get("page"), 10) || 1));
  const sort = params.get("sort") === "updated" ? "o.updated_at DESC" : "o.id DESC";
  const [rows, count, counts] = await Promise.all([
    env.DB.prepare(`SELECT o.order_number, o.created_at, o.updated_at, o.customer_name, o.customer_phone, o.city, o.district, o.boxes,
        o.total_amount, o.currency, o.payment_method, o.status, o.archived_at, o.source,
        (SELECT r.status FROM inventory_reservations r WHERE r.order_id = o.id LIMIT 1) inv_status
      FROM orders o ${f.sql} ORDER BY ${sort} LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...f.binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM orders o ${f.sql}`).bind(...f.binds).first(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM orders WHERE archived_at IS NULL GROUP BY status").all()
  ]);
  return {
    orders: rows.results.map(r => ({ orderNumber: r.order_number, createdAt: r.created_at, updatedAt: r.updated_at, customerName: r.customer_name,
      phone: localPhone(r.customer_phone), city: r.city, district: r.district, boxes: r.boxes, total: r.total_amount, currency: r.currency,
      paymentMethod: r.payment_method, status: r.status, archived: !!r.archived_at, source: r.source, inventoryStatus: r.inv_status || null })),
    total: count.n, page, per, counts: Object.fromEntries(counts.results.map(r => [r.status, r.n]))
  };
}

// "Select all" = every order matching the current filter, capped so one click cannot touch the whole database.
export const BULK_MAX = 500;
export async function matchingNumbers(env, ctx, params) {
  need(ctx, "orders.view");
  const f = await filterFor(env, params);
  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT o.order_number FROM orders o ${f.sql} ORDER BY o.id DESC LIMIT ${BULK_MAX}`).bind(...f.binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM orders o ${f.sql}`).bind(...f.binds).first()
  ]);
  return { numbers: rows.results.map(r => r.order_number), total: count.n, max: BULK_MAX };
}

/* ---------- CSV export (respects the filters; formulas neutralised for Excel) ---------- */
export async function exportCsv(env, ctx, params) {
  need(ctx, "orders.export");
  const f = await filterFor(env, params);
  const rows = (await env.DB.prepare(`SELECT o.*, (SELECT group_concat(i.product_name_snapshot || ' × ' || i.quantity, ' | ') FROM order_items i WHERE i.order_id = o.id) products,
      (SELECT SUM(i.quantity) FROM order_items i WHERE i.order_id = o.id) qty
    FROM orders o ${f.sql} ORDER BY o.id DESC LIMIT 10000`).bind(...f.binds).all()).results;
  const cell = v => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["Order Number", "Date", "Customer Name", "Mobile", "City", "District", "Address", "Products", "Quantity", "Subtotal", "Discount", "Shipping", "Total", "Payment Method", "Status", "Created At", "Updated At"];
  const fmt = iso => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
  const lines = [head.join(",")].concat(rows.map(o => [o.order_number, fmt(o.created_at).slice(0, 10), o.customer_name, localPhone(o.customer_phone), o.city, o.district, o.address,
    o.products, o.qty, o.subtotal, o.discount_amount, o.shipping_amount, o.total_amount, o.payment_method === "cod" ? "Cash on delivery" : o.payment_method,
    LABELS[o.status] ? LABELS[o.status].en : o.status, fmt(o.created_at), fmt(o.updated_at)].map(cell).join(",")));
  await audit(env, ctx, "orders_exported", "orders", null, null, { filter: Object.fromEntries(params), rows: rows.length });
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/* ---------- one order ---------- */
async function getOrderOr404(env, number) {
  const n = normalizeOrderNumber(number);
  const full = n && await loadOrder(env.DB, n);
  if (!full) throw new HttpError(404, { error: "not_found" });
  return full;
}

export async function orderDetail(env, ctx, number) {
  need(ctx, "orders.view");
  const full = await getOrderOr404(env, number), o = full.order, fin = ctx.perms.has("finance.view");
  const [notes, auditRows, reservations, invTx] = await Promise.all([
    env.DB.prepare("SELECT note, created_by, created_at FROM order_notes WHERE order_id = ?1 ORDER BY id").bind(o.id).all(),
    ctx.perms.has("audit.view") || ctx.perms.has("orders.edit_customer")
      ? env.DB.prepare("SELECT username, action, old_value, new_value, created_at FROM audit_logs WHERE entity_type = 'order' AND entity_id = ?1 ORDER BY id DESC LIMIT 200").bind(o.order_number).all()
      : Promise.resolve({ results: [] }),
    ctx.perms.has("inventory.view") ? env.DB.prepare("SELECT * FROM inventory_reservations WHERE order_id = ?1").bind(o.id).all() : Promise.resolve({ results: [] }),
    ctx.perms.has("inventory.view") ? env.DB.prepare("SELECT * FROM inventory_transactions WHERE order_id = ?1 ORDER BY id").bind(o.id).all() : Promise.resolve({ results: [] })
  ]);
  const delivered = o.status === "DELIVERED", closed = ["CANCELLED", "FAILED"].includes(o.status);
  return {
    id: o.id, orderNumber: o.order_number, status: o.status, createdAt: o.created_at, updatedAt: o.updated_at, lang: o.lang,
    paymentMethod: o.payment_method, boxes: o.boxes, subtotal: o.subtotal, discount: o.discount_amount, shipping: o.shipping_amount,
    total: o.total_amount, currency: o.currency, archived: !!o.archived_at, anonymized: !!o.anonymized_at, locked: LOCKED.includes(o.status),
    source: o.source, createdBy: o.created_by, manualDiscount: o.manual_discount, manualDiscountReason: o.manual_discount_reason,
    // cash on delivery: collected when the order is delivered; nothing is owed on a cancelled / failed order
    payment: { status: delivered ? "COLLECTED" : closed ? "NONE" : "PENDING", collected: delivered ? o.total_amount : 0, outstanding: delivered || closed ? 0 : o.total_amount },
    customer: { name: o.customer_name, phone: localPhone(o.customer_phone), phoneIntl: o.customer_phone, city: o.city, district: o.district,
      address: o.address, notes: o.customer_notes, location: o.location_latitude != null ? { lat: o.location_latitude, lng: o.location_longitude } : null },
    items: full.items.map(i => ({ id: i.id, productId: i.product_id, name: i.product_name_snapshot, boxesPerUnit: i.boxes_per_unit,
      unitPrice: i.unit_price, priceOverridden: !!i.price_overridden, quantity: i.quantity, lineTotal: i.line_total })),
    history: full.history.map(h => ({ from: h.previous_status, to: h.new_status, by: h.changed_by, note: h.note, visibility: h.visibility, bulk: !!h.bulk_id, at: h.created_at })),
    notes: notes.results.map(x => ({ note: x.note, by: x.created_by, at: x.created_at })),
    audit: auditRows.results.map(a => ({ by: a.username, action: a.action, old: a.old_value, new: a.new_value, at: a.created_at })),
    inventory: ctx.perms.has("inventory.view") ? {
      reservations: reservations.results.map(r => ({ product: r.product_id, status: r.status, requested: r.requested_qty, reserved: r.reserved_qty, shortage: r.shortage_qty,
        availableBefore: r.available_at_order, availableAfter: r.available_after, reservedAt: r.reserved_at, releasedAt: r.released_at, committedAt: r.committed_at,
        ...(fin ? { cogs: sar(r.cogs_halalas), cogsComplete: !!r.cogs_complete } : {}) })),
      transactions: invTx.results.map(t => ({ type: t.type, quantity: t.quantity, availableBefore: t.available_before, availableAfter: t.available_after,
        onHandBefore: t.on_hand_before, onHandAfter: t.on_hand_after, actor: t.actor, at: t.created_at, ...(fin ? { cost: sar(t.cost_halalas) } : {}) })),
      canAllocate: ctx.perms.has("inventory.manage") && reservations.results.some(r => r.status === "SHORTAGE")
    } : null,
    nextStatuses: o.anonymized_at ? [] : nextOptions(ctx.perms, o.status),
    can: Object.fromEntries(["orders.edit_customer", "orders.edit_items", "orders.edit_price", "orders.notes", "orders.revoke_link", "orders.archive", "orders.anonymize"]
      .map(p => [p.split(".")[1], ctx.perms.has(p) && !o.anonymized_at]))
  };
}
/* ---------- status change: one transition, used by the single and the bulk change ----------
   The order update, its history, the customer notification and every stock movement are one transaction. The stock
   statements are guarded by the new (status, updated_at) the same transaction writes, so a duplicated, retried or
   concurrent request can never reserve, release or consume twice. */
async function applyTransition(env, ctx, full, to, { note, visibility, kind, bulkId = null }) {
  const o = full.order, db = env.DB;
  const msg = notifyMessage(to, o.lang, o.order_number) + (visibility === "customer" && note ? " " + note : "");
  let t;
  const res = await runWithRetry(async () => {
    t = new Date().toISOString();
    const inv = await transitionStmts(db, { order: o, items: full.items, from: o.status, to, actor: ctx.user.username, userId: ctx.user.id, t, g: orderGuard(o.id, to, t) });
    // when stock moves, the order must not have changed since it was read (its reservation was read with it)
    const upd = inv.length
      ? db.prepare("UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4 AND updated_at = ?5").bind(to, t, o.id, o.status, o.updated_at)
      : db.prepare("UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4").bind(to, t, o.id, o.status);
    return [
      upd,
      // each insert runs only if the update above changed the row, so a lost race writes nothing
      db.prepare(`INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, user_id, note, visibility, bulk_id, ip_address, user_agent, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE changes() = 1`).bind(o.id, o.status, to, ctx.user.username, ctx.user.id, note, visibility, bulkId, ctx.ip, (ctx.ua || "").slice(0, 300), t),
      db.prepare("INSERT INTO notification_outbox (order_id, event, lang, message, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1").bind(o.id, to, o.lang, msg, t),
      ...inv,
      ...(bulkId ? [] : [auditStmt(env, ctx, to === "CANCELLED" ? "order_cancelled" : "order_status_changed", "order", o.order_number, { status: o.status }, { status: to, note, visibility, override: kind === "override" })])
    ];
  }, db);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "status_changed" });
  if (ruleOf(o.status) !== ruleOf(to)) { try { await checkAlert(db); } catch (e) { console.log("stock alert failed:", e.message); } }
}

export async function changeStatus(env, ctx, number, body) {
  const full = await getOrderOr404(env, number), o = full.order;
  if (o.anonymized_at) throw new HttpError(409, { error: "anonymized" });
  const to = String(body && body.status || "");
  const kind = allowedTransition(ctx.perms, o.status, to);
  if (!kind) throw new HttpError(STATUSES.includes(to) ? 403 : 422, { error: STATUSES.includes(to) ? "transition_not_allowed" : "invalid_status", from: o.status, to });
  if (kind === "override" && body.override !== true) throw new HttpError(409, { error: "override_confirmation_required", from: o.status, to });
  if (body.expectedStatus && body.expectedStatus !== o.status) throw new HttpError(409, { error: "status_changed", status: o.status });
  await applyTransition(env, ctx, full, to, { note: cleanNote(body.note), visibility: body.visibility === "customer" ? "customer" : "internal", kind });
  return orderDetail(env, ctx, o.order_number);
}

/* ---------- status change: many orders ----------
   Each order goes through the same transition as a single change (so stock follows every order exactly as it would one by
   one); an order that cannot move — wrong status, stock shortage, changed meanwhile — is skipped with its reason. */
export async function bulkStatus(env, ctx, body) {
  need(ctx, "orders.status.bulk");
  const to = String(body && body.status || "");
  if (!STATUSES.includes(to)) throw new HttpError(422, { error: "invalid_status" });
  const numbers = [...new Set((Array.isArray(body.numbers) ? body.numbers : []).map(normalizeOrderNumber).filter(Boolean))];
  if (!numbers.length) throw new HttpError(422, { error: "nothing_selected" });
  if (numbers.length > BULK_MAX) throw new HttpError(422, { error: "too_many", max: BULK_MAX });
  if (body.expectedCount != null && Number(body.expectedCount) !== numbers.length) throw new HttpError(409, { error: "selection_changed" });
  const override = body.override === true;
  const note = cleanNote(body.note), visibility = body.visibility === "customer" ? "customer" : "internal";
  const bulkId = crypto.randomUUID(), updated = [], skipped = [];
  for (const n of numbers) {
    const full = await loadOrder(env.DB, n);
    if (!full) { skipped.push({ orderNumber: n, reason: "not_found" }); continue; }
    const o = full.order;
    if (o.anonymized_at) { skipped.push({ orderNumber: n, reason: "anonymized", status: o.status }); continue; }
    if (o.status === to) { skipped.push({ orderNumber: n, reason: "already", status: o.status }); continue; }
    const kind = allowedTransition(ctx.perms, o.status, to);
    if (!(kind === "normal" || (kind === "override" && override))) { skipped.push({ orderNumber: n, reason: "transition_not_allowed", status: o.status }); continue; }
    try { await applyTransition(env, ctx, full, to, { note, visibility, kind, bulkId }); updated.push(n); }
    catch (e) {
      if (!(e instanceof HttpError)) throw e;
      skipped.push({ orderNumber: n, reason: e.body.error, status: o.status, ...(e.body.shortage != null ? { shortage: e.body.shortage } : {}) });
    }
  }
  await audit(env, ctx, "bulk_status_update", "orders", bulkId, null, { to, note, visibility, override, requested: numbers.length, updated: updated.length, orders: updated, skipped: skipped.map(s => s.orderNumber) });
  return { updated: updated.length, skipped, bulkId };
}
/* ---------- edit customer / delivery details ---------- */
const CUSTOMER_FIELDS = { name: ["customer_name", 60, 2], phone: ["customer_phone", 20, 0], city: ["city", 60, 2], district: ["district", 60, 2], address: ["address", 200, 3], notes: ["customer_notes", 500, 0] };
export async function editCustomer(env, ctx, number, body) {
  need(ctx, "orders.edit_customer");
  const full = await getOrderOr404(env, number), o = full.order;
  if (o.anonymized_at) throw new HttpError(409, { error: "anonymized" });
  if (body.expectedUpdatedAt && body.expectedUpdatedAt !== o.updated_at) throw new HttpError(409, { error: "order_changed" });
  const changes = [], errors = {};
  for (const [key, [col, max, min]] of Object.entries(CUSTOMER_FIELDS)) {
    if (!(key in (body.customer || {}))) continue;
    let v = key === "phone" ? normalizePhone(body.customer.phone) : clean(body.customer[key], max);
    if (key === "phone" && !v) { errors.phone = "invalid_phone"; continue; }
    if (key === "name" && !/\p{L}/u.test(v)) { errors.name = "required"; continue; }
    if (v.length < min) { errors[key] = "required"; continue; }
    if (v !== o[col]) changes.push({ key, col, old: o[col], new: v });
  }
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  if (!changes.length) return orderDetail(env, ctx, o.order_number);
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET ${changes.map((c, i) => `${c.col} = ?${i + 1}`).join(", ")}, updated_at = ?${changes.length + 1} WHERE id = ?${changes.length + 2}`)
      .bind(...changes.map(c => c.new), t, o.id),
    ...changes.map(c => auditStmt(env, ctx, "order_customer_changed", "order", o.order_number, { field: c.key, value: c.key === "phone" ? localPhone(c.old) : c.old }, { field: c.key, value: c.key === "phone" ? localPhone(c.new) : c.new }))
  ]);
  return orderDetail(env, ctx, o.order_number);
}

/* ---------- edit items (server recalculates every total) ---------- */
export async function editItems(env, ctx, number, body) {
  need(ctx, "orders.edit_items");
  const full = await getOrderOr404(env, number), o = full.order;
  if (o.anonymized_at) throw new HttpError(409, { error: "anonymized" });
  if (["CANCELLED", "FAILED"].includes(o.status)) throw new HttpError(409, { error: "order_closed" });
  if (LOCKED.includes(o.status) && body.force !== true) throw new HttpError(409, { error: "order_locked", status: o.status });
  if (body.expectedUpdatedAt && body.expectedUpdatedAt !== o.updated_at) throw new HttpError(409, { error: "order_changed" });
  const catalog = await getCatalog(env);
  const wanted = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  if (!wanted.length) throw new HttpError(422, { error: "validation", fields: { items: "empty" } });
  const reason = clean(body.reason, 200);
  const existing = new Map(full.items.map(i => [i.id, i]));
  const lines = [], events = [];
  let priceChanged = false;
  for (const w of wanted) {
    const qty = Number(w.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(422, { error: "validation", fields: { items: "invalid_quantity" } });
    const ex = w.id != null ? existing.get(Number(w.id)) : null;
    if (w.id != null && !ex) throw new HttpError(422, { error: "validation", fields: { items: "unknown_item" } });
    const bundle = catalog.bundles.find(b => b.id === (ex ? ex.product_id : w.productId));
    if (!ex && !bundle) throw new HttpError(422, { error: "validation", fields: { items: "unknown_product" } });
    const basePrice = ex ? ex.unit_price : bundle.price;
    let price = basePrice, overridden = ex ? !!ex.price_overridden : false;
    if (w.unitPrice != null && Number(w.unitPrice) !== basePrice) {
      need(ctx, "orders.edit_price");
      const p = Number(w.unitPrice);
      if (!Number.isInteger(p) || p < 0 || p > 100000) throw new HttpError(422, { error: "validation", fields: { items: "invalid_price" } });
      if (reason.length < 3) throw new HttpError(422, { error: "validation", fields: { reason: "required" } });
      price = p; overridden = true; priceChanged = true;
    }
    const label = (t, p) => p ? `${t} · ${p}` : t;
    lines.push({ ex, productId: ex ? ex.product_id : bundle.id, name: ex ? ex.product_name_snapshot : label(bundle.title, bundle.program),
      nameEn: ex ? ex.product_name_en_snapshot : label(bundle.title_en, bundle.program_en), boxesPerUnit: ex ? ex.boxes_per_unit : bundle.boxes,
      unitPrice: price, overridden, quantity: qty, catalogPrice: bundle ? bundle.price : null });
    if (!ex) events.push(["order_item_added", null, { product: lines.at(-1).name, quantity: qty, unitPrice: price }]);
    else {
      if (ex.quantity !== qty) events.push(["order_item_quantity_changed", { product: ex.product_name_snapshot, quantity: ex.quantity }, { product: ex.product_name_snapshot, quantity: qty }]);
      if (ex.unit_price !== price) events.push(["order_item_price_changed", { product: ex.product_name_snapshot, unitPrice: ex.unit_price }, { product: ex.product_name_snapshot, unitPrice: price, reason }]);
    }
    if (!ex && price !== bundle.price) events.push(["order_item_price_changed", { product: lines.at(-1).name, unitPrice: bundle.price }, { product: lines.at(-1).name, unitPrice: price, reason }]);
  }
  const keptIds = new Set(lines.filter(l => l.ex).map(l => l.ex.id));
  if (keptIds.size !== lines.filter(l => l.ex).length) throw new HttpError(422, { error: "validation", fields: { items: "duplicate_item" } });
  for (const ex of full.items) if (!keptIds.has(ex.id)) events.push(["order_item_removed", { product: ex.product_name_snapshot, quantity: ex.quantity, unitPrice: ex.unit_price }, null]);
  if (!events.length) return orderDetail(env, ctx, o.order_number);

  // Totals: the bundle best-price discount applies to lines at their normal price; overridden prices are taken as given.
  // A manual discount given when the order was created is kept (never more than what is left to pay for the products).
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const boxes = lines.reduce((s, l) => s + l.boxesPerUnit * l.quantity, 0);
  const normal = lines.filter(l => !l.overridden);
  const normalSum = normal.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const normalBoxes = normal.reduce((s, l) => s + l.boxesPerUnit * l.quantity, 0);
  const bundleDiscount = normalBoxes ? normalSum - Math.min(normalSum, priceForBoxes(normalBoxes, catalog)) : 0;
  const manual = Math.min(o.manual_discount || 0, subtotal - bundleDiscount);
  const discount = bundleDiscount + manual;
  const net = subtotal - discount;
  const shipping = catalog.freeShippingFrom && net >= catalog.freeShippingFrom ? 0 : catalog.shippingCost;
  const total = net + shipping, t = now();

  // The order row is updated first and only if nobody changed it meanwhile; every other statement checks that update
  // happened (same updated_at), so items, totals and the stock reservation change together or not at all.
  const G = "EXISTS (SELECT 1 FROM orders WHERE id = ? AND updated_at = ?)", gb = [o.id, t];
  const newItems = lines.map(l => ({ product_id: l.productId, boxes_per_unit: l.boxesPerUnit, quantity: l.quantity }));
  const inv = await requantityStmts(env.DB, { order: o, oldItems: full.items, newItems, actor: ctx.user.username, userId: ctx.user.id, t, g: { sql: G, binds: gb } });
  const stmts = [env.DB.prepare(`UPDATE orders SET boxes = ?, subtotal = ?, discount_amount = ?, manual_discount = ?, shipping_amount = ?, total_amount = ?, updated_at = ?
    WHERE id = ? AND updated_at = ?`).bind(boxes, subtotal, discount, manual, shipping, total, t, o.id, o.updated_at)];
  for (const ex of full.items) if (!keptIds.has(ex.id)) stmts.push(env.DB.prepare(`DELETE FROM order_items WHERE id = ? AND order_id = ? AND ${G}`).bind(ex.id, o.id, ...gb));
  for (const l of lines) {
    if (l.ex) stmts.push(env.DB.prepare(`UPDATE order_items SET quantity = ?, unit_price = ?, price_overridden = ?, line_total = ?, updated_at = ? WHERE id = ? AND order_id = ? AND ${G}`)
      .bind(l.quantity, l.unitPrice, l.overridden ? 1 : 0, l.unitPrice * l.quantity, t, l.ex.id, o.id, ...gb));
    else stmts.push(env.DB.prepare(`INSERT INTO order_items (order_id, product_id, product_name_snapshot, product_name_en_snapshot, boxes_per_unit, unit_price, price_overridden, quantity, line_total, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${G}`).bind(o.id, l.productId, l.name, l.nameEn, l.boxesPerUnit, l.unitPrice, l.overridden ? 1 : 0, l.quantity, l.unitPrice * l.quantity, t, t, ...gb));
  }
  stmts.push(...inv);
  for (const [action, oldV, newV] of events) stmts.push(auditStmt(env, ctx, action, "order", o.order_number, oldV, newV));
  stmts.push(auditStmt(env, ctx, "order_totals_recalculated", "order", o.order_number,
    { subtotal: o.subtotal, discount: o.discount_amount, shipping: o.shipping_amount, total: o.total_amount },
    { subtotal, discount, shipping, total, reason: reason || undefined, forcedAfter: LOCKED.includes(o.status) ? o.status : undefined }));
  const res = await env.DB.batch(stmts);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "order_changed" });
  if (inv.length) { try { await checkAlert(env.DB); } catch (e) { console.log("stock alert failed:", e.message); } }
  return orderDetail(env, ctx, o.order_number);
}
/* ---------- notes, archive, secure link, privacy erase ---------- */
export async function addNote(env, ctx, number, body) {
  need(ctx, "orders.notes");
  const o = (await getOrderOr404(env, number)).order, note = cleanNote(body && body.note);
  if (!note) throw new HttpError(422, { error: "empty_note" });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO order_notes (order_id, note, created_by, user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(o.id, note, ctx.user.username, ctx.user.id, now()),
    auditStmt(env, ctx, "order_note_added", "order", o.order_number, null, { note })
  ]);
  return orderDetail(env, ctx, o.order_number);
}

export async function setArchived(env, ctx, number, body) {
  need(ctx, "orders.archive");
  const o = (await getOrderOr404(env, number)).order, archive = body && body.archived === true;
  if (archive && !["DELIVERED", "CANCELLED", "FAILED"].includes(o.status)) throw new HttpError(409, { error: "only_finished_orders" });
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET archived_at = ?1 WHERE id = ?2").bind(archive ? now() : null, o.id),
    auditStmt(env, ctx, archive ? "order_archived" : "order_unarchived", "order", o.order_number)
  ]);
  return orderDetail(env, ctx, o.order_number);
}

export async function revokeLink(env, ctx, number) {
  need(ctx, "orders.revoke_link");
  const o = (await getOrderOr404(env, number)).order;
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET token_version = token_version + 1 WHERE id = ?1").bind(o.id),
    auditStmt(env, ctx, "order_link_revoked", "order", o.order_number, { tokenVersion: o.token_version }, { tokenVersion: o.token_version + 1 })
  ]);
  return orderDetail(env, ctx, o.order_number);
}

// Orders are never deleted. For a privacy request the personal data is erased; amounts and history stay.
export async function anonymize(env, ctx, number, body) {
  need(ctx, "orders.anonymize");
  const o = (await getOrderOr404(env, number)).order;
  if (o.anonymized_at) throw new HttpError(409, { error: "anonymized" });
  if (!body || body.confirm !== o.order_number) throw new HttpError(422, { error: "confirmation_required" });
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET customer_name = 'محذوف', customer_phone = '966500000000', city = '—', district = '—', address = '—', customer_notes = '',
      location_latitude = NULL, location_longitude = NULL, anonymized_at = ?1, token_version = token_version + 1, updated_at = ?1 WHERE id = ?2`).bind(t, o.id),
    env.DB.prepare("UPDATE order_notes SET note = '[محذوف]' WHERE order_id = ?1").bind(o.id),
    env.DB.prepare("UPDATE orders SET customer_id = NULL WHERE id = ?1").bind(o.id),
    env.DB.prepare("DELETE FROM customers WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = ?1)").bind(o.customer_id ?? -1),
    auditStmt(env, ctx, "order_anonymized", "order", o.order_number, null, { reason: clean(body.reason, 200) })
  ]);
  return orderDetail(env, ctx, o.order_number);
}

/* ---------- dashboard and reports (optional ?city=<key>) ---------- */
// " AND city IN (?n, …)" numbered after the query's own parameters; " AND 0" for a city without orders; "" without a filter
function cityClause(spellings, col, first) {
  if (!spellings) return "";
  if (!spellings.length) return " AND 0";
  return ` AND ${col} IN (${spellings.map((_, i) => "?" + (first + i)).join(",")})`;
}
const cityFilterFor = async (env, params) => { const key = cityKeyParam(params); return key ? await citySpellings(env, key) : null; };

export async function cityList(env, ctx) {
  if (!["dashboard.view", "orders.view", "reports.view"].some(p => ctx.perms.has(p))) throw new HttpError(403, { error: "forbidden" });
  const rows = (await env.DB.prepare("SELECT city, COUNT(*) n FROM orders WHERE anonymized_at IS NULL GROUP BY city").all()).results;
  return { cities: groupCities(rows).map(c => ({ key: c.key, name: c.name, orders: c.n })) };
}

export async function dashboard(env, ctx, params = new URLSearchParams()) {
  need(ctx, "dashboard.view");
  const sp = await cityFilterFor(env, params), cb = sp || [];
  const today = riyadhMidnight(0).toISOString();
  const [byStatus, todayRow, latest] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) n FROM orders WHERE archived_at IS NULL${cityClause(sp, "city", 1)} GROUP BY status`).bind(...cb).all(),
    env.DB.prepare(`SELECT COUNT(*) n FROM orders WHERE created_at >= ?1${cityClause(sp, "city", 2)}`).bind(today, ...cb).first(),
    env.DB.prepare(`SELECT order_number, customer_name, customer_phone, city, total_amount, currency, payment_method, status, created_at, updated_at, archived_at
      FROM orders WHERE 1${cityClause(sp, "city", 1)} ORDER BY id DESC LIMIT 8`).bind(...cb).all()
  ]);
  const inventory = ctx.perms.has("inventory.view") ? await stockSummary(env, ctx) : null;
  return { today: todayRow.n, byStatus: Object.fromEntries(byStatus.results.map(r => [r.status, r.n])), inventory,
    latest: latest.results.map(r => ({ orderNumber: r.order_number, customerName: r.customer_name, phone: localPhone(r.customer_phone), city: r.city, total: r.total_amount,
      currency: r.currency, paymentMethod: r.payment_method, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, archived: !!r.archived_at })) };
}

export async function reports(env, ctx, params) {
  need(ctx, "reports.view");
  const days = [7, 30, 90].includes(Number(params.get("days"))) ? Number(params.get("days")) : 30;
  const since = riyadhMidnight(-(days - 1)).toISOString();
  const sp = await cityFilterFor(env, params), cb = sp || [], C1 = cityClause(sp, "city", 1), C2 = cityClause(sp, "city", 2);
  const REV = "status NOT IN ('CANCELLED','FAILED')";
  const period = from => env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${REV} THEN total_amount END), 0) revenue FROM orders WHERE created_at >= ?1${C2}`).bind(from, ...cb).first();
  const [all, today, week, month, daily, status, products, cities] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${REV} THEN total_amount END), 0) revenue FROM orders WHERE 1${C1}`).bind(...cb).first(),
    period(riyadhMidnight(0).toISOString()), period(riyadhMidnight(-6).toISOString()), period(riyadhMidnight(-29).toISOString()),
    env.DB.prepare(`SELECT substr(datetime(created_at, '+3 hours'), 1, 10) d, COUNT(*) n, COALESCE(SUM(CASE WHEN ${REV} THEN total_amount END), 0) revenue
      FROM orders WHERE created_at >= ?1${C2} GROUP BY d ORDER BY d`).bind(since, ...cb).all(),
    env.DB.prepare(`SELECT status, COUNT(*) n FROM orders WHERE created_at >= ?1${C2} GROUP BY status`).bind(since, ...cb).all(),
    env.DB.prepare(`SELECT i.product_id, MAX(i.product_name_snapshot) name, SUM(i.quantity) qty, SUM(i.boxes_per_unit * i.quantity) boxes, SUM(i.line_total) revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.created_at >= ?1 AND o.${REV}${cityClause(sp, "o.city", 2)} GROUP BY i.product_id ORDER BY boxes DESC`).bind(since, ...cb).all(),
    // every city in the period (not narrowed by the city filter), so the cities can be compared and one picked
    env.DB.prepare(`SELECT city, COUNT(*) n, COALESCE(SUM(CASE WHEN ${REV} THEN total_amount END), 0) revenue, COALESCE(SUM(CASE WHEN ${REV} THEN boxes END), 0) boxes
      FROM orders WHERE created_at >= ?1 AND anonymized_at IS NULL GROUP BY city`).bind(since).all()
  ]);
  // fill missing days with zeros so the charts have a continuous axis
  const map = new Map(daily.results.map(r => [r.d, r])), series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(riyadhMidnight(-i).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
    series.push({ date: d, orders: map.get(d) ? map.get(d).n : 0, revenue: map.get(d) ? map.get(d).revenue : 0 });
  }
  return { days, totals: { all, today, week, month }, series, byStatus: Object.fromEntries(status.results.map(r => [r.status, r.n])),
    products: products.results.map(p => ({ productId: p.product_id, name: p.name, quantity: p.qty, boxes: p.boxes, revenue: p.revenue })),
    cities: groupCities(cities.results).map(c => ({ key: c.key, name: c.name, orders: c.n, revenue: c.revenue, boxes: c.boxes })) };
}

/* ---------- customers (from orders, grouped by mobile number) ---------- */
export async function customers(env, ctx, params) {
  need(ctx, "customers.view");
  const q = String(params.get("q") || "").trim().slice(0, 60), page = Math.max(1, parseInt(params.get("page"), 10) || 1), per = 25;
  const where = ["anonymized_at IS NULL"], binds = [];
  if (q) {
    const digits = latinDigits(q).replace(/\D/g, "");
    if (digits.length >= 4) { where.push(`customer_phone LIKE ?${binds.push("%" + digits.replace(/^0/, "").replace(/^966/, "") + "%")}`); }
    else where.push(`customer_name LIKE ?${binds.push("%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%")} ESCAPE '\\'`);
  }
  const w = "WHERE " + where.join(" AND ");
  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT customer_phone, (SELECT customer_name FROM orders x WHERE x.customer_phone = o.customer_phone ORDER BY id DESC LIMIT 1) name,
        (SELECT city FROM orders x WHERE x.customer_phone = o.customer_phone ORDER BY id DESC LIMIT 1) city,
        COUNT(*) orders, COALESCE(SUM(CASE WHEN status NOT IN ('CANCELLED','FAILED') THEN total_amount END), 0) spent, MAX(created_at) last_order
      FROM orders o ${w} GROUP BY customer_phone ORDER BY last_order DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(DISTINCT customer_phone) n FROM orders ${w}`).bind(...binds).first()
  ]);
  return { customers: rows.results.map(r => ({ phone: localPhone(r.customer_phone), name: r.name, city: r.city, orders: r.orders, spent: r.spent, lastOrder: r.last_order })),
    total: count.n, page, per };
}

export async function products(env, ctx) {
  need(ctx, "products.view");
  const catalog = await getCatalog(env);
  const sold = (await env.DB.prepare(`SELECT i.product_id, SUM(i.quantity) qty FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.status NOT IN ('CANCELLED','FAILED') GROUP BY i.product_id`).all()).results;
  return { bundles: catalog.bundles.map(b => ({ ...b, sold: (sold.find(s => s.product_id === b.id) || {}).qty || 0 })),
    pricing: { boxPriceAfterBundles: catalog.boxPriceAfterBundles, maxBoxesPerOrder: catalog.maxBoxesPerOrder, maxQtyPerLine: catalog.maxQtyPerLine,
      shippingCost: catalog.shippingCost, freeShippingFrom: catalog.freeShippingFrom, paymentMethods: catalog.paymentMethods, inStock: catalog.inStock, currency: catalog.currency } };
}

/* ---------- audit log ---------- */
export async function auditLog(env, ctx, params) {
  need(ctx, "audit.view");
  const where = [], binds = [], page = Math.max(1, parseInt(params.get("page"), 10) || 1), per = 50;
  const q = String(params.get("q") || "").trim().slice(0, 60);
  if (q) { const like = "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%"; where.push(`(entity_id LIKE ?${binds.push(like.toUpperCase())} ESCAPE '\\' OR username LIKE ?${binds.push(like)} ESCAPE '\\' OR action LIKE ?${binds.push(like)} ESCAPE '\\')`); }
  const action = params.get("action");
  if (/^[a-z_]{3,40}$/.test(action || "")) where.push(`action = ?${binds.push(action)}`);
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT * FROM audit_logs ${w} ORDER BY id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(*) n FROM audit_logs ${w}`).bind(...binds).first()
  ]);
  return { entries: rows.results.map(r => ({ id: r.id, by: r.username, action: r.action, entityType: r.entity_type, entityId: r.entity_id, old: r.old_value, new: r.new_value, ip: r.ip_address, ua: r.user_agent, at: r.created_at })),
    total: count.n, page, per };
}

/* ---------- admin users (Super Admin) ---------- */
const ROLES = ["super_admin", "order_manager", "support_agent"];
export async function listUsers(env, ctx) {
  need(ctx, "users.manage");
  const rows = (await env.DB.prepare(`SELECT u.id, u.username, u.display_name, u.role_id, r.name_ar role_name, u.is_active, u.totp_enabled, u.last_login_at, u.failed_login_attempts, u.locked_until, u.must_change_password, u.created_at
    FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`).all()).results;
  return { users: rows.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role_id, roleName: u.role_name, active: !!u.is_active,
    twoFactor: !!u.totp_enabled, lastLogin: u.last_login_at, locked: !!(u.locked_until && Date.parse(u.locked_until) > Date.now()), mustChangePassword: !!u.must_change_password, createdAt: u.created_at })),
    roles: ROLES };
}
async function activeSuperAdmins(env) { return (await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role_id = 'super_admin' AND is_active = 1").first()).n; }

export async function createUser(env, ctx, body) {
  need(ctx, "users.manage");
  const username = String(body.username || "").trim(), role = String(body.role || ""), password = String(body.password || "");
  if (!validUsername(username)) throw new HttpError(422, { error: "invalid_username" });
  if (!ROLES.includes(role)) throw new HttpError(422, { error: "invalid_role" });
  const problem = passwordProblem(password, username);
  if (problem) throw new HttpError(422, { error: "weak_password", reason: problem });
  if (await env.DB.prepare("SELECT 1 FROM users WHERE username = ?1").bind(username).first()) throw new HttpError(409, { error: "username_taken" });
  const t = now();
  // a temporary password set by the Super Admin must be changed at first login
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (username, display_name, password_hash, role_id, must_change_password, password_changed_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?5)`).bind(username, clean(body.displayName || username, 60), await hashPassword(env, password), role, t),
    auditStmt(env, ctx, "admin_user_created", "user", username, null, { role })
  ]);
  return listUsers(env, ctx);
}

export async function updateUser(env, ctx, id, body) {
  need(ctx, "users.manage");
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(Number(id)).first();
  if (!u) throw new HttpError(404, { error: "not_found" });
  const t = now(), stmts = [], changes = {};
  if (body.role != null && body.role !== u.role_id) {
    if (!ROLES.includes(body.role)) throw new HttpError(422, { error: "invalid_role" });
    if (u.role_id === "super_admin" && u.is_active && await activeSuperAdmins(env) <= 1) throw new HttpError(409, { error: "last_super_admin" });
    changes.role = [u.role_id, body.role];
    stmts.push(env.DB.prepare("UPDATE users SET role_id = ?1, updated_at = ?2 WHERE id = ?3").bind(body.role, t, u.id), revokeAllStmt(env, u.id));
  }
  if (body.active != null && !!body.active !== !!u.is_active) {
    if (!body.active && u.id === ctx.user.id) throw new HttpError(409, { error: "cannot_disable_self" });
    if (!body.active && u.role_id === "super_admin" && await activeSuperAdmins(env) <= 1) throw new HttpError(409, { error: "last_super_admin" });
    changes.active = [!!u.is_active, !!body.active];
    stmts.push(env.DB.prepare("UPDATE users SET is_active = ?1, updated_at = ?2 WHERE id = ?3").bind(body.active ? 1 : 0, t, u.id));
    if (!body.active) stmts.push(revokeAllStmt(env, u.id));
  }
  if (body.displayName != null && clean(body.displayName, 60) !== u.display_name) {
    changes.displayName = [u.display_name, clean(body.displayName, 60)];
    stmts.push(env.DB.prepare("UPDATE users SET display_name = ?1, updated_at = ?2 WHERE id = ?3").bind(clean(body.displayName, 60), t, u.id));
  }
  if (body.unlock === true) {
    changes.unlocked = true;
    stmts.push(env.DB.prepare("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?1").bind(u.id),
               env.DB.prepare("DELETE FROM login_throttle WHERE username_key = ?1").bind(u.username.toLowerCase()));
  }
  if (body.resetTwoFactor === true) {
    changes.twoFactorReset = true;
    stmts.push(env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, updated_at = ?1 WHERE id = ?2").bind(t, u.id), revokeAllStmt(env, u.id));
  }
  if (body.password != null) {
    const problem = passwordProblem(body.password, u.username);
    if (problem) throw new HttpError(422, { error: "weak_password", reason: problem });
    changes.passwordReset = true;
    stmts.push(env.DB.prepare("UPDATE users SET password_hash = ?1, must_change_password = 1, password_changed_at = ?2, updated_at = ?2 WHERE id = ?3").bind(await hashPassword(env, body.password), t, u.id), revokeAllStmt(env, u.id));
  }
  if (!stmts.length) return listUsers(env, ctx);
  stmts.push(auditStmt(env, ctx, "admin_user_updated", "user", u.username, null, changes));
  await env.DB.batch(stmts);
  return listUsers(env, ctx);
}

/* ---------- own account: password and 2FA ---------- */
export async function changeOwnPassword(env, ctx, body) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(ctx.user.id).first();
  if (!(await verifyPassword(env, String(body.current || ""), u.password_hash))) {
    await audit(env, ctx, "password_change_failed", "user", u.username);
    throw new HttpError(401, { error: "invalid_credentials" });
  }
  const problem = passwordProblem(body.next, u.username);
  if (problem) throw new HttpError(422, { error: "weak_password", reason: problem });
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?1, must_change_password = 0, password_changed_at = ?2, updated_at = ?2 WHERE id = ?3").bind(await hashPassword(env, body.next), t, u.id),
    revokeAllStmt(env, u.id, ctx.session.id),                       // other devices are signed out
    auditStmt(env, ctx, "password_changed", "user", u.username)
  ]);
  return { ok: true };
}

export async function startTwoFactor(env, ctx) {
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  await env.DB.prepare("UPDATE users SET totp_secret_enc = ?1, totp_enabled = 0, updated_at = ?2 WHERE id = ?3 AND totp_enabled = 0").bind(await encryptSecret(env, secret), now(), ctx.user.id).run();
  const label = encodeURIComponent(`CalmGastro Admin:${ctx.user.username}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("CalmGastro Admin")}&algorithm=SHA1&digits=6&period=30` };
}
export async function enableTwoFactor(env, ctx, body) {
  const u = await env.DB.prepare("SELECT totp_secret_enc, totp_enabled, totp_last_step, username FROM users WHERE id = ?1").bind(ctx.user.id).first();
  if (!u.totp_secret_enc || u.totp_enabled) throw new HttpError(409, { error: "two_factor_state" });
  const step = await verifyTotp(await decryptSecret(env, u.totp_secret_enc), body && body.code, u.totp_last_step);
  if (!step) throw new HttpError(422, { error: "invalid_code" });
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET totp_enabled = 1, totp_last_step = ?1, updated_at = ?2 WHERE id = ?3").bind(step, now(), ctx.user.id),
    auditStmt(env, ctx, "two_factor_enabled", "user", u.username)
  ]);
  return { ok: true };
}
export async function disableTwoFactor(env, ctx, body) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(ctx.user.id).first();
  if (!u.totp_enabled) throw new HttpError(409, { error: "two_factor_state" });
  const okPw = await verifyPassword(env, String(body.password || ""), u.password_hash);
  const step = okPw ? await verifyTotp(await decryptSecret(env, u.totp_secret_enc), body.code, u.totp_last_step) : 0;
  if (!step) throw new HttpError(401, { error: "invalid_credentials" });
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, updated_at = ?1 WHERE id = ?2").bind(now(), u.id),
    auditStmt(env, ctx, "two_factor_disabled", "user", u.username)
  ]);
  return { ok: true };
}

/* ---------- full backup (Super Admin): business data as JSON, without password hashes or 2FA secrets ---------- */
export async function backup(env, ctx) {
  need(ctx, "settings.manage");
  const tables = ["orders", "order_items", "order_status_history", "order_notes", "notification_outbox", "order_counters", "audit_logs", "roles", "permissions", "role_permissions", "catalog_cache",
    "customers", "products", "inventory_settings", "inventory_balances", "inventory_batches", "inventory_reservations", "inventory_consumptions", "inventory_adjustments",
    "inventory_transactions", "inventory_alerts", "expense_categories", "expenses"];
  const out = { exportedAt: now(), exportedBy: ctx.user.username, schema: "0003", tables: {} };
  for (const t of tables) out.tables[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid LIMIT 100000`).all()).results;
  out.tables.users = (await env.DB.prepare("SELECT id, username, display_name, role_id, is_active, created_at, updated_at FROM users ORDER BY id").all()).results;
  await audit(env, ctx, "backup_downloaded", "system", null, null, Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length])));
  return out;
}

/* ---------- orders created by an admin on behalf of a customer ----------
   Same validation, pricing (website offers / best price), customer record, stock reservation and history as a website
   order (orders.insertOrder); only source = ADMIN and created_by differ. preview=true returns the totals and the stock
   impact without writing anything; the order is created only when the admin confirms. */
const ADMIN_INITIAL = ["RECEIVED", "CONFIRMED"];
export async function adminOrder(env, ctx, body) {
  need(ctx, "orders.create");
  body = body || {};
  let catalog;
  try { catalog = await getCatalog(env); } catch (e) { throw new HttpError(503, { error: "catalog_unavailable" }); }
  const boxes = Number(body.quantity);
  if (!Number.isInteger(boxes) || boxes < 1) throw new HttpError(422, { error: "validation", fields: { quantity: "invalid" } });
  if (boxes > catalog.maxBoxesPerOrder) throw new HttpError(422, { error: "validation", fields: { quantity: "max_boxes" }, max: catalog.maxBoxesPerOrder });
  const items = linesForBoxes(boxes, catalog);
  if (!items) throw new HttpError(422, { error: "validation", fields: { quantity: "invalid" } });
  const status = ADMIN_INITIAL.includes(body.status) ? body.status : "RECEIVED";
  if (status === "CONFIRMED" && !ctx.perms.has("orders.status") && !ctx.perms.has("orders.status.limited")) throw new HttpError(403, { error: "forbidden", permission: "orders.status" });
  const key = body.preview === true && !body.idempotencyKey ? "preview-" + "0".repeat(16) : String(body.idempotencyKey || "");
  const v = validateOrderInput({ customer: body.customer, items, paymentMethod: body.paymentMethod || "cod", idempotencyKey: key, lang: body.lang === "en" ? "en" : "ar" }, catalog);
  if (v.errors) throw new HttpError(422, { error: "validation", fields: v.errors });
  const o = v.value, q = quote(o.items, catalog);

  // optional manual discount: never above what the products cost after the offer price
  let manual = 0, manualReason = "";
  if (body.discount != null && body.discount !== "" && Number(body.discount) !== 0) {
    need(ctx, "orders.discount");
    manual = Number(body.discount); manualReason = clean(body.discountReason, 200);
    if (!Number.isInteger(manual) || manual < 0 || manual > q.subtotal - q.discount) throw new HttpError(422, { error: "validation", fields: { discount: "invalid" } });
    if (manualReason.length < 3) throw new HttpError(422, { error: "validation", fields: { discountReason: "required" } });
  }
  const existing = await env.DB.prepare("SELECT * FROM customers WHERE phone = ?").bind(o.customer.phone).first();
  const stock = await reservationPreview(env.DB, boxes);
  const totals = { boxes: q.boxes, lines: q.lines.map(l => ({ name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    subtotal: q.subtotal, offerDiscount: q.discount, manualDiscount: manual, discount: q.discount + manual, shipping: q.shipping, total: q.subtotal - q.discount - manual + q.shipping, currency: q.currency };
  const customer = existing ? { existing: true, id: existing.id, name: existing.name, city: existing.city, district: existing.district, address: existing.address } : { existing: false };
  if (body.preview === true) return { preview: true, status, source: "ADMIN", totals, stock, customer };

  if (stock.initialized && stock.shortage > 0 && body.allowShortage !== true)
    throw new HttpError(409, { error: "insufficient_stock", requested: boxes, available: stock.available, shortage: stock.shortage, toReserve: stock.toReserve });
  const replay = await findReplay(env, o, await sha256(JSON.stringify(["admin", o.items, o.customer, manual, status])));
  if (replay) return { replay: true, orderNumber: replay.number };
  const internalNote = cleanNote(body.internalNote);
  const created = await insertOrder(env, catalog, o, q, {
    source: "ADMIN", actor: ctx.user.username, userId: ctx.user.id, status, manualDiscount: manual, manualReason, internalNote,
    saveProfile: !existing || body.saveProfile === true,
    auditStmt: auditStmt(env, ctx, "order_created_by_admin", "order", null, null, {
      idempotencyKey: o.key, customerPhone: localPhone(o.customer.phone), existingCustomer: !!existing, boxes, subtotal: q.subtotal, offerDiscount: q.discount,
      manualDiscount: manual, manualDiscountReason: manualReason || undefined, total: totals.total, status, stock: stock.initialized ? { available: stock.available, toReserve: stock.toReserve, shortage: stock.shortage } : null })
  });
  return { replay: created.replay, orderNumber: created.number, order: await orderDetail(env, ctx, created.number) };
}

/* Search saved customers by mobile number or name (admin order form). */
export async function customerLookup(env, ctx, params) {
  if (!ctx.perms.has("orders.create") && !ctx.perms.has("customers.view")) throw new HttpError(403, { error: "forbidden" });
  const q = String(params.get("q") || "").trim().slice(0, 60);
  if (q.length < 2) return { customers: [] };
  const digits = latinDigits(q).replace(/\D/g, "");
  const rows = digits.length >= 4
    ? (await env.DB.prepare("SELECT * FROM customers WHERE phone LIKE ? ORDER BY updated_at DESC LIMIT 10").bind("%" + digits.replace(/^0/, "").replace(/^966/, "") + "%").all()).results
    : (await env.DB.prepare("SELECT * FROM customers WHERE name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 10").bind("%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%").all()).results;
  return { customers: rows.map(c => ({ id: c.id, name: c.name, phone: localPhone(c.phone), city: c.city, district: c.district, address: c.address })) };
}
