-- Admin panel additions. Safe to run more than once.
-- Depends on: SQL/marketplace_v2_schema.sql (app_user, app_role, user_role).
BEGIN;

-- 1. New role
INSERT INTO app_role (role_name) VALUES ('super_admin') ON CONFLICT (role_name) DO NOTHING;

-- 2. Approval workflow on role assignments (e.g. seller applications).
--    Existing rows default to 'approved' so nobody loses access.
ALTER TABLE user_role
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(12) NOT NULL DEFAULT 'approved'
  CHECK (approval_status IN ('pending','approved','rejected'));

-- Fast lookup for the "pending approvals" list on the dashboard
CREATE INDEX IF NOT EXISTS user_role_pending_idx
  ON user_role (assigned_at) WHERE approval_status = 'pending';

-- 3. Only APPROVED roles count. Without this, a pending/rejected seller still
--    passes the guard triggers in the base schema (product, seller_payment_account, ...).
CREATE OR REPLACE FUNCTION has_app_role(p_user_id BIGINT, p_role_name TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM user_role ur JOIN app_role r USING(role_id)
                 WHERE ur.user_id = p_user_id
                   AND r.role_name = p_role_name
                   AND ur.approval_status = 'approved');
$$;

-- 4. Audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE RESTRICT,
  action       VARCHAR(80) NOT NULL,
  target_table VARCHAR(60),
  target_id    BIGINT,
  details      TEXT,
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_user_idx    ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

-- 5. Password reset tokens (store only the hash, never the raw token)
CREATE TABLE IF NOT EXISTS password_reset (
  reset_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset (user_id);

COMMIT;
