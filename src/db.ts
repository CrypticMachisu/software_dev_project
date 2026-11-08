import pg from "pg";
import { env } from "./env.js";

const { Pool, Client } = pg;
const ssl = env.postgres.ssl ? { rejectUnauthorized: true } : false;

/** Application traffic. */
export const pool = new Pool({
  connectionString: env.postgres.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  ssl,
});
// An idle client can lose its connection (serverless database restarts); log it instead of crashing.
pool.on("error", (err) => console.error("idle postgres client error", err));

/** Schema / migration work. */
export function unpooledClient(): pg.Client {
  return new Client({ connectionString: env.postgres.databaseUrlUnpooled, ssl });
}
