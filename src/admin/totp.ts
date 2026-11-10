import crypto from "node:crypto";

/**
 * TOTP (RFC 6238) with the base32 secrets that authenticator apps expect.
 * Kept dependency-free: HMAC-SHA1, 6 digits, 30-second steps, one step of drift.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

/** 160 random bits, base32 without padding (what Google Authenticator and friends scan). */
export function generateSecret(bytes = 20): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of crypto.randomBytes(bytes)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The 6-digit code for a given 30-second counter. */
export function codeAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const currentStep = (now = Date.now()): number => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Returns the matched counter, or null. `window` allows clock drift in both directions.
 * The caller must also refuse a counter it has already accepted to block replay.
 */
export function verifyCode(secret: string, input: string, window = 1, now = Date.now()): number | null {
  const code = input.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code) || !secret) return null;
  const step = currentStep(now);
  const given = Buffer.from(code);
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(codeAt(secret, step + drift));
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return step + drift;
  }
  return null;
}

/** otpauth:// URI for the authenticator app. Issuer and account are shown in the app. */
export function otpauthUri(secret: string, account: string, issuer = "M-DUKA"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
