# M-DUKA user manual

M-DUKA is a multi-seller marketplace. Buyers order from several sellers in one checkout, each
seller fulfils their own slice, and the admin panel tracks the money from payment to payout.

| Where | Who it is for | Address |
|---|---|---|
| Storefront | buyers and sellers | `/` |
| Admin panel | admins and super admins | `/admin` |

Setup, environment variables and the M-Pesa sandbox are covered in [`INSTALL.md`](../INSTALL.md).
Architecture, database diagrams and the money model are covered in [`README.md`](../README.md).

## 1. Before you start

- The app must be running (`npm run build && npm start`) and the database migrated (`npm run migrate`).
- Demo data (`npm run demo:seed`) creates two accounts and eight listings:

  | Account | Email | Password | Role |
  |---|---|---|---|
  | Jane | `jane@example.com` | `password123` | buyer |
  | Sam | `sam@example.com` | `password123` | seller |

- An admin account is created with `npm run admin:seed -- "Name" email@example.com "Password"` and
  can hold the `admin` and/or `super_admin` roles.
- One currency per deployment is displayed (`APP_CURRENCY`); the payment provider is `demo`
  (simulated) unless `PAYMENT_PROVIDER=mpesa`.

## 2. Storefront — buying

1. **Browse.** The catalogue shows active listings with image, price, seller and category. Use the
   search box, the category chips and the price filters; the dark/light toggle is in the header.
2. **Open a product.** The product page shows stock, description and the seller. Add a quantity to
   the cart.
3. **Cart.** Review quantities; the cart remembers items in the browser.
4. **Check out.** Enter the delivery name, phone, street, city and postal code, and choose an
   exchange method for each seller (delivery or pickup). Place the order.
5. **Pay.** On the payment screen, use the simulated prompt (demo provider) or, when M-Pesa is
   configured, enter the phone number that receives the STK push. The page polls until the payment
   settles. **The cart is only emptied after a successful payment.**
6. **Follow the order.** *Orders* lists every checkout with each seller's slice and status. A seller
   starts at *pending*, then *confirmed*, *shipped* (with a tracking number), and finally
   *completed* once you confirm receipt.
7. **Confirm receipt.** After the parcel arrives, open the order and confirm receipt. This is what
   makes the seller's money payable.
8. **Request a refund.** Once an order slice is completed, *Request refund* marks it for the admin.
   A refund that has already been requested cannot be requested twice, and a slice whose seller
   has been paid out must be handled by an admin.
9. **Review the seller.** Completed slices can be reviewed once, with a 1–5 star rating and a
   comment.
10. **Cancel an unpaid order.** Orders that have not been paid can be cancelled from the order
    page. Paid orders cannot be cancelled by the buyer.

## 3. Storefront — selling

1. **Become a seller.** While signed in, use *Become a seller*. The role is granted immediately;
   an admin can also approve or revoke roles.
2. **Create a listing.** Give it a title, category, price, stock quantity, description and an
   optional image URL (must start with `http://` or `https://`). Save it as *draft*, *active* or
   *paused*. The price is the asking price in the deployment currency.
3. **Edit a listing.** Sellers can edit their own listings, including price and stock. A listing
   removed by an admin is locked and can no longer be edited or reactivated.
4. **Handle orders.** *Seller orders* shows each incoming slice with the delivery address. Confirm
   it, then mark it shipped with a tracking number. You cannot mark your own order received — only
   the buyer can confirm receipt.
5. **Decline an order.** A pending slice can be declined. The buyer is not charged twice; an admin
   handles any money that was already captured.
6. **Watch performance.** The seller dashboard shows revenue, units sold, a 14-day series and the
   best-selling listings.

## 4. Admin panel

Sign in at `/admin` with an admin account. The sidebar shows only what your role allows:
admins see users, products, orders, payouts, reports and help; super admins additionally see
exchange methods and audit logs.

### 4.1 Dashboard

Counts of users, approved sellers and orders, revenue per currency, a 14-day revenue chart, the
fulfilment pipeline, recent orders and low-stock listings with a *Restock* shortcut.

### 4.2 Users

- **Search and filter** by name/email, role, account status and role approval.
- **Create a user** with a name, email, password and one or more roles.
- **Open a user** to change roles, approve or reject a pending application (for example a seller
  request), suspend or reactivate the account, and issue a password reset link.
- **Suspend** signs the user out everywhere immediately. Reactivating does not restore old
  sessions; the user signs in again.
