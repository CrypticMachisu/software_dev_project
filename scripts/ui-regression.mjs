#!/usr/bin/env node
/**
 * Browser regression + accessibility audit for the M-DUKA storefront.
 * Usage: node scripts/ui-regression.mjs   (BASE_URL defaults to http://127.0.0.1:3003)
 * Requires a running server. CHROME_PATH can override the Chrome executable.
 *
 * The test creates its own buyer and seller accounts so it never depends on
 * demo cart state. It checks per-user cart isolation, pickup-only checkout,
 * small-screen layout, and axe WCAG 2.1 A/AA violations.
 */
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { cleanupTestAccounts } from "./lib/test-accounts.mjs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3003";
const PW = "UiRegression123!";
const stamp = Date.now();
const buyerEmail = `ui-buyer-${stamp}@example.com`;
const sellerEmail = `ui-seller-${stamp}@example.com`;
const deliverySellerEmail = `ui-delivery-${stamp}@example.com`;
const testEmails = [buyerEmail, sellerEmail, deliverySellerEmail];
const screenshots = "screenshots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { failures.push(name + (extra ? " — " + extra : "")); console.log("  FAIL  " + name + (extra ? " — " + extra : "")); }
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH.");
  return found;
}

async function api(path, { cookie = "", method = "GET", body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, res };
}

async function createAccount(name, email) {
  const res = await fetch(BASE + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: PW }),
  });
  const data = await res.json().catch(() => ({}));
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, data, cookie };
}

