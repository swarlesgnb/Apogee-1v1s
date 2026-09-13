/**
 * Draw the application icon: build/icon.png for the installer, and every size a store
 * page, a Discord server or a sign-up form asks for in build/icons/, with an SVG beside
 * them.
 *
 * The mark is the one the app already wears in the corner of its rail - the peak, with
 * the crossbar of an A through it - so the icon on somebody else's page is the thing the
 * player sees every time they open the client. The previous icon was a separate drawing,
 * an orbit with a point at apogee in pure cyan and pure red taken from the rank ladder,
 * and it matched nothing on screen.
 *
 * Nothing about it is chosen here. The path is read out of index.html, and this refuses
 * to draw if the rail's mark and the one below ever differ. The colours are --brand from
 * arena.css on --ground from index.html, read the way validate:theme reads them. Rank
 * colours are left out on purpose: they are the player's, and the icon is the app's.
 *
 * Drawn rather than exported from an editor so it is reproducible from the repository,
 * and the SVG is the same geometry as the PNGs rather than a trace of them. PNG is a
 * container around a zlib stream and Node already has zlib, so there is no image
 * dependency; electron-builder converts build/icon.png to the .ico Windows wants.
 *
 *   node tools/buildIcon.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// --- what it draws, read from the app -------------------------------------------

const html = read("src/app/renderer/index.html");
const css = html.slice(0, html.indexOf("</style>")) + "\n" + read("src/app/renderer/arena.css");

function token(name) {
  const m = new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})").exec(css);
  if (!m) throw new Error(`--${name} has no hex value in the stylesheets`);
  return m[1].toLowerCase();
}

const GROUND = token("ground");
const MARK = token("brand");
const EDGE = token("rule-2");

/**
 * The rail's mark, in its own 24-unit box.
 *
 * The crossbar sits at half height and the inner peak three units below it. They used to
 * sit one unit apart, crossbar at 14 and peak at 13, and with a stroke 1.65 wide that is
 * an overlap: a bump in the middle of the A, too small to see in the rail and the first
 * thing anybody saw at 512px. Three units clears it at both weights drawn below.
 */
const PATH = "m3 20 9-17 9 17M8.5 11.5h7M5 20l7-5.5 7 5.5";
if (!/<svg class="brand-mark"/.test(html)) throw new Error("the rail's brand mark is missing from index.html");
// The app draws the mark in more than one place - the rail, the tournaments header, and
// one the renderer builds - and every copy has to be this one. Checking only the rail let
// the other two keep the old crossbar when the rail's was moved.
const js = read("src/app/renderer/renderer.js");
const copies = [...(html + js).matchAll(/d="(m3 20 9-17 9 17[^"]*)"/g)].map((m) => m[1]);
const stale = [...new Set(copies.filter((d) => d !== PATH))];
if (stale.length) {
  throw new Error(`copies of the mark in the app differ from "${PATH}": ${stale.join(", ")}; update them together`);
}

/** Line segments from the subset of SVG path syntax the mark uses: m, M, l, L and h. */
function segments(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+/g);
  const out = [];
  let x = 0;
  let y = 0;
  let cmd = null;
  let first = true;
  for (let i = 0; i < tokens.length;) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const num = () => Number(tokens[i++]);
    if (cmd === "m" || cmd === "M") {
      const dx = num();
      const dy = num();
      // A path's first moveto is absolute even when written lowercase.
      [x, y] = cmd === "M" || first ? [dx, dy] : [x + dx, y + dy];
      first = false;
      cmd = cmd === "m" ? "l" : "L";   // pairs after a moveto are linetos
    } else if (cmd === "l" || cmd === "L") {
      const nx = cmd === "l" ? x + num() : num();
      const ny = cmd === "l" ? y + num() : num();
      out.push([x, y, nx, ny]);
      [x, y] = [nx, ny];
    } else if (cmd === "h") {
      const nx = x + num();
      out.push([x, y, nx, y]);
      x = nx;
    } else {
      throw new Error(`path command ${cmd} is not one this draws`);
    }
  }
  return out;
}

const SEGMENTS = segments(PATH);

// --- geometry, as fractions of the icon's side ------------------------------------

const TILE_HALF = 0.46;
const TILE_RADIUS = 0.115;
/** How much of the icon's width the mark spans. */
const GLYPH = 0.6;
/**
 * Stroke weight by size, the way type is drawn heavier small than large.
 *
 * The rail draws the mark at 1.65 in its 24-unit box, and at 16px that is under a pixel
 * wide and breaks up, so the small sizes are drawn at 2.1. That weight is wrong large:
 * at 512px the two feet on each side merge into one lump, so from 128px up the icon
 * uses the rail's own 1.65, and between the two it blends on a log scale. The SVG is for
 * large use and takes the large weight.
 */
