/* Shipments to the carrier (SENA).

   Export = one batch: the admin selects orders, sees how many boxes leave the warehouse, names the export and confirms.
   Each order then moves to SHIPPED through the normal steps (RECEIVED → CONFIRMED → PREPARING → SHIPPED, each one in its
   history, the customer notified once, for «تم الشحن»), gets a unique shipment reference, and the carrier's own Excel
   template is filled from the batch (downloadable again at any time). Only orders that can really leave are accepted:
   not cancelled / failed / delivered / already shipped / on hold / anonymized. Stock goes by availability: a shipped order
   takes its boxes from the warehouse, even ones held for an order that has not shipped yet (see claimStock). Shipping more
   boxes than the warehouse holds in the system does not block the export (the receipt may not be recorded yet) — it is
   shown and must be confirmed (allowShortage).

   Editing a batch: an order cancelled (e.g. a duplicate) or returned to «جاري التجهيز» leaves the batch — its row stays on
   record but the totals, the carrier file and delivery confirmation skip it (removeFromShipment, or any status change).
   Orders can also be added after export (addToShipment): same checks and same steps as an export. SENA refuses a reference it
   has already received, so the added orders can be downloaded in a file of their own (?only=new).

   Delivery = per batch: confirm all remaining orders, or the selected ones, as Delivered (or Failed) in one action. It is
   the usual status change, so stock is consumed (FIFO cost), revenue counts and the history records who confirmed. */
import { HttpError, loadOrder, normalizeOrderNumber, localPhone, normalizeNationalAddress } from "./orders.js";
import { allowedTransition } from "./statuses.js";
import { applyTransition, need, BULK_MAX, DUP_OF, dupList } from "./admin.js";
import { audit } from "./auth.js";
import { riyadhDay } from "./inventory.js";
import { stockFlow } from "./stock_admin.js";
import { senaWorkbook } from "./xlsx.js";
import { SENA_ZONES, SENA_PREP, SENA_MAX_ROWS } from "./sena_template.js";

const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const MAX = Math.min(BULK_MAX, SENA_MAX_ROWS);
// the normal steps from each status to «تم الشحن»
const PATH = { RECEIVED: ["CONFIRMED", "PREPARING", "SHIPPED"], CONFIRMED: ["PREPARING", "SHIPPED"], PREPARING: ["SHIPPED"] };
const IN_TRANSIT = ["SHIPPED", "OUT_FOR_DELIVERY"];
const FROM_SENA_STOCK = SENA_PREP[1];       // «من مخزون SENA»: SENA packs from its warehouse (their rules 8 and 11: packaging counts, SKU or barcode required)
const canView = ctx => { if (!ctx.perms.has("shipments.manage") && !ctx.perms.has("orders.view")) throw new HttpError(403, { error: "forbidden" }); };

/* ---------- settings (zone, preparation source, weight of one box) ---------- */
export async function getShippingSettings(db) {
  const rows = (await db.prepare("SELECT key, value FROM shipping_settings").all()).results, s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let naFallback = [];
  try { naFallback = (JSON.parse(s.na_fallback || "[]") || []).filter(r => r && r.names && normalizeNationalAddress(r.code)); } catch (_) {}
  return { zone: s.sena_zone || SENA_ZONES.find(z => z.code === "KSA").label, prepSource: s.sena_prep_source || FROM_SENA_STOCK, boxWeightKg: Number(s.box_weight_kg || 0.5), naFallback,
    itemName: s.sena_item_name || "calmgastro", sku: s.sena_sku ?? "", barcode: s.sena_barcode ?? "", itemPrice: Number(s.sena_item_price || 0),
    bags: Number(s.sena_bags ?? 1), bubbles: Number(s.sena_bubbles || 0), cartons: Number(s.sena_cartons || 0) };
}

/* Approximate national address per city: used in the carrier file only, for an order that has none of its own (the order
   keeps it empty so the customer's real code can still be added). A row lists the city's spellings («جدة، جده، Jeddah»);
   the longest spelling found inside the order's city wins («جازان ابو عريش» → the Abu Arish row before the Jazan one). */
const cityKey = v => String(v || "").toLowerCase().replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
  .replace(/\s+/g, " ").trim();
