-- 0014: cash on delivery collected by the carrier (SENA) and paid over to us.
-- An order delivered while in an active SENA shipment row = the carrier collected its amount and owes it to us until a
-- settlement covers it. An order delivered with no active shipment row = delivered by hand (cash taken by our team).
-- A settlement = one payment received from SENA: every SENA delivery up to a cut-off day, what was expected (sum of the
-- amounts in the SENA file), what was received, when, and by whom. Voided, never deleted; its orders become owed again.

CREATE TABLE carrier_settlements (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_no      TEXT    NOT NULL UNIQUE,                              -- SET-2026-0001
  carrier            TEXT    NOT NULL DEFAULT 'SENA' CHECK (carrier IN ('SENA')),
  cutoff_day         TEXT    NOT NULL,                                     -- deliveries up to and including this Riyadh day
  orders_count       INTEGER NOT NULL CHECK (orders_count > 0),
  expected_halalas   INTEGER NOT NULL CHECK (expected_halalas >= 0),       -- sum of the covered orders' amounts
  received_halalas   INTEGER NOT NULL CHECK (received_halalas >= 0),       -- what SENA actually paid (fees may be deducted)
  received_day       TEXT    NOT NULL,
  received_by        TEXT    NOT NULL,                                     -- who received the money
  reference          TEXT    NOT NULL DEFAULT '',                          -- transfer / receipt reference
  notes              TEXT    NOT NULL DEFAULT '',
  request_id         TEXT    NOT NULL UNIQUE,                              -- one settlement per click, however often retried
  created_by         TEXT    NOT NULL,
  user_id            INTEGER,
  created_at         TEXT    NOT NULL,
  voided_at          TEXT,
  voided_by          TEXT,
  void_reason        TEXT
);
CREATE INDEX idx_settlements_created ON carrier_settlements (created_at);

-- the SENA deliveries a settlement covers; active = 1 while the settlement stands, NULL once voided (so the row can be
-- covered again: the unique index ignores NULLs)
CREATE TABLE carrier_settlement_orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  settlement_id      INTEGER NOT NULL REFERENCES carrier_settlements (id),
  shipment_order_id  INTEGER NOT NULL REFERENCES shipment_orders (id),
  order_id           INTEGER NOT NULL REFERENCES orders (id),
  amount             INTEGER NOT NULL CHECK (amount >= 0),                 -- SAR, as in the SENA file
  active             INTEGER CHECK (active IS NULL OR active = 1),
  created_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_settlement_orders_once ON carrier_settlement_orders (shipment_order_id, active);
CREATE INDEX idx_settlement_orders_settlement ON carrier_settlement_orders (settlement_id);

INSERT INTO permissions (permission_key, description) VALUES
  ('settlements.view', 'See what the shipping company collected and owes, hand deliveries and past settlements'),
  ('settlements.manage', 'Record a payment received from the shipping company (and void one)');
INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('super_admin', 'settlements.view'), ('super_admin', 'settlements.manage'), ('order_manager', 'settlements.view');
