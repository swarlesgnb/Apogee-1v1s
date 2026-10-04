/**
 * Draw the brand kit into assets/brand: lockups, the palette sheet, the rank emblems, the
 * README hero and the Steam capsules.
 *
 *   npm run brand          this, then the share cards (tools/brand/renderShareCard.ts)
 *
 * Every picture is SVG first, written by the functions below from the client's own
 * tokens, the client's own mark and the client's own rank insignia (tools/brand/kit.ts
 * says where each is read from), then rasterised by Electron. Nothing in assets/brand is
 * drawn by hand, so a palette change, a new tier colour or a redrawn insignia reaches
 * every file here on the next run, and a diff of this directory after one is the review.
 *
 * The composition that recurs - the ladder as an orbit, eight insignia rising along it to
 * Supernova at the far end of the major axis - is the name taken literally: apogee is the
 * point of an orbit farthest from what it circles. The app icon was once an orbit with a
 * point at apogee (see buildIcon.mjs); the mark replaced it in the icon, and the orbit
 * moved here, where there is room for it.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { contrast } from "../../src/core/report/contrast.ts";
import { palettes, paletteChecks, rankInk, type BrandPalette } from "../../src/core/brand/palette.ts";
import { MARK_PATH, placeSvg } from "../../src/core/brand/shareCard.ts";
import { ascent, corners, ground, horizontal, mark, stars, svgDoc, t } from "./draw.ts";
import { emblem, ensureDir, rasterize, root, slug, tiers, tokens, withFonts, type RasterJob } from "./kit.ts";

const P = palettes(tokens);
const OUT = join(root, "assets", "brand");
const jobs: RasterJob[] = [];

/** Queue one SVG for rasterising, and keep the fitted SVG beside the PNG. */
function emit(rel: string, svg: string, width: number, height: number, trim?: number): void {
  const base = join(OUT, rel);
  jobs.push({ svg: withFonts(svg), svgOut: ensureDir(`${base}.svg`), pngOut: `${base}.png`, width, height, trim });
}

// ------------------------------------------------------------------ the palette, proved

let bad = 0;
for (const p of [P.dark, P.light]) {
  for (const row of paletteChecks(p)) {
    if (row.ratio < row.floor) {
      bad++;
      console.error(`  FAIL ${p.theme}: ${row.pair} is ${row.ratio.toFixed(2)}:1, under ${row.floor}:1`);
    }
  }
}
if (bad) process.exit(1);
console.log(`brand palette: ${paletteChecks(P.dark).length * 2} ink/ground pairs clear their floor on both themes`);

// ------------------------------------------------------------------ lockups

