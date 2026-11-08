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
