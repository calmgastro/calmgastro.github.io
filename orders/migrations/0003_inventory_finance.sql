-- 0003: inventory (batches, FIFO cost, reservations, ledger), operating expenses, customers, order source.
--
-- Nothing existing is changed or deleted. The opening stock is NOT inserted here: an admin creates it once from
-- Admin → المخزون (quantity, date before the first order, optional total cost), and the same step reconciles every
-- existing order against it by its current status. Until then the inventory hooks do nothing.
--
-- Units: 1 unit = 1 box. Purchase costs and expenses are stored in halalas (1 SAR = 100) so that a batch total that
-- does not divide evenly (e.g. 1,000 SAR / 24) keeps its exact value; order amounts stay in whole riyals as before.

-- ---------------------------------------------------------------- products (one today, more later)
CREATE TABLE products (
  id          TEXT    PRIMARY KEY,                  -- 'calmgastro'; catalog bundles map to a product (default calmgastro)
  name        TEXT    NOT NULL,
  name_en     TEXT    NOT NULL DEFAULT '',
  unit_label  TEXT    NOT NULL DEFAULT 'علبة',
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT    NOT NULL
);
INSERT INTO products (id, name, name_en, created_at) VALUES ('calmgastro', 'كالم كاسترو', 'CalmGastro', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------------------------------------------------------------- settings (key/value, edited from Admin → الإعدادات)
CREATE TABLE inventory_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL
);
INSERT INTO inventory_settings (key, value, updated_at) VALUES
  ('low_stock_threshold',  '10',                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('critical_stock_threshold', '3',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('costing_method',       'FIFO',              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('reservation_behavior', 'ON_ORDER_CREATED',  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortage_policy',      'RESERVE_AVAILABLE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),   -- or RESERVE_NONE
  ('return_policy',        'RESTOCK',           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));   -- or WRITE_OFF

-- ---------------------------------------------------------------- current balance per product
-- Maintained only inside the same transaction that writes inventory_transactions (never edited on its own).
-- on_hand  = physical units not yet sold (opening + receipts ± adjustments − sold + returns)
-- reserved = units held for open orders;  available = on_hand − reserved
CREATE TABLE inventory_balances (
  product_id   TEXT    PRIMARY KEY REFERENCES products (id),
  on_hand      INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved     INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  sold         INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  last_delta   INTEGER NOT NULL DEFAULT 0,          -- scratch value: quantity moved by the current statement group
  alert_level  TEXT    NOT NULL DEFAULT 'NONE' CHECK (alert_level IN ('NONE','LOW','CRITICAL','OUT')),
  initialized_at TEXT,
  updated_at   TEXT    NOT NULL,
  CHECK (reserved <= on_hand)                        -- available can never go negative
);

-- ---------------------------------------------------------------- batches (one per receipt; never merged)
CREATE TABLE inventory_batches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id          TEXT    NOT NULL REFERENCES products (id),
  batch_no            INTEGER NOT NULL,             -- 1, 2, 3 … per product
  source              TEXT    NOT NULL CHECK (source IN ('OPENING','PURCHASE','ADJUSTMENT')),
  received_at         TEXT    NOT NULL,             -- date the goods arrived (YYYY-MM-DD or ISO)
  quantity_ordered    INTEGER,                      -- optional: quantity on the purchase document
  quantity_received   INTEGER NOT NULL CHECK (quantity_received > 0),
  quantity_remaining  INTEGER NOT NULL CHECK (quantity_remaining >= 0),
  total_cost_halalas  INTEGER CHECK (total_cost_halalas IS NULL OR total_cost_halalas >= 0),   -- NULL = cost not entered yet
  supplier            TEXT    NOT NULL DEFAULT '',
  reference           TEXT    NOT NULL DEFAULT '',
  location            TEXT    NOT NULL DEFAULT '',
  notes               TEXT    NOT NULL DEFAULT '',
  created_by          TEXT    NOT NULL,
  user_id             INTEGER,
  created_at          TEXT    NOT NULL,
  CHECK (quantity_remaining <= quantity_received),
  UNIQUE (product_id, batch_no)
);
CREATE INDEX idx_batches_fifo ON inventory_batches (product_id, received_at, id);

-- ---------------------------------------------------------------- reservations (one row per order and product)
CREATE TABLE inventory_reservations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id              INTEGER NOT NULL REFERENCES orders (id),
  product_id            TEXT    NOT NULL REFERENCES products (id),
  requested_qty         INTEGER NOT NULL CHECK (requested_qty > 0),
  reserved_qty          INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  shortage_qty          INTEGER NOT NULL DEFAULT 0 CHECK (shortage_qty >= 0),
  status                TEXT    NOT NULL CHECK (status IN ('RESERVED','SHORTAGE','COMMITTED','RELEASED')),
  available_at_order    INTEGER,                    -- available stock just before this order reserved
  available_after       INTEGER,
  cogs_halalas          INTEGER,                    -- set when committed (FIFO); NULL if a batch cost is unknown
  cogs_complete         INTEGER NOT NULL DEFAULT 0 CHECK (cogs_complete IN (0,1)),
  reserved_at           TEXT,
  released_at           TEXT,
  committed_at          TEXT,
  updated_at            TEXT    NOT NULL,
  UNIQUE (order_id, product_id),
  CHECK (reserved_qty + shortage_qty <= requested_qty)
);
CREATE INDEX idx_reservations_status ON inventory_reservations (status);

