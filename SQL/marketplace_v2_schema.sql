-- Fresh-install PostgreSQL schema for the revised multi-seller marketplace.
-- PostgreSQL 14+. All monetary amounts use integer minor currency units.
-- This schema tracks provider operations; it does not itself provide escrow custody.
BEGIN;

CREATE TABLE app_user (
  user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  phone VARCHAR(32),
  account_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active','suspended','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX app_user_email_lower_uq ON app_user (lower(email));

CREATE TABLE app_role (
  role_id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_name VARCHAR(40) NOT NULL UNIQUE
);
INSERT INTO app_role(role_name) VALUES ('admin'), ('buyer'), ('seller');
CREATE TABLE user_role (
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  role_id SMALLINT NOT NULL REFERENCES app_role(role_id) ON DELETE RESTRICT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE auth_session (
  session_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  refresh_token_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX auth_session_user_idx ON auth_session(user_id);
CREATE INDEX auth_session_expiry_idx ON auth_session(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE category (
  category_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT
);
CREATE TABLE exchange_method (
  exchange_method_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  managed_by_admin_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  method_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (method_status IN ('active','inactive')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE product (
  product_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  category_id BIGINT NOT NULL REFERENCES category(category_id) ON DELETE RESTRICT,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  asking_price NUMERIC(12,2) NOT NULL CHECK (asking_price >= 0),
  quantity_available INTEGER NOT NULL DEFAULT 1 CHECK (quantity_available >= 0),
  listing_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (listing_status IN ('draft','active','sold','paused','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX product_seller_idx ON product(seller_id);
CREATE INDEX product_category_idx ON product(category_id);
CREATE INDEX product_search_idx ON product USING GIN
  (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')));

CREATE TABLE market_order (
  order_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  order_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (order_status IN ('pending','confirmed','completed','cancelled','refunded','partially_refunded')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_amount_minor >= 0),
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX market_order_buyer_idx ON market_order(buyer_id);
CREATE TABLE order_item (
  order_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES market_order(order_id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES product(product_id) ON DELETE RESTRICT,
  product_title_snapshot VARCHAR(200) NOT NULL,
  seller_id_snapshot BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0),
  UNIQUE(order_id, product_id),
  CHECK (line_total_minor = quantity * unit_price_minor)
);
CREATE INDEX order_item_product_idx ON order_item(product_id);

CREATE TABLE seller_order (
  seller_order_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES market_order(order_id) ON DELETE RESTRICT,
  seller_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  exchange_method_id BIGINT NOT NULL REFERENCES exchange_method(exchange_method_id) ON DELETE RESTRICT,
  fulfillment_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (fulfillment_status IN ('pending','confirmed','processing','shipped','delivered','completed','cancelled','returned')),
  release_status VARCHAR(24) NOT NULL DEFAULT 'not_eligible'
    CHECK (release_status IN ('not_eligible','eligible','held','requested','released','blocked','reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, seller_id),
  UNIQUE(seller_order_id, seller_id)
);
CREATE INDEX seller_order_seller_status_idx ON seller_order(seller_id, fulfillment_status);
CREATE TABLE seller_order_item (
  seller_order_id BIGINT NOT NULL REFERENCES seller_order(seller_order_id) ON DELETE CASCADE,
  order_item_id BIGINT NOT NULL UNIQUE REFERENCES order_item(order_item_id) ON DELETE RESTRICT,
  PRIMARY KEY(seller_order_id, order_item_id)
);

CREATE TABLE review (
  review_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_order_id BIGINT NOT NULL UNIQUE REFERENCES seller_order(seller_order_id) ON DELETE RESTRICT,
  buyer_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  seller_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX review_seller_created_idx ON review(seller_id, created_at DESC);
CREATE INDEX review_buyer_idx ON review(buyer_id);

CREATE TABLE payment_provider (
  payment_provider_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_code VARCHAR(40) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  provider_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (provider_status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE seller_payment_account (
  seller_payment_account_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_provider_id BIGINT NOT NULL REFERENCES payment_provider(payment_provider_id) ON DELETE RESTRICT,
  seller_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  provider_account_id VARCHAR(200) NOT NULL,
  onboarding_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN ('pending','in_review','enabled','restricted','disabled')),
  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(payment_provider_id, provider_account_id),
  UNIQUE(payment_provider_id, seller_id)
);

CREATE TABLE payment (
  payment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES market_order(order_id) ON DELETE RESTRICT,
  payment_provider_id BIGINT NOT NULL REFERENCES payment_provider(payment_provider_id) ON DELETE RESTRICT,
  provider_payment_id VARCHAR(200),
  status VARCHAR(24) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','requires_action','authorized','captured','failed','cancelled','partially_refunded','refunded','disputed')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(payment_provider_id, provider_payment_id)
);
CREATE INDEX payment_order_idx ON payment(order_id);
CREATE TABLE payment_allocation (
  allocation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id BIGINT NOT NULL REFERENCES payment(payment_id) ON DELETE RESTRICT,
  seller_order_id BIGINT REFERENCES seller_order(seller_order_id) ON DELETE RESTRICT,
  allocation_type VARCHAR(24) NOT NULL
    CHECK (allocation_type IN ('seller_proceeds','platform_fee','tax','shipping','discount','adjustment')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status VARCHAR(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','submitted','confirmed','failed','reversed')),
  provider_transfer_id VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((allocation_type = 'seller_proceeds' AND seller_order_id IS NOT NULL)
      OR (allocation_type <> 'seller_proceeds'))
);
CREATE INDEX payment_allocation_seller_idx ON payment_allocation(seller_order_id);

CREATE TABLE payout (
  payout_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_order_id BIGINT NOT NULL REFERENCES seller_order(seller_order_id) ON DELETE RESTRICT,
  payment_provider_id BIGINT NOT NULL REFERENCES payment_provider(payment_provider_id) ON DELETE RESTRICT,
  provider_payout_id VARCHAR(200),
  status VARCHAR(24) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','pending','paid','failed','reversed','cancelled')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMPTZ,
  UNIQUE(payment_provider_id, provider_payout_id)
);
CREATE INDEX payout_seller_status_idx ON payout(seller_order_id, status);

CREATE TABLE refund (
  refund_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id BIGINT NOT NULL REFERENCES payment(payment_id) ON DELETE RESTRICT,
  seller_order_id BIGINT REFERENCES seller_order(seller_order_id) ON DELETE RESTRICT,
  payment_provider_id BIGINT NOT NULL REFERENCES payment_provider(payment_provider_id) ON DELETE RESTRICT,
  provider_refund_id VARCHAR(200),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status VARCHAR(24) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','pending','succeeded','failed','cancelled')),
  reason TEXT,
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(payment_provider_id, provider_refund_id)
);
CREATE TABLE dispute (
  dispute_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id BIGINT NOT NULL REFERENCES payment(payment_id) ON DELETE RESTRICT,
  seller_order_id BIGINT REFERENCES seller_order(seller_order_id) ON DELETE RESTRICT,
  payment_provider_id BIGINT NOT NULL REFERENCES payment_provider(payment_provider_id) ON DELETE RESTRICT,
  provider_dispute_id VARCHAR(200) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status VARCHAR(24) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','needs_response','under_review','won','lost','closed')),
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(payment_provider_id, provider_dispute_id)
);

CREATE TABLE provider_event (
  provider_event_row_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_provider_id BIGINT NOT NULL REFERENCES payment_provider(payment_provider_id) ON DELETE RESTRICT,
  provider_event_id VARCHAR(200) NOT NULL,
  event_type VARCHAR(120) NOT NULL,
  resource_type VARCHAR(40) NOT NULL,
  resource_id VARCHAR(200) NOT NULL,
  processing_status VARCHAR(20) NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processing','processed','failed','ignored')),
  payload_hash BYTEA NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  UNIQUE(payment_provider_id, provider_event_id)
);
CREATE INDEX provider_event_pending_idx ON provider_event(received_at) WHERE processing_status IN ('received','failed');

CREATE TABLE ledger_account (
  ledger_account_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_code VARCHAR(80) NOT NULL UNIQUE,
  account_type VARCHAR(24) NOT NULL
    CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE ledger_transaction (
  ledger_transaction_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at TIMESTAMPTZ
);
CREATE INDEX ledger_source_idx ON ledger_transaction(source_type, source_id);
CREATE TABLE ledger_entry (
  ledger_entry_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ledger_transaction_id BIGINT NOT NULL REFERENCES ledger_transaction(ledger_transaction_id) ON DELETE RESTRICT,
  ledger_account_id BIGINT NOT NULL REFERENCES ledger_account(ledger_account_id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  direction VARCHAR(6) NOT NULL CHECK (direction IN ('debit','credit')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ledger_entry_tx_idx ON ledger_entry(ledger_transaction_id);

CREATE FUNCTION has_app_role(p_user_id BIGINT, p_role_name TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM user_role ur JOIN app_role r USING(role_id)
                 WHERE ur.user_id=p_user_id AND r.role_name=p_role_name);
$$;
CREATE FUNCTION guard_role_reference()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_user BIGINT; v_role TEXT;
BEGIN
  IF TG_TABLE_NAME = 'exchange_method' THEN
    v_user := NEW.managed_by_admin_id; v_role := 'admin';
  ELSIF TG_TABLE_NAME = 'product' THEN
    v_user := NEW.seller_id; v_role := 'seller';
  ELSIF TG_TABLE_NAME = 'market_order' THEN
    v_user := NEW.buyer_id; v_role := 'buyer';
  ELSE
    v_user := NEW.seller_id; v_role := 'seller';
  END IF;
  IF NOT has_app_role(v_user, v_role) THEN
    RAISE EXCEPTION 'user % must have % role for %', v_user, v_role, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER exchange_method_admin_guard
  BEFORE INSERT OR UPDATE OF managed_by_admin_id ON exchange_method
  FOR EACH ROW EXECUTE FUNCTION guard_role_reference();
CREATE TRIGGER product_seller_role_guard
  BEFORE INSERT OR UPDATE OF seller_id ON product
  FOR EACH ROW EXECUTE FUNCTION guard_role_reference();
CREATE TRIGGER market_order_buyer_role_guard
  BEFORE INSERT OR UPDATE OF buyer_id ON market_order
  FOR EACH ROW EXECUTE FUNCTION guard_role_reference();
CREATE TRIGGER seller_payment_account_role_guard
  BEFORE INSERT OR UPDATE OF seller_id ON seller_payment_account
  FOR EACH ROW EXECUTE FUNCTION guard_role_reference();

CREATE FUNCTION guard_seller_order_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_order_seller BIGINT; v_item_seller BIGINT; v_so_order BIGINT;
BEGIN
  SELECT order_id, seller_id INTO v_so_order, v_order_seller
    FROM seller_order WHERE seller_order_id=NEW.seller_order_id FOR UPDATE;
  SELECT seller_id_snapshot INTO v_item_seller FROM order_item WHERE order_item_id=NEW.order_item_id;
  IF v_so_order IS NULL OR v_item_seller IS NULL THEN RAISE EXCEPTION 'invalid seller order or item'; END IF;
  IF v_order_seller <> v_item_seller THEN RAISE EXCEPTION 'order item seller does not match seller order'; END IF;
  IF NOT EXISTS (SELECT 1 FROM order_item WHERE order_item_id=NEW.order_item_id AND order_id=v_so_order) THEN
    RAISE EXCEPTION 'order item and seller order must belong to the same checkout';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER seller_order_item_guard BEFORE INSERT OR UPDATE ON seller_order_item
FOR EACH ROW EXECUTE FUNCTION guard_seller_order_item();

CREATE FUNCTION guard_review_seller_order()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_buyer BIGINT; v_seller BIGINT; v_status TEXT;
BEGIN
  SELECT mo.buyer_id, so.seller_id, so.fulfillment_status
    INTO v_buyer, v_seller, v_status
    FROM seller_order so JOIN market_order mo USING(order_id)
    WHERE so.seller_order_id=NEW.seller_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'seller order not found'; END IF;
  IF NEW.buyer_id <> v_buyer OR NEW.seller_id <> v_seller THEN
    RAISE EXCEPTION 'review buyer/seller must match the seller order';
  END IF;
  IF v_status <> 'completed' THEN RAISE EXCEPTION 'review requires completed seller order'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER review_seller_order_guard BEFORE INSERT OR UPDATE ON review
FOR EACH ROW EXECUTE FUNCTION guard_review_seller_order();

CREATE FUNCTION guard_ledger_entry_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_tx_currency CHAR(3); v_account_currency CHAR(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO v_status FROM ledger_transaction WHERE ledger_transaction_id=OLD.ledger_transaction_id;
    IF v_status = 'posted' THEN RAISE EXCEPTION 'posted ledger entries are immutable'; END IF;
    RETURN OLD;
  END IF;
  SELECT status, currency INTO v_status, v_tx_currency
    FROM ledger_transaction WHERE ledger_transaction_id=NEW.ledger_transaction_id;
  IF v_status = 'posted' THEN RAISE EXCEPTION 'cannot change entries of a posted transaction'; END IF;
  SELECT currency INTO v_account_currency FROM ledger_account WHERE ledger_account_id=NEW.ledger_account_id;
  IF NEW.currency <> v_tx_currency OR NEW.currency <> v_account_currency THEN
    RAISE EXCEPTION 'ledger entry, transaction, and account currencies must match';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER ledger_entry_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_entry_write();

CREATE FUNCTION guard_posted_ledger_transaction()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'posted ledger transactions are immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER ledger_transaction_write_guard
  BEFORE UPDATE OR DELETE ON ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION guard_posted_ledger_transaction();

CREATE FUNCTION assert_ledger_transaction_balanced()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_count BIGINT; v_net NUMERIC;
BEGIN
  IF NEW.status <> 'posted' THEN RETURN NEW; END IF;
  SELECT COUNT(*), COALESCE(SUM(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END),0)
    INTO v_count, v_net FROM ledger_entry
    WHERE ledger_transaction_id=NEW.ledger_transaction_id AND currency=NEW.currency;
  IF v_count < 2 OR v_net <> 0 THEN
    RAISE EXCEPTION 'posted ledger transaction % must have at least two balanced entries', NEW.ledger_transaction_id;
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_entry WHERE ledger_transaction_id=NEW.ledger_transaction_id AND currency<>NEW.currency) THEN
    RAISE EXCEPTION 'ledger entry currency does not match transaction';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER ledger_transaction_balance_guard
  AFTER INSERT OR UPDATE ON ledger_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

COMMIT;
