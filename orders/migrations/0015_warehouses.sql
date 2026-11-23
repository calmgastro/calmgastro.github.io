-- 0015: two separate warehouses: «سينا مكة» (SENA's warehouse in Makkah, SENA packs from it) and «مستودع الرياض» (our own).
--
-- Every box is in exactly one warehouse: balances, reservations, FIFO batches, receipts, adjustments and alerts are per
-- warehouse, boxes move between them only by a recorded transfer, and every order has the warehouse it is taken from.
--
-- Existing data: all stock on hand now goes to «سينا مكة» (confirmed by the owner 2026-11-23: none in Riyadh). Ledger rows
-- written before this migration keep warehouse_id NULL (the ledger is append-only): they were one common stock, so each
-- warehouse is checked from the baseline stored here, and the two together against the whole ledger. Delivered orders that
-- never went through SENA were handed over in Riyadh: their warehouse (and sold boxes) is Riyadh; nothing else changes.
-- No cost, COGS, price or order total changes.

CREATE TABLE warehouses (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  is_carrier  INTEGER NOT NULL DEFAULT 0 CHECK (is_carrier IN (0,1)),   -- 1 = held by the carrier, which packs from it
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL
);
INSERT INTO warehouses (id, name, is_carrier, sort, created_at) VALUES
  ('SENA_MAKKAH', 'سينا مكة',       1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('RIYADH',      'مستودع الرياض', 0, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- which warehouse a new order is taken from: CITY (Riyadh city → RIYADH, the rest → SENA_MAKKAH), or one warehouse for all
INSERT INTO inventory_settings (key, value, updated_at) VALUES ('warehouse_mode', 'CITY', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------------------------------------------------------------- orders and shipments
ALTER TABLE orders ADD COLUMN warehouse_id TEXT;                           -- set on every new order
ALTER TABLE orders ADD COLUMN warehouse_manual INTEGER NOT NULL DEFAULT 0; -- 1 = chosen by the team: a city edit no longer moves it
UPDATE orders SET warehouse_id = CASE WHEN status = 'DELIVERED'
    AND NOT EXISTS (SELECT 1 FROM shipment_orders s WHERE s.order_id = orders.id AND s.removed_at IS NULL) THEN 'RIYADH' ELSE 'SENA_MAKKAH' END;
CREATE INDEX idx_orders_warehouse ON orders (warehouse_id, status);
ALTER TABLE shipment_batches ADD COLUMN warehouse_id TEXT;                 -- where its boxes left from
UPDATE shipment_batches SET warehouse_id = 'SENA_MAKKAH';

-- ---------------------------------------------------------------- balance per product AND warehouse
CREATE TABLE inventory_balances_new (
  product_id   TEXT    NOT NULL REFERENCES products (id),
  warehouse_id TEXT    NOT NULL REFERENCES warehouses (id),
  on_hand      INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved     INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  sold         INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  last_delta   INTEGER NOT NULL DEFAULT 0,
  alert_level  TEXT    NOT NULL DEFAULT 'NONE' CHECK (alert_level IN ('NONE','LOW','CRITICAL','OUT')),
  initialized_at TEXT,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (product_id, warehouse_id),
  CHECK (reserved <= on_hand)
);
-- boxes of delivered Riyadh orders are counted as sold from Riyadh, the rest from SENA
INSERT INTO inventory_balances_new (product_id, warehouse_id, on_hand, reserved, sold, alert_level, initialized_at, updated_at)
  SELECT b.product_id, 'RIYADH', 0, 0, COALESCE((SELECT SUM(r.reserved_qty) FROM inventory_reservations r JOIN orders o ON o.id = r.order_id
      WHERE r.product_id = b.product_id AND r.status = 'COMMITTED' AND o.warehouse_id = 'RIYADH'), 0), 'OUT', b.initialized_at, b.updated_at FROM inventory_balances b;
INSERT INTO inventory_balances_new (product_id, warehouse_id, on_hand, reserved, sold, alert_level, initialized_at, updated_at)
  SELECT b.product_id, 'SENA_MAKKAH', b.on_hand, b.reserved, b.sold - (SELECT n.sold FROM inventory_balances_new n WHERE n.product_id = b.product_id AND n.warehouse_id = 'RIYADH'),
    b.alert_level, b.initialized_at, b.updated_at FROM inventory_balances b;
DROP TABLE inventory_balances;
ALTER TABLE inventory_balances_new RENAME TO inventory_balances;

-- ---------------------------------------------------------------- where the remaining units of each batch are
ALTER TABLE inventory_batches ADD COLUMN warehouse_id TEXT;                -- where it was received (NULL = before this migration → SENA_MAKKAH)
CREATE TABLE inventory_batch_stock (
  batch_id     INTEGER NOT NULL REFERENCES inventory_batches (id),
  warehouse_id TEXT    NOT NULL REFERENCES warehouses (id),
  quantity     INTEGER NOT NULL DEFAULT 0 CONSTRAINT batch_stock_quantity CHECK (quantity >= 0),
  PRIMARY KEY (batch_id, warehouse_id)
);
INSERT INTO inventory_batch_stock (batch_id, warehouse_id, quantity) SELECT id, 'SENA_MAKKAH', quantity_remaining FROM inventory_batches;

ALTER TABLE inventory_transactions ADD COLUMN warehouse_id TEXT;           -- its before / after numbers are this warehouse's
ALTER TABLE inventory_adjustments  ADD COLUMN warehouse_id TEXT;
ALTER TABLE inventory_alerts       ADD COLUMN warehouse_id TEXT;
CREATE INDEX idx_inv_tx_warehouse ON inventory_transactions (warehouse_id, id);

-- what each warehouse is checked from (the ledger rows after last_tx_id)
CREATE TABLE inventory_baselines (
  product_id   TEXT    NOT NULL REFERENCES products (id),
  warehouse_id TEXT    NOT NULL REFERENCES warehouses (id),
  on_hand      INTEGER NOT NULL,
  sold         INTEGER NOT NULL,
  last_tx_id   INTEGER NOT NULL,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (product_id, warehouse_id)
);
INSERT INTO inventory_baselines (product_id, warehouse_id, on_hand, sold, last_tx_id, created_at)
  SELECT product_id, warehouse_id, on_hand, sold, COALESCE((SELECT MAX(id) FROM inventory_transactions), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM inventory_balances;

-- ---------------------------------------------------------------- transfers (append-only; a mistake is a transfer back)
CREATE TABLE warehouse_transfers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     TEXT    NOT NULL REFERENCES products (id),
  from_warehouse TEXT    NOT NULL REFERENCES warehouses (id),
  to_warehouse   TEXT    NOT NULL REFERENCES warehouses (id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  notes          TEXT    NOT NULL DEFAULT '',
  request_id     TEXT    NOT NULL UNIQUE,
  created_by     TEXT    NOT NULL,
  user_id        INTEGER,
  created_at     TEXT    NOT NULL,
  CHECK (from_warehouse <> to_warehouse)
);
