# M-DUKA Storefront & Admin UI Refresh — Design Spec

**Status:** Approved for implementation planning
**Date:** 2026-11-08
**Scope:** Storefront visual system and composition, product imagery, motion, admin visual alignment and dashboard upgrade, currency consistency, accessibility. No payment, storage or framework changes.

---

## 1. Context

The app has a coherent identity — warm paper, terracotta accent, Fraunces display type, Instrument Sans UI — but the presentation has not caught up with the functionality added around it.

Evidence from the audit:

- Muted text fails WCAG AA in light mode: `#867d6a` on `#f7f2e8` is **3.65:1**; on cards **3.97:1**.
- Warning chips are **3.52:1** and success chips **4.26:1**.
- The admin panel's Phosphor icon font renders as empty boxes; several nav rows have no visible icon.
- Browse has no `h1`; the review modal has no dialog semantics or focus management; toasts are not announced.
- Product media is emoji, the largest visual ceiling in the product.
- Currency is inconsistent: checkout and the storefront use USD, while admin defaults to KES.
- Card stagger replays on every filter render; route changes have no transition.
- Touch targets (filter rows, small buttons, nav pills) are below 44 px.

The goal is a restrained, premium marketplace: keep the identity, raise the craft, and make the interface trustworthy at the decision points.

---

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Product imagery | `image_url` on listings, editable by sellers/admins; photo when present, designed inline-SVG fallback otherwise. No uploads or storage service. |
| Currency | One `APP_CURRENCY` setting (default `USD`) used by checkout, storefront formatting and admin labels. Orders keep their stored currency. Admin revenue groups by currency. |
| Admin scope | Shared tokens, inline SVG icons, contrast/focus fixes, and a dashboard upgrade. No shell rebuild, no Reports/Settings screens. |
| Visual identity | Retained: paper, terracotta, Fraunces + Instrument Sans. No rebrand. |
| Motion | CSS-first, progressive enhancement, no GSAP/ScrollTrigger/scroll-jacking. |

No open questions remain.

---

## 3. Approach

**In-place evolution (chosen).** Keep the storefront as one self-contained `src/public/index.html` with inline CSS and JS. Keep the admin as EJS + Bootstrap. Refactor inside those files, add one migration, and keep the existing build (`tsc`) and test harness.

Shared artifacts:

- One canonical token block, mirrored in the storefront's inline CSS and `src/admin/public/css/admin.css`.
- One inline SVG sprite partial for admin icons: `src/admin/views/partials/icons.ejs`.

Rejected:

- **Extract a shared design system with static CSS routing.** Better long-term, but adds requests and churn across both surfaces for a two-surface app.
- **Rebuild the storefront in React/Vite.** Adds build weight and rewrite risk without a capability the marketplace needs.

---

## 4. Visual system

### 4.1 Color tokens

Light mode:

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#f7f2e8` | paper |
| `--card` | `#fffcf4` | panel |
| `--ink` | `#272b1f` | primary text |
| `--mute` | `#6f6653` | **changed** from `#867d6a`; 5.08:1 on bg, 5.53:1 on card |
| `--line` | `#e7ddc8` | borders |
| `--line-2` | `#efe8d9` | dividers |
| `--acc` | `#b04f2a` | 5.12:1 on card |
| `--acc-deep` | `#8f3e20` | hover; 6.93:1 with `--acc-ink` |
| `--acc-ink` | `#fff8f1` | text on accent; 4.99:1 |
| `--acc-soft` | `#f5e6d9` | tinted hover |
| `--go` | `#2f6440` | **changed**; 5.77:1 on `--go-soft` |
| `--go-soft` | `#e2eddf` | |
| `--warn` | `#7a5217` | **changed**; 5.75:1 on `--warn-soft` |
| `--warn-soft` | `#f3ead3` | |
| `--bad` | `#b23b34` | 4.72:1 on `--bad-soft` |
| `--bad-soft` | `#f6e2de` | |
| `--chip` | `#f0e9d8` | |
| `--star` | `#d9972f` | |

Dark mode keeps the current values, which already pass: `--bg:#17140e`, `--card:#211d15`, `--ink:#ece3cf`, `--mute:#a09477` (6.12:1 / 5.59:1), `--go:#82bd90` (6.68:1), `--warn:#d9a44c` (6.67:1), `--bad:#e07f7a` (5.42:1).

Admin tokens keep the same semantic names with the admin paper/panel values. `--mute` changes from `#8b8171` to `#6f6653` (**4.94:1** on paper, **5.57:1** on panel). Admin also adopts the corrected `--warn` and `--go` text values so badges pass contrast; only the paper, panel, line and sidebar surface values remain admin-specific. Sidebar muted text stays `#a4a08c` on `#1f2119` (6.19:1).

