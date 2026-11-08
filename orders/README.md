# CalmGastro orders: API, database and admin system

The website (GitHub Pages, static) is the shop front. This Cloudflare Worker + D1 database is the
**system of record**: every order is created here before the customer sees a confirmation, gets a
number like `CG-2026-000123`, and is managed from the admin panel. WhatsApp is only a support channel.

- API + admin: `https://api.vitamik.com` — admin at `/admin` (also `https://vitamik.com/admin/`). The original
  `https://calmgastro-orders.calmgastro.workers.dev` stays on as a fallback: some Wi-Fi filters, ad blockers and VPNs block
  `*.workers.dev`, so the site tries `api.vitamik.com` first and, only if the request gets no response at all, repeats it on
  workers.dev with the same idempotency key (one order, never two). Custom domain declared in `wrangler.toml`; DNS zone on Cloudflare.
- Database: D1 `calmgastro-orders` (free plan); schema in `migrations/`
- Code: `src/index.js` routes · `src/orders.js` order creation + customer views · `src/catalog.js` trusted prices ·
  `src/statuses.js` lifecycle · `src/auth.js` login, sessions, 2FA · `src/admin.js` admin API · `src/cities.js` city grouping for filters/reports · `public/admin/` admin UI

## Customer flow

Offers → «إضافة للسلة» → cart → `#/checkout` (delivery → review) → «تأكيد الطلب» → `POST /api/orders` →
`#/order/CG-…` confirmation (with the secure link) → `#/track` (order number + mobile).

The browser sends product ids and quantities only. Prices come from the `product-data` block of the
live site; the server recalculates subtotal, best-price discount, shipping and total. If the total the
customer reviewed differs, nothing is created (`409 price_changed`) and the page shows the new total.

**Order recovery** (no SMS provider, by decision): (1) the secure link shown after checkout,
`https://vitamik.com/#/order/CG-…?k=<token>` — the token is after `#`, never sent to a server, and is removed
from the address bar before any analytics script runs; it can be revoked per order; (2) orders saved on the
same device are listed under «نسيت رقم الطلب؟»; (3) WhatsApp support with a generic message
(«مرحباً، أحتاج المساعدة في استرجاع رقم طلبي.») — the agent verifies identity manually.
An OTP flow can be added once an SMS provider is chosen (table and endpoints are not created yet).

## Status lifecycle (`src/statuses.js`)

| Enum | Customer label | Normal next |
|---|---|---|
| `RECEIVED` | تم استلام الطلب | CONFIRMED, CANCELLED, ON_HOLD |
| `CONFIRMED` | تم تأكيد الطلب | PREPARING, CANCELLED, ON_HOLD |
| `PREPARING` | جاري التجهيز | SHIPPED, CANCELLED, ON_HOLD |
| `SHIPPED` | تم الشحن | OUT_FOR_DELIVERY, DELIVERED, FAILED, ON_HOLD |
| `OUT_FOR_DELIVERY` | خرج للتوصيل | DELIVERED, FAILED, ON_HOLD |
| `DELIVERED` | تم التوصيل | — (final) |
| `CANCELLED` | ملغي | — (final) |
| `FAILED` | تعذّر إكمال الطلب | — (final) |
| `ON_HOLD` | معلّق — يوجد مشكلة | any open stage, CANCELLED, FAILED |

Customer submission creates `RECEIVED`; only an admin confirms. Any other move (backwards, out of a final
status) is an **override**: Super Admin only, with explicit confirmation, recorded as such. Items, quantities
and prices are locked from `SHIPPED` on; changing them requires an explicit "force" confirmation and is audited.
Exceptional statuses appear in the customer timeline only when they happen (e.g. received → confirmed → ملغي).
Each status note is either **internal** or **customer-visible** (shown in tracking and added to the queued notification).

## City filter

