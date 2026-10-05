/**
 * The marketing kit, into assets/brand/marketing: one composition per place Apogee is
 * posted, each at the size that place asks for.
 *
 *   npm run brand:marketing        compose from the committed product shots
 *   npm run brand:shots            photograph the real renderer again first (productShots.cjs)
 *
 *   og-1200x630                Open Graph link preview; also fine as GitHub's social preview
 *   x-header-1500x500          X/Twitter header, clear of the avatar and the mobile crop
 *   discord-icon-512           Discord server icon, everything inside the round crop
 *   discord-banner-960x540     Discord server banner, clear of the server name overlay
 *   youtube-thumbnail-*        the thumbnail template, rendered twice: a product shot, a mechanic
 *   announcement-1200x1200     a square post for Reddit or a Discord announcement
 *   whats-new-1080x1350        the new mechanics, one tile each
 *   readme-hero-1280x640       a README hero with a real product frame
 *
 * The rules: taglines are statements the product makes true ("Scores read from your stats
 * folder, never typed in"), no superlatives, and no picture of UI that does not exist.
 * Product frames are photographs of the renderer (shots/); the mechanics being built tonight
 * appear only as their glyphs and their one line, never as invented screens.
 *
 * Each SVG keeps its product shot as a relative link (shots/queue.png) rather than a second
 * embedded copy of the image; the PNG beside it is complete.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { MECHANICS, mechanicEmblemSvg, mechanicIconSvg, type MechanicId } from "../../src/core/brand/mechanics.ts";
import { palettes, rankInk, type BrandPalette } from "../../src/core/brand/palette.ts";
import { placeSvg } from "../../src/core/brand/shareCard.ts";
import { renderChecked, type TextChecks } from "./checks.ts";
import { ascent, corners, ground, horizontal, mark, stars, svgDoc, t, withFit } from "./draw.ts";
import { emblem, ensureDir, root, tiers, tokens, withFonts, type RasterJob } from "./kit.ts";

const P = palettes(tokens);
const D = P.dark;
const OUT = join(root, "assets", "brand", "marketing");
export const SHOTS_DIR = join(OUT, "shots");

/**
 * The mechanics a poster may name. The fleet brief fixes seven working names; the arena
 * branch built Crowns and Live race, not Draft, so Draft has its glyph and no poster. Keep
 * this list to what actually merged, and every poster follows it on the next run.
 */
export const FEATURED: MechanicId[] = ["shadow", "flag", "daily", "link", "crown", "race"];

/** Statements the product already makes true. Nothing here claims a mechanic. */
export const TAGLINES = {
  what: "Ranked 1v1 for KovaaK's",
  scores: "Scores read from your stats folder, never typed in",
  rule: "Beat your own baseline by more than they beat theirs",
  where: "Free for Windows",
  repo: "github.com/swarlesgnb/Apogee-1v1s",
} as const;

// ------------------------------------------------------------------ product frames

const SHOT_W = 1440;
const SHOT_H = 900;
const shotUri = new Map<string, string>();
function shotData(name: string): string {
  if (!shotUri.has(name)) {
    const file = join(SHOTS_DIR, `${name}.png`);
    if (!existsSync(file)) throw new Error(`no product shot ${name}: run npm run brand:shots`);
    shotUri.set(name, `data:image/png;base64,${readFileSync(file).toString("base64")}`);
  }
  return shotUri.get(name) as string;
}

let clipN = 0;
/**
 * A photographed screen in a plain frame: a hairline and a small radius, no shadow and no
 * glass, as the theme has it. `crop` is the part of the 1440x900 shot to show.
 */
function frame(p: BrandPalette, name: string, x: number, y: number, w: number, crop: [number, number, number, number] = [0, 0, SHOT_W, SHOT_H], radius = 10): string {
  const [cx, cy, cw, ch] = crop;
  const h = Math.round((w * ch) / cw);
  const id = `frame${++clipN}`;
  return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}"/></clipPath></defs>` +
    `<g clip-path="url(#${id})"><svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${cx} ${cy} ${cw} ${ch}" preserveAspectRatio="xMidYMid slice"><image href="${shotData(name)}" width="${SHOT_W}" height="${SHOT_H}"/></svg></g>` +
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${radius}" fill="none" stroke="${p.theme === "dark" ? "#bad3e9" : p.ink}" stroke-opacity=".28"/>`;
}

