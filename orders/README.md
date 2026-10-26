# CalmGastro orders: API, database and admin panel

The website (GitHub Pages, static) is the shop front. This Worker is the **system of record for orders**:
it creates every order in a Cloudflare D1 database before the customer sees a confirmation, gives it a
number like `CG-2026-000123`, and lets the owner manage it from an admin panel. WhatsApp is only a
support channel; it never creates or completes an order.

- API + admin: `https://calmgastro-orders.calmgastro.workers.dev` (admin panel at `/admin`, also reachable via `https://vitamik.com/admin/`)
- Database: D1 `calmgastro-orders` (free plan), schema in `migrations/`
- Code: `src/index.js` (routes, CORS, rate limits), `src/orders.js` (validation, creation, customer views),
  `src/catalog.js` (trusted prices), `src/admin.js` (login + admin API), `src/admin-ui.js` (panel)

## Flow

Landing → «إضافة للسلة» → cart (header icon / side panel, saved in `localStorage`) → `#/checkout`
(delivery details → review) → «تأكيد الطلب» → `POST /api/orders` → order saved → `#/order/CG-…`
(confirmation) → `#/track` (order number + mobile).

The browser sends **product ids and quantities only**. The Worker reads prices from the
`product-data` block of the live site (the same single source the page uses), recalculates
subtotal, best-price discount, shipping and total, and stores them. If the total the customer
reviewed differs from the server's, nothing is created and the page shows the new total (`409 price_changed`).

Pricing rule (from `product-data`): cheapest combination of bundles (1 = 250, 2 = 450, 3 = 600);
above the largest bundle every box costs `pricing.boxPriceAfterBundles` (200 → 4 boxes = 800).
Limits: `orders.maxQtyPerLine` (10), `orders.maxBoxesPerOrder` (30). Shipping: `shipping.cost` / `shipping.freeFrom`.
Payment methods: `paymentMethods` (only `cod` today; the API rejects anything else).

## API

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/orders` | `{ idempotencyKey, items:[{id,qty}], customer:{name,phone,city,district,address,notes}, location?, paymentMethod:"cod", lang, expectedTotal }` | `201 { order, token }` (or `200` with `replay:true` for the same key) |
| POST | `/api/orders/view` | `{ orderNumber, token }` | `{ order }` with full delivery details (confirmation page) |
| POST | `/api/orders/track` | `{ orderNumber, phone }` | `{ order }` with status, timeline, items, total, city/district (no address or phone) |
| GET | `/admin/api/orders?q=&status=&from=&to=&page=` | — | list, counts per status |
| GET | `/admin/api/orders/{orderNumber}` | — | full details, history, notes, allowed next statuses |
| POST | `/admin/api/orders/{orderNumber}/status` | `{ status, note, expectedStatus }` | updated details |
| POST | `/admin/api/orders/{orderNumber}/notes` | `{ note }` | updated details |
| POST | `/admin/api/login`, `/admin/api/logout` | `{ password }` | session cookie |

Errors: `422 validation` (`fields.phone = "invalid_phone"`, `items = "empty_cart" | "qty_limit" | "max_boxes"`, …),
`409 price_changed | idempotency_conflict | out_of_stock | status_changed`, `429 rate_limited`, `500 create_failed`, `503 catalog_unavailable`.

## Database (`migrations/0001_init.sql`)

- `orders`: internal `id` (never shown to customers), unique `order_number`, unique `idempotency_key`,
  customer and delivery fields, optional coordinates, `boxes`, `subtotal`, `discount_amount`,
  `shipping_amount`, `total_amount` (CHECK total = subtotal − discount + shipping), `payment_method`
  (CHECK `cod`), `status` (CHECK one of 8 values), `lang`, timestamps. Indexes on `created_at`, `(status, created_at)`, `customer_phone`.
- `order_items`: `order_id` → orders (cascade), `product_id`, `product_name_snapshot`, `product_name_en_snapshot`,
  `boxes_per_unit`, `unit_price`, `quantity` (1–99), `line_total` (CHECK = unit_price × quantity).
- `order_status_history`: previous/new status, `changed_by` (`customer` at creation, `admin`), note, time.
- `order_notes`: internal admin notes (never sent to customers).
- `order_counters`: one row per year; incremented inside the creation transaction → sequential numbers.
- `notification_outbox`: queued customer messages (created / confirmed / shipped / out for delivery / delivered / cancelled) in the order's language. No sender is connected yet; a future WhatsApp / SMS / email integration reads `pending` rows.
- `catalog_cache`: last valid product data, used if the website is briefly unreachable.

Order creation runs as one D1 batch (transaction): counter, order, items and the first history row
are written together or not at all.

## Statuses

`pending` بانتظار التأكيد → `confirmed` تم تأكيد الطلب → `preparing` جاري تجهيز الطلب → `shipped` تم شحن الطلب →
`out_for_delivery` خرج للتوصيل → `delivered` تم التوصيل; plus `cancelled` ملغي and `problem` يوجد مشكلة في الطلب.
Allowed changes are fixed in `TRANSITIONS` (`src/orders.js`); `delivered` and `cancelled` are final.

## Security

- CORS: only `ALLOWED_ORIGINS` (vitamik.com) may call `/api/*`; 16 KB body limit; honeypot field.
- Rate limits per IP (Cloudflare bindings): 10 orders/min, 30 lookups/min, 5 admin logins/min.
- Duplicate protection: the page disables the button and reuses one `idempotencyKey` per attempt; the key is UNIQUE in the database, so double clicks, retries after a lost response and parallel requests all return the same order.
- Customer access: confirmation uses an HMAC token derived from the order number (`TOKEN_SECRET`, never stored); tracking requires order number + the same mobile number. Unknown order and wrong phone return the same `404`.
- Admin: password (`ADMIN_PASSWORD`) → signed `__Host-` cookie (HttpOnly, Secure, SameSite=Strict, 12 h); every change also needs the `X-CG-Admin` header from the same origin (CSRF). Changing the password signs everyone out. Admin page has a strict CSP, no framing, `noindex`.
- All SQL uses bound parameters; `LIKE` wildcards are escaped; text is length-limited and stripped of control/bidi characters; the admin panel renders data with `textContent` only.

## Deploy / operate

```sh
npx wrangler d1 migrations apply calmgastro-orders --remote
npx wrangler deploy
npx wrangler secret put ADMIN_PASSWORD     # change the admin password any time
npx wrangler secret put SESSION_SECRET     # random, 32+ chars
npx wrangler secret put TOKEN_SECRET       # random, 32+ chars (changing it invalidates old confirmation links; tracking still works)
npx wrangler d1 export calmgastro-orders --remote --output backup.sql   # backup
```

The page reaches the API through `CONFIG.ordersApi.endpoint` in `assets/app.js`; its origin is listed in the
CSP `connect-src` of `index.html`.
