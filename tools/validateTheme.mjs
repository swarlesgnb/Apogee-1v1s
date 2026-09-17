/**
 * The player theme's promise, re-derived: a base changes hue and never contrast.
 *
 *   npm run validate:theme
 *
 * The theme section of renderer.js says every ratio measured on the stock palette holds on
 * every base, because each base token is solved to the stock token's luminance and rounded
 * the safe way - surfaces darker, inks lighter. That is a claim about arithmetic, so it is
 * checked by doing the arithmetic: the pure half of the section is sliced out of the
 * renderer and run here against the stylesheet's own :root.
 *
 * Four things are held:
 *
 *   - the stock theme paints nothing, so stock is the stylesheet and not a copy of it;
 *   - on every base, every ink-on-surface pair is at least as far apart as on stock;
 *   - on every base, every season rank colour, lifted the way the renderer lifts it, still
 *     clears RANK_TEXT_CONTRAST on the control;
 *   - for every accent in a sweep of the 12-bit cube, on every base, the brand clears
 *     BRAND_CONTRAST on each surface it is text on, and the brand ink clears it on the brand.
 *
 * The sweep also has to lift something. An accent lift that no colour in 4,096 ever needed
 * would be a check that cannot fail, which is how a vacuous assertion hid a real leak here
 * once already.
 *
 * Sliced rather than imported for the reason validateSound.mjs gives: the renderer is one
 * plain script, and tools/buildUiPreview.ts inlines exactly one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = read("src/app/renderer/renderer.js").split(/\r?\n/);

function slice(from, to) {
  const start = src.findIndex((l) => l.includes(from));
  const end = src.findIndex((l, i) => i > start && l.includes(to));
  if (start < 0 || end < 0) {
    console.error(`could not find "${from}" .. "${to}" in renderer.js`);
    process.exit(1);
  }
  return src.slice(start, end).join("\n");
}

const readability = slice("rank colour readability */", "What is wrong with a rank colour");
const themeBlock = slice("=== theme */", "theme: on screen */");

const T = new Function(
  `${readability}\n${themeBlock}\n;return { luminance, contrastRatio, legibleOnDark, ` +
    `RANK_TEXT_CONTRAST, BRAND_CONTRAST, THEME_RAMP, THEME_TOKENS, THEME_BASES, ` +
    `THEME_ACCENTS, THEME_STOCK, themeTokens };`,
)();

// The stock values, from the stylesheets in the order the page loads them: index.html's
// own :root first, then arena.css and arcade.css. The final declaration wins.
const html = read("src/app/renderer/index.html");
const css = html.slice(0, html.indexOf("</style>")) + "\n" + read("src/app/renderer/arena.css") + "\n" + read("src/app/renderer/arcade.css");
const stock = {};
for (const name of T.THEME_TOKENS) {
  const m = [...css.matchAll(new RegExp(name + ":\\s*(#[0-9a-fA-F]{6})", 'g'))].at(-1);
  if (!m) {
    console.error(`${name} has no hex value in the stylesheets`);
    process.exit(1);
  }
  stock[name] = m[1].toLowerCase();
}

const season = JSON.parse(read("data/seasons/season-1.json"));
const rankColours = new Set();
const addColours = (o) => {
  for (const v of Object.values(o ?? {})) if (/^#[0-9a-fA-F]{6}$/.test(v)) rankColours.add(v);
};
addColours(season.rankColors);
for (const c of season.categories ?? []) {
  addColours(c.rankColors);
  for (const b of c.bands ?? []) addColours(b.rankColors);
}

console.log("\napogee theme\n");

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};

const { contrastRatio: ratio, luminance: lum } = T;
const kindOf = Object.fromEntries(T.THEME_RAMP);
const surfaces = T.THEME_RAMP.filter(([, k]) => k === "surface").map(([n]) => n);
const inks = T.THEME_RAMP.filter(([, k]) => k === "ink").map(([n]) => n);

const painted = Object.keys(T.themeTokens(stock, T.THEME_STOCK)).length;
if (painted !== 0) fail(`the stock theme paints ${painted} token(s); it should paint none`);
else console.log("  ok   stock paints nothing: the stylesheet is the stock theme");