export function fallbackFor(city, list) {
  const c = cityKey(city);
  let best = null, len = 0;
  for (const r of list || []) for (const n of String(r.names).split(/[,،]/).map(cityKey).filter(x => x.length >= 3))
    if (c.includes(n) && n.length > len) { best = r.code; len = n.length; }
  return best;
}
export async function shippingSettings(env, ctx) {
  canView(ctx);
  return { settings: await getShippingSettings(env.DB), zones: SENA_ZONES, prepSources: SENA_PREP, canManage: ctx.perms.has("shipments.manage") };
}
export async function saveShippingSettings(env, ctx, body) {
  need(ctx, "shipments.manage");
  const old = await getShippingSettings(env.DB), errors = {}, w = Number(body.boxWeightKg);
  if (!SENA_ZONES.some(z => z.label === body.zone)) errors.zone = "invalid";
  if (!SENA_PREP.includes(body.prepSource)) errors.prepSource = "invalid";
  if (!(w >= 0.01 && w <= 30)) errors.boxWeightKg = "invalid";
  // the item and packaging written to the carrier file; each is optional in the request (unsent = unchanged)
  const extra = [], item = {};
  const text = (key, field, max, min) => { if (body[field] == null) return old[field]; const v = clean(body[field], max); if (v.length < min) errors[field] = "invalid"; extra.push([key, v]); item[field] = v; return v; };
  const count = (key, field, top, isInt) => { if (body[field] == null) return; const v = Number(body[field]); if (body[field] === "" || !(v >= 0 && v <= top) || (isInt && !Number.isInteger(v))) errors[field] = "invalid"; extra.push([key, String(v)]); item[field] = v; };
  text("sena_item_name", "itemName", 120, 2);
  const sku = text("sena_sku", "sku", 64, 0), barcode = text("sena_barcode", "barcode", 64, 0);
  if (body.prepSource === FROM_SENA_STOCK && !sku && !barcode) errors.sku = "required";   // their rule 11
  count("sena_item_price", "itemPrice", 100000, false);
  count("sena_bags", "bags", 999, true); count("sena_bubbles", "bubbles", 999, true); count("sena_cartons", "cartons", 999, true);
  let fb = null;
  if (body.naFallback != null) {
    const list = Array.isArray(body.naFallback) ? body.naFallback.slice(0, 60) : [];
    fb = list.map(r => ({ names: clean(r && r.names, 120), code: normalizeNationalAddress(r && r.code) })).filter(r => r.names || r.code);
    if (fb.some(r => r.names.length < 2 || !r.code)) errors.naFallback = "invalid";
  }
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  const t = now(), u = ctx.user.username;
  await env.DB.batch([["sena_zone", body.zone], ["sena_prep_source", body.prepSource], ["box_weight_kg", String(Math.round(w * 1000) / 1000)], ...extra,
    ...(fb ? [["na_fallback", JSON.stringify(fb)]] : [])].map(([k, v]) =>
    env.DB.prepare("INSERT INTO shipping_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").bind(k, v, u, t)));
  await audit(env, ctx, "shipping_settings_changed", "shipping", "SENA", old, { zone: body.zone, prepSource: body.prepSource, boxWeightKg: w, ...item, ...(fb ? { naFallback: fb } : {}) });
  return getShippingSettings(env.DB);
}

/* ---------- which selected orders can leave ---------- */
function readNumbers(body) {
  const numbers = [...new Set((Array.isArray(body && body.numbers) ? body.numbers : []).map(normalizeOrderNumber).filter(Boolean))];
  if (!numbers.length) throw new HttpError(422, { error: "nothing_selected" });
  if (numbers.length > MAX) throw new HttpError(422, { error: "too_many", max: MAX });
  return numbers;
}
async function examine(env, ctx, numbers) {
  const rows = [], fb = (await getShippingSettings(env.DB)).naFallback;
  for (const n of numbers) {
    const full = await loadOrder(env.DB, n);
    if (!full) { rows.push({ orderNumber: n, eligible: false, reason: "not_found" }); continue; }
    const o = full.order;
    const dup = await env.DB.prepare(`SELECT ${DUP_OF} d FROM orders o WHERE o.id = ?`).bind(o.id).first();
    const steps = PATH[o.status] || [];
    let reason = null;
    if (o.anonymized_at) reason = "anonymized";
    else if (IN_TRANSIT.includes(o.status)) reason = "already_shipped";
    else if (o.status === "DELIVERED") reason = "delivered";
    else if (["CANCELLED", "FAILED"].includes(o.status)) reason = "closed";
    else if (o.status === "ON_HOLD") reason = "on_hold";
    else if (!steps.every((s, i) => allowedTransition(ctx.perms, i ? steps[i - 1] : o.status, s) === "normal")) reason = "transition_not_allowed";
    rows.push({ orderNumber: o.order_number, customer: o.customer_name, phone: localPhone(o.customer_phone), city: o.city, district: o.district,
      boxes: o.boxes, amount: o.total_amount, status: o.status, steps, eligible: !reason, reason, duplicateOf: dupList(dup.d),
      nationalAddress: o.national_address || null, naApprox: o.national_address ? null : fallbackFor(o.city, fb), createdAt: o.created_at });
  }
  return rows;
}
// what is physically in the warehouse (on hand − boxes with the carrier) before and after this export; any order can take it
async function stockPicture(db, selectedBoxes) {
  const f = await stockFlow(db);
  if (!f) return null;
  return { onHand: f.onHand, inWarehouse: f.inWarehouse, withCarrier: f.withCarrier.boxes, selected: selectedBoxes, inWarehouseAfter: f.inWarehouse - selectedBoxes };
}
const totals = async (db, rows) => {
  const ok = rows.filter(r => r.eligible), boxes = ok.reduce((a, r) => a + r.boxes, 0), f = await stockFlow(db);
  // boxes leaving beyond what the warehouse holds in the system (receipt not recorded yet): allowed, but only knowingly
  return { orders: ok.length, boxes, amount: ok.reduce((a, r) => a + r.amount, 0), shortageBoxes: f ? Math.max(0, boxes - Math.max(0, f.inWarehouse)) : 0 };
};