### 4.2 Spacing, type and shape

- Spacing scale: `4, 8, 12, 16, 24, 32, 48, 64 px` (`--s1` through `--s16`). Replace one-off values in touched rules; do not rewrite untouched admin views.
- Type scale: `12, 14, 16, 20, 25, 31, 39 px` (`--t-xs` through `--t-3xl`). Storefront body becomes 16 px; admin stays 14 px. Page titles use `clamp()`; product titles are 15 px / 1.35.
- Radii: storefront `--r-lg:18px`, `--r-sm:10px`; admin `--r:12px`.
- Shadows: keep the existing warm, low-contrast shadows; tighten the card shadow rather than adding new elevation levels.
- Breakpoints: convert the four layout breakpoints to mobile-first `min-width` (520, 760, 880, 1100 px). Grid: `repeat(auto-fill, minmax(200px, 1fr))`, gap 16 px, content max-width 1180 px.

### 4.3 Hierarchy rules

- Product titles use `--ink`, not accent. Accent is reserved for links and the primary action.
- One primary CTA per screen: browse = the card link; product = `Add to cart`; checkout = `Place order`; admin = the page's single main action.
- `Buy now` is a secondary outline action; card-level `Add` is a compact secondary control.
- Prices and counters use `font-variant-numeric: tabular-nums`.
- Product descriptions cap at 65ch.

---

## 5. Storefront composition

### 5.1 Header

- First focusable element: `Skip to content` link targeting `#app` (`tabindex="-1"`).
- Nav becomes: brand, search, cart, orders, seller, account/logout. All interactive elements have a minimum 44×44 px hit area.
- Search keeps its visible icon and `aria-label`; Enter submits, and the query is reflected in the URL hash so the state is shareable.
- Mobile: search takes the full row; secondary links collapse into a compact account menu; no horizontal overflow at 360 px.

### 5.2 Browse

- Visible `h1` "Browse the market" plus result count.
- Desktop: sticky 220 px filter rail with categories, price range and reset.
- Mobile: `<details>` filter drawer with an active-filter summary and chips; applying closes it.
- Grid: four columns at ≥1100 px, two at tablet, one on small phones.
- Card composition: 4:3 media, two-line title, seller, price, compact add control. Whole card is the link. Hover raises 2 px; no competing button weight.
- Filtering keeps the result count and scroll position; no re-stagger.

### 5.3 Product

- Two columns: 4:5 media left; sticky buy box right on desktop.
- Buy box: breadcrumbs, title, price, stock, seller + rating, exchange-method chips, quantity stepper, `Add to cart` primary, `Buy now` secondary.
- Trust row adjacent to the CTA: buyer protection, delivery/pickup, refunds.
- Description below; reviews with average, count and up to three recent reviews.
- Mobile: media first, then buy box; sticky bottom bar with price + add-to-cart.

### 5.4 Cart, checkout, orders

- Cart line items show media thumbnail, title, unit price, accessible quantity stepper and remove. Updating quantity updates line and summary in place — no full route re-render, no focus loss.
- Checkout keeps the single-step form. Errors render below the field with `aria-describedby` and focus moves to the first invalid field. Summary is sticky on desktop; total is labelled with the configured currency.
- Orders show delivery address, a text-labelled status stepper (not dots alone), tracking, review and refund actions. Pending orders show `Awaiting payment`, `Pay now` and `Cancel`.

### 5.5 Auth and seller

- Auth stays a single card with login/register tabs; demo credentials remain.
- Seller analytics keeps the current cards and 14-day chart, restyled to the shared tokens; "Awaiting you" is the first operational card.

### 5.6 States

- Browse/loading: eight skeleton cards with the final card geometry.
- Empty: one component with a title, one sentence and one action (browse, cart, orders, seller listings).
- API failure: retry card preserving the current route.
- Toasts: `role="status" aria-live="polite"`, bottom center, 3.5 s.

---

## 6. Product imagery

### 6.1 Schema

`SQL/005_product_images.sql`:

```sql
BEGIN;
ALTER TABLE product
  ADD COLUMN IF NOT EXISTS image_url TEXT
  CONSTRAINT product_image_url_scheme CHECK (image_url IS NULL OR image_url ~ '^https?://');
COMMIT;
```

### 6.2 API

- `rowToProduct` returns `imageUrl: row.image_url ?? null`.
- Every product SELECT adds `p.image_url` (catalogue cache, filtered list, detail, seller listings).
- `readListing` accepts `imageUrl`: trimmed, ≤500 characters, must match `^https?://`; empty becomes `null`; otherwise `400` with a field-specific message.
- Seller create/update and admin product create/edit write `image_url`.

