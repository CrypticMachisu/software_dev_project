/**
 * Safaricom Daraja client for M-Pesa Express (STK Push).
 *
 * The sandbox needs only a free developer account: create an app, enable the
 * "M-Pesa Express" product, and use shortcode 174379 plus the sandbox passkey.
 * Real money needs a paybill and a registered business ("Go Live").
 *
 * Docs: https://developer.safaricom.co.ke
 */
export interface MpesaSettings {
  environment: "sandbox" | "production";
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
}

const BASE_URL: Record<MpesaSettings["environment"], string> = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
};

const TIMEOUT_MS = 15_000;

/** Anything M-Pesa will accept as a Safaricom number, as 2547XXXXXXXX. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^254(7\d{8}|1\d{8})$/.test(digits)) return digits;
  if (/^0(7\d{8}|1\d{8})$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^(7\d{8}|1\d{8})$/.test(digits)) return `254${digits}`;
  return null;
}

/** Daraja expects base64(shortcode + passkey + timestamp) with timestamp YYYYMMDDHHmmss. */
export function stkPassword(shortcode: string, passkey: string): { password: string; timestamp: string } {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const timestamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return { password: Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64"), timestamp };
}

// Daraja tokens last an hour; refreshing per request hits their rate limits.
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function accessToken(s: MpesaSettings): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const basic = Buffer.from(`${s.consumerKey}:${s.consumerSecret}`).toString("base64");
  const res = await fetch(`${BASE_URL[s.environment]}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`M-Pesa OAuth ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { access_token?: string; expires_in?: string };
  if (!body.access_token) throw new Error(`M-Pesa OAuth returned no token: ${text.slice(0, 200)}`);
  const ttl = (Number(body.expires_in ?? 3599) - 120) * 1000;
  tokenCache = { token: body.access_token, expiresAt: Date.now() + ttl };
  return tokenCache.token;
}

export interface StkPushInput {
  /** 2547XXXXXXXX */
  phone: string;
  /** Whole shillings: M-Pesa does not accept decimals. */
  amount: number;
  accountRef: string;
  description: string;
}

export interface StkPushResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  customerMessage: string;
}

export async function stkPush(s: MpesaSettings, input: StkPushInput): Promise<StkPushResult> {
  const token = await accessToken(s);
  const { password, timestamp } = stkPassword(s.shortcode, s.passkey);
  const res = await fetch(`${BASE_URL[s.environment]}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: s.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(input.amount),
      PartyA: input.phone,
      PartyB: s.shortcode,
      PhoneNumber: input.phone,
      CallBackURL: s.callbackUrl,
      // Daraja rejects longer values: 12 characters for the reference, 13 for the description.
      AccountReference: input.accountRef.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok || !body) throw new Error(`M-Pesa STK Push ${res.status}: ${text.slice(0, 300)}`);
  const checkoutRequestId = String(body.CheckoutRequestID ?? "");
  if (String(body.ResponseCode ?? "") !== "0" || !checkoutRequestId) {
    const reason = String(body.errorMessage ?? body.ResponseDescription ?? text);
    throw new Error(`M-Pesa rejected the STK Push: ${reason.slice(0, 200)}`);
  }
  return {
    checkoutRequestId,
    merchantRequestId: String(body.MerchantRequestID ?? ""),
    customerMessage: String(body.CustomerMessage ?? "Check your phone for the M-Pesa prompt."),
  };
}

export interface MpesaCallback {
  checkoutRequestId: string;
  merchantRequestId: string;
  resultCode: number;
  resultDesc: string;
  receipt: string | null;
  amount: number | null;
  phone: string | null;
}

/** Reads the STK result Daraja posts to the callback URL. Returns null when the body is not one. */
export function parseCallback(body: unknown): MpesaCallback | null {
  const stk = (body as { Body?: { stkCallback?: Record<string, unknown> } } | null)?.Body?.stkCallback;
  if (!stk || typeof stk !== "object") return null;
  const checkoutRequestId = String(stk.CheckoutRequestID ?? "");
  if (!checkoutRequestId) return null;

  const raw = (stk.CallbackMetadata as { Item?: unknown } | undefined)?.Item;
  const items: { Name?: string; Value?: unknown }[] = Array.isArray(raw) ? raw : [];
  const value = (name: string): unknown => items.find((i) => i?.Name === name)?.Value;

  const receipt = value("MpesaReceiptNumber");
  const amount = value("Amount");
  const phone = value("PhoneNumber");
  return {
    checkoutRequestId,
    merchantRequestId: String(stk.MerchantRequestID ?? ""),
    resultCode: Number(stk.ResultCode ?? -1),
    resultDesc: String(stk.ResultDesc ?? ""),
    receipt: typeof receipt === "string" && receipt ? receipt : null,
    amount: typeof amount === "number" ? amount : null,
    phone: phone === undefined || phone === null ? null : String(phone),
  };
}
