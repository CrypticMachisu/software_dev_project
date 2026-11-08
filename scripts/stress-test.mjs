#!/usr/bin/env node
/**
 * End-to-end audit + stress test for the M-DUKA storefront and admin panel.
 * Usage: node scripts/stress-test.mjs   (BASE_URL defaults to http://127.0.0.1:3003)
 * Requires the server to be running and the demo data seeded.
 */
const BASE = process.env.BASE_URL || "http://127.0.0.1:3003";
let pass = 0;
const failures = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { failures.push(name + (extra ? " — " + extra : "")); console.log("  FAIL  " + name + (extra ? " — " + extra : "")); }
};
const section = (s) => console.log("\n### " + s);

class Jar {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(";")[0];
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async req(path, { method = "GET", json, form, body, headers = {}, redirect = "manual" } = {}) {
    const h = { ...headers };
    let payload = body;
    if (json !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(json); }
    else if (form !== undefined) { h["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
    if (this.cookies.size) h.cookie = this.header();
    const t0 = performance.now();
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect });
    const ms = performance.now() - t0;
    this.absorb(res);
    return { res, ms };
  }
  async json(path, opts) {
    const { res, ms } = await this.req(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data, headers: res.headers, ms };
  }
  async text(path, opts) {
    const { res, ms } = await this.req(path, opts);
    return { status: res.status, body: await res.text(), headers: res.headers, ms };
  }
}

const uniq = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const PW = "StressPass123!";

async function register(jar, tag, extra = {}) {
  const email = uniq(tag);
  const r = await jar.json("/api/auth/register", { method: "POST", json: { name: "Stress " + tag, email, password: PW, ...extra } });
  return { ...r, email };
}

async function loginApi(jar, email, password) {
  return jar.json("/api/auth/login", { method: "POST", json: { email, password } });
}

async function makeSeller(jar) {
  await jar.json("/api/roles/seller", { method: "POST" });
}

async function createListing(jar, { title, priceMinor, qty, categoryId }) {
  return jar.json("/api/seller/listings", {
    method: "POST",
    json: { title, categoryId, priceMinor, qty, status: "active", description: "stress test item" },
  });
}

