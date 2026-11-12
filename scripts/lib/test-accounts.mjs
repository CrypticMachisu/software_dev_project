/**
 * Safe cleanup for accounts created by the regression, UI, and stress harnesses.
 *
 * Only email addresses matching the generators in those scripts are eligible.
 * Deleting an account also removes its listings, orders, payments, reviews, and
 * sessions, because most of the schema's user references are RESTRICT rather
 * than CASCADE. Everything happens in one transaction.
 */
import { loadEnvFile } from "node:process";
import pg from "pg";

// Local runs keep database credentials in .env. CI supplies real env vars.
try { loadEnvFile(); } catch { /* no .env, use the process environment */ }

const TEST_EMAIL_PATTERNS = [
  /^ui-(?:buyer|seller|delivery)-\d+@example\.com$/i,
  /^(?:pickupseller|pickupbuyer|deliveryseller|stockseller|buyer|seller|stranger|cancelstranger|raceseller|race1|race2|load\d+|lockout|esc|bad|weak|admin)-\d+-[a-z0-9]+@example\.com$/i,
];

/** True only for addresses produced by the test harnesses. */
export function isTestEmail(email) {
  return TEST_EMAIL_PATTERNS.some((pattern) => pattern.test(email));
}

function normalizeEmails(emails) {
  const wanted = [...new Set(emails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))];
  const refused = wanted.filter((email) => !isTestEmail(email));
  if (refused.length) {
    throw new Error("Refusing to delete non-test accounts: " + refused.join(", "));
  }
  return wanted;
}

function connectionOptions() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to clean test accounts.");
  }
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
  };
}

