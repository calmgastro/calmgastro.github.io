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
  `src/statuses.js` lifecycle · `src/auth.js` login, sessions, 2FA · `src/admin.js` admin API · `public/admin/` admin UI

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
| Deletion | orders are never deleted. Super Admin can archive finished orders or erase personal data for a privacy request (amounts and history stay). |

## API

Public (CORS: vitamik.com only; 10 orders/min/IP, 30 lookups/min/IP):

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/orders` | `{ idempotencyKey, items:[{id,qty}], customer:{…}, location?, paymentMethod:"cod", lang, expectedTotal }` | `201 { order, token }` / `200` replay |
| POST | `/api/orders/view` | `{ orderNumber, token }` | `{ order }` (secure link) |
| POST | `/api/orders/track` | `{ orderNumber, phone }` | `{ order }` |

Admin (`/admin/api/*`, session cookie; POST needs `X-CG-Admin: 1`):
`GET /setup` · `POST /setup` · `POST /login` · `POST /login/2fa` · `POST /logout` · `GET /me` · `POST /me/password` ·
`POST /me/2fa/start|enable|disable` · `GET /dashboard` · `GET /reports?days=7|30|90` ·
`GET /orders?q=&status=&payment=&range=today|yesterday|7d|30d&from=&to=&archived=&phone=&page=&per=25|50|100` ·
`GET /orders/matching?<same filters>` (select-all, max 500) · `GET /orders/export.csv?<same filters>` ·
`POST /orders/bulk-status { numbers, status, note, visibility, override, expectedCount }` ·
`GET /orders/{n}` · `POST /orders/{n}/status|customer|items|notes|archive|revoke-link|anonymize` ·
`GET /customers` · `GET /products` · `GET /audit` · `GET /users` · `POST /users` · `POST /users/{id}` · `GET /backup`.

## Database (migrations `0001`, `0002`)

`orders` (unique `order_number`, unique `idempotency_key`, CHECKs on status/payment/totals, `token_version`,
`archived_at`, `anonymized_at`; indexes on created/updated/status/phone) · `order_items` (name/price snapshots,
`price_overridden`, CHECK line = price × qty) · `order_status_history` (previous/new, changed_by, user_id, note,
visibility, bulk_id, IP, user agent; append-only) · `order_notes` (internal) · `notification_outbox` (queued
customer messages; sender to be connected later) · `order_counters` (atomic yearly sequence) · `users`, `roles`,
`permissions`, `role_permissions`, `sessions`, `login_throttle`, `audit_logs` (append-only) · `catalog_cache`.
Migration 0002 rebuilt the order tables to the new status enum, keeping every existing row
(`pending` → `RECEIVED`, `problem` → `ON_HOLD`), children-first so no cascade can delete data.

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
npx wrangler d1 migrations apply calmgastro-orders --remote
npx wrangler deploy
npx wrangler secret put PASSWORD_PEPPER    # random, 32+ chars (set once; changing it invalidates all admin passwords)
npx wrangler secret put TOKEN_SECRET       # random, 32+ chars (changing it invalidates customers' secure links)
npx wrangler secret put ADMIN_PASSWORD     # setup key for the first Super Admin only
```

## Not included (needs a decision or a provider)

SMS / WhatsApp / email sending (messages are queued in `notification_outbox`), OTP order recovery, online
payments, customer accounts. The schema and APIs leave room for each.
