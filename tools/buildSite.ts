/**
 * Write site/index.html, the public page, from the season.
 *
 *   npm run build:site
 *
 * The page is one self-contained file for any static host. What goes on it and why is in
 * src/core/report/site.ts; the only inputs typed by hand are in data/site.json.
 *
 * Three things are read out of the client rather than restated, so the page is the app a
 * visitor then downloads: the palette (the first :root block of cosmic.css), each
 * category's mark and ink (DISCIPLINES in renderer.js, a plain script nothing can import),
 * and the stats parser, which is bundled into the page whole. A category with no mark
 * fails the build instead of rendering blank.
 *
 * A share code keyed by a name the season does not produce fails the build too: a renamed
 * playlist would otherwise leave its code off the page with nothing to say so. Playlists
 * still waiting for a code are listed, not refused, because the page is worth publishing
 * before every playlist is on the Workshop.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { MIN_RUNS_TO_QUEUE } from "../src/core/match/eligibility.ts";
import { renderSite, type Mark, type SiteConfig } from "../src/core/report/site.ts";
import { practicePlaylists } from "../src/core/season/practice.ts";
import { loadSeason } from "../src/core/season/season.ts";
import { renderLanding } from "../src/core/social/landing.ts";
import { MARK_PATH } from "../src/core/brand/shareCard.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const renderer = join(root, "src", "app", "renderer");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const season = loadSeason();
const config = JSON.parse(readFileSync(join(root, "data", "site.json"), "utf8")) as SiteConfig;

// ---- palette ----------------------------------------------------------------------------

const cosmic = readFileSync(join(renderer, "cosmic.css"), "utf8");
const rootBlock = /:root\s*\{([^}]*)\}/.exec(cosmic)?.[1] ?? fail("cosmic.css has no :root block");
const palette: Record<string, string> = {};
for (const m of rootBlock.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) palette[m[1]] = m[2].trim();
// The page's own display and body faces carry fallbacks for machines without Windows fonts.
delete palette.font;
delete palette.display;
for (const need of ["ground", "panel", "well", "card", "sunk", "brand", "brand-ink", "ink", "ink-dim", "rule"]) {
  if (!palette[need]) fail(`cosmic.css :root has no --${need}, which the page is built on`);
}

// ---- category marks ---------------------------------------------------------------------

const rendererJs = readFileSync(join(renderer, "renderer.js"), "utf8");
const marks: Record<string, Mark> = {};
for (const m of rendererJs.matchAll(/"([^"]+)":\s*\{\s*key:\s*"[^"]+",\s*ink:\s*"(#[0-9a-fA-F]{3,8})",[^}]*?path:\s*'<path d="([^"]+)"\/>'\s*\}/g)) {
  marks[m[1]] = { ink: m[2], path: m[3] };
}
const unmarked = season.categories.filter((c) => !marks[c.name]).map((c) => c.name);
if (unmarked.length) fail(`renderer.js DISCIPLINES has no mark for: ${unmarked.join(", ")}`);

// ---- share codes ------------------------------------------------------------------------

const names = new Set(practicePlaylists(season).map((p) => p.name));
const unknown = Object.keys(config.shareCodes).filter((n) => !names.has(n));
if (unknown.length) {
  fail(
    `data/site.json has share codes for playlists ${season.name} does not produce:\n  ` +
      `${unknown.join("\n  ")}\nthe names it does produce:\n  ${[...names].join("\n  ")}`,
  );
}

// ---- script -----------------------------------------------------------------------------

const bundled = await build({
  entryPoints: [join(root, "src", "core", "report", "siteClient.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "none",
});
// Inlined into a <script>, so a literal closing tag in the bundle would end it early.
const script = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

// ---- write ------------------------------------------------------------------------------

const html = renderSite({ season, config, minRunsToQueue: MIN_RUNS_TO_QUEUE, palette, marks, script });
const out = join(root, "site", "index.html");
mkdirSync(join(root, "site"), { recursive: true });
writeFileSync(out, html, "utf8");

// ---- the challenge-link landing (site/c/index.html) -----------------------------------
// Where every https challenge link a post carries lands; see src/core/social/landing.ts.
const landingScript = (await build({
  entryPoints: [join(root, "src", "core", "social", "landingClient.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "none",
})).outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const landing = renderLanding({
  downloadUrl: config.downloadUrl,
  sourceUrl: config.sourceUrl,
  homeHref: "../",
  palette,
  script: landingScript,
  markPath: MARK_PATH,
});
mkdirSync(join(root, "site", "c"), { recursive: true });
writeFileSync(join(root, "site", "c", "index.html"), landing, "utf8");
console.log(`wrote site/c/index.html: the challenge-link landing, ${Math.round(landing.length / 1024)} KB`);

const liveLookup = season.scenarios.some((s) => s.leaderboardId);
const waiting = [...names].filter((n) => !config.shareCodes[n]?.trim());
console.log(
  `wrote site/index.html: ${season.scenarios.length} scenarios, ${names.size} playlists, ` +
    `${Math.round(html.length / 1024)} KB`,
);
console.log(
  liveLookup
    ? "KovaaK's username lookup: on"
    : "KovaaK's username lookup: off until a season scenario has a KovaaK's board (recut:season fills leaderboardId)",
);
if (waiting.length) {
  console.log(`${waiting.length} of ${names.size} playlists have no share code yet (data/site.json):`);
  for (const n of waiting) console.log(`  ${n}`);
}
