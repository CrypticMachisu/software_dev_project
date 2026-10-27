import pg from "pg";
import { env } from "./env.js";

const { Pool, Client } = pg;
const ssl = env.postgres.ssl ? { rejectUnauthorized: true } : false;

/** Application traffic. */
export const pool = new Pool({ connectionString: env.postgres.databaseUrl, max: 10, ssl });

/** Schema / migration work. */
export function unpooledClient(): pg.Client {
  return new Client({ connectionString: env.postgres.databaseUrlUnpooled, ssl });
}
