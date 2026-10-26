/* Admin API: every handler receives ctx = { user, perms, session, ip, ua } from an authenticated session.
   Permissions are checked here, on the server, for every action. */
import { STATUSES, FLOW, LABELS, LOCKED, allowedTransition, nextOptions, notifyMessage } from "./statuses.js";
import { loadOrder, localPhone, normalizeOrderNumber, normalizePhone, latinDigits, HttpError } from "./orders.js";
import { getCatalog, priceForBoxes } from "./catalog.js";
import { audit, auditStmt, hashPassword, verifyPassword, passwordProblem, validUsername, revokeAllStmt,
         encryptSecret, decryptSecret, verifyTotp, base32 } from "./auth.js";

export const need = (ctx, perm) => { if (!ctx.perms.has(perm)) throw new HttpError(403, { error: "forbidden", permission: perm }); };
const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanNote = v => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, 1000);
const DAY = 86400000;

/* ---------- navigation for the signed-in admin (sidebar shows only what the role may open) ---------- */
const NAV = [
  ["dashboard", "dashboard.view"], ["orders", "orders.view"], ["customers", "customers.view"], ["products", "products.view"],
  ["reports", "reports.view"], ["audit", "audit.view"], ["users", "users.manage"], ["settings", null]
];
export function me(ctx) {
  return { user: ctx.user, permissions: [...ctx.perms].sort(), nav: NAV.filter(([, p]) => !p || ctx.perms.has(p)).map(([k]) => k) };
}

/* ---------- filters shared by the list, "select all", bulk and export ---------- */
// Riyadh is UTC+3 all year; date filters are Riyadh calendar days.
const riyadhMidnight = (offsetDays = 0) => { const r = new Date(Date.now() + 3 * 3600e3); r.setUTCHours(0, 0, 0, 0); return new Date(r.getTime() - 3 * 3600e3 + offsetDays * DAY); };
const dayStart = d => new Date(Date.parse(d + "T00:00:00+03:00"));

function orderFilter(params) {
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
  const f = orderFilter(params);
  const per = [25, 50, 100].includes(Number(params.get("per"))) ? Number(params.get("per")) : 25;
  const page = Math.max(1, Math.min(100000, parseInt(params.get("page"), 10) || 1));
  const sort = params.get("sort") === "updated" ? "o.updated_at DESC" : "o.id DESC";
  const [rows, count, counts] = await Promise.all([
    env.DB.prepare(`SELECT o.order_number, o.created_at, o.updated_at, o.customer_name, o.customer_phone, o.city, o.district, o.boxes,
        o.total_amount, o.currency, o.payment_method, o.status, o.archived_at
      FROM orders o ${f.sql} ORDER BY ${sort} LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...f.binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM orders o ${f.sql}`).bind(...f.binds).first(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM orders WHERE archived_at IS NULL GROUP BY status").all()
  ]);
  return {
    orders: rows.results.map(r => ({ orderNumber: r.order_number, createdAt: r.created_at, updatedAt: r.updated_at, customerName: r.customer_name,
      phone: localPhone(r.customer_phone), city: r.city, district: r.district, boxes: r.boxes, total: r.total_amount, currency: r.currency,
      paymentMethod: r.payment_method, status: r.status, archived: !!r.archived_at })),
    total: count.n, page, per, counts: Object.fromEntries(counts.results.map(r => [r.status, r.n]))
  };
}

// "Select all" = every order matching the current filter, capped so one click cannot touch the whole database.
export const BULK_MAX = 500;
export async function matchingNumbers(env, ctx, params) {
  need(ctx, "orders.view");
  const f = orderFilter(params);
  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT o.order_number FROM orders o ${f.sql} ORDER BY o.id DESC LIMIT ${BULK_MAX}`).bind(...f.binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM orders o ${f.sql}`).bind(...f.binds).first()
  ]);
  return { numbers: rows.results.map(r => r.order_number), total: count.n, max: BULK_MAX };
}