/** Delete every account this run created, including its listings and orders. */
async function cleanupTestRun() {
  try {
    const result = await cleanupTestAccounts(testEmails);
    if (result.deleted) console.log(`  INFO  cleanup: removed ${result.deleted} test account(s)`);
  } catch (e) {
    console.log(`  INFO  cleanup failed — ${e.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  fs.mkdirSync(screenshots, { recursive: true });
  const boot = await api("/api/bootstrap");
  const categoryId = boot.data?.categories?.[0]?.id;
  const pickupId = boot.data?.methods?.find((m) => /pickup/i.test(m.name))?.id;
  const deliveryId = boot.data?.methods?.find((m) => /delivery/i.test(m.name))?.id;
  if (!categoryId || !pickupId || !deliveryId) throw new Error("Demo categories, pickup, or delivery method missing.");

  const buyerReg = await createAccount("UI Buyer", buyerEmail);
  const sellerReg = await createAccount("UI Seller", sellerEmail);
  ok("Browser buyer registered", buyerReg.status === 201, `status ${buyerReg.status}`);
  ok("Browser seller registered", sellerReg.status === 201, `status ${sellerReg.status}`);
  if (buyerReg.status !== 201 || sellerReg.status !== 201) throw new Error("Could not create test accounts.");
  const sellerId = sellerReg.data?.user?.user_id;
  const madeSeller = await api("/api/roles/seller", { cookie: sellerReg.cookie, method: "POST" });
  ok("Browser seller can enable selling", madeSeller.status === 200, `status ${madeSeller.status}`);
  const sellerMe = await api("/api/me", { cookie: sellerReg.cookie });
  ok("Browser seller has the seller role after enabling it", sellerMe.data?.user?.roles?.includes("seller"));
  const pickupListingBody = {
    title: "UI pickup listing " + stamp,
    categoryId,
    priceMinor: 3400,
    qty: 5,
    status: "active",
    description: "A listing created by the browser regression test.",
    imageUrl: "",
  };
  const listing = await api("/api/seller/listings", {
    cookie: sellerReg.cookie,
    method: "POST",
    body: pickupListingBody,
  });
  const productId = listing.data?.id;
  ok("Browser seller listing created", listing.status === 201 && !!productId, `status ${listing.status}`);

  const deliverySellerReg = await createAccount("UI Delivery Seller", deliverySellerEmail);
  ok("Second browser seller registered", deliverySellerReg.status === 201, `status ${deliverySellerReg.status}`);
  if (deliverySellerReg.status !== 201) throw new Error("Could not create the delivery test seller.");
  const deliverySellerId = deliverySellerReg.data?.user?.user_id;
  const deliveryRole = await api("/api/roles/seller", { cookie: deliverySellerReg.cookie, method: "POST" });
  const deliveryListingBody = {
    title: "UI delivery listing " + stamp,
    categoryId,
    priceMinor: 4200,
    qty: 4,
    status: "active",
    description: "A delivery listing created by the mixed-cart browser test.",
    imageUrl: "",
  };
  const deliveryListing = await api("/api/seller/listings", {
    cookie: deliverySellerReg.cookie,
    method: "POST",
    body: deliveryListingBody,
  });
  const deliveryProductId = deliveryListing.data?.id;
  const deliveryMethods = await api("/api/seller/methods", {
    cookie: deliverySellerReg.cookie,
    method: "PUT",
    body: { methodIds: [deliveryId] },
  });
  ok("Second browser seller offers delivery only",
    deliveryRole.status === 200 && deliveryListing.status === 201 && deliveryMethods.status === 200 && !!deliveryProductId,
    `status ${deliveryRole.status}/${deliveryListing.status}/${deliveryMethods.status}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
  });
  const page = await browser.newPage();
  await page.setDefaultTimeout(20_000);
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  const pageErrors = [];
  const consoleErrors = [];
  const fontResponses = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("response", (res) => {
    try {
      const url = new URL(res.url());
      const local = url.hostname === new URL(BASE).hostname && url.pathname.startsWith("/fonts/");
      const external = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
      if (local || external) {
        fontResponses.push({ host: url.hostname, path: url.pathname, status: res.status(), type: res.headers()["content-type"] ?? "" });
      }
    } catch { /* ignore malformed URLs */ }
  });
  page.on("console", (msg) => {
    // Headless Chrome asks for a favicon the app does not ship; that is not an app error.
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text());
  });

  let navTick = 0;
  async function go(hash) {
    // Change the query as well as the hash so every visit is a fresh document.
    // That avoids same-document navigation races in the test and exercises boot.
    await page.goto(BASE + "/?r=" + (++navTick) + hash, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((wanted) => location.hash === wanted, { timeout: 10_000 }, hash).catch(() => {});
    await page.waitForFunction(() => {
      const app = document.querySelector("#app");
      return !!app && !app.hasAttribute("aria-busy") && app.textContent.trim().length > 0 && !app.textContent.includes("Loading…");
    }, { timeout: 20_000 }).catch(async (e) => {
      console.log("  DEBUG go failed:", hash, await page.evaluate(() => ({
        url: location.href,
        hash: location.hash,
        busy: document.querySelector("#app")?.getAttribute("aria-busy"),
        text: document.querySelector("#app")?.textContent.slice(0, 500),
        nav: document.querySelector("nav")?.innerText,
      })), { pageErrors });
      await page.screenshot({ path: `${screenshots}/debug-go-failed.png`, fullPage: true });
      throw e;
    });
    await page.evaluate(() => document.fonts?.ready);
    await sleep(250);
  }

  async function login(email) {
    await go("#/login");
    await page.waitForSelector("#auth-email");
    await page.type("#auth-email", email);
    await page.type("#auth-pw", PW);
    await page.evaluate(() => document.querySelector('form[data-form="auth"]')?.requestSubmit());
    await page.waitForFunction(() => !!document.querySelector("nav .account"), { timeout: 25_000 });
    await page.waitForFunction(() => !location.hash.startsWith("#/login"), { timeout: 20_000 });
    await sleep(250);
  }

  async function logout() {
    await page.evaluate(() => document.querySelector('[data-act="logout"]')?.click());
    await page.waitForFunction(() => document.querySelector("nav .who")?.textContent?.includes("Browsing as guest"), { timeout: 15_000 });
    await sleep(200);
  }

  async function cartCount() {
    return page.evaluate(() => Number(document.querySelector("nav .badge")?.textContent ?? 0));
  }

  async function runAxe(label) {
    const source = fs.readFileSync("node_modules/axe-core/axe.min.js", "utf8");
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
    });
    const serious = result.violations.filter((v) => ["critical", "serious"].includes(v.impact));
    if (result.violations.length) {
      for (const v of result.violations) {
        console.log(`  INFO  axe ${label}: ${v.impact} ${v.id} — ${v.help} (${v.nodes.length})`);
        for (const n of v.nodes.slice(0, 5)) console.log(`        ${n.target.join(" ")} :: ${n.html.slice(0, 160)}`);
      }
    }
    ok(`axe ${label}: no serious or critical violations`, serious.length === 0, serious.map((v) => v.id).join(","));
    return result;
  }

  try {
    await go("#/");
    await page.waitForSelector(".product-card");
    const fonts = await page.evaluate(() => ({
      body: document.fonts.check('16px "Instrument Sans"'),
      display: document.fonts.check('italic 600 1.5rem "Fraunces"'),
      status: document.fonts.status,
    }));
    const localFontCss = fontResponses.find((r) => r.path === "/fonts/fonts.css" && r.status === 200);
    const localFontFile = fontResponses.find((r) => r.path.endsWith(".woff2") && r.status === 200 && /font\/woff2/i.test(r.type));
    const externalFont = fontResponses.find((r) => /fonts\.(googleapis|gstatic)\.com$/.test(r.host));
    ok("Self-hosted brand fonts load in the browser",
      fonts.body && fonts.display && fonts.status === "loaded" && !!localFontCss && !!localFontFile && !externalFont,
      JSON.stringify({ fonts, localFontCss, localFontFile, externalFont }));
    await page.screenshot({ path: `${screenshots}/audit-browse-desktop.png`, fullPage: true });
    await runAxe("browse");

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await go("#/");
    await page.waitForSelector(".product-card");
    const browseOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok("Browse has no horizontal overflow at 390px", browseOverflow <= 1, `${browseOverflow}px`);
    await page.screenshot({ path: `${screenshots}/audit-browse-mobile.png`, fullPage: true });
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });

    await login(buyerEmail);
    ok("Buyer can sign in", await page.evaluate(() => !!document.querySelector("nav .account")));
    await go("#/product/" + productId);
    await page.waitForSelector('button[data-act="add"]');
    await sleep(300);
    await page.evaluate(() => document.querySelector('button[data-act="add"]')?.click());
    await page.waitForFunction(() => document.querySelector("nav .badge")?.textContent === "1", { timeout: 10_000 });
    ok("Buyer can add a product to the cart", (await cartCount()) === 1);
    await go("#/cart");
    await page.screenshot({ path: `${screenshots}/audit-cart-buyer.png`, fullPage: true });

    await logout();
    await login(sellerEmail);
    ok("Seller starts with an empty cart", (await cartCount()) === 0);
    await go("#/cart");
    ok("Seller cannot see the buyer's cart", (await page.evaluate(() => document.querySelector("#app")?.textContent?.includes("Your cart is empty"))) === true);
    await page.screenshot({ path: `${screenshots}/audit-cart-seller.png`, fullPage: true });

    const configured = await page.evaluate(async ({ pickupId }) => {
      const put = async (path, body) => {
        const r = await fetch("/api" + path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: r.status, data: await r.json().catch(() => ({})) };
      };
      return {
        pickup: await put("/seller/pickup", {
          location: "UI Seller's stall, 14 Market Lane",
          instructions: "Ring the bell and ask for the UI Seller.",
        }),
        methods: await put("/seller/methods", { methodIds: [pickupId] }),
      };
    }, { pickupId });
    ok("Seller can save pickup details in the browser", configured.pickup.status === 200, JSON.stringify(configured.pickup));
    ok("Seller can choose pickup only in the browser", configured.methods.status === 200, JSON.stringify(configured.methods));

    await go("#/seller");
    await page.waitForSelector('form[data-form="pickup"]');
    ok("Seller dashboard shows the pickup form", (await page.$eval("#pickup-location", (el) => el.value)).includes("Market Lane"));
    const methodChoices = await page.$$eval('input[name="method"]', (els) => els.map((el) => ({
      name: el.parentElement?.textContent?.trim(),
      checked: el.checked,
    })));
    const deliveryChoice = methodChoices.find((m) => /Delivery/i.test(m.name ?? ""));
    const pickupChoice = methodChoices.find((m) => /Pickup/i.test(m.name ?? ""));
    ok("Seller dashboard reflects the saved pickup-only choice", deliveryChoice?.checked === false && pickupChoice?.checked === true, JSON.stringify(methodChoices));
    await page.screenshot({ path: `${screenshots}/audit-seller-pickup.png`, fullPage: true });
    await runAxe("seller dashboard");

    await logout();
    await login(buyerEmail);
    ok("Buyer's cart survives signing out and back in", (await cartCount()) === 1);
    await go("#/checkout");
    await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("Checkout"), { timeout: 15_000 }).catch(() => {});
    await page.waitForSelector(".pickup-note", { timeout: 15_000 }).catch(async (e) => {
      console.log("  DEBUG checkout page:", await page.evaluate(() => ({ hash: location.hash, heading: document.querySelector("h1")?.textContent, text: document.querySelector("#app")?.textContent.slice(0, 500) })));
      throw e;
    });
    const checkout = await page.evaluate(() => {
      const note = document.querySelector(".pickup-note");
      const fields = document.querySelector("[data-delivery-fields]");
      const street = document.querySelector("#co-street");
      const methodText = document.body.textContent;
      return {
        note: note?.textContent ?? "",
        fieldsHidden: !!fields?.hidden,
        streetRequired: !!street?.required,
        pickupOnly: /Pickup only/i.test(methodText),
        pickupOnlyNotice: !document.querySelector("[data-pickup-only]")?.hidden,
      };
    });
    ok("Checkout shows the seller's pickup point", checkout.note.includes("Market Lane"));
    ok("Pickup-only checkout hides delivery fields", checkout.fieldsHidden === true);
    ok("Pickup-only checkout does not require a street", checkout.streetRequired === false);
    ok("Checkout shows the pickup-only method and notice", checkout.pickupOnly && checkout.pickupOnlyNotice);
    await page.screenshot({ path: `${screenshots}/audit-checkout-pickup.png`, fullPage: true });
    await runAxe("checkout");

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await go("#/checkout");
    await page.waitForSelector(".pickup-note");
    const checkoutOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok("Checkout has no horizontal overflow at 390px", checkoutOverflow <= 1, `${checkoutOverflow}px`);
    await page.screenshot({ path: `${screenshots}/audit-checkout-pickup-mobile.png`, fullPage: true });

    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
    await go("#/product/" + deliveryProductId);
    await page.waitForSelector('button[data-act="add"]');
    await page.evaluate(() => document.querySelector('button[data-act="add"]')?.click());
    await page.waitForFunction(() => document.querySelector("nav .badge")?.textContent === "2", { timeout: 10_000 });
    await go("#/checkout");
    await page.waitForSelector(`[data-pickup-slot="${sellerId}"]`);
    const mixed = await page.evaluate(({ pickupSeller, deliverySeller }) => {
      const pickupSlot = document.querySelector(`[data-pickup-slot="${pickupSeller}"]`);
      const deliverySlot = document.querySelector(`[data-pickup-slot="${deliverySeller}"]`);
      const fields = document.querySelector("[data-delivery-fields]");
      const street = document.querySelector("#co-street");
      const notice = document.querySelector("[data-pickup-only]");
      const text = document.querySelector("#app")?.textContent ?? "";
      return {
        pickupVisible: !!pickupSlot && !pickupSlot.hidden && pickupSlot.textContent.includes("Market Lane"),
        deliveryHidden: !!deliverySlot?.hidden,
        fieldsVisible: !!fields && !fields.hidden,
        streetRequired: !!street?.required,
        noticeHidden: !!notice?.hidden,
        twoSellers: /2 items/.test(text) && /2 sellers/.test(text),
        bothMethods: /Pickup only/.test(text) && /Delivery only/.test(text),
      };
    }, { pickupSeller: String(sellerId), deliverySeller: String(deliverySellerId) });
    ok("Mixed cart shows pickup for one seller and delivery for the other",
      Object.values(mixed).every(Boolean), JSON.stringify(mixed));
    await page.screenshot({ path: `${screenshots}/audit-checkout-mixed.png`, fullPage: true });
    await page.evaluate(() => {
      const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
      set("co-name", "UI Mixed Buyer");
      set("co-phone", "5551234");
      set("co-street", "1 Main");
      set("co-city", "Nairobi");
      set("co-zip", "00100");
    });
    await page.evaluate(() => document.querySelector('form[data-form="checkout"]')?.requestSubmit());
    await page.waitForFunction(() => location.hash.startsWith("#/pay/"), { timeout: 20_000 });
    const mixedOrderId = await page.evaluate(() => location.hash.split("/").pop());
    const mixedOrder = await page.evaluate(async (id) => {
      const res = await fetch("/api/order/" + encodeURIComponent(id));
      return { status: res.status, data: await res.json().catch(() => ({})) };
    }, mixedOrderId);
    const mixedSellers = mixedOrder.data?.order?.sellerOrders ?? [];
    ok("Mixed cart submits and records both seller orders",
      mixedOrder.status === 200 && mixedSellers.length === 2 &&
      mixedSellers.some((s) => /pickup/i.test(s.method) && s.pickup?.location?.includes("Market Lane")) &&
      mixedSellers.some((s) => /delivery/i.test(s.method) && !s.pickup),
      JSON.stringify({ status: mixedOrder.status, sellers: mixedSellers.map((s) => ({ method: s.method, pickup: s.pickup })) }));
    await page.evaluate(async (id) => {
      await fetch("/api/order/" + encodeURIComponent(id) + "/cancel", { method: "POST" });
    }, mixedOrderId);

    await go("#/login");
    await page.screenshot({ path: `${screenshots}/audit-login.png`, fullPage: true });
    await runAxe("login");

    ok("No uncaught page errors during the browser pass", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    ok("No unexpected console errors during the browser pass", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }

  console.log(`\n================ UI REGRESSION RESULT: ${pass} passed, ${failures.length} failed ================`);
  if (failures.length) {
    for (const f of failures) console.log(" - " + f);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error("UI HARNESS ERROR:", e); process.exitCode = 2; })
  .finally(cleanupTestRun);
