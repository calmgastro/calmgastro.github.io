-- 0002: new status lifecycle (RECEIVED … DELIVERED + CANCELLED / FAILED / ON_HOLD), admin users,
-- roles and permissions, server-side sessions, login throttling and an immutable audit log.
--
-- Existing orders are kept. SQLite cannot change a CHECK constraint in place, so the order tables are
-- rebuilt: new tables are created and filled first, then the old ones are dropped children-first.
-- Dropping a parent while children still reference it would cascade-delete them, so the new child
-- tables reference the new parent (orders_v2) from the start; renaming orders_v2 → orders rewrites
-- those references automatically.
PRAGMA defer_foreign_keys = true;

CREATE TABLE orders_v2 (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number        TEXT    NOT NULL UNIQUE,
  idempotency_key     TEXT    NOT NULL UNIQUE,
  request_hash        TEXT    NOT NULL,
  customer_name       TEXT    NOT NULL,
  customer_phone      TEXT    NOT NULL,
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
  status              TEXT    NOT NULL DEFAULT 'RECEIVED'
                      CHECK (status IN ('RECEIVED','CONFIRMED','PREPARING','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','FAILED','ON_HOLD')),
  lang                TEXT    NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  token_version       INTEGER NOT NULL DEFAULT 1 CHECK (token_version >= 1),   -- raise to revoke the customer's secure link
  archived_at         TEXT,
  anonymized_at       TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK (total_amount = subtotal - discount_amount + shipping_amount),
  CHECK ((location_latitude IS NULL) = (location_longitude IS NULL))
);
INSERT INTO orders_v2 (id, order_number, idempotency_key, request_hash, customer_name, customer_phone, city, district, address,
  location_latitude, location_longitude, customer_notes, boxes, subtotal, discount_amount, shipping_amount, total_amount,
  currency, payment_method, status, lang, created_at, updated_at)
SELECT id, order_number, idempotency_key, request_hash, customer_name, customer_phone, city, district, address,
  location_latitude, location_longitude, customer_notes, boxes, subtotal, discount_amount, shipping_amount, total_amount,
  currency, payment_method,
  CASE status WHEN 'pending' THEN 'RECEIVED' WHEN 'problem' THEN 'ON_HOLD' ELSE upper(status) END,
  lang, created_at, updated_at
FROM orders;

CREATE TABLE order_items_v2 (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id                  INTEGER NOT NULL REFERENCES orders_v2 (id),
  product_id                TEXT    NOT NULL,
  product_name_snapshot     TEXT    NOT NULL,
  product_name_en_snapshot  TEXT    NOT NULL DEFAULT '',
  boxes_per_unit            INTEGER NOT NULL CHECK (boxes_per_unit > 0),
  unit_price                INTEGER NOT NULL CHECK (unit_price >= 0),
  price_overridden          INTEGER NOT NULL DEFAULT 0 CHECK (price_overridden IN (0,1)),   -- set by an authorized admin
  quantity                  INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total                INTEGER NOT NULL,
  created_at                TEXT    NOT NULL,
  updated_at                TEXT    NOT NULL,
  CHECK (line_total = unit_price * quantity)
);
INSERT INTO order_items_v2 (id, order_id, product_id, product_name_snapshot, product_name_en_snapshot, boxes_per_unit, unit_price,
  quantity, line_total, created_at, updated_at)
SELECT id, order_id, product_id, product_name_snapshot, product_name_en_snapshot, boxes_per_unit, unit_price,
  quantity, line_total, created_at, created_at
FROM order_items;

CREATE TABLE order_status_history_v2 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders_v2 (id),
  previous_status  TEXT,
  new_status       TEXT    NOT NULL
                   CHECK (new_status IN ('RECEIVED','CONFIRMED','PREPARING','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','FAILED','ON_HOLD')),
  changed_by       TEXT    NOT NULL,          -- 'customer' at creation, otherwise the admin username
  user_id          INTEGER,
  note             TEXT    NOT NULL DEFAULT '',
  visibility       TEXT    NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','customer')),
  bulk_id          TEXT,                      -- set when the change was part of a bulk update
  ip_address       TEXT,
  user_agent       TEXT,
  created_at       TEXT    NOT NULL
);
INSERT INTO order_status_history_v2 (id, order_id, previous_status, new_status, changed_by, note, visibility, created_at)
SELECT id, order_id,
  CASE previous_status WHEN 'pending' THEN 'RECEIVED' WHEN 'problem' THEN 'ON_HOLD' ELSE upper(previous_status) END,
  CASE new_status WHEN 'pending' THEN 'RECEIVED' WHEN 'problem' THEN 'ON_HOLD' ELSE upper(new_status) END,
  changed_by, note, 'internal', created_at
FROM order_status_history;

CREATE TABLE order_notes_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders_v2 (id),
  note        TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  user_id     INTEGER,
  created_at  TEXT    NOT NULL
);
INSERT INTO order_notes_v2 (id, order_id, note, created_by, created_at) SELECT id, order_id, note, created_by, created_at FROM order_notes;

CREATE TABLE notification_outbox_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders_v2 (id),
  event       TEXT    NOT NULL,
  lang        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  created_at  TEXT    NOT NULL
);
INSERT INTO notification_outbox_v2 (id, order_id, event, lang, message, status, created_at)
SELECT id, order_id, CASE event WHEN 'created' THEN 'RECEIVED' ELSE upper(event) END, lang, message, status, created_at FROM notification_outbox;

-- old tables: children first, so dropping the old parent cascades into nothing
DROP TABLE notification_outbox;
DROP TABLE order_notes;
DROP TABLE order_status_history;
DROP TABLE order_items;
DROP TABLE orders;

