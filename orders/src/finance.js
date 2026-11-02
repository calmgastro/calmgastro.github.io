/* Operating expenses, purchase spending and profitability (finance.view / expenses.* only; never exposed to customers).

   Profit (accrual):
   Revenue  = total of orders whose CURRENT status is Delivered, dated by when they became Delivered (COD: cash collected
              on delivery). Cancelled / failed / still-open orders are not revenue.
   COGS     = FIFO cost stored on those orders' reservations when they were delivered (kept in step with purchase edits).
   Expenses = non-voided expenses dated in the period (delivery, advertising, other).
   Stock losses = cost of units taken out by negative adjustments, plus write-offs, in the period.
   Net profit = Revenue − COGS − Expenses − Stock losses.

   Spending (cash out, a separate view — never subtracted from profit, which already carries purchases through COGS):
   Operating expenses      = the same non-voided expenses as above.
   Inventory purchases     = non-voided purchase batches (opening balance + purchases) received in the period, valued at
                             quantity × unit cost. Batches without a cost are counted and flagged, never guessed.
   Total spending          = operating expenses + inventory purchases.

   Every figure is read from the source rows (expenses, inventory_batches, reservations) at request time; nothing is cached.
   All money is computed in halalas and returned in SAR (2 decimals). */
import { HttpError, normalizeOrderNumber } from "./orders.js";
import { auditStmt } from "./auth.js";
import { DEFAULT_PRODUCT, toHalalas, addDays, periodOf, validDay } from "./inventory.js";
import { sar, remainingValue } from "./stock_admin.js";

export { periodOf };
const need = (ctx, perm) => { if (!ctx.perms.has(perm)) throw new HttpError(403, { error: "forbidden", permission: perm }); };
const needAny = (ctx, ...perms) => { if (!perms.some(p => ctx.perms.has(p))) throw new HttpError(403, { error: "forbidden" }); };
const now = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const like = q => "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%";
export const PLATFORMS = ["META", "GOOGLE", "TIKTOK", "SNAPCHAT", "OTHER"];
const MAX_EXPENSE = 100000000;                    // 1,000,000 SAR per entry
const isoAt = day => new Date(Date.parse(day + "T00:00:00+03:00")).toISOString();