/* ---------- CSV export (respects the filters; formulas neutralised for Excel) ---------- */
export async function exportCsv(env, ctx, params) {
  need(ctx, "orders.export");
  const f = orderFilter(params);
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
  const full = await getOrderOr404(env, number), o = full.order;
  const [notes, auditRows] = await Promise.all([
    env.DB.prepare("SELECT note, created_by, created_at FROM order_notes WHERE order_id = ?1 ORDER BY id").bind(o.id).all(),
    ctx.perms.has("audit.view") || ctx.perms.has("orders.edit_customer")
      ? env.DB.prepare("SELECT username, action, old_value, new_value, created_at FROM audit_logs WHERE entity_type = 'order' AND entity_id = ?1 ORDER BY id DESC LIMIT 200").bind(o.order_number).all()
      : Promise.resolve({ results: [] })
  ]);
  return {
    id: o.id, orderNumber: o.order_number, status: o.status, createdAt: o.created_at, updatedAt: o.updated_at, lang: o.lang,
    paymentMethod: o.payment_method, boxes: o.boxes, subtotal: o.subtotal, discount: o.discount_amount, shipping: o.shipping_amount,
    total: o.total_amount, currency: o.currency, archived: !!o.archived_at, anonymized: !!o.anonymized_at, locked: LOCKED.includes(o.status),
    customer: { name: o.customer_name, phone: localPhone(o.customer_phone), phoneIntl: o.customer_phone, city: o.city, district: o.district,
      address: o.address, notes: o.customer_notes, location: o.location_latitude != null ? { lat: o.location_latitude, lng: o.location_longitude } : null },
    items: full.items.map(i => ({ id: i.id, productId: i.product_id, name: i.product_name_snapshot, boxesPerUnit: i.boxes_per_unit,
      unitPrice: i.unit_price, priceOverridden: !!i.price_overridden, quantity: i.quantity, lineTotal: i.line_total })),
    history: full.history.map(h => ({ from: h.previous_status, to: h.new_status, by: h.changed_by, note: h.note, visibility: h.visibility, bulk: !!h.bulk_id, at: h.created_at })),
    notes: notes.results.map(x => ({ note: x.note, by: x.created_by, at: x.created_at })),
    audit: auditRows.results.map(a => ({ by: a.username, action: a.action, old: a.old_value, new: a.new_value, at: a.created_at })),
    nextStatuses: o.anonymized_at ? [] : nextOptions(ctx.perms, o.status),
    can: Object.fromEntries(["orders.edit_customer", "orders.edit_items", "orders.edit_price", "orders.notes", "orders.revoke_link", "orders.archive", "orders.anonymize"]
      .map(p => [p.split(".")[1], ctx.perms.has(p) && !o.anonymized_at]))
  };
}

/* ---------- status change: one order ---------- */
export async function changeStatus(env, ctx, number, body) {
  const full = await getOrderOr404(env, number), o = full.order;
  if (o.anonymized_at) throw new HttpError(409, { error: "anonymized" });
  const to = String(body && body.status || "");
  const kind = allowedTransition(ctx.perms, o.status, to);
  if (!kind) throw new HttpError(STATUSES.includes(to) ? 403 : 422, { error: STATUSES.includes(to) ? "transition_not_allowed" : "invalid_status", from: o.status, to });
  if (kind === "override" && body.override !== true) throw new HttpError(409, { error: "override_confirmation_required", from: o.status, to });
  if (body.expectedStatus && body.expectedStatus !== o.status) throw new HttpError(409, { error: "status_changed", status: o.status });
  const note = cleanNote(body.note), visibility = body.visibility === "customer" ? "customer" : "internal", t = now();
  const msg = notifyMessage(to, o.lang, o.order_number) + (visibility === "customer" && note ? " " + note : "");
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4").bind(to, t, o.id, o.status),
    // each insert runs only if the update above changed the row, so a lost race writes nothing
    env.DB.prepare(`INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, user_id, note, visibility, ip_address, user_agent, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE changes() = 1`).bind(o.id, o.status, to, ctx.user.username, ctx.user.id, note, visibility, ctx.ip, (ctx.ua || "").slice(0, 300), t),
    env.DB.prepare("INSERT INTO notification_outbox (order_id, event, lang, message, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1").bind(o.id, to, o.lang, msg, t),
    auditStmt(env, ctx, to === "CANCELLED" ? "order_cancelled" : "order_status_changed", "order", o.order_number, { status: o.status }, { status: to, note, visibility, override: kind === "override" })
  ]);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "status_changed" });
  return orderDetail(env, ctx, o.order_number);
}

