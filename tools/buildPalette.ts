/**
 * A rank ladder's colours, generated so that every rung survives both grounds.
 *
 *   npx tsx tools/buildPalette.ts                  print what would change
 *   npx tsx tools/buildPalette.ts --write          write it into the season
 *   npx tsx tools/buildPalette.ts --ladder "Dynamic Clicking" --write
 *
 * WHY THIS EXISTS
 *
 * Three of the six ladders were ramped by hand from a start colour to an end colour, and
 * all three ran the same way into the same wall: they ascend by getting lighter, so their
 * top halves land in the near-whites. That reads beautifully in the client, which is dark,
 * and vanishes the moment a rank is screenshotted onto anything pale - twenty-two of the
 * forty-two names the rank sheet reports as disappearing on paper are the top rungs of
 * these three, and not one of them fails on dark.
 *
 * The band a colour has to stay inside to clear MIN_CONTRAST against both grounds is
 * narrow and it is arithmetic, not taste:
 *
 *     dark  #1e1b18   Y >= 2 * (0.0116 + 0.05) - 0.05  =  0.073
 *     light #eef1f6   Y <= (0.7998 + 0.05) / 2 - 0.05  =  0.375
 *
 * Five times in relative luminance for seventeen rungs. Lightness alone cannot carry a
 * ladder that narrow, so these ramps carry their hue as well, and the endpoints of each
 * hue sweep are the two colours the ladder was already built from. The identity survives;
 * only the range it is drawn over changes.
 *
 * WHY OKLCH
 *
 * The first version interpolated the hex endpoints channel by channel in sRGB, which is
 * how the current ramps were made, and it is why `Reactive Tracking` spends nine of its
 * sixteen rungs between 3.29:1 and 3.86:1 on dark - visually one colour, and the ladder
 * stops reading as a climb. OKLab spaces its steps by perceived lightness, so equal steps
 * look equal. The luminance target is still solved in sRGB afterwards, because WCAG
 * contrast is defined there and nowhere else.
 *
 * WHAT IT REFUSES
 *
 * A ramp whose luminance stops ascending, and any rung under MIN_CONTRAST on either
 * ground. Both are checked on the colours actually produced rather than on the request,
 * so a hue that cannot be made to hit its target in gamut fails here instead of shipping.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { contrast, DARK_GROUND, LIGHT_GROUND, MIN_CONTRAST } from "../src/core/report/contrast.ts";
import { dataFile, sourceDataDir } from "../src/core/dataDir.ts";

const PLACEHOLDER = /^Rank \d+\**$/;

/**
 * The legible band, derived rather than typed, so it moves if a ground does.
 *
 * A little inside the true edge on each side: a rung solved to land exactly on 2.00:1 is
 * one rounding away from being reported as a failure by the sheet that reads it back.
 */
const MARGIN = 1.06;
const Y_MIN = MIN_CONTRAST * MARGIN * (luminance(DARK_GROUND) + 0.05) - 0.05;
const Y_MAX = (luminance(LIGHT_GROUND) + 0.05) / (MIN_CONTRAST * MARGIN) - 0.05;

/**
 * Where each generated ladder starts and ends, in OKLCH hue and chroma.
 *
 * Authored, and the only authored thing in the file. The hues are the ones the ladders
 * already had - `Dynamic Clicking` was a brown that ripened into a yellow-green and it
 * still is - read off the existing first and last colours and then held fixed while the
 * lightness was re-solved.
 *
 * A ladder absent from here keeps its hand-picked colours untouched. Static Clicking,
 * Precise Tracking, Speed Switching and Overall are not ramps at all: they are chosen
 * colours, several of them jokes that depend on the exact value (`Singularity` is #000000
 * and `HAL 9000` is #ffffff), and generating over them would be replacing a decision with
 * an average.
 */
const RAMPS: Record<string, { from: { h: number; c: number }; to: { h: number; c: number } }> = {
  // #8d5a35 leather to #e3f6ac ripened - a thrown rock becoming a guided one.
  "Dynamic Clicking": { from: { h: 58, c: 0.075 }, to: { h: 116, c: 0.125 } },
  // #356f8d overcast to #cbacf6 storm light - weather that gets harder to stand in.
  "Reactive Tracking": { from: { h: 236, c: 0.07 }, to: { h: 300, c: 0.13 } },
  // #358d44 hull green to #acf6e7 wake - a boat becoming something that is not seen.
  "Evasive Switching": { from: { h: 148, c: 0.085 }, to: { h: 186, c: 0.115 } },
};

