/**
 * A rank ladder's colours, generated so that its rungs are evenly spaced on the screen
 * they are read on.
 *
 *   npx tsx tools/buildPalette.ts                  print what would change
 *   npx tsx tools/buildPalette.ts --write          write it into the season
 *   npx tsx tools/buildPalette.ts --ladder "Dynamic Clicking" --write
 *
 * WHY THIS EXISTS
 *
 * Three of the six ladders were ramped by interpolating a start hex and an end hex channel
 * by channel, and sRGB does not space anything evenly. `Reactive Tracking` spent nine of
 * its sixteen rungs between 3.29:1 and 3.86:1 against the client's ground - over half the
 * climb reading as one colour, with the difference between rank 1 and rank 9 being a thing
 * you can only find by sampling pixels. A ladder is a sequence or it is a gradient, and
 * this one had become a gradient.
 *
 * WHY OKLCH
 *
 * OKLab spaces its steps by perceived lightness, so equal steps look equal - which is the
 * entire ask. The luminance target is still solved back in sRGB afterwards, because WCAG
 * contrast is defined there and nowhere else, and the contrast is what the floor is
 * expressed in.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not try to make a colour legible on paper. That was the first version's goal and
 * it was the wrong place for it: see the band below. `legibleOn` corrects a rank colour
 * towards whichever ground it is painted on, so every light surface handles itself, and
 * this file is free to answer only to the client.
 *
 * WHAT IT REFUSES
 *
 * A ramp that stops ascending *as the client paints it*, a rung under the client's text
 * floor, and a rung no amount of correction can get onto a light ground. All three are
 * checked on the colours actually produced rather than on the request, so a hue that
 * cannot hit its target in gamut fails here instead of shipping.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  contrast,
  DARK_GROUND,
  legibleOn,
  LIGHT_GROUND,
  MIN_CONTRAST,
  RANK_TEXT_CONTRAST,
} from "../src/core/report/contrast.ts";
import { dataFile, sourceDataDir } from "../src/core/dataDir.ts";

const PLACEHOLDER = /^Rank \d+\**$/;

/**
 * The band the ramp is drawn across, in contrast against the client's own ground.
 *
 * The floor is the client's text floor and not MIN_CONTRAST, which is the whole lesson of
 * the first version. Solving to 2:1 put the bottom seven rungs of every ladder under the
 * 3.5:1 the client sets a rank name at, so the client lifted them - and the lift moves in
 * five percent steps, which is coarse enough to reorder rungs that were only five percent
 * apart to begin with. Measured on the result: Rock to Bolas went *down*, Boomerang up,
 * Sling down, Net up. Half of every generated ladder stopped ascending on the one screen
 * it is read on, to fix a paper problem, and it was strictly worse than the ramp it
 * replaced.
 *
 * There is no light ceiling any more either, for the same reason there is no lift needed
 * at the bottom: `legibleOn` corrects a colour towards whatever ground it is being painted
 * on, so the sheet, a printout and anything else light already darken these themselves.
 * Trying to satisfy both grounds in the data at once left a band of five times in
 * luminance for seventeen rungs, and pinning the floor at 3.5:1 as well would have left
 * 2.3 - about one perceptual step per rank, which is a ladder nobody can see the rungs of.
 *
 * So the ramp answers to the client, the paint answers to the ground, and each is solved
 * where it can actually be solved.
 */
// A little above the client's floor rather than exactly on it. A rung solved to land on
// 3.50:1 comes back as 3.49 once it is rounded to eight bits per channel, and then the
// client lifts the one rung the whole exercise was about not lifting.
const FLOOR = RANK_TEXT_CONTRAST + 0.2;
const CEILING = 13.5;
const Y_MIN = FLOOR * (luminance(DARK_GROUND) + 0.05) - 0.05;
const Y_MAX = CEILING * (luminance(DARK_GROUND) + 0.05) - 0.05;

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
  // Rock to snow, and the only ladder here whose chroma *falls*: the six categories are
  // the colourful ones and the overall sits above them as a readout, so it wants to look
  // like weather and stone rather than like a seventh thing competing for attention.
  "Overall": { from: { h: 66, c: 0.055 }, to: { h: 245, c: 0.035 } },

  // Dynamic Clicking, Reactive Tracking and Evasive Switching were in here and are not any
  // more. Their colours are chosen now, the same way the other three categories' are, and
  // running this over a chosen palette replaces a decision with an average - which it did
  // once, and the names went with them. A ladder belongs here only while nobody has an
  // opinion about it; the moment somebody does, it comes out.
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
const season = JSON.parse(readFileSync(path, "utf8")) as {
  rankNames: string[];
  rankColors: Record<string, string>;
  categories: Category[];
};

/**
 * The overall ladder is a category as far as this file is concerned.
 *
 * It has no bands - it is derived from the six that do - so its ranks live at the top
 * level of the season rather than inside a `bands` array. Wrapping it here keeps one loop
 * instead of two nearly identical ones.
 */
const ladders: Category[] = [
  { name: "Overall", rankNames: season.rankNames, rankColors: season.rankColors },
  ...season.categories,
];

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const problems: string[] = [];
let changed = 0;

for (const category of ladders) {
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
  if (order.length === 0) order.push(...category.rankNames);
  const named = order.filter((n) => !PLACEHOLDER.test(n));
  const colors = ramp(named.length, spec);
  const assigned = new Map(named.map((n, i) => [n, colors[i]]));

  console.log(`\n${category.name}`);
  let previous = -1;
  for (const [i, name] of named.entries()) {
    const hex = colors[i];
    const was =
      category.bands?.find((b) => b.rankColors[name])?.rankColors[name] ??
      category.rankColors[name] ??
      "?";
    const d = contrast(hex, DARK_GROUND);
    const l = contrast(hex, LIGHT_GROUND);
    const y = luminance(hex);

    // Checked on the colour the client will actually paint, not on the one solved for.
    // A ramp that ascends in the file and not on the screen is the bug this whole band
    // exists to have avoided, so it is the screen that gets asserted about.
    const painted = luminance(legibleOn(hex, DARK_GROUND, RANK_TEXT_CONTRAST));
    if (painted <= previous) problems.push(`${category.name} / ${name} does not ascend`);
    previous = painted;
    if (d < RANK_TEXT_CONTRAST) {
      problems.push(`${category.name} / ${name} is ${d.toFixed(2)}:1 on dark`);
    }
    if (contrast(legibleOn(hex, LIGHT_GROUND), LIGHT_GROUND) < MIN_CONTRAST) {
      problems.push(`${category.name} / ${name} cannot be corrected onto light`);
    }
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
