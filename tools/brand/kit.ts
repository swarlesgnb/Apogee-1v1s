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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { emblemFrom, fontCss as fontCssFrom, readTokens, sliceBadge, TOKEN_SHEETS, tokenCss, withFonts as withFontsFrom } from "../../src/core/brand/clientSources.ts";
import type { BrandTokens } from "../../src/core/brand/palette.ts";
import type { TextChecks } from "./checks.ts";
import { loadRankTheme, type RankTier } from "../../src/core/ranks/apogeeRanks.ts";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const read = (p: string) => readFileSync(join(root, p), "utf8");

// ------------------------------------------------------------------ tokens

const html = read("src/app/renderer/index.html");
const css = tokenCss(html, TOKEN_SHEETS.map((f) => read(`src/app/renderer/${f}`)));

export const tokens: BrandTokens = readTokens(css);

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

/**
 * The client's insignia for a tier, in a given ink: badge() sliced out of renderer.js by
 * clientSources.ts, the same slice the app's own share card makes from its bundled copy.
 */
export const emblem = emblemFrom(sliceBadge(read("src/app/renderer/renderer.js")));

// ------------------------------------------------------------------ fonts

const fontBase64 = (file: string) => readFileSync(join(root, "assets", "brand", "fonts", file)).toString("base64");

/** The card faces an SVG sets, inlined as data URIs; clientSources.ts says which and why. */
export function fontCss(svgBody: string): string {
  return fontCssFrom(svgBody, fontBase64);
}

/** Put the @font-face rules an SVG needs into its <defs>, creating one if it has none. */
export function withFonts(svg: string): string {
  return withFontsFrom(svg, fontBase64);
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
  /** Measure every text after fitting (position, ink, what is behind it); see checks.ts. */
  report?: boolean;
  /** Strings replaced in the kept SVG only: an embedded picture swapped for its path. */
  rewrite?: [string, string][];
  /** What the measured text is held to (checks.ts). Implies `report`. */
  checks?: TextChecks;
}

/** One <text> as the rasteriser measured it, in output pixels. */
export interface TextMetric {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Font size in output pixels, after fitting. */
  size: number;
  weight: number;
  fill: string;
  opacity: number;
  /** The least legible pixel behind the text (3rd percentile), when it sits on a drawn ground. */
  bg?: string;
}

/**
 * Render SVGs to PNG in an offscreen Electron window, and fail on text that overruns.
 *
 * Electron rather than an image library because it is already a dependency, it lays
 * type out with the same engine the client uses, and it runs FIT_TEXT_SCRIPT against the
 * real font metrics, which nothing in Node can do without a font parser.
 */
export function rasterize(jobs: RasterJob[], label: string): void {
  const r = rasterizeReport(jobs, label);
  if (!r.ok) process.exit(1);
}

/**
 * The same, without exiting: whether every job rendered cleanly, and the text measured in
 * each job that asked for a report (null for the rest).
 */
export function rasterizeReport(jobs: RasterJob[], label: string): { ok: boolean; reports: (TextMetric[] | null)[] } {
  const dir = join(root, ".cache", "brand", "jobs");
  mkdirSync(dir, { recursive: true });
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const file = join(dir, `${label}.json`);
  const reportFile = file.replace(/\.json$/, ".report.json");
  rmSync(reportFile, { force: true });
  writeFileSync(file, JSON.stringify(jobs));
  // Chromium refuses to start as root with its sandbox on (a Linux container or CI box);
  // the pages drawn here are our own SVGs, with no network and no remote content.
  const sandbox = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const r = spawnSync(electron, [...sandbox, join(root, "tools", "brand", "rasterize.cjs"), file], { stdio: "inherit" });
  const ok = r.status === 0;
  if (!ok) console.error(`rasterising ${label} failed (${relative(root, file)})`);
  if (!existsSync(reportFile)) return { ok, reports: jobs.map(() => null) };
  const reports = JSON.parse(readFileSync(reportFile, "utf8")) as (TextMetric[] | null)[];
  rmSync(reportFile);
  return { ok, reports };
}

export function ensureDir(p: string): string {
  mkdirSync(dirname(p), { recursive: true });
  return p;
}