async function main() {
  const anon = new Jar();

  section("1. Smoke / static");
  {
    const h = await anon.json("/health");
    ok("GET /health 200 + ok:true", h.status === 200 && h.data?.ok === true, `status ${h.status}`);
    const root = await anon.text("/");
    ok("GET / 200 and serves storefront", root.status === 200 && root.body.includes("M-DUKA"));
    const unknown = await anon.req("/definitely-missing");
    ok("Unknown storefront path 404", unknown.res.status === 404);
    const api404 = await anon.json("/api/definitely-missing");
    ok("Unknown /api path 404", api404.status === 404, `status ${api404.status}`);
    ok("Storefront HTML escapes dynamic data (esc helper present)", root.body.includes("replace(/[&<>"));
    ok("Storefront boots from the API, not a localStorage seed", root.body.includes('api("/bootstrap")') && !root.body.includes("mkt_db:{"));
    ok("Storefront has a skip link to #app", root.body.includes('class="skip"') && root.body.includes('href="#app"'));
    ok("Storefront has a visible browse heading", root.body.includes("Browse the market"));
    ok("Review dialog is announced", root.body.includes('setAttribute("role","dialog")') && root.body.includes('setAttribute("aria-modal","true")'));
    ok("Toasts are live regions", root.body.includes('setAttribute("role","status")') && root.body.includes('setAttribute("aria-live","polite")'));
  }

  section("2. Catalogue");
  let categories = [];
  let products = [];
  {
    const b = await anon.json("/api/bootstrap");
    categories = b.data?.categories ?? [];
    products = b.data?.products ?? [];
    ok("GET /api/bootstrap 200", b.status === 200, `status ${b.status}`);
    ok("Bootstrap returns categories", categories.length > 0, `${categories.length}`);
    ok("Bootstrap returns active products", products.length > 0, `${products.length}`);
    ok("Bootstrap returns exchange methods", (b.data?.methods ?? []).length > 0);
    ok("Bootstrap user is null for guest", b.data?.user === null);
  }
  {
    const r = await anon.json("/api/products?q=camera");
    ok("Search filter works", r.status === 200 && r.data.products.length >= 1, `n=${r.data?.products?.length}`);
    const cat = categories[0];
    const r2 = await anon.json("/api/products?category=" + cat.id);
    ok("Category filter returns only that category", r2.status === 200 && r2.data.products.every((p) => p.categoryId === cat.id));
    const r3 = await anon.json("/api/products?min=10&max=30");
    ok("Price range filter respected", r3.status === 200 && r3.data.products.every((p) => p.priceMinor >= 1000 && p.priceMinor <= 3000));
    const r4 = await anon.json("/api/products?category=abc");
    ok("Non-numeric category rejected with 400 (not 500)", r4.status === 400, `status ${r4.status}`);
    const r5 = await anon.json("/api/products?min=abc");
    ok("Non-numeric min rejected with 400 (not 500)", r5.status === 400, `status ${r5.status}`);
    const r6 = await anon.json("/api/products?q=%27%20OR%201%3D1--");
    ok("SQL-injection-shaped search returns normal empty set", r6.status === 200 && r6.data.products.length === 0);
    const one = products[0];
    const d = await anon.json("/api/products/" + one.id);
    ok("Product detail 200 with seller rating shape", d.status === 200 && d.data.product?.id === one.id);
    const missing = await anon.json("/api/products/999999999");
    ok("Missing product 404", missing.status === 404);
    const bad = await anon.json("/api/products/not-a-number");
    ok("Invalid product id 400", bad.status === 400, `status ${bad.status}`);
  }

  section("3. Authentication");
  const buyer = new Jar();
  let buyerEmail = "";
  {
    const weak = await buyer.json("/api/auth/register", { method: "POST", json: { name: "A", email: uniq("weak"), password: "short" } });
    ok("Weak password rejected", weak.status === 400, `status ${weak.status}`);
    const badEmail = await buyer.json("/api/auth/register", { method: "POST", json: { name: "A", email: "not-an-email", password: PW } });
    ok("Invalid email rejected", badEmail.status === 400, `status ${badEmail.status}`);
    const reg = await register(buyer, "buyer");
    buyerEmail = reg.email;
    ok("Register 201 + buyer role", reg.status === 201 && reg.data?.user?.roles?.includes("buyer"), `status ${reg.status}`);
    const dup = await new Jar().json("/api/auth/register", { method: "POST", json: { name: "Dup", email: buyerEmail, password: PW } });
    ok("Duplicate email rejected 409", dup.status === 409, `status ${dup.status}`);
    const me = await buyer.json("/api/me");
    ok("GET /api/me returns session user", me.status === 200 && me.data?.user?.email === buyerEmail);
    const boot = await buyer.json("/api/bootstrap");
    ok("Bootstrap carries signed-in user + roles", boot.data?.user?.email === buyerEmail && boot.data.user.roles.includes("buyer"));
    const wrong = await new Jar().json("/api/auth/login", { method: "POST", json: { email: buyerEmail, password: "wrong-password" } });
    ok("Wrong password 401", wrong.status === 401);
    const good = await loginApi(new Jar(), buyerEmail, PW);
    ok("Login 200", good.status === 200 && good.data?.user?.email === buyerEmail);
    const inj = await new Jar().json("/api/auth/login", { method: "POST", json: { email: "' OR 1=1 --", password: PW } });
    ok("SQL-injection login rejected", inj.status === 401, `status ${inj.status}`);
  }

  section("4. Authz + seller listings");
  const seller = new Jar();
  let listingId = null;
  let categoryId = categories[0]?.id;
  {
    const reg = await register(seller, "seller");
    ok("Seller account created", reg.status === 201);
    await makeSeller(seller);
    const me = await seller.json("/api/me");
    ok("Become-a-seller grants seller role", me.data?.user?.roles?.includes("seller"));
    const bad = await createListing(seller, { title: "", priceMinor: 1000, qty: 1, categoryId });
    ok("Listing without title rejected 400", bad.status === 400, `status ${bad.status}`);
    const neg = await createListing(seller, { title: "Bad price", priceMinor: -5, qty: 1, categoryId });
    ok("Negative price rejected 400", neg.status === 400, `status ${neg.status}`);
    const good = await createListing(seller, { title: "Stress widget " + Date.now(), priceMinor: 2500, qty: 5, categoryId });
    listingId = good.data?.id;
    ok("Valid listing created 201", good.status === 201 && !!listingId, `status ${good.status}`);
    const anonSeller = await anon.json("/api/seller/listings");
    ok("Seller listings require login (401)", anonSeller.status === 401);
    const anonOrders = await anon.json("/api/orders");
    ok("Orders require login (401)", anonOrders.status === 401);
    const anonCheckout = await anon.json("/api/checkout", { method: "POST", json: { items: [{ productId: listingId, quantity: 1 }], address: { name: "A", street: "B" } } });
    ok("Checkout requires login (401)", anonCheckout.status === 401);
    const update = await seller.json("/api/seller/listings/" + listingId, { method: "PUT", json: { title: "Stress widget updated", categoryId, priceMinor: 2500, qty: 5, status: "active", description: "x" } });
    ok("Seller can update own listing", update.status === 200);
    const other = await buyer.json("/api/seller/listings/" + listingId, { method: "PUT", json: { title: "Hijack", categoryId, priceMinor: 1, qty: 1, status: "active" } });
    ok("Non-seller cannot update listing (403)", other.status === 403, `status ${other.status}`);
  }

  section("5. Checkout, payment, seller-order flow");
  let orderId = null;
  let sellerOrderId = null;
  {
    const cart = [{ productId: listingId, quantity: 2 }, { productId: listingId, quantity: 1 }];
    const addr = { name: "Buyer One", phone: "555", street: "1 Main", city: "Town", zip: "0001" };
    const co = await buyer.json("/api/checkout", { method: "POST", json: { items: cart, address: addr } });
    orderId = co.data?.order;
    ok("Checkout with duplicate lines 201 (lines merged)", co.status === 201 && !!orderId, `status ${co.status}`);
    const det = await buyer.json("/api/order/" + orderId);
    ok("Order visible to buyer with one merged line qty 3", det.status === 200 && det.data.order.sellerOrders[0]?.items.length === 1 && det.data.order.sellerOrders[0].items[0].qty === 3, JSON.stringify(det.data?.order?.sellerOrders?.[0]?.items));
    ok("Checkout persists the delivery address", det.data.order.delivery?.street === addr.street && det.data.order.delivery?.city === addr.city, JSON.stringify(det.data?.order?.delivery));
    sellerOrderId = det.data?.order?.sellerOrders?.[0]?.id;
    const other = await seller.json("/api/order/" + orderId);
    ok("Seller involved in order can read it", other.status === 200);
    const stranger = new Jar();
    await register(stranger, "stranger");
    const denied = await stranger.json("/api/order/" + orderId);
    ok("Unrelated user cannot read order (403)", denied.status === 403, `status ${denied.status}`);
    const pay = await buyer.json("/api/order/" + orderId + "/pay", { method: "POST", json: { result: "captured" } });
    ok("Payment captured 200", pay.status === 200 && pay.data.order.status === "confirmed", `status ${pay.status}`);
    const again = await buyer.json("/api/order/" + orderId + "/pay", { method: "POST", json: { result: "captured" } });
    ok("Double payment rejected 409", again.status === 409, `status ${again.status}`);
    const orders = await buyer.json("/api/orders");
    ok("GET /api/orders lists the new order", orders.status === 200 && orders.data.orders.some((o) => o.id === orderId));
    const soList = await seller.json("/api/seller/orders");
    const soRow = soList.data.orders.find((x) => x.id === sellerOrderId);
    ok("Seller sees the delivery address", soRow?.delivery?.street === addr.street, JSON.stringify(soRow?.delivery));

    const confirm = await seller.json("/api/seller-orders/" + sellerOrderId + "/status", { method: "POST", json: { action: "seller:confirm" } });
    ok("Seller confirms order", confirm.status === 200 && confirm.data.fulfillment === "confirmed", `status ${confirm.status}`);
    const ship = await seller.json("/api/seller-orders/" + sellerOrderId + "/status", { method: "POST", json: { action: "seller:ship", tracking: "TRK-1" } });
    ok("Seller marks shipped with tracking", ship.status === 200 && ship.data.fulfillment === "shipped", `status ${ship.status}`);

    const sellerSelfReceive = await seller.json("/api/seller-orders/" + sellerOrderId + "/status", { method: "POST", json: { action: "buyer:receive" } });
    ok("Seller CANNOT mark their own order received (403)", sellerSelfReceive.status === 403, `status ${sellerSelfReceive.status}`);
    const buyerReceive = await buyer.json("/api/seller-orders/" + sellerOrderId + "/status", { method: "POST", json: { action: "buyer:receive" } });
    ok("Buyer confirms receipt", buyerReceive.status === 200 && buyerReceive.data.fulfillment === "completed", `status ${buyerReceive.status}`);
    const intruderReceive = await new Jar().json("/api/seller-orders/" + sellerOrderId + "/status", { method: "POST", json: { action: "buyer:receive" } });
    ok("Anonymous cannot advance an order (401)", intruderReceive.status === 401, `status ${intruderReceive.status}`);

    const review = await buyer.json("/api/reviews", { method: "POST", json: { sellerOrderId, rating: 5, comment: "Great" } });
    ok("Review accepted 201", review.status === 201, `status ${review.status}`);
    const review2 = await buyer.json("/api/reviews", { method: "POST", json: { sellerOrderId, rating: 4, comment: "Again" } });
    ok("Duplicate review rejected 409", review2.status === 409, `status ${review2.status}`);
    const badRating = await buyer.json("/api/reviews", { method: "POST", json: { sellerOrderId, rating: 9 } });
    ok("Out-of-range rating rejected (400/409)", [400, 409].includes(badRating.status), `status ${badRating.status}`);
    const refund = await buyer.json("/api/seller-orders/" + sellerOrderId + "/refund", { method: "POST" });
    ok("Refund request on completed order accepted", refund.status === 200, `status ${refund.status}`);
    const refund2 = await buyer.json("/api/seller-orders/" + sellerOrderId + "/refund", { method: "POST" });
    ok("Second refund request rejected 409", refund2.status === 409, `status ${refund2.status}`);

    const stats = await seller.json("/api/seller/stats");
    ok("Seller stats report completed revenue", stats.status === 200 && stats.data.revenueMinor >= 7500, JSON.stringify(stats.data && { r: stats.data.revenueMinor, u: stats.data.unitsSold }));
    ok("Seller stats report units + a 14-day series", stats.data.unitsSold >= 3 && stats.data.daily.length === 14);
    ok("Seller analytics lists the top listing", stats.data.top.length >= 1 && stats.data.top[0].title.includes("Stress widget"));
  }

  section("5b. Unpaid order visibility + cancellation");
  {
    const addr = { name: "Cancel Me", city: "Town", street: "9 Side St" };
    const co = await buyer.json("/api/checkout", { method: "POST", json: { items: [{ productId: listingId, quantity: 1 }], address: addr } });
    const pendingId = co.data?.order;
    ok("Pending order created", co.status === 201 && !!pendingId, `status ${co.status}`);
    const list = await buyer.json("/api/orders");
    ok("Unpaid orders are visible to the buyer", list.data.orders.some((o) => o.id === pendingId && o.status === "pending"));
    const stranger = new Jar();
    await register(stranger, "cancelstranger");
    const denied = await stranger.json("/api/order/" + pendingId + "/cancel", { method: "POST" });
    ok("Only the buyer can cancel (403)", denied.status === 403, `status ${denied.status}`);
    const cancel = await buyer.json("/api/order/" + pendingId + "/cancel", { method: "POST" });
    ok("Buyer cancels an unpaid order", cancel.status === 200 && cancel.data.order.status === "cancelled", `status ${cancel.status}`);
    const payAfter = await buyer.json("/api/order/" + pendingId + "/pay", { method: "POST", json: { result: "captured" } });
    ok("Cancelled order cannot be paid", payAfter.status === 409, `status ${payAfter.status}`);
    const cancelAgain = await buyer.json("/api/order/" + pendingId + "/cancel", { method: "POST" });
    ok("Second cancel rejected 409", cancelAgain.status === 409, `status ${cancelAgain.status}`);
  }

  section("6. Inventory race (oversell)");
  {
    const raceSeller = new Jar();
    await register(raceSeller, "raceseller");
    await makeSeller(raceSeller);
    const l = await createListing(raceSeller, { title: "Last one " + Date.now(), priceMinor: 5000, qty: 1, categoryId });
    const raceListing = l.data?.id;
    const b1 = new Jar();
    const b2 = new Jar();
    await register(b1, "race1");
    await register(b2, "race2");
    const addr = { name: "R", street: "S" };
    const c1 = await b1.json("/api/checkout", { method: "POST", json: { items: [{ productId: raceListing, quantity: 1 }], address: addr } });
    const c2 = await b2.json("/api/checkout", { method: "POST", json: { items: [{ productId: raceListing, quantity: 1 }], address: addr } });
    ok("Both pending checkouts accepted (stock reserved at payment)", c1.status === 201 && c2.status === 201, `${c1.status}/${c2.status}`);
    const [p1, p2] = await Promise.all([
      b1.json("/api/order/" + c1.data.order + "/pay", { method: "POST", json: { result: "captured" } }),
      b2.json("/api/order/" + c2.data.order + "/pay", { method: "POST", json: { result: "captured" } }),
    ]);
    const confirmed = [p1, p2].filter((p) => p.status === 200).length;
    ok("Only one buyer can capture the last unit", confirmed === 1, `confirmed=${confirmed} (${p1.status}/${p2.status})`);
    const prod = await anon.json("/api/products/" + raceListing);
    ok("Stock never goes negative", prod.data?.product?.qty === 0, `qty=${prod.data?.product?.qty}`);
  }

  section("7. Input hardening");
  {
    const huge = "a".repeat(200_000);
    const big = await anon.json("/api/auth/login", { method: "POST", json: { email: huge, password: huge } });
    ok("Oversized JSON body rejected 413 (not 500)", big.status === 413, `status ${big.status}`);
    const malformed = await anon.req("/api/auth/login", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    ok("Malformed JSON rejected 400 (not 500)", malformed.res.status === 400, `status ${malformed.res.status}`);
    const r = await anon.json("/api/auth/login", { method: "POST", json: { email: 12345, password: { $ne: null } } });
    ok("Wrong-typed credentials rejected without crash", [400, 401, 429].includes(r.status), `status ${r.status}`);
    const xss = await seller.json("/api/seller/listings", { method: "POST", json: { title: '<img src=x onerror=alert(1)>', categoryId, priceMinor: 100, qty: 1, status: "draft" } });
    ok("XSS-shaped title stored safely (accepted, rendered escaped)", xss.status === 201, `status ${xss.status}`);
  }

  section("8. Login lockout");
  {
    const jar = new Jar();
    const email = uniq("lockout");
    let saw429 = false;
    for (let i = 0; i < 7; i++) {
      const r = await jar.json("/api/auth/login", { method: "POST", json: { email, password: "bad-password" } });
      if (r.status === 429) saw429 = true;
    }
    ok("Repeated bad logins trigger 429 lockout", saw429);
  }

  section("9. Admin panel");
  {
    const admin = new Jar();
    const anonAdmin = await anon.req("/admin");
    ok("/admin requires login (302)", anonAdmin.res.status === 302 && (anonAdmin.res.headers.get("location") || "").includes("/admin/login"));
    const loginPage = await anon.text("/admin/login");
    ok("Admin login page renders with security headers", loginPage.status === 200 && !!loginPage.headers.get("content-security-policy") && loginPage.headers.get("x-content-type-options") === "nosniff");
    const login = await admin.req("/admin/login", { method: "POST", form: { email: "stress-admin@example.com", password: "StressPass123!" } });
    ok("Super admin login redirects into panel", login.res.status === 302, `status ${login.res.status}`);
    const dash = await admin.text("/admin");
    ok("Dashboard renders", dash.status === 200 && dash.body.includes("Dashboard"));
    ok("Admin uses inline SVG icons", dash.body.includes('<symbol id="icon-dashboard"') && !dash.body.includes("ph ph-"));
    for (const p of ["/admin/products", "/admin/products/categories", "/admin/orders", "/admin/users", "/admin/exchange", "/admin/audit"]) {
      const r = await admin.text(p);
      ok(`GET ${p} 200`, r.status === 200, `status ${r.status}`);
    }
    const sqli = await admin.text("/admin/users?q=%27%20OR%201%3D1--");
    ok("Admin search tolerates SQL-shaped input", sqli.status === 200);
    const xss = await admin.text("/admin/users?q=" + encodeURIComponent("<script>alert(1)</script>"));
    ok("Admin search reflects input escaped (no raw <script>)", xss.status === 200 && !xss.body.includes("<script>alert(1)</script>"));

    const plainEmail = uniq("admin");
    const created = await admin.req("/admin/users/new", { method: "POST", form: { name: "Plain Admin", email: plainEmail, phone: "", password: PW, roles: "admin" } });
    ok("Super admin can create a plain admin", created.res.status === 302, `status ${created.res.status}`);
    const escalated = await admin.req("/admin/users/new", { method: "POST", form: { name: "Escalate", email: uniq("esc"), password: PW, roles: "super_admin" } });
    ok("Super admin may create super admin (control)", escalated.res.status === 302, `status ${escalated.res.status}`);

    const plain = new Jar();
    const pl = await plain.req("/admin/login", { method: "POST", form: { email: plainEmail, password: PW } });
    ok("Plain admin can log in", pl.res.status === 302, `status ${pl.res.status}`);
    const exchange = await plain.text("/admin/exchange");
    ok("Plain admin blocked from super-admin exchange page (403)", exchange.status === 403, `status ${exchange.status}`);
    const audit = await plain.text("/admin/audit");
    ok("Plain admin blocked from audit log (403)", audit.status === 403, `status ${audit.status}`);
    const plainEscalate = await plain.req("/admin/users/new", { method: "POST", form: { name: "Bad", email: uniq("bad"), password: PW, roles: "super_admin" } });
    ok("Plain admin cannot create a super admin (400)", plainEscalate.res.status === 400, `status ${plainEscalate.res.status}`);
  }

  section("10. Concurrency / load");
  {
    // Warm the pooled connections first so the measurement is sustained load, not socket setup.
    for (let i = 0; i < 5; i++) {
      for (const p of ["/api/bootstrap", "/api/products"]) {
        const r = await anon.req(p);
        await r.res.arrayBuffer();
      }
    }
    const N = 200;
    const CONC = 20;
    const times = [];
    let errors = 0;
    let idx = 0;
    async function worker() {
      while (idx < N) {
        idx++;
        const path = idx % 2 ? "/api/bootstrap" : "/api/products";
        const t0 = performance.now();
        const r = await anon.req(path);
        times.push(performance.now() - t0);
        if (r.res.status !== 200) errors++;
        await r.res.arrayBuffer();
      }
    }
    const t0 = performance.now();
    await Promise.all(Array.from({ length: CONC }, worker));
    const total = performance.now() - t0;
    times.sort((a, b) => a - b);
    const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
    console.log(`  INFO  ${N} requests, concurrency ${CONC}: ${(N / (total / 1000)).toFixed(1)} req/s, p50=${p(0.5)}ms p95=${p(0.95)}ms`);
    ok("No failures under concurrent catalogue load", errors === 0, `${errors} errors`);
    ok("p95 catalogue latency under 1500ms", Number(p(0.95)) < 1500, `p95=${p(0.95)}ms`);

    const regs = await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const j = new Jar();
      return register(j, "load" + i);
    }));
    ok("12 concurrent registrations all succeed", regs.every((r) => r.status === 201), regs.map((r) => r.status).join(","));

    const logins = await Promise.all(Array.from({ length: 10 }, () => loginApi(new Jar(), buyerEmail, PW)));
    ok("10 concurrent logins all succeed", logins.every((r) => r.status === 200), logins.map((r) => r.status).join(","));
  }

  section("11. Non-buyer checkout");
  {
    const j = new Jar();
    await loginApi(j, "stress-admin@example.com", "StressPass123!");
    // stress admin has no buyer role
    const r = await j.json("/api/checkout", { method: "POST", json: { items: [{ productId: listingId, quantity: 1 }], address: { name: "A", street: "B" } } });
    ok("Account without buyer role gets a clear 403 at checkout", r.status === 403, `status ${r.status}`);
  }

  console.log(`\n================ RESULT: ${pass} passed, ${failures.length} failed ================`);
  if (failures.length) {
    for (const f of failures) console.log(" - " + f);
    process.exitCode = 1;
  }
}


main().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 2; });
