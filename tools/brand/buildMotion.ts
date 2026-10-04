/**
 * Title cards and lower thirds for each new mechanic, for the video pipeline.
 *
 *   npm run brand:motion        this alone (npm run brand runs it too)
 *
 *   assets/brand/motion/<id>/title-16x9.svg|png    1920x1080, the card's resting frame
 *   assets/brand/motion/<id>/title-9x16.svg|png    1080x1920, the same for the vertical cuts
 *   assets/brand/motion/<id>/lower-third.svg|png   1920x1080, transparent, an opaque plate bottom left
 *   tools/video/mechanics.json                     ready-made shots.json scenes and captions
 *
 * Two ways in, for whoever cuts the next video:
 *
 * - Animated: put a scene from tools/video/mechanics.json into shots.json. It is an
 *   ordinary card.html card with one new field, `glyph`, which record.cjs fills with the
 *   mechanic's emblem from assets/brand/mechanics, so the card animates the way every
 *   other card in the trailer does. The `caption` entry is a stage.js caption step for
 *   the same words over app footage.
 * - Still: the PNGs here are card.html's resting frame drawn as SVG (the same ground glow,
 *   orbits, type sizes in vmin and the brand rule), for an editor or an ffmpeg overlay.
 *   The lower third is transparent around its plate.
 *
 * The words are mechanics.ts's name and one line, so a card, a share card and a poster can
 * never describe a mechanic three ways.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { MECHANICS, mechanicEmblemSvg, type Mechanic } from "../../src/core/brand/mechanics.ts";
import { palettes } from "../../src/core/brand/palette.ts";
import { placeSvg } from "../../src/core/brand/shareCard.ts";
import { renderChecked } from "./checks.ts";
import { horizontal, rng, svgDoc, t, withFit } from "./draw.ts";
import { ensureDir, root, tokens, withFonts, type RasterJob } from "./kit.ts";

const D = palettes(tokens).dark;
const OUT = join(root, "assets", "brand", "motion");
export const VIDEO_MECHANICS = join(root, "tools", "video", "mechanics.json");

/** card.html's sky at rest: the corner glow, the low brand glow, three orbits, the stars. */
function sky(W: number, H: number, portrait: boolean): string {
  const m = Math.min(W, H);
  const cx = W * (portrait ? 0.5 : 0.72);
  const cy = H * (portrait ? 0.34 : 0.5);
  const deg = (-0.42 * 180) / Math.PI + 3 * 0.018 * (180 / Math.PI);
  let s = `<defs>` +
    `<radialGradient id="glow" cx="${W * 0.86}" cy="${H * 0.08}" r="${Math.max(W, H) * 0.75}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#324452" stop-opacity=".42"/><stop offset="1" stop-color="#324452" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="low" cx="${W * 0.1}" cy="${H * 1.05}" r="${m * 0.9}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${D.brand}" stop-opacity=".07"/><stop offset="1" stop-color="${D.brand}" stop-opacity="0"/></radialGradient>` +
    `</defs><rect width="${W}" height="${H}" fill="${D.ground}"/><rect width="${W}" height="${H}" fill="url(#glow)"/><rect width="${W}" height="${H}" fill="url(#low)"/>`;
  s += `<g transform="translate(${cx} ${cy}) rotate(${deg.toFixed(2)})">`;
  for (let i = 0; i < 3; i++) {
    const rx = m * (0.42 + i * 0.2);
    const ry = m * (0.15 + i * 0.07);
    s += `<ellipse rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="#bad3e9" stroke-opacity="${(0.09 - i * 0.02).toFixed(2)}" stroke-width="1.2"/>`;
    const a = 3 * (0.16 - i * 0.04) + i * 2.1;
    s += `<circle cx="${(Math.cos(a) * rx).toFixed(1)}" cy="${(Math.sin(a) * ry).toFixed(1)}" r="${(m * (0.005 - i * 0.001)).toFixed(1)}" fill="${i === 0 ? D.brand : "#abc5dc"}" fill-opacity="${i === 0 ? 0.8 : 0.55}"/>`;
  }
  s += `</g>`;
  const r = rng(9173);
  for (let i = 0; i < 260; i++) {
    const x = r() * W;
    const y = r() * H;
    const z = 0.2 + r() * 0.8;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(z * 1.9).toFixed(2)}" height="${(z * 1.9).toFixed(2)}" fill="#abc5dc" fill-opacity="${(0.25 + 0.45 * z * 0.85).toFixed(2)}"/>`;
  }
  return s;
}

