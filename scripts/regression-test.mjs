#!/usr/bin/env node
/**
 * Focused regression tests for the storefront changes.
 * Usage: node scripts/regression-test.mjs   (BASE_URL defaults to http://127.0.0.1:3003)
 * Requires a running server and the demo data seeded.
 *
 * Covers: seller-specific exchange methods, pickup details + snapshots,
 * delivery-address rules, stock limits, session revocation and the storefront
 * hooks that keep carts per account.
 */
import { cleanupTestAccounts } from "./lib/test-accounts.mjs";

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
  async req(path, { method = "GET", json, headers = {}, redirect = "manual" } = {}) {
    const h = { ...headers };
    let body;
    if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
    if (this.cookies.size) h.cookie = this.header();
    const res = await fetch(BASE + path, { method, headers: h, body, redirect });
    this.absorb(res);
    return res;
  }
  async json(path, opts) {
    const res = await this.req(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data, headers: res.headers };
  }
  async text(path, opts) {
    const res = await this.req(path, opts);
    return { status: res.status, body: await res.text(), headers: res.headers };
  }
}

const uniq = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const PW = "RegressionPass123!";
const createdEmails = [];

/** Delete every account this run created, including its listings and orders. */
async function cleanupTestRun() {
  try {
    const result = await cleanupTestAccounts(createdEmails);
    if (result.deleted) console.log(`  INFO  cleanup: removed ${result.deleted} test account(s)`);
  } catch (e) {
    console.log(`  INFO  cleanup failed — ${e.message}`);
    process.exitCode = 1;
  }
}

async function register(jar, tag) {
  const email = uniq(tag);
  const r = await jar.json("/api/auth/register", {
    method: "POST",
    json: { name: "Regression " + tag, email, password: PW },
  });
  if (r.status === 201) createdEmails.push(email);
  return { ...r, email };
}

async function login(jar, email, password = PW) {
  return jar.json("/api/auth/login", { method: "POST", json: { email, password } });
}

async function makeSeller(jar) {
  return jar.json("/api/roles/seller", { method: "POST" });
}

async function createListing(jar, { title, categoryId, priceMinor = 2500, qty = 5 }) {
  const body = {
    title, categoryId, priceMinor, qty,
    status: "active", description: "regression test item", imageUrl: "",
  };
  return jar.json("/api/seller/listings", { method: "POST", json: body });
}

async function cancel(jar, orderId) {
  if (!orderId) return;
  await jar.json(`/api/order/${orderId}/cancel`, { method: "POST" });
}

