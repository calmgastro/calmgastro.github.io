-- 0009: orders can be added to a shipment after export. SENA refuses a shipment reference it has already received (their rule 9), so
-- once a file may have been uploaded the added orders need a file of their own: each row records when it was last in a downloaded
-- file. Rows of batches already downloaded count as downloaded. No order, stock or shipment value changes.

ALTER TABLE shipment_orders ADD COLUMN downloaded_at TEXT;

UPDATE shipment_orders SET downloaded_at = (SELECT b.last_download_at FROM shipment_batches b WHERE b.id = shipment_orders.batch_id)
WHERE batch_id IN (SELECT id FROM shipment_batches WHERE last_download_at IS NOT NULL);
