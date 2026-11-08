# M-DUKA Storefront & Admin UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the storefront and admin UI to the approved design, add Postgres-backed product imagery and one app currency, and adopt the tuned quiet-motion system.

**Architecture:** Keep the existing shape: one self-contained `src/public/index.html`, EJS + Bootstrap admin, Express JSON API. Add one SQL migration, one contrast script, one icon partial, and one admin JS enhancement. Work in five phases (foundation, data, storefront, admin, motion), each independently shippable.

**Tech Stack:** Node 22+, TypeScript (`tsc`), Express 4, PostgreSQL (`pg`), EJS, Bootstrap 5.3, vanilla CSS/JS. No new runtime dependencies.

---

## Execution baseline

- Work from the repository root.
- Server: `http://127.0.0.1:3003` (`PORT` in `.env`).
- Build: `npm run build`
- Migrate: `npm run migrate`
- Seed demo data: `npm run demo:seed`
- Harness: `node scripts/stress-test.mjs`
- Admin login for tests: `stress-admin@example.com` / `StressPass123!`
- Restart the server after every API or EJS change. Storefront HTML is read from disk per request, so CSS/JS-only storefront edits need no restart.
- Run the harness only against a built, running server.
- Commit after each task. Do not stage unrelated working-tree files.

## File structure

| File | Responsibility |
|---|---|
| `scripts/check-contrast.mjs` | New. Asserts token pairs against WCAG AA and checks token literals in both stylesheets. |
| `src/public/index.html` | Storefront: tokens, composition, media, motion, a11y, currency. |
| `src/admin/public/css/admin.css` | Admin tokens, icon sizing, dashboard chart/pipeline. |
| `src/admin/public/js/admin.js` | Existing confirm handler plus image preview. |
| `src/admin/views/partials/icons.ejs` | New inline SVG sprite. |
| `src/admin/views/partials/header.ejs` | Sprite include, icon references, "Soon" labels. |
| `src/admin/views/dashboard.ejs` | KPI, chart, pipeline, approvals, low stock, recent orders. |
| `src/admin/routes/dashboard.ts` | Dashboard queries. |
| `src/admin/routes/products.ts` | Product image field validation and persistence. |
| `src/admin/views/product_form.ejs` | Image URL input + preview. |
| `src/admin/app.ts` | Currency locals and `money` default. |
| `src/env.ts` | `APP_CURRENCY` parsing. |
| `src/api/index.ts` | Image field, currency in bootstrap/checkout, URL validation. |
| `SQL/005_product_images.sql` | New `image_url` column and scheme check. |
| `scripts/stress-test.mjs` | New API/UI assertions. |

---

### Task 1: Contrast guard and tokens

**Files:**
- Create: `scripts/check-contrast.mjs`
- Modify: `src/public/index.html` (`:root` block)
- Modify: `src/admin/public/css/admin.css` (`:root` block)

- [ ] **Step 1: Write the failing contrast script**

```js
// scripts/check-contrast.mjs
import { readFileSync } from "node:fs";

const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const pairs = [
  ["storefront mute on bg", "#6f6653", "#f7f2e8"],
  ["storefront mute on card", "#6f6653", "#fffcf4"],
  ["storefront warn on warn-soft", "#7a5217", "#f3ead3"],
  ["storefront go on go-soft", "#2f6440", "#e2eddf"],
  ["storefront bad on bad-soft", "#b23b34", "#f6e2de"],
  ["storefront accent on card", "#b04f2a", "#fffcf4"],
  ["storefront dark mute on bg", "#a09477", "#17140e"],
  ["storefront dark mute on card", "#a09477", "#211d15"],
  ["storefront dark warn on warn-soft", "#d9a44c", "#312513"],
  ["storefront dark go on go-soft", "#82bd90", "#1f2c22"],
  ["admin mute on paper", "#6f6653", "#f3efe5"],
  ["admin mute on panel", "#6f6653", "#fffdf6"],
  ["admin warn on warn-soft", "#7a5217", "#f3ead3"],
  ["admin go on go-soft", "#2f6440", "#e2eddf"],
];

let failed = 0;
for (const [name, fg, bg] of pairs) {
  const value = ratio(fg, bg);
  const ok = value >= 4.5;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${value.toFixed(2)}:1`);
  if (!ok) failed++;
}

const storefront = readFileSync("src/public/index.html", "utf8");
const admin = readFileSync("src/admin/public/css/admin.css", "utf8");
const literals = [
  [storefront, "--mute:#6f6653;", "storefront --mute"],
  [storefront, "--warn:#7a5217;", "storefront --warn"],
  [storefront, "--go:#2f6440;", "storefront --go"],
  [admin, "--mute:#6f6653;", "admin --mute"],
  [admin, "--warn:#7a5217;", "admin --warn"],
  [admin, "--go:#2f6440;", "admin --go"],
];
for (const [source, needle, name] of literals) {
  const ok = source.includes(needle);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}

if (failed) {
  console.error(`${failed} contrast check(s) failed`);
  process.exit(1);
}
console.log("All contrast checks pass");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-contrast.mjs`
Expected: FAIL for `storefront mute`, `warn`, `go` and the corresponding admin literals; exit code 1.

- [ ] **Step 3: Change the storefront tokens**

In `src/public/index.html`, replace the light `:root` block values:

```css
:root{
  --bg:#f7f2e8; --card:#fffcf4; --ink:#272b1f; --mute:#6f6653;
  --line:#e7ddc8; --line-2:#efe8d9;
  --acc:#b04f2a; --acc-deep:#8f3e20; --acc-ink:#fff8f1; --acc-soft:#f5e6d9;
  --go:#2f6440; --go-soft:#e2eddf;
  --warn:#7a5217; --warn-soft:#f3ead3;
  --bad:#b23b34; --bad-soft:#f6e2de;
  --chip:#f0e9d8;
  --star:#d9972f;
}
```

Keep the dark-mode block unchanged.

- [ ] **Step 4: Change the admin tokens**

In `src/admin/public/css/admin.css`, replace the `:root` block:

```css
:root{
  --paper:#f3efe5; --panel:#fffdf6; --ink:#262a1d; --mute:#6f6653;
  --line:#e4dbc5; --line-soft:#efe9da;
  --acc:#b04f2a; --acc-deep:#8f3e20; --acc-ink:#fff8f1; --acc-soft:#f5e5d7;
  --side:#1f2119; --side-ink:#e9e5d6; --side-mute:#a4a08c;
  --go:#2f6440; --go-soft:#e2eddf;
  --warn:#7a5217; --warn-soft:#f3ead3;
  --bad:#b23b34; --bad-soft:#f6e2de;
  --shadow:0 1px 2px rgba(66,55,34,.04),0 10px 26px -16px rgba(66,55,34,.16);
  --r:12px;
}
```

Update the warning badge border to the new hue:

```css
.badge.text-bg-warning{background:var(--warn-soft)!important;color:var(--warn)!important;border:1px solid rgba(122,82,23,.25)}
```

- [ ] **Step 5: Add spacing/type tokens and make layout mobile-first**

Add to the storefront `:root`:

```css
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;--s8:64px;
--t-xs:12px;--t-sm:14px;--t-md:16px;--t-lg:20px;--t-xl:25px;--t-2xl:31px;--t-3xl:39px;
```

Add the same scale tokens to the admin `:root`. Change the storefront body to:

```css
font:16px/1.55 "Instrument Sans",system-ui,sans-serif;
```

Keep the admin body at 14px. Replace the existing `.layout`, `.two`, `aside` and the 880/760 media blocks with mobile-first rules:

```css
.layout,.two{grid-template-columns:1fr}
aside{position:static}
@media(min-width:880px){
 .layout{grid-template-columns:220px 1fr}
 .two{grid-template-columns:1fr 340px}
 aside{position:sticky;top:4.6rem}
}
nav .brand-sub,nav .who{display:none}
nav .search{order:9;width:100%;max-width:none}
@media(min-width:760px){
 nav .brand-sub{display:inline}
 nav .who{display:inline}
 nav .search{order:0;width:min(300px,100%)}
}
@media(min-width:1100px){.grid{grid-template-columns:repeat(4,1fr)}}
```

- [ ] **Step 6: Verify and commit**

Run: `node scripts/check-contrast.mjs`
Expected: all `PASS`, exit 0.

```bash
git add scripts/check-contrast.mjs src/public/index.html src/admin/public/css/admin.css
git commit -m "fix: raise UI contrast to WCAG AA"
```

---

### Task 2: Storefront accessibility base, dialog and toast

**Files:**
- Modify: `src/public/index.html`
- Modify: `scripts/stress-test.mjs` (section 1)

- [ ] **Step 1: Add failing static assertions**

In `scripts/stress-test.mjs` section 1, after the existing storefront checks:

```js
ok("Storefront has a skip link to #app", root.body.includes('class="skip"') && root.body.includes('href="#app"'));
ok("Storefront has a visible browse heading", root.body.includes("Browse the market"));
ok("Review dialog is announced", root.body.includes('setAttribute("role","dialog")') && root.body.includes('setAttribute("aria-modal","true")'));
ok("Toasts are live regions", root.body.includes('setAttribute("role","status")') && root.body.includes('setAttribute("aria-live","polite")'));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL for the four new assertions.