async function main() {
  const anon = new Jar();
  let pickupId = null;
  let deliveryId = null;
  let categoryId = null;
  let sellerId = null;
  let sellerJar = null;
  let listingId = null;
  let buyer = null;
  let buyerEmail = "";

  section("1. Storefront regression hooks");
  {
    const root = await anon.text("/");
    ok("Storefront serves 200", root.status === 200, `status ${root.status}`);
    ok("Cart keys are per account and guest", root.body.includes("mkt_cart:u:") && root.body.includes("mkt_cart:guest"));
    ok("Legacy shared cart key is not used as the live key", !root.body.includes('this.key="mkt_cart"'));
    ok("Storefront has skeleton loading states", root.body.includes("skeletonView") && root.body.includes("sk-media"));
    ok("Login form announces busy state", root.body.includes('data-form="auth"') && root.body.includes("Signing you in…"));
    ok("Checkout has a pickup slot", root.body.includes("data-pickup-slot") && root.body.includes("pickup-note"));
    ok("Checkout hides delivery fields for pickup", root.body.includes("data-delivery-fields") && root.body.includes("syncCheckoutMode"));
    ok("Seller dashboard has a pickup form", root.body.includes('data-form="pickup"') && root.body.includes('name="location"'));
    ok("Hero image is eager, cards stay lazy", root.body.includes('big?"eager":"lazy"'));
    ok("Focus-visible styling exists", root.body.includes("input:focus-visible") && root.body.includes("outline:2px solid var(--acc)"));
    ok("Storefront uses self-hosted brand fonts",
      !root.body.includes("fonts.googleapis.com") && !root.body.includes("fonts.gstatic.com") &&
      root.body.includes('href="/fonts/fonts.css"') && root.body.includes("/fonts/instrument-sans-normal-latin.woff2"));
    const fontCss = await anon.text("/fonts/fonts.css");
    ok("Local font stylesheet is served",
      fontCss.status === 200 && /text\/css/i.test(fontCss.headers.get("content-type") ?? "") &&
      fontCss.body.includes('font-family: "Fraunces"') && fontCss.body.includes('font-family: "Instrument Sans"'),
      `status ${fontCss.status}`);
    const fontRes = await fetch(BASE + "/fonts/instrument-sans-normal-latin.woff2");
    const fontBytes = (await fontRes.arrayBuffer()).byteLength;
    ok("Local WOFF2 font is served and cacheable",
      fontRes.status === 200 && /font\/woff2/i.test(fontRes.headers.get("content-type") ?? "") &&
      /max-age=/i.test(fontRes.headers.get("cache-control") ?? "") && fontBytes > 1000,
      `status ${fontRes.status}, ${fontBytes} bytes`);
    const adminLogin = await anon.text("/admin/login");
    const adminCss = await anon.text("/admin/static/css/admin.css");
    ok("Admin pages use the same local font stylesheet",
      adminLogin.status === 200 && adminLogin.body.includes('href="/fonts/fonts.css"') &&
      !adminLogin.body.includes("fonts.googleapis.com") && !adminCss.body.includes("fonts.googleapis.com") &&
      !adminCss.body.includes("@import url("));
    const bootstrapCss = await anon.text("/admin/static/vendor/bootstrap/5.3.3/bootstrap.min.css");
    const bootstrapJs = await anon.text("/admin/static/vendor/bootstrap/5.3.3/bootstrap.bundle.min.js");
    const adminCsp = adminLogin.headers.get("content-security-policy") ?? "";
    ok("Admin uses self-hosted Bootstrap",
      adminLogin.body.includes('href="/admin/static/vendor/bootstrap/5.3.3/bootstrap.min.css"') &&
      !adminLogin.body.includes("cdn.jsdelivr") && !adminLogin.body.includes("cdnjs") &&
      bootstrapCss.status === 200 && /text\/css/i.test(bootstrapCss.headers.get("content-type") ?? "") &&
      bootstrapCss.body.includes("--bs-") &&
      bootstrapJs.status === 200 && /javascript/i.test(bootstrapJs.headers.get("content-type") ?? "") &&
      bootstrapJs.body.includes("Bootstrap") &&
      /max-age=604800/.test(bootstrapCss.headers.get("cache-control") ?? "") &&
      !/cdn\.jsdelivr|cdnjs/.test(adminCsp),
      JSON.stringify({ login: adminLogin.status, css: bootstrapCss.status, js: bootstrapJs.status, csp: adminCsp }));
  }

  section("2. Bootstrap + seller setup");
  {
    const b = await anon.json("/api/bootstrap");
    ok("Bootstrap 200", b.status === 200, `status ${b.status}`);
    ok("Bootstrap includes seller methods map", b.data?.sellerMethods && typeof b.data.sellerMethods === "object");
    ok("Bootstrap includes seller pickup map", b.data?.sellerPickup && typeof b.data.sellerPickup === "object");
    const methods = b.data?.methods ?? [];
    pickupId = methods.find((m) => /pickup/i.test(m.name))?.id ?? null;
    deliveryId = methods.find((m) => /delivery/i.test(m.name))?.id ?? null;
    categoryId = b.data?.categories?.[0]?.id ?? null;
    ok("Demo exchange methods include pickup", !!pickupId, JSON.stringify(methods));
    ok("Demo exchange methods include delivery", !!deliveryId, JSON.stringify(methods));
    ok("Demo categories exist", !!categoryId);

    sellerJar = new Jar();
    const reg = await register(sellerJar, "pickupseller");
    ok("Seller account registered", reg.status === 201, `status ${reg.status}`);
    sellerId = reg.data?.user?.user_id;
    await makeSeller(sellerJar);
    const l = await createListing(sellerJar, {
      title: "Pickup regression " + Date.now(),
      categoryId,
      qty: 4,
    });
    listingId = l.data?.id;
    ok("Seller listing created", l.status === 201 && !!listingId, `status ${l.status}`);

    const setMethods = await sellerJar.json("/api/seller/methods", {
      method: "PUT",
      json: { methodIds: [pickupId] },
    });
    ok("Seller can choose pickup only", setMethods.status === 200, `status ${setMethods.status}`);

    const empty = await sellerJar.json("/api/seller/pickup", {
      method: "PUT",
      json: { location: "", instructions: "ignored" },
    });
    ok("Pickup location is required", empty.status === 400, `status ${empty.status}`);

    const saved = await sellerJar.json("/api/seller/pickup", {
      method: "PUT",
      json: {
        location: "Kim's stall, 12 Market Lane",
        instructions: "Ask for Kim at the side gate after 9am.",
      },
    });
    ok("Seller can save pickup details", saved.status === 200 && saved.data?.pickup?.location?.includes("Market Lane"), `status ${saved.status}`);
    const got = await sellerJar.json("/api/seller/pickup");
    ok("Seller can read back pickup details", got.status === 200 && got.data?.pickup?.instructions?.includes("side gate"));
    const noRole = await anon.json("/api/seller/pickup");
    ok("Pickup details require a seller session", noRole.status === 401, `status ${noRole.status}`);

    const boot = await anon.json("/api/bootstrap");
    ok("Bootstrap exposes the seller's pickup point", boot.data?.sellerPickup?.[String(sellerId)]?.location?.includes("Market Lane"));
    ok("Bootstrap exposes pickup-only methods", JSON.stringify(boot.data?.sellerMethods?.[String(sellerId)] ?? []) === JSON.stringify([Number(pickupId)]));
    const product = await anon.json("/api/products/" + listingId);
    ok("Product detail exposes pickup details", product.data?.pickup?.location?.includes("Market Lane"));
    ok("Product detail shows only pickup", product.data?.methods?.length === 1 && /pickup/i.test(product.data.methods[0].name), JSON.stringify(product.data?.methods));
    buyer = new Jar();
    const buyerReg = await register(buyer, "pickupbuyer");
    buyerEmail = buyerReg.email;
    ok("Buyer account registered", buyerReg.status === 201, `status ${buyerReg.status}`);
  }

  section("3. Pickup checkout + snapshot");
  {
    const wrong = await buyer.json("/api/checkout", {
      method: "POST",
      json: {
        items: [{ productId: listingId, quantity: 1 }],
        address: { name: "Pickup Buyer", phone: "555" },
        methods: { [sellerId]: deliveryId },
      },
    });
    ok("Seller rejects a method they do not offer", wrong.status === 400 && /does not offer/i.test(wrong.data?.error ?? ""), `status ${wrong.status}`);

    const co = await buyer.json("/api/checkout", {
      method: "POST",
      json: {
        items: [{ productId: listingId, quantity: 2 }],
        address: { name: "Pickup Buyer", phone: "555" },
        methods: { [sellerId]: pickupId },
      },
    });
    const orderId = co.data?.order;
    ok("Pickup checkout works without a street address", co.status === 201 && !!orderId, `status ${co.status} ${co.data?.error ?? ""}`);
    const detail = await buyer.json("/api/order/" + orderId);
    const so = detail.data?.order?.sellerOrders?.[0];
    ok("Order records the pickup method", detail.status === 200 && /pickup/i.test(so?.method ?? ""), JSON.stringify(so?.method));
    ok("Order snapshots the pickup location", so?.pickup?.location?.includes("Market Lane"), JSON.stringify(so?.pickup));
    ok("Pickup order has no delivery street", !detail.data?.order?.delivery?.street, JSON.stringify(detail.data?.order?.delivery));
    await cancel(buyer, orderId);
  }

  section("4. Delivery rule when a seller offers both");
  {
    const both = await sellerJar.json("/api/seller/methods", {
      method: "PUT",
      json: { methodIds: [pickupId, deliveryId] },
    });
    ok("Seller can offer pickup and delivery", both.status === 200, `status ${both.status}`);

    const noStreet = await buyer.json("/api/checkout", {
      method: "POST",
      json: {
        items: [{ productId: listingId, quantity: 1 }],
        address: { name: "Delivery Buyer" },
        methods: { [sellerId]: deliveryId },
      },
    });
    ok("Delivery checkout requires a street address", noStreet.status === 400 && /street address/i.test(noStreet.data?.error ?? ""), `status ${noStreet.status} ${noStreet.data?.error ?? ""}`);

    const withStreet = await buyer.json("/api/checkout", {
      method: "POST",
      json: {
        items: [{ productId: listingId, quantity: 1 }],
        address: { name: "Delivery Buyer", street: "1 Main", city: "Town" },
        methods: { [sellerId]: deliveryId },
      },
    });
    const deliveryOrder = withStreet.data?.order;
    ok("Delivery checkout succeeds with a street address", withStreet.status === 201 && !!deliveryOrder, `status ${withStreet.status} ${withStreet.data?.error ?? ""}`);
    const deliveryDetail = await buyer.json("/api/order/" + deliveryOrder);
    ok("Delivery order stores the street", deliveryDetail.data?.order?.delivery?.street === "1 Main");
    ok("Delivery order has no pickup snapshot", !deliveryDetail.data?.order?.sellerOrders?.[0]?.pickup);
    await cancel(buyer, deliveryOrder);

    const deliverySeller = new Jar();
    const deliveryReg = await register(deliverySeller, "deliveryseller");
    await makeSeller(deliverySeller);
    const deliverySellerId = deliveryReg.data?.user?.user_id;
    const deliveryListing = await createListing(deliverySeller, {
      title: "Delivery regression " + Date.now(),
      categoryId,
      qty: 3,
    });
    const deliveryListingId = deliveryListing.data?.id;
    const deliveryMethods = await deliverySeller.json("/api/seller/methods", {
      method: "PUT",
      json: { methodIds: [deliveryId] },
    });
    ok("Second seller offers delivery only",
      deliveryReg.status === 201 && deliveryMethods.status === 200 && !!deliveryListingId,
      `status ${deliveryReg.status}/${deliveryMethods.status}/${deliveryListing.status}`);

    const mixed = await buyer.json("/api/checkout", {
      method: "POST",
      json: {
        items: [
          { productId: listingId, quantity: 1 },
          { productId: deliveryListingId, quantity: 1 },
        ],
        address: { name: "Mixed Buyer", phone: "555", street: "1 Main", city: "Town" },
        methods: { [sellerId]: pickupId, [deliverySellerId]: deliveryId },
      },
    });
    ok("Mixed pickup + delivery cart checks out", mixed.status === 201 && !!mixed.data?.order, `status ${mixed.status} ${mixed.data?.error ?? ""}`);
    const mixedDetail = await buyer.json("/api/order/" + mixed.data?.order);
    const mixedSellers = mixedDetail.data?.order?.sellerOrders ?? [];
    ok("Mixed order keeps each seller's own method",
      mixedSellers.length === 2 &&
      mixedSellers.some((s) => s.sellerId === String(sellerId) && /pickup/i.test(s.method ?? "")) &&
      mixedSellers.some((s) => s.sellerId === String(deliverySellerId) && /delivery/i.test(s.method ?? "")),
      JSON.stringify(mixedSellers.map((s) => ({ sellerId: s.sellerId, method: s.method }))));
    ok("Mixed order snapshots only the pickup seller's point",
      mixedSellers.filter((s) => s.pickup?.location)?.length === 1 &&
      mixedSellers.find((s) => s.pickup?.location)?.pickup?.location?.includes("Market Lane"),
      JSON.stringify(mixedSellers.map((s) => ({ sellerId: s.sellerId, pickup: s.pickup }))));
    await cancel(buyer, mixed.data?.order);

    const pickupAgain = await buyer.json("/api/checkout", {
      method: "POST",
      json: {
        items: [{ productId: listingId, quantity: 1 }],
        address: { name: "Pickup Buyer" },
        methods: { [sellerId]: pickupId },
      },
    });
    ok("Pickup still works when the seller offers both", pickupAgain.status === 201, `status ${pickupAgain.status}`);
    const pickupDetail = await buyer.json("/api/order/" + pickupAgain.data?.order);
    ok("Pickup order still snapshots the location", pickupDetail.data?.order?.sellerOrders?.[0]?.pickup?.location?.includes("Market Lane"));
    await cancel(buyer, pickupAgain.data?.order);

    const missingName = await buyer.json("/api/checkout", {
      method: "POST",
      json: {
        items: [{ productId: listingId, quantity: 1 }],
        address: { street: "1 Main" },
        methods: { [sellerId]: pickupId },
      },
    });
    ok("Checkout still requires a contact name", missingName.status === 400, `status ${missingName.status}`);
  }

  section("5. Stock limit and sold-out");
  {
    const seller = new Jar();
    const reg = await register(seller, "stockseller");
    await makeSeller(seller);
    const l = await createListing(seller, { title: "Stock regression " + Date.now(), categoryId, qty: 1 });
    const id = l.data?.id;
    ok("Stock listing created with qty 1", l.status === 201 && !!id, `status ${l.status}`);
    const over = await buyer.json("/api/checkout", {
      method: "POST",
      json: { items: [{ productId: id, quantity: 2 }], address: { name: "Stock Buyer", street: "1 Main" }, methods: {} },
    });
    ok("Checkout over stock returns 409", over.status === 409 && /Only 1 left/i.test(over.data?.error ?? ""), `status ${over.status}`);
    const prod = await anon.json("/api/products/" + id);
    ok("Stock is unchanged after the rejected checkout", prod.data?.product?.qty === 1, JSON.stringify(prod.data?.product?.qty));
    const zero = await seller.json("/api/seller/listings/" + id, {
      method: "PUT",
      json: { title: "Stock regression " + Date.now(), categoryId, priceMinor: 2500, qty: 0, status: "active", description: "zero" },
    });
    ok("Seller can set qty to zero", zero.status === 200, `status ${zero.status}`);
    const sold = await anon.json("/api/products/" + id);
    ok("Sold-out product reports qty 0", sold.data?.product?.qty === 0, JSON.stringify(sold.data?.product?.qty));
    const blocked = await buyer.json("/api/checkout", {
      method: "POST",
      json: { items: [{ productId: id, quantity: 1 }], address: { name: "Stock Buyer", street: "1 Main" }, methods: {} },
    });
    ok("Sold-out product cannot be ordered", blocked.status === 409, `status ${blocked.status}`);
  }

  section("6. Session revocation + cache headers");
  {
    const newBrowser = new Jar();
    const first = await login(newBrowser, buyerEmail);
    ok("First login succeeds", first.status === 200, `status ${first.status}`);
    const otherBrowser = new Jar();
    const second = await login(otherBrowser, buyerEmail);
    ok("Second login succeeds", second.status === 200, `status ${second.status}`);
    const oldMe = await newBrowser.json("/api/me");
    const newMe = await otherBrowser.json("/api/me");
    ok("Old session is revoked after a new login", oldMe.data?.user === null, JSON.stringify(oldMe.data));
    ok("New session belongs to the buyer", newMe.data?.user?.email === buyerEmail, JSON.stringify(newMe.data?.user?.email));
    const cache = newMe.headers.get("cache-control") ?? "";
    const vary = newMe.headers.get("vary") ?? "";
    ok("API responses are not cacheable", /no-store/i.test(cache), cache);
    ok("API responses vary by cookie", /cookie/i.test(vary), vary);
  }

  console.log(`\n================ REGRESSION RESULT: ${pass} passed, ${failures.length} failed ================`);
  if (failures.length) {
    for (const f of failures) console.log(" - " + f);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 2; })
  .finally(cleanupTestRun);