/* ---------- status change: many orders (set-based, one transaction) ---------- */
export async function bulkStatus(env, ctx, body) {
  need(ctx, "orders.status.bulk");
  const to = String(body && body.status || "");
  if (!STATUSES.includes(to)) throw new HttpError(422, { error: "invalid_status" });
  const numbers = [...new Set((Array.isArray(body.numbers) ? body.numbers : []).map(normalizeOrderNumber).filter(Boolean))];
  if (!numbers.length) throw new HttpError(422, { error: "nothing_selected" });
  if (numbers.length > BULK_MAX) throw new HttpError(422, { error: "too_many", max: BULK_MAX });
  if (body.expectedCount != null && Number(body.expectedCount) !== numbers.length) throw new HttpError(409, { error: "selection_changed" });
  const override = body.override === true;
  const fromOk = STATUSES.filter(s => { const k = allowedTransition(ctx.perms, s, to); return k === "normal" || (k === "override" && override); });
  const note = cleanNote(body.note), visibility = body.visibility === "customer" ? "customer" : "internal", t = now();
  const bulkId = crypto.randomUUID();
  const sel = "FROM orders WHERE order_number IN (SELECT value FROM json_each(?1)) AND status IN (SELECT value FROM json_each(?2)) AND anonymized_at IS NULL";
  const J = JSON.stringify(numbers), F = JSON.stringify(fromOk);
  const before = (await env.DB.prepare("SELECT order_number, status, anonymized_at FROM orders WHERE order_number IN (SELECT value FROM json_each(?1))").bind(J).all()).results;
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, user_id, note, visibility, bulk_id, ip_address, user_agent, created_at)
      SELECT id, status, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 ${sel}`).bind(J, F, to, ctx.user.username, ctx.user.id, note, visibility, bulkId, ctx.ip, (ctx.ua || "").slice(0, 300), t),
    env.DB.prepare(`INSERT INTO notification_outbox (order_id, event, lang, message, created_at)
      SELECT id, ?3, lang, CASE lang WHEN 'en' THEN ?4 ELSE ?5 END || ' (' || order_number || ')' || ?6, ?7 ${sel}`)
      .bind(J, F, to, notifyMessage(to, "en", "").replace(/ \(\)$/, ""), notifyMessage(to, "ar", "").replace(/ \(\)$/, ""), visibility === "customer" && note ? " " + note : "", t),
    env.DB.prepare(`UPDATE orders SET status = ?3, updated_at = ?4 WHERE order_number IN (SELECT value FROM json_each(?1)) AND status IN (SELECT value FROM json_each(?2)) AND anonymized_at IS NULL`).bind(J, F, to, t)
  ]);
  const updatedCount = res[2].meta.changes;
  const updated = before.filter(b => fromOk.includes(b.status) && !b.anonymized_at).map(b => b.order_number);
  const skipped = numbers.filter(n => !updated.includes(n)).map(n => {
    const b = before.find(x => x.order_number === n);
    return { orderNumber: n, reason: !b ? "not_found" : b.anonymized_at ? "anonymized" : b.status === to ? "already" : "transition_not_allowed", status: b && b.status };
  });
  await audit(env, ctx, "bulk_status_update", "orders", bulkId, null, { to, note, visibility, override, requested: numbers.length, updated: updatedCount, orders: updated, skipped: skipped.map(s => s.orderNumber) });
  return { updated: updatedCount, skipped, bulkId };
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
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const boxes = lines.reduce((s, l) => s + l.boxesPerUnit * l.quantity, 0);
  const normal = lines.filter(l => !l.overridden);
  const normalSum = normal.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const normalBoxes = normal.reduce((s, l) => s + l.boxesPerUnit * l.quantity, 0);
  const discount = normalBoxes ? normalSum - Math.min(normalSum, priceForBoxes(normalBoxes, catalog)) : 0;
  const net = subtotal - discount;
  const shipping = catalog.freeShippingFrom && net >= catalog.freeShippingFrom ? 0 : catalog.shippingCost;
  const total = net + shipping, t = now();

  const stmts = [];
  for (const ex of full.items) if (!keptIds.has(ex.id)) stmts.push(env.DB.prepare("DELETE FROM order_items WHERE id = ?1 AND order_id = ?2").bind(ex.id, o.id));
  for (const l of lines) {
    if (l.ex) stmts.push(env.DB.prepare("UPDATE order_items SET quantity = ?1, unit_price = ?2, price_overridden = ?3, line_total = ?4, updated_at = ?5 WHERE id = ?6 AND order_id = ?7")
      .bind(l.quantity, l.unitPrice, l.overridden ? 1 : 0, l.unitPrice * l.quantity, t, l.ex.id, o.id));
    else stmts.push(env.DB.prepare(`INSERT INTO order_items (order_id, product_id, product_name_snapshot, product_name_en_snapshot, boxes_per_unit, unit_price, price_overridden, quantity, line_total, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`).bind(o.id, l.productId, l.name, l.nameEn, l.boxesPerUnit, l.unitPrice, l.overridden ? 1 : 0, l.quantity, l.unitPrice * l.quantity, t));
  }
  stmts.push(env.DB.prepare("UPDATE orders SET boxes = ?1, subtotal = ?2, discount_amount = ?3, shipping_amount = ?4, total_amount = ?5, updated_at = ?6 WHERE id = ?7")
    .bind(boxes, subtotal, discount, shipping, total, t, o.id));
  for (const [action, oldV, newV] of events) stmts.push(auditStmt(env, ctx, action, "order", o.order_number, oldV, newV));
  stmts.push(auditStmt(env, ctx, "order_totals_recalculated", "order", o.order_number,
    { subtotal: o.subtotal, discount: o.discount_amount, shipping: o.shipping_amount, total: o.total_amount },
    { subtotal, discount, shipping, total, reason: reason || undefined, forcedAfter: LOCKED.includes(o.status) ? o.status : undefined }));
  await env.DB.batch(stmts);
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
    auditStmt(env, ctx, "order_anonymized", "order", o.order_number, null, { reason: clean(body.reason, 200) })
  ]);
  return orderDetail(env, ctx, o.order_number);
}

/* ---------- dashboard and reports ---------- */
export async function dashboard(env, ctx) {
  need(ctx, "dashboard.view");
  const today = riyadhMidnight(0).toISOString();
  const [byStatus, todayRow, latest] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) n FROM orders WHERE archived_at IS NULL GROUP BY status").all(),
    env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE created_at >= ?1").bind(today).first(),
    env.DB.prepare("SELECT order_number, customer_name, total_amount, currency, status, created_at FROM orders ORDER BY id DESC LIMIT 8").all()
  ]);
  return { today: todayRow.n, byStatus: Object.fromEntries(byStatus.results.map(r => [r.status, r.n])),
    latest: latest.results.map(r => ({ orderNumber: r.order_number, customerName: r.customer_name, total: r.total_amount, currency: r.currency, status: r.status, createdAt: r.created_at })) };
}

export async function reports(env, ctx, params) {
  need(ctx, "reports.view");
  const days = [7, 30, 90].includes(Number(params.get("days"))) ? Number(params.get("days")) : 30;
  const since = riyadhMidnight(-(days - 1)).toISOString();
  const REV = "status NOT IN ('CANCELLED','FAILED')";
  const period = from => env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${REV} THEN total_amount END), 0) revenue FROM orders WHERE created_at >= ?1`).bind(from).first();
  const [all, today, week, month, daily, status, products] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${REV} THEN total_amount END), 0) revenue FROM orders`).first(),
    period(riyadhMidnight(0).toISOString()), period(riyadhMidnight(-6).toISOString()), period(riyadhMidnight(-29).toISOString()),
    env.DB.prepare(`SELECT substr(datetime(created_at, '+3 hours'), 1, 10) d, COUNT(*) n, COALESCE(SUM(CASE WHEN ${REV} THEN total_amount END), 0) revenue
      FROM orders WHERE created_at >= ?1 GROUP BY d ORDER BY d`).bind(since).all(),
    env.DB.prepare("SELECT status, COUNT(*) n FROM orders WHERE created_at >= ?1 GROUP BY status").bind(since).all(),
    env.DB.prepare(`SELECT i.product_id, MAX(i.product_name_snapshot) name, SUM(i.quantity) qty, SUM(i.boxes_per_unit * i.quantity) boxes, SUM(i.line_total) revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.created_at >= ?1 AND o.${REV} GROUP BY i.product_id ORDER BY boxes DESC`).bind(since).all()
  ]);
  // fill missing days with zeros so the charts have a continuous axis
  const map = new Map(daily.results.map(r => [r.d, r])), series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(riyadhMidnight(-i).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
    series.push({ date: d, orders: map.get(d) ? map.get(d).n : 0, revenue: map.get(d) ? map.get(d).revenue : 0 });
  }
  return { days, totals: { all, today, week, month }, series, byStatus: Object.fromEntries(status.results.map(r => [r.status, r.n])),
    products: products.results.map(p => ({ productId: p.product_id, name: p.name, quantity: p.qty, boxes: p.boxes, revenue: p.revenue })) };
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
  const tables = ["orders", "order_items", "order_status_history", "order_notes", "notification_outbox", "order_counters", "audit_logs", "roles", "permissions", "role_permissions", "catalog_cache"];
  const out = { exportedAt: now(), exportedBy: ctx.user.username, schema: "0002", tables: {} };
  for (const t of tables) out.tables[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid LIMIT 100000`).all()).results;
  out.tables.users = (await env.DB.prepare("SELECT id, username, display_name, role_id, is_active, created_at, updated_at FROM users ORDER BY id").all()).results;
  await audit(env, ctx, "backup_downloaded", "system", null, null, Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length])));
  return out;
}