export async function previewShipment(env, ctx, body) {
  need(ctx, "shipments.manage");
  const rows = await examine(env, ctx, readNumbers(body)), tot = await totals(env.DB, rows);
  const d = riyadhDay(now());
  // everything the admin picked, before exclusions («حدّدت 14 طلب بـ 23 علبة»)
  const selected = { orders: rows.length, boxes: rows.reduce((a, r) => a + (r.boxes || 0), 0) };
  // SENA asks for the national address of every shipment inside Saudi Arabia: missing ones are shown (and can be filled) before export
  const missingNationalAddress = rows.filter(r => r.eligible && !r.nationalAddress && !r.naApprox).length;
  const approxNationalAddress = rows.filter(r => r.eligible && !r.nationalAddress && r.naApprox).length;
  return { rows, selected, totals: tot, missingNationalAddress, approxNationalAddress, excluded: rows.filter(r => !r.eligible).length, stock: await stockPicture(env.DB, tot.boxes), settings: await getShippingSettings(env.DB), prepSources: SENA_PREP,
    suggestedName: `شحنة سينا ${d}`, max: MAX };
}

/* ---------- export: batch + status → SHIPPED ---------- */
export async function createShipment(env, ctx, body) {
  need(ctx, "shipments.manage");
  const db = env.DB, numbers = readNumbers(body), name = clean(body.name, 80), notes = clean(body.notes, 300), requestId = String(body.requestId || "");
  const errors = {};
  if (name.length < 2) errors.name = "required";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) errors.requestId = "invalid";
  if (body.prepSource != null && !SENA_PREP.includes(body.prepSource)) errors.prepSource = "invalid";
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  const prior = await db.prepare("SELECT id FROM shipment_batches WHERE request_id = ?").bind(requestId).first();
  if (prior) return { replay: true, batch: await batchSummary(db, prior.id), shipped: [], failed: [] };
  const rows = await examine(env, ctx, numbers), tot = await totals(db, rows);
  const bad = rows.filter(r => !r.eligible);
  if (bad.length) throw new HttpError(409, { error: "not_eligible", orders: bad.map(r => ({ orderNumber: r.orderNumber, reason: r.reason, status: r.status })) });
  // what the admin confirmed must still be what is exported
  if (Number(body.expectedCount) !== tot.orders || Number(body.expectedBoxes) !== tot.boxes) throw new HttpError(409, { error: "selection_changed", totals: tot });
  // shipping more boxes than the system holds is allowed, but only knowingly
  if (tot.shortageBoxes && body.allowShortage !== true) throw new HttpError(409, { error: "shortage_confirmation_required", totals: tot });

  const year = riyadhDay(now()).slice(0, 4), t = now(), prep = body.prepSource || (await getShippingSettings(db)).prepSource;
  let batchId = null;
  for (let i = 0; i < 3 && !batchId; i++) {
    try {
      const r = await db.prepare(`INSERT INTO shipment_batches (batch_no, carrier, name, notes, request_id, created_by, user_id, created_at, prep_source)
        SELECT 'SENA-' || ?1 || '-' || printf('%04d', COALESCE(MAX(CAST(substr(batch_no, 11) AS INTEGER)), 0) + 1), 'SENA', ?2, ?3, ?4, ?5, ?6, ?7, ?8
        FROM shipment_batches WHERE batch_no LIKE 'SENA-' || ?1 || '-%'`).bind(year, name, notes, requestId, ctx.user.username, ctx.user.id, t, prep).run();
      batchId = r.meta.last_row_id || (await db.prepare("SELECT id FROM shipment_batches WHERE request_id = ?").bind(requestId).first()).id;
    } catch (e) {
      if (/UNIQUE constraint failed: shipment_batches\.request_id/i.test(e.message)) {     // the same click arrived twice
        const p = await db.prepare("SELECT id FROM shipment_batches WHERE request_id = ?").bind(requestId).first();
        return { replay: true, batch: await batchSummary(db, p.id), shipped: [], failed: [] };
      }
      if (!/UNIQUE constraint failed: shipment_batches\.batch_no/i.test(e.message)) throw e;   // two exports at the same moment: next number
    }
  }
  if (!batchId) throw new HttpError(409, { error: "busy_try_again" });
  const batch = await db.prepare("SELECT * FROM shipment_batches WHERE id = ?").bind(batchId).first();
  const { shipped, failed } = await shipOrders(env, ctx, batch, rows);
  if (!shipped.length) await db.prepare("DELETE FROM shipment_batches WHERE id = ? AND NOT EXISTS (SELECT 1 FROM shipment_orders WHERE batch_id = ?)").bind(batchId, batchId).run();
  await audit(env, ctx, "shipment_exported", "shipment", batch.batch_no, null, { name, prepSource: prep, orders: shipped.length, boxes: tot.boxes, amount: tot.amount,
    shipped, failed: failed.map(f => f.orderNumber), ...(tot.shortageBoxes ? { shortageBoxes: tot.shortageBoxes } : {}) });
  return { replay: false, batch: shipped.length ? await batchSummary(db, batchId) : null, shipped, failed };
}