for (const theme of ["dark", "light"] as const) {
  const p = P[theme];
  // Transparent: a lockup is placed on somebody else's ground. Dark means "for a dark
  // ground", so its ink is light.
  emit(`logo/horizontal-${theme}`, svgDoc(560, 160, horizontal(p, 20, 110, 96), "Apogee"), 1200, 0, 8);
  emit(
    `logo/stacked-${theme}`,
    svgDoc(560, 420,
      mark(p, 280 - 60, 20, 120) +
      t("apogee", 280, 214, { size: 96, fill: p.ink, weight: 500, anchor: "middle", tracking: -0.03 }) +
      t("Ranked 1v1 for KovaaK's", 280, 262, { size: 17, fill: p.inkDim, mono: true, anchor: "middle", tracking: 0.12, upper: true }),
      "Apogee: ranked 1v1 for KovaaK's"),
    800, 0, 12,
  );
  // The mark in its own 24-unit box, unpadded: the box already holds the optical lift
  // buildIcon.mjs applies (the glyph's centre is half a unit above the box's).
  emit(`logo/mark-${theme}`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512" role="img" aria-label="Apogee"><title>Apogee</title><path d="${MARK_PATH}" fill="none" stroke="${p.brand}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>`, 512, 512);
}

// ------------------------------------------------------------------ emblems

for (const theme of ["dark", "light"] as const) {
  const p = P[theme];
  tiers.forEach((tier, i) => {
    // Transparent, like the lockups, and lifted for the ground its theme names: the same
    // lift the client gives the insignia on its own surfaces.
    emit(`emblems/${theme}/${i + 1}-${slug(tier.name)}`, emblem(tier, rankInk(p, tier.color)), 320, 344);
  });

  // The ladder: every tier, its colour as authored and as it is drawn, and its band.
  const W = 1600;
  const H = 560;
  let body = ground(p, W, H, W * 0.9, 0) + stars(p, W, H, 60, 11 + (theme === "dark" ? 0 : 1), [[40, 150, W - 80, 380]]) + corners(p, W, H, 20, 14);
  body += horizontal(p, 64, 84, 30) + t("Season 1 ladder", W - 64, 78, { size: 14, fill: p.inkDim, mono: true, anchor: "end", tracking: 0.18, upper: true });
  body += `<path d="M64 112H${W - 64}" stroke="${p.theme === "dark" ? "#bad3e9" : p.ink}" stroke-opacity=".2"/>`;
  const pitch = (W - 128) / tiers.length;
  tiers.forEach((tier, i) => {
    const cx = 64 + pitch * (i + 0.5);
    const ink = rankInk(p, tier.color);
    // Each rung sits a little higher than the last: the ladder climbs even in a row.
    const lift = i * 9;
    const h = 150;
    body += placeSvg(emblem(tier, ink), cx - (h * 80) / 86 / 2, 180 - lift, (h * 80) / 86, h);
    body += t(tier.name, cx, 380, { size: 26, fill: ink, weight: 600, anchor: "middle" });
    const [lo, hi] = tier.percentile;
    body += t(hi === 100 ? `Top ${100 - lo}%` : `p${lo}–${hi}`, cx, 412, { size: 13, fill: p.inkMid, mono: true, anchor: "middle", tracking: 0.12, upper: true });
    body += `<rect x="${cx - 40}" y="444" width="80" height="10" rx="2" fill="${tier.color}"/>`;
    body += t(tier.color.toLowerCase(), cx, 480, { size: 12, fill: p.inkDim, mono: true, anchor: "middle" });
    body += t(ink === tier.color ? "drawn as is" : `drawn ${ink}`, cx, 500, { size: 12, fill: p.inkDim, mono: true, anchor: "middle" });
  });
  emit(`emblems/ladder-${theme}`, svgDoc(W, H, body, "Apogee season 1 rank ladder"), W, H);
}

// ------------------------------------------------------------------ palette sheet

{
  const W = 1600;
  const H = 1180;
  const d = P.dark;
  let body = ground(d, W, H, W * 0.95, 0) + corners(d, W, H, 20, 14);
  body += horizontal(d, 72, 96, 34);
  body += t("Brand palette", W - 72, 80, { size: 14, fill: d.inkDim, mono: true, anchor: "end", tracking: 0.18, upper: true });
  body += t("Read from the client stylesheets · npm run brand", W - 72, 102, { size: 12, fill: d.inkDim, mono: true, anchor: "end", tracking: 0.04 });

  const row = (p: BrandPalette, y: number, title: string, note: string) => {
    const keys: [string, keyof BrandPalette][] = [
      ["ground", "ground"], ["panel", "panel"], ["well", "well"], ["rule", "rule"],
      ["ink", "ink"], ["ink mid", "inkMid"], ["ink dim", "inkDim"],
      ["brand", "brand"], ["up", "up"], ["down", "down"], ["warn", "warn"],
    ];
    let s = "";
    // Each row sits on its own theme's ground, so a swatch is judged where it is used.
    s += `<rect x="56" y="${y - 44}" width="${W - 112}" height="244" rx="12" fill="${p.ground}" stroke="${p.theme === "dark" ? "#bad3e9" : p.ink}" stroke-opacity=".16"/>`;
    s += t(title, 80, y - 14, { size: 14, fill: p.brand, mono: true, tracking: 0.2, upper: true, weight: 600 });
    s += t(note, W - 80, y - 14, { size: 12, fill: p.inkDim, mono: true, anchor: "end" });
    const pitch = (W - 160) / keys.length;
    keys.forEach(([name, k], i) => {
      const x = 80 + i * pitch;
      const c = p[k] as string;
      s += `<rect x="${x}" y="${y}" width="${pitch - 12}" height="92" rx="7" fill="${c}" stroke="${p.theme === "dark" ? "#bad3e9" : p.ink}" stroke-opacity=".22"/>`;
      s += t(name, x, y + 120, { size: 15, fill: p.ink, weight: 600 });
      s += t(c, x, y + 142, { size: 13, fill: p.inkMid, mono: true });
      const isInk = !["ground", "panel", "well", "rule"].includes(String(k));
      if (isInk) {
        const ratio = contrast(c, p.ground);
        s += t(`${ratio.toFixed(1)}:1`, x, y + 162, { size: 12, fill: p.inkDim, mono: true });
      }
    });
    return s;
  };
  body += row(d, 200, "Dark · the client", "tokens as the renderer ships them; ratios against ground");
  body += row(P.light, 480, "Light · derived", "hue and saturation kept, lightness moved until 4.5:1");

  // Type.
  const ty = 780;
  body += t("Type", 80, ty, { size: 14, fill: d.brand, mono: true, tracking: 0.2, upper: true, weight: 600 });
  body += t("Victory", 80, ty + 110, { size: 112, fill: d.up, weight: 600, tracking: -0.035 });
  body += t("Barlow 400 · 500 · 600, display and names", 80, ty + 150, { size: 14, fill: d.inkMid, mono: true });
  body += t("rylee vs ravenous", 520, ty + 70, { size: 40, fill: d.ink, weight: 500 });
  body += t("In place of the client's Bahnschrift, which cannot be shipped", 520, ty + 104, { size: 16, fill: d.inkDim, weight: 400 });
  body += t("+3.1% · base 3,584 · 1617 → 1629", 1010, ty + 70, { size: 24, fill: d.ink, mono: true, weight: 600 });
  body += t("Cascadia Mono 400 · 600, figures and labels", 1010, ty + 104, { size: 14, fill: d.inkMid, mono: true });
  body += t("SIL Open Font License 1.1 · assets/brand/fonts", 1010, ty + 126, { size: 14, fill: d.inkDim, mono: true });

  // The eight tiers, raw.
  const ry = 980;
  body += t("Rank tiers · data/apogee_ranks.json", 80, ry, { size: 14, fill: d.brand, mono: true, tracking: 0.2, upper: true, weight: 600 });
  const pitch = (W - 160) / tiers.length;
  tiers.forEach((tier, i) => {
    const x = 80 + i * pitch;
    body += `<rect x="${x}" y="${ry + 24}" width="${pitch - 12}" height="56" rx="7" fill="${tier.color}"/>`;
    body += t(tier.name, x, ry + 108, { size: 17, fill: rankInk(d, tier.color), weight: 600 });
    body += t(tier.color.toLowerCase(), x, ry + 130, { size: 13, fill: d.inkMid, mono: true });
  });
  emit("palette", svgDoc(W, H, body, "Apogee brand palette"), W, H);
}

// ------------------------------------------------------------------ hero and store art

/**
 * One composition at four sizes. Steam asks that capsules carry the logo and little
 * else, so the store art has no tagline; the README hero is read, so it gets one line.
 */
function key(w: number, h: number, o: { lockup: number; lx: number; ly: number; arc: Parameters<typeof ascent>[1] | null; tagline?: boolean; seed: number }): string {
  const p = P.dark;
  let body = ground(p, w, h, w * 0.88, h * 0.05);
  body += stars(p, w, h, Math.round((w * h) / 9000), o.seed, [[o.lx - 10, o.ly - o.lockup * 1.3, o.lockup * 4.6, o.lockup * (o.tagline ? 2.4 : 1.6)]]);
  body += corners(p, w, h, Math.round(w * 0.018), Math.round(w * 0.012));
  if (o.arc) body += ascent(p, o.arc);
  body += horizontal(p, o.lx, o.ly, o.lockup);
  if (o.tagline) {
    body += t("Ranked 1v1 for KovaaK's", o.lx + 4, o.ly + o.lockup * 0.62, { size: o.lockup * 0.3, fill: p.ink, weight: 500 });
    body += t("Queue a category · play three scenarios · the ladder settles itself", o.lx + 4, o.ly + o.lockup * 0.95, { size: o.lockup * 0.13, fill: p.inkDim, mono: true, tracking: 0.04 });
  }
  return svgDoc(w, h, body, "Apogee: ranked 1v1 for KovaaK's");
}

emit("readme-hero", key(1280, 640, { lockup: 100, lx: 80, ly: 298, tagline: true, seed: 5, arc: { cx: 995, cy: 340, rx: 275, ry: 175, tilt: -16, small: 60, large: 116 } }), 1280, 640);
emit("store/main-capsule-1232x706", key(1232, 706, { lockup: 104, lx: 80, ly: 386, seed: 7, arc: { cx: 885, cy: 400, rx: 325, ry: 205, tilt: -16, small: 64, large: 136 } }), 1232, 706);
emit("store/header-920x430", key(920, 430, { lockup: 80, lx: 52, ly: 244, seed: 9, arc: { cx: 672, cy: 236, rx: 222, ry: 136, tilt: -16, small: 46, large: 96 } }), 920, 430);
// At 462x174 eight insignia are eight smudges and even one crowds the logo, so the
// small capsule keeps only the orbit and its apogee: the logo has to read at list size.
emit("store/small-capsule-462x174", key(462, 174, { lockup: 56, lx: 30, ly: 108, seed: 13, arc: { cx: 368, cy: 92, rx: 76, ry: 42, tilt: -16, small: 0, large: 60, count: 0 } }), 462, 174);

// ------------------------------------------------------------------ write

writeFileSync(ensureDir(join(root, ".cache", "brand", "kit.txt")), jobs.map((j) => j.pngOut).join("\n") + "\n");
console.log(`brand kit: ${jobs.length} images`);
rasterize(jobs, "kit");
