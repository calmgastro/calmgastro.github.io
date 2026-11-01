/* Operating expenses and profitability (finance.view / expenses.manage only; never exposed to customers).

   Revenue  = total of orders whose CURRENT status is Delivered, dated by when they became Delivered (COD: cash collected
              on delivery). Cancelled / failed / still-open orders are not revenue.
   COGS     = FIFO cost stored on those orders' reservations when they were delivered.
   Expenses = non-voided expenses dated in the period (delivery, advertising, other).
   Stock losses = cost of negative adjustments and write-offs in the period.
   Net profit = Revenue − COGS − Expenses − Stock losses.
   All money is computed in halalas and returned in SAR (2 decimals). */
import { HttpError, normalizeOrderNumber } from "./orders.js";
import { auditStmt } from "./auth.js";
import { DEFAULT_PRODUCT, toHalalas, riyadhDay, addDays } from "./inventory.js";
import { sar, remainingValue } from "./stock_admin.js";

const need = (ctx, perm) => { if (!ctx.perms.has(perm)) throw new HttpError(403, { error: "forbidden", permission: perm }); };
const needAny = (ctx, ...perms) => { if (!perms.some(p => ctx.perms.has(p))) throw new HttpError(403, { error: "forbidden" }); };
const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
export const PLATFORMS = ["META", "GOOGLE", "TIKTOK", "SNAPCHAT", "OTHER"];

