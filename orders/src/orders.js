/* Orders: validation, creation (exactly once per checkout attempt), customer views and tracking. */
import { getCatalog, quote } from "./catalog.js";

import { notifyMessage } from "./statuses.js";
export { notifyMessage };

/* ---------- input cleaning ---------- */
const DIGITS = { "٠": 0, "١": 1, "٢": 2, "٣": 3, "٤": 4, "٥": 5, "٦": 6, "٧": 7, "٨": 8, "٩": 9, "۰": 0, "۱": 1, "۲": 2, "۳": 3, "۴": 4, "۵": 5, "۶": 6, "۷": 7, "۸": 8, "۹": 9 };
export const latinDigits = s => String(s ?? "").replace(/[٠-٩۰-۹]/g, d => DIGITS[d]);

/* Saudi mobile: 05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX, +9665XXXXXXXX, 009665XXXXXXXX → 9665XXXXXXXX */
export function normalizePhone(v) {
  let d = latinDigits(v).replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, "").replace(/^00/, "");
  if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? "966" + d : null;
}
export const localPhone = p => "0" + String(p).replace(/^966/, "");

const clean = (v, max) => String(v ?? "")
  .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")   // control and bidi-override characters
  .replace(/[<>]/g, "")
  .replace(/\s+/g, " ").trim().slice(0, max);

export function normalizeOrderNumber(v) {
  const s = latinDigits(v).toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([A-Z]{2,4})-?(\d{4})-?(\d{1,6})$/);
  return m ? `${m[1]}-${m[2]}-${m[3].padStart(6, "0")}` : null;
}

/* Returns { value } or { errors: { field: code } } */
export function validateOrderInput(body, catalog) {
  const errors = {};
  const c = body && typeof body.customer === "object" && body.customer ? body.customer : {};
  const name = clean(c.name, 60), city = clean(c.city, 60), district = clean(c.district, 60);
  const address = clean(c.address, 200), notes = clean(c.notes, 500);
  const phone = normalizePhone(c.phone);
  if (name.length < 2 || !/\p{L}/u.test(name)) errors.name = "required";
  if (!phone) errors.phone = "invalid_phone";
  if (city.length < 2) errors.city = "required";
  if (district.length < 2) errors.district = "required";
  if (address.length < 3) errors.address = "required";

  let location = null;
  if (body && body.location != null) {
    const lat = Number(body.location.lat), lng = Number(body.location.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
      location = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    else errors.location = "invalid";
  }

  // cart: known products only, whole quantities, duplicates merged
  const merged = new Map();
  const raw = Array.isArray(body && body.items) ? body.items.slice(0, 20) : [];
  for (const it of raw) {
    const id = String(it && it.id || ""), qty = Number(it && it.qty);
    if (!catalog.bundles.some(b => b.id === id) || !Number.isInteger(qty) || qty < 1) { errors.items = "invalid_items"; continue; }
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const items = [...merged].map(([id, qty]) => ({ id, qty }));
  if (!items.length) errors.items = errors.items || "empty_cart";
  else if (items.some(i => i.qty > catalog.maxQtyPerLine)) errors.items = "qty_limit";
  else {
    const boxes = items.reduce((s, i) => s + catalog.bundles.find(b => b.id === i.id).boxes * i.qty, 0);
    if (boxes > catalog.maxBoxesPerOrder) errors.items = "max_boxes";
  }

  const payment = String(body && body.paymentMethod || "cod");
  if (!catalog.paymentMethods.includes(payment)) errors.paymentMethod = "unsupported";
  const key = String(body && body.idempotencyKey || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) errors.idempotencyKey = "invalid";

  if (Object.keys(errors).length) return { errors };
  return { value: { key, items, payment, location, lang: body.lang === "en" ? "en" : "ar",
    customer: { name, phone, city, district, address, notes },
    expectedTotal: Number.isInteger(body.expectedTotal) ? body.expectedTotal : null } };
}

/* ---------- helpers ---------- */
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function sha256(text) { return b64url(await crypto.subtle.digest("SHA-256", enc.encode(text))); }
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
// Customer access token for one order: derived, never stored, so a database leak does not leak it.
// Version 1 is the original formula (links already given to customers stay valid); revoking a link raises the version.
export async function orderToken(env, number, version = 1) {
  if (!env.TOKEN_SECRET || env.TOKEN_SECRET.length < 32) throw new Error("TOKEN_SECRET missing");
  return (await hmac(env.TOKEN_SECRET, "order-view:" + number + (version > 1 ? ":v" + version : ""))).slice(0, 32);
}
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ---------- create ---------- */
export class HttpError extends Error { constructor(status, body) { super(body.error); this.status = status; this.body = body; } }

export async function createOrder(env, body) {
  let catalog;
  try { catalog = await getCatalog(env); }
  catch (e) { throw new HttpError(503, { error: "catalog_unavailable" }); }
  if (!catalog.inStock) throw new HttpError(409, { error: "out_of_stock" });

  const v = validateOrderInput(body, catalog);
  if (v.errors) throw new HttpError(422, { error: "validation", fields: v.errors });
  const o = v.value;
  const q = quote(o.items, catalog);
  const requestHash = await sha256(JSON.stringify([o.items, o.customer, o.location, o.payment]));

  // Same checkout attempt sent again (double click, slow network, retry): return the order already created.
  const existing = await env.DB.prepare("SELECT order_number, request_hash FROM orders WHERE idempotency_key = ?1").bind(o.key).first();
  if (existing) {
    if (existing.request_hash !== requestHash) throw new HttpError(409, { error: "idempotency_conflict" });
    return { replay: true, number: existing.order_number };
  }
  // The customer reviewed a total; if prices changed meanwhile, show the new numbers instead of charging silently.
  if (o.expectedTotal != null && o.expectedTotal !== q.total) throw new HttpError(409, { error: "price_changed", quote: publicQuote(q) });

  const now = new Date().toISOString();
  const year = now.slice(0, 4);                // bound as text: D1 passes JS numbers as REAL, which would print "2026.0"
  const db = env.DB;
  const orderId = "(SELECT id FROM orders WHERE idempotency_key = ?1)";
  const stmts = [
    db.prepare("INSERT INTO order_counters (year, last_value) VALUES (?1, 1) ON CONFLICT(year) DO UPDATE SET last_value = last_value + 1").bind(year),
    db.prepare(`INSERT INTO orders (order_number, idempotency_key, request_hash, customer_name, customer_phone, city, district, address,
        location_latitude, location_longitude, customer_notes, boxes, subtotal, discount_amount, shipping_amount, total_amount,
        currency, payment_method, status, lang, created_at, updated_at)
      VALUES (?1 || '-' || ?2 || '-' || printf('%06d', (SELECT last_value FROM order_counters WHERE year = ?2)),
        ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 'RECEIVED', ?20, ?21, ?21)`)
      .bind(catalog.orderPrefix, year, o.key, requestHash, o.customer.name, o.customer.phone, o.customer.city, o.customer.district,
        o.customer.address, o.location ? o.location.lat : null, o.location ? o.location.lng : null, o.customer.notes,
        q.boxes, q.subtotal, q.discount, q.shipping, q.total, q.currency, o.payment, o.lang, now),
    ...q.lines.map(l => db.prepare(`INSERT INTO order_items (order_id, product_id, product_name_snapshot, product_name_en_snapshot,
        boxes_per_unit, unit_price, quantity, line_total, created_at, updated_at) VALUES (${orderId}, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`)
      .bind(o.key, l.productId, l.name, l.nameEn, l.boxesPerUnit, l.unitPrice, l.quantity, l.lineTotal, now)),
    db.prepare(`INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, note, visibility, created_at)
      VALUES (${orderId}, NULL, 'RECEIVED', 'customer', '', 'internal', ?2)`).bind(o.key, now)
  ];
  // All statements run as one transaction: either the whole order exists or nothing does.
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE constraint failed: orders\.idempotency_key/i.test(e.message)) {   // a parallel duplicate won the race
      const row = await db.prepare("SELECT order_number, request_hash FROM orders WHERE idempotency_key = ?1").bind(o.key).first();
      if (row && row.request_hash === requestHash) return { replay: true, number: row.order_number };
    }
    console.log("order insert failed:", e.message);
    throw new HttpError(500, { error: "create_failed" });
  }
  const row = await db.prepare("SELECT id, order_number FROM orders WHERE idempotency_key = ?1").bind(o.key).first();
  if (!row) throw new HttpError(500, { error: "create_failed" });
  try {
    await db.prepare("INSERT INTO notification_outbox (order_id, event, lang, message, created_at) VALUES (?1, 'RECEIVED', ?2, ?3, ?4)")
      .bind(row.id, o.lang, notifyMessage("RECEIVED", o.lang, row.order_number), now).run();
  }
  catch (e) { console.log("outbox write failed:", e.message); }                          // never fails the order
  return { replay: false, number: row.order_number };
}