-- FIFO consumption of batches per order; reversed rows are kept (a return restocks the same batches)
CREATE TABLE inventory_consumptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER REFERENCES orders (id),     -- NULL for an adjustment write-off
  adjustment_id INTEGER,
  batch_id      INTEGER NOT NULL REFERENCES inventory_batches (id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  cost_halalas  INTEGER,                            -- NULL if the batch cost is unknown
  created_at    TEXT    NOT NULL,
  reversed_at   TEXT
);
CREATE INDEX idx_consumptions_order ON inventory_consumptions (order_id);
CREATE INDEX idx_consumptions_batch ON inventory_consumptions (batch_id);

-- ---------------------------------------------------------------- manual adjustments (physical count, damage …)
CREATE TABLE inventory_adjustments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id       TEXT    NOT NULL REFERENCES products (id),
  quantity         INTEGER NOT NULL CHECK (quantity <> 0),     -- signed: −5 damaged, +2 found
  old_on_hand      INTEGER NOT NULL,
  new_on_hand      INTEGER NOT NULL,
  reason           TEXT    NOT NULL,
  notes            TEXT    NOT NULL DEFAULT '',
  created_by       TEXT    NOT NULL,
  user_id          INTEGER,
  created_at       TEXT    NOT NULL
);

-- ---------------------------------------------------------------- the ledger: every movement, append-only
CREATE TABLE inventory_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        TEXT    NOT NULL REFERENCES products (id),
  type              TEXT    NOT NULL CHECK (type IN ('OPENING_BALANCE','PURCHASE_RECEIPT','RESERVATION','RELEASE','SALE','ADJUSTMENT','RETURN','WRITE_OFF','COST_UPDATE')),
  quantity          INTEGER NOT NULL,               -- units moved (positive); direction follows the type
  order_id          INTEGER REFERENCES orders (id),
  batch_id          INTEGER REFERENCES inventory_batches (id),
  adjustment_id     INTEGER REFERENCES inventory_adjustments (id),
  on_hand_before    INTEGER NOT NULL,
  on_hand_after     INTEGER NOT NULL,
  reserved_before   INTEGER NOT NULL,
  reserved_after    INTEGER NOT NULL,
  available_before  INTEGER NOT NULL,
  available_after   INTEGER NOT NULL,
  cost_halalas      INTEGER,
  reference         TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  actor             TEXT    NOT NULL,               -- admin username, 'customer' (website order) or 'system'
  user_id           INTEGER,
  idempotency_key   TEXT    UNIQUE,                 -- one key per logical movement: a retry can never apply it twice
  created_at        TEXT    NOT NULL
);
CREATE INDEX idx_inv_tx_product ON inventory_transactions (product_id, id);
CREATE INDEX idx_inv_tx_order   ON inventory_transactions (order_id);
CREATE TRIGGER inventory_transactions_no_update BEFORE UPDATE ON inventory_transactions BEGIN SELECT RAISE(ABORT, 'inventory_transactions is append-only'); END;
CREATE TRIGGER inventory_transactions_no_delete BEFORE DELETE ON inventory_transactions BEGIN SELECT RAISE(ABORT, 'inventory_transactions is append-only'); END;

-- ---------------------------------------------------------------- stock alerts (one row per level change, no spam)
CREATE TABLE inventory_alerts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id       TEXT    NOT NULL REFERENCES products (id),
  level            TEXT    NOT NULL CHECK (level IN ('NONE','LOW','CRITICAL','OUT')),
  available        INTEGER NOT NULL,
  threshold        INTEGER NOT NULL,
  created_at       TEXT    NOT NULL,
  acknowledged_by  TEXT,
  acknowledged_at  TEXT
);
CREATE INDEX idx_alerts_open ON inventory_alerts (acknowledged_at, id);

