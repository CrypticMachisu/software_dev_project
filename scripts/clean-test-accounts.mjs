#!/usr/bin/env node
/**
 * Remove accounts left behind by the test harnesses.
 *
 *   node scripts/clean-test-accounts.mjs            delete matching accounts
 *   node scripts/clean-test-accounts.mjs --dry-run  list what would be deleted
 *   node scripts/clean-test-accounts.mjs --check    fail if any remain
 *
 * Demo accounts (jane/sam) and the seeded stress admin are not matched.
 */
import { cleanupTestAccounts, findTestAccounts } from "./lib/test-accounts.mjs";

const mode = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : "delete";

const accounts = await findTestAccounts();

if (mode === "check") {
  if (accounts.length) {
    console.error(`Found ${accounts.length} leftover test account(s):`);
    for (const email of accounts) console.error(" - " + email);
    process.exitCode = 1;
  } else {
    console.log("No leftover test accounts.");
  }
} else if (mode === "dry-run") {
  if (accounts.length) {
    console.log(`Would delete ${accounts.length} test account(s):`);
    for (const email of accounts) console.log(" - " + email);
  } else {
    console.log("No test accounts to delete.");
  }
} else {
  const result = await cleanupTestAccounts(accounts);
  if (result.deleted) {
    console.log(`Deleted ${result.deleted} test account(s).`);
    for (const email of result.emails) console.log(" - " + email);
  } else {
    console.log("No test accounts to delete.");
  }
}