### 6.3 Rendering

- Card media: `<img>` with `loading="lazy"`, `decoding="async"`, `referrerpolicy="no-referrer"`, `alt` = product title, inside a fixed `aspect-ratio:4/3` frame; detail uses `4/5`.
- The fallback is always rendered beneath the image. On load error the image is hidden and the fallback shown; no layout shift.
- Fallback algorithm: deterministic category tint + up to two title initials in an inline SVG, `aria-hidden="true"`. No emoji anywhere in product media.
- Reject `javascript:`, `data:` and other schemes at the API and DB check; escape all interpolated text.

### 6.4 Forms

- Seller create/edit form: "Image URL (optional)" with live preview and inline error.
- Admin product form: same field, prefixed with the existing seller/category fields.

---

## 7. Motion

Principles: explain state, never decorate; interruptible; respect reduced motion.

| Interaction | Treatment |
|---|---|
| Route/view change | View Transitions API: 180 ms crossfade + 6 px rise; instant fallback |
| Card hover | 160 ms translateY(-2px) + shadow |
| Press | scale(0.98), no bounce |
| Filter drawer | 220 ms ease-out slide/fade |
| Toast | 180 ms rise |
| Browse first paint | 40 ms stagger for the first 5 cards, once per page load |
| Filter/sort | No stagger; optional 80 ms fade |

Implementation:

- Guard `document.startViewTransition`; skip it when `prefers-reduced-motion: reduce`.
- All animation/transition rules live inside `@media (prefers-reduced-motion: no-preference)`.
- Global reduced-motion override sets animation/transition duration to `0.01ms`, disables smooth scroll and view transitions.
- No GSAP, ScrollTrigger, parallax, pinned sections, autoplay or scroll-jacking.

---

## 8. Admin panel

### 8.1 Icons and tokens

- Remove the Phosphor CDN import from `admin.css`.
- Add `src/admin/views/partials/icons.ejs` with inline SVG symbols for: dashboard, users, seller approvals, products, orders, exchange, reports, audit, settings, logout.
- Header partial renders `<svg><use href="#icon-<%= n.icon %>"></use></svg>`; no network dependency for navigation.
- Apply the shared semantic color/spacing tokens; keep Bootstrap for layout, tables and forms.

### 8.2 Dashboard upgrade

Server-rendered in `src/admin/routes/dashboard.ts` and `dashboard.ejs`:

1. KPI cards: users, approved sellers, orders, revenue by currency (one row per stored currency, labelled).
2. 14-day revenue bar chart (CSS bars, no library).
3. Order pipeline counts: pending, confirmed/processing, shipped, completed.
4. Pending seller approvals (existing query, promoted).
5. Low stock with links to product edit.
6. Recent orders (existing).

Empty states are one sentence plus the relevant action. Reports and Settings stay disabled with a visible "Soon" label.

---

## 9. Data and API changes

| File | Change |
|---|---|
| `SQL/005_product_images.sql` | new `image_url` column + scheme check |
| `src/env.ts` | `currency`: `APP_CURRENCY` uppercased, validated `/^[A-Z]{3}$/`, fallback `USD` |
| `src/api/index.ts` | import env; `CURRENCY`; bootstrap returns `currency`; checkout uses `CURRENCY`; product selects and `rowToProduct` add `imageUrl`; listing read/write adds `imageUrl` |
| `src/admin/app.ts` | `money` default currency from env |
| `src/admin/routes/dashboard.ts` | revenue grouped by currency; trend + pipeline queries |
| `src/admin/routes/products.ts` | `image_url` in form read/validate/insert/update |
| `src/admin/views/product_form.ejs` | image URL field + preview |
| `src/admin/views/dashboard.ejs` | KPI, chart, pipeline, approvals, low stock, recent orders |
| `src/admin/views/partials/header.ejs` | inline SVG icons |
| `src/admin/views/partials/icons.ejs` | new sprite |
| `src/admin/public/css/admin.css` | tokens, icon sizing, chart bars, dashboard layout |
| `src/public/index.html` | tokens, composition, media, motion, a11y, currency |
| `scripts/stress-test.mjs` | new API/a11y assertions |

Order currency remains stored per order. The API never converts amounts; it only labels with the configured currency. Admin totals group by `currency` so mixed historical data is never summed silently. The storefront falls back to `USD` if `currency` is missing from the bootstrap payload.

---

## 10. Accessibility acceptance criteria