export async function financeSummary(env, ctx, params) {
  need(ctx, "finance.view");
  const db = env.DB, p = periodOf(params), source = ["WEBSITE", "ADMIN"].includes(params.get("source")) ? params.get("source") : null;
  const fromIso = isoAt(p.from), toIso = isoAt(p.to);
  const src = source ? " AND o.source = ?" : "", sb = source ? [source] : [];
  const [sales, created, exp, losses, batches, purchases, cats] = await Promise.all([
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
    // losses from the consumption rows themselves (their cost follows purchase edits); write-offs from the ledger
    source ? Promise.resolve({ cost: 0, missing: 0 }) :
      db.prepare(`SELECT
          (SELECT COALESCE(SUM(cost_halalas), 0) FROM inventory_consumptions WHERE adjustment_id IS NOT NULL AND created_at >= ?1 AND created_at < ?2)
        + (SELECT COALESCE(SUM(cost_halalas), 0) FROM inventory_transactions WHERE type = 'WRITE_OFF' AND created_at >= ?1 AND created_at < ?2) cost,
          (SELECT COUNT(*) FROM inventory_consumptions WHERE adjustment_id IS NOT NULL AND cost_halalas IS NULL AND created_at >= ?1 AND created_at < ?2)
        + (SELECT COUNT(*) FROM inventory_transactions WHERE type = 'WRITE_OFF' AND cost_halalas IS NULL AND created_at >= ?1 AND created_at < ?2) missing`).bind(fromIso, toIso).first(),
    db.prepare("SELECT * FROM inventory_batches WHERE product_id = ? AND quantity_remaining > 0").bind(DEFAULT_PRODUCT).all(),
    // purchases are not tied to an order source: shown only for «all sources»
    source ? Promise.resolve({ results: [] }) :
      db.prepare(`SELECT source, COUNT(*) n, COALESCE(SUM(quantity_received), 0) units, COALESCE(SUM(total_cost_halalas), 0) value, SUM(total_cost_halalas IS NULL) missing
        FROM inventory_batches WHERE voided_at IS NULL AND source IN ('OPENING','PURCHASE') AND substr(received_at, 1, 10) >= ? AND substr(received_at, 1, 10) < ?
        GROUP BY source`).bind(p.from, p.to).all(),
    db.prepare("SELECT id, name_ar FROM expense_categories ORDER BY sort").all()
  ]);
  const byCat = Object.fromEntries(exp.results.map(r => [r.category_id, r.amount]));
  const nByCat = Object.fromEntries(exp.results.map(r => [r.category_id, r.n]));
  const delivery = byCat.DELIVERY || 0, ads = byCat.ADVERTISING || 0, other = Object.entries(byCat).filter(([k]) => !["DELIVERY", "ADVERTISING"].includes(k)).reduce((s, [, v]) => s + v, 0);
  const revenue = sales.revenue * 100, cogs = sales.cogs, gross = revenue - cogs, opex = delivery + ads + other, loss = losses.cost || 0;
  const values = batches.results.map(remainingValue);
  const pur = Object.fromEntries(purchases.results.map(r => [r.source, r]));
  const z = { n: 0, units: 0, value: 0, missing: 0 }, op = pur.OPENING || z, pu = pur.PURCHASE || z, purchaseValue = op.value + pu.value;
  return {
    period: { range: p.range, from: p.from, to: addDays(p.to, -1) }, source: source || "ALL",
    sales: { orders: created.total || 0, successful: created.delivered || 0, cancelled: created.cancelled || 0, failed: created.failed || 0, pending: created.pending || 0,
      deliveredInPeriod: sales.n || 0, bySource: { WEBSITE: { orders: sales.n_web || 0, revenue: sales.rev_web || 0 }, ADMIN: { orders: sales.n_admin || 0, revenue: sales.rev_admin || 0 } } },
    financial: { grossRevenue: sar(revenue), cogs: sar(cogs), grossProfit: sar(gross), deliveryExpenses: sar(delivery), advertisingExpenses: sar(ads),
      otherExpenses: sar(other), operatingExpenses: sar(opex), stockLosses: sar(loss), netProfit: sar(gross - opex - loss),
      cogsMissingOrders: sales.cogs_missing || 0, stockLossesCostMissing: losses.missing || 0,
      expensesNote: source ? "general_expenses_excluded" : null },
    spending: {
      operatingExpenses: sar(opex), operatingCount: exp.results.reduce((a, r) => a + r.n, 0),
      byCategory: cats.results.filter(c => nByCat[c.id]).map(c => ({ id: c.id, name: c.name_ar, amount: sar(byCat[c.id] || 0), count: nByCat[c.id] })),
      inventoryPurchases: source ? null : sar(purchaseValue),
      purchases: source ? null : { count: op.n + pu.n, units: op.units + pu.units, missingCost: (op.missing || 0) + (pu.missing || 0),
        opening: { count: op.n, units: op.units, value: sar(op.value) }, purchased: { count: pu.n, units: pu.units, value: sar(pu.value) } },
      totalSpending: sar(opex + (source ? 0 : purchaseValue)),
      note: source ? "purchases_excluded_with_source" : null
    },
    product: { unitsSold: sales.units || 0, averageSellingPrice: sales.units ? sar(revenue / sales.units) : null,
      averageUnitCost: sales.units && !sales.cogs_missing ? sar(cogs / sales.units) : null,
      inventoryValue: sar(values.reduce((a, v) => a + (v || 0), 0)), inventoryValueComplete: values.every(v => v != null) }
  };
}

/* ---------- expenses ---------- */
const EXPENSE_STATUS = { active: "e.voided_at IS NULL", voided: "e.voided_at IS NOT NULL", all: "1" };
const expensePerms = ctx => ({ canCreate: ctx.perms.has("expenses.create"), canEdit: ctx.perms.has("expenses.edit"), canVoid: ctx.perms.has("expenses.void") });

