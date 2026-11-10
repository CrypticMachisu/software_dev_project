#!/usr/bin/env node
/**
 * Proves that registration really lands in PostgreSQL, for both routes:
 *   A. a visitor registers on the storefront (POST /api/auth/register)
 *   B. a super admin creates a user in the panel (POST /admin/users/new)
 * Each step is checked twice: through the running app (HTTP) and straight in the database.
 *
 * Usage (server running, database migrated):
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run verify:registration
 *   BASE_URL defaults to http://127.0.0.1:3000; DATABASE_URL comes from .env.
 * The admin account must not have two-factor enabled (the script cannot read your authenticator).
 * It leaves its test users (verify-*@example.com) in place: audit_log rows cannot be deleted.
 */
import pg from "pg";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL } = process.env;
if (!DATABASE_URL) { console.error("DATABASE_URL is missing (run through npm so .env is loaded)."); process.exit(2); }

let passed = 0;
const failed = [];
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed.push(name); console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
};

/** Object -> urlencoded body; an array value becomes a repeated field (roles=buyer&roles=seller). */
function formBody(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
}

class Jar {
  cookies = new Map();
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async fetch(path, { method = "GET", json, form, headers = {} } = {}) {
    const h = { ...headers };
    let body;
    if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
    if (form !== undefined) { h["content-type"] = "application/x-www-form-urlencoded"; body = formBody(form); }
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
    this.absorb(res);
    return res;
  }
}

const db = new pg.Client({ connectionString: DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false });
const stamp = Date.now();
const PASSWORD = "Verify-Pass-" + stamp;

async function userRow(email) {
  const { rows } = await db.query(
    `SELECT u.user_id, u.name, u.email, u.password_hash, u.account_status, u.created_at,
            COALESCE(json_agg(json_build_object('role', r.role_name, 'status', ur.approval_status))
                     FILTER (WHERE r.role_id IS NOT NULL), '[]') AS roles
     FROM app_user u
     LEFT JOIN user_role ur ON ur.user_id = u.user_id
     LEFT JOIN app_role r ON r.role_id = ur.role_id
     WHERE lower(u.email) = lower($1) GROUP BY u.user_id`, [email]);
  return rows;
}
const auditCount = async (userId, action) =>
  Number((await db.query(`SELECT count(*) AS n FROM audit_log WHERE action = $1 AND target_table = 'app_user' AND target_id = $2`, [action, userId])).rows[0].n);

