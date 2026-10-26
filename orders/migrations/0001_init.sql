-- CalmGastro orders: initial schema (Cloudflare D1 / SQLite)
-- Money is stored as whole riyals (INTEGER). Timestamps are ISO-8601 UTC strings.

-- One row per year; incremented inside the order-creation transaction → CG-2026-000001, CG-2026-000002, ...
CREATE TABLE order_counters (
  year        INTEGER PRIMARY KEY,
  last_value  INTEGER NOT NULL CHECK (last_value >= 0)
);

CREATE TABLE orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,        -- internal only, never shown to customers
  order_number        TEXT    NOT NULL UNIQUE,                  -- customer-facing, e.g. CG-2026-000123
  idempotency_key     TEXT    NOT NULL UNIQUE,                  -- one checkout attempt = one order
  request_hash        TEXT    NOT NULL,                         -- detects a reused key with different content
  customer_name       TEXT    NOT NULL,
  customer_phone      TEXT    NOT NULL,                         -- normalized 9665XXXXXXXX
  city                TEXT    NOT NULL,
  district            TEXT    NOT NULL,
  address             TEXT    NOT NULL,
  location_latitude   REAL,
  location_longitude  REAL,
  customer_notes      TEXT    NOT NULL DEFAULT '',
  boxes               INTEGER NOT NULL CHECK (boxes > 0),
  subtotal            INTEGER NOT NULL CHECK (subtotal >= 0),
  discount_amount     INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  shipping_amount     INTEGER NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
  total_amount        INTEGER NOT NULL CHECK (total_amount >= 0),
  currency            TEXT    NOT NULL DEFAULT 'SAR',
  payment_method      TEXT    NOT NULL CHECK (payment_method IN ('cod')),
  status              TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','preparing','shipped','out_for_delivery','delivered','cancelled','problem')),
  lang                TEXT    NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK (total_amount = subtotal - discount_amount + shipping_amount),
  CHECK ((location_latitude IS NULL) = (location_longitude IS NULL))
);
CREATE INDEX idx_orders_created        ON orders (created_at);
CREATE INDEX idx_orders_status_created ON orders (status, created_at);
CREATE INDEX idx_orders_phone          ON orders (customer_phone);

-- Name and price are snapshots taken at purchase time; later catalog changes never alter old orders.
CREATE TABLE order_items (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id                  INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id                TEXT    NOT NULL,
  product_name_snapshot     TEXT    NOT NULL,
  product_name_en_snapshot  TEXT    NOT NULL DEFAULT '',
  boxes_per_unit            INTEGER NOT NULL CHECK (boxes_per_unit > 0),
  unit_price                INTEGER NOT NULL CHECK (unit_price >= 0),
  quantity                  INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total                INTEGER NOT NULL,
  created_at                TEXT    NOT NULL,
  CHECK (line_total = unit_price * quantity)
);
CREATE INDEX idx_order_items_order ON order_items (order_id);

-- Audit trail and the customer-facing timeline.
CREATE TABLE order_status_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  previous_status  TEXT,
  new_status       TEXT    NOT NULL
                   CHECK (new_status IN ('pending','confirmed','preparing','shipped','out_for_delivery','delivered','cancelled','problem')),
  changed_by       TEXT    NOT NULL,          -- 'customer' (creation) or 'admin'
  note             TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL
);
CREATE INDEX idx_status_history_order ON order_status_history (order_id, id);

-- Internal notes: visible in the admin panel only.
CREATE TABLE order_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  note        TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_order_notes_order ON order_notes (order_id, id);

-- Customer notifications are queued here. No sender is connected yet (WhatsApp / SMS / email
-- can later read 'pending' rows and mark them 'sent' or 'failed').
CREATE TABLE notification_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  event       TEXT    NOT NULL,
  lang        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_outbox_status ON notification_outbox (status, id);

-- Last product data successfully read from the website, used if the site is briefly unreachable.
CREATE TABLE catalog_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  json        TEXT    NOT NULL,
  fetched_at  TEXT    NOT NULL
);
