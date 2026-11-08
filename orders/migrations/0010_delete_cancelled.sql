-- 0010: a cancelled or failed order (a test order, a duplicate) can be deleted for good, and with it a customer left with no
-- orders. Orders that matter stay: one that was in a shipment file sent to SENA, one with real stock movement (a sale or a
-- return), one tied to an expense. Its status history and its reserve/release ledger rows (which add up to nothing) go with it;
-- the audit log keeps the record of the deletion. The append-only guards stay for everything else: a row may only be deleted
-- while its order carries a purge_token, which the delete sets in the same transaction and which only a cancelled or failed
-- order can carry. No order, stock or shipment value changes here.

ALTER TABLE orders ADD COLUMN purge_token TEXT;

INSERT INTO permissions (permission_key, description) VALUES
  ('orders.delete', 'Delete cancelled or failed orders, and customers left with no orders');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('super_admin', 'orders.delete');

DROP TRIGGER status_history_no_delete;
CREATE TRIGGER status_history_no_delete BEFORE DELETE ON order_status_history
WHEN NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = OLD.order_id AND o.purge_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'order_status_history is append-only'); END;

DROP TRIGGER inventory_transactions_no_delete;
CREATE TRIGGER inventory_transactions_no_delete BEFORE DELETE ON inventory_transactions
WHEN OLD.type NOT IN ('RESERVATION', 'RELEASE') OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = OLD.order_id AND o.purge_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'inventory_transactions is append-only'); END;

CREATE TRIGGER orders_purge_only_finished BEFORE UPDATE OF purge_token ON orders
WHEN NEW.purge_token IS NOT NULL AND NEW.status NOT IN ('CANCELLED', 'FAILED')
BEGIN SELECT RAISE(ABORT, 'only a cancelled or failed order can be deleted'); END;

CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
WHEN OLD.purge_token IS NULL OR OLD.status NOT IN ('CANCELLED', 'FAILED')
BEGIN SELECT RAISE(ABORT, 'only a cancelled or failed order marked for deletion can be deleted'); END;
