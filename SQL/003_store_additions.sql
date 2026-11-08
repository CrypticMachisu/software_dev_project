-- Storefront (public marketplace) additions. Safe to run more than once.
-- Depends on: SQL/marketplace_v2_schema.sql, SQL/002_admin_additions.sql.
BEGIN;

-- 1. Carrier tracking number captured when a seller marks an order shipped.
ALTER TABLE seller_order
  ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(60);

-- 2. Demo payment provider (the simulated "payment provider" page in the storefront).
INSERT INTO payment_provider (provider_code, display_name)
VALUES ('demo', 'Demo Payments')
ON CONFLICT (provider_code) DO NOTHING;

-- 3. Default exchange methods (delivery / pickup).
--    The schema guard trigger requires an admin as manager; resolve lazily so
--    this stays safe whether or not an admin already exists.
INSERT INTO exchange_method (managed_by_admin_id, name, description)
SELECT a.admin_id, m.name, m.description
FROM (VALUES ('Delivery', 'Courier delivery to your address'), ('Pickup', 'Collect at the seller''s locations'))
     AS m(name, description)
CROSS JOIN LATERAL (
  SELECT u.user_id AS admin_id
  FROM app_user u
  JOIN user_role ur ON ur.user_id = u.user_id
  JOIN app_role r   ON r.role_id  = ur.role_id
  WHERE r.role_name = 'admin'
  ORDER BY u.user_id
  LIMIT 1
) a
WHERE NOT EXISTS (SELECT 1 FROM exchange_method e WHERE e.name = m.name);

COMMIT;