const STROKE_SMALL = 2.1;
const STROKE_LARGE = 1.65;
function strokeAt(size) {
  const t = Math.min(1, Math.max(0, Math.log2(size / 32) / 2));
  return STROKE_SMALL + (STROKE_LARGE - STROKE_SMALL) * t;
}
/**
 * The mark's weight sits in its base and its bounding box centre looks low, so it is
 * raised by two percent of the tile to sit optically centred.
 */
const LIFT = 0.02;
/** A faint edge in the chrome's own rule colour, so a dark icon survives a dark page. */
const EDGE_WIDTH = 0.006;
const EDGE_ALPHA = 0.55;

const xs = SEGMENTS.flatMap(([x0, , x1]) => [x0, x1]);
const ys = SEGMENTS.flatMap(([, y0, , y1]) => [y0, y1]);
const CX = (Math.min(...xs) + Math.max(...xs)) / 2;
const CY = (Math.min(...ys) + Math.max(...ys)) / 2;
/** Mark units to tile fraction. */
const S = GLYPH / (Math.max(...xs) - Math.min(...xs));
const OX = 0.5 - CX * S;
const OY = 0.5 - LIFT - CY * S;

function roundedRect(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from a point to the stroked mark, in tile fraction. Round caps and joins. */
function mark(x, y, stroke) {
  const u = (x - OX) / S;
  const v = (y - OY) / S;
  let best = Infinity;
  for (const [x0, y0, x1, y1] of SEGMENTS) {
    const ex = x1 - x0;
    const ey = y1 - y0;
    const t = Math.max(0, Math.min(1, ((u - x0) * ex + (v - y0) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(u - (x0 + t * ex), v - (y0 + t * ey)));
  }
  return (best - stroke / 2) * S;
}

// --- raster ------------------------------------------------------------------------

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const [G, M, E] = [hex(GROUND), hex(MARK), hex(EDGE)];
const SS = 4;

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const stroke = strokeAt(size);
  // One output pixel's width in tile fraction: coverage ramps across exactly that.
  const px = 1 / size;
  const cover = (d) => Math.min(1, Math.max(0, 0.5 - d / px));
  for (let py = 0; py < size; py++) {
    for (let qx = 0; qx < size; qx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (qx + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const tile = roundedRect(x - 0.5, y - 0.5, TILE_HALF, TILE_RADIUS);
          const bg = cover(tile);
          if (bg <= 0) continue;
          let c = G.slice();
          const blend = (rgb, alpha) => { c = c.map((v, k) => v * (1 - alpha) + rgb[k] * alpha); };
          blend(E, cover(Math.abs(tile + EDGE_WIDTH / 2) - EDGE_WIDTH / 2) * EDGE_ALPHA);
          blend(M, cover(mark(x, y, stroke)));
          r += c[0] * bg; g += c[1] * bg; b += c[2] * bg; a += bg;
        }
      }
      const n = SS * SS;
      const o = (py * size + qx) * 4;
      // Colour is stored unpremultiplied, so divide the coverage back out of it.
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// --- a minimal PNG encoder ------------------------------------------------------

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  // Each scanline carries a filter byte; 0 (none) costs a little size and no complexity.
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- the same drawing as vector ---------------------------------------------------

function svg() {
  const V = 512;
  const f = (n) => Number((n * V).toFixed(3));
  const inset = TILE_HALF - EDGE_WIDTH / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${V} ${V}" width="${V}" height="${V}">
  <rect x="${f(0.5 - TILE_HALF)}" y="${f(0.5 - TILE_HALF)}" width="${f(TILE_HALF * 2)}" height="${f(TILE_HALF * 2)}" rx="${f(TILE_RADIUS)}" fill="${GROUND}"/>
  <rect x="${f(0.5 - inset)}" y="${f(0.5 - inset)}" width="${f(inset * 2)}" height="${f(inset * 2)}" rx="${f(TILE_RADIUS - EDGE_WIDTH / 2)}" fill="none" stroke="${EDGE}" stroke-opacity="${EDGE_ALPHA}" stroke-width="${f(EDGE_WIDTH)}"/>
  <path d="${PATH}" transform="matrix(${f(S)} 0 0 ${f(S)} ${f(OX)} ${f(OY)})" fill="none" stroke="${MARK}" stroke-width="${STROKE_LARGE}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

// --- write ------------------------------------------------------------------------

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
mkdirSync(join(root, "build", "icons"), { recursive: true });
for (const size of SIZES) {
  const file = png(render(size), size, size);
  writeFileSync(join(root, "build", "icons", `icon-${size}.png`), file);
  if (size === 512) writeFileSync(join(root, "build", "icon.png"), file);
}
writeFileSync(join(root, "build", "icons", "icon.svg"), svg());
console.log(`wrote build/icon.png and build/icons/: ${SIZES.map((s) => `${s}px`).join(", ")} and icon.svg`);
console.log(`  mark ${MARK} on ${GROUND}, edge ${EDGE}, stroke ${STROKE_SMALL} at 32px and under to ${STROKE_LARGE} at 128px and over`);
