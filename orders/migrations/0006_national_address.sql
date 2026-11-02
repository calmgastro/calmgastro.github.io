-- 0006: Saudi national address (the short code, e.g. RRRD2929: 4 letters + 4 digits) on orders and saved customers.
-- The carrier (SENA) needs it for shipments inside Saudi Arabia; it goes into column J of their import file.
ALTER TABLE orders ADD COLUMN national_address TEXT
  CHECK (national_address IS NULL OR national_address GLOB '[A-Z][A-Z][A-Z][A-Z][0-9][0-9][0-9][0-9]');
ALTER TABLE customers ADD COLUMN national_address TEXT
  CHECK (national_address IS NULL OR national_address GLOB '[A-Z][A-Z][A-Z][A-Z][0-9][0-9][0-9][0-9]');

-- Existing orders: a customer who pasted the address from the national address service starts it with the short code
-- ("EHAC6670، 6670 سعد الكندي، 5226، ضاحية الملك فهد، الدمام 32512"). Only that exact form is taken; nothing is guessed.
UPDATE orders SET national_address = upper(substr(trim(address), 1, 8))
WHERE national_address IS NULL AND anonymized_at IS NULL
  AND upper(substr(trim(address), 1, 8)) GLOB '[A-Z][A-Z][A-Z][A-Z][0-9][0-9][0-9][0-9]'
  AND (length(trim(address)) = 8 OR substr(trim(address), 9, 1) NOT GLOB '[0-9A-Za-z]');

-- saved customers take the latest national address found on their orders
UPDATE customers SET national_address = (SELECT o.national_address FROM orders o WHERE o.customer_id = customers.id AND o.national_address IS NOT NULL ORDER BY o.id DESC LIMIT 1)
WHERE national_address IS NULL;
