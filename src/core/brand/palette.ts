/**
 * The brand palette, derived rather than chosen.
 *
 * Everything that leaves the client - a share card, a store capsule, the README - should
 * be recognisably the thing the player opens, so the dark palette is the client's own
 * stylesheet tokens, passed in by whoever read them (tools/brand/kit.ts reads the
 * stylesheets in load order, the way buildIcon.mjs and validate:theme do; the renderer can
 * hand over getComputedStyle values). Nothing here picks a colour the client does not have.
 *
 * The client has no light theme, and a light card has to exist anyway: a screenshot
 * pasted into a light Discord, a forum post, a printed bracket. Rather than design a second
 * palette, each dark token is carried onto LIGHT_GROUND by arithmetic, so the light
 * palette's contrast is a property of the arithmetic instead of a promise: every ink clears
 * TEXT on its ground. The verdict colours are held to TEXT too, not WCAG's 3:1 for large
 * type, because the same green and red also mark the 13px round deltas.
 *
 * The first cut used `legibleOn`, the rank sheet's lift, which mixes a colour toward the
 * opposite ground. That is right for rank colours, where keeping neighbouring rungs evenly
 * spaced matters more than saturation, but every chrome token on the dark palette is a
 * pastel (--up is about 60% white), and mixing a pastel toward #10121b lands in grey:
 * Victory came out #5a716c, which reads as disabled. `deepen` keeps hue and saturation
 * and moves lightness alone, so the light Victory is still the dark one's green.
 */

import { DARK_GROUND, LIGHT_GROUND, contrast, legibleOn, mix } from "../report/contrast.ts";

function hsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("");
}

/**
 * A colour darkened, hue and saturation held, until it clears `floor` on `ground`.
 * One-percent steps of lightness; a colour already clear is returned untouched.
 */
export function deepen(color: string, ground: string, floor: number): string {
  const [h, s, l] = hsl(color);
  let out = color;
  for (let x = l; x > 0 && contrast(out, ground) < floor; x -= 0.01) out = fromHsl(h, s, Math.max(0, x));
  return out;
}

/** WCAG body text. Anything set under 24px on a card is held to this. */
export const TEXT = 4.5;

/** The client tokens the brand is built from, by their stylesheet names without `--`. */
export const BRAND_TOKENS = [
  "ground", "panel", "well", "rule", "rule-2",
  "ink", "ink-mid", "ink-dim",
  "brand", "brand-ink",
  "up", "down", "warn",
] as const;

export type BrandTokens = Record<(typeof BRAND_TOKENS)[number], string>;

export interface BrandPalette {
  theme: "dark" | "light";
  ground: string;
  /** A raised surface: table rows, the duel-code slot. */
  panel: string;
  well: string;
  /** Hairlines. Drawn at `lineOpacity`, the way the client's --cosmic-line is. */
  line: string;
  lineOpacity: number;
  /** A firmer rule for dividers that have to survive JPEG recompression on Discord. */
  rule: string;
  ink: string;
  inkMid: string;
  inkDim: string;
  brand: string;
  brandInk: string;
  up: string;
  down: string;
  warn: string;
  /** The ground a rank colour is lifted against: the brightest surface it sits on. */
  rankGround: string;
}

export function darkPalette(t: BrandTokens): BrandPalette {
  return {
    theme: "dark",
    ground: t.ground,
    panel: t.panel,
    well: t.well,
    // --cosmic-line is rgba(186,211,233,.14); written as a hex and an opacity so an SVG
    // attribute can carry it without an rgba() parser on the other end.
    line: "#bad3e9",
    lineOpacity: 0.14,
    rule: t["rule-2"],
    ink: t.ink,
    inkMid: t["ink-mid"],
    inkDim: t["ink-dim"],
    brand: t.brand,
    brandInk: t["brand-ink"],
    up: t.up,
    down: t.down,
    warn: t.warn,
    rankGround: t.panel,
  };
}

export function lightPalette(t: BrandTokens): BrandPalette {
  const ground = LIGHT_GROUND;
  const on = (c: string, floor: number) => deepen(c, ground, floor);
  return {
    theme: "light",
    ground,
    // White is the only thing lighter than the light ground, so the raised surface goes
    // most of the way there rather than inventing a tint.
    panel: mix(ground, "#ffffff", 70),
    well: mix(ground, t.ground, 4),
    line: t.ground,
    lineOpacity: 0.13,
    rule: mix(ground, t.ground, 22),
    // The dark ground is the darkest thing the brand owns, so it is the light ink.
    ink: t.ground,
    inkMid: on(mix(t.ground, ground, 22), TEXT),
    inkDim: on(t["ink-dim"], TEXT),
    brand: on(t.brand, TEXT),
    brandInk: ground,
    up: on(t.up, TEXT),
    down: on(t.down, TEXT),
    warn: on(t.warn, TEXT),
    rankGround: ground,
  };
}

export function palettes(t: BrandTokens): { dark: BrandPalette; light: BrandPalette } {
  return { dark: darkPalette(t), light: lightPalette(t) };
}

/**
 * Every ink/ground pair a card sets text in, with its floor, so a caller can prove the
 * palette rather than trust this file. tools/brand/buildBrand.ts fails on any row under.
 */
export function paletteChecks(p: BrandPalette): { pair: string; ratio: number; floor: number }[] {
  const rows: [string, string, string, number][] = [
    ["ink", p.ink, "ground", TEXT],
    ["inkMid", p.inkMid, "ground", TEXT],
    ["inkDim", p.inkDim, "ground", TEXT],
    ["inkDim", p.inkDim, "panel", TEXT],
    ["brand", p.brand, "ground", TEXT],
    ["brand", p.brand, "panel", TEXT],
    ["up", p.up, "ground", TEXT],
    ["down", p.down, "ground", TEXT],
    ["up", p.up, "panel", TEXT],
    ["down", p.down, "panel", TEXT],
    ["warn", p.warn, "ground", TEXT],
  ];
  return rows.map(([name, c, g, floor]) => {
    const ground = g === "panel" ? p.panel : p.ground;
    return { pair: `${name} on ${g}`, ratio: contrast(c, ground), floor };
  });
}

/** A rank colour as text on this palette, lifted the way the client lifts it. */
export function rankInk(p: BrandPalette, color: string, floor: number = TEXT): string {
  return legibleOn(color, p.rankGround, floor);
}

export { DARK_GROUND, LIGHT_GROUND };
