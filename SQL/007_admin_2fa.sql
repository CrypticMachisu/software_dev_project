-- Two-factor authentication for admin accounts (TOTP, RFC 6238).
-- totp_secret is set while enrolment is pending, and stays after it is confirmed;
-- totp_enabled_at records the moment the first valid code was verified.
-- totp_last_step blocks replaying a code that was already accepted.
BEGIN;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS totp_secret      TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS totp_last_step   BIGINT;

COMMIT;