function shotsUsed(svg: string): [string, string][] {
  return [...shotUri.entries()].filter(([, uri]) => svg.includes(uri)).map(([name, uri]) => [uri, `shots/${name}.png`]);
}

/** A mechanic's icon placed at x,y, `s` px, in `ink`. */
function icon(id: MechanicId, x: number, y: number, s: number, ink: string): string {
  return placeSvg(mechanicIconSvg(id).replace("<svg ", `<svg style="color:${ink}" `), x, y, s, s);
}

/** Greedy word wrap by an average glyph width; the fit script still catches an overrun. */
function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of s.split(" ")) {
    if (line && (line + " " + w).length > max) {
      out.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out;
}

// ------------------------------------------------------------------ compositions

function og(): string {
  const W = 1200;
  const H = 630;
  let b = ground(D, W, H, W * 0.95, 0) + stars(D, W, H, 60, 31, [[40, 60, 560, 520], [600, 110, 600, 440]]) + corners(D, W, H, 22, 14);
  b += horizontal(D, 72, 168, 64);
  b += t(TAGLINES.what, 74, 262, { size: 46, fill: D.ink, weight: 600, tracking: -0.02, fit: 500 });
  b += t("Scores read from your stats folder,", 74, 312, { size: 24, fill: D.inkMid, weight: 400, fit: 500 });
  b += t("never typed in.", 74, 344, { size: 24, fill: D.inkMid, weight: 400, fit: 500 });
  b += t("A round goes to whoever beats", 74, 420, { size: 15, fill: D.inkDim, mono: true, fit: 500 });
  b += t("their own baseline by more.", 74, 444, { size: 15, fill: D.inkDim, mono: true, fit: 500 });
  b += `<path d="M74 500H330" stroke="#bad3e9" stroke-opacity=".2"/>`;
  b += t(`${TAGLINES.where} · ${TAGLINES.repo}`, 74, 540, { size: 14, fill: D.inkDim, mono: true, tracking: 0.04, fit: 500 });
  b += frame(D, "queue", 610, 136, 680, [210, 0, 1230, 900]);
  return svgDoc(W, H, b, `Apogee: ${TAGLINES.what}`);
}

function xHeader(): string {
  const W = 1500;
  const H = 500;
  let b = ground(D, W, H, W * 0.9, 0) + stars(D, W, H, 90, 37, [[380, 130, 560, 240], [900, 40, 560, 420]]) + corners(D, W, H, 22, 14);
  // Low enough that Supernova's crown survives the phone crop of the top edge.
  b += ascent(D, { cx: 1170, cy: 290, rx: 260, ry: 138, tilt: -16, small: 40, large: 88 });
  b += horizontal(D, 420, 236, 76);
  b += t(TAGLINES.what, 424, 296, { size: 30, fill: D.ink, weight: 500, fit: 470 });
  b += t(`${TAGLINES.scores}.`, 424, 334, { size: 15, fill: D.inkDim, mono: true, fit: 470 });
  return svgDoc(W, H, b, `Apogee: ${TAGLINES.what}`);
}

function discordIcon(): string {
  const W = 512;
  let b = ground(D, W, W, W * 0.85, W * 0.1);
  // A faint orbit around the mark with its body at apogee: invisible at 48px, where only
  // the mark has to read, and there when the icon is shown large.
  b += `<ellipse cx="256" cy="262" rx="196" ry="92" transform="rotate(-16 256 262)" fill="none" stroke="#bad3e9" stroke-opacity=".2" stroke-width="2"/>`;
  b += `<circle cx="${(256 + 196 * Math.cos((-16 * Math.PI) / 180)).toFixed(1)}" cy="${(262 + 196 * Math.sin((-16 * Math.PI) / 180)).toFixed(1)}" r="7" fill="${D.brand}"/>`;
  b += mark(D, 256 - 150, 256 - 156, 300);
  return svgDoc(W, W, b, "Apogee");
}

function discordBanner(): string {
  const W = 960;
  const H = 540;
  let b = ground(D, W, H, W * 0.92, H * 0.1) + stars(D, W, H, 60, 41, [[50, 300, 520, 200], [500, 60, 440, 420]]) + corners(D, W, H, 22, 14);
  b += ascent(D, { cx: 706, cy: 300, rx: 210, ry: 128, tilt: -16, small: 36, large: 84 });
  b += horizontal(D, 64, 412, 84);
  b += t(TAGLINES.what, 68, 466, { size: 28, fill: D.ink, weight: 500, fit: 440 });
  return svgDoc(W, H, b, `Apogee: ${TAGLINES.what}`);
}

export interface ThumbnailSpec {
  kicker: string;
  title: [string, string];
  /** A product shot from shots/, or a mechanic's emblem; never a mock-up. */
  shot?: string;
  glyph?: MechanicId;
}

/**
 * The YouTube thumbnail template. Two title lines at a size that still reads at 168px wide
 * (YouTube's smallest listing), the lockup small, and the right half for a product shot or
 * an emblem. Clear of the duration badge YouTube lays over the bottom right.
 */
export function thumbnail(spec: ThumbnailSpec): string {
  const W = 1280;
  const H = 720;
  let b = ground(D, W, H, W * 0.95, 0) + stars(D, W, H, 70, 43, [[40, 40, 640, 640], [640, 60, 640, 600]]) + corners(D, W, H, 24, 16);
  b += horizontal(D, 72, 112, 44);
  b += t(spec.kicker, 76, 268, { size: 26, fill: D.brand, mono: true, weight: 600, tracking: 0.16, upper: true, fit: 560 });
  b += t(spec.title[0], 70, 388, { size: 108, fill: D.ink, weight: 600, tracking: -0.03, fit: 600 });
  b += t(spec.title[1], 70, 506, { size: 108, fill: D.brand, weight: 600, tracking: -0.03, fit: 600 });
  if (spec.shot) b += frame(D, spec.shot, 700, 150, 720, [210, 60, 1230, 840], 12);
  if (spec.glyph) {
    const m = MECHANICS.find((x) => x.id === spec.glyph);
    b += `<ellipse cx="960" cy="330" rx="290" ry="96" transform="rotate(-14 960 330)" fill="none" stroke="#bad3e9" stroke-opacity=".22"/>`;
    b += placeSvg(mechanicEmblemSvg(spec.glyph, D.brand), 815, 185, 290, 290);
    if (m) {
      b += t(m.name, 960, 548, { size: 48, fill: D.ink, weight: 600, anchor: "middle", fit: 480 });
      b += t(m.line, 960, 590, { size: 17, fill: D.inkMid, mono: true, anchor: "middle", fit: 500 });
    }
  }
  return svgDoc(W, H, b, `${spec.title.join(" ")}: Apogee`);
}

function announcement(): string {
  const W = 1200;
  const H = 1200;
  let b = ground(D, W, H, W * 0.95, 0) + stars(D, W, H, 90, 47, [[60, 60, 1080, 1080]]) + corners(D, W, H, 26, 18);
  b += horizontal(D, 80, 150, 60);
  b += t(TAGLINES.what, 82, 262, { size: 64, fill: D.ink, weight: 600, tracking: -0.025, fit: 1040 });
  b += frame(D, "queue", 80, 312, 1040);
  const facts: [string, string, string][] = [
    ["Read, not typed", "Scores come from your", "KovaaK's stats folder."],
    ["Your baseline", "Each round goes to whoever", "beats their own by more."],
    ["Three scenarios", "One category, one opponent,", "settled by the server."],
  ];
  facts.forEach(([h, a, c], i) => {
    const x = 80 + i * 360;
    b += `<path d="M${x} 988H${x + 320}" stroke="${D.brand}" stroke-opacity=".7" stroke-width="2"/>`;
    b += t(h, x, 1030, { size: 26, fill: D.ink, weight: 600, fit: 330 });
    b += t(a, x, 1064, { size: 16, fill: D.inkMid, weight: 400, fit: 330 });
    b += t(c, x, 1088, { size: 16, fill: D.inkMid, weight: 400, fit: 330 });
  });
  b += t(`${TAGLINES.where} · ${TAGLINES.repo}`, 80, 1136, { size: 15, fill: D.inkDim, mono: true, tracking: 0.04, fit: 1040 });
  return svgDoc(W, H, b, `Apogee: ${TAGLINES.what}`);
}

function whatsNew(featured: MechanicId[]): { svg: string; h: number } {
  const W = 1080;
  const list = MECHANICS.filter((m) => featured.includes(m.id));
  const cols = 2;
  const tileW = (W - 160 - 40) / cols;
  const top = 350;
  const rows = Math.ceil(list.length / cols);
  const H = 1350;
  // The grid fills the space between the title and the foot, whatever merged: six tiles
  // get taller rows than eight.
  const tileH = Math.min(250, Math.floor((H - 140 - top - (rows - 1) * 16) / rows));
  let b = ground(D, W, H, W * 0.92, 0) + stars(D, W, H, 80, 53, [[60, 60, W - 120, H - 120]]) + corners(D, W, H, 26, 18);
  b += horizontal(D, 80, 146, 52);
  b += t("New in Apogee", 82, 232, { size: 22, fill: D.brand, mono: true, weight: 600, tracking: 0.18, upper: true });
  b += t("What's new", 78, 300, { size: 64, fill: D.ink, weight: 600, tracking: -0.025 });
  list.forEach((m, i) => {
    const x = 80 + (i % cols) * (tileW + 40);
    const y = top + Math.floor(i / cols) * (tileH + 16);
    // A lone last tile spans both columns, so the grid never ends on a hole.
    const lone = i === list.length - 1 && list.length % cols === 1;
    const w = lone ? W - 160 : tileW;
    const lines = wrap(m.line, lone ? 70 : 30).slice(0, 3);
    const block = 40 + lines.length * 26;
    const by = y + (tileH - block) / 2;
    b += `<rect x="${x}" y="${y}" width="${w}" height="${tileH}" rx="12" fill="${D.panel}" fill-opacity=".86" stroke="#bad3e9" stroke-opacity=".14"/>`;
    b += placeSvg(mechanicEmblemSvg(m.id, D.brand), x + 24, y + (tileH - 96) / 2, 96, 96);
    b += t(m.name, x + 140, by + 30, { size: 32, fill: D.ink, weight: 600, fit: w - 164 });
    lines.forEach((l, j) => {
      b += t(l, x + 140, by + 68 + j * 26, { size: 18, fill: D.inkMid, weight: 400, fit: w - 164 });
    });
  });
  b += t(`${TAGLINES.what} · ${TAGLINES.where}`, 80, H - 80, { size: 16, fill: D.inkDim, mono: true, tracking: 0.04, fit: W - 160 });
  return { svg: svgDoc(W, H, b, "What's new in Apogee"), h: H };
}

function readmeHero(): string {
  const W = 1280;
  const H = 640;
  let b = ground(D, W, H, W * 0.95, 0) + stars(D, W, H, 70, 59, [[60, 120, 560, 420], [600, 60, 680, 560]]) + corners(D, W, H, 22, 14);
  b += horizontal(D, 80, 262, 92);
  // The ladder in a row under the words, each rung a little higher than the last, as on
  // the ladder sheet: the original hero's idea, at the size the frame leaves room for.
  tiers.forEach((tier, i) => {
    const h = 34 + i * 3.4;
    const w = (h * 80) / 86;
    b += placeSvg(emblem(tier, rankInk(D, tier.color)), 84 + i * 60 + (60 - w) / 2 - 8, 548 - h - i * 4, w, h);
  });
  b += t(TAGLINES.what, 84, 338, { size: 36, fill: D.ink, weight: 500, fit: 500 });
  b += t("Queue a category · play three scenarios", 84, 386, { size: 15, fill: D.inkDim, mono: true, tracking: 0.04, fit: 500 });
  b += t("the ladder settles itself", 84, 410, { size: 15, fill: D.inkDim, mono: true, tracking: 0.04, fit: 500 });
  b += t("Season 1 ladder", 84, 584, { size: 12, fill: D.inkDim, mono: true, tracking: 0.18, upper: true });
  b += frame(D, "queue", 640, 120, 720, [210, 0, 1230, 900]);
  return svgDoc(W, H, b, `Apogee: ${TAGLINES.what}`);
}

// ------------------------------------------------------------------ jobs

const LANDSCAPE_SAFE: TextChecks = { inset: 40 };

export function marketingJobs(out = OUT): RasterJob[] {
  clipN = 0;
  const jobs: RasterJob[] = [];
  const emit = (name: string, svg: string, width: number, height: number, checks: TextChecks) => {
    const base = join(out, name);
    jobs.push({ svg: withFit(withFonts(svg)), svgOut: ensureDir(`${base}.svg`), pngOut: `${base}.png`, width, height, checks, rewrite: shotsUsed(svg) });
  };
  emit("og-1200x630", og(), 1200, 630, LANDSCAPE_SAFE);
  // X covers the bottom left with the avatar and crops the top and bottom on phones.
  emit("x-header-1500x500", xHeader(), 1500, 500, { inset: [40, 80, 40, 80], avoid: [{ name: "avatar", rect: [0, 290, 380, 210] }] });
  emit("discord-icon-512", discordIcon(), 512, 512, { circle: { cx: 256, cy: 256, r: 230 } });
  // Discord lays the server name over the top of the banner on a dark gradient.
  emit("discord-banner-960x540", discordBanner(), 960, 540, { inset: 40, avoid: [{ name: "server name", rect: [0, 0, 960, 120] }] });
  const yt: TextChecks = { inset: 48, avoid: [{ name: "duration badge", rect: [1100, 640, 180, 80] }] };
  emit("youtube-thumbnail-template-ranked", thumbnail({ kicker: "Ranked 1v1 for KovaaK's", title: ["Beat your", "baseline."], shot: "queue" }), 1280, 720, yt);
  emit("youtube-thumbnail-template-mechanic", thumbnail({ kicker: "New in Apogee", title: ["Nobody", "online?"], glyph: "shadow" }), 1280, 720, yt);
  emit("announcement-1200x1200", announcement(), 1200, 1200, { inset: 48 });
  const wn = whatsNew(FEATURED);
  emit("whats-new-1080x1350", wn.svg, 1080, wn.h, { inset: 48 });
  emit("readme-hero-1280x640", readmeHero(), 1280, 640, LANDSCAPE_SAFE);
  return jobs;
}

/** Build the preview from the current renderer and photograph it (productShots.cjs). */
export function shoot(): void {
  const preview = join(root, ".cache", "brand", "preview.html");
  const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
    const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" && cmd === "npx" });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
  };
  run("node", ["tools/buildCosmic.mjs"]);
  run("npx", ["tsx", "tools/buildUiPreview.ts"], { ...process.env, APOGEE_PREVIEW_OUT: preview });
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const sandbox = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  run(electron, [...sandbox, join(root, "tools", "brand", "productShots.cjs"), preview, SHOTS_DIR]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--shots") || !existsSync(join(SHOTS_DIR, "queue.png"))) shoot();
  const jobs = marketingJobs();
  console.log(`marketing: ${jobs.length} images`);
  const r = renderChecked(jobs, "marketing");
  if (r.failures.length) {
    console.error(r.failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`  ${r.measured} checked for safe areas, overlap and contrast` + (r.worst ? `; lowest contrast ${r.worst.ratio.toFixed(2)}:1 ("${r.worst.text}")` : ""));
}

export { icon };