/* A reference is never reused: X, then X-2, X-3 … across every shipment of the order (SENA refuses one it has received). */
async function nextShipmentRef(db, o) {
  const refs = (await db.prepare("SELECT shipment_ref r FROM shipment_orders WHERE order_id = ?").bind(o.id).all()).results.map(x => x.r);
  if (!refs.length) return o.order_number;
  return `${o.order_number}-${Math.max(...refs.map(r => r === o.order_number ? 1 : Number(r.slice(o.order_number.length + 1)) || 1)) + 1}`;
}
/* Each order goes to SHIPPED through the normal steps and joins the batch. An order taken out of this same batch earlier comes back on
   its row (one row per batch and order), with a new reference. */
async function shipOrders(env, ctx, batch, rows) {
  const db = env.DB, note = `شُحن مع سينا — ${batch.batch_no} (${batch.name})`, shipped = [], failed = [];
  for (const r of rows) {
    let full = await loadOrder(db, r.orderNumber), reached = full.order.status;
    try {
      for (const step of PATH[full.order.status] || []) {
        await applyTransition(env, ctx, full, step, { note, visibility: "internal", kind: "normal", bulkId: batch.batch_no, notify: step === "SHIPPED" });
        reached = step;
        full = await loadOrder(db, r.orderNumber);
      }
      if (full.order.status !== "SHIPPED") throw new HttpError(409, { error: "status_changed" });
      const o = full.order, ref = await nextShipmentRef(db, o), t = now();
      await db.prepare(`INSERT INTO shipment_orders (batch_id, order_id, shipment_ref, status_before, boxes, amount, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (batch_id, order_id) DO UPDATE SET shipment_ref = ?3, status_before = ?4, boxes = ?5, amount = ?6, created_at = ?7,
          removed_at = NULL, removed_by = NULL, removed_reason = NULL, downloaded_at = NULL`)
        .bind(batch.id, o.id, ref, r.status, o.boxes, o.total_amount, t).run();
      shipped.push(r.orderNumber);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      failed.push({ orderNumber: r.orderNumber, reason: e.body.error, reached });
    }
  }
  return { shipped, failed };
}

/* ---------- edit a batch: add orders ----------
   The same checks as an export: only orders that can really leave, what was confirmed must still be true, boxes beyond the warehouse
   only knowingly. The batch keeps its preparation source. */