ALTER TABLE orders_v2 RENAME TO orders;
ALTER TABLE order_items_v2 RENAME TO order_items;
ALTER TABLE order_status_history_v2 RENAME TO order_status_history;
ALTER TABLE order_notes_v2 RENAME TO order_notes;
ALTER TABLE notification_outbox_v2 RENAME TO notification_outbox;

CREATE INDEX idx_orders_created        ON orders (created_at);
CREATE INDEX idx_orders_updated        ON orders (updated_at);
CREATE INDEX idx_orders_status_created ON orders (status, created_at);
CREATE INDEX idx_orders_phone          ON orders (customer_phone);
CREATE INDEX idx_order_items_order     ON order_items (order_id);
CREATE INDEX idx_order_items_product   ON order_items (product_id);
CREATE INDEX idx_status_history_order  ON order_status_history (order_id, id);
CREATE INDEX idx_order_notes_order     ON order_notes (order_id, id);
CREATE INDEX idx_outbox_status         ON notification_outbox (status, id);

-- History is an audit trail: rows can be added, never changed or removed.
CREATE TRIGGER status_history_no_update BEFORE UPDATE ON order_status_history BEGIN SELECT RAISE(ABORT, 'order_status_history is append-only'); END;
CREATE TRIGGER status_history_no_delete BEFORE DELETE ON order_status_history BEGIN SELECT RAISE(ABORT, 'order_status_history is append-only'); END;

-- ---------------------------------------------------------------- access control
CREATE TABLE roles (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  name_ar  TEXT NOT NULL
);
CREATE TABLE permissions (
  permission_key  TEXT PRIMARY KEY,
  description     TEXT NOT NULL
);
CREATE TABLE role_permissions (
  role_id         TEXT NOT NULL REFERENCES roles (id),
  permission_key  TEXT NOT NULL REFERENCES permissions (permission_key),
  PRIMARY KEY (role_id, permission_key)
);

INSERT INTO roles (id, name, name_ar) VALUES
  ('super_admin',   'Super Admin',   'مدير عام'),
  ('order_manager', 'Order Manager', 'مدير الطلبات'),
  ('support_agent', 'Support Agent', 'دعم العملاء');

INSERT INTO permissions (permission_key, description) VALUES
  ('dashboard.view',         'View the operational dashboard'),
  ('orders.view',            'Search and open orders, view customer data'),
  ('orders.notes',           'Add internal notes'),
  ('orders.status',          'Change order status along the normal workflow'),
  ('orders.status.limited',  'Confirm new orders or put them on hold only'),
  ('orders.status.bulk',     'Change the status of many orders at once'),
  ('orders.status.override', 'Move orders backwards or out of a final status'),
  ('orders.edit_customer',   'Edit customer and delivery details'),
  ('orders.edit_items',      'Add, remove and change quantities of order items'),
  ('orders.edit_price',      'Change unit prices on orders'),
  ('orders.revoke_link',     'Revoke the customer''s secure order link'),
  ('orders.archive',         'Archive and unarchive finished orders'),
  ('orders.anonymize',       'Erase personal data from an order (privacy requests)'),
  ('orders.export',          'Export orders to CSV'),
  ('customers.view',         'View the customer list'),
  ('products.view',          'View products and prices'),
  ('reports.view',           'View analytics and reports'),
  ('audit.view',             'View the audit log'),
  ('users.manage',           'Create and manage admin accounts'),
  ('settings.manage',        'System settings and full backups');

INSERT INTO role_permissions (role_id, permission_key) SELECT 'super_admin', permission_key FROM permissions;
INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('order_manager', 'dashboard.view'), ('order_manager', 'orders.view'), ('order_manager', 'orders.notes'),
  ('order_manager', 'orders.status'), ('order_manager', 'orders.status.bulk'), ('order_manager', 'orders.edit_customer'),
  ('order_manager', 'orders.edit_items'), ('order_manager', 'orders.revoke_link'), ('order_manager', 'orders.archive'),
  ('order_manager', 'orders.export'), ('order_manager', 'customers.view'), ('order_manager', 'products.view'),
  ('order_manager', 'reports.view'),
  ('support_agent', 'dashboard.view'), ('support_agent', 'orders.view'), ('support_agent', 'orders.notes'),
  ('support_agent', 'orders.status.limited'), ('support_agent', 'customers.view'), ('support_agent', 'products.view');

CREATE TABLE users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  username               TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name           TEXT    NOT NULL DEFAULT '',
  password_hash          TEXT    NOT NULL,                -- pbkdf2-sha256$iterations$salt$hash (peppered)
  role_id                TEXT    NOT NULL REFERENCES roles (id),
  is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password   INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  totp_secret_enc        TEXT,                            -- AES-GCM encrypted; never returned by the API
  totp_enabled           INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),
  totp_last_step         INTEGER NOT NULL DEFAULT 0,      -- blocks reuse of a code
  last_login_at          TEXT,
  failed_login_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until           TEXT,
  password_changed_at    TEXT,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

-- Only the SHA-256 of the session token is stored; the token itself lives in an HttpOnly cookie.
CREATE TABLE sessions (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id),
  mfa_pending   INTEGER NOT NULL DEFAULT 0 CHECK (mfa_pending IN (0,1)),
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,                         -- absolute timeout
  revoked_at    TEXT,
  ip_address    TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Failed logins per username, including names that do not exist, so lockout behaves identically for both.
CREATE TABLE login_throttle (
  username_key  TEXT    PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  username     TEXT,
  action       TEXT    NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  old_value    TEXT,
  new_value    TEXT,
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs (created_at);
CREATE INDEX idx_audit_entity  ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_user    ON audit_logs (user_id, created_at);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
