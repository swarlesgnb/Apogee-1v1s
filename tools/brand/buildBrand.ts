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
import { FONT_DISPLAY, FONT_MONO, MARK_PATH, esc, placeSvg } from "../../src/core/brand/shareCard.ts";
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

// ------------------------------------------------------------------ drawing helpers

function t(
  s: string, x: number, y: number,
  o: { size: number; fill: string; mono?: boolean; weight?: number; anchor?: "middle" | "end"; tracking?: number; upper?: boolean; opacity?: number },
): string {
  return `<text x="${x}" y="${y}" font-family="${o.mono ? FONT_MONO : FONT_DISPLAY}" font-size="${o.size}" font-weight="${o.weight ?? (o.mono ? 400 : 500)}" fill="${o.fill}"` +
    (o.anchor ? ` text-anchor="${o.anchor}"` : "") +
    (o.tracking ? ` letter-spacing="${(o.tracking * o.size).toFixed(2)}"` : "") +
    (o.opacity != null ? ` opacity="${o.opacity}"` : "") +
    `>${esc(o.upper ? s.toUpperCase() : s)}</text>`;
}

function svgDoc(w: number, h: number, body: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${body}</svg>`;
}

/** The mark alone, `h` tall, its 24-unit box's top-left at x,y. */
function mark(p: BrandPalette, x: number, y: number, h: number, colour = p.brand): string {
  return `<svg x="${x}" y="${y}" width="${h}" height="${h}" viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${MARK_PATH}"/></svg>`;
}

/**
 * The horizontal lockup with its baseline at y. The mark's feet (y=20 of its 24) sit on
 * the wordmark's baseline and its peak stands a little over the cap height, so the two
 * read as one line rather than an icon beside a word. The rail's own ratio (a 31px box
 * beside 29px Bahnschrift) was tried first and made the mark the loudest thing in every
 * lockup: Barlow's lowercase is smaller on the body than Bahnschrift's.
 */
function horizontal(p: BrandPalette, x: number, y: number, size: number, ink = p.ink): string {
  const m = size * 1.05;
  return mark(p, x, y - m * (20.8 / 24), m) + t("apogee", x + m * 0.93 + size * 0.22, y, { size, fill: ink, weight: 500, tracking: -0.03 });
}