async function withClient(fn) {
  const client = new pg.Client(connectionOptions());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** All existing accounts that match a known test-account prefix. */
export async function findTestAccountsWithClient(client) {
  const { rows } = await client.query("SELECT email FROM app_user");
  return rows
    .map((row) => String(row.email).trim().toLowerCase())
    .filter(isTestEmail)
    .sort();
}

export async function findTestAccounts() {
  return withClient(findTestAccountsWithClient);
}

/**
 * Delete the named test accounts and everything that belongs to them.
 * The caller owns the client and must keep it on one session for the transaction.
 */
export async function deleteTestAccountsWithClient(client, emails) {
  const wanted = normalizeEmails(emails);
  if (!wanted.length) return { deleted: 0, emails: [] };

  await client.query("BEGIN");
  try {
    // pg uses the extended protocol for parameterized queries, so keep each
    // $1-containing statement separate instead of combining it with DDL.
    await client.query(`
      CREATE TEMP TABLE cleanup_users (user_id BIGINT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE cleanup_orders (order_id BIGINT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE cleanup_seller_orders (seller_order_id BIGINT PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMP TABLE cleanup_payments (payment_id BIGINT PRIMARY KEY) ON COMMIT DROP;
    `);
    await client.query(
      `INSERT INTO cleanup_users (user_id)
       SELECT user_id FROM app_user WHERE lower(email) = ANY($1::text[])`,
      [wanted],
    );
    await client.query(`
      INSERT INTO cleanup_orders (order_id)
      SELECT order_id FROM market_order WHERE buyer_id IN (SELECT user_id FROM cleanup_users)
      UNION
      SELECT order_id FROM seller_order WHERE seller_id IN (SELECT user_id FROM cleanup_users)
      UNION
      SELECT order_id FROM order_item WHERE seller_id_snapshot IN (SELECT user_id FROM cleanup_users);

      INSERT INTO cleanup_seller_orders (seller_order_id)
      SELECT seller_order_id FROM seller_order
      WHERE seller_id IN (SELECT user_id FROM cleanup_users)
         OR order_id IN (SELECT order_id FROM cleanup_orders);

      INSERT INTO cleanup_payments (payment_id)
      SELECT payment_id FROM payment WHERE order_id IN (SELECT order_id FROM cleanup_orders);
    `);

    const found = await client.query(
      `SELECT u.email FROM app_user u JOIN cleanup_users c USING (user_id) ORDER BY u.email`,
    );

    // Children with RESTRICT references must go before their parents.
    await client.query(`
      DELETE FROM review
      WHERE seller_order_id IN (SELECT seller_order_id FROM cleanup_seller_orders)
         OR buyer_id IN (SELECT user_id FROM cleanup_users)
         OR seller_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM refund
      WHERE payment_id IN (SELECT payment_id FROM cleanup_payments)
         OR seller_order_id IN (SELECT seller_order_id FROM cleanup_seller_orders);

      DELETE FROM dispute
      WHERE payment_id IN (SELECT payment_id FROM cleanup_payments)
         OR seller_order_id IN (SELECT seller_order_id FROM cleanup_seller_orders);

      DELETE FROM payout
      WHERE seller_order_id IN (SELECT seller_order_id FROM cleanup_seller_orders);

      DELETE FROM payment_allocation
      WHERE payment_id IN (SELECT payment_id FROM cleanup_payments)
         OR seller_order_id IN (SELECT seller_order_id FROM cleanup_seller_orders);

      DELETE FROM payment
      WHERE payment_id IN (SELECT payment_id FROM cleanup_payments);

      DELETE FROM seller_order_item
      WHERE seller_order_id IN (SELECT seller_order_id FROM cleanup_seller_orders)
         OR order_item_id IN (
           SELECT order_item_id FROM order_item
           WHERE order_id IN (SELECT order_id FROM cleanup_orders)
         );

      DELETE FROM seller_order
      WHERE seller_order_id IN (SELECT seller_order_id FROM cleanup_seller_orders);

      DELETE FROM order_item
      WHERE order_id IN (SELECT order_id FROM cleanup_orders);

      DELETE FROM market_order
      WHERE order_id IN (SELECT order_id FROM cleanup_orders);

      DELETE FROM product
      WHERE seller_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM seller_payment_account
      WHERE seller_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM seller_pickup_detail
      WHERE seller_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM seller_exchange_method
      WHERE seller_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM audit_log
      WHERE user_id IN (SELECT user_id FROM cleanup_users);
    `);

    // A test admin may own a managed exchange method; keep the method and
    // hand it to a surviving admin instead of blocking the account deletion.
    const managed = await client.query(
      `SELECT count(*)::int AS n FROM exchange_method
       WHERE managed_by_admin_id IN (SELECT user_id FROM cleanup_users)`,
    );
    if (managed.rows[0].n > 0) {
      const replacement = await client.query(
        `SELECT u.user_id
         FROM app_user u
         JOIN user_role ur ON ur.user_id = u.user_id AND ur.approval_status = 'approved'
         JOIN app_role r ON r.role_id = ur.role_id AND r.role_name = 'admin'
         WHERE u.user_id NOT IN (SELECT user_id FROM cleanup_users)
         ORDER BY u.user_id
         LIMIT 1`,
      );
      if (!replacement.rows.length) {
        throw new Error("A test admin owns an exchange method, but no other admin is available to own it.");
      }
      await client.query(
        `UPDATE exchange_method SET managed_by_admin_id = $1
         WHERE managed_by_admin_id IN (SELECT user_id FROM cleanup_users)`,
        [replacement.rows[0].user_id],
      );
    }

    await client.query(`
      DELETE FROM password_reset
      WHERE user_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM auth_session
      WHERE user_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM user_role
      WHERE user_id IN (SELECT user_id FROM cleanup_users);

      DELETE FROM app_user
      WHERE user_id IN (SELECT user_id FROM cleanup_users);
    `);

    await client.query("COMMIT");
    return { deleted: found.rows.length, emails: found.rows.map((row) => row.email) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Delete the named test accounts using the normal Postgres connection. */
export async function cleanupTestAccounts(emails) {
  const wanted = normalizeEmails(emails);
  if (!wanted.length) return { deleted: 0, emails: [] };
  return withClient((client) => deleteTestAccountsWithClient(client, wanted));
}
