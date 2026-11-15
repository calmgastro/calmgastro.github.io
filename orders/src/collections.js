/* Collections (migration 0014): cash on delivery the carrier (SENA) collected and owes us, cash taken by hand, and the
   payments received from SENA.

   - Owed by SENA      = orders Delivered while in an active SENA shipment row (the latest one for the order), not covered
                         by a standing settlement. Amount = the amount in the SENA file (shipment_orders.amount), which is
                         what SENA collected; a different current order total is flagged, never silently used.
   - With SENA         = active shipment rows whose order is still Shipped / Out for delivery (to be collected).
   - Hand delivered    = orders Delivered with no active shipment row (removed from a batch, or never exported).
   - Settlement        = one payment from SENA covering every owed delivery up to a cut-off day (Riyadh day of delivery):
                         expected (sum of the amounts), received (fees may be deducted), received day, received by, reference.
                         The admin confirms the count and total they saw (409 selection_changed otherwise). Voiding keeps
                         the record and makes its orders owed again.
   Delivered day = the last «تم التوصيل» in the order history, as a Riyadh calendar day. Money in SAR; received in halalas. */
import { HttpError } from "./orders.js";
import { need } from "./admin.js";
import { auditStmt } from "./auth.js";
import { riyadhDay, validDay } from "./inventory.js";

const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const sar = h => Math.round(h) / 100;
const DELIVERED_AT = "(SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'DELIVERED')";
const DELIVERED_BY = "(SELECT h.changed_by FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'DELIVERED' ORDER BY h.id DESC LIMIT 1)";
const LATEST_ACTIVE = "s.removed_at IS NULL AND s.id = (SELECT MAX(s2.id) FROM shipment_orders s2 WHERE s2.order_id = s.order_id AND s2.removed_at IS NULL)";
const name = o => o.anonymized_at ? "—" : o.customer_name;

async function owedRows(db) {
  const rows = (await db.prepare(`SELECT s.id sid, s.amount, s.shipment_ref, b.id batch_id, b.batch_no, o.id oid, o.order_number, o.customer_name, o.anonymized_at,
      o.city, o.total_amount, ${DELIVERED_AT} delivered_at
    FROM shipment_orders s JOIN shipment_batches b ON b.id = s.batch_id JOIN orders o ON o.id = s.order_id
    WHERE ${LATEST_ACTIVE} AND o.status = 'DELIVERED'
      AND NOT EXISTS (SELECT 1 FROM carrier_settlement_orders c WHERE c.shipment_order_id = s.id AND c.active = 1)
    ORDER BY delivered_at, s.id`).all()).results;
  return rows.map(r => ({ sid: r.sid, orderNumber: r.order_number, customer: name(r), city: r.city, batchId: r.batch_id, batchNo: r.batch_no, shipmentRef: r.shipment_ref,
    deliveredAt: r.delivered_at, deliveredDay: r.delivered_at ? riyadhDay(r.delivered_at) : null, amount: r.amount, orderTotal: r.total_amount, mismatch: r.total_amount !== r.amount }));
}
const upTo = (rows, day) => rows.filter(r => r.deliveredDay && r.deliveredDay <= day);
const sum = rows => ({ count: rows.length, amount: rows.reduce((a, r) => a + r.amount, 0) });

async function manualRows(db) {
  const rows = (await db.prepare(`SELECT o.order_number, o.customer_name, o.anonymized_at, o.city, o.total_amount, o.source, ${DELIVERED_AT} delivered_at, ${DELIVERED_BY} delivered_by
    FROM orders o WHERE o.status = 'DELIVERED' AND NOT EXISTS (SELECT 1 FROM shipment_orders s WHERE s.order_id = o.id AND s.removed_at IS NULL)
    ORDER BY delivered_at DESC`).all()).results;
  return rows.map(r => ({ orderNumber: r.order_number, customer: name(r), city: r.city, amount: r.total_amount, source: r.source,
    deliveredAt: r.delivered_at, deliveredDay: r.delivered_at ? riyadhDay(r.delivered_at) : null, deliveredBy: r.delivered_by || "" }));
}

const settlementView = s => ({ id: s.id, settlementNo: s.settlement_no, cutoffDay: s.cutoff_day, ordersCount: s.orders_count, expected: sar(s.expected_halalas),
  received: sar(s.received_halalas), difference: sar(s.received_halalas - s.expected_halalas), receivedDay: s.received_day, receivedBy: s.received_by, reference: s.reference,
  notes: s.notes, createdBy: s.created_by, createdAt: s.created_at, voided: !!s.voided_at, voidedAt: s.voided_at, voidedBy: s.voided_by, voidReason: s.void_reason });