- [ ] **Step 3: Add the skip link and touch-target CSS**

Immediately after `<body>`:

```html
<a class="skip" href="#app">Skip to content</a>
```

Change the app mount to:

```html
<main id="app" tabindex="-1"></main>
```

Add to the CSS, after the base focus rules:

```css
.skip{position:fixed;left:1rem;top:-4rem;z-index:100;background:var(--card);color:var(--ink);
  padding:.7rem 1rem;border-radius:999px;border:1px solid var(--line);box-shadow:var(--shadow)}
.skip:focus{top:1rem}
#app:focus{outline:none}
nav .pill,aside .fcat,.btn,button,summary{min-height:44px}
aside .fcat{padding:.55rem .78rem}
```

- [ ] **Step 4: Add the browse `h1`**

At the start of the `V.browse` return string, before `<div class="layout">`, add:

```html
<h1>Browse the market</h1>
```

This is expanded in Task 8; the heading is the accessibility requirement.

- [ ] **Step 5: Replace the toast and review modal**

Replace `function toast`:

```js
function toast(t){const e=document.createElement("div");e.className="toast";e.setAttribute("role","status");e.setAttribute("aria-live","polite");e.textContent=t;document.body.append(e);setTimeout(()=>e.remove(),3500)}
```

Replace the whole `review` action in `const A`:

```js
review(e){
 const id=+e.dataset.id, trigger=e;
 let r=5;
 const m=document.createElement("div");
 m.className="modal";
 m.setAttribute("role","dialog");
 m.setAttribute("aria-modal","true");
 m.setAttribute("aria-labelledby","review-title");
 m.innerHTML=`<div class="card"><button type="button" class="modal-close" data-x="no" aria-label="Close review dialog">×</button>
  <h2 id="review-title">Review your seller</h2>
  <div class="stars" role="group" aria-label="Rating">${[1,2,3,4,5].map(n=>`<button type="button" data-r="${n}" aria-label="${n} star${n===1?"":"s"}" aria-pressed="${n===r}">${n<=r?"★":"☆"}</button>`).join("")}</div>
  <label for="rc">Comment</label><textarea id="rc" rows="4"></textarea>
  <div class="row" style="margin-top:.8rem"><button type="button" data-x="ok">Submit review</button><button type="button" class="ghost" data-x="no">Cancel</button></div>
  <p class="mute">One review per completed order.</p></div>`;
 const previous=document.activeElement;
 const close=()=>{m.remove();document.removeEventListener("keydown",onKey);if(previous instanceof HTMLElement)previous.focus()};
 const focusables=()=>[...m.querySelectorAll('button, textarea, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter(el=>!el.hasAttribute("disabled"));
 const onKey=ev=>{
  if(ev.key==="Escape"){ev.preventDefault();close();return}
  if(ev.key!=="Tab")return;
  const f=focusables(),first=f[0],last=f[f.length-1];
  if(!first)return;
  if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus()}
  else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus()}
 };
 m.addEventListener("click",ev=>{
  const t=ev.target.closest("button");if(!t)return;
  if(t.dataset.r){r=+t.dataset.r;m.querySelectorAll("[data-r]").forEach(b=>{const n=+b.dataset.r;b.textContent=n<=r?"★":"☆";b.setAttribute("aria-pressed",String(n===r))});return}
  if(t.dataset.x==="no"){close();return}
  call("POST","/reviews",{sellerOrderId:id,rating:r,comment:($("#rc")?.value??"")})
   .then(()=>{close();route();toast("Review posted")})
   .catch(x=>toast(x.message));
 });
 document.body.append(m);
 document.addEventListener("keydown",onKey);
 m.querySelector('[data-x="no"]').focus();
}
```

Add modal CSS:

```css
.modal .card{position:relative}
.modal-close{position:absolute;right:.7rem;top:.6rem;min-width:44px;min-height:44px;
  background:transparent;border:1px solid var(--line);color:var(--ink);font-size:1.3rem}
```

- [ ] **Step 6: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: 98 old checks plus 4 new checks pass.

```bash
git add src/public/index.html scripts/stress-test.mjs
git commit -m "feat: add storefront skip link and accessible dialog"
```

---

### Task 3: Admin inline SVG icons

**Files:**
- Create: `src/admin/views/partials/icons.ejs`
- Modify: `src/admin/views/partials/header.ejs`
- Modify: `src/admin/views/products.ejs`
- Modify: `src/admin/views/users.ejs`
- Modify: `src/admin/views/user-detail.ejs`
- Modify: `src/admin/views/exchange.ejs`
- Modify: `src/admin/public/css/admin.css`
- Modify: `scripts/stress-test.mjs` (section 9)

- [ ] **Step 1: Add a failing assertion**

In section 9 after `dash` is fetched:

```js
ok("Admin uses inline SVG icons", dash.body.includes('<symbol id="icon-dashboard"') && !dash.body.includes("ph ph-"));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL "Admin uses inline SVG icons".

- [ ] **Step 3: Create the sprite**

`src/admin/views/partials/icons.ejs`:

```html
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">
  <symbol id="icon-dashboard" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 0 1 16 0"/><path d="m12 13 4-4"/><circle cx="12" cy="13" r="1"/></symbol>
  <symbol id="icon-users" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
  <symbol id="icon-user-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/></symbol>
  <symbol id="icon-package" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></symbol>
  <symbol id="icon-receipt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2V2l-3 2-3-2-3 2-3-2-3 2Z"/><path d="M8 7h8M8 11h8M8 15h5"/></symbol>
  <symbol id="icon-truck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-4l-3-4h-5v8h3"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></symbol>
  <symbol id="icon-chart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></symbol>
  <symbol id="icon-clipboard" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4V2h6v2"/><path d="M9 10h6M9 14h6M9 18h4"/></symbol>
  <symbol id="icon-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3v-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.4 7l2.8-2.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h4v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></symbol>
  <symbol id="icon-logout" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></symbol>
  <symbol id="icon-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="icon-tags" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/></symbol>
  <symbol id="icon-arrow-left" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></symbol>
</svg>
```

- [ ] **Step 4: Wire the header**

In `src/admin/views/partials/header.ejs`, after `<body>`:

```html
<%- include('icons') %>
```

Change the nav icon names to sprite ids:

```js
{ key: 'dashboard', label: 'Dashboard',        href: '/admin',          icon: 'icon-dashboard', ready: true  },
{ key: 'users',     label: 'Users',            href: '/admin/users',    icon: 'icon-users', ready: true  },
{ key: 'sellers',   label: 'Seller approvals', href: '/admin/users?approval=pending', icon: 'icon-user-check', ready: true  },
{ key: 'products',  label: 'Products',         href: '/admin/products', icon: 'icon-package', ready: true  },
{ key: 'orders',    label: 'Orders',           href: '/admin/orders',   icon: 'icon-receipt', ready: true  },
{ key: 'exchange',  label: 'Exchange methods', href: '/admin/exchange', icon: 'icon-truck', ready: true, superOnly: true },
{ key: 'reports',   label: 'Reports',          href: '/admin/reports',  icon: 'icon-chart', ready: false },
{ key: 'audit',     label: 'Audit logs',       href: '/admin/audit',    icon: 'icon-clipboard', ready: true, superOnly: true },
{ key: 'settings',  label: 'Settings',         href: '/admin/settings', icon: 'icon-gear', ready: false, superOnly: true }
```

Replace the two nav link bodies:

```html
<a class="nav-item-link <%= active === n.key ? 'active' : '' %>" href="<%= n.href %>"><svg class="icon" aria-hidden="true"><use href="#<%= n.icon %>"></use></svg> <%= n.label %></a>
```

```html
<span class="nav-item-link disabled"><svg class="icon" aria-hidden="true"><use href="#<%= n.icon %>"></use></svg> <%= n.label %> <span class="soon">Soon</span></span>
```

Add the logout icon to the header button:

```html
<button class="btn btn-outline-secondary btn-sm"><svg class="icon" aria-hidden="true"><use href="#icon-logout"></use></svg> Log out</button>
```

- [ ] **Step 5: Replace remaining Phosphor icons**

In `products.ejs`, replace the two `<i class="ph …"></i>` elements with:

```html
<svg class="icon" aria-hidden="true"><use href="#icon-tags"></use></svg>
<svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg>
```

In `users.ejs`:

```html
<svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg>
```

In `user-detail.ejs`:

```html
<svg class="icon" aria-hidden="true"><use href="#icon-arrow-left"></use></svg>
```

In `exchange.ejs`, both add buttons:

```html
<svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg>
```

- [ ] **Step 6: Add CSS and remove the CDN import**

Delete this line from `admin.css`:

```css
@import url("https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/regular/style.min.css");
```

Add:

```css
.icon{width:20px;height:20px;flex:none;display:inline-block;vertical-align:-.2em}
.btn .icon{width:16px;height:16px}
.nav-item-link .icon{width:20px;height:20px}
.soon{margin-left:auto;font-size:.65rem;font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;color:var(--side-mute);border:1px solid currentColor;
  border-radius:999px;padding:.05rem .4rem}