// ------------------------------------------------------------------ the bases
for (const base of T.THEME_BASES) {
  if (base.hue === null) continue;
  const out = T.themeTokens(stock, { base: base.id, accent: null });
  const t = { ...stock, ...out };
  const before = failures;

  let drift = 1;
  for (const [name, kind] of T.THEME_RAMP) {
    if (!(name in out)) {
      fail(`${base.id}: ${name} was not solved`);
      continue;
    }
    if (kind === "surface" && lum(t[name]) > lum(stock[name])) {
      fail(`${base.id}: ${name} ${t[name]} is lighter than stock ${stock[name]}`);
    }
    if (kind === "ink" && lum(t[name]) < lum(stock[name])) {
      fail(`${base.id}: ${name} ${t[name]} is darker than stock ${stock[name]}`);
    }
    drift = Math.max(drift, ratio(stock[name], t[name]));
  }

  let pairs = 0;
  let tightest = Infinity;
  for (const ink of inks) {
    for (const surface of surfaces) {
      const kept = ratio(t[ink], t[surface]) / ratio(stock[ink], stock[surface]);
      pairs++;
      tightest = Math.min(tightest, kept);
      if (kept < 1) {
        fail(`${base.id}: ${ink} on ${surface} is ${ratio(t[ink], t[surface]).toFixed(2)}:1, ` +
          `under stock's ${ratio(stock[ink], stock[surface]).toFixed(2)}:1`);
      }
    }
  }

  let ranksLow = 0;
  for (const c of rankColours) {
    const lifted = T.legibleOnDark(c, T.RANK_TEXT_CONTRAST);
    if (ratio(lifted, t["--control"]) < T.RANK_TEXT_CONTRAST) ranksLow++;
  }
  if (ranksLow > 0) {
    fail(`${base.id}: ${ranksLow} lifted rank colour(s) under ${T.RANK_TEXT_CONTRAST}:1 on its control`);
  }

  const brandOnWell = ratio(stock["--brand"], t["--brand-well"]);
  if (brandOnWell < T.BRAND_CONTRAST) {
    fail(`${base.id}: the stock brand is ${brandOnWell.toFixed(2)}:1 on its well`);
  }

  if (failures === before) {
    console.log(
      `  ok   ${base.id.padEnd(9)} ground ${t["--ground"]}, luminance within ` +
        `${drift.toFixed(3)}:1 of stock, ${pairs} ink/surface pairs at >= ${tightest.toFixed(3)}x ` +
        `stock, ${rankColours.size} rank colours clear`,
    );
  }
}

// ---------------------------------------------------------------- the accents
const sweep = [];
for (let r = 0; r < 16; r++) {
  for (let g = 0; g < 16; g++) {
    for (let b = 0; b < 16; b++) {
      sweep.push("#" + [r, g, b].map((v) => (v * 17).toString(16).padStart(2, "0")).join(""));
    }
  }
}
for (const a of T.THEME_ACCENTS) if (a.hex) sweep.push(a.hex);

const low = { well: Infinity, tab: Infinity, raised: Infinity, ground: Infinity, ink: Infinity };
let lifted = 0;
let runs = 0;
const worst = [];
for (const base of T.THEME_BASES) {
  for (const accent of sweep) {
    const t = { ...stock, ...T.themeTokens(stock, { base: base.id, accent }) };
    const brand = t["--brand"];
    runs++;
    if (brand !== accent) lifted++;
    const got = {
      well: ratio(brand, t["--brand-well"]),
      tab: ratio(brand, t["--tab-on"]),
      raised: ratio(brand, t["--control-hi"]),
      ground: ratio(brand, t["--ground"]),
      ink: ratio(t["--brand-ink"], brand),
    };
    for (const [k, v] of Object.entries(got)) {
      low[k] = Math.min(low[k], v);
      if (v < T.BRAND_CONTRAST && worst.length < 5) worst.push(`${base.id} ${accent} ${k} ${v.toFixed(2)}:1`);
    }
  }
}

if (runs !== T.THEME_BASES.length * sweep.length) fail("the accent sweep did not run in full");
if (lifted === 0) fail("no accent in the sweep needed lifting, so the lift was never exercised");
for (const [k, v] of Object.entries(low)) {
  if (v < T.BRAND_CONTRAST) fail(`an accent's ${k} contrast falls to ${v.toFixed(2)}:1`);
}
for (const w of worst) console.log(`       ${w}`);
if (Object.values(low).every((v) => v >= T.BRAND_CONTRAST) && lifted > 0) {
  console.log(
    `  ok   ${sweep.length} accents x ${T.THEME_BASES.length} bases, ${lifted} lifted; ` +
      `brand on well ${low.well.toFixed(2)}, on tab ${low.tab.toFixed(2)}, ` +
      `on raised ${low.raised.toFixed(2)}, on ground ${low.ground.toFixed(2)}, ` +
      `ink on brand ${low.ink.toFixed(2)} (floor ${T.BRAND_CONTRAST})`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nOK");