const publicQuote = q => ({ boxes: q.boxes, subtotal: q.subtotal, discount: q.discount, shipping: q.shipping, total: q.total, currency: q.currency });

/* ---------- read ---------- */
export async function loadOrder(db, number) {
  const order = await db.prepare("SELECT * FROM orders WHERE order_number = ?1").bind(number).first();
  if (!order) return null;
  const [items, history] = await Promise.all([
    db.prepare("SELECT * FROM order_items WHERE order_id = ?1 ORDER BY id").bind(order.id).all(),
    db.prepare("SELECT * FROM order_status_history WHERE order_id = ?1 ORDER BY id").bind(order.id).all()
  ]);
  return { order, items: items.results, history: history.results };
}

/* What the customer may see: no internal id, no internal notes, no admin names.
   Tracking (number + phone) and the secure link both show delivery details; the phone is masked. */
export function customerView(full) {
  const { order: o, items, history } = full;
  const mask = p => { const l = localPhone(p); return l.slice(0, 3) + "•••••" + l.slice(-2); };
  const anonymized = !!o.anonymized_at;
  return {
    orderNumber: o.order_number, status: o.status, createdAt: o.created_at, updatedAt: o.updated_at,
    items: items.map(i => ({ productId: i.product_id, name: i.product_name_snapshot, nameEn: i.product_name_en_snapshot || i.product_name_snapshot,
      boxesPerUnit: i.boxes_per_unit, unitPrice: i.unit_price, quantity: i.quantity, lineTotal: i.line_total })),
    boxes: o.boxes, subtotal: o.subtotal, discount: o.discount_amount, shipping: o.shipping_amount, total: o.total_amount,
    currency: o.currency, paymentMethod: o.payment_method,
    delivery: anonymized ? { name: "—", city: "—", district: "—", address: "—" }
      : { name: o.customer_name, phone: mask(o.customer_phone), city: o.city, district: o.district, address: o.address, notes: o.customer_notes, hasLocation: o.location_latitude != null },
    // status changes with time; a note is shown only when the admin marked it customer-visible
    history: history.map(h => ({ status: h.new_status, at: h.created_at, note: h.visibility === "customer" ? h.note : "" }))
  };
}