Customers type the city freely, so one city arrives as «الرياض», «رياض», «Riyadh», «الرياض - حي العليا»…
`src/cities.js` folds the spellings (alef forms, ة/ه, ى/ي, tashkeel, leading «ال»/"al", first word(s) of the field) and
maps ~40 Saudi cities (Arabic + English names) to one key and display name; other cities keep the customer's spelling.
Orders keep the city exactly as typed: `?city=<key>` is resolved to the spellings in the database and filtered with
`city IN (…)` (most common 80 spellings per city — D1's bound-value limit). Used by the dashboard, the orders list
(and select-all, bulk, CSV export) and the reports, which also show orders / boxes / revenue per city for the period.

## Admin access

- **First run:** `/admin/setup` creates the first Super Admin (username + password chosen there), proven with the
  `ADMIN_PASSWORD` secret. It works only while no admin exists.
- **Login:** username + password → optional TOTP code (Google/Microsoft Authenticator) → session.
- **Roles (RBAC, tables `roles`, `permissions`, `role_permissions`):**
  - *مدير عام / Super Admin* — everything, incl. admins, prices, overrides, audit log, privacy erase, backup.
  - *مدير الطلبات / Order Manager* — orders, customer and item edits, normal status changes, bulk updates, export, reports.
  - *دعم العملاء / Support Agent* — search and view orders and customers, internal notes, confirm new orders or put them on hold.
  The sidebar shows only permitted sections; every API call checks the permission on the server.
- New admins get a temporary password and must change it at first login.

### Security

| Area | Implementation |
|---|---|
| Passwords | PBKDF2-SHA256, 100,000 iterations (Cloudflare's maximum), 16-byte salt, keyed with a secret pepper (`PASSWORD_PEPPER`) — a leaked database alone cannot be cracked. Free plan has no CPU budget for Argon2id/bcrypt. Policy: ≥ 12 chars, no username, no common words. |
| Sessions | random 256-bit token in `__Host-cg_sess` (HttpOnly, Secure, SameSite=Strict); only its SHA-256 is stored (`sessions`); 30-min idle timeout, 12-h absolute; new token on every login; logout, password change, role change, disable and 2FA reset revoke sessions. |
| Brute force | Cloudflare rate limit 5/min/IP on login + per-username lockout (5 failures → 15 min) for existing *and* unknown usernames; attempts during a lockout never reset it; one generic message «بيانات الدخول غير صحيحة.»; same work for unknown users (no timing leak). |
| 2FA | TOTP (RFC 6238); secret encrypted with AES-GCM (key derived from the pepper); a code cannot be reused. |
| CSRF | SameSite=Strict cookie + required `X-CG-Admin` header + same-origin check on every POST. |
| Input / output | bound SQL parameters only; LIKE wildcards escaped; control/bidi characters stripped; admin UI renders with `textContent`; strict CSP (`script-src 'self'`, no inline script, no third-party resources), `frame-ancestors 'none'`, `noindex`. CSV export neutralises spreadsheet formulas. |
| Customer access | tracking needs order number **and** the order's mobile; secure link uses an HMAC token (revocable via `token_version`); unknown order, wrong phone and wrong token give the same `404`; internal ids, internal notes and admin names never reach customers. |
| Audit | `audit_logs` and `order_status_history` are append-only (database triggers block UPDATE/DELETE). Logged: logins (ok/failed/locked), logout, setup, password/2FA changes, admin create/update, customer field changes (before → after), item add/remove/quantity/price (with reason), totals recalculation, status changes (incl. overrides), bulk updates, cancellation, notes, archive, link revocation, privacy erase, export, backup — with IP and user agent. |
| Deletion | only a cancelled or failed order can be deleted (Super Admin, `orders.delete`, see «Deleting cancelled orders»). Other orders are archived, or their personal data erased for a privacy request (amounts and history stay). |

## API

Public (CORS: vitamik.com only; 10 orders/min/IP, 30 lookups/min/IP):

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/orders` | `{ idempotencyKey, items:[{id,qty}], customer:{…}, location?, paymentMethod:"cod", lang, expectedTotal }` | `201 { order, token }` / `200` replay |
| POST | `/api/orders/view` | `{ orderNumber, token }` | `{ order }` (secure link) |
| POST | `/api/orders/track` | `{ orderNumber, phone }` | `{ order }` |

Admin (`/admin/api/*`, session cookie; POST needs `X-CG-Admin: 1`):
`GET /setup` · `POST /setup` · `POST /login` · `POST /login/2fa` · `POST /logout` · `GET /me` · `POST /me/password` ·
`POST /me/2fa/start|enable|disable` · `GET /cities` · `GET /dashboard?city=` · `GET /reports?days=7|30|90&city=` ·
`GET /orders?q=&status=&payment=&city=&range=today|yesterday|7d|30d&from=&to=&archived=&phone=&page=&per=25|50|100` ·
`GET /orders/matching?<same filters>` (select-all, max 500) · `GET /orders/export.csv?<same filters>` ·
`POST /orders/bulk-status { numbers, status, note, visibility, override, expectedCount }` ·
`GET /orders/{n}` · `POST /orders/{n}/status|customer|items|notes|archive|revoke-link|anonymize` ·
`GET /customers` · `GET /products` · `GET /audit` · `GET /users` · `POST /users` · `POST /users/{id}` · `GET /backup`.

## Database (migrations `0001` – `0004`)

`orders` (unique `order_number`, unique `idempotency_key`, CHECKs on status/payment/totals, `token_version`,
`archived_at`, `anonymized_at`; indexes on created/updated/status/phone) · `order_items` (name/price snapshots,
`price_overridden`, CHECK line = price × qty) · `order_status_history` (previous/new, changed_by, user_id, note,
visibility, bulk_id, IP, user agent; append-only) · `order_notes` (internal) · `notification_outbox` (queued
customer messages; sender to be connected later) · `order_counters` (atomic yearly sequence) · `users`, `roles`,
`permissions`, `role_permissions`, `sessions`, `login_throttle`, `audit_logs` (append-only) · `catalog_cache`.
Migration 0002 rebuilt the order tables to the new status enum, keeping every existing row
(`pending` → `RECEIVED`, `problem` → `ON_HOLD`), children-first so no cascade can delete data.

## Inventory, cost and profit (migration `0003`, `src/inventory.js`, `src/stock_admin.js`, `src/finance.js`)

**One stock service.** `src/inventory.js` is the only code that moves stock. Website orders and admin orders
(`orders.insertOrder`), single and bulk status changes (`admin.applyTransition`) and item edits all call it, and every
movement is written in the same D1 transaction as the order change that caused it.

**Units and states.** 1 unit = 1 box. Per product: `on_hand` (physical, not yet sold), `reserved` (held for open orders),
`sold`; available = on_hand − reserved. CHECK constraints make available < 0 impossible: such a transaction aborts.

**Status → stock** (`ORDER_STATUS_INVENTORY_RULES`): RECEIVED / CONFIRMED / PREPARING / SHIPPED / OUT_FOR_DELIVERY /
ON_HOLD → RESERVE · DELIVERED → COMMIT (FIFO consumption, COGS stored on the reservation) · CANCELLED / FAILED → RELEASE.
Overrides are handled too: Cancelled → open re-reserves, Cancelled → Delivered consumes directly if stock is available,
Delivered → Cancelled is a RETURN (restocks the same batches; or WRITE_OFF per the return policy setting).

**Stock by availability, not by order date.** An order still reserves what is free when it is created (policy
RESERVE_AVAILABLE) — internal bookkeeping only. When an order is shipped (or delivered) it takes its boxes from the
warehouse (`claimStock`, called by `applyTransition` before SHIPPED / DELIVERED): free stock first, then boxes held for
orders that have **not** shipped yet, newest first (never from an order with the carrier). The move is in the ledger both
ways (`reference = 'reallocation'`: RELEASE on the donor «نُقل إلى …», RESERVATION on the shipped order) and audited as
`stock_claimed`. No order is ever shown as «نقص مخزون»: the orders list, the order page and the shipment pages show no
per-order shortage, and there is no shortages tab. The shortage is a **total** (`stockSummary().flow`, dashboard and
Admin → المخزون): **في المستودع** = on hand − boxes with the carrier · **مطلوب لطلبات لم تُشحن** · **المتبقي بعد تجهيزها**
or **الناقص** · **لدى شركة الشحن**. Delivery is refused (`inventory_shortage`) only when the warehouse itself holds fewer
boxes than are leaving (a receipt not recorded yet).

**Cost.** Every receipt is its own batch (`inventory_batches`, never merged). The admin enters the quantity and the UNIT
cost; the server stores value = quantity × unit cost (`total_cost_halalas`, which FIFO reads) and database triggers refuse
any row where the two disagree. (An older batch recorded with an invoice total that does not divide evenly keeps no exact
unit cost until it is edited.) FIFO consumption is recorded per batch (`inventory_consumptions`). Costs and expenses are
stored in halalas. A batch entered without a cost gets it later by editing the purchase.

**Idempotency.** Status-change stock statements are guarded by the order's new (status, updated_at); order creation by
the idempotency key; receipts / adjustments by a per-form request id (`inventory_transactions.idempotency_key` UNIQUE).
FIFO plans that went stale under concurrency abort on the batch CHECK and are rebuilt (`runWithRetry`).

**Ledger.** `inventory_transactions` is append-only (triggers) with before/after on-hand, reserved and available, actor and
reference. Admin → المخزون → «فحص تطابق الأرصدة» recomputes the balance from the ledger, the batches and the reservations.

**Opening balance.** Created once from Admin → المخزون: quantity, a date before the first order, optional total cost. The
same step replays every existing order by its current status (delivered → consumed, open → reserved, cancelled/failed → no
effect), with a preview first. Until it exists the stock hooks do nothing.

**Alerts.** One `inventory_alerts` row when the level changes (LOW ≤ threshold, CRITICAL ≤ critical threshold, OUT = 0, all
on available stock) — never on page loads. Thresholds and policies live in `inventory_settings`.

**Expenses and profit.** `expenses` (DELIVERY / ADVERTISING / OTHER via `expense_categories`, optional order, platform,
campaign; voided with a reason, never deleted). Profit for a period: revenue = totals of orders currently Delivered, dated
when they became Delivered; COGS = their stored FIFO cost; minus expenses dated in the period; minus stock losses (cost of
negative adjustments and write-offs). Filter by source (WEBSITE / ADMIN): general expenses then are excluded.

**Admin orders.** Admin → الطلبات → «+ طلب جديد»: same validation, website pricing (boxes → bundles, best price), customer
record per mobile number (`customers`), reservation and history as a website order; `source = ADMIN`, `created_by`. Preview
first (totals + what is left in the warehouse); when it is not enough the order is still created normally (shipped when the
boxes arrive). Initial status RECEIVED or
CONFIRMED only. Optional manual discount (`orders.discount`, reason required) is kept when items are edited later.

**Editing purchases and expenses (migration `0004`).** No parallel tables: a purchase IS its batch (source PURCHASE, or
the OPENING balance) and an expense IS its `expenses` row. Both carry `created_by/at`, `updated_by/at`, a `version`
(optimistic lock: an edit sent with an old version gets 409 `record_changed`) and soft-delete fields (`voided_at/by`,
`void_reason`); nothing is deleted. Every edit writes `audit_logs` with the old and new value of each changed field
(`expense_edited`, `purchase_edited`, `…_voided`), in the same transaction and only if the edit applied.
· Purchase edit (`POST /inventory/purchases/{id}`): quantity, unit cost, date, supplier, reference, location, invoice
  quantity, notes. A quantity change moves stock by the difference (ledger ADJUSTMENT, reference `PURCHASE_EDIT`); it can
  never go below what was already used from the batch nor take units reserved for open orders. A cost change re-costs the
  units already used (consumptions) and the COGS of delivered orders that used them, with a `COST_UPDATE` ledger row.
  Changing a cost needs `finance.view` as well. The opening balance stays dated before the first order.
· Purchase void (`/void`, reason required): only while nothing of it was used and its units are not reserved; the stock
  leaves with a ledger row (`PURCHASE_VOID`). The opening balance cannot be voided (edit it instead).
· Expense edit (`POST /expenses/{id}`) / void (`/void`): same validation as creating (amount > 0 and ≤ 1,000,000, a real
  date not in the future, description, existing order number).
· Lists with filters: `GET /expenses?range&from&to&category&status=active|voided|all&min&max&q` and
  `GET /inventory/purchases?range&from&to&supplier&product&status&source&min&max&q`; their sums never include voided rows.

**Spending in the reports.** `GET /finance/summary` returns `spending`: operating expenses (by category), inventory
purchase value (opening + purchases received in the period, valued quantity × unit cost; purchases without a cost are
counted and flagged) and total spending = operating + purchases. Admin → التقارير → «المصاريف ومشتريات المخزون» shows the
three figures for any period. This is cash out; net profit does NOT subtract purchases again (they reach profit through
COGS when sold). Every figure is computed from the rows at request time; open report pages reload by themselves after any
add / edit / void (BroadcastChannel `cg-finance`, and on returning to the tab).

**Permissions.** `inventory.view` (stock, purchases list; no costs) · `inventory.manage` (adjustments, settings,
opening balance, allocation) · `inventory.purchase.create|edit|void` · `finance.view` (costs, COGS, stock value, profit,
spending) · `expenses.create|edit|void` · `orders.create` · `orders.discount`. All checked in the API. Super Admin: all ·
Order Manager: inventory.view, orders.create · Support Agent: orders.create. (`0004` replaced `expenses.manage` with the
three expense keys and gave the purchase keys to every role that had `inventory.manage`.)

## Shipping to the carrier (SENA) — migration `0005`, `src/shipments.js`, `src/xlsx.js`

**Export.** Admin → الطلبات: select orders (the bar reads «تم تحديد 14 طلب بـ 23 علبة») → «تصدير لشركة الشحن (سينا)» →
review page («حدّدت … طلب بـ … علبة», orders that can ship, boxes leaving the warehouse, warehouse before/after, orders
excluded and why: cancelled / failed / delivered / already shipped / on hold) → export name → «هل أنت متأكد؟».
Any order can take what is in the warehouse (see «Stock by availability»). Only when the selection needs more boxes than
the warehouse holds in the system (e.g. a receipt not recorded yet) the review shows one total warning («ستشحن N علبة أكثر
مما هو مسجّل في المستودع»), the confirmation repeats it, and the API refuses the export unless `allowShortage: true` is sent
(audited as `shortageBoxes`). Each order then moves to SHIPPED
through the normal steps (RECEIVED → CONFIRMED → PREPARING → SHIPPED, each in its history, tagged with the batch number; the
customer is notified once, at «تم الشحن»), gets a unique shipment reference, and the batch (`shipment_batches`,
`shipment_orders`, number `SENA-YYYY-NNNN`, one per click via `request_id`) is saved. The whole selection is refused if
anything changed since the review (`expectedCount` / `expectedBoxes`).

**The file** (`GET /shipments/{id}/file.xlsx`, downloadable again any time, counted and audited) is the carrier's own
template filled: `src/sena_template.js` is generated from their .xlsx by `build_sena_template.py` (all sheets, dropdown
lists, zones, hidden options sheet and instructions kept; the 2,495 per-cell copies of their 5 validation rules written as
5 ranges). The output matches, cell for cell, the merchant's approved edit of SENA-2026-0001. Columns: name · city · zone
(from their list, setting) · address (district, address, delivery note, map link) · mobile as a number without the leading 0
(5XXXXXXXX) · order number · shipment ref · amount to collect · weight (boxes × box weight, setting) · national address
(`orders.national_address`, see below) · preparation source · bags / bubbles / cartons (settings, default 1 / 0 / 0).
Items sheet: one line per order, linked by order number: item name, SKU, barcode (settings; digits-only codes are numbers with
format «0»), quantity = boxes, item price (setting, default 0; the cash to collect is the amount column), «N علبة في الوحدة», weight.
**Preparation source** (migration `0008`): «من مخزون SENA» by default, or «الشحنة مجهزة من التاجر», chosen on the review page and
kept on the batch (`prep_source`; older batches follow the setting). From SENA's stock the packaging counts and SKU / barcode are
written (their rules 8, 11; saving the settings with neither code is refused); prepared by the merchant they are left out, so nothing
is deducted (rule 12), and a pick-up address must be chosen on SENA's import page. Regenerate the module if the carrier changes the template.

**Delivery.** Admin → الشحن → a batch: select orders (or paste the numbers / shipment refs from the carrier's report) →
«تأكيد التوصيل» / «خرج للتوصيل» / «تعذّر التوصيل» with «هل أنت متأكد؟». Same status change as elsewhere: delivered
consumes the stock (FIFO) and counts as revenue; failed releases it. Only orders of that batch that are with the carrier
move. If the warehouse in the system still does not hold its boxes it is skipped with the boxes missing and stays shipped
until the receipt is recorded (Inventory → إضافة مخزون), then confirmed again.

**Editing a batch** (migration `0007`): an order taken out of a batch keeps its `shipment_orders` row with `removed_at`,
`removed_by`, `removed_reason` (CANCELLED | RETURNED) and no longer counts anywhere: batch totals, the carrier file,
delivery confirmation, «لدى شركة الشحن», `?shipment=` on the orders page. It happens (1) automatically whenever the order
is cancelled or moved back before «تم الشحن» from anywhere (same transaction as the status change), or (2) from the batch
page: select → «إزالة من الشحنة…» → «إلغاء الطلب» (duplicate / cancelled by the customer) or «إعادته للتجهيز» (ships in a
later batch, new reference `…-2`; the old one is never reused). `POST /shipments/{id}/remove { action: cancel|return,
numbers, expectedCount, note }`, permission `shipments.manage` (taking an order out of a shipment is part of managing
it, so the override permission is not needed); the customer is notified of a cancellation only; audited as
`shipment_orders_removed`. The batch page lists removed orders under «أُزيلت من الشحنة»; download the file again after an edit.
On deploy the migration marks rows of orders that were already cancelled (SENA-2026-0001: CG-2026-000036 → 14 orders, 22 boxes).

**Adding to a batch** (migration `0009`): batch page → «+ إضافة طلبات» → `/admin/shipments/{id}/add` lists orders not shipped yet
(`GET /shipments/{id}/candidates`) → `POST /shipments/{id}/add { numbers, expectedCount, expectedBoxes, allowShortage }`: same checks and steps as
an export (permission `shipments.manage`, audited `shipment_orders_added`); the batch keeps its preparation source. An order removed from this same batch
returns on its row with a new reference; references are never reused (X, X-2, X-3 …). SENA refuses a reference it has received (rule 9), so each row records
`downloaded_at` and `GET /shipments/{id}/file.xlsx?only=new` gives only rows not in a downloaded file («تنزيل الطلبات المضافة فقط»). The system does not
connect to SENA: an order removed after the file was uploaded must also be cancelled in SENA's system (the dialog says so).

**Possible duplicates** (migration `0008`): an open order with another order on the same mobile placed within 3 days of it
(`DUP_*` in `admin.js`; cancelled, failed, archived and anonymized orders do not count, a delivered one can be the other order
but is not flagged itself). Admin only, nothing is blocked and the customer sees nothing: «⚠ قد يكون مكرراً» under the order number (orders,
batch page), the chip «قد تكون مكررة» (`?dup=1`, combines with other filters, list response `duplicates`), a dashboard alert, a card on the
order page with the other orders, WhatsApp (message naming them) and «اتصال», a warning on the export review (with «استبعاد من الشحنة», and
repeated in the confirmation) and in the admin new-order preview. `POST /orders/{n}/duplicate { cleared }` (`orders.notes`, audited): «ليس مكرراً»
stops it on the order and the ones flagged with it, a later order on that mobile is flagged again; cancelling the extra order stops it too.

**National address** (migration `0006`): the Saudi short code (4 letters + 4 digits, e.g. RRRD2929) on `orders` and
`customers` (CHECK on the shape). Checkout requires it **or** the customer's map location («تحديد موقعي تلقائياً»; `requireNationalAddress` on website
orders only, 422 `nationalAddress: required`); Arabic digits, lower case and spaces accepted, stored upper case; when the
field is empty, a short code written in the address or delivery notes is used. Turning a location into a code needs the
Saudi Post (SPL) API key — not wired yet. Admins set it on the order
page, the new-order form (filled from the saved customer), or directly in the SENA review / batch rows (missing ones are
counted; the batch file is regenerated on each download). 0006 back-filled existing orders only where the address starts
with the code (the form copied from the national address service); nothing is guessed. Cleared by anonymize; in the CSV.
Editable in place («تعديل» next to it on the order page and in the SENA rows; saving it empty clears it). **Approximate code
per city** (Shipping → settings, `shipping_settings.na_fallback`): one real code per city (a public place) with the city's
spellings («جدة، جده، Jeddah»); an order without its own code gets its city's code in column J, shown as «تقريبي», and the
order itself stays empty so the customer's real code can be added later (the file is regenerated on each download).

**Orders page size**: «عدد الطلبات في الصفحة: 25 | 50 | 100» above the list (`per` + `page` in the API and the link; the server
accepts only 25/50/100, so nothing loads thousands at once; changing it returns to page 1; an out-of-range page moves to the
last one; «عرض 1–50 من 327 طلبًا»). No «all» option on purpose.

**Several statuses at once**: `status` and `inv` take a comma list (`status=RECEIVED,SHIPPED` = either one; the group names
`OPEN`, `TO_SHIP`, `WITH_CARRIER` still work and can be mixed in). On the orders page the «الحالة» and «حالة المخزون» filters
are tick-boxes (with quick groups and «مسح الاختيار»), and the status chips toggle: press one to show it, press another to add
it, press it again to remove it, «الكل» clears. List, «تحديد كل النتائج» and CSV export all follow the same filter.

**Orders table columns** can be resized by dragging the edge of a header (or ←/→ on the focused edge); widths are kept per
browser (`localStorage` `cg-cols:orders`), double-click an edge to reset. Permission `shipments.manage` (Super Admin, Order Manager) plus the normal status permissions.

## Deleting cancelled orders and test customers (migration `0010`)

Super Admin (`orders.delete`) can delete a **cancelled or failed** order for good: from its page («حذف الطلب نهائياً», type
the order number), from the orders list (select, «حذف نهائياً», type «حذف»), or a whole customer from «العملاء» («حذف»,
offered only when every order on that mobile can be deleted). A reason is optional. `POST /admin/api/orders/delete`
`{numbers, expectedCount, confirm: "حذف", reason}` → `{deleted, skipped:[{orderNumber, reason}]}`;
`POST /admin/api/customers/delete` `{phone, confirm, reason}` (409 `customer_has_kept_orders` with the list).

Kept, with the reason shown: an order that was in a shipment file downloaded for SENA (`in_shipment_file`: it stays in its
batch for reconciling with SENA), one with real stock movement — sale, return or a reservation not released (`stock_moved`),
one tied to an expense (`has_expense`). Deleted with the order: items, status history, notes, notifications, its released
reservation and its RESERVATION/RELEASE ledger rows (they add up to zero, so stock and the reconcile check do not change),
a removed shipment row that was never in a downloaded file, and the saved customer if no order is left. Order numbers are
not reused. The audit log keeps `order_deleted` (who, when, reason, status, total, boxes, date, source — no name or mobile)
and `customer_deleted` (masked mobile, the orders); earlier audit entries of the order stay.

Database guards: status history and ledger rows stay undeletable unless their order carries a `purge_token`, which only a
cancelled or failed order can carry and which the delete sets in the same transaction; an order without one cannot be
deleted; SALE/RETURN ledger rows and the audit log can never be deleted. Batches of 50 (D1's 100-parameter limit).
Tests: `e2e/orders_delete.mjs` (51), `e2e/rehearse_0010.mjs` (on a production copy).

## Backup and recovery

- D1 **Time Travel**: restore the database to any minute of the last 7 days (free plan):
  `npx wrangler d1 time-travel info calmgastro-orders` · `npx wrangler d1 time-travel restore calmgastro-orders --timestamp=<ISO time>`
- Full export: Super Admin → «حسابي والإعدادات» → «تنزيل نسخة احتياطية» (JSON, no password hashes or 2FA secrets), or
  `npx wrangler d1 export calmgastro-orders --remote --output backup.sql` (complete SQL). Recommended weekly, stored off-site.
- Secrets live only in Cloudflare (`wrangler secret`); keep a copy of `PASSWORD_PEPPER` and `TOKEN_SECRET` in a password
  manager — without the pepper, restored admin passwords must be reset.

## Deploy

```sh
npx wrangler d1 export calmgastro-orders --remote --output before-migration.sql   # always back up first
npx wrangler d1 migrations apply calmgastro-orders --remote   # BEFORE deploying code that needs the new tables/columns
npx wrangler deploy
npx wrangler secret put PASSWORD_PEPPER    # random, 32+ chars (set once; changing it invalidates all admin passwords)
npx wrangler secret put TOKEN_SECRET       # random, 32+ chars (changing it invalidates customers' secure links)
npx wrangler secret put ADMIN_PASSWORD     # setup key for the first Super Admin only
```

## Not included (needs a decision or a provider)

SMS / WhatsApp / email sending (messages are queued in `notification_outbox`), OTP order recovery, online
payments, customer accounts. The schema and APIs leave room for each.
