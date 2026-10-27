// Reads plain Postgres settings from .env (no Neon dependency).
export const env = {
  branch: null as { name: string } | null,
  postgres: {
    databaseUrl: process.env.DATABASE_URL ?? "",
    databaseUrlUnpooled: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
    ssl: process.env.DATABASE_SSL === "true",
  },
};
if (!env.postgres.databaseUrl) throw new Error("DATABASE_URL is missing from .env");
