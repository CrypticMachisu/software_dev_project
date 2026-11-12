-- Pickup information sellers can show to buyers, plus a snapshot on each seller
-- order so the buyer keeps the details they checked out with. Safe to run again.
BEGIN;

CREATE TABLE IF NOT EXISTS seller_pickup_detail (
  seller_id    BIGINT PRIMARY KEY REFERENCES app_user(user_id) ON DELETE CASCADE,
  location     VARCHAR(300) NOT NULL,
  instructions TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE seller_order
  ADD COLUMN IF NOT EXISTS pickup_location_snapshot     VARCHAR(300),
  ADD COLUMN IF NOT EXISTS pickup_instructions_snapshot TEXT;

COMMIT;