```

- [ ] **Step 7: Verify and commit**

Run: `npm run build && node scripts/stress-test.mjs`
Expected: the new icon assertion passes; all admin pages still 200.

```bash
git add src/admin/views/partials/icons.ejs src/admin/views/partials/header.ejs src/admin/views/products.ejs src/admin/views/users.ejs src/admin/views/user-detail.ejs src/admin/views/exchange.ejs src/admin/public/css/admin.css scripts/stress-test.mjs
git commit -m "feat: replace admin icon font with inline SVG"
```

---

### Task 4: Migration 005 and currency configuration

**Files:**
- Create: `SQL/005_product_images.sql`
- Modify: `src/env.ts`
- Modify: `scripts/stress-test.mjs` (section 2)

- [ ] **Step 1: Add a failing currency assertion**

In section 2 after the bootstrap request:

```js
appCurrency = b.data?.currency ?? "USD";
ok("Bootstrap exposes a configured three-letter currency", /^[A-Z]{3}$/.test(appCurrency), appCurrency);
```

Declare `let appCurrency = "USD";` immediately after `const anon = new Jar();` in `main()`.

- [ ] **Step 2: Write the migration**

`SQL/005_product_images.sql`:

```sql
-- Product photos are external URLs; no upload/storage service is added.
BEGIN;

ALTER TABLE product
  ADD COLUMN IF NOT EXISTS image_url TEXT
  CONSTRAINT product_image_url_scheme CHECK (image_url IS NULL OR image_url ~ '^https?://');

COMMIT;
```

- [ ] **Step 3: Add currency parsing**

In `src/env.ts`, replace the exported object with:

```ts
const currencyRaw = (process.env.APP_CURRENCY ?? "USD").trim().toUpperCase();

