import pg from "pg";
import { env } from "./env.js";

const { Pool, Client } = pg;

/** Application traffic: pooled Neon URL (PgBouncer). */
export const pool = new Pool({
  connectionString: env.postgres.databaseUrl,
  max: 10,
  ssl: { rejectUnauthorized: true },
});

/** Schema / session work: direct unpooled URL. */
export function unpooledClient(): pg.Client {
  return new Client({
    connectionString: env.postgres.databaseUrlUnpooled,
    ssl: { rejectUnauthorized: true },
  });
}