function rng(seed: number): () => number {
  let h = seed >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let v = Math.imul(h ^ (h >>> 15), h | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

function stars(p: BrandPalette, w: number, h: number, n: number, seed: number, avoid: [number, number, number, number][] = []): string {
  const r = rng(seed);
  const ink = p.theme === "dark" ? p.ink : p.inkDim;
  let out = "";
  for (let i = 0, tries = 0; i < n && tries < n * 20; tries++) {
    const x = Math.round(r() * w);
    const y = Math.round(r() * h);
    const big = r() < 0.16;
    const o = big ? 0.36 : 0.12 + r() * 0.16;
    if (avoid.some(([ax, ay, aw, ah]) => x > ax && x < ax + aw && y > ay && y < ay + ah)) continue;
    out += `<rect x="${x}" y="${y}" width="${big ? 3 : 2}" height="${big ? 3 : 2}" fill="${ink}" opacity="${o.toFixed(2)}"/>`;
    i++;
  }
  return out;
}

function ground(p: BrandPalette, w: number, h: number, gx: number, gy: number): string {
  const wash = p.theme === "dark" ? "#324452" : "#c9d6e2";
  return `<defs><radialGradient id="wash" cx="${gx}" cy="${gy}" r="${Math.max(w, h) * 0.7}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${wash}" stop-opacity="${p.theme === "dark" ? 0.45 : 0.6}"/><stop offset="1" stop-color="${wash}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="${p.ground}"/><rect width="${w}" height="${h}" fill="url(#wash)"/>`;
}

function corners(p: BrandPalette, w: number, h: number, inset: number, arm: number): string {
  const d = `M${inset} ${inset + arm}V${inset}H${inset + arm}M${w - inset - arm} ${inset}H${w - inset}V${inset + arm}M${inset} ${h - inset - arm}V${h - inset}H${inset + arm}M${w - inset - arm} ${h - inset}H${w - inset}V${h - inset - arm}`;
  return `<path d="${d}" fill="none" stroke="${p.ink}" stroke-opacity=".2" stroke-width="1.5"/>`;
}

/**
 * The ladder as an orbit. The ellipse is drawn whole and faint; the eight insignia sit on
 * its upper half from the perigee end to the apogee end, growing as they climb, so the
 * rank order reads left to right and bottom to top without a single label.
 */
function ascent(p: BrandPalette, o: { cx: number; cy: number; rx: number; ry: number; tilt: number; small: number; large: number; from?: number; count?: number }): string {
  const a = (o.tilt * Math.PI) / 180;
  const at = (theta: number) => {
    const ex = o.rx * Math.cos(theta);
    const ey = o.ry * Math.sin(theta);
    return [o.cx + ex * Math.cos(a) - ey * Math.sin(a), o.cy + ex * Math.sin(a) + ey * Math.cos(a)];
  };
  let out = `<g fill="none" stroke="${p.theme === "dark" ? "#bad3e9" : p.ink}">` +
    `<ellipse cx="${o.cx}" cy="${o.cy}" rx="${o.rx}" ry="${o.ry}" transform="rotate(${o.tilt} ${o.cx} ${o.cy})" stroke-opacity=".22" stroke-width="1.2"/>` +
    `<ellipse cx="${o.cx}" cy="${o.cy}" rx="${o.rx * 1.08}" ry="${o.ry * 1.16}" transform="rotate(${o.tilt} ${o.cx} ${o.cy})" stroke-opacity=".2" stroke-dasharray="1 8"/>` +
    `</g>`;
  const [px, py] = at(0);
  out += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(o.large * 0.035).toFixed(1)}" fill="${p.brand}"/>`;
  const list = tiers.slice(o.from ?? 0, (o.from ?? 0) + (o.count ?? tiers.length));
  // From the perigee side over the top to short of apogee, so the top tier sits beside
  // the apogee point rather than on it. Spaced by distance along the path, not by angle:
  // equal angles bunch up at the ends of a tilted ellipse, and the top three tiers
  // overlapped.
  const t0 = Math.PI * 1.06;
  const t1 = Math.PI * 1.84;
  const steps = 400;
  const lengths = [0];
  for (let s = 1; s <= steps; s++) {
    const [x0, y0] = at(t0 + ((t1 - t0) * (s - 1)) / steps);
    const [x1, y1] = at(t0 + ((t1 - t0) * s) / steps);
    lengths.push(lengths[s - 1] + Math.hypot(x1 - x0, y1 - y0));
  }
  const thetaAt = (frac: number) => {
    const want = frac * lengths[steps];
    const s = lengths.findIndex((l) => l >= want);
    return t0 + ((t1 - t0) * Math.max(0, s)) / steps;
  };
  // The two largest neighbours are the tightest pair; if they would touch, every insignia
  // shrinks by the same factor so the climb in size survives.
  const width = (h: number) => (h * 80) / 86;
  const spacing = list.length > 1 ? lengths[steps] / (list.length - 1) : Infinity;
  const penultimate = o.small + (o.large - o.small) * ((list.length - 2) / Math.max(1, list.length - 1));
  const fit = Math.min(1, (0.9 * spacing) / ((width(o.large) + width(penultimate)) / 2));
  list.forEach((tier, i) => {
    const k = list.length === 1 ? 1 : i / (list.length - 1);
    const [x, y] = at(thetaAt(k));
    const h = (o.small + (o.large - o.small) * k) * fit;
    const w = (h * 80) / 86;
    out += placeSvg(emblem(tier, rankInk(p, tier.color)), +(x - w / 2).toFixed(1), +(y - h / 2).toFixed(1), +w.toFixed(1), +h.toFixed(1));
  });
  return out;
}

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