/* Riyadh calendar periods → [fromDay, toDay) as YYYY-MM-DD; the week starts on Sunday (Saudi working week). */
export function periodOf(params) {
  const today = riyadhDay(now()), range = params.get("range") || "month";
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
const isoAt = day => new Date(Date.parse(day + "T00:00:00+03:00")).toISOString();

export async function financeSummary(env, ctx, params) {
  need(ctx, "finance.view");
  const db = env.DB, p = periodOf(params), source = ["WEBSITE", "ADMIN"].includes(params.get("source")) ? params.get("source") : null;
  const fromIso = isoAt(p.from), toIso = isoAt(p.to);
  const src = source ? " AND o.source = ?" : "", sb = source ? [source] : [];
  const [sales, created, exp, losses, batches] = await Promise.all([
    db.prepare(`WITH d AS (SELECT order_id, MAX(created_at) at FROM order_status_history WHERE new_status = 'DELIVERED' GROUP BY order_id)
      SELECT COUNT(*) n, COALESCE(SUM(o.total_amount), 0) revenue, COALESCE(SUM(o.boxes), 0) units,
        COALESCE(SUM((SELECT SUM(cogs_halalas) FROM inventory_reservations r WHERE r.order_id = o.id AND r.status = 'COMMITTED')), 0) cogs,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.order_id = o.id AND r.status = 'COMMITTED' AND r.cogs_complete = 1) THEN 1 ELSE 0 END) cogs_missing,
        COALESCE(SUM(CASE WHEN o.source = 'WEBSITE' THEN o.total_amount END), 0) rev_web, COALESCE(SUM(CASE WHEN o.source = 'ADMIN' THEN o.total_amount END), 0) rev_admin,
        SUM(o.source = 'WEBSITE') n_web, SUM(o.source = 'ADMIN') n_admin
      FROM orders o JOIN d ON d.order_id = o.id WHERE o.status = 'DELIVERED' AND d.at >= ? AND d.at < ?${src}`).bind(fromIso, toIso, ...sb).first(),
    db.prepare(`SELECT COUNT(*) total, SUM(status = 'DELIVERED') delivered, SUM(status = 'CANCELLED') cancelled, SUM(status = 'FAILED') failed,
        SUM(status IN ('RECEIVED','CONFIRMED','PREPARING','SHIPPED','OUT_FOR_DELIVERY','ON_HOLD')) pending
      FROM orders o WHERE created_at >= ? AND created_at < ?${src}`).bind(fromIso, toIso, ...sb).first(),
    // general expenses cannot be split by order source: with a source filter only order-linked expenses of that source count
    db.prepare(`SELECT e.category_id, COALESCE(SUM(e.amount_halalas), 0) amount, COUNT(*) n FROM expenses e
      WHERE e.voided_at IS NULL AND e.expense_date >= ? AND e.expense_date < ?${source ? " AND e.order_id IN (SELECT id FROM orders WHERE source = ?)" : ""}
      GROUP BY e.category_id`).bind(p.from, p.to, ...sb).all(),
    source ? Promise.resolve({ cost: 0, missing: 0 }) :
      db.prepare(`SELECT COALESCE(SUM(cost_halalas), 0) cost, SUM(cost_halalas IS NULL) missing FROM inventory_transactions
        WHERE created_at >= ? AND created_at < ? AND (type = 'WRITE_OFF' OR (type = 'ADJUSTMENT' AND on_hand_after < on_hand_before))`).bind(fromIso, toIso).first(),
    db.prepare("SELECT * FROM inventory_batches WHERE product_id = ? AND quantity_remaining > 0").bind(DEFAULT_PRODUCT).all()
  ]);
  const byCat = Object.fromEntries(exp.results.map(r => [r.category_id, r.amount]));
  const delivery = byCat.DELIVERY || 0, ads = byCat.ADVERTISING || 0, other = Object.entries(byCat).filter(([k]) => !["DELIVERY", "ADVERTISING"].includes(k)).reduce((s, [, v]) => s + v, 0);
  const revenue = sales.revenue * 100, cogs = sales.cogs, gross = revenue - cogs, opex = delivery + ads + other, loss = losses.cost || 0;
  const values = batches.results.map(remainingValue);
  return {
    period: { range: p.range, from: p.from, to: addDays(p.to, -1) }, source: source || "ALL",
    sales: { orders: created.total || 0, successful: created.delivered || 0, cancelled: created.cancelled || 0, failed: created.failed || 0, pending: created.pending || 0,
      deliveredInPeriod: sales.n || 0, bySource: { WEBSITE: { orders: sales.n_web || 0, revenue: sales.rev_web || 0 }, ADMIN: { orders: sales.n_admin || 0, revenue: sales.rev_admin || 0 } } },
    financial: { grossRevenue: sar(revenue), cogs: sar(cogs), grossProfit: sar(gross), deliveryExpenses: sar(delivery), advertisingExpenses: sar(ads),
      otherExpenses: sar(other), operatingExpenses: sar(opex), stockLosses: sar(loss), netProfit: sar(gross - opex - loss),
      cogsMissingOrders: sales.cogs_missing || 0, stockLossesCostMissing: losses.missing || 0,
      expensesNote: source ? "general_expenses_excluded" : null },
    product: { unitsSold: sales.units || 0, averageSellingPrice: sales.units ? sar(revenue / sales.units) : null,
      averageUnitCost: sales.units && !sales.cogs_missing ? sar(cogs / sales.units) : null,
      inventoryValue: sar(values.reduce((a, v) => a + (v || 0), 0)), inventoryValueComplete: values.every(v => v != null) }
  };
}

/* ---------- expenses ---------- */
export async function expenseList(env, ctx, params) {
  needAny(ctx, "finance.view", "expenses.manage");
  const db = env.DB, where = [], binds = [], page = Math.max(1, parseInt(params.get("page"), 10) || 1), per = 50;
  if (params.get("range")) { const p = periodOf(params); where.push("e.expense_date >= ? AND e.expense_date < ?"); binds.push(p.from, p.to); }
  const cat = params.get("category");
  if (/^[A-Z_]{2,20}$/.test(cat || "")) { where.push("e.category_id = ?"); binds.push(cat); }
  if (params.get("voided") !== "1") where.push("e.voided_at IS NULL");
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const [rows, count, cats] = await Promise.all([
    db.prepare(`SELECT e.*, o.order_number, c.name_ar FROM expenses e LEFT JOIN orders o ON o.id = e.order_id JOIN expense_categories c ON c.id = e.category_id
      ${w} ORDER BY e.expense_date DESC, e.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount_halalas), 0) total FROM expenses e ${w}`).bind(...binds).first(),
    db.prepare("SELECT id, name_ar, name_en FROM expense_categories WHERE is_active = 1 ORDER BY sort").all()
  ]);
  return {
    expenses: rows.results.map(e => ({ id: e.id, category: e.category_id, categoryName: e.name_ar, amount: sar(e.amount_halalas), date: e.expense_date, description: e.description,
      orderNumber: e.order_number, platform: e.platform, campaign: e.campaign, reference: e.reference, paymentMethod: e.payment_method, notes: e.notes,
      createdBy: e.created_by, createdAt: e.created_at, voided: !!e.voided_at, voidedBy: e.voided_by, voidReason: e.void_reason })),
    total: count.n, sum: sar(count.total), page, per, categories: cats.results.map(c => ({ id: c.id, name: c.name_ar, nameEn: c.name_en })), platforms: PLATFORMS,
    canManage: ctx.perms.has("expenses.manage")
  };
}

export async function createExpense(env, ctx, body) {
  need(ctx, "expenses.manage");
  const db = env.DB, errors = {};
  const cat = String(body.category || ""), amount = toHalalas(body.amount), date = String(body.date || ""), description = clean(body.description, 200);
  if (!(await db.prepare("SELECT 1 FROM expense_categories WHERE id = ? AND is_active = 1").bind(cat).first())) errors.category = "invalid";
  if (amount === undefined || amount <= 0) errors.amount = "invalid";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = "invalid";
  if (description.length < 2) errors.description = "required";
  const platform = body.platform ? String(body.platform) : "";
  if (platform && !PLATFORMS.includes(platform)) errors.platform = "invalid";
  let orderId = null;
  if (body.orderNumber) {
    const n = normalizeOrderNumber(body.orderNumber), o = n && await db.prepare("SELECT id FROM orders WHERE order_number = ?").bind(n).first();
    if (!o) errors.orderNumber = "not_found"; else orderId = o.id;
  }
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  const t = now(), f = { campaign: clean(body.campaign, 120), reference: clean(body.reference, 120), paymentMethod: clean(body.paymentMethod, 60), notes: clean(body.notes, 500) };
  await db.batch([
    db.prepare(`INSERT INTO expenses (category_id, amount_halalas, expense_date, description, order_id, platform, campaign, reference, payment_method, notes, created_by, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(cat, amount, date, description, orderId, platform, f.campaign, f.reference, f.paymentMethod, f.notes, ctx.user.username, ctx.user.id, t),
    auditStmt(env, ctx, "expense_created", "expense", null, null, { category: cat, amountHalalas: amount, date, description, orderNumber: body.orderNumber || undefined, platform: platform || undefined })
  ]);
  return { ok: true };
}

// Expenses are never deleted: a wrong entry is voided with a reason and stays visible in the list (with ?voided=1) and the audit log.
export async function voidExpense(env, ctx, id, body) {
  need(ctx, "expenses.manage");
  const reason = clean(body && body.reason, 200);
  if (reason.length < 3) throw new HttpError(422, { error: "validation", fields: { reason: "required" } });
  const e = await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(Number(id)).first();
  if (!e) throw new HttpError(404, { error: "not_found" });
  if (e.voided_at) throw new HttpError(409, { error: "already_voided" });
  await env.DB.batch([
    env.DB.prepare("UPDATE expenses SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL").bind(now(), ctx.user.username, reason, e.id),
    auditStmt(env, ctx, "expense_voided", "expense", e.id, { amountHalalas: e.amount_halalas, category: e.category_id, date: e.expense_date }, { reason })
  ]);
  return { ok: true };
}
