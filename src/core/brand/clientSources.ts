/**
 * Reading the brand out of the client's own files: colour tokens from the stylesheets, the
 * rank insignia from renderer.js, the card faces from the vendored fonts.
 *
 * Pure string work, no fs, so the two readers share one copy: tools/brand/kit.ts hands in
 * the source tree's files, and the app's share card (src/app/shareCard.ts) hands in the
 * copies build:app put in dist. Two readers with their own regexes would drift, and a card
 * from the app that coloured a tier differently from the brand kit's samples is exactly
 * the disagreement nobody would catch by eye.
 */

import { BRAND_TOKENS, type BrandTokens } from "./palette.ts";

/**
 * The stylesheets in the order the client loads them: index.html's inline <style>, then
 * the linked sheets that set tokens. Later declarations win, as they do in the page.
 */
export const TOKEN_SHEETS = ["arena.css", "arcade.css", "cosmic.css"] as const;

export function tokenCss(indexHtml: string, sheets: string[]): string {
  return indexHtml.slice(0, indexHtml.indexOf("</style>")) + "\n" + sheets.join("\n");
}

function lastHex(css: string, name: string): string | null {
  const m = [...css.matchAll(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})\\s*[;}]", "g"))].at(-1);
  return m ? m[1].toLowerCase() : null;
}

export function readTokens(css: string): BrandTokens {
  return Object.fromEntries(
    BRAND_TOKENS.map((n) => {
      const hex = lastHex(css, n);
      if (!hex) throw new Error(`--${n} has no hex value in the stylesheets`);
      return [n, hex];
    }),
  ) as BrandTokens;
}

/**
 * Ghost Mode's own tint, `--gh` in ghost.css. The ghost screen marks the past self in it,
 * so a ghost card does too; null when the sheet no longer sets it, and the card falls back
 * to the brand colour rather than inventing one.
 */
export function readGhostTint(ghostCss: string): string | null {
  const m = /--gh:\s*(#[0-9a-fA-F]{6})\s*[;}]/.exec(ghostCss);
  return m ? m[1].toLowerCase() : null;
}

export type BadgeFn = (tier: { id: string; name: string; color: string }, uid?: string) => string;

/**
 * badge() sliced out of renderer.js, with its colour lift replaced by a fixed ink.
 *
 * badge() lifts the tier colour for the client's dark control surface; a card on a light
 * ground needs it moved the other way, so the ink is handed in and the geometry is the
 * renderer's untouched.
 */
export function sliceBadge(rendererJs: string): (ink: string) => BadgeFn {
  const src = rendererJs.replace(/\r\n/g, "\n");
  const start = src.indexOf("function badge(tier");
  const end = src.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("badge() is missing from renderer.js");
  const body = `${src.slice(start, end + 2)}\nreturn badge;`;
  const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  return (ink) => new Function("esc", "legibleOnDark", "RANK_TEXT_CONTRAST", body)(esc, () => ink, 4.5) as BadgeFn;
}

/** The insignia for a tier as a standalone <svg>, drawn in `ink`. */
export function emblemFrom(badge: (ink: string) => BadgeFn): (tier: { id: string; name: string; color: string }, ink: string) => string {
  return (tier, ink) => {
    const svg = badge(ink)(tier);
    return svg.includes("xmlns=") ? svg : svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  };
}

/**
 * Barlow for display and Cascadia Mono for figures, both SIL OFL 1.1 and vendored in
 * assets/brand/fonts with their licences. The client sets Bahnschrift and Cascadia Mono
 * from the system; Bahnschrift cannot be redistributed, and Barlow is the open grotesk
 * cut closest to it (both descend from DIN 1451), so a card reads as the same family
 * without depending on a Windows font the renderer may not have.
 */
export const CARD_FACES = [
  { family: "Apogee Display", weight: 400, file: "barlow-latin-400-normal.woff2" },
  { family: "Apogee Display", weight: 500, file: "barlow-latin-500-normal.woff2" },
  { family: "Apogee Display", weight: 600, file: "barlow-latin-600-normal.woff2" },
  { family: "Apogee Mono", weight: 400, file: "cascadia-mono-latin-400-normal.woff2" },
  { family: "Apogee Mono", weight: 600, file: "cascadia-mono-latin-600-normal.woff2" },
] as const;

/**
 * @font-face rules for the faces an SVG actually sets, inlined as data URIs, so the file
 * renders the same in a browser, an image viewer, or an SVG decoded into a canvas, which
 * cannot fetch anything. Only the weights used are embedded: each is about 22 KB.
 */
export function fontCss(svgBody: string, fontBase64: (file: string) => string): string {
  return CARD_FACES.filter((f) => new RegExp(`font-family="'${f.family}'[^"]*"[^>]*font-weight="${f.weight}"`).test(svgBody))
    .map((f) => `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:normal;src:url(data:font/woff2;base64,${fontBase64(f.file)}) format('woff2')}`)
    .join("");
}

/** Put the @font-face rules an SVG needs into its <defs>, creating one if it has none. */
export function withFonts(svg: string, fontBase64: (file: string) => string): string {
  const css = fontCss(svg, fontBase64);
  if (!css) return svg;
  if (svg.includes("<defs>")) return svg.replace("<defs>", `<defs><style>${css}</style>`);
  return svg.replace(/(<svg\b[^>]*>)/, `$1<defs><style>${css}</style></defs>`);
}