export const env = {
  branch: null as { name: string } | null,
  currency: /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : "USD",
  postgres: {
    databaseUrl: process.env.DATABASE_URL ?? "",
    databaseUrlUnpooled: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
    ssl: process.env.DATABASE_SSL === "true",
  },
};
```

Keep the existing `DATABASE_URL` check below it.

- [ ] **Step 4: Apply and verify the migration**

Run:

```bash
npm run build
npm run migrate
```

Expected: `Applied 005_product_images.sql`.

Run:

```bash
node --env-file=.env -e "import('./dist/src/db.js').then(async ({pool})=>{const r=await pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='product' AND column_name='image_url'\");console.log(r.rows);await pool.end()})"
```

Expected: one row, `image_url`.

- [ ] **Step 5: Commit**

```bash
git add SQL/005_product_images.sql src/env.ts scripts/stress-test.mjs
git commit -m "feat: add product image column and app currency config"
```

The currency assertion still fails until Task 5 changes the API; that is expected.

---

### Task 5: API image and currency support

**Files:**
- Modify: `src/api/index.ts`
- Modify: `scripts/stress-test.mjs` (sections 2, 4, 5)

- [ ] **Step 1: Add failing API assertions**

In section 2:

```js
ok("Bootstrap products expose imageUrl", products.length > 0 && "imageUrl" in products[0]);
```

At the end of section 4:

```js
const withImage = await createListing(seller, { title: "Image widget " + Date.now(), priceMinor: 3300, qty: 2, categoryId, imageUrl: "https://example.com/widget.jpg" });
const imageListingId = withImage.data?.id;
const imageBoot = await anon.json("/api/bootstrap");
const imageRow = imageBoot.data.products.find((p) => p.id === imageListingId);
ok("Listing stores a valid image URL", withImage.status === 201 && imageRow?.imageUrl === "https://example.com/widget.jpg", JSON.stringify(imageRow));
const imageDetail = await anon.json("/api/products/" + imageListingId);
ok("Product detail returns imageUrl", imageDetail.data?.product?.imageUrl === "https://example.com/widget.jpg");
const jsUrl = await createListing(seller, { title: "Bad image", priceMinor: 100, qty: 1, categoryId, imageUrl: "javascript:alert(1)" });
ok("javascript: image URL rejected 400", jsUrl.status === 400, `status ${jsUrl.status}`);
const longUrl = await createListing(seller, { title: "Long image", priceMinor: 100, qty: 1, categoryId, imageUrl: "https://example.com/" + "a".repeat(500) });
ok("Over-500-character image URL rejected 400", longUrl.status === 400, `status ${longUrl.status}`);
```

In section 5 after the order detail:

```js
ok("Order uses the configured app currency", det.data.order.currency === appCurrency, `${det.data.order.currency} vs ${appCurrency}`);
```

`appCurrency` is declared in Task 4 and captured from the bootstrap response.

- [ ] **Step 2: Extend the harness listing helper**

Change `createListing` in `scripts/stress-test.mjs` to accept an image URL:

```js
async function createListing(jar, { title, priceMinor, qty, categoryId, imageUrl }) {
  const body = { title, categoryId, priceMinor, qty, status: "active", description: "stress test item" };
  if (imageUrl !== undefined) body.imageUrl = imageUrl;
  return jar.json("/api/seller/listings", { method: "POST", json: body });
}
```

- [ ] **Step 3: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL for image/currency assertions.

- [ ] **Step 4: Wire currency through the API**

At the top of `src/api/index.ts`:

```ts
import { env } from "../env.js";
```

After `const IDLE_MINUTES = 30;`:

```ts
const CURRENCY = env.currency;
```

In `/bootstrap` response:

```ts
res.json({
  user,
  currency: CURRENCY,
  categories: data.categories,
  methods: data.methods,
  products: data.products.map(rowToProduct),
});
```

In the checkout INSERT:

```ts
const orderRes = await client.query<{ order_id: string; ordered_at: Date }>(
  `INSERT INTO market_order (buyer_id, currency, total_amount_minor,
                             delivery_name, delivery_phone, delivery_street, delivery_city, delivery_zip)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING order_id, ordered_at`,
  [user.user_id, CURRENCY, totalMinor, delivery.name, delivery.phone || null, delivery.street,
    delivery.city || null, delivery.zip || null],
);
```

- [ ] **Step 5: Wire the configured currency into the storefront**

Before `money(...)` in the utilities, add:

```js
let CURRENCY="USD";
```

Change `money` to default to it:

```js
const money=(m,c=CURRENCY)=>new Intl.NumberFormat("en",{style:"currency",currency:c}).format(m/100);
```

In `boot()`, after `db.user=d.user`, add:

```js
CURRENCY=d.currency??"USD";
```

Change the seller edit price label from `Price (USD)` to:

```html
<label>Price (${CURRENCY})</label>
```

- [ ] **Step 6: Add `imageUrl` to product shaping and reads**

In `rowToProduct`:

```ts
imageUrl: row.image_url ?? null,
```

Add `p.image_url` to the SELECT list in all four product reads: `loadCatalogue`, `/products`, `/products/:id`, `/seller/listings`. The column list becomes:

```sql
p.title, p.description, p.image_url, p.asking_price, p.quantity_available, p.listing_status
```

- [ ] **Step 7: Validate and persist the image URL**

In `readListing`:

```ts
const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
if (imageUrl.length > 500) return { error: "Image URL must be 500 characters or fewer." };
if (imageUrl && !/^https?:\/\//i.test(imageUrl)) return { error: "Image URL must start with http:// or https://." };
```

Add to the returned value:

```ts
image_url: imageUrl || null,
```

Update the cast types in create/update to include `image_url: string | null`. Change the INSERT:

```ts
`INSERT INTO product (seller_id, category_id, title, description, asking_price, quantity_available, listing_status, image_url)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING product_id`,
[user.user_id, v.categoryId, v.title, v.description, v.asking_price, v.quantity_available, v.listing_status, v.image_url]
```

Change the UPDATE:

```ts
`UPDATE product SET category_id=$2, title=$3, description=$4, asking_price=$5,
        quantity_available=$6, listing_status=$7, image_url=$8, updated_at=now()
 WHERE product_id = $1`,
[id, v.categoryId, v.title, v.description, v.asking_price, v.quantity_available, v.listing_status, v.image_url]
```

- [ ] **Step 8: Rebuild, restart, verify and commit**

Restart the server (Ctrl+C, then `npm run start`), then:

```bash
npm run build
node scripts/stress-test.mjs
```

Expected: image and currency assertions pass; all prior checks remain green.

```bash
git add src/api/index.ts scripts/stress-test.mjs
git commit -m "feat: expose product images and app currency through the API"
```

---

### Task 6: Seller and admin image forms

**Files:**
- Modify: `src/admin/routes/products.ts`
- Modify: `src/admin/views/product_form.ejs`
- Modify: `src/admin/public/js/admin.js`
- Modify: `src/admin/app.ts`
- Modify: `src/public/index.html` (`V.edit`, listing submit)
- Modify: `scripts/stress-test.mjs` (section 9)

- [ ] **Step 1: Add failing form assertions**

In section 9, after the dashboard fetch:

```js
const productForm = await admin.text("/admin/products/new");
ok("Admin product form has an image URL field", productForm.status === 200 && productForm.body.includes('name="image_url"'));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL "Admin product form has an image URL field".

- [ ] **Step 3: Extend the admin form model**

In `src/admin/routes/products.ts`:

```ts
interface ProductForm {
  seller_id: string;
  category_id: string;
  title: string;
  description: string;
  asking_price: string;
  quantity_available: string;
  image_url: string;
}
```

`readForm` adds:

```ts
image_url: typeof b.image_url === "string" ? b.image_url.trim() : "",
```

`emptyForm` adds `image_url: ""`.

`validateProduct` adds:

```ts
if (f.image_url.length > 500) problems.push("Image URL must be 500 characters or fewer.");
if (f.image_url && !/^https?:\/\//i.test(f.image_url)) problems.push("Image URL must start with http:// or https://.");
```

- [ ] **Step 4: Persist the admin field**

In `loadProduct`, add `p.image_url` to the SELECT and the row type as `image_url: string | null`.

In the GET edit branch, add `image_url: p.image_url ?? ""` to the `form` object.

In the POST new INSERT:

```ts
const r = await c.query<{ product_id: string }>(
  `INSERT INTO product (seller_id, category_id, title, description, asking_price, quantity_available, image_url)
   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING product_id`,
  [form.seller_id, form.category_id, form.title, form.description || null, form.asking_price, form.quantity_available, form.image_url || null],
);
```

In the POST edit UPDATE:

```ts
`UPDATE product SET category_id = $2, title = $3, description = $4, asking_price = $5,
        quantity_available = $6, image_url = $7, updated_at = now() WHERE product_id = $1`,
[id, form.category_id, form.title, form.description || null, form.asking_price, form.quantity_available, form.image_url || null]
```

- [ ] **Step 5: Add the admin field and preview**

In `product_form.ejs`, after the description field:

```html
<div class="mb-3">
  <label class="form-label" for="image_url">Image URL (optional)</label>
  <input class="form-control" id="image_url" name="image_url" maxlength="500"
         value="<%= form.image_url %>" placeholder="https://…" data-image-url>
  <div class="form-text">Use a public http(s) image. Leave blank for a designed fallback.</div>
  <img data-image-preview alt="" hidden
       style="margin-top:.6rem;max-width:100%;max-height:180px;border-radius:9px;border:1px solid var(--line)">
</div>
```

Allow external preview images in the admin CSP. In `src/admin/app.ts`, add to the helmet directives:

```ts
"img-src": ["'self'", "data:", "https:"],
```

Add to `src/admin/public/js/admin.js`:

```js
// Image URL preview. Inline handlers are blocked by the admin CSP, so bind here.
document.querySelectorAll("[data-image-url]").forEach(function (input) {
  var preview = input.parentElement.querySelector("[data-image-preview]");
  if (!preview) return;
  function sync() {
    var value = input.value.trim();
    var valid = /^https?:\/\//i.test(value);
    preview.hidden = !valid;
    if (valid) preview.src = value;
  }
  input.addEventListener("input", sync);
  preview.addEventListener("error", function () { preview.hidden = true; });
  sync();
});
```

- [ ] **Step 6: Add the seller field**

In `V.edit`, add `imageUrl: ""` to the default product and use `p=l` so the API value is present.

After the description textarea, add:

```html
<label>Image URL (optional)</label>
<input name="imageUrl" type="url" maxlength="500" value="${esc(p.imageUrl??"")}" placeholder="https://…">
```

In the listing submit body, add:

```js
imageUrl:d.imageUrl.trim(),
```

- [ ] **Step 7: Verify and commit**

Run: `npm run build`, restart the server, then `node scripts/stress-test.mjs`.
Expected: admin form assertion passes; seller listing image roundtrip still passes.

```bash
git add src/admin/routes/products.ts src/admin/views/product_form.ejs src/admin/public/js/admin.js src/public/index.html scripts/stress-test.mjs
git commit -m "feat: let sellers and admins set product images"
```

---

### Task 7: Storefront media system

**Files:**
- Modify: `src/public/index.html`
- Modify: `scripts/stress-test.mjs` (section 1)

- [ ] **Step 1: Add failing static assertions**

In section 1:

```js
ok("Storefront no longer uses emoji product media", !root.body.includes("📷") && !root.body.includes("🪴") && !root.body.includes("📦"));
ok("Storefront renders image fallbacks with alt text", root.body.includes("imageUrl") && root.body.includes('referrerpolicy="no-referrer"'));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL for both media assertions.

- [ ] **Step 3: Replace the emoji map with a media helper**

Replace `PIC_BY_CATEGORY`, `PIC_DEFAULT` and `pic` with:

```js
function media(p, big=false){
 const title=String(p?.title??"");
 const initials=title.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join("").toUpperCase()||"M";
 let h=0;for(const ch of String(p?.categoryName??""))h=(h*31+ch.charCodeAt(0))%360;
 const fallback=`<svg viewBox="0 0 400 300" role="presentation" focusable="false"><rect width="400" height="300" fill="hsl(${h} 30% 86%)"/><text x="200" y="150" text-anchor="middle" dominant-baseline="middle" font-family="Fraunces, Georgia, serif" font-size="84" fill="hsl(${h} 28% 32%)">${esc(initials)}</text></svg>`;
 const img=p?.imageUrl?`<img src="${esc(p.imageUrl)}" alt="${esc(title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none'">`:"";
 return `<div class="media${big?" big":""}">${fallback}${img}</div>`;
}
```

Change `CartItem` to store `imageUrl:p.imageUrl??null` instead of `pic:pic(p)`.

- [ ] **Step 4: Use the helper in every product surface**

- `V.browse` card media (replaced again in Task 8) uses `${media(p)}`.
- `V.product` detail uses `${media(p,true)}`.
- `V.cart` line uses `media({title:i.titleSnapshot,imageUrl:i.imageUrl})`.
- `V.seller` listings table uses `media(p)`.
- `V.edit` does not render media.

- [ ] **Step 5: Add media CSS**

```css
.media{position:relative;aspect-ratio:4/3;overflow:hidden;border-radius:calc(var(--r-lg) - 6px);background:var(--chip)}
.media.big{aspect-ratio:4/5;border-radius:var(--r-lg)}
.media svg{position:absolute;inset:0;width:100%;height:100%}
.media img{position:absolute;inset:0;z-index:1;width:100%;height:100%;object-fit:cover}
.product-card .media{transition:transform .18s ease}
.table .media{width:56px;aspect-ratio:1;border-radius:8px}
```

Remove the `.pic` rules.

- [ ] **Step 6: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: media assertions pass; product pages still render.

```bash
git add src/public/index.html scripts/stress-test.mjs
git commit -m "feat: replace emoji product media with image fallbacks"
```

---

### Task 8: Browse composition and mobile filters

**Files:**
- Modify: `src/public/index.html`
- Modify: `scripts/stress-test.mjs` (section 1)

- [ ] **Step 1: Add failing assertions**

In section 1:

```js
ok("Browse has a mobile filter drawer", root.body.includes('class="filters"') && root.body.includes("<summary>"));
ok("Browse cards expose a product link and add control", root.body.includes("product-card") && root.body.includes('data-act="add"'));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL for the two browse assertions.

- [ ] **Step 3: Replace `V.browse`**

```js
let browsePainted=false;
V.browse=()=>{
 const f=catalog,base=db.products;
 let ps=base.filter(p=>(!f.categoryId||p.categoryId==f.categoryId)&&(!f.query||p.title.toLowerCase().includes(f.query.toLowerCase()))&&(f.min===""||p.priceMinor>=f.min*100)&&(f.max===""||p.priceMinor<=f.max*100));
 ps.sort((a,b)=>f.sort=="lo"?a.priceMinor-b.priceMinor:f.sort=="hi"?b.priceMinor-a.priceMinor:b.id-a.id);
 const cnt=id=>base.filter(p=>!id||p.categoryId==id).length;
 const dirty=!!(f.categoryId||f.query||f.min!==""||f.max!=="");
 const seller=p=>p.sellerName??full(p.sellerId)?.sellerName??"Seller";
 const card=p=>`<article class="card product-card"><a class="card-link" href="#/product/${p.id}">${media(p)}<h2 class="product-title">${esc(p.title)}</h2></a><p class="mute seller">Sold by ${esc(seller(p))}</p><div class="row"><span class="price">${money(p.priceMinor)}</span><span class="sp"></span><button class="sm" data-act="add" data-id="${p.id}" aria-label="Add ${esc(p.title)} to cart">Add</button></div></article>`;
 const active=[f.categoryId?`<span class="chip">${esc(db.categories.find(c=>c.id==f.categoryId)?.name??"Category")}</span>`:"",f.query?`<span class="chip">Search: ${esc(f.query)}</span>`:"",(f.min!==""||f.max!=="")?`<span class="chip">${f.min!==""?money(f.min*100):"Any"} – ${f.max!==""?money(f.max*100):"Any"}</span>`:""].filter(Boolean);
 const stagger=browsePainted?"":" stagger";browsePainted=true;
 return `<div class="layout">
 <details class="filters"${matchMedia("(min-width:880px)").matches?" open":""}>
  <summary>Filters <span class="mute">${ps.length} result${ps.length===1?"":"s"}</span></summary>
  <aside aria-label="Filters"><h3>Categories</h3><div class="fcats">
   <a class="fcat ${f.categoryId?"":"on"}" href="#" data-act="cat" data-id="0"><span>All</span><span class="cnt">${cnt(0)}</span></a>
   ${db.categories.map(c=>`<a class="fcat ${f.categoryId==c.id?"on":""}" href="#" data-act="cat" data-id="${c.id}"><span>${esc(c.name)}</span><span class="cnt">${cnt(c.id)}</span></a>`).join("")}
  </div>
  <h3>Price (${CURRENCY})</h3><div class="prange"><input id="min" inputmode="numeric" placeholder="Min" maxlength="7" value="${esc(f.min)}" aria-label="Minimum price"><span class="dash">–</span><input id="max" inputmode="numeric" placeholder="Max" maxlength="7" value="${esc(f.max)}" aria-label="Maximum price"></div>
  <div class="fbtns"><button class="sm" data-act="price">Apply</button>${dirty?`<button class="sm ghost" data-act="clearf">Reset</button>`:""}</div>
  <p class="fhint mute">Press Enter in a price field to apply.</p></aside>
 </details>
 <section aria-labelledby="browse-title">
  <div class="browse-head"><div><h1 id="browse-title">Browse the market</h1><p class="mute">${ps.length} result${ps.length===1?"":"s"}</p></div>
  <label class="sort-label" for="sort">Sort</label><select id="sort"><option value="new">Newest</option><option value="lo" ${f.sort=="lo"?"selected":""}>Price: low to high</option><option value="hi" ${f.sort=="hi"?"selected":""}>Price: high to low</option></select></div>
  ${active.length?`<div class="active-filters">${active.join("")}</div>`:""}
  ${ps.length?`<div class="grid${stagger}">${ps.map(card).join("")}</div>`:`<div class="card empty"><h2>Nothing matches yet</h2><p class="mute">Widen the price range, clear the search, or try another category.</p><button class="sm ghost" data-act="clearf">Clear all filters</button></div>`}
 </section></div>`;
};
```

- [ ] **Step 4: Close the drawer after mobile filtering**

In `route()`, after writing the view, add:

```js
if(window.matchMedia("(max-width:879px)").matches){const fd=$(".filters");if(fd)fd.open=false}
```

- [ ] **Step 5: Keep scroll position for filter changes**

Add `let keepScroll=false;` near `const catalog`.

In `A.cat`, `A.price`, `A.clearf`, set `keepScroll=true` before `route()`. In the `change` listener for `#sort`, set it too.

In `route()`, before the loading state:

```js
const previousScroll=window.scrollY;
```

Replace the final `window.scrollTo(0,0)` with:

```js
if(keepScroll)window.scrollTo(0,previousScroll);else window.scrollTo(0,0);
keepScroll=false;
```

- [ ] **Step 6: Reflect search in the URL hash**

Replace the `#q` branch in the keydown listener:

```js
if(id==="q"){
 const term=ev.target.value.trim();
 catalog.query=term;
 const next=term?`#/?q=${encodeURIComponent(term)}`:"#/";
 if(location.hash!==next)location.hash=next;else route();
}
```

In `route()`, after `name` and `args` are computed, add:

```js
if(name==="browse"&&typeof q.q==="string")catalog.query=q.q;
```

In `A.clearf`, after clearing the fields, replace the final `route()` with:

```js
if(location.hash.includes("?")){location.hash="#/";return}
route();
```

- [ ] **Step 7: Add browse CSS**

```css
.browse-head{display:flex;align-items:end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.8rem}
.browse-head h1{margin:0}
.sort-label{display:flex;align-items:center;gap:.4rem;font-size:.8rem;font-weight:600;color:var(--mute)}
.sort-label select{width:auto}
.filters>summary{display:none}
.active-filters{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.8rem}
.product-card{padding:.55rem .55rem 1rem;display:flex;flex-direction:column;gap:.15rem}
.product-card .card-link:hover{text-decoration:none}
.product-title{font:600 1rem/1.35 "Instrument Sans",system-ui,sans-serif;color:var(--ink);margin:.55rem 0 .1rem}
.product-card .seller{font-size:.8rem}
@media(max-width:879px){
 .layout{grid-template-columns:1fr}
 .filters{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:.4rem .8rem}
 .filters>summary{display:flex;align-items:center;justify-content:space-between;min-height:44px;font-weight:600;cursor:pointer}
 .filters aside{border:0;padding:0 0 .6rem;background:none;position:static}
}
```

- [ ] **Step 8: Add the compact mobile account menu**

Replace the signed-in segment of `navbar()` with:

```js
${u?`<details class="account"${matchMedia("(min-width:761px)").matches?" open":""}><summary class="pill">${esc(u.name)}</summary><div class="account-links"><a class="pill" href="#/orders">My orders</a><a class="pill" href="#/seller">${auth.hasRole("seller")?"Sell":"Become a seller"}</a><a class="quiet" href="#" data-act="logout">Log out</a></div></details>`
 :`<span class="who">Browsing as guest</span><a class="pill" href="#/login">Log in</a>`}