export async function expenseList(env, ctx, params) {
  needAny(ctx, "finance.view", "expenses.create", "expenses.edit", "expenses.void");
  const db = env.DB, where = [], binds = [], page = Math.max(1, parseInt(params.get("page"), 10) || 1), per = 50;
  if (params.get("range")) { const p = periodOf(params); where.push("e.expense_date >= ? AND e.expense_date < ?"); binds.push(p.from, p.to); }
  const cat = params.get("category");
  if (/^[A-Z_]{2,20}$/.test(cat || "")) { where.push("e.category_id = ?"); binds.push(cat); }
  // status: active (default) | voided | all; the older ?voided=1 meant «include voided»
  const status = EXPENSE_STATUS[params.get("status")] ? params.get("status") : params.get("voided") === "1" ? "all" : "active";
  where.push(EXPENSE_STATUS[status]);
  const min = params.get("min") ? toHalalas(params.get("min")) : null, max = params.get("max") ? toHalalas(params.get("max")) : null;
  if (min === undefined || max === undefined || (min != null && max != null && min > max)) throw new HttpError(422, { error: "validation", fields: { amountRange: "invalid" } });
  if (min != null) { where.push("e.amount_halalas >= ?"); binds.push(min); }
  if (max != null) { where.push("e.amount_halalas <= ?"); binds.push(max); }
  const q = clean(params.get("q"), 60);
  if (q) { where.push("(e.description LIKE ? ESCAPE '\\' OR e.reference LIKE ? ESCAPE '\\' OR e.notes LIKE ? ESCAPE '\\' OR e.campaign LIKE ? ESCAPE '\\' OR e.payment_method LIKE ? ESCAPE '\\')"); binds.push(...Array(5).fill(like(q))); }
  const w = "WHERE " + where.join(" AND ");
  const [rows, count, cats] = await Promise.all([
    db.prepare(`SELECT e.*, o.order_number, c.name_ar FROM expenses e LEFT JOIN orders o ON o.id = e.order_id JOIN expense_categories c ON c.id = e.category_id
      ${w} ORDER BY e.expense_date DESC, e.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...binds).all(),
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN e.voided_at IS NULL THEN e.amount_halalas END), 0) total, COALESCE(SUM(e.voided_at IS NOT NULL), 0) voided FROM expenses e ${w}`).bind(...binds).first(),
    db.prepare("SELECT id, name_ar, name_en FROM expense_categories WHERE is_active = 1 ORDER BY sort").all()
  ]);
  const perms = expensePerms(ctx);
  return {
    expenses: rows.results.map(e => ({ id: e.id, category: e.category_id, categoryName: e.name_ar, amount: sar(e.amount_halalas), date: e.expense_date, description: e.description,
      orderNumber: e.order_number, platform: e.platform, campaign: e.campaign, reference: e.reference, paymentMethod: e.payment_method, notes: e.notes,
      createdBy: e.created_by, createdAt: e.created_at, updatedBy: e.updated_by, updatedAt: e.updated_at, version: e.version,
      voided: !!e.voided_at, voidedAt: e.voided_at, voidedBy: e.voided_by, voidReason: e.void_reason })),
    // sum = the non-voided rows matching the filter (a voided row is listed but never counted)
    total: count.n, sum: sar(count.total), voidedCount: count.voided, status, page, per,
    categories: cats.results.map(c => ({ id: c.id, name: c.name_ar, nameEn: c.name_en })), platforms: PLATFORMS,
    ...perms, canManage: perms.canCreate || perms.canEdit || perms.canVoid
  };
}

/* One validation for create and edit. `current` is the row being edited (its category may since have been deactivated). */
async function readExpense(db, body, current = null) {
  const errors = {};
  const cat = String(body.category || ""), amount = toHalalas(body.amount), date = String(body.date || ""), description = clean(body.description, 200);
  if (!(await db.prepare("SELECT 1 FROM expense_categories WHERE id = ? AND (is_active = 1 OR id = ?)").bind(cat, current ? current.category_id : "").first())) errors.category = "invalid";
  if (amount === undefined || amount <= 0) errors.amount = "invalid";
  else if (amount > MAX_EXPENSE) errors.amount = "too_large";
  if (!validDay(date)) errors.date = "invalid";
  if (description.length < 2) errors.description = "required";
  const platform = body.platform ? String(body.platform) : "";
  if (platform && !PLATFORMS.includes(platform)) errors.platform = "invalid";
  let orderId = null, orderNumber = null;
  if (body.orderNumber) {
    const n = normalizeOrderNumber(body.orderNumber), o = n && await db.prepare("SELECT id, order_number FROM orders WHERE order_number = ?").bind(n).first();
    if (!o) errors.orderNumber = "not_found"; else { orderId = o.id; orderNumber = o.order_number; }
  }
  if (Object.keys(errors).length) throw new HttpError(422, { error: "validation", fields: errors });
  return { orderNumber, row: { category_id: cat, amount_halalas: amount, expense_date: date, description, order_id: orderId, platform,
    campaign: clean(body.campaign, 120), reference: clean(body.reference, 120), payment_method: clean(body.paymentMethod, 60), notes: clean(body.notes, 500) } };
}
// column → name used in the audit log (amounts in SAR so the log reads naturally)
const EXPENSE_FIELDS = { category_id: "category", amount_halalas: "amount", expense_date: "date", description: "description", order_id: "orderNumber",
  platform: "platform", campaign: "campaign", reference: "reference", payment_method: "paymentMethod", notes: "notes" };

