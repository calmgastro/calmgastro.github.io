-- 0004: recorded expenses and stock purchases become editable (versioned + audited), purchases can be voided, granular permissions.
--
-- No new parallel tables: a stock purchase IS its inventory batch (inventory_batches, source PURCHASE or OPENING) and an
-- operating expense IS its row in expenses. Reports keep reading those rows directly.
--
-- Source of truth for a purchase's value: quantity_received × unit_cost_halalas. total_cost_halalas is what FIFO reads; the
-- triggers below refuse any write where it differs from unit × quantity, so the two can never disagree. A batch recorded
-- before this migration with only an invoice total that does not divide evenly keeps unit_cost_halalas NULL (its unit
-- cost is total ÷ quantity) until it is next edited.
--
-- Nothing is deleted: a voided expense or purchase stays in its table with who / when / why, and every edit is written to
-- audit_logs with the old and new values of the fields that changed.

-- ---------------------------------------------------------------- expenses: who changed what, optimistic locking
ALTER TABLE expenses ADD COLUMN updated_at TEXT;
ALTER TABLE expenses ADD COLUMN updated_by TEXT;
ALTER TABLE expenses ADD COLUMN updated_by_user_id INTEGER;
ALTER TABLE expenses ADD COLUMN voided_by_user_id INTEGER;
ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_expenses_category ON expenses (category_id, expense_date);

-- ---------------------------------------------------------------- purchases (inventory batches)
ALTER TABLE inventory_batches ADD COLUMN unit_cost_halalas INTEGER CHECK (unit_cost_halalas IS NULL OR unit_cost_halalas > 0);
ALTER TABLE inventory_batches ADD COLUMN updated_at TEXT;
ALTER TABLE inventory_batches ADD COLUMN updated_by TEXT;
ALTER TABLE inventory_batches ADD COLUMN updated_by_user_id INTEGER;
ALTER TABLE inventory_batches ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inventory_batches ADD COLUMN voided_at TEXT;
ALTER TABLE inventory_batches ADD COLUMN voided_by TEXT;
ALTER TABLE inventory_batches ADD COLUMN voided_by_user_id INTEGER;
ALTER TABLE inventory_batches ADD COLUMN void_reason TEXT;
CREATE INDEX idx_batches_received ON inventory_batches (source, received_at);

-- existing batches whose total divides evenly get their exact unit cost
UPDATE inventory_batches SET unit_cost_halalas = total_cost_halalas / quantity_received
WHERE total_cost_halalas IS NOT NULL AND total_cost_halalas > 0 AND total_cost_halalas % quantity_received = 0;

CREATE TRIGGER inventory_batches_cost_insert BEFORE INSERT ON inventory_batches
WHEN NEW.unit_cost_halalas IS NOT NULL AND NEW.total_cost_halalas IS NOT NEW.unit_cost_halalas * NEW.quantity_received
BEGIN SELECT RAISE(ABORT, 'purchase total must equal unit cost x quantity'); END;
CREATE TRIGGER inventory_batches_cost_update BEFORE UPDATE ON inventory_batches
WHEN NEW.unit_cost_halalas IS NOT NULL AND NEW.total_cost_halalas IS NOT NEW.unit_cost_halalas * NEW.quantity_received
BEGIN SELECT RAISE(ABORT, 'purchase total must equal unit cost x quantity'); END;
-- a voided purchase holds no stock; only unused purchases can be voided
CREATE TRIGGER inventory_batches_void_empty BEFORE UPDATE ON inventory_batches
WHEN NEW.voided_at IS NOT NULL AND NEW.quantity_remaining <> 0
BEGIN SELECT RAISE(ABORT, 'a voided purchase must hold no stock'); END;

-- ---------------------------------------------------------------- permissions (checked in the API, not only in the UI)
INSERT INTO permissions (permission_key, description) VALUES
  ('expenses.create',           'Record operating expenses'),
  ('expenses.edit',             'Edit recorded operating expenses (versioned, audited)'),
  ('expenses.void',             'Void (soft-delete) operating expenses'),
  ('inventory.purchase.create', 'Add stock purchases / receipts'),
  ('inventory.purchase.edit',   'Edit stock purchases: quantity, unit cost, date, supplier, reference (versioned, audited)'),
  ('inventory.purchase.void',   'Void (soft-delete) a stock purchase none of which has been used');
-- whoever could manage expenses / inventory keeps exactly what they could do before
INSERT INTO role_permissions (role_id, permission_key)
  SELECT role_id, k FROM role_permissions, (SELECT 'expenses.create' k UNION ALL SELECT 'expenses.edit' UNION ALL SELECT 'expenses.void')
  WHERE permission_key = 'expenses.manage';
INSERT INTO role_permissions (role_id, permission_key)
  SELECT role_id, k FROM role_permissions, (SELECT 'inventory.purchase.create' k UNION ALL SELECT 'inventory.purchase.edit' UNION ALL SELECT 'inventory.purchase.void')
  WHERE permission_key = 'inventory.manage';
-- expenses.manage is replaced by the three keys above
DELETE FROM role_permissions WHERE permission_key = 'expenses.manage';
DELETE FROM permissions WHERE permission_key = 'expenses.manage';
