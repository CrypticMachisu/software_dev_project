// Reads plain Postgres settings from .env (no Neon dependency).
const currencyRaw = (process.env.APP_CURRENCY ?? "USD").trim().toUpperCase();
const providerRaw = (process.env.PAYMENT_PROVIDER ?? "demo").trim().toLowerCase();
const mpesaEnvRaw = (process.env.MPESA_ENV ?? "sandbox").trim().toLowerCase();

export const env = {
  branch: null as { name: string } | null,
  currency: /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : "USD",
  postgres: {
    databaseUrl: process.env.DATABASE_URL ?? "",
    databaseUrlUnpooled: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
    ssl: process.env.DATABASE_SSL === "true",
  },
  payments: {
    /** "demo" simulates the provider; "mpesa" sends a real (or sandbox) STK Push. */
    provider: (providerRaw === "mpesa" ? "mpesa" : "demo") as "demo" | "mpesa",
    mpesa: {
      environment: (mpesaEnvRaw === "production" ? "production" : "sandbox") as "sandbox" | "production",
      consumerKey: (process.env.MPESA_CONSUMER_KEY ?? "").trim(),
      consumerSecret: (process.env.MPESA_CONSUMER_SECRET ?? "").trim(),
      shortcode: (process.env.MPESA_SHORTCODE ?? "174379").trim(),
      passkey: (process.env.MPESA_PASSKEY ?? "").trim(),
      callbackUrl: (process.env.MPESA_CALLBACK_URL ?? "").trim(),
    },
  },
};
if (!env.postgres.databaseUrl) throw new Error("DATABASE_URL is missing from .env");

if (env.payments.provider === "mpesa") {
  const m = env.payments.mpesa;
  const missing = (["consumerKey", "consumerSecret", "passkey", "callbackUrl"] as const)
    .filter((key) => !m[key])
    .map((key) => `MPESA_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`);
  if (missing.length) {
    throw new Error(`PAYMENT_PROVIDER=mpesa needs ${missing.join(", ")} in .env`);
  }
  if (!/^https?:\/\//i.test(m.callbackUrl)) {
    throw new Error("MPESA_CALLBACK_URL must be a full http(s) URL.");
  }
  if (/localhost|127\.0\.0\.1/i.test(m.callbackUrl)) {
    throw new Error("MPESA_CALLBACK_URL cannot be localhost; expose the app with ngrok and use the public URL.");
  }
  // M-Pesa charges Kenya shillings only, in whole shillings.
  if (env.currency !== "KES") {
    throw new Error("M-Pesa charges in KES, so set APP_CURRENCY=KES when PAYMENT_PROVIDER=mpesa.");
  }
}