/** A title card's resting frame: emblem and eyebrow, the name, the brand rule, the line. */
function title(m: Mechanic, portrait: boolean): string {
  const W = portrait ? 1080 : 1920;
  const H = portrait ? 1920 : 1080;
  const vmin = Math.min(W, H) / 100;
  const pad = (portrait ? 8 : 11) * vmin;
  const titleSize = (portrait ? 11 : 10) * vmin;
  const subSize = (portrait ? 4.1 : 3.1) * vmin;
  const emblemSize = 13 * vmin;
  // card.html centres the block; these are its rows, top to bottom, at rest.
  const blockH = emblemSize + 4 * vmin + titleSize * 1.02 + 4.4 * vmin + 0.35 * vmin + 3.6 * vmin + subSize * 1.35 * 2;
  let y = (H - blockH) / 2;
  let b = sky(W, H, portrait);
  b += placeSvg(mechanicEmblemSvg(m.id, D.brand), pad, y, emblemSize, emblemSize);
  const ex = pad + emblemSize + 2.4 * vmin;
  b += `<path d="M${ex} ${y + emblemSize / 2 - 1.7 * vmin}v${3.4 * vmin}" stroke="#bad3e9" stroke-opacity=".22"/>`;
  b += t("New in Apogee", ex + 2.4 * vmin, y + emblemSize / 2 + 0.75 * vmin, { size: +(2.1 * vmin).toFixed(1), fill: D.inkDim, mono: true, tracking: 0.32, upper: true });
  y += emblemSize + 4 * vmin;
  b += t(m.name, pad - 0.05 * titleSize, y + titleSize * 0.82, { size: +titleSize.toFixed(1), fill: D.ink, weight: 600, tracking: -0.03, fit: W - pad * 2 });
  y += titleSize * 1.02 + 4.4 * vmin;
  b += `<rect x="${pad}" y="${y.toFixed(1)}" width="${(14 * vmin).toFixed(1)}" height="${(0.35 * vmin).toFixed(1)}" fill="${D.brand}"/>`;
  y += 0.35 * vmin + 3.6 * vmin;
  // The line wraps where card.html's 80vmin measure would wrap it.
  const words = m.line.split(" ");
  const perLine = portrait ? 30 : 46;
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > perLine) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  lines.forEach((l, i) => {
    b += t(l, pad, y + subSize * (0.95 + i * 1.35), { size: +subSize.toFixed(1), fill: D.inkMid, weight: 400, fit: 80 * vmin + (portrait ? 0 : 40 * vmin) });
  });
  // card.html's foot row, with the lockup in place of a caption.
  b += horizontal(D, pad, H - 7.5 * vmin, +(2.6 * vmin).toFixed(1));
  b += t("Ranked 1v1 for KovaaK's", W - pad, H - 7.5 * vmin, { size: +(1.9 * vmin).toFixed(1), fill: D.inkDim, mono: true, anchor: "end", tracking: 0.22, upper: true });
  return svgDoc(W, H, b, `${m.name}: ${m.line}`);
}

/** A lower third: an opaque plate bottom left, the rest of the frame transparent. */
function lowerThird(m: Mechanic): string {
  const W = 1920;
  const H = 1080;
  const x = 96;
  const y = 846;
  const w = 1000;
  const h = 150;
  let b = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${D.ground}"/>`;
  b += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="10" fill="none" stroke="#bad3e9" stroke-opacity=".22"/>`;
  b += `<rect x="${x}" y="${y + 24}" width="4" height="${h - 48}" rx="2" fill="${D.brand}"/>`;
  b += placeSvg(mechanicEmblemSvg(m.id, D.brand), x + 30, y + 23, 104, 104);
  b += t("New in Apogee", x + 160, y + 46, { size: 15, fill: D.brand, mono: true, weight: 600, tracking: 0.24, upper: true });
  b += t(m.name, x + 158, y + 94, { size: 46, fill: D.ink, weight: 600, tracking: -0.02, fit: w - 190 });
  b += t(m.line, x + 160, y + 128, { size: 21, fill: D.inkMid, weight: 400, fit: w - 190 });
  return svgDoc(W, H, b, `${m.name}: ${m.line}`);
}

/** The scenes and captions for shots.json, generated so the words stay mechanics.ts's. */
export function videoScenes(): string {
  const scenes = MECHANICS.map((m) => ({
    id: m.id,
    name: m.name,
    line: m.line,
    card: { glyph: m.id, eyebrow: "New in Apogee", title: [m.name], sub: [m.line], rule: true },
    scene: { id: `${m.id}-title`, kind: "card", seconds: 3.2, card: { glyph: m.id, eyebrow: "New in Apogee", title: [m.name], sub: [m.line] } },
    caption: { do: "caption", index: "New", text: m.name, sub: m.line },
    stills: {
      title16x9: `assets/brand/motion/${m.id}/title-16x9.png`,
      title9x16: `assets/brand/motion/${m.id}/title-9x16.png`,
      lowerThird: `assets/brand/motion/${m.id}/lower-third.png`,
    },
  }));
  return JSON.stringify({
    about: "Generated by npm run brand:motion from src/core/brand/mechanics.ts; do not edit. Each `scene` drops into a cut's scenes in shots.json (card.html draws `glyph` from assets/brand/mechanics/emblems/dark). `caption` is a stage.js step for app footage. `stills` are the same cards as PNGs. Only add a scene for a mechanic that has merged.",
    mechanics: scenes,
  }, null, 2) + "\n";
}

export function motionJobs(out = OUT): RasterJob[] {
  const jobs: RasterJob[] = [];
  const emit = (rel: string, svg: string, width: number, height: number, inset: number, contrast = true) => {
    const base = join(out, rel);
    jobs.push({ svg: withFit(withFonts(svg)), svgOut: ensureDir(`${base}.svg`), pngOut: `${base}.png`, width, height, checks: { inset, contrast } });
  };
  for (const m of MECHANICS) {
    emit(`${m.id}/title-16x9`, title(m, false), 1920, 1080, 64);
    emit(`${m.id}/title-9x16`, title(m, true), 1080, 1920, 64);
    emit(`${m.id}/lower-third`, lowerThird(m), 1920, 1080, 64);
  }
  return jobs;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(VIDEO_MECHANICS, videoScenes());
  const jobs = motionJobs();
  console.log(`motion: ${jobs.length} images, and tools/video/mechanics.json`);
  const r = renderChecked(jobs, "motion");
  if (r.failures.length) {
    console.error(r.failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`  ${r.measured} checked for margins, overlap and contrast` + (r.worst ? `; lowest contrast ${r.worst.ratio.toFixed(2)}:1 ("${r.worst.text}")` : ""));
}