```

Add CSS:

```css
.account{position:relative}
.account>summary{list-style:none;cursor:pointer}
.account>summary::-webkit-details-marker{display:none}
.account-links{display:flex;gap:.6rem;align-items:center}
@media(min-width:761px){.account>summary{display:none}}
@media(max-width:760px){
 .account-links{position:absolute;right:0;top:calc(100% + .45rem);min-width:190px;display:grid;gap:.35rem;
  padding:.5rem;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);z-index:10}
 .account-links .pill{width:100%;justify-content:flex-start}
}
```

- [ ] **Step 9: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: browse assertions pass; no JS boot errors on `/`.

```bash
git add src/public/index.html scripts/stress-test.mjs
git commit -m "feat: rebuild browse composition with mobile filters"
```

---

### Task 9: Product page composition

**Files:**
- Modify: `src/public/index.html`
- Modify: `scripts/stress-test.mjs` (section 1)

- [ ] **Step 1: Add failing assertions**

In section 1:

```js
ok("Product page has a buy box and trust row", root.body.includes("buybox") && root.body.includes("Buyer protection"));
ok("Product page has a mobile buy bar", root.body.includes("mobile-buy"));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL for both.

- [ ] **Step 3: Replace `V.product`**

```js
V.product=async([id])=>{
 const d=await api("/products/"+encodeURIComponent(id));
 const p=d.product;
 if(!p)return"<p>Product not found.</p>";
 const rv=d.reviews??[];
 const rate=d.sellerRating?`${stars(d.sellerRating.avg)} ${d.sellerRating.avg.toFixed(1)} (${d.sellerRating.n})`:"No reviews yet";
 const disabled=p.qty?"":" disabled";
 return `<nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Browse</a><span aria-hidden="true">›</span><span>${esc(p.categoryName)}</span></nav>
 <div class="product-layout">
  <div class="product-media">${media(p,true)}</div>
  <div class="buybox card">
   <h1>${esc(p.title)}</h1>
   <div class="price big">${money(p.priceMinor)}</div>
   <p class="mute">Sold by ${esc(p.sellerName)} · ${rate}</p>
   <p><span class="chip ${p.qty?"ok":"bad"}">${p.qty?`In stock: ${p.qty}`:"Sold out"}</span></p>
   <div class="method-chips">${db.methods.map(m=>`<span class="chip">${esc(m.name)}</span>`).join("")}</div>
   <label for="qty">Quantity</label><input id="qty" type="number" min="1" max="${p.qty}" value="1">
   <div class="buy-actions"><button data-act="add" data-id="${p.id}" data-qty${disabled}>Add to cart</button><button class="ghost" data-act="buy" data-id="${p.id}"${disabled}>Buy now</button></div>
   <ul class="trust"><li>Buyer protection</li><li>Pickup or delivery</li><li>Refunds via support</li></ul>
  </div>
 </div>
 <div class="product-detail"><h2>Description</h2><p>${esc(p.description)}</p><h2>Seller reviews</h2>
  ${rv.map(r=>`<p><span class="stars-static" aria-label="${r.rating} out of 5">${stars(r.rating)}</span> ${esc(r.comment||"")}${r.buyerName?` <span class="mute">— ${esc(r.buyerName)}</span>`:""}</p>`).join("")||'<p class="mute">No reviews yet.</p>'}
 </div>
 <div class="mobile-buy"><span class="price">${money(p.priceMinor)}</span><button data-act="add" data-id="${p.id}" data-qty${disabled}>Add to cart</button></div>`;
};
```

- [ ] **Step 4: Add product CSS**

