/**
 * Contact sheets of everything the kit generates, for a person to look at before it ships.
 *
 *   npm run brand:contact                      into .cache/brand/contact
 *   npm run brand:contact -- --out some/dir    somewhere else
 *
 * Reads the PNGs as they are on disk, so a sheet shows what was committed, not what a
 * generator meant to draw. Transparent pictures are laid on the ground their theme names
 * (dark on the client's ground, light on the light ground). The icons get a sheet of their
 * own at eight times their size, pixel for pixel, because "reads at 16px" is a claim about
 * pixels and a downscaled sheet cannot show them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { MECHANICS } from "../../src/core/brand/mechanics.ts";
import { palettes } from "../../src/core/brand/palette.ts";
import { esc } from "../../src/core/brand/shareCard.ts";
import { ICON_SIZES } from "./buildMechanics.ts";
import { svgDoc, t } from "./draw.ts";
import { ensureDir, rasterize, root, tokens, withFonts, type RasterJob } from "./kit.ts";

const P = palettes(tokens);
const argOut = process.argv.indexOf("--out");
const OUT = resolve(root, argOut > 0 ? process.argv[argOut + 1] : ".cache/brand/contact");

const png = (p: string) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
const size = (p: string) => {
  const b = readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)] as const;
};
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".png") ? [p] : [];
  }).sort();
}

/** A grid of pictures, each scaled to `tile` wide, labelled with its path and size. */
function grid(title: string, files: string[], tile: number, cols: number): { svg: string; w: number; h: number } {
  const pad = 32;
  const labelH = 34;
  const items = files.map((f) => {
    const [w, h] = size(f);
    const s = Math.min(1, tile / w);
    return { f, w, h, dw: Math.round(w * s), dh: Math.round(h * s) };
  });
  const rows: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  const W = pad * 2 + cols * tile + (cols - 1) * pad;
  let y = 96;
  let body = "";
  for (const row of rows) {
    const rh = Math.max(...row.map((r) => r.dh));
    row.forEach((it, i) => {
      const x = pad + i * (tile + pad);
      const light = /light/.test(relative(root, it.f));
      const g = light ? P.light : P.dark;
      body += `<rect x="${x - 1}" y="${y - 1}" width="${it.dw + 2}" height="${it.dh + 2}" fill="${g.ground}" stroke="#bad3e9" stroke-opacity=".25"/>`;
      body += `<image href="${png(it.f)}" x="${x}" y="${y}" width="${it.dw}" height="${it.dh}"/>`;
      body += t(`${relative(root, it.f).replace(/\\/g, "/").split("/").slice(-2).join("/")} · ${it.w}x${it.h}`, x, y + it.dh + 20, { size: 12, fill: P.dark.inkMid, mono: true });
    });
    y += rh + labelH + pad;
  }
  const H = y + pad;
  const head = t(title, pad, 56, { size: 28, fill: P.dark.ink, weight: 600 });
  return { svg: svgDoc(W, H, `<rect width="${W}" height="${H}" fill="#05070b"/>` + head + body, title), w: W, h: H };
}

/** Every icon at 1x and at 8x, nearest neighbour, on both grounds. */
function pixels(): { svg: string; w: number; h: number } {
  const zoom = 8;
  const pad = 28;
  const colW = ICON_SIZES.reduce((a, s) => a + s * zoom + pad, 0) + 80;
  const W = pad + colW * 2;
  const rowH = 48 * zoom + 120;
  const H = 110 + MECHANICS.length * rowH;
  let body = `<rect width="${W}" height="${H}" fill="#05070b"/>` + t("Icons pixel for pixel: 16, 24, 32, 48 px at 8x, then 1x", pad, 56, { size: 28, fill: P.dark.ink, weight: 600 });
  (["dark", "light"] as const).forEach((theme, c) => {
    const g = P[theme];
    MECHANICS.forEach((m, r) => {
      let x = pad + c * colW;
      const y = 100 + r * rowH;
      body += `<rect x="${x - 10}" y="${y - 10}" width="${colW - pad}" height="${rowH - 20}" fill="${g.ground}"/>`;
      body += t(`${m.name} · ${theme}`, x, y + 18, { size: 16, fill: g.inkMid, mono: true });
      for (const s of ICON_SIZES) {
        const f = join(root, "assets", "brand", "mechanics", "icons", theme, `${m.id}-${s}.png`);
        body += `<image href="${png(f)}" x="${x}" y="${y + 32}" width="${s * zoom}" height="${s * zoom}" style="image-rendering:pixelated"/>`;
        body += `<image href="${png(f)}" x="${x}" y="${y + 40 + s * zoom}" width="${s}" height="${s}"/>`;
        x += s * zoom + pad;
      }
    });
  });
  return { svg: svgDoc(W, H, body, "Icon pixels"), w: W, h: H };
}

const brand = join(root, "assets", "brand");
const sections: [string, () => { svg: string; w: number; h: number }][] = [
  ["1-icon-pixels", pixels],
  ["2-emblems", () => grid("Mechanic emblems, 320 px", walk(join(brand, "mechanics", "emblems")), 240, 7)],
  ["3-sheets", () => grid("Mechanic sheets", walk(brand + "/mechanics").filter((f) => /sheet-/.test(f)), 1100, 2)],
  ["4-cards-landscape", () => grid("Share cards, 1200x675", walk(join(brand, "samples")).filter((f) => /landscape/.test(f)), 900, 2)],
  ["5-cards-portrait", () => grid("Share cards, 1080x1920", walk(join(brand, "samples")).filter((f) => /portrait/.test(f)), 360, 6)],
  ["6-marketing", () => grid("Marketing kit", walk(join(brand, "marketing")).filter((f) => !/[\\/]shots[\\/]/.test(f)), 900, 2)],
  ["7-motion", () => grid("Motion: title cards and lower thirds", walk(join(brand, "motion")), 640, 3)],
  ["8-product-shots", () => grid("Product shots (the real renderer on data/snapshot.json)", walk(join(brand, "marketing", "shots")), 900, 2)],
];

const jobs: RasterJob[] = [];
for (const [name, make] of sections) {
  const { svg, w, h } = make();
  if (h < 200) continue;
  jobs.push({ svg: withFonts(svg), pngOut: ensureDir(join(OUT, `${name}.png`)), width: w, height: h });
}
console.log(`contact sheets: ${jobs.length} into ${relative(root, OUT) || OUT}`);
rasterize(jobs, "contact");
console.log(esc(jobs.map((j) => relative(root, j.pngOut)).join("\n")));