export async function shipmentCandidates(env, ctx, id) {
  need(ctx, "shipments.manage");
  const db = env.DB, batch = await batchSummary(db, Number(id)), set = await getShippingSettings(db);
  if (!batch) throw new HttpError(404, { error: "not_found" });
  batch.prepSource = batch.prepSource || set.prepSource;
  const rows = (await db.prepare(`SELECT ${DUP_OF} dup_of, o.* FROM orders o WHERE o.status IN ('RECEIVED','CONFIRMED','PREPARING') AND o.anonymized_at IS NULL AND o.archived_at IS NULL ORDER BY o.id LIMIT ${MAX}`).all()).results;
  return { batch, stock: await stockPicture(db, 0), max: MAX, orders: rows.map(o => ({ orderNumber: o.order_number, customer: o.customer_name, phone: localPhone(o.customer_phone), city: o.city, boxes: o.boxes, amount: o.total_amount,
    status: o.status, createdAt: o.created_at, nationalAddress: o.national_address || null, naApprox: o.national_address ? null : fallbackFor(o.city, set.naFallback), duplicateOf: dupList(o.dup_of) })) };
}
export async function addToShipment(env, ctx, id, body) {
  need(ctx, "shipments.manage");
  const db = env.DB, batch = await db.prepare("SELECT * FROM shipment_batches WHERE id = ?").bind(Number(id)).first();
  if (!batch) throw new HttpError(404, { error: "not_found" });
  const rows = await examine(env, ctx, readNumbers(body)), tot = await totals(db, rows), bad = rows.filter(r => !r.eligible);
  if (bad.length) throw new HttpError(409, { error: "not_eligible", orders: bad.map(r => ({ orderNumber: r.orderNumber, reason: r.reason, status: r.status })) });
  if (Number(body.expectedCount) !== tot.orders || Number(body.expectedBoxes) !== tot.boxes) throw new HttpError(409, { error: "selection_changed", totals: tot });
  if (tot.shortageBoxes && body.allowShortage !== true) throw new HttpError(409, { error: "shortage_confirmation_required", totals: tot });
  const { shipped, failed } = await shipOrders(env, ctx, batch, rows);
  await audit(env, ctx, "shipment_orders_added", "shipment", batch.batch_no, null, { orders: shipped, boxes: tot.boxes, amount: tot.amount, failed: failed.map(f => f.orderNumber), ...(tot.shortageBoxes ? { shortageBoxes: tot.shortageBoxes } : {}) });
  return { added: shipped.length, shipped, failed, batch: await batchSummary(db, batch.id) };
}

/* ---------- batches ---------- */
const AGG = `COUNT(s.id) n, COALESCE(SUM(s.boxes), 0) boxes, COALESCE(SUM(s.amount), 0) amount,
  COALESCE(SUM(o.status = 'DELIVERED'), 0) delivered, COALESCE(SUM(o.status IN ('SHIPPED','OUT_FOR_DELIVERY')), 0) in_transit,
  COALESCE(SUM(o.status = 'FAILED'), 0) failed, COALESCE(SUM(o.status NOT IN ('DELIVERED','SHIPPED','OUT_FOR_DELIVERY','FAILED')), 0) other,
  COALESCE(SUM(CASE WHEN o.status = 'DELIVERED' THEN s.amount END), 0) delivered_amount,
  COALESCE(SUM(CASE WHEN o.status IN ('SHIPPED','OUT_FOR_DELIVERY') THEN s.amount END), 0) transit_amount,
  COALESCE(SUM(CASE WHEN o.status IN ('SHIPPED','OUT_FOR_DELIVERY') THEN s.boxes END), 0) transit_boxes`;
const batchView = b => ({ id: b.id, batchNo: b.batch_no, carrier: b.carrier, name: b.name, notes: b.notes, createdBy: b.created_by, createdAt: b.created_at,
  downloads: b.downloads, lastDownloadAt: b.last_download_at, orders: b.n, boxes: b.boxes, amount: b.amount,
  delivered: b.delivered, inTransit: b.in_transit, failed: b.failed, other: b.other, deliveredAmount: b.delivered_amount, transitAmount: b.transit_amount,
  prepSource: b.prep_source, removed: b.removed || 0, notDownloaded: b.not_downloaded || 0, state: b.in_transit ? "IN_TRANSIT" : "DONE" });
async function batchSummary(db, id) {
  const b = await db.prepare(`SELECT b.*, ${AGG}, (SELECT COUNT(*) FROM shipment_orders x WHERE x.batch_id = b.id AND x.removed_at IS NOT NULL) removed,
    (SELECT COUNT(*) FROM shipment_orders x WHERE x.batch_id = b.id AND x.removed_at IS NULL AND x.downloaded_at IS NULL) not_downloaded FROM shipment_batches b LEFT JOIN shipment_orders s ON s.batch_id = b.id AND s.removed_at IS NULL LEFT JOIN orders o ON o.id = s.order_id WHERE b.id = ? GROUP BY b.id`).bind(id).first();
  return b ? batchView(b) : null;
}