- **Password reset link.** The link is shown once, expires after a short period and works once.
  Send it to the user yourself — the app does not send email. The user chooses a new password and
  is signed out of all devices.

### 4.3 Products and categories

- Search and filter the catalogue, open a listing to edit it, or change its status.
- **Remove** a listing to take it off the storefront permanently (sellers cannot revive it).
- Manage **categories** (add, rename, delete). A category still used by a listing cannot be
  deleted.
- Low-stock active listings are flagged on the dashboard.

### 4.4 Orders

- Filter by order number, buyer name/email, status and date range.
- Open an order to see the buyer, delivery address, payment rows (status, amount, provider,
  receipt) and every seller's slice.
- Move a slice through **pending → confirmed → processing → shipped → delivered → completed**, or
  cancel/return it. The checkout status follows the slices automatically.
- **Record a refund.** This reverses the seller's allocation, updates the payment (fully or
  partially refunded) and the checkout status. It refuses when a refund already exists or the
  seller has already been paid out. Move the money back in the provider dashboard — the panel
  records the refund, it does not transfer funds.

### 4.5 Payouts

- A seller's proceeds become **eligible** when the buyer confirms receipt.
- Send the transfer in the provider dashboard, then enter the provider reference on this page and
  record the payout. The same reference cannot be booked twice.
- Rows marked **requested** are buyers asking for a refund, not payout requests. Settle those from
  the order page; the payout action refuses until the refund is resolved.
- A recorded payout blocks further refunds until it is reversed.

### 4.6 Reports

1. Open **Reports** in the sidebar.
2. Choose a **From** and **To** date (the *To* day is included), an optional **currency** and
   **status**, and how to **sort** (date, total, order number or buyer) and in which direction.
3. Select **Run report**. The summary shows, per currency, the number of orders, the total order
   value and the value of confirmed/completed orders. The table lists the matching orders with
   date, buyer, seller count, total, status and payment status.
4. Select **Print / Save as PDF**. The print layout keeps the M-DUKA header, the period, the
   generation time and the preparer's name, and hides the sidebar and filter bar.
5. The report lists at most 500 rows. Narrow the period or add filters to print the rest.

### 4.7 Exchange methods (super admin)

Add, rename, activate or pause delivery/pickup methods. Each method has a managing admin. Active
methods are offered at checkout.

### 4.8 Audit logs (super admin)

A searchable, filterable trail of privileged actions: who did what, to which record, from which IP
and when. Every admin change writes its audit row in the same transaction as the change.

### 4.9 Help

**Help** in the sidebar summarises the order lifecycle, refunds, payouts, user administration,
reports and common problems. This manual is the longer version.

## 5. Access levels

| Role | Can do |
|---|---|
| Buyer | browse, order, pay, confirm receipt, request refunds, review sellers |
| Seller | everything a buyer can, plus listings, seller orders and seller statistics |
| Admin | the admin panel: users, products, orders, payouts, reports, help |
| Super admin | everything an admin can, plus exchange methods, audit logs and admin-account actions |

Roles are additive: a user can be a buyer and a seller at the same time. Every admin route
requires a signed-in session; super-admin-only routes also check the role on each request.

## 6. Troubleshooting

| Symptom | What to check |
|---|---|
| "Only buyer accounts can place orders" | The account has no buyer role. Grant it from *Users*. |
| Checkout says a product is no longer available | The listing was paused or removed, or another buyer took the last unit between checkout and payment. |
| Payment taken but the order stays pending | M-Pesa callback did not arrive or did not match the amount. Check the provider dashboard and the payment rows; reconcile manually. |
| Refund button missing | The seller was already paid out; reverse the payout first, or the slice is not completed yet. |
| Payout action refuses | The money is not eligible yet, a refund request is open, or the reference was already used. |
| Reset link says it is invalid | It expired or was already used. Issue a new link from the user's page. |
| Sessions gone after a restart | Admin and API sessions are database-backed; a suspension or password reset revokes them by design. |
| Images do not load | Image URLs must start with `http://` or `https://`. |

## 7. Where things live

| Path | Purpose |
|---|---|
| `src/api/` | storefront API, checkout, payments, seller transitions |
| `src/admin/` | admin panel (routes, EJS views, assets) |
| `src/public/index.html` | storefront single-page app |
| `SQL/` | schema and migrations (applied by `npm run migrate`) |
| `scripts/` | stress harness and contrast checker |
| `screenshots/` | storefront and admin screenshots used in the README |