```css
.crumbs{display:flex;gap:.45rem;align-items:center;font-size:.85rem;margin-bottom:.8rem}
.product-layout{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr);gap:1.7rem;align-items:start}
.product-media{position:sticky;top:4.6rem}
.buybox{position:sticky;top:4.6rem}
.buybox h1{margin-top:0}
.price.big{font-size:1.5rem}
.method-chips{display:flex;gap:.4rem;flex-wrap:wrap;margin:.7rem 0}
.buy-actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.8rem}
.trust{list-style:none;padding:0;margin:1rem 0 0;display:grid;gap:.3rem;font-size:.84rem;color:var(--mute)}
.trust li::before{content:"✓";color:var(--go);margin-right:.45rem}
.product-detail{max-width:65ch;margin-top:1.8rem}
.product-detail p{overflow-wrap:anywhere}
.mobile-buy{display:none}
@media(max-width:880px){
 .product-layout{grid-template-columns:1fr}
 .product-media,.buybox{position:static}
 .mobile-buy{display:flex;position:sticky;bottom:0;z-index:6;align-items:center;gap:.8rem;
   padding:.7rem 1rem;background:var(--card);border-top:1px solid var(--line)}
 .mobile-buy .price{flex:1}
}
```

- [ ] **Step 5: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: new product assertions pass; add-to-cart still works.

```bash
git add src/public/index.html scripts/stress-test.mjs
git commit -m "feat: rebuild product page around the buy box"
```

---

### Task 10: Cart, checkout and order progress

**Files:**
- Modify: `src/public/index.html`
- Modify: `scripts/stress-test.mjs` (section 1)

- [ ] **Step 1: Add failing assertions**

In section 1:

```js
ok("Cart updates totals in place", root.body.includes("data-line-total") && root.body.includes("data-subtotal"));
ok("Order progress uses text labels", root.body.includes("order-steps"));
ok("Checkout links errors to fields", root.body.includes("aria-describedby") || root.body.includes("field-err"));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL for the three.

- [ ] **Step 3: Replace `V.cart`**

```js
V.cart=()=>{const g=cart.groupBySeller();if(!cart.items.length)return'<div class="card empty"><h1>Your cart is empty</h1><p class="mute">Saved items live here until you check out.</p><a class="btn" href="#/">Find something to buy</a></div>';
 return `<h1>Shopping cart <span class="mute">(${cart.count()} items)</span></h1><div class="two"><div>${Object.entries(g).map(([s,its])=>`<div class="group">Seller: ${esc(full(s)?.sellerName??"Seller")}</div>${its.map(i=>`<div class="card cart-line" data-line="${i.productId}">${media({title:i.titleSnapshot,imageUrl:i.imageUrl})}<div class="cart-line-body"><a href="#/product/${i.productId}">${esc(i.titleSnapshot)}</a><span class="mute">${money(i.unitPriceMinor)} each</span></div><input class="qty-input" type="number" min="1" value="${i.quantity}" data-act="qty" data-id="${i.productId}" aria-label="Quantity for ${esc(i.titleSnapshot)}"><span class="price" data-line-total>${money(i.lineTotalMinor())}</span><button class="sm ghost" data-act="rm" data-id="${i.productId}" aria-label="Remove ${esc(i.titleSnapshot)}">Remove</button></div>`).join("")}`).join("")}</div>
 <div class="card"><h2>Order summary</h2><div class="row"><span>Subtotal</span><span class="sp"></span><span data-subtotal>${money(cart.subtotalMinor())}</span></div><p class="mute">Items ship separately per seller. The final total is confirmed by the server.</p><a class="btn" style="display:block;text-align:center" href="#/checkout">Checkout</a></div></div>`;
};
```

- [ ] **Step 4: Update quantity in place**

Replace `A.qty`:

```js
qty(e){
 const id=+e.dataset.id;
 cart.updateQuantity(id,e.value);
 const it=cart.items.find(i=>i.productId==id);
 if(!it)return;
 e.value=it.quantity;
 const line=document.querySelector(`[data-line="${id}"]`);
 if(line){const total=line.querySelector("[data-line-total]");if(total)total.textContent=money(it.lineTotalMinor())}
 const subtotal=document.querySelector("[data-subtotal]");
 if(subtotal)subtotal.textContent=money(cart.subtotalMinor());
 navbar();
}
```

- [ ] **Step 5: Add field-error helpers**

Near the utilities:

```js
function setFieldError(input,message){
 let p=input.parentElement.querySelector(".field-err");
 if(!p){p=document.createElement("p");p.className="field-err";input.parentElement.append(p)}
 const id=`err-${input.name}`;p.id=id;p.textContent=message;
 input.setAttribute("aria-invalid","true");
 input.setAttribute("aria-describedby",id);
}
function clearFieldError(input){
 const p=input.parentElement.querySelector(".field-err");
 if(p)p.remove();
 input.removeAttribute("aria-invalid");
 input.removeAttribute("aria-describedby");
}
```

Add a global input listener:

```js
document.addEventListener("input",ev=>{if(ev.target.matches('[aria-invalid="true"]'))clearFieldError(ev.target)});
```

- [ ] **Step 6: Make checkout validate fields**

Add `novalidate` to the checkout form:

```html
<form data-form="checkout" class="two" novalidate>
```

In the submit handler, before building the request:

```js
if(k==="checkout"){
 const required=[...f.querySelectorAll("[required]")];
 const missing=required.find(el=>!el.value.trim());
 if(missing){setFieldError(missing,"This field is required.");missing.focus();return}
 required.forEach(clearFieldError);
}
```

Add CSS:

```css
.field-err{color:var(--bad);font-size:.82rem;margin:.25rem 0 0}
input[aria-invalid="true"],select[aria-invalid="true"],textarea[aria-invalid="true"]{border-color:var(--bad);box-shadow:0 0 0 2px var(--bad-soft)}
```

- [ ] **Step 7: Replace the order stepper**

```js
const stepper=s=>{const i=STEPS.indexOf(s.fulfillment);
 if(i<0)return `<span class="chip bad">${LABEL[s.fulfillment]??s.fulfillment}</span>`;
 return `<ol class="order-steps" aria-label="Order progress">${STEPS.map((x,k)=>`<li class="${k<=i?"done":""}"${k===i?' aria-current="step"':""}>${LABEL[x]}</li>`).join("")}</ol>`;
};
```

Add CSS:

```css
.cart-line{display:grid;grid-template-columns:72px minmax(0,1fr) auto auto auto;gap:.7rem;align-items:center;margin-bottom:.4rem}
.cart-line .media{width:72px;aspect-ratio:1}
.cart-line-body{display:grid;gap:.1rem;min-width:0}
.qty-input{width:72px}
.order-steps{display:flex;list-style:none;padding:0;margin:0;gap:.3rem;flex-wrap:wrap;font-size:.76rem;color:var(--mute)}
.order-steps li{padding:.15rem .5rem;border:1px solid var(--line);border-radius:999px}
.order-steps li.done{background:var(--go-soft);border-color:var(--go);color:var(--go)}
@media(max-width:760px){.cart-line{grid-template-columns:56px 1fr;grid-auto-rows:auto}.cart-line .price,.cart-line .qty-input,.cart-line button{grid-column:2}}
```

- [ ] **Step 8: Show the stored order currency**

In `V.orders`, change the order total to `money(o.totalMinor,o.currency)`.
In `V.pay`, change the amount to `money(o.totalMinor,o.currency)`.

In `/seller/orders`, add `mo.currency` to the SELECT, add `currency: string` to the row type, and return `currency: r.currency` in each order object. In `V.seller`, change the seller-order total to `money(s.totalMinor,s.currency)`.

Add the sticky checkout summary:

```css
@media(min-width:881px){.two>form>.card:last-child{position:sticky;top:4.6rem}}
```

- [ ] **Step 9: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: cart/checkout/order assertions pass.

```bash
git add src/public/index.html scripts/stress-test.mjs
git commit -m "feat: make cart and checkout updates accessible"
```

---

### Task 11: Loading, empty and retry states

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: Add the skeleton**

```js
const skeletonGrid=()=>`<div class="grid" aria-hidden="true">${Array.from({length:8},()=>`<div class="card skeleton"><div class="sk-media"></div><div class="sk-line"></div><div class="sk-line short"></div></div>`).join("")}</div>`;
```

- [ ] **Step 2: Use it in `route()`**

Replace the loading write:

```js
$("#app").innerHTML=name==="browse"?skeletonGrid():'<div class="card empty" role="status"><p class="mute">Loading…</p></div>';
```

- [ ] **Step 3: Add retry**

Replace `errBox`:

```js
const errBox=(msg)=>`<div class="card empty" role="alert"><h2>Something went wrong</h2><p class="mute">${esc(msg)}</p><div class="row"><button data-act="retry">Try again</button><a class="btn ghost" href="#/">Back to the market</a></div></div>`;
```

Add to `A`:

```js
retry(){route()},
```

- [ ] **Step 4: Add skeleton CSS**

```css
.skeleton{overflow:hidden}
.sk-media{aspect-ratio:4/3;border-radius:calc(var(--r-lg) - 6px);background:var(--chip)}
.sk-line{height:12px;border-radius:6px;background:var(--chip);margin-top:.6rem;width:80%}
.sk-line.short{width:45%}
@media(prefers-reduced-motion:no-preference){
 .skeleton{animation:pulse 1.2s ease-in-out infinite alternate}
 @keyframes pulse{from{opacity:.65}to{opacity:1}}
}
```

- [ ] **Step 5: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: all checks pass; `/` still boots.

```bash
git add src/public/index.html
git commit -m "feat: add storefront loading and retry states"
```

---

### Task 12: Seller dashboard composition

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: Fix the completed branch and put "Awaiting you" first**

In `V.seller`, replace the broken `completed:completed.includes(s)` entry with:

```js
completed:s.fulfillment==="completed"?(s.release!="not_eligible"?'<span class="chip warn">Refund requested</span>':'<span class="chip ok">Order complete</span>'):""
```

In `V.seller`, replace the stats row so "Awaiting you" is the first card:

```html
<div class="row seller-stats" style="margin-bottom:1.2rem">
 <div class="card stat-card"><div class="mute">Awaiting you</div><h2>${st.awaitingAction}</h2></div>
 <div class="card"><div class="mute">Completed revenue</div><h2>${money(st.revenueMinor)}</h2></div>
 <div class="card"><div class="mute">Units sold</div><h2>${st.unitsSold}</h2></div>
 <div class="card"><div class="mute">Open orders</div><h2>${st.openOrders}</h2></div>
 <div class="card"><div class="mute">Active listings</div><h2>${mine.filter(p=>p.status=="active").length}</h2></div>
