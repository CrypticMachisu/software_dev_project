import { env } from "./env.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * Sends one email. `MAIL_PROVIDER=resend` uses Resend's HTTP API (no SDK, no extra dependency);
 * the default `log` provider prints to the server console so development and demos work
 * without an account. In production `log` never prints the link, because logs are not private.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (env.mail.provider === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.mail.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.mail.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`mail provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (process.env.NODE_ENV === "production") {
    console.warn(`[mail] MAIL_PROVIDER is not configured; "${mail.subject}" to ${mail.to} was not sent.`);
    return;
  }
  console.log(`[mail:log] to=${mail.to}\n  subject: ${mail.subject}\n${mail.text.replace(/^/gm, "  ")}`);
}

export function passwordResetMail(to: string, name: string, link: string, minutes: number): Mail {
  const text =
    `Hello ${name},\n\n` +
    `Someone asked to reset the password for your M-DUKA account. Open this link to choose a new one ` +
    `(it works once and expires in ${minutes} minutes):\n\n${link}\n\n` +
    `If you did not ask for this, ignore this email. Your password stays the same.\n`;
  const html =
    `<p>Hello ${esc(name)},</p>` +
    `<p>Someone asked to reset the password for your M-DUKA account. ` +
    `<a href="${esc(link)}">Choose a new password</a>. The link works once and expires in ${minutes} minutes.</p>` +
    `<p>If you did not ask for this, ignore this email. Your password stays the same.</p>`;
  return { to, subject: "Reset your M-DUKA password", text, html };
}
