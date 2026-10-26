/* Admin: password login → signed HttpOnly session cookie; order list, details, status changes, notes. */
import { STATUSES, TRANSITIONS, loadOrder, localPhone, normalizeOrderNumber, latinDigits, notifyMessage, sha256, safeEqual, HttpError } from "./orders.js";

const COOKIE = "__Host-cg_admin";
const SESSION_HOURS = 12;
const PAGE_SIZE = 25;
const enc = new TextEncoder();

async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text))))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
}
const configured = env => !!(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 12 && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);

// Changing ADMIN_PASSWORD signs everybody out, because the password fingerprint is part of the signature.
async function sessionValue(env, exp) { return `${exp}.${await sign(env, `admin|${exp}|${await sha256(env.ADMIN_PASSWORD)}`)}`; }

export async function isAdmin(request, env) {
  if (!configured(env)) return false;
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const exp = Number(m[1].split(".")[0]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(m[1], await sessionValue(env, exp));
}

const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export async function login(env, body) {
  if (!configured(env)) throw new HttpError(503, { error: "admin_not_configured" });
  const given = String(body && body.password || "");
  // Compare fixed-length digests so the time taken says nothing about the password.
  const ok = safeEqual(await sha256("pw:" + given), await sha256("pw:" + env.ADMIN_PASSWORD));
  if (!ok) throw new HttpError(401, { error: "wrong_password" });
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  return cookie(await sessionValue(env, exp), SESSION_HOURS * 3600);
}
export const logoutCookie = () => cookie("", 0);

/* Riyadh is UTC+3 all year. Date filters are Riyadh calendar days. */
const riyadhDayStartUtc = d => new Date(Date.parse(d + "T00:00:00+03:00")).toISOString();

export async function listOrders(env, params) {
  const where = [], binds = [];
  const add = (sql, ...v) => { where.push(sql.replace(/\?/g, () => `?${binds.push(v.shift())}`)); };
  const q = String(params.get("q") || "").trim().slice(0, 60);
  if (q) {
    const num = normalizeOrderNumber(q), digits = latinDigits(q).replace(/\D/g, "");
    const like = "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%";
    const parts = ["order_number LIKE ? ESCAPE '\\'", "customer_name LIKE ? ESCAPE '\\'"];
    const vals = [like.toUpperCase(), like];
    if (num) { parts.push("order_number = ?"); vals.push(num); }
    if (digits.length >= 4) { parts.push("customer_phone LIKE ?"); vals.push("%" + digits.replace(/^0/, "") + "%"); }
    add("(" + parts.join(" OR ") + ")", ...vals);
  }
  const status = params.get("status");
  if (status && STATUSES.includes(status)) add("status = ?", status);
  const from = params.get("from"), to = params.get("to");
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || "")) add("created_at >= ?", riyadhDayStartUtc(from));
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || "")) add("created_at < ?", new Date(Date.parse(riyadhDayStartUtc(to)) + 86400000).toISOString());
  const page = Math.max(1, Math.min(10000, parseInt(params.get("page"), 10) || 1));
  const w = where.length ? "WHERE " + where.join(" AND ") : "";

  const [rows, count, counts] = await Promise.all([
    env.DB.prepare(`SELECT order_number, created_at, customer_name, customer_phone, city, district, boxes, total_amount, currency, status
      FROM orders ${w} ORDER BY id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM orders ${w}`).bind(...binds).first(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all()
  ]);
  return {
    orders: rows.results.map(r => ({ orderNumber: r.order_number, createdAt: r.created_at, customerName: r.customer_name,
      phone: localPhone(r.customer_phone), city: r.city, district: r.district, boxes: r.boxes, total: r.total_amount, currency: r.currency, status: r.status })),
    total: count.n, page, pageSize: PAGE_SIZE,
    counts: Object.fromEntries(counts.results.map(r => [r.status, r.n]))
  };
}

export async function orderDetail(env, number) {
  const n = normalizeOrderNumber(number);
  const full = n && await loadOrder(env.DB, n);
  if (!full) throw new HttpError(404, { error: "not_found" });
  const notes = await env.DB.prepare("SELECT note, created_by, created_at FROM order_notes WHERE order_id = ?1 ORDER BY id").bind(full.order.id).all();
  const o = full.order;
  return {
    id: o.id, orderNumber: o.order_number, status: o.status, createdAt: o.created_at, updatedAt: o.updated_at, lang: o.lang,
    paymentMethod: o.payment_method, boxes: o.boxes, subtotal: o.subtotal, discount: o.discount_amount, shipping: o.shipping_amount,
    total: o.total_amount, currency: o.currency,
    customer: { name: o.customer_name, phone: localPhone(o.customer_phone), phoneIntl: o.customer_phone, city: o.city, district: o.district,
      address: o.address, notes: o.customer_notes,
      location: o.location_latitude != null ? { lat: o.location_latitude, lng: o.location_longitude } : null },
    items: full.items.map(i => ({ productId: i.product_id, name: i.product_name_snapshot, boxesPerUnit: i.boxes_per_unit,
      unitPrice: i.unit_price, quantity: i.quantity, lineTotal: i.line_total })),
    history: full.history.map(h => ({ from: h.previous_status, to: h.new_status, by: h.changed_by, note: h.note, at: h.created_at })),
    notes: notes.results.map(x => ({ note: x.note, by: x.created_by, at: x.created_at })),
    allowedNext: TRANSITIONS[o.status] || []
  };
}

const cleanNote = v => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 1000);

export async function changeStatus(env, number, body) {
  const n = normalizeOrderNumber(number);
  const o = n && await env.DB.prepare("SELECT id, order_number, status, lang FROM orders WHERE order_number = ?1").bind(n).first();
  if (!o) throw new HttpError(404, { error: "not_found" });
  const to = String(body && body.status || ""), note = cleanNote(body && body.note);
  if (!STATUSES.includes(to)) throw new HttpError(422, { error: "invalid_status" });
  // Someone else changed it since this screen was loaded
  if (body && body.expectedStatus && body.expectedStatus !== o.status) throw new HttpError(409, { error: "status_changed", status: o.status });
  if (!(TRANSITIONS[o.status] || []).includes(to)) throw new HttpError(422, { error: "transition_not_allowed", from: o.status, to });
  const now = new Date().toISOString();
  const stmts = [
    env.DB.prepare("UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4").bind(to, now, o.id, o.status),
    env.DB.prepare("INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, note, created_at) SELECT ?1, ?2, ?3, 'admin', ?4, ?5 WHERE changes() = 1")
      .bind(o.id, o.status, to, note, now)
  ];
  // Each insert runs only if the statement before it changed a row, so a lost race writes nothing at all.
  const msg = notifyMessage(to, o.lang, o.order_number);
  if (msg) stmts.push(env.DB.prepare("INSERT INTO notification_outbox (order_id, event, lang, message, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1")
    .bind(o.id, to, o.lang, msg, now));
  const res = await env.DB.batch(stmts);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "status_changed" });
  return orderDetail(env, n);
}

export async function addNote(env, number, body) {
  const n = normalizeOrderNumber(number);
  const o = n && await env.DB.prepare("SELECT id FROM orders WHERE order_number = ?1").bind(n).first();
  if (!o) throw new HttpError(404, { error: "not_found" });
  const note = cleanNote(body && body.note);
  if (!note) throw new HttpError(422, { error: "empty_note" });
  await env.DB.prepare("INSERT INTO order_notes (order_id, note, created_by, created_at) VALUES (?1, ?2, 'admin', ?3)").bind(o.id, note, new Date().toISOString()).run();
  return orderDetail(env, n);
}
