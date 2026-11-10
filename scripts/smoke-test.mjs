#!/usr/bin/env node
/**
 * Post-deploy smoke test: the five things to prove on the LIVE URL before presenting.
 *
 *   BASE_URL=https://your-app.example.com \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... \            # optional: checks admin sign-in
 *   MPESA_CALLBACK_SECRET=...                       # optional: checks the M-Pesa callback route
 *   node scripts/smoke-test.mjs
 *
 * It registers one throw-away buyer (smoke-*@example.com) and places one small order, so run it
 * against a staging or demo database, not against real customer data. Exit code 1 on any failure.
 * Admin accounts with two-factor enabled cannot be used here; the script reports that and moves on.
 */
const BASE = (process.env.BASE_URL || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(BASE)) { console.error("Set BASE_URL, for example BASE_URL=https://mduka.onrender.com"); process.exit(2); }
const { ADMIN_EMAIL, ADMIN_PASSWORD, MPESA_CALLBACK_SECRET } = process.env;

let passed = 0, skipped = 0;
const failed = [];
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed.push(name); console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
};
const skip = (name, why) => { skipped++; console.log("  SKIP  " + name + "  (" + why + ")"); };

class Jar {
  cookies = new Map();
  csrf = null;
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async req(path, { method = "GET", json, form, headers = {} } = {}) {
    const h = { ...headers };
    let body;
    if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
    if (form !== undefined) { h["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.csrf && method !== "GET" && path.startsWith("/api/")) h["x-csrf-token"] = this.csrf;
    const res = await fetch(BASE + path, { method, headers: h, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    this.absorb(res);
    return res;
  }
  async json(path, opts) {
    const res = await this.req(path, opts);
    const data = await res.json().catch(() => null);
    if (data && "csrfToken" in data) this.csrf = data.csrfToken;
    return { status: res.status, data };
  }
}

const stamp = Date.now();
const PASSWORD = "Smoke-Pass-" + stamp;

async function main() {
  console.log(`Smoke test against ${BASE}\n`);

  console.log("1. Health");
  const anon = new Jar();
  const health = await anon.json("/health");
  check("GET /health is 200 {ok:true} (database reachable)", health.status === 200 && health.data?.ok === true, `status ${health.status}`);
  check("/health tells strangers nothing else", health.data && Object.keys(health.data).length === 1, JSON.stringify(health.data));
  const home = await anon.req("/");
  check("Storefront page loads over the live URL", home.status === 200 && (await home.text()).includes("M-DUKA"));
  if (!BASE.startsWith("https://")) console.log("  NOTE  BASE_URL is not https: the session cookie is only marked Secure behind HTTPS");

  console.log("\n2. Catalogue");
  const boot = await anon.json("/api/bootstrap");
  const products = boot.data?.products ?? [];
  check("/api/bootstrap returns products and categories", boot.status === 200 && products.length > 0 && (boot.data?.categories?.length ?? 0) > 0, `products ${products.length}`);
  const provider = boot.data?.payment?.provider ?? "demo";
  console.log(`  NOTE  payment provider on this deployment: ${provider}`);

  console.log("\n3. Admin sign-in");
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    skip("admin sign-in", "set ADMIN_EMAIL and ADMIN_PASSWORD");
  } else {
    const loginPage = await anon.req("/admin/login");
    check("GET /admin/login renders", loginPage.status === 200);
    const admin = new Jar();
    const res = await admin.req("/admin/login", { method: "POST", form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const loc = res.headers.get("location") || "";
    if (loc === "/admin/2fa") skip("admin dashboard", "this account has two-factor enabled; sign-in step 1 passed");
    else {
      check("Admin sign-in redirects into the panel", res.status === 302 && loc === "/admin", `status ${res.status} ${loc}`);
      const dash = await admin.req("/admin");
      check("Dashboard loads with the session", dash.status === 200);
      const out = await admin.req("/admin/users");
      check("Users page loads (database read through the panel)", out.status === 200);
    }
  }

  console.log("\n4. Register, check out and pay");
  const buyer = new Jar();
  const reg = await buyer.json("/api/auth/register", { method: "POST", json: { name: "Smoke Buyer", email: `smoke-${stamp}@example.com`, password: PASSWORD } });
  check("Registration works on the live site", reg.status === 201, `status ${reg.status} ${JSON.stringify(reg.data)}`);
  const product = products.find((p) => p.qty > 0);
  if (!product) {
    skip("checkout", "no in-stock product (run npm run demo:seed)");
  } else if (reg.status === 201) {
    const co = await buyer.json("/api/checkout", {
      method: "POST",
      json: { items: [{ productId: product.id, quantity: 1 }], address: { name: "Smoke Buyer", phone: "0700000000", street: "1 Test Street", city: "Nairobi" }, methods: {} },
    });
    check("Checkout creates an order", co.status === 201 && co.data?.order, `status ${co.status} ${JSON.stringify(co.data)}`);
    if (co.data?.order) {
      if (provider === "mpesa") {
        skip("payment", "M-Pesa needs a real STK prompt on a phone; pay this order from the storefront to finish");
        console.log(`  NOTE  order ${co.data.order} is waiting for payment at ${BASE}/#/pay/${co.data.order}`);
      } else {
        const pay = await buyer.json(`/api/order/${co.data.order}/pay`, { method: "POST", json: { result: "captured" } });
        check("Payment captures and the order is confirmed", pay.status === 200 && pay.data?.order?.status === "confirmed", `status ${pay.status} ${JSON.stringify(pay.data)}`);
        const orders = await buyer.json("/api/orders?page=1");
        check("The order appears in the buyer's paginated list", orders.status === 200 && orders.data?.orders?.some((o) => String(o.id) === String(co.data.order)));
      }
    }
  }

  console.log("\n5. M-Pesa callback route");
  if (!MPESA_CALLBACK_SECRET) {
    skip("callback route", "set MPESA_CALLBACK_SECRET to test it (the same value as on the server)");
  } else {
    const junk = { Body: { stkCallback: { CheckoutRequestID: "smoke-unknown-" + stamp, ResultCode: 0, ResultDesc: "smoke" } } };
    const wrong = await anon.req("/api/webhooks/mpesa/not-the-secret", { method: "POST", json: junk });
    check("Callback with a wrong secret is refused (404)", wrong.status === 404, `status ${wrong.status}`);
    const right = await anon.req(`/api/webhooks/mpesa/${encodeURIComponent(MPESA_CALLBACK_SECRET)}`, { method: "POST", json: junk });
    check("Callback with the right secret is acknowledged (200)", right.status === 200, `status ${right.status}`);
    console.log(`  NOTE  register this exact URL with Daraja: ${BASE}/api/webhooks/mpesa/<your secret>`);
  }

  console.log("\n6. Security headers");
  const h = await anon.req("/");
  check("Storefront sends X-Frame-Options and nosniff", !!h.headers.get("x-frame-options") && h.headers.get("x-content-type-options") === "nosniff");
  const adminHead = await anon.req("/admin/login");
  check("Admin sends a Content-Security-Policy", !!adminHead.headers.get("content-security-policy"));
}

try { await main(); }
catch (e) { console.error("\nHARNESS ERROR:", e instanceof Error ? e.message : e); process.exitCode = 2; }
console.log(`\n${passed} passed, ${failed.length} failed, ${skipped} skipped`);
if (failed.length) { failed.forEach((f) => console.log(" - " + f)); process.exitCode = process.exitCode || 1; }
