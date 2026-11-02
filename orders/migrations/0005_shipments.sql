-- 0005: shipments to the carrier (SENA): export batches, the orders in each batch, carrier settings, permission.
--
-- A batch is one export to the carrier: a name chosen by the admin, a running number (SENA-2026-0001), who / when, and the
-- orders it contains. Exporting moves each order to SHIPPED through the normal steps (recorded in its history) and the
-- carrier's own Excel template is filled from these rows; it can be downloaded again at any time. Delivery is confirmed
-- per batch (all at once or selected orders) through the usual status change, so stock and revenue follow as always.
-- Nothing existing is changed.

CREATE TABLE shipping_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL
);
INSERT INTO shipping_settings (key, value, updated_at) VALUES
  ('sena_zone',        '#1 | Saudi Arabia - Riyadh - Mecca warehouse - مكة', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sena_prep_source', 'الشحنة مجهزة من التاجر',                              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('box_weight_kg',    '0.5',                                                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE shipment_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no         TEXT    NOT NULL UNIQUE,                    -- SENA-2026-0001
  carrier          TEXT    NOT NULL CHECK (carrier IN ('SENA')),
  name             TEXT    NOT NULL,                           -- export name chosen by the admin
  notes            TEXT    NOT NULL DEFAULT '',
  request_id       TEXT    NOT NULL UNIQUE,                    -- one batch per click, however often it is retried
  created_by       TEXT    NOT NULL,
  user_id          INTEGER,
  created_at       TEXT    NOT NULL,
  downloads        INTEGER NOT NULL DEFAULT 0,
  last_download_at TEXT
);
CREATE INDEX idx_shipment_batches_created ON shipment_batches (created_at);

-- one row per order in a batch; what was handed to the carrier (boxes, amount) is kept as exported
CREATE TABLE shipment_orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL REFERENCES shipment_batches (id),
  order_id       INTEGER NOT NULL REFERENCES orders (id),
  shipment_ref   TEXT    NOT NULL UNIQUE,                      -- «مرجع الشحنة» in the carrier file: unique, never reused
  status_before  TEXT    NOT NULL,
  boxes          INTEGER NOT NULL CHECK (boxes > 0),
  amount         INTEGER NOT NULL CHECK (amount >= 0),         -- SAR, cash to collect
  created_at     TEXT    NOT NULL,
  UNIQUE (batch_id, order_id)
);
CREATE INDEX idx_shipment_orders_order ON shipment_orders (order_id);

INSERT INTO permissions (permission_key, description) VALUES
  ('shipments.manage', 'Export orders to the shipping company (status → Shipped) and confirm deliveries per batch');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('super_admin', 'shipments.manage'), ('order_manager', 'shipments.manage');
