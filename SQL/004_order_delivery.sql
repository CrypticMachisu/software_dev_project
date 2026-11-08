-- Delivery details captured at checkout. The API used to validate these and then
-- throw them away, so sellers had no address to ship to. Safe to run more than once.
BEGIN;

ALTER TABLE market_order
  ADD COLUMN IF NOT EXISTS delivery_name   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS delivery_phone  VARCHAR(32),
  ADD COLUMN IF NOT EXISTS delivery_street VARCHAR(300),
  ADD COLUMN IF NOT EXISTS delivery_city   VARCHAR(120),
  ADD COLUMN IF NOT EXISTS delivery_zip    VARCHAR(20);

-- The buyer order list filters by buyer and status.
CREATE INDEX IF NOT EXISTS market_order_buyer_status_idx
  ON market_order (buyer_id, order_status);

COMMIT;
