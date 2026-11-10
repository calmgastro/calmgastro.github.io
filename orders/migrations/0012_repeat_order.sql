-- 0012: a customer who already has an order not delivered yet is asked on the website whether the new one is really a new
-- order. When they confirm it, the order records when (repeat_confirmed_at), so the admin sees that the customer chose it
-- and was not a double submission. Existing orders stay NULL. No order, stock or shipment value changes here.

ALTER TABLE orders ADD COLUMN repeat_confirmed_at TEXT;