</div>
```

- [ ] **Step 2: Use media in the listings table**

Replace `<td style="font-size:1.6rem">${pic(p)}</td>` with:

```html
<td>${media(p)}</td>
```

- [ ] **Step 3: Add seller CSS**

```css
.seller-stats .card{flex:1 1 150px}
.seller-stats .stat-card{background:var(--acc-soft);border-color:var(--acc)}
.seller-stats h2{margin:.15rem 0 0;font-size:1.55rem}
```

- [ ] **Step 4: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: seller stats API checks still pass; page renders.

```bash
git add src/public/index.html
git commit -m "feat: lead seller dashboard with pending work"
```

---

### Task 13: Admin dashboard queries

**Files:**
- Modify: `src/admin/routes/dashboard.ts`
- Modify: `scripts/stress-test.mjs` (section 9)

- [ ] **Step 1: Add failing dashboard assertions**

In section 9 after `dash`:

```js
ok("Dashboard shows revenue chart", dash.body.includes('data-chart="revenue"'));
ok("Dashboard shows an order pipeline", dash.body.includes("Order pipeline"));
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `node scripts/stress-test.mjs`
Expected: FAIL for both.

- [ ] **Step 3: Replace the route**

```ts
import { Router } from "express";
import { query } from "../db-helpers.js";
import { env } from "../../env.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", async (_req, res, next) => {
  try {
    const stats = (
      await query(
        `SELECT
          (SELECT count(*) FROM app_user) AS users,
          (SELECT count(*) FROM user_role ur JOIN app_role r ON r.role_id = ur.role_id
            WHERE r.role_name = 'seller' AND ur.approval_status = 'approved') AS sellers,
          (SELECT count(*) FROM market_order) AS orders`,
      )
    ).rows[0];

    const revenueByCurrency = (
      await query<{ currency: string; revenue_minor: string }>(
        `SELECT currency, coalesce(sum(total_amount_minor),0)::text AS revenue_minor
         FROM market_order WHERE order_status IN ('confirmed','completed')
         GROUP BY currency ORDER BY currency`,
      )
    ).rows;

    const trendRows = (
      await query<{ day: string; revenue_minor: string }>(
        `SELECT to_char(date_trunc('day', ordered_at), 'YYYY-MM-DD') AS day,
                coalesce(sum(total_amount_minor),0)::text AS revenue_minor
         FROM market_order
         WHERE currency = $1 AND order_status IN ('confirmed','completed')
           AND ordered_at >= current_date - interval '13 days'
         GROUP BY 1 ORDER BY 1`,
        [env.currency],
      )
    ).rows;

    const byDay = new Map(trendRows.map((r) => [r.day, Number(r.revenue_minor)]));
    const daily: { day: string; revenue_minor: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      daily.push({ day: key, revenue_minor: byDay.get(key) ?? 0 });
    }

    const pipeline = (
      await query(
        `SELECT
          count(*) FILTER (WHERE fulfillment_status = 'pending')::int AS pending,
          count(*) FILTER (WHERE fulfillment_status IN ('confirmed','processing'))::int AS processing,
          count(*) FILTER (WHERE fulfillment_status = 'shipped')::int AS shipped,
          count(*) FILTER (WHERE fulfillment_status = 'completed')::int AS completed
         FROM seller_order`,
      )
    ).rows[0];

    const pending = (
      await query(
        `SELECT u.user_id, u.name, u.email, ur.assigned_at
         FROM user_role ur
         JOIN app_role r ON r.role_id = ur.role_id
         JOIN app_user u ON u.user_id = ur.user_id
         WHERE r.role_name = 'seller' AND ur.approval_status = 'pending'
         ORDER BY ur.assigned_at LIMIT 5`,
      )
    ).rows;

    const recent = (
      await query(
        `SELECT so.seller_order_id, mo.order_id, bu.name AS buyer, mo.total_amount_minor,
                mo.currency, so.fulfillment_status, mo.ordered_at
         FROM seller_order so
         JOIN market_order mo ON mo.order_id = so.order_id
         JOIN app_user bu ON bu.user_id = mo.buyer_id
         ORDER BY mo.ordered_at DESC LIMIT 5`,
      )
    ).rows;

    const lowStock = (
      await query(
        `SELECT p.product_id, p.title, su.name AS seller, p.quantity_available
         FROM product p JOIN app_user su ON su.user_id = p.seller_id
         WHERE p.listing_status = 'active' AND p.quantity_available <= 2
         ORDER BY p.quantity_available, p.product_id LIMIT 5`,
      )
    ).rows;

    res.render("dashboard", {
      title: "Dashboard",
      active: "dashboard",
      stats,
      revenueByCurrency,
      daily,
      pipeline,
      pending,
      recent,
      lowStock,
    });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Rebuild and commit**

Run: `npm run build`
Expected: no TypeScript errors.

```bash
git add src/admin/routes/dashboard.ts scripts/stress-test.mjs
git commit -m "feat: add revenue and pipeline dashboard queries"
```

The assertions still fail until Task 14 updates the view.

---

### Task 14: Admin dashboard view, CSS and currency defaults

**Files:**
- Modify: `src/admin/views/dashboard.ejs`
- Modify: `src/admin/public/css/admin.css`
- Modify: `src/admin/app.ts`
- Modify: `src/admin/views/product_form.ejs`
- Modify: `src/admin/views/products.ejs`

- [ ] **Step 1: Replace the dashboard view**

```html
<%- include('partials/header') %>
<div class="dash-kpis">
  <div class="card stat-card"><div class="stat-label">Users</div><div class="stat-value"><%= stats.users %></div></div>
  <div class="card stat-card"><div class="stat-label">Approved sellers</div><div class="stat-value"><%= stats.sellers %></div></div>
  <div class="card stat-card"><div class="stat-label">Orders</div><div class="stat-value"><%= stats.orders %></div></div>
  <div class="card stat-card">
    <div class="stat-label">Revenue by currency</div>
    <% if (!revenueByCurrency.length) { %><div class="stat-value"><%= money(0) %></div><div class="text-muted small">No confirmed orders yet</div><% } else { %>
      <% revenueByCurrency.forEach(r => { %><div class="stat-value"><%= money(r.revenue_minor, r.currency) %></div><% }) %>
    <% } %>
  </div>
</div>

<div class="card chart-card">
  <div class="d-flex justify-content-between align-items-center mb-2">
    <h2 class="h6 m-0">Revenue · last 14 days</h2>
    <span class="text-muted small">Confirmed and completed orders</span>
  </div>
  <% const peak = Math.max(1, ...daily.map(d => d.revenue_minor)); %>
  <div class="chart" data-chart="revenue" role="img" aria-label="Revenue for the last 14 days">
    <% daily.forEach(d => { %><div class="chart-col"><div class="chart-bar" style="height:<%= Math.max(2, Math.round(d.revenue_minor / peak * 100)) %>%" title="<%= d.day %>: <%= money(d.revenue_minor) %>"></div><span class="chart-day"><%= d.day.slice(5) %></span></div><% }) %>
  </div>
</div>

<div class="card">
  <h2 class="h6">Order pipeline</h2>
  <div class="pipeline">
    <div><span class="pipeline-count"><%= pipeline.pending %></span><span>Pending</span></div>
    <div><span class="pipeline-count"><%= pipeline.processing %></span><span>Confirmed / processing</span></div>
    <div><span class="pipeline-count"><%= pipeline.shipped %></span><span>Shipped</span></div>
    <div><span class="pipeline-count"><%= pipeline.completed %></span><span>Completed</span></div>
  </div>
</div>