-- ---------------------------------------------------------------- operating expenses
CREATE TABLE expense_categories (
  id          TEXT    PRIMARY KEY,
  name_ar     TEXT    NOT NULL,
  name_en     TEXT    NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
INSERT INTO expense_categories (id, name_ar, name_en, sort) VALUES
  ('DELIVERY',    'التوصيل والشحن',  'Delivery / Shipping', 1),
  ('ADVERTISING', 'الإعلانات المدفوعة', 'Paid advertising',    2),
  ('OTHER',       'مصاريف تشغيلية أخرى', 'Other operating',   3);

CREATE TABLE expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     TEXT    NOT NULL REFERENCES expense_categories (id),
  amount_halalas  INTEGER NOT NULL CHECK (amount_halalas > 0),
  expense_date    TEXT    NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),   -- Riyadh calendar day
  description     TEXT    NOT NULL,
  order_id        INTEGER REFERENCES orders (id),   -- optional: order-specific delivery cost
  platform        TEXT    NOT NULL DEFAULT '' CHECK (platform IN ('','META','GOOGLE','TIKTOK','SNAPCHAT','OTHER')),
  campaign        TEXT    NOT NULL DEFAULT '',
  reference       TEXT    NOT NULL DEFAULT '',
  payment_method  TEXT    NOT NULL DEFAULT '',
  notes           TEXT    NOT NULL DEFAULT '',
  created_by      TEXT    NOT NULL,
  user_id         INTEGER,
  created_at      TEXT    NOT NULL,
  voided_at       TEXT,                             -- expenses are voided (with a reason), never deleted
  voided_by       TEXT,
  void_reason     TEXT
);
CREATE INDEX idx_expenses_date ON expenses (expense_date);
CREATE INDEX idx_expenses_order ON expenses (order_id);

-- ---------------------------------------------------------------- customers (one per mobile number)
CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT    NOT NULL UNIQUE,              -- normalized 9665XXXXXXXX
  name        TEXT    NOT NULL,
  city        TEXT    NOT NULL DEFAULT '',
  district    TEXT    NOT NULL DEFAULT '',
  address     TEXT    NOT NULL DEFAULT '',
  created_by  TEXT    NOT NULL DEFAULT 'customer',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
-- existing customers, from each number's latest order (anonymized orders excluded)
INSERT INTO customers (phone, name, city, district, address, created_by, created_at, updated_at)
SELECT o.customer_phone, o.customer_name, o.city, o.district, o.address, 'customer',
       (SELECT MIN(created_at) FROM orders x WHERE x.customer_phone = o.customer_phone), o.created_at
FROM orders o
WHERE o.anonymized_at IS NULL AND o.id = (SELECT MAX(id) FROM orders y WHERE y.customer_phone = o.customer_phone AND y.anonymized_at IS NULL);

-- ---------------------------------------------------------------- orders: source, creator, customer, manual discount
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'WEBSITE' CHECK (source IN ('WEBSITE','ADMIN'));
ALTER TABLE orders ADD COLUMN created_by TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE orders ADD COLUMN created_by_user_id INTEGER;
ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers (id);
ALTER TABLE orders ADD COLUMN manual_discount INTEGER NOT NULL DEFAULT 0 CHECK (manual_discount >= 0);   -- included in discount_amount
ALTER TABLE orders ADD COLUMN manual_discount_reason TEXT NOT NULL DEFAULT '';
UPDATE orders SET customer_id = (SELECT id FROM customers c WHERE c.phone = orders.customer_phone) WHERE anonymized_at IS NULL;
CREATE INDEX idx_orders_source ON orders (source, created_at);
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- ---------------------------------------------------------------- permissions
INSERT INTO permissions (permission_key, description) VALUES
  ('orders.create',     'Create orders on behalf of customers'),
  ('orders.discount',   'Apply a manual discount when creating an order'),
  ('inventory.view',    'View stock levels, reservations and shortages'),
  ('inventory.manage',  'Receive stock, adjust stock, inventory settings, opening balance'),
  ('finance.view',      'View purchase costs, COGS, expenses and profit'),
  ('expenses.manage',   'Record and void operating expenses');
INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('super_admin', 'orders.create'), ('super_admin', 'orders.discount'), ('super_admin', 'inventory.view'),
  ('super_admin', 'inventory.manage'), ('super_admin', 'finance.view'), ('super_admin', 'expenses.manage'),
  ('order_manager', 'orders.create'), ('order_manager', 'inventory.view'),
  ('support_agent', 'orders.create');
