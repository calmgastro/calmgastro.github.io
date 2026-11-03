-- 0007: edit a shipment after export. An order taken out of a batch (cancelled — e.g. a duplicate — or returned to
-- «جاري التجهيز» to ship later) keeps its row for the record but no longer counts: the batch totals, the carrier file,
-- delivery confirmation and «لدى شركة الشحن» skip it. Its shipment reference is never reused.
-- Existing rows of orders that are already cancelled are marked removed now (they were cancelled after export).

ALTER TABLE shipment_orders ADD COLUMN removed_at     TEXT;
ALTER TABLE shipment_orders ADD COLUMN removed_by     TEXT;
ALTER TABLE shipment_orders ADD COLUMN removed_reason TEXT;      -- CANCELLED | RETURNED

UPDATE shipment_orders SET removed_at = (SELECT o.updated_at FROM orders o WHERE o.id = shipment_orders.order_id), removed_by = 'system', removed_reason = 'CANCELLED'
WHERE removed_at IS NULL AND order_id IN (SELECT id FROM orders WHERE status = 'CANCELLED');

CREATE INDEX idx_shipment_orders_active ON shipment_orders (batch_id, removed_at);