<div class="row g-3">
  <div class="col-lg-6"><div class="card h-100"><div class="card-body">
    <h2 class="h6">Pending seller approvals</h2>
    <% if (!pending.length) { %><p class="text-muted mb-0">No sellers waiting for approval.</p><% } else { %>
    <div class="table-responsive"><table class="table table-sm align-middle mb-0">
      <thead><tr><th>Seller</th><th>Email</th><th>Since</th></tr></thead>
      <tbody><% pending.forEach(p => { %><tr><td><a href="/admin/users/<%= p.user_id %>"><%= p.name %></a></td><td><%= p.email %></td><td><%= fmtDate(p.assigned_at) %></td></tr><% }) %></tbody>
    </table></div><% } %>
  </div></div></div>

  <div class="col-lg-6"><div class="card h-100"><div class="card-body">
    <h2 class="h6">Recent orders</h2>
    <% if (!recent.length) { %><p class="text-muted mb-0">No orders yet.</p><% } else { %>
    <div class="table-responsive"><table class="table table-sm align-middle mb-0">
      <thead><tr><th>Order</th><th>Buyer</th><th>Total</th><th>Status</th></tr></thead>
      <tbody><% recent.forEach(o => { %><tr>
        <td>#<%= o.order_id %></td><td><%= o.buyer %></td>
        <td><%= money(o.total_amount_minor, o.currency) %></td>
        <td><span class="badge text-bg-secondary"><%= o.fulfillment_status %></span></td>
      </tr><% }) %></tbody>
    </table></div><% } %>
  </div></div></div>
</div>

<div class="card"><div class="card-body">
  <h2 class="h6">Low stock</h2>
  <% if (!lowStock.length) { %><p class="text-muted mb-0">No active products are running low.</p><% } else { %>
  <div class="table-responsive"><table class="table table-sm align-middle mb-0">
    <thead><tr><th>Product</th><th>Seller</th><th>Left</th><th></th></tr></thead>
    <tbody><% lowStock.forEach(p => { %><tr><td><%= p.title %></td><td><%= p.seller %></td><td><span class="badge text-bg-warning"><%= p.quantity_available %></span></td><td class="text-end"><a class="btn btn-outline-secondary btn-sm" href="/admin/products/<%= p.product_id %>/edit">Restock</a></td></tr><% }) %></tbody>
  </table></div><% } %>
</div></div>
<%- include('partials/footer') %>
```

- [ ] **Step 2: Add dashboard CSS**

```css
.dash-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:16px}
.dash-kpis .stat-value{font-size:1.5rem;overflow-wrap:anywhere}
.chart-card{margin-bottom:16px}
.chart{display:flex;align-items:flex-end;gap:6px;height:140px;padding-top:8px}
.chart-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-width:0}
.chart-bar{width:100%;max-width:30px;background:linear-gradient(180deg,var(--acc),var(--acc-soft));border-radius:5px 5px 2px 2px;min-height:2px}
.chart-day{font-size:.62rem;color:var(--mute);font-variant-numeric:tabular-nums}
.pipeline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.pipeline>div{display:grid;gap:2px;padding:10px 12px;background:var(--paper);border-radius:9px}
.pipeline-count{font-family:Fraunces,Georgia,serif;font-size:1.5rem;font-weight:560}
.pipeline span:last-child{font-size:.78rem;color:var(--mute)}
@media(max-width:900px){.dash-kpis,.pipeline{grid-template-columns:repeat(2,minmax(0,1fr))}}
```

- [ ] **Step 3: Use the configured currency in admin**

In `src/admin/app.ts`:

```ts
import { env } from "../env.js";
```

After the view engine setup:

```ts
adminApp.locals.currency = env.currency;
```

Change the money default:

```ts
adminApp.locals.money = (minor: string | number, cur = env.currency): string =>
  `${cur} ${(Number(minor) / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
```

In `product_form.ejs`, change the price label:

```html
<label class="form-label" for="asking_price">Price (<%= currency %>)</label>
```

In `products.ejs`, change the price cell:

```html
<td class="text-end"><%= money(Math.round(Number(p.asking_price) * 100)) %></td>
```

- [ ] **Step 4: Verify and commit**

Run: `npm run build`, restart the server, then `node scripts/stress-test.mjs`.
Expected: dashboard assertions pass; all admin pages 200.

```bash
git add src/admin/views/dashboard.ejs src/admin/public/css/admin.css src/admin/app.ts src/admin/views/product_form.ejs src/admin/views/products.ejs scripts/stress-test.mjs
git commit -m "feat: rebuild dashboard around revenue and pipeline"
```

---

### Task 15: Apply the tuned motion system

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: Add motion tokens**

To the storefront `:root`:

```css
--ease:cubic-bezier(.2,.7,.2,1);
--dur-1:120ms; --dur-2:180ms; --dur-3:240ms;
```

- [ ] **Step 2: Replace the entry animation block**

Delete the existing `@media(prefers-reduced-motion:no-preference)` block containing `rise`, the eight nth-child delays and `fade`. Replace with:

```css
@media(prefers-reduced-motion:no-preference){
 .grid.stagger>.card{animation:rise var(--dur-3) var(--ease) both}
 .grid.stagger>.card:nth-child(2){animation-delay:24ms}
 .grid.stagger>.card:nth-child(3){animation-delay:48ms}
 .grid.stagger>.card:nth-child(4){animation-delay:72ms}
 @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
 @keyframes fade{from{opacity:0}to{opacity:1}}
 ::view-transition-old(root){animation:fade 160ms var(--ease) both reverse}
 ::view-transition-new(root){animation:fade 160ms var(--ease) both}
 .filters[open] aside{animation:drawer var(--dur-2) var(--ease)}
 @keyframes drawer{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
}
@media(prefers-reduced-motion:reduce){
 *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
 html{scroll-behavior:auto}
 ::view-transition-old(root),::view-transition-new(root){animation:none!important}
}
```

- [ ] **Step 3: Make hover lift pointer-only and quieter**

Replace `.grid>.card` transition and hover rules with:

```css
.grid>.card{transition:box-shadow var(--dur-2) var(--ease)}
@media(hover:hover) and (pointer:fine){
 .grid>.card:hover{transform:translateY(-2px);box-shadow:var(--shadow);transition:transform 140ms var(--ease),box-shadow 140ms var(--ease)}
 .product-card .card-link:hover .media{transform:scale(1.02)}
}
```

Replace button transitions:

```css
.btn,button{transition:transform 90ms var(--ease),background var(--dur-1) var(--ease),box-shadow var(--dur-1) var(--ease),border-color var(--dur-1) var(--ease)}
.btn:active,button:active{transform:scale(.985)}
.toast{animation:rise 140ms var(--ease)}
```

- [ ] **Step 4: Use View Transitions only for route changes**

Remove the existing loading write before the `try` block and show it only when the app is empty, so a View Transition snapshots the previous page:

```js
if(!$("#app").innerHTML.trim())$("#app").innerHTML=name==="browse"?skeletonGrid():'<div class="card empty" role="status"><p class="mute">Loading…</p></div>';
```

Refactor the tail of `route()`:

```js
const render=async()=>{
 $("#app").innerHTML=await (V[name]||(()=>"<p>Page not found.</p>"))(name==="login"?state:args,q);
 if(window.matchMedia("(max-width:879px)").matches){const fd=$(".filters");if(fd)fd.open=false}
 if(keepScroll)window.scrollTo(0,previousScroll);else{$("#app").focus({preventScroll:true});window.scrollTo(0,0)}
 keepScroll=false;
};
if(document.startViewTransition&&!window.matchMedia("(prefers-reduced-motion: reduce)").matches){
 await document.startViewTransition(render).finished;
}else{
 await render();
}
```

Keep the surrounding `try/catch`: on error, write `errBox` directly.

- [ ] **Step 5: Verify and commit**

Run: `node scripts/stress-test.mjs`
Expected: all checks pass; no console errors on browse, product and cart routes.

```bash
git add src/public/index.html
git commit -m "feat: apply tuned quiet-motion system"
```

---

### Task 16: Full verification gate

**Files:**
- Modify: `scripts/stress-test.mjs` (only if a check is missing)

- [ ] **Step 1: Apply the migration on a clean build**

```bash
npm run build
npm run migrate
```

Expected: build succeeds; `005_product_images.sql` is already recorded or applies once.

- [ ] **Step 2: Run the contrast script**

```bash
node scripts/check-contrast.mjs
```

Expected: every line `PASS`; exit 0.

- [ ] **Step 3: Restart and run the harness**

```bash
npm run start
```

In a second terminal:

```bash
node scripts/stress-test.mjs
```

Expected: all existing checks plus the new image, currency, a11y and dashboard checks pass; exit 0.

- [ ] **Step 4: Manual responsive and motion check**

At 390, 768 and 1440 px in light and dark:

- Browse has one `h1`, no horizontal overflow at 360 px, and the mobile filter drawer opens/closes.
- Product buy box is sticky on desktop and the mobile buy bar appears at ≤880 px.
- Card hover lift happens only with a mouse; touch devices do not keep a raised card.
- With `prefers-reduced-motion: reduce`, route changes are instant and no card rises.
- Admin dashboard shows the chart, pipeline and "Soon" labels; no broken icon boxes.

- [ ] **Step 5: Final commit**

```bash
git status --short
```

Only intended files should be listed. If the harness needed a final assertion fix:

```bash
git add scripts/stress-test.mjs
git commit -m "test: cover the refreshed UI contracts"
```