export async function listShipments(env, ctx, params) {
  canView(ctx);
  const db = env.DB, page = Math.max(1, parseInt(params.get("page"), 10) || 1), per = 25, where = [], binds = [];
  const q = clean(params.get("q"), 60);
  if (q) { where.push("(b.name LIKE ? ESCAPE '\\' OR b.batch_no LIKE ? ESCAPE '\\')"); const l = "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%"; binds.push(l, l.toUpperCase()); }
  const state = params.get("state"), having = state === "open" ? "HAVING in_transit > 0" : state === "done" ? "HAVING in_transit = 0" : "";
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const [rows, all, transit] = await Promise.all([
    db.prepare(`SELECT b.*, ${AGG} FROM shipment_batches b LEFT JOIN shipment_orders s ON s.batch_id = b.id AND s.removed_at IS NULL LEFT JOIN orders o ON o.id = s.order_id ${w}
      GROUP BY b.id ${having} ORDER BY b.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    db.prepare(`SELECT COUNT(*) n FROM (SELECT b.id, ${AGG} FROM shipment_batches b LEFT JOIN shipment_orders s ON s.batch_id = b.id AND s.removed_at IS NULL LEFT JOIN orders o ON o.id = s.order_id ${w} GROUP BY b.id ${having})`).bind(...binds).first(),
    // everything currently with the carrier, whatever batch
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(s.boxes), 0) boxes, COALESCE(SUM(s.amount), 0) amount FROM shipment_orders s JOIN orders o ON o.id = s.order_id
      WHERE o.status IN ('SHIPPED','OUT_FOR_DELIVERY') AND s.removed_at IS NULL AND s.id = (SELECT MAX(id) FROM shipment_orders x WHERE x.order_id = s.order_id)`).first()
  ]);
  return { batches: rows.results.map(batchView), total: all.n, page, per, withCarrier: { orders: transit.n, boxes: transit.boxes, amount: transit.amount },
    canManage: ctx.perms.has("shipments.manage") };
}

export async function shipmentDetail(env, ctx, id) {
  canView(ctx);
  const db = env.DB, batch = await batchSummary(db, Number(id)), set = await getShippingSettings(db), fb = set.naFallback;
  if (!batch) throw new HttpError(404, { error: "not_found" });
  batch.prepSource = batch.prepSource || set.prepSource;
  const rows = (await db.prepare(`SELECT s.*, o.order_number, o.customer_name, o.customer_phone, o.city, o.district, o.status, o.anonymized_at, o.national_address, o.updated_at order_updated_at,
      (SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = o.status) status_at, ${DUP_OF} dup_of
    FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE s.batch_id = ? ORDER BY s.id`).bind(batch.id).all()).results;
  const view = r => ({ orderNumber: r.order_number, shipmentRef: r.shipment_ref, customer: r.customer_name, phone: localPhone(r.customer_phone),
    city: r.city, district: r.district, boxes: r.boxes, amount: r.amount, statusBefore: r.status_before, status: r.status, statusAt: r.status_at, anonymized: !!r.anonymized_at,
    nationalAddress: r.national_address || null, naApprox: r.national_address ? null : fallbackFor(r.city, fb), orderUpdatedAt: r.order_updated_at, duplicateOf: dupList(r.dup_of), downloaded: !!r.downloaded_at,
    ...(r.removed_at ? { removedAt: r.removed_at, removedBy: r.removed_by, removedReason: r.removed_reason } : {}) });
  return { batch, orders: rows.filter(r => !r.removed_at).map(view), removed: rows.filter(r => r.removed_at).map(view), canManage: ctx.perms.has("shipments.manage") };
}

