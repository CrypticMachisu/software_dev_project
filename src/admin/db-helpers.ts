import type pg from "pg";
import { pool } from "../db.js";

/** Anything with a query(text, params) method: a pool, a transaction client, or our query helper. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/** Always pass values as $1, $2... parameters, never build SQL from strings. */
export function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return pool.query<R>(text, params);
}

/** Runs fn inside BEGIN/COMMIT. Any error rolls everything back. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Writes one audit_log row. Pass the transaction client so it commits or rolls back with the change. */
export async function logAction(
  q: Queryable,
  userId: string | number,
  action: string,
  targetTable: string | null,
  targetId: string | number | null,
  ip: string | undefined,
  details: string | null = null,
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (user_id, action, target_table, target_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, targetTable, targetId, ip ?? null, details],
  );
}
