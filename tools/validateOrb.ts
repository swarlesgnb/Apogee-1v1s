/**
 * The orb field's opacities and the ink ramp above it, re-derived from each other.
 *
 * The field behind the content column lifts the ground, and the ground is what every
 * contrast figure in the stylesheet was measured against. So the two are one decision:
 * a brighter field needs a higher ramp, and a ramp chosen against the bare ground stops
 * being true the moment the field is painted over it.
 *
 * The worst case is not hypothetical. --accent is set from the player's tier colour on
 * every snapshot, and the top of the ladder is saturated - pure green, pure cyan,
 * near-pure yellow - so a player at that tier sees a blob tinted with it on every
 * screen of the app.
 *
 *   npm run validate:orb
 *
 * The blobs are rasterised where the stylesheet actually puts them, rather than being
 * summed as if they were one pixel. The first version of this file did the latter, and
 * it was wrong in the direction that matters: it read the field as 2.09x brighter than
 * anything that reaches the screen, which forced the opacities down until the field was
 * invisible while this script reported it sitting exactly on the limit. Three gradient
 * centres cannot occupy one pixel when the stylesheet pins them to three corners.
 *
 * Everything is read out of index.html - the boxes, the opacities, the gradient stops,
 * the drift keyframes and the largest screen lift - so editing any of them by hand and
 * not re-running this fails here rather than quietly costing the client's dim text its
 * rating.
 *
 * The ramp is also checked for evenness. Lifting --ink-dim alone is all the contrast
 * floor strictly demands, and it is the wrong fix: it closes the gap to --ink-mid until
 * three tones read as two. A ramp whose steps are lopsided is a ramp that lost a rung.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DARK_GROUND, DARK_CHROME, contrast, luminance } from "../src/core/report/contrast.js";

const root = join(import.meta.dirname, "..");
const html = readFileSync(join(root, "src/app/renderer/index.html"), "utf8");
const ranks = JSON.parse(readFileSync(join(root, "data/apogee_ranks.json"), "utf8"));

/** WCAG's floor for body text. The same number the rest of the chrome is held to. */
const FLOOR = 4.5;

/** How far apart the ramp's two steps may drift before it has lost a rung. */
const MAX_STEP_SPREAD = 0.25;

/**
 * Window sizes to rasterise at. The blobs are sized in vmax and the column is what is
 * left after the rail, so the field's shape is not the same at every size and the
 * brightest pixel does not sit in the same place. These are the default, the smallest
 * the window is allowed to be, and a large monitor.
 */
const WINDOWS: [number, number][] = [[1280, 880], [940, 640], [2560, 1440]];
const RAIL = Number(/--rail-w:\s*(\d+)px/.exec(html)?.[1]);
if (!Number.isFinite(RAIL)) throw new Error("missing rail width");
const BAR = 46;

const parse = (h: string) => parseInt(h.replace("#", ""), 16);
const chan = (n: number, s: number) => (n >> s) & 255;
const hexOf = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/** Straight source-over: `tint` at `alpha` painted on `ground`. */
function over(ground: string, tint: string, alpha: number): string {
  const g = parse(ground);
  const t = parse(tint);
  return hexOf(
    ...([16, 8, 0].map((s) => chan(g, s) * (1 - alpha) + chan(t, s) * alpha) as [number, number, number]),
  );
}

/** A custom property's value from the stylesheet's `:root`. */
function token(name: string): string {
  const m = new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})").exec(html);
  if (!m) throw new Error("--" + name + " not found in index.html");
  return m[1];
}

/** One `.orb-x` rule's body. */
function rule(cls: string): string {
  const m = new RegExp("\\." + cls + "\\s*\\{([^}]*)\\}").exec(html);
  if (!m) throw new Error("." + cls + " rule not found in index.html");
  return m[1];
}

const num = (body: string, prop: string): number | null => {
  const m = new RegExp(prop + ":\\s*(-?[0-9.]+)vmax").exec(body);
  return m ? Number(m[1]) : null;
};

interface Blob {
  name: string;
  size: number;      // vmax
  left: number | null;
  right: number | null;
  top: number | null;
  bottom: number | null;
  op: number;
  drift: [number, number, number][];   // dx vmax, dy vmax, scale
}

