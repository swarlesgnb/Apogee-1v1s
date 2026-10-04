/**
 * The brand kit's drawing vocabulary, shared by every generator in tools/brand: type set
 * in the kit's two faces, the lockups, the square-star sky, the corner wash, the
 * registration corners and the ladder drawn as an orbit.
 *
 * Moved out of buildBrand.ts unchanged when the mechanics, marketing and motion builds
 * needed the same pieces; buildBrand.ts's output is byte-for-byte what it was.
 */

import { rankInk, type BrandPalette } from "../../src/core/brand/palette.ts";
import { FIT_TEXT_SCRIPT, FONT_DISPLAY, FONT_MONO, MARK_PATH, esc, placeSvg } from "../../src/core/brand/shareCard.ts";
import { emblem, tiers } from "./kit.ts";

/**
 * Carry FIT_TEXT_SCRIPT inside an SVG for the rasteriser: it shrinks any `data-fit` text
 * to its budget and reports text that leaves the canvas. The kept SVG has it removed.
 */
export function withFit(svg: string): string {
  return svg.replace(/<\/svg>$/, `<script type="text/fit">${FIT_TEXT_SCRIPT}</script></svg>`);
}

export function t(
  s: string, x: number, y: number,
  o: { size: number; fill: string; mono?: boolean; weight?: number; anchor?: "middle" | "end"; tracking?: number; upper?: boolean; opacity?: number; fit?: number },
): string {
  return `<text x="${x}" y="${y}" font-family="${o.mono ? FONT_MONO : FONT_DISPLAY}" font-size="${o.size}" font-weight="${o.weight ?? (o.mono ? 400 : 500)}" fill="${o.fill}"` +
    (o.anchor ? ` text-anchor="${o.anchor}"` : "") +
    (o.tracking ? ` letter-spacing="${(o.tracking * o.size).toFixed(2)}"` : "") +
    (o.opacity != null ? ` opacity="${o.opacity}"` : "") +
    // A width budget for FIT_TEXT_SCRIPT, for text a caller passes in (withFit() adds the script).
    (o.fit ? ` data-fit="${o.fit}"` : "") +
    `>${esc(o.upper ? s.toUpperCase() : s)}</text>`;
}

export function svgDoc(w: number, h: number, body: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${body}</svg>`;
}

/** The mark alone, `h` tall, its 24-unit box's top-left at x,y. */
export function mark(p: BrandPalette, x: number, y: number, h: number, colour = p.brand): string {
  return `<svg x="${x}" y="${y}" width="${h}" height="${h}" viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${MARK_PATH}"/></svg>`;
}

/**
 * The horizontal lockup with its baseline at y. The mark's feet (y=20 of its 24) sit on
 * the wordmark's baseline and its peak stands a little over the cap height, so the two
 * read as one line rather than an icon beside a word. The rail's own ratio (a 31px box
 * beside 29px Bahnschrift) was tried first and made the mark the loudest thing in every
 * lockup: Barlow's lowercase is smaller on the body than Bahnschrift's.
 */
export function horizontal(p: BrandPalette, x: number, y: number, size: number, ink = p.ink): string {
  const m = size * 1.05;
  return mark(p, x, y - m * (20.8 / 24), m) + t("apogee", x + m * 0.93 + size * 0.22, y, { size, fill: ink, weight: 500, tracking: -0.03 });
}

export function rng(seed: number): () => number {
  let h = seed >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let v = Math.imul(h ^ (h >>> 15), h | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

export function stars(p: BrandPalette, w: number, h: number, n: number, seed: number, avoid: [number, number, number, number][] = []): string {
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

export function ground(p: BrandPalette, w: number, h: number, gx: number, gy: number): string {
  const wash = p.theme === "dark" ? "#324452" : "#c9d6e2";
  return `<defs><radialGradient id="wash" cx="${gx}" cy="${gy}" r="${Math.max(w, h) * 0.7}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${wash}" stop-opacity="${p.theme === "dark" ? 0.45 : 0.6}"/><stop offset="1" stop-color="${wash}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="${p.ground}"/><rect width="${w}" height="${h}" fill="url(#wash)"/>`;
}

export function corners(p: BrandPalette, w: number, h: number, inset: number, arm: number): string {
  const d = `M${inset} ${inset + arm}V${inset}H${inset + arm}M${w - inset - arm} ${inset}H${w - inset}V${inset + arm}M${inset} ${h - inset - arm}V${h - inset}H${inset + arm}M${w - inset - arm} ${h - inset}H${w - inset}V${h - inset - arm}`;
  return `<path d="${d}" fill="none" stroke="${p.ink}" stroke-opacity=".2" stroke-width="1.5"/>`;
}

/**
 * The ladder as an orbit. The ellipse is drawn whole and faint; the eight insignia sit on
 * its upper half from the perigee end to the apogee end, growing as they climb, so the
 * rank order reads left to right and bottom to top without a single label.
 */
export function ascent(p: BrandPalette, o: { cx: number; cy: number; rx: number; ry: number; tilt: number; small: number; large: number; from?: number; count?: number }): string {
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