/* ---------- the carrier file (their template, filled) ---------- */
export async function shipmentFile(env, ctx, id, { onlyNew = false } = {}) {
  need(ctx, "shipments.manage");
  const db = env.DB, b = await db.prepare("SELECT * FROM shipment_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  const s = await getShippingSettings(db);
  const rows = (await db.prepare(`SELECT s.shipment_ref, s.boxes sboxes, s.amount, o.* FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE s.batch_id = ? AND s.removed_at IS NULL${onlyNew ? " AND s.downloaded_at IS NULL" : ""} ORDER BY s.id`).bind(b.id).all()).results;
  if (onlyNew && !rows.length) throw new HttpError(409, { error: "nothing_new" });
  const kg = n => Math.round(n * s.boxWeightKg * 100) / 100;
  const prep = b.prep_source || s.prepSource, fromStock = prep === FROM_SENA_STOCK;
  // the mobile as a number without its leading 0, and a digits-only SKU / barcode as a whole number: as in the file approved for import
  const mobile = p => /^05\d{8}$/.test(p) ? Number(p.slice(1)) : p;
  const code = v => !fromStock || !v ? null : /^[1-9]\d{0,14}$/.test(v) ? { n: Number(v), s: 1 } : v;
  const shipments = [], items = [];
  for (const o of rows) {
    const address = [o.district ? "حي " + o.district.replace(/^حي\s+/, "") : "", o.address, o.customer_notes ? "ملاحظة: " + o.customer_notes : "",
      o.location_latitude != null ? `الموقع: https://maps.google.com/?q=${o.location_latitude},${o.location_longitude}` : ""].filter(Boolean).join("، ");
    // A اسم المستلم · B المدينة · C الزون · D العنوان · E الجوال · F رقم الطلب · G مرجع الشحنة · H القيمة · I الوزن · J العنوان الوطني · K مصدر التجهيز · L–N أكياس/ببلز/كراتين (لمخزون SENA فقط) · O رقم الزون
    shipments.push([o.anonymized_at ? "—" : o.customer_name, o.city, s.zone, o.anonymized_at ? "—" : address, o.anonymized_at ? "" : mobile(localPhone(o.customer_phone)),
      o.order_number, o.shipment_ref, o.amount, kg(o.sboxes), o.national_address || fallbackFor(o.city, s.naFallback) || "", prep,
      fromStock ? s.bags : 0, fromStock ? s.bubbles : 0, fromStock ? s.cartons : 0, null]);
    // one line per order: the product and its boxes. SKU / barcode only from SENA's stock, where they deduct it (their rule 11); prepared by the merchant the line is a description (rule 12)
    items.push([o.order_number, s.itemName, code(s.sku), code(s.barcode), o.sboxes, s.itemPrice, `${o.sboxes} علبة في الوحدة`, kg(o.sboxes)]);
  }
  const t = now();
  await db.batch([db.prepare("UPDATE shipment_batches SET downloads = downloads + 1, last_download_at = ? WHERE id = ?").bind(t, b.id),
    db.prepare("UPDATE shipment_orders SET downloaded_at = ? WHERE batch_id = ? AND removed_at IS NULL AND downloaded_at IS NULL").bind(t, b.id)]);
  await audit(env, ctx, "shipment_file_downloaded", "shipment", b.batch_no, null, { orders: rows.length, ...(onlyNew ? { onlyNew: true } : {}) });
  const tail = onlyNew ? "-added" : "";
  return { fileName: `${b.batch_no}${tail}.xlsx`, displayName: `${b.batch_no}${tail} ${b.name}.xlsx`, bytes: senaWorkbook(shipments, items) };
}

/* ---------- delivery confirmation for a batch (all remaining, or selected orders) ---------- */
export async function confirmShipment(env, ctx, id, body) {
  need(ctx, "shipments.manage");
  const db = env.DB, b = await db.prepare("SELECT * FROM shipment_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  const to = String(body && body.status || "");
  if (!["DELIVERED", "FAILED", "OUT_FOR_DELIVERY"].includes(to)) throw new HttpError(422, { error: "invalid_status" });
  const inBatch = new Set((await db.prepare("SELECT o.order_number FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE s.batch_id = ? AND s.removed_at IS NULL").bind(b.id).all()).results.map(r => r.order_number));
  const numbers = readNumbers(body);
  if (body.expectedCount != null && Number(body.expectedCount) !== numbers.length) throw new HttpError(409, { error: "selection_changed" });
  const note = clean(body.note, 300), updated = [], skipped = [];
  const label = { DELIVERED: "تأكيد التوصيل", FAILED: "تعذّر التوصيل", OUT_FOR_DELIVERY: "خرج للتوصيل" }[to];
  for (const n of numbers) {
    if (!inBatch.has(n)) { skipped.push({ orderNumber: n, reason: "not_in_batch" }); continue; }
    const full = await loadOrder(db, n), o = full.order;
    if (o.status === to) { skipped.push({ orderNumber: n, reason: "already", status: o.status }); continue; }
    if (o.anonymized_at) { skipped.push({ orderNumber: n, reason: "anonymized", status: o.status }); continue; }
    if (!IN_TRANSIT.includes(o.status) || allowedTransition(ctx.perms, o.status, to) !== "normal") { skipped.push({ orderNumber: n, reason: "transition_not_allowed", status: o.status }); continue; }
    try {
      await applyTransition(env, ctx, await loadOrder(db, n), to, { note: `${label} — ${b.batch_no}` + (note ? `: ${note}` : ""), visibility: "internal", kind: "normal", bulkId: `${b.batch_no}:${to}` });
      updated.push(n);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      skipped.push({ orderNumber: n, reason: e.body.error, status: o.status, ...(e.body.shortage != null ? { shortage: e.body.shortage } : {}) });
    }
  }
  await audit(env, ctx, to === "DELIVERED" ? "shipment_delivery_confirmed" : to === "FAILED" ? "shipment_delivery_failed" : "shipment_out_for_delivery", "shipment", b.batch_no, null,
    { status: to, note: note || undefined, requested: numbers.length, updated: updated.length, orders: updated, skipped: skipped.map(s => s.orderNumber) });
  return { updated: updated.length, skipped, batch: await batchSummary(db, b.id) };
}

/* ---------- edit a batch: take orders out ----------
   action "cancel": the order is cancelled (e.g. a duplicate) · "return": back to «جاري التجهيز», to be shipped in a later batch.
   Either way its boxes go back to the warehouse for other orders, its row leaves the totals and the carrier file (download it
   again), and its history records who did it. Taking an order out of a shipment is part of managing shipments, so
   shipments.manage is enough even though leaving «تم الشحن» is otherwise an exceptional status change. */
export async function removeFromShipment(env, ctx, id, body) {
  need(ctx, "shipments.manage");
  const db = env.DB, b = await db.prepare("SELECT * FROM shipment_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  const action = String(body && body.action || "");
  if (!["cancel", "return"].includes(action)) throw new HttpError(422, { error: "invalid_action" });
  const numbers = readNumbers(body);
  if (body.expectedCount != null && Number(body.expectedCount) !== numbers.length) throw new HttpError(409, { error: "selection_changed" });
  const inBatch = new Set((await db.prepare("SELECT o.order_number FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE s.batch_id = ? AND s.removed_at IS NULL").bind(b.id).all()).results.map(r => r.order_number));
  const to = action === "cancel" ? "CANCELLED" : "PREPARING", note = clean(body.note, 300), removed = [], skipped = [];
  const label = action === "cancel" ? `أُلغي وأُزيل من الشحنة ${b.batch_no}` : `أُعيد للتجهيز وأُزيل من الشحنة ${b.batch_no}`;
  for (const n of numbers) {
    if (!inBatch.has(n)) { skipped.push({ orderNumber: n, reason: "not_in_batch" }); continue; }
    const full = await loadOrder(db, n), o = full.order;
    if (o.anonymized_at) { skipped.push({ orderNumber: n, reason: "anonymized", status: o.status }); continue; }
    if (!["SHIPPED", "OUT_FOR_DELIVERY", "ON_HOLD"].includes(o.status)) { skipped.push({ orderNumber: n, reason: "transition_not_allowed", status: o.status }); continue; }
    try {
      await applyTransition(env, ctx, full, to, { note: label + (note ? `: ${note}` : ""), visibility: "internal", kind: allowedTransition(ctx.perms, o.status, to) || "override",
        bulkId: `${b.batch_no}:remove`, notify: to === "CANCELLED" });
      removed.push(n);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      skipped.push({ orderNumber: n, reason: e.body.error, status: o.status });
    }
  }
  await audit(env, ctx, "shipment_orders_removed", "shipment", b.batch_no, null, { action, note: note || undefined, orders: removed, skipped: skipped.map(s => s.orderNumber) });
  return { removed: removed.length, skipped, batch: await batchSummary(db, b.id) };
}

/* shipment rows of one order (order page) */
export async function shipmentsOfOrder(db, orderId) {
  return (await db.prepare(`SELECT s.shipment_ref, s.created_at, s.removed_at, s.removed_reason, b.id, b.batch_no, b.name FROM shipment_orders s JOIN shipment_batches b ON b.id = s.batch_id WHERE s.order_id = ? ORDER BY s.id`)
    .bind(orderId).all()).results.map(r => ({ batchId: r.id, batchNo: r.batch_no, name: r.name, shipmentRef: r.shipment_ref, at: r.created_at, removedAt: r.removed_at, removedReason: r.removed_reason }));
}