/** The drift extremes from a blob's keyframes: every stop, as offset and scale. */
function driftOf(name: string): [number, number, number][] {
  const kf = new RegExp("@keyframes orb-drift-" + name + "\\s*\\{([\\s\\S]*?)\\n  \\}").exec(html);
  if (!kf) throw new Error("@keyframes orb-drift-" + name + " not found");
  const out: [number, number, number][] = [];
  for (const m of kf[1].matchAll(
    /translate3d\(\s*(-?[0-9.]+)vmax,\s*(-?[0-9.]+)vmax,\s*0\)\s*scale\(([0-9.]+)\)/g,
  )) {
    out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  if (out.length === 0) throw new Error("no drift stops parsed for orb-" + name);
  return out;
}

const blobs: Blob[] = ["a", "b", "c"].map((letter) => {
  const cls = "orb-" + letter;
  const body = rule(cls);
  const size = num(body, "width");
  const op = /opacity:\s*([0-9.]+)/.exec(body);
  if (size === null || !op) throw new Error("." + cls + " is missing width or opacity");
  return {
    name: letter,
    size,
    left: num(body, "left"),
    right: num(body, "right"),
    top: num(body, "top"),
    bottom: num(body, "bottom"),
    op: Number(op[1]),
    drift: driftOf(letter),
  };
});

/**
 * The gradient's alpha profile, read from the stylesheet's stops.
 *   <opaque> 0%, <alpha> 38%, transparent 72%
 */
function gradientStops(): { mix: number; mid: number; midAt: number; endAt: number } {
  const mix = /color-mix\(in srgb, var\(--accent\) (\d+)%, #ffffff\)/.exec(html);
  const mid = /color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\) (\d+)%/.exec(html);
  const end = /transparent (\d+)%\)/.exec(html);
  if (!mix || !mid || !end) throw new Error("orb gradient stops not found in index.html");
  return {
    mix: Number(mix[1]) / 100,
    mid: Number(mid[1]) / 100,
    midAt: Number(mid[2]) / 100,
    endAt: Number(end[1]) / 100,
  };
}
const G = gradientStops();

/** Alpha at fraction `t` of the gradient's radius. */
function profile(t: number): number {
  if (t <= G.midAt) return 1 - (1 - G.mid) * (t / G.midAt);
  if (t <= G.endAt) return G.mid * (1 - (t - G.midAt) / (G.endAt - G.midAt));
  return 0;
}

