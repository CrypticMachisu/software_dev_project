-- Real M-Pesa collections (Daraja / M-Pesa Express). Safe to run more than once.
BEGIN;

-- 1. Register the provider so /admin/exchange lists it next to the demo one.
INSERT INTO payment_provider (provider_code, display_name)
VALUES ('mpesa', 'M-Pesa (Safaricom)')
ON CONFLICT (provider_code) DO NOTHING;

-- 2. provider_payment_id stores the STK CheckoutRequestID, which is what the callback
--    is matched on. The M-Pesa receipt is the code a buyer quotes in support requests.
ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS provider_receipt VARCHAR(40);

CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_receipt_uq
  ON payment (payment_provider_id, provider_receipt)
  WHERE provider_receipt IS NOT NULL;

COMMIT;