async function partA() {
  console.log("\nA. Visitor registers on the storefront");
  const email = `verify-self-${stamp}@example.com`;
  const jar = new Jar();
  const res = await jar.fetch("/api/auth/register", { method: "POST", json: { name: "Verify Self", email, password: PASSWORD } });
  const data = await res.json().catch(() => ({}));
  check("API answers 201 Created", res.status === 201, `status ${res.status} ${JSON.stringify(data)}`);
  check("A session cookie is issued", jar.cookies.has("sid"));

  const rows = await userRow(email);
  check("Exactly one app_user row exists in the database", rows.length === 1);
  const u = rows[0];
  if (u) {
    check("Name and email are stored as entered", u.name === "Verify Self" && u.email === email);
    check("Password is stored as a bcrypt hash, never in plain text", /^\$2[aby]\$\d\d\$/.test(u.password_hash) && !u.password_hash.includes(PASSWORD));
    check("Account is active", u.account_status === "active");
    check("Buyer role is attached and approved", u.roles.some((r) => r.role === "buyer" && r.status === "approved"));
    const sessions = Number((await db.query(`SELECT count(*) AS n FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [u.user_id])).rows[0].n);
    check("A session row was written", sessions >= 1);
    check("The registration is in the audit log", (await auditCount(u.user_id, "auth.register")) === 1);
  }

  const dup = await new Jar().fetch("/api/auth/register", { method: "POST", json: { name: "Dup", email: email.toUpperCase(), password: PASSWORD } });
  check("Registering the same email in another case is refused (409)", dup.status === 409, `status ${dup.status}`);
  check("...and no second row was created", (await userRow(email)).length === 1);

  const login = await new Jar().fetch("/api/auth/login", { method: "POST", json: { email, password: PASSWORD } });
  check("The new account can sign in with that password", login.status === 200, `status ${login.status}`);
}

async function partB() {
  console.log("\nB. Super admin creates users in the admin panel");
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log("  SKIP  set ADMIN_EMAIL and ADMIN_PASSWORD to run this part");
    return;
  }
  const jar = new Jar();
  const login = await jar.fetch("/admin/login", { method: "POST", form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const loc = login.headers.get("location") || "";
  check("Admin sign-in succeeds", login.status === 302 && loc === "/admin", `status ${login.status} location ${loc} (two-factor accounts cannot be used here)`);
  if (login.status !== 302 || loc !== "/admin") return;

  const adminRow = (await userRow(ADMIN_EMAIL))[0];
  const form = await (await jar.fetch("/admin/users/new")).text();
  const csrf = form.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  check("The Add-user form carries a CSRF token", !!csrf);

  for (const [label, roles] of [["seller", ["buyer", "seller"]], ["admin", ["admin"]]]) {
    const email = `verify-${label}-${stamp}@example.com`.toUpperCase().replace("EXAMPLE.COM", "example.com"); // mixed case on purpose
    const res = await jar.fetch("/admin/users/new", {
      method: "POST",
      form: { _csrf: csrf, name: `Verify ${label}`, email, phone: "0700000000", password: PASSWORD, roles },
    });
    const redirect = res.headers.get("location") || "";
    check(`Creating a ${label} user redirects to the user page`, res.status === 302 && /^\/admin\/users\/\d+\?ok=created$/.test(redirect), `status ${res.status} ${redirect}`);
    const rows = await userRow(email.toLowerCase());
    check(`${label}: row exists in the database (email stored lower-case)`, rows.length === 1 && rows[0].email === email.toLowerCase());
    const u = rows[0];
    if (!u) continue;
    check(`${label}: password stored as a bcrypt hash`, /^\$2[aby]\$/.test(u.password_hash));
    const want = new Set(roles);
    const got = new Set(u.roles.filter((r) => r.status === "approved").map((r) => r.role));
    check(`${label}: roles saved and approved (${[...want].join(", ")})`, [...want].every((r) => got.has(r)), JSON.stringify(u.roles));
    const audit = (await db.query(`SELECT user_id FROM audit_log WHERE action = 'user.created' AND target_id = $1`, [u.user_id])).rows;
    check(`${label}: audit row 'user.created' names the acting admin`, audit.length === 1 && audit[0].user_id === adminRow?.user_id);
    const signin = await new Jar().fetch("/api/auth/login", { method: "POST", json: { email: email.toLowerCase(), password: PASSWORD } });
    check(`${label}: the new user can sign in`, signin.status === 200, `status ${signin.status}`);
    if (label === "admin") {
      const adminLogin = await new Jar().fetch("/admin/login", { method: "POST", form: { email: email.toLowerCase(), password: PASSWORD } });
      check("admin: the new admin can open the admin panel", adminLogin.status === 302 && adminLogin.headers.get("location") === "/admin", `status ${adminLogin.status}`);
    }
  }

  const dup = await jar.fetch("/admin/users/new", { method: "POST", form: { _csrf: csrf, name: "Dup", email: `verify-seller-${stamp}@example.com`, password: PASSWORD, roles: "buyer" } });
  check("Creating a duplicate email is refused, not saved twice", dup.status === 400);
}

try {
  await db.connect();
  const ping = await db.query("SELECT current_database() AS name");
  console.log(`Database: ${ping.rows[0].name}   App: ${BASE}`);
  await partA();
  await partB();
} catch (e) {
  console.error("\nHARNESS ERROR:", e instanceof Error ? e.message : e);
  process.exitCode = 2;
} finally {
  await db.end().catch(() => {});
}
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { failed.forEach((f) => console.log(" - " + f)); process.exitCode = process.exitCode || 1; }
