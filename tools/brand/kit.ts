/**
 * What every brand generator reads, read once: the client's colour tokens, the rank
 * ladder, the rank insignia, the fonts, and the Electron rasteriser that turns SVG into
 * PNG.
 *
 * Nothing here is a second copy. The tokens come out of the stylesheets in load order,
 * last declaration winning, exactly as buildIcon.mjs and validate:theme read them. The
 * tiers are data/apogee_ranks.json through loadRankTheme(), which is the file the client
 * ranks players with. The insignia is badge() sliced out of renderer.js, the way
 * validate:theme slices the theme section, so a change to the in-app emblem is a change to
 * every emblem, card and capsule the next time these run.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BRAND_TOKENS, type BrandTokens } from "../../src/core/brand/palette.ts";
import { loadRankTheme, type RankTier } from "../../src/core/ranks/apogeeRanks.ts";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const read = (p: string) => readFileSync(join(root, p), "utf8");

// ------------------------------------------------------------------ tokens

const html = read("src/app/renderer/index.html");
const css =
  html.slice(0, html.indexOf("</style>")) + "\n" +
  ["arena", "arcade", "cosmic"].map((f) => read(`src/app/renderer/${f}.css`)).join("\n");

function token(name: string): string {
  const m = [...css.matchAll(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})\\s*[;}]", "g"))].at(-1);
  if (!m) throw new Error(`--${name} has no hex value in the stylesheets`);
  return m[1].toLowerCase();
}

export const tokens = Object.fromEntries(BRAND_TOKENS.map((n) => [n, token(n)])) as BrandTokens;

// ------------------------------------------------------------------ tiers

export const tiers: RankTier[] = loadRankTheme(join(root, "data", "apogee_ranks.json")).tiers;

// The season carries the overall ladder's names and colours too. They are meant to be the
// same eight, and a kit drawn from one while the client shows the other would be wrong
// in a way nobody notices until a player does, so a disagreement stops the build.
{
  const season = JSON.parse(read("data/seasons/season-1.json")) as { rankNames?: string[]; rankColors?: Record<string, string> };
  const names = tiers.map((t) => t.name);
  if (season.rankNames && season.rankNames.join("|") !== names.join("|")) {
    throw new Error(`season-1 rankNames (${season.rankNames.join(", ")}) differ from apogee_ranks.json (${names.join(", ")})`);
  }
  for (const t of tiers) {
    const c = season.rankColors?.[t.name];
    if (c && c.toLowerCase() !== t.color.toLowerCase()) {
      throw new Error(`${t.name} is ${t.color} in apogee_ranks.json and ${c} in season-1.json`);
    }
  }
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ------------------------------------------------------------------ the insignia

type Badge = (tier: { id: string; name: string; color: string }, uid?: string) => string;

function sliceBadge(ink: () => string): Badge {
  const src = read("src/app/renderer/renderer.js").replace(/\r\n/g, "\n");
  const start = src.indexOf("function badge(tier");
  const end = src.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("badge() is missing from renderer.js");
  const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  return new Function("esc", "legibleOnDark", "RANK_TEXT_CONTRAST", `${src.slice(start, end + 2)}\nreturn badge;`)(esc, ink, 4.5) as Badge;
}

/**
 * The client's insignia for a tier, in a given ink.
 *
 * badge() lifts the tier colour itself for the client's dark control surface; a card on
 * a light ground needs the colour moved the other way, so the lift is handed in and the
 * geometry is the renderer's untouched.
 */
export function emblem(tier: { id: string; name: string; color: string }, ink: string): string {
  const svg = sliceBadge(() => ink)(tier);
  return svg.includes("xmlns=") ? svg : svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

// ------------------------------------------------------------------ fonts

/**
 * Barlow for display and Cascadia Mono for figures, both SIL OFL 1.1 and vendored in
 * assets/brand/fonts with their licences. The client sets Bahnschrift and Cascadia Mono
 * from the system; Bahnschrift cannot be redistributed, and Barlow is the open grotesk
 * cut closest to it (both descend from DIN 1451), so a card reads as the same family
 * without depending on a Windows font the renderer may not have.
 */
const FACES = [
  { family: "Apogee Display", weight: 400, file: "barlow-latin-400-normal.woff2" },
  { family: "Apogee Display", weight: 500, file: "barlow-latin-500-normal.woff2" },
  { family: "Apogee Display", weight: 600, file: "barlow-latin-600-normal.woff2" },
  { family: "Apogee Mono", weight: 400, file: "cascadia-mono-latin-400-normal.woff2" },
  { family: "Apogee Mono", weight: 600, file: "cascadia-mono-latin-600-normal.woff2" },
];

/**
 * @font-face rules for the faces an SVG actually sets, inlined as data URIs, so the file
 * renders the same in a browser, on GitHub and in an image viewer with no fonts installed.
 * Only the weights used are embedded: each is about 22 KB.
 */
export function fontCss(svgBody: string): string {
  const used = FACES.filter((f) => {
    const fam = f.family === "Apogee Mono" ? "Apogee Mono" : "Apogee Display";
    const re = new RegExp(`font-family="'${fam}'[^"]*"[^>]*font-weight="${f.weight}"`);
    return re.test(svgBody);
  });
  return used
    .map((f) => {
      const b64 = readFileSync(join(root, "assets", "brand", "fonts", f.file)).toString("base64");
      return `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:normal;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
    })
    .join("");
}

/** Put the @font-face rules an SVG needs into its <defs>, creating one if it has none. */
export function withFonts(svg: string): string {
  const css = fontCss(svg);
  if (!css) return svg;
  if (svg.includes("<defs>")) return svg.replace("<defs>", `<defs><style>${css}</style>`);
  return svg.replace(/(<svg\b[^>]*>)/, `$1<defs><style>${css}</style></defs>`);
}

// ------------------------------------------------------------------ rasterising

export interface RasterJob {
  /** The drawn SVG, fonts embedded. */
  svg: string;
  /** Where the fitted SVG is written, if it is kept. */
  svgOut?: string;
  pngOut: string;
  width: number;
  height: number;
  /** Shrink-wrap the viewBox to the drawing plus this many units, then scale to `width`. */
  trim?: number;
}

/**
 * Render SVGs to PNG in an offscreen Electron window, and fail on text that overruns.
 *
 * Electron rather than an image library because it is already a dependency, it lays
 * type out with the same engine the client uses, and it runs FIT_TEXT_SCRIPT against the
 * real font metrics, which nothing in Node can do without a font parser.
 */
export function rasterize(jobs: RasterJob[], label: string): void {
  const dir = join(root, ".cache", "brand", "jobs");
  mkdirSync(dir, { recursive: true });
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const file = join(dir, `${label}.json`);
  writeFileSync(file, JSON.stringify(jobs));
  const r = spawnSync(electron, [join(root, "tools", "brand", "rasterize.cjs"), file], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`rasterising ${label} failed (${relative(root, file)})`);
    process.exit(r.status ?? 1);
  }
}

export function ensureDir(p: string): string {
  mkdirSync(dirname(p), { recursive: true });
  return p;
}