export async function createExpense(env, ctx, body) {
  need(ctx, "expenses.create");
  const db = env.DB, { row, orderNumber } = await readExpense(db, body || {}), t = now();
  const res = await db.batch([
    db.prepare(`INSERT INTO expenses (category_id, amount_halalas, expense_date, description, order_id, platform, campaign, reference, payment_method, notes, created_by, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(row.category_id, row.amount_halalas, row.expense_date, row.description, row.order_id, row.platform,
        row.campaign, row.reference, row.payment_method, row.notes, ctx.user.username, ctx.user.id, t),
    auditStmt(env, ctx, "expense_created", "expense", null, null, { category: row.category_id, amount: sar(row.amount_halalas), date: row.expense_date, description: row.description,
      orderNumber: orderNumber || undefined, platform: row.platform || undefined })
  ]);
  return { ok: true, id: res[0].meta.last_row_id };
}

/* Edit: optimistic locking on `version` (two admins editing the same row cannot overwrite each other silently); only the
   fields that changed are written to the audit log, old and new, so the original values are never lost. */
export async function editExpense(env, ctx, id, body) {
  need(ctx, "expenses.edit");
  const db = env.DB;
  const e = await db.prepare("SELECT e.*, o.order_number FROM expenses e LEFT JOIN orders o ON o.id = e.order_id WHERE e.id = ?").bind(Number(id)).first();
  if (!e) throw new HttpError(404, { error: "not_found" });
  if (e.voided_at) throw new HttpError(409, { error: "expense_voided" });
  if (Number(body && body.version) !== e.version) throw new HttpError(409, { error: "record_changed", version: e.version });
  const { row, orderNumber } = await readExpense(db, body, e);
  const show = (k, v, num) => k === "amount_halalas" ? sar(v) : k === "order_id" ? (num || null) : v;
  const changed = Object.keys(EXPENSE_FIELDS).filter(k => (row[k] ?? null) !== (e[k] ?? null));
  if (!changed.length) return { ok: true, changed: false, version: e.version };
  const oldV = Object.fromEntries(changed.map(k => [EXPENSE_FIELDS[k], show(k, e[k], e.order_number)]));
  const newV = Object.fromEntries(changed.map(k => [EXPENSE_FIELDS[k], show(k, row[k], orderNumber)]));
  const t = now(), v = e.version + 1;
  const res = await db.batch([
    db.prepare(`UPDATE expenses SET category_id = ?, amount_halalas = ?, expense_date = ?, description = ?, order_id = ?, platform = ?, campaign = ?, reference = ?,
        payment_method = ?, notes = ?, updated_at = ?, updated_by = ?, updated_by_user_id = ?, version = ? WHERE id = ? AND version = ? AND voided_at IS NULL`)
      .bind(row.category_id, row.amount_halalas, row.expense_date, row.description, row.order_id, row.platform, row.campaign, row.reference, row.payment_method, row.notes,
        t, ctx.user.username, ctx.user.id, v, e.id, e.version),
    auditStmt(env, ctx, "expense_edited", "expense", e.id, { ...oldV, version: e.version }, { ...newV, version: v },
      { sql: "EXISTS (SELECT 1 FROM expenses WHERE id = ?11 AND version = ?12 AND updated_at = ?13)", binds: [e.id, v, t] })
  ]);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "record_changed" });
  return { ok: true, changed: true, version: v, fields: changed.map(k => EXPENSE_FIELDS[k]) };
}

// Expenses are never deleted: a wrong entry is voided with a reason and stays visible in the list (status voided / all) and the audit log.
export async function voidExpense(env, ctx, id, body) {
  need(ctx, "expenses.void");
  const reason = clean(body && body.reason, 200);
  if (reason.length < 3) throw new HttpError(422, { error: "validation", fields: { reason: "required" } });
  const e = await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(Number(id)).first();
  if (!e) throw new HttpError(404, { error: "not_found" });
  if (e.voided_at) throw new HttpError(409, { error: "already_voided" });
  if (body.version != null && Number(body.version) !== e.version) throw new HttpError(409, { error: "record_changed", version: e.version });
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE expenses SET voided_at = ?, voided_by = ?, voided_by_user_id = ?, void_reason = ?, version = version + 1 WHERE id = ? AND version = ? AND voided_at IS NULL")
      .bind(t, ctx.user.username, ctx.user.id, reason, e.id, e.version),
    auditStmt(env, ctx, "expense_voided", "expense", e.id, { amount: sar(e.amount_halalas), category: e.category_id, date: e.expense_date, description: e.description }, { reason },
      { sql: "EXISTS (SELECT 1 FROM expenses WHERE id = ?11 AND voided_at = ?12)", binds: [e.id, t] })
  ]);
  if (!res[0].meta.changes) throw new HttpError(409, { error: "record_changed" });
  return { ok: true };
}
