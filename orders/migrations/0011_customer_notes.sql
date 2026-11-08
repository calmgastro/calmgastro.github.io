-- 0011: the saved customer keeps its delivery notes too, so the customer page can show and edit every shipping detail and a
-- quick order from that page carries them. Filled once from each customer's latest order (anonymized orders excluded).
-- No order, stock or shipment value changes here.

ALTER TABLE customers ADD COLUMN notes TEXT NOT NULL DEFAULT '';

UPDATE customers SET notes = COALESCE((SELECT o.customer_notes FROM orders o
  WHERE o.customer_id = customers.id AND o.anonymized_at IS NULL ORDER BY o.id DESC LIMIT 1), '');
