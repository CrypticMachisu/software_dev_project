-- Per-seller fulfilment options. A seller with no rows here offers every
-- active exchange method; once they save a choice, only those methods are shown
-- to buyers at checkout.
BEGIN;

CREATE TABLE IF NOT EXISTS seller_exchange_method (
  seller_id          BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  exchange_method_id BIGINT NOT NULL REFERENCES exchange_method(exchange_method_id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, exchange_method_id)
);
CREATE INDEX IF NOT EXISTS seller_exchange_method_method_idx
  ON seller_exchange_method (exchange_method_id);

COMMIT;