/* GET /collections?to=YYYY-MM-DD&mfrom=&mto= : everything the page shows */
export async function collectionsPage(env, ctx, params) {
  need(ctx, "settlements.view");
  const db = env.DB, today = riyadhDay(now());
  const to = validDay(params.get("to")) ? params.get("to") : today;
  const mfrom = validDay(params.get("mfrom")) ? params.get("mfrom") : today.slice(0, 8) + "01", mto = validDay(params.get("mto")) ? params.get("mto") : today;
  const [owed, manual, transit, settled, list] = await Promise.all([
    owedRows(db), manualRows(db),
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(s.amount), 0) a FROM shipment_orders s JOIN orders o ON o.id = s.order_id WHERE ${LATEST_ACTIVE} AND o.status IN ('SHIPPED', 'OUT_FOR_DELIVERY')`).first(),
    db.prepare("SELECT COUNT(*) n, COALESCE(SUM(orders_count), 0) orders, COALESCE(SUM(expected_halalas), 0) e, COALESCE(SUM(received_halalas), 0) r FROM carrier_settlements WHERE voided_at IS NULL").first(),
    db.prepare("SELECT * FROM carrier_settlements ORDER BY id DESC LIMIT 100").all()
  ]);
  const owedTo = upTo(owed, to), manualIn = manual.filter(r => r.deliveredDay && r.deliveredDay >= mfrom && r.deliveredDay <= mto);
  return {
    to, mfrom, mto, today, canManage: ctx.perms.has("settlements.manage"),
    summary: { owed: sum(owed), owedTo: sum(owedTo), withCarrier: { count: transit.n, amount: transit.a },
      settled: { count: settled.n, orders: settled.orders, expected: sar(settled.e), received: sar(settled.r), difference: sar(settled.r - settled.e) },
      manual: sum(manual), manualRange: sum(manualIn) },
    owed: owedTo.map(({ sid, ...r }) => r), manual: manualIn, settlements: list.results.map(settlementView)
  };
}

/* GET /collections/claim.csv?to= : the statement to send to SENA */
export async function claimCsv(env, ctx, params) {
  need(ctx, "settlements.view");
  const to = validDay(params.get("to")) ? params.get("to") : riyadhDay(now());
  const rows = upTo(await owedRows(env.DB), to);
  const cell = v => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["رقم الطلب", "مرجع الشحنة", "الشحنة", "تاريخ التوصيل", "العميل", "المدينة", "المبلغ المحصّل (ر.س)"].join(",")]
    .concat(rows.map(r => [r.orderNumber, r.shipmentRef, r.batchNo, r.deliveredDay, r.customer, r.city, r.amount].map(cell).join(",")))
    .concat([["الإجمالي", "", "", "حتى " + to, rows.length + " طلب", "", rows.reduce((a, r) => a + r.amount, 0)].map(cell).join(",")]);
  await auditStmt(env, ctx, "collections_claim_exported", "settlement", null, null, { to, orders: rows.length }).run();
  return { body: "﻿" + lines.join("\r\n") + "\r\n", to };
}

/* POST /collections/settlements : a payment received from SENA for every owed delivery up to `to` */
export async function createSettlement(env, ctx, body) {
  need(ctx, "settlements.manage");
  const db = env.DB, errors = {};
  const to = String(body.to || ""), receivedDay = String(body.receivedDay || ""), receivedBy = clean(body.receivedBy, 60);
  const reference = clean(body.reference, 80), notes = clean(body.notes, 300), requestId = String(body.requestId || "");
  const received = Number(body.receivedAmount);
  if (!validDay(to)) errors.to = "invalid";
  if (!validDay(receivedDay)) errors.receivedDay = "invalid";
  if (receivedBy.length < 2) errors.receivedBy = "required";
  // SAR with at most 2 decimals (halalas)
  if (body.receivedAmount === "" || body.receivedAmount == null || !Number.isFinite(received) || received < 0 || received > 10000000 || Math.abs(received * 100 - Math.round(received * 100)) > 1e-6) errors.receivedAmount = "invalid";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) errors.requestId = "invalid";
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  const prior = await db.prepare("SELECT * FROM carrier_settlements WHERE request_id = ?").bind(requestId).first();
  if (prior) return { replay: true, settlement: settlementView(prior) };
  const rows = upTo(await owedRows(db), to), tot = sum(rows);
  if (!rows.length) throw new HttpError(409, { error: "nothing_owed" });
  // what the admin confirmed must still be what is settled (a delivery confirmed meanwhile changes it)
  if (Number(body.expectedCount) !== tot.count || Number(body.expectedAmount) !== tot.amount) throw new HttpError(409, { error: "selection_changed", totals: tot });
  const t = now(), year = t.slice(0, 4), recvH = Math.round(received * 100), expH = tot.amount * 100;
  const id = "(SELECT id FROM carrier_settlements WHERE request_id = ?)";
  const stmts = [
    db.prepare(`INSERT INTO carrier_settlements (settlement_no, cutoff_day, orders_count, expected_halalas, received_halalas, received_day, received_by, reference, notes, request_id, created_by, user_id, created_at)
      VALUES ('SET-' || ?1 || '-' || printf('%04d', (SELECT COUNT(*) + 1 FROM carrier_settlements WHERE settlement_no LIKE 'SET-' || ?1 || '-%')), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
      .bind(year, to, tot.count, expH, recvH, receivedDay, receivedBy, reference, notes, requestId, ctx.user.username, ctx.user.id ?? null, t),
    ...rows.map(r => db.prepare(`INSERT INTO carrier_settlement_orders (settlement_id, shipment_order_id, order_id, amount, active, created_at)
      VALUES (${id}, ?, (SELECT order_id FROM shipment_orders WHERE id = ?), ?, 1, ?)`).bind(requestId, r.sid, r.sid, r.amount, t)),
    auditStmt(env, ctx, "settlement_created", "settlement", requestId, null,
      { to, orders: tot.count, expected: tot.amount, received: sar(recvH), receivedDay, receivedBy, reference: reference || undefined })
  ];
  try { await db.batch(stmts); }
  catch (e) {
    // the same delivery already covered by a settlement saved a moment ago (another tab): nothing was written
    if (/UNIQUE/i.test(String(e && e.message))) throw new HttpError(409, { error: "selection_changed", totals: sum(upTo(await owedRows(db), to)) });
    throw e;
  }
  const s = await db.prepare("SELECT * FROM carrier_settlements WHERE request_id = ?").bind(requestId).first();
  return { settlement: settlementView(s) };
}

/* GET /collections/settlements/:id */
export async function settlementDetail(env, ctx, id) {
  need(ctx, "settlements.view");
  const s = await env.DB.prepare("SELECT * FROM carrier_settlements WHERE id = ?").bind(Number(id)).first();
  if (!s) throw new HttpError(404, { error: "not_found" });
  const rows = (await env.DB.prepare(`SELECT c.amount, c.active, s.shipment_ref, b.batch_no, b.id batch_id, o.order_number, o.customer_name, o.anonymized_at, o.city, ${DELIVERED_AT} delivered_at
    FROM carrier_settlement_orders c JOIN shipment_orders s ON s.id = c.shipment_order_id JOIN shipment_batches b ON b.id = s.batch_id JOIN orders o ON o.id = c.order_id
    WHERE c.settlement_id = ? ORDER BY delivered_at, c.id`).bind(s.id).all()).results;
  return { settlement: settlementView(s), orders: rows.map(r => ({ orderNumber: r.order_number, customer: name(r), city: r.city, batchId: r.batch_id, batchNo: r.batch_no,
    shipmentRef: r.shipment_ref, deliveredDay: r.delivered_at ? riyadhDay(r.delivered_at) : null, amount: r.amount })) };
}

/* POST /collections/settlements/:id/void { reason } : the record stays; its orders are owed again */
export async function voidSettlement(env, ctx, id, body) {
  need(ctx, "settlements.manage");
  const reason = clean(body.reason, 200);
  if (reason.length < 3) throw new HttpError(422, { error: "validation", fields: { reason: "required" } });
  const s = await env.DB.prepare("SELECT * FROM carrier_settlements WHERE id = ?").bind(Number(id)).first();
  if (!s) throw new HttpError(404, { error: "not_found" });
  if (s.voided_at) throw new HttpError(409, { error: "already_voided" });
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE carrier_settlements SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL").bind(t, ctx.user.username, reason, s.id),
    env.DB.prepare("UPDATE carrier_settlement_orders SET active = NULL WHERE settlement_id = ?").bind(s.id),
    auditStmt(env, ctx, "settlement_voided", "settlement", s.settlement_no, { received: sar(s.received_halalas), orders: s.orders_count }, { reason })
  ]);
  return settlementDetail(env, ctx, s.id);
}
