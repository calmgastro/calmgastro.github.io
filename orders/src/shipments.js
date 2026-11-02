/* Shipments to the carrier (SENA).

   Export = one batch: the admin selects orders, sees how many boxes leave the warehouse, names the export and confirms.
   Each order then moves to SHIPPED through the normal steps (RECEIVED → CONFIRMED → PREPARING → SHIPPED, each one in its
   history, the customer notified once, for «تم الشحن»), gets a unique shipment reference, and the carrier's own Excel
   template is filled from the batch (downloadable again at any time). Only orders that can really leave are accepted:
   not cancelled / failed / delivered / already shipped / on hold / anonymized. A stock shortage does not block the export
   (the boxes may be physically there before the receipt is recorded) — it is shown and must be confirmed (allowShortage).

   Delivery = per batch: confirm all remaining orders, or the selected ones, as Delivered (or Failed) in one action. It is
   the usual status change, so stock is consumed (FIFO cost), revenue counts and the history records who confirmed. A
   shortage order first takes whatever stock is available now; one still short is skipped until the receipt is recorded. */
import { HttpError, loadOrder, normalizeOrderNumber, localPhone } from "./orders.js";
import { allowedTransition } from "./statuses.js";
import { applyTransition, need, BULK_MAX } from "./admin.js";
import { audit } from "./auth.js";
import { getBalance, riyadhDay } from "./inventory.js";
import { allocateShortage } from "./stock_admin.js";
import { senaWorkbook } from "./xlsx.js";
import { SENA_ZONES, SENA_PREP, SENA_MAX_ROWS } from "./sena_template.js";

const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const MAX = Math.min(BULK_MAX, SENA_MAX_ROWS);
// the normal steps from each status to «تم الشحن»
const PATH = { RECEIVED: ["CONFIRMED", "PREPARING", "SHIPPED"], CONFIRMED: ["PREPARING", "SHIPPED"], PREPARING: ["SHIPPED"] };
const IN_TRANSIT = ["SHIPPED", "OUT_FOR_DELIVERY"];
const canView = ctx => { if (!ctx.perms.has("shipments.manage") && !ctx.perms.has("orders.view")) throw new HttpError(403, { error: "forbidden" }); };

/* ---------- settings (zone, preparation source, weight of one box) ---------- */
export async function getShippingSettings(db) {
  const rows = (await db.prepare("SELECT key, value FROM shipping_settings").all()).results, s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { zone: s.sena_zone || SENA_ZONES.find(z => z.code === "KSA").label, prepSource: s.sena_prep_source || SENA_PREP[0], boxWeightKg: Number(s.box_weight_kg || 0.5) };
}
export async function shippingSettings(env, ctx) {
  canView(ctx);
  return { settings: await getShippingSettings(env.DB), zones: SENA_ZONES, prepSources: SENA_PREP, canManage: ctx.perms.has("shipments.manage") };
}
export async function saveShippingSettings(env, ctx, body) {
  need(ctx, "shipments.manage");
  const errors = {}, w = Number(body.boxWeightKg);
  if (!SENA_ZONES.some(z => z.label === body.zone)) errors.zone = "invalid";
  if (!SENA_PREP.includes(body.prepSource)) errors.prepSource = "invalid";
  if (!(w >= 0.01 && w <= 30)) errors.boxWeightKg = "invalid";
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  const old = await getShippingSettings(env.DB), t = now(), u = ctx.user.username;
  await env.DB.batch([["sena_zone", body.zone], ["sena_prep_source", body.prepSource], ["box_weight_kg", String(Math.round(w * 1000) / 1000)]].map(([k, v]) =>
    env.DB.prepare("INSERT INTO shipping_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").bind(k, v, u, t)));
  await audit(env, ctx, "shipping_settings_changed", "shipping", "SENA", old, { zone: body.zone, prepSource: body.prepSource, boxWeightKg: w });
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
  const rows = [];
  for (const n of numbers) {
    const full = await loadOrder(env.DB, n);
    if (!full) { rows.push({ orderNumber: n, eligible: false, reason: "not_found" }); continue; }
    const o = full.order;
    const res = await env.DB.prepare("SELECT status, shortage_qty FROM inventory_reservations WHERE order_id = ? AND status = 'SHORTAGE'").bind(o.id).first();
    const steps = PATH[o.status] || [];
    let reason = null;
    if (o.anonymized_at) reason = "anonymized";
    else if (IN_TRANSIT.includes(o.status)) reason = "already_shipped";
    else if (o.status === "DELIVERED") reason = "delivered";
    else if (["CANCELLED", "FAILED"].includes(o.status)) reason = "closed";
    else if (o.status === "ON_HOLD") reason = "on_hold";
    else if (!steps.every((s, i) => allowedTransition(ctx.perms, i ? steps[i - 1] : o.status, s) === "normal")) reason = "transition_not_allowed";
    rows.push({ orderNumber: o.order_number, customer: o.customer_name, phone: localPhone(o.customer_phone), city: o.city, district: o.district,
      boxes: o.boxes, amount: o.total_amount, status: o.status, steps, eligible: !reason, reason, shortage: res ? res.shortage_qty : 0, createdAt: o.created_at });
  }
  return rows;
}
async function stockPicture(db, selectedBoxes) {
  const b = await getBalance(db);
  if (!b) return null;
  // boxes of orders already handed to the carrier are still on hand (sold only when delivered) but no longer in the warehouse
  const t = await db.prepare(`SELECT COALESCE(SUM(r.reserved_qty), 0) n FROM inventory_reservations r JOIN orders o ON o.id = r.order_id
    WHERE r.status IN ('RESERVED','SHORTAGE') AND o.status IN ('SHIPPED','OUT_FOR_DELIVERY')`).first();
  const inWarehouse = b.on_hand - t.n;
  return { onHand: b.on_hand, reserved: b.reserved, available: b.on_hand - b.reserved, withCarrier: t.n, inWarehouse, selected: selectedBoxes, inWarehouseAfter: inWarehouse - selectedBoxes };
}
const totals = rows => {
  const ok = rows.filter(r => r.eligible), short = ok.filter(r => r.shortage > 0);
  return { orders: ok.length, boxes: ok.reduce((a, r) => a + r.boxes, 0), amount: ok.reduce((a, r) => a + r.amount, 0),
    shortageOrders: short.length, shortageBoxes: short.reduce((a, r) => a + r.shortage, 0) };
};

