#!/usr/bin/env node
/**
 * Subresource Integrity guard for the admin panel.
 *
 * The admin templates pin Bootstrap with integrity="sha384-..." attributes, so
 * the browser recomputes each file's hash before using it. If a vendored file
 * changes by even one byte — a re-save, a line-ending conversion, a hand edit —
 * the hash stops matching and the browser silently drops the stylesheet or
 * script, which leaves the whole panel unstyled. Nothing in the HTTP layer
 * notices: the file is still served with a 200.
 *
 * Usage: node scripts/check-assets.mjs
 * Reads every /admin/static/vendor reference in src/admin/views and compares
 * the hash of the file on disk with the integrity attribute that loads it.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const VIEWS_DIR = path.resolve("src", "admin", "views");
const PUBLIC_DIR = path.resolve("src", "admin", "public");
const VENDOR_URL_PREFIX = "/admin/static/vendor/";

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const sriOf = (file) => `sha384-${createHash("sha384").update(readFileSync(file)).digest("base64")}`;

let failed = 0;
const fail = (message) => {
  console.log(`FAIL  ${message}`);
  failed++;
};

// Collect each pinned vendor reference and every view that loads it.
const references = new Map();
for (const view of walk(VIEWS_DIR).filter((f) => f.endsWith(".ejs"))) {
  const source = readFileSync(view, "utf8");
  const relative = path.relative(VIEWS_DIR, view);
  for (const [tag] of source.matchAll(/<(?:link|script)\b[^>]*>/gi)) {
    const ref = tag.match(/(?:href|src)="([^"]+)"/)?.[1];
    const integrity = tag.match(/integrity="([^"]+)"/)?.[1];
    if (!ref || !integrity || !ref.startsWith(VENDOR_URL_PREFIX)) continue;
    const entry = references.get(ref) ?? { views: [], hashes: new Set() };
    entry.views.push(relative);
    for (const hash of integrity.trim().split(/\s+/)) entry.hashes.add(hash);
    references.set(ref, entry);
  }
}

if (!references.size) {
  fail("no integrity-pinned vendor references found in src/admin/views");
}

for (const [ref, { views, hashes }] of [...references].sort()) {
  const file = path.join(PUBLIC_DIR, ref.slice("/admin/static/".length));
  const who = `${path.basename(ref)} (${views.length} view${views.length === 1 ? "" : "s"}: ${views.join(", ")})`;

  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    fail(`${who}: file missing at ${path.relative(process.cwd(), file)}`);
    continue;
  }
  const actual = sriOf(file);
  const stale = hashes.size > 1;
  if (stale || !hashes.has(actual)) {
    fail(`${who}: integrity does not match the file — expected ${[...hashes].join(" or ")}`);
    console.log(`      actual  ${actual}`);
    console.log(`      fix by updating the integrity attribute, or restore the file to its pinned bytes`);
    continue;
  }
  console.log(`PASS  ${who}: ${actual}`);
}

if (failed) {
  console.error(`${failed} asset integrity check(s) failed`);
  process.exit(1);
}
console.log(`All ${references.size} integrity-pinned vendor asset(s) match`);