/** The gradient's centre, as a fraction of the blob box. */
function centreFraction(): [number, number] {
  const m = /radial-gradient\(circle at (\d+)% (\d+)%/.exec(html);
  if (!m) throw new Error("orb gradient centre not found");
  return [Number(m[1]) / 100, Number(m[2]) / 100];
}
const [CX, CY] = centreFraction();

/** The largest lift any screen or state applies. Never above 1 by design. */
function maxLift(): number {
  const lifts = [...html.matchAll(/--orb-lift:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  if (lifts.length === 0) throw new Error("no --orb-lift declarations found");
  return Math.max(...lifts);
}
const lift = maxLift();

/**
 * The brightest alpha the whole field puts on any pixel of the content column, at one
 * window size. Each blob is taken at its most generous drift stop independently: they
 * are on coprime periods, so every combination happens eventually.
 */
function peakAlpha(win: [number, number], scale = 1, step = 5): { peak: number; mean: number } {
  const [winW, winH] = win;
  const vmax = Math.max(winW, winH) / 100;
  const W = winW - (winW <= 960 ? 72 : RAIL);
  const H = winH - BAR;
  let peak = 0;
  let sum = 0;
  let n = 0;

  for (let py = 0; py < H; py += step) {
    for (let px = 0; px < W; px += step) {
      let composite = 1;
      for (const b of blobs) {
        const size0 = b.size * vmax;
        let best = 0;
        for (const [dxv, dyv, sc] of b.drift) {
          const size = size0 * sc;
          // Resolve the box, then re-centre for the scale, then drift.
          const x0 = b.left !== null ? b.left * vmax : W - size0 - (b.right ?? 0) * vmax;
          const y0 = b.top !== null ? b.top * vmax : H - size0 - (b.bottom ?? 0) * vmax;
          const bx = x0 + (size0 - size) / 2 + dxv * vmax;
          const by = y0 + (size0 - size) / 2 + dyv * vmax;
          const cx = bx + size * CX;
          const cy = by + size * CY;
          // `circle` with no extent keyword resolves to farthest-corner of the box.
          const radius = Math.max(
            Math.hypot(cx - bx, cy - by),
            Math.hypot(cx - (bx + size), cy - by),
            Math.hypot(cx - bx, cy - (by + size)),
            Math.hypot(cx - (bx + size), cy - (by + size)),
          );
          best = Math.max(best, profile(Math.hypot(px - cx, py - cy) / radius) * b.op * scale);
        }
        composite *= 1 - best * lift;
      }
      const a = 1 - composite;
      sum += a;
      n++;
      if (a > peak) peak = a;
    }
  }
  return { peak, mean: sum / n };
}

const tiers: { name: string; color: string }[] = ranks.tiers ?? [];
if (tiers.length === 0) throw new Error("no tiers in data/apogee_ranks.json");

const INKS: [string, string][] = [
  ["ink", token("ink")],
  ["ink-mid", token("ink-mid")],
  ["ink-dim", token("ink-dim")],
];

/** Worst ink contrast anywhere in the palette, at a given field alpha. */
function worstAt(alpha: number) {
  let worst = { ratio: Infinity, ink: "", tier: "", ground: "" };
  for (const t of tiers) {
    const litGround = over(DARK_GROUND, over("#ffffff", t.color, G.mix), alpha);
    for (const [name, ink] of INKS) {
      const r = contrast(ink, litGround);
      if (r < worst.ratio) worst = { ratio: r, ink: name, tier: t.color, ground: litGround };
    }
  }
  return worst;
}

// The worst window size is the one that puts the most blob over the column.
let shipped = { peak: 0, mean: 0, win: WINDOWS[0] };
for (const w of WINDOWS) {
  const r = peakAlpha(w);
  if (r.peak > shipped.peak) shipped = { ...r, win: w };
}

// How much room is left at this geometry, as a multiplier on all three opacities.
let headroom = 0;
for (let sc = 0.25; sc <= 12; sc += 0.25) {
  const p = Math.max(...WINDOWS.map((w) => peakAlpha(w, sc, 8).peak));
  if (worstAt(p).ratio >= FLOOR) headroom = sc;
  else break;
}

const worst = worstAt(shipped.peak);
const steps: [string, number][] = [
  ["ink:ink-mid", contrast(INKS[0][1], INKS[1][1])],
  ["ink-mid:ink-dim", contrast(INKS[1][1], INKS[2][1])],
];
const spread = Math.max(...steps.map((s) => s[1])) - Math.min(...steps.map((s) => s[1]));
const dL = (luminance(worst.ground) - luminance(DARK_GROUND)) * 100;

console.log("orb field and ink ramp, rasterised against the shipped palette");
console.log("-------------------------------------------------------------");
console.log("  tiers             " + tiers.map((t) => t.color).join(" "));
console.log("  gradient          " + (G.mix * 100).toFixed(0) + "% into white, " +
  (G.mid * 100).toFixed(0) + "% at " + (G.midAt * 100).toFixed(0) + "%, clear at " +
  (G.endAt * 100).toFixed(0) + "%");
console.log("  opacities         " + blobs.map((b) => b.op).join(" / "));
console.log("  max screen lift   " + lift.toFixed(2));
console.log("  worst window      " + shipped.win[0] + "x" + shipped.win[1]);
console.log("  peak alpha        " + shipped.peak.toFixed(4) + "   (mean " + shipped.mean.toFixed(4) + ")");
console.log("  headroom left     x" + headroom.toFixed(2) + " on all three opacities");
console.log("  ramp              " + INKS.map(([n, c]) => n + " " + c).join("   "));
console.log("  steps             " + steps.map(([n, v]) => n + " " + v.toFixed(2) + ":1").join("   "));
console.log("  worst lit ground  " + worst.ground + " (tier " + worst.tier + "), +" +
  dL.toFixed(1) + " pts of luminance");
console.log("  worst ink there   " + worst.ink + " at " + worst.ratio.toFixed(2) + ":1");

const problems: string[] = [];

if (lift > 1) {
  problems.push("a --orb-lift of " + lift + " is over 1; the opacities are the ceiling already");
}
if (worst.ratio < FLOOR) {
  problems.push(
    "--" + worst.ink + " falls to " + worst.ratio.toFixed(2) + ":1 on " + worst.ground +
    " (tier " + worst.tier + ", floor " + FLOOR + "). Lower the orb opacities, or lift the ramp.",
  );
}
if (spread > MAX_STEP_SPREAD) {
  problems.push(
    "the ramp is lopsided: " + steps.map(([n, v]) => n + " " + v.toFixed(2)).join(", ") +
    " (spread " + spread.toFixed(2) + ", max " + MAX_STEP_SPREAD + "). Lifting one ink and " +
    "not the other is how three tones become two.",
  );
}

// The client's :root is where a human edits these; everything that generates a document
// reads DARK_CHROME. Two copies of a palette is one chance to change the wrong one.
for (const [name, key] of [["ink", "ink"], ["ink-mid", "inkMid"], ["ink-dim", "inkDim"]] as const) {
  const shippedInk = token(name);
  const shared = DARK_CHROME[key as keyof typeof DARK_CHROME];
  if (shippedInk.toLowerCase() !== String(shared).toLowerCase()) {
    problems.push(
      "--" + name + " is " + shippedInk + " in index.html but " + shared + " in DARK_CHROME. " +
      "The rank sheet and the UI preview are built from DARK_CHROME.",
    );
  }
}

console.log("");
if (problems.length > 0) {
  for (const p of problems) console.log("FAIL  " + p);
  process.exit(1);
}
console.log("OK: the orb field costs no ink its " + FLOOR + ":1, at any tier colour,");
console.log("    and the ramp still has three even rungs.");