export async function previewShipment(env, ctx, body) {
  need(ctx, "shipments.manage");
  const rows = await examine(env, ctx, readNumbers(body)), tot = totals(rows);
  const d = riyadhDay(now());
  // everything the admin picked, before exclusions («حدّدت 14 طلب بـ 23 علبة»)
  const selected = { orders: rows.length, boxes: rows.reduce((a, r) => a + (r.boxes || 0), 0) };
  return { rows, selected, totals: tot, excluded: rows.filter(r => !r.eligible).length, stock: await stockPicture(env.DB, tot.boxes), settings: await getShippingSettings(env.DB),
    suggestedName: `شحنة سينا ${d}`, max: MAX };
}

/* ---------- export: batch + status → SHIPPED ---------- */
export async function createShipment(env, ctx, body) {
  need(ctx, "shipments.manage");
  const db = env.DB, numbers = readNumbers(body), name = clean(body.name, 80), notes = clean(body.notes, 300), requestId = String(body.requestId || "");
  const errors = {};
  if (name.length < 2) errors.name = "required";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) errors.requestId = "invalid";
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  const prior = await db.prepare("SELECT id FROM shipment_batches WHERE request_id = ?").bind(requestId).first();
  if (prior) return { replay: true, batch: await batchSummary(db, prior.id), shipped: [], failed: [] };
  const rows = await examine(env, ctx, numbers), tot = totals(rows);
  const bad = rows.filter(r => !r.eligible);
  if (bad.length) throw new HttpError(409, { error: "not_eligible", orders: bad.map(r => ({ orderNumber: r.orderNumber, reason: r.reason, status: r.status })) });
  // what the admin confirmed must still be what is exported
  if (Number(body.expectedCount) !== tot.orders || Number(body.expectedBoxes) !== tot.boxes) throw new HttpError(409, { error: "selection_changed", totals: tot });
  // shipping more boxes than the system holds is allowed, but only knowingly
  if (tot.shortageOrders && body.allowShortage !== true) throw new HttpError(409, { error: "shortage_confirmation_required", totals: tot });

  const year = riyadhDay(now()).slice(0, 4), t = now();
  let batchId = null;
  for (let i = 0; i < 3 && !batchId; i++) {
    try {
      const r = await db.prepare(`INSERT INTO shipment_batches (batch_no, carrier, name, notes, request_id, created_by, user_id, created_at)
        SELECT 'SENA-' || ?1 || '-' || printf('%04d', COALESCE(MAX(CAST(substr(batch_no, 11) AS INTEGER)), 0) + 1), 'SENA', ?2, ?3, ?4, ?5, ?6, ?7
        FROM shipment_batches WHERE batch_no LIKE 'SENA-' || ?1 || '-%'`).bind(year, name, notes, requestId, ctx.user.username, ctx.user.id, t).run();
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
  const note = `شُحن مع سينا — ${batch.batch_no} (${name})`;
  const shipped = [], failed = [];
  for (const r of rows) {
    let full = await loadOrder(db, r.orderNumber), reached = full.order.status;
    try {
      for (const step of PATH[full.order.status] || []) {
        await applyTransition(env, ctx, full, step, { note, visibility: "internal", kind: "normal", bulkId: batch.batch_no, notify: step === "SHIPPED" });
        reached = step;
        full = await loadOrder(db, r.orderNumber);
      }
      if (full.order.status !== "SHIPPED") throw new HttpError(409, { error: "status_changed" });
      const n = (await db.prepare("SELECT COUNT(*) n FROM shipment_orders WHERE order_id = ?").bind(full.order.id).first()).n;
      await db.prepare(`INSERT INTO shipment_orders (batch_id, order_id, shipment_ref, status_before, boxes, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(batchId, full.order.id, n ? `${full.order.order_number}-${n + 1}` : full.order.order_number, r.status, full.order.boxes, full.order.total_amount, now()).run();
      shipped.push(r.orderNumber);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      failed.push({ orderNumber: r.orderNumber, reason: e.body.error, reached });
    }
  }
  if (!shipped.length) await db.prepare("DELETE FROM shipment_batches WHERE id = ? AND NOT EXISTS (SELECT 1 FROM shipment_orders WHERE batch_id = ?)").bind(batchId, batchId).run();
  await audit(env, ctx, "shipment_exported", "shipment", batch.batch_no, null, { name, orders: shipped.length, boxes: tot.boxes, amount: tot.amount,
    shipped, failed: failed.map(f => f.orderNumber), ...(tot.shortageOrders ? { shortageOrders: rows.filter(r => r.shortage > 0).map(r => r.orderNumber), shortageBoxes: tot.shortageBoxes } : {}) });
  return { replay: false, batch: shipped.length ? await batchSummary(db, batchId) : null, shipped, failed };
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
  state: b.in_transit ? "IN_TRANSIT" : "DONE" });
async function batchSummary(db, id) {
  const b = await db.prepare(`SELECT b.*, ${AGG} FROM shipment_batches b LEFT JOIN shipment_orders s ON s.batch_id = b.id LEFT JOIN orders o ON o.id = s.order_id WHERE b.id = ? GROUP BY b.id`).bind(id).first();
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
    db.prepare(`SELECT b.*, ${AGG} FROM shipment_batches b LEFT JOIN shipment_orders s ON s.batch_id = b.id LEFT JOIN orders o ON o.id = s.order_id ${w}
      GROUP BY b.id ${having} ORDER BY b.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    db.prepare(`SELECT COUNT(*) n FROM (SELECT b.id, ${AGG} FROM shipment_batches b LEFT JOIN shipment_orders s ON s.batch_id = b.id LEFT JOIN orders o ON o.id = s.order_id ${w} GROUP BY b.id ${having})`).bind(...binds).first(),
    // everything currently with the carrier, whatever batch
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(s.boxes), 0) boxes, COALESCE(SUM(s.amount), 0) amount FROM shipment_orders s JOIN orders o ON o.id = s.order_id
      WHERE o.status IN ('SHIPPED','OUT_FOR_DELIVERY') AND s.id = (SELECT MAX(id) FROM shipment_orders x WHERE x.order_id = s.order_id)`).first()
  ]);
  return { batches: rows.results.map(batchView), total: all.n, page, per, withCarrier: { orders: transit.n, boxes: transit.boxes, amount: transit.amount },
    canManage: ctx.perms.has("shipments.manage") };
}

export async function shipmentDetail(env, ctx, id) {
  canView(ctx);
  const db = env.DB, batch = await batchSummary(db, Number(id));
  if (!batch) throw new HttpError(404, { error: "not_found" });
  const rows = (await db.prepare(`SELECT s.*, o.order_number, o.customer_name, o.customer_phone, o.city, o.district, o.status, o.anonymized_at,
      (SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = o.status) status_at,
      (SELECT COALESCE(SUM(r.shortage_qty), 0) FROM inventory_reservations r WHERE r.order_id = o.id AND r.status = 'SHORTAGE') shortage
    FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE s.batch_id = ? ORDER BY s.id`).bind(batch.id).all()).results;
  return { batch, orders: rows.map(r => ({ orderNumber: r.order_number, shipmentRef: r.shipment_ref, customer: r.customer_name, phone: localPhone(r.customer_phone),
      city: r.city, district: r.district, boxes: r.boxes, amount: r.amount, statusBefore: r.status_before, status: r.status, statusAt: r.status_at, anonymized: !!r.anonymized_at,
      shortage: r.shortage })),
    canManage: ctx.perms.has("shipments.manage") };
}

/* ---------- the carrier file (their template, filled) ---------- */
export async function shipmentFile(env, ctx, id) {
  need(ctx, "shipments.manage");
  const db = env.DB, b = await db.prepare("SELECT * FROM shipment_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  const s = await getShippingSettings(db);
  const rows = (await db.prepare(`SELECT s.shipment_ref, s.boxes sboxes, s.amount, o.* FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE s.batch_id = ? ORDER BY s.id`).bind(b.id).all()).results;
  const kg = n => Math.round(n * s.boxWeightKg * 100) / 100;
  const shipments = [], items = [];
  for (const o of rows) {
    const address = [o.district ? "حي " + o.district.replace(/^حي\s+/, "") : "", o.address, o.customer_notes ? "ملاحظة: " + o.customer_notes : "",
      o.location_latitude != null ? `الموقع: https://maps.google.com/?q=${o.location_latitude},${o.location_longitude}` : ""].filter(Boolean).join("، ");
    // A اسم المستلم · B المدينة · C الزون · D العنوان · E الجوال · F رقم الطلب · G مرجع الشحنة · H القيمة · I الوزن · J العنوان الوطني (فارغ حالياً) · K مصدر التجهيز · L–N أكياس/ببلز/كراتين · O رقم الزون
    shipments.push([o.anonymized_at ? "—" : o.customer_name, o.city, s.zone, o.anonymized_at ? "—" : address, o.anonymized_at ? "" : localPhone(o.customer_phone),
      o.order_number, o.shipment_ref, o.amount, kg(o.sboxes), "", s.prepSource, 0, 0, 0, null]);
    for (const i of (await db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").bind(o.id).all()).results)
      items.push([o.order_number, i.product_name_snapshot, null, null, i.quantity, i.unit_price, `${i.boxes_per_unit} علبة في الوحدة`, kg(i.boxes_per_unit * i.quantity)]);
  }
  await db.prepare("UPDATE shipment_batches SET downloads = downloads + 1, last_download_at = ? WHERE id = ?").bind(now(), b.id).run();
  await audit(env, ctx, "shipment_file_downloaded", "shipment", b.batch_no, null, { orders: rows.length });
  return { fileName: `${b.batch_no}.xlsx`, displayName: `${b.batch_no} ${b.name}.xlsx`, bytes: senaWorkbook(shipments, items) };
}

/* ---------- delivery confirmation for a batch (all remaining, or selected orders) ---------- */
export async function confirmShipment(env, ctx, id, body) {
  need(ctx, "shipments.manage");
  const db = env.DB, b = await db.prepare("SELECT * FROM shipment_batches WHERE id = ?").bind(Number(id)).first();
  if (!b) throw new HttpError(404, { error: "not_found" });
  const to = String(body && body.status || "");
  if (!["DELIVERED", "FAILED", "OUT_FOR_DELIVERY"].includes(to)) throw new HttpError(422, { error: "invalid_status" });
  const inBatch = new Set((await db.prepare("SELECT o.order_number FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE s.batch_id = ?").bind(b.id).all()).results.map(r => r.order_number));
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
      // shipped short of stock: take what has been received since, so delivery can consume it
      if (to === "DELIVERED" && await db.prepare("SELECT 1 FROM inventory_reservations WHERE order_id = ? AND status = 'SHORTAGE'").bind(o.id).first()) {
        try { await allocateShortage(env, ctx, o); } catch (e) { if (!(e instanceof HttpError)) throw e; }
      }
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

/* shipment rows of one order (order page) */
export async function shipmentsOfOrder(db, orderId) {
  return (await db.prepare(`SELECT s.shipment_ref, s.created_at, b.id, b.batch_no, b.name FROM shipment_orders s JOIN shipment_batches b ON b.id = s.batch_id WHERE s.order_id = ? ORDER BY s.id`)
    .bind(orderId).all()).results.map(r => ({ batchId: r.id, batchNo: r.batch_no, name: r.name, shipmentRef: r.shipment_ref, at: r.created_at }));
}
