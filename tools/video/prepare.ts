/**
 * Film-time inputs the scenes need besides the preview, written into .cache/video/:
 *
 *   landing.html             the challenge-link landing page, rendered by
 *                            src/core/social/landing.ts with build:site's inputs (the
 *                            palette from cosmic.css, data/site.json, the bundled
 *                            landingClient.ts), so the scene films the page a link lands on
 *   cards/daily-*.png        the Daily's share card in both shapes, drawn by the brand kit's
 *                            own path (anyCardSvg, fonts embedded, FIT_TEXT_SCRIPT, the
 *                            Electron rasteriser) from the record in social.json, which is
 *                            the card the Daily screen's "Share image" panel shows
 *
 *   npx tsx tools/video/prepare.ts       (make.mjs runs it after the preview)
 *
 * Nothing here is committed: both are rebuilt from source on every run, like the preview.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

import { MARK_PATH, FIT_TEXT_SCRIPT, SHARE_CARD_SIZES, type CardLayout } from "../../src/core/brand/shareCard.ts";
import { anyCardSvg } from "../../src/core/brand/mechanicCards.ts";
import { palettes } from "../../src/core/brand/palette.ts";
import { dailyCardInput, type CardContext, type DailyRecord } from "../../src/core/brand/shareInput.ts";
import { renderLanding } from "../../src/core/social/landing.ts";
import { emblem, rasterize, root, tokens, withFonts } from "../brand/kit.ts";

const cache = join(root, ".cache", "video");
mkdirSync(join(cache, "cards"), { recursive: true });

// ---- the landing page: build:site's renderLanding call, written somewhere else --------

const cosmic = readFileSync(join(root, "src", "app", "renderer", "cosmic.css"), "utf8");
const rootBlock = /:root\s*\{([^}]*)\}/.exec(cosmic)?.[1];
if (!rootBlock) throw new Error("cosmic.css has no :root block");
const palette: Record<string, string> = {};
for (const m of rootBlock.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) palette[m[1]] = m[2].trim();
delete palette.font;
delete palette.display;
const config = JSON.parse(readFileSync(join(root, "data", "site.json"), "utf8")) as { downloadUrl: string; sourceUrl: string };
const script = (await build({
  entryPoints: [join(root, "src", "core", "social", "landingClient.ts")],
  bundle: true, write: false, format: "iife", target: "es2020", minify: true, legalComments: "none",
})).outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
writeFileSync(join(cache, "landing.html"), renderLanding({
  downloadUrl: config.downloadUrl, sourceUrl: config.sourceUrl, homeHref: "../", palette, script, markPath: MARK_PATH,
}));
console.log("wrote .cache/video/landing.html");

// ---- the Daily's share card ----------------------------------------------------------

const social = JSON.parse(readFileSync(join(root, "tools", "video", "social.json"), "utf8")) as { dailyRecord: DailyRecord; cardContext: CardContext };
const input = dailyCardInput(social.dailyRecord, social.cardContext);
if ("refused" in input) throw new Error(`the daily card was refused: ${input.refused}`);
const dark = palettes(tokens).dark;
const layouts: CardLayout[] = ["landscape", "portrait"];
rasterize(layouts.map((layout) => ({
  svg: withFonts(anyCardSvg(input, { layout, palette: dark, emblem })).replace("</svg>", `<script type="text/fit">${FIT_TEXT_SCRIPT}</script></svg>`),
  pngOut: join(cache, "cards", `daily-${layout}.png`),
  width: SHARE_CARD_SIZES[layout].width,
  height: SHARE_CARD_SIZES[layout].height,
})), "video-cards");
console.log("wrote .cache/video/cards/daily-landscape.png, daily-portrait.png");