/* ---------------------------------------------------------------- colour ---- */

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** OKLCH to linear sRGB. Returns channels unclamped, so out-of-gamut is visible. */
function oklchToLinear(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

function hexOf(rgb: number[]): string {
  return (
    "#" +
    rgb
      .map((v) => Math.round(Math.min(1, Math.max(0, toSrgb(v))) * 255))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * The colour at hue `h` whose relative luminance is `target`, as chromatic as the gamut
 * allows up to `chroma`.
 *
 * Two nested searches rather than one: OKLab lightness does not map to WCAG luminance in
 * closed form once chroma is involved, and chroma that is fine at one lightness clips at
 * another. Chroma gives way first - a rung that is a little less saturated than asked for
 * is a smaller loss than a rung that is the wrong brightness, because brightness is the
 * thing carrying the order.
 */
function solve(target: number, h: number, chroma: number): string {
  for (let c = chroma; c >= 0; c -= 0.002) {
    let lo = 0;
    let hi = 1;
    let best: number[] | null = null;
    for (let i = 0; i < 40; i++) {
      const L = (lo + hi) / 2;
      const rgb = oklchToLinear(L, c, h);
      const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      if (y < target) lo = L;
      else hi = L;
      if (inGamut(rgb) && Math.abs(y - target) < 0.0004) best = rgb;
    }
    if (best) return hexOf(best);
  }
  throw new Error(`no in-gamut colour at hue ${h} for luminance ${target.toFixed(3)}`);
}

/* ------------------------------------------------------------------ ramp ---- */

/**
 * `count` colours from one end of a ramp to the other.
 *
 * Luminance is stepped geometrically, not linearly. A linear step from 0.08 to 0.36 puts
 * more than half the visible difference in the bottom four rungs and leaves the top eight
 * looking identical; the ratio between neighbours is what the eye reads, so it is the
 * ratio that is held constant.
 */
function ramp(count: number, spec: (typeof RAMPS)[string]): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const y = Y_MIN * Math.pow(Y_MAX / Y_MIN, t);
    out.push(solve(y, spec.from.h + (spec.to.h - spec.from.h) * t, spec.from.c + (spec.to.c - spec.from.c) * t));
  }
  return out;
}

/* ------------------------------------------------------------------ main ---- */

interface Band {
  window: number;
  rankNames: string[];
  rankColors: Record<string, string>;
}
interface Category {
  name: string;
  bands?: Band[];
  rankNames: string[];
  rankColors: Record<string, string>;
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const at = args.indexOf("--ladder");
const only = at === -1 ? null : args[at + 1];

const path = dataFile("seasons/season-1.json");
const season = JSON.parse(readFileSync(path, "utf8")) as { categories: Category[] };

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const problems: string[] = [];
let changed = 0;

for (const category of season.categories) {
  const spec = RAMPS[category.name];
  if (!spec) continue;
  if (only && category.name !== only) continue;

  // The ordered distinct ranks of the whole category. A band is not the unit here: the
  // ladder overlaps by two, so six of the seventeen rungs are graded by two adjacent
  // bands and must come out of this holding one colour, not two.
  const order: string[] = [];
  for (const band of category.bands ?? []) {
    for (const name of band.rankNames) if (!order.includes(name)) order.push(name);
  }
  const named = order.filter((n) => !PLACEHOLDER.test(n));
  const colors = ramp(named.length, spec);
  const assigned = new Map(named.map((n, i) => [n, colors[i]]));

  console.log(`\n${category.name}`);
  let previous = -1;
  for (const [i, name] of named.entries()) {
    const hex = colors[i];
    const was = category.bands?.find((b) => b.rankColors[name])?.rankColors[name] ?? "?";
    const d = contrast(hex, DARK_GROUND);
    const l = contrast(hex, LIGHT_GROUND);
    const y = luminance(hex);

    if (y <= previous) problems.push(`${category.name} / ${name} does not ascend`);
    previous = y;
    if (d < MIN_CONTRAST) problems.push(`${category.name} / ${name} is ${d.toFixed(2)}:1 on dark`);
    if (l < MIN_CONTRAST) problems.push(`${category.name} / ${name} is ${l.toFixed(2)}:1 on light`);
    if (hex !== was) changed++;

    console.log(
      `  ${DIM}${was}${RESET} -> ${hex}  ` +
        `${d.toFixed(2).padStart(5)}:1 dark  ${l.toFixed(2).padStart(5)}:1 light  ${name}`,
    );
  }

  if (write) {
    for (const band of category.bands ?? []) {
      for (const name of band.rankNames) {
        const hex = assigned.get(name);
        if (hex) band.rankColors[name] = hex;
      }
    }
    for (const name of category.rankNames) {
      const hex = assigned.get(name);
      if (hex) category.rankColors[name] = hex;
    }
  }
}

if (problems.length > 0) {
  console.error(`\nFAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

if (write) {
  // Both copies, for the same reason the season editor writes both: `dist/data` is what
  // the running client reads, and `data/` is what the next build rewrites it from.
  const body = JSON.stringify(season, null, 2) + "\n";
  writeFileSync(path, body);
  const source = sourceDataDir();
  if (source) writeFileSync(`${source}/seasons/season-1.json`, body);
  console.log(`\nwrote ${changed} colour(s)`);
} else {
  console.log(`\n${changed} colour(s) would change; --write to apply`);
}
