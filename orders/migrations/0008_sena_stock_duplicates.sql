-- 0008: (1) the carrier file as the merchant approved it (SENA-2026-0001, edited): prepared from SENA's stock, 1 bag per
-- shipment, the item as «calmgastro» with its SKU / barcode so SENA deducts its stock, item price 0. All are settings, and the
-- preparation source can be chosen per export (kept on the batch; older batches follow the setting).
-- (2) possible duplicates: an admin who called the customer can mark an order «ليس مكرراً» so the warning stops.
-- No existing order, stock or shipment value changes.

ALTER TABLE shipment_batches ADD COLUMN prep_source TEXT;

UPDATE shipping_settings SET value = 'من مخزون SENA', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'sena_prep_source';
INSERT INTO shipping_settings (key, value, updated_at) VALUES
  ('sena_item_name',  'calmgastro',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sena_sku',        '8684712870001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sena_barcode',    '8684712870001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sena_item_price', '0',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sena_bags',       '1',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sena_bubbles',    '0',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('sena_cartons',    '0',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE orders ADD COLUMN duplicate_cleared_at TEXT;
ALTER TABLE orders ADD COLUMN duplicate_cleared_by TEXT;