- All text ≥4.5:1; large text ≥3:1; measured with the project contrast script.
- Visible focus ring (2 px + 2 px offset) on every interactive element.
- Touch targets ≥44×44 px, including filter rows, nav pills, add controls, steppers and modal buttons.
- Skip link is the first focusable element; each route has exactly one `h1`; heading order is sequential.
- Focus moves to the page heading/main region after route changes.
- Review dialog: `role="dialog"`, `aria-modal="true"`, accessible name, focus trap, Escape closes, focus returns to trigger.
- Toasts announced via `role="status" aria-live="polite"`.
- Forms: visible labels, errors linked with `aria-describedby`, focus moves to first invalid field.
- Status uses text/icon plus colour; never colour alone.
- Product images have alt text; fallbacks are `aria-hidden`.
- Reduced motion honoured globally.

---

## 11. Error, empty and loading behaviour

- Image failure: silent fallback, never a broken icon.
- Invalid image URL: inline field error, form retained.
- API failure: retry card with the failing action named.
- Empty browse: "Nothing matches yet" + clear filters.
- Empty cart/orders/seller listings: one action each.
- Loading: skeletons for browse, spinner-free optimistic updates for cart quantity.
- Admin: existing flash messages stay; dashboard sections have their own empty copy.

---

## 12. Verification

Commands:

```
npm run build
npm run migrate
node scripts/check-contrast.mjs
node scripts/stress-test.mjs
```

`scripts/check-contrast.mjs` is a small new script that asserts the token pairs listed in section 4.1 against WCAG AA.

New harness assertions:

- Listing accepts a valid `https` image URL and returns it in bootstrap/detail.
- `javascript:` and >500-character URLs are rejected with `400`.
- Bootstrap `currency` equals the currency on a newly created order.
- Admin product form contains `name="image_url"`.
- Dashboard returns 200 and contains `data-chart="revenue"` plus pipeline labels.
- Storefront source contains a skip link, `role="dialog"`, `aria-live`, a page-level `h1` in every view template, and no emoji product-media map; a visual pass confirms each rendered route has exactly one `h1`.
- Contrast pairs (muted, warn, success, bad) all ≥4.5.

Manual checks:

- Responsive screenshots at 390, 768, 1440 px in light and dark.
- Keyboard-only pass: skip link, filters, modal, checkout.
- Reduced-motion emulation: no transforms or view transitions.
- Image-failure simulation: fallback appears with no layout shift.

All 98 existing checks must remain green.

---

## 13. Delivery phases

| Phase | Contents | Exit criteria |
|---|---|---|
| 0. Foundation | tokens, contrast, focus, touch targets, skip link, `h1`, modal/toast a11y, inline admin icons | build green; contrast script passes |
| 1. Data | migration 005, currency config, API image/currency, seller/admin forms | migration applied; image/currency tests pass |
| 2. Storefront | browse/product/cart/orders composition, media system, mobile patterns | responsive + keyboard checks pass |
| 3. Admin | dashboard KPIs, chart, pipeline, approvals, low stock | dashboard tests pass |
| 4. Motion | view transitions, stagger-once, skeletons, reduced-motion override | reduced-motion + 60 fps spot check |

Each phase is independently shippable; later phases must not regress earlier tests.

---

## 14. Out of scope

- Image uploads, storage/CDN, resizing or moderation.
- Real payment capture, payouts, escrow or ledger posting.
- New admin Reports/Settings screens.
- Framework migration or a component build pipeline.
- Light/dark theme toggle (system preference remains the source of truth).
- Messaging, wishlists, recommendations, coupons.
- Multi-currency conversion or tax handling.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| External image URLs rot or block hotlinking | Fallback renders; image failure never breaks layout |
| View Transitions unsupported | Guarded; instant fallback |
| Mixed historical currencies | Admin groups revenue by currency; no conversion |
| Catalogue cache delays new image URLs | Existing invalidation on seller writes; 3 s TTL bound |
| Bootstrap CDN remains a dependency | Keep Bootstrap (layout/tables); remove the second CDN (icons) |
| Single-file storefront grows further | Keep section comments and one helper per concern; revisit extraction only if it passes ~2,500 lines |
| Screenshots in `/screenshots` predate current code | Verify against code and fresh captures, not old images |

---

## 16. Definition of done

- All phases implemented and independently verified.
- `npm run build` and `npm run migrate` succeed.
- `scripts/stress-test.mjs` passes with the existing 98 checks plus the new image, currency and a11y assertions.
- Contrast and reduced-motion checks pass.
- Light/dark responsive captures reviewed at 390, 768 and 1440 px.
- No emoji product media, no broken admin icons, no USD/KES mismatch, no focus traps or missing dialog semantics.
