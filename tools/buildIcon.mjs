/**
 * Draw the application icon, and write it as build/icon.png.
 *
 * A packaged app with no icon ships Electron's default, which is the single loudest
 * signal that a build is a hobby project rather than a product. This draws one instead
 * of adding an image dependency: PNG is a container around a zlib stream, and Node
 * already has zlib, so the whole encoder is about forty lines.
 *
 * electron-builder converts this to the .ico Windows wants, so 512x512 with an alpha
 * channel is the only thing that has to be true of the output.
 *
 * The mark is the name: an orbit, and the bright point at the top of it is apogee, the
 * furthest a body gets. Colours are the ladder's own, taken from data/apogee_ranks.json
 * rather than picked again here - Stargazer's cyan for the orbit, Supernova's orange for
 * the point - so the icon cannot drift away from the palette the app renders.
 *
 *   node tools/buildIcon.mjs
 */

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ranks = JSON.parse(readFileSync(join(root, "data", "apogee_ranks.json"), "utf8"));
const tier = (name) => ranks.tiers.find((t) => t.name === name);

// The ends of the ladder and a point in its middle. The flare used to come from
// Supernova's gradient; there is no gradient in the rank data any more, so it is a
// lifted Supernova instead - the same colour the top rank actually wears.
const ORBIT = hex(tier("Stargazer").color);
const POINT = hex(tier("Supernova").color);
const FLARE = lift(hex(tier("Supernova").color), 0.45);
const BODY = hex(tier("Lunar").color);
const BACKDROP = [11, 13, 15];

function hex(s) {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The same colour, pulled `t` of the way to white. */
function lift(rgb, t) {
  return rgb.map((v) => Math.round(v + (255 - v) * t));
}

const SIZE = 512;
const SS = 4;                 // supersample factor; the edges are all curves
const N = SIZE * SS;

/** Signed distance to a rounded square, in supersampled pixels. */
function roundedRect(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * First-order signed distance to the ellipse (x/a)^2 + (y/b)^2 = 1.
 *
 * The exact distance needs Newton iteration per pixel; dividing the implicit function
 * by its gradient is the standard approximation and is indistinguishable here, where
 * the only consumer is a 2px antialiasing ramp.
 */
function ellipse(x, y, a, b) {
  const f = (x * x) / (a * a) + (y * y) / (b * b) - 1;
  const gx = (2 * x) / (a * a);
  const gy = (2 * y) / (b * b);
  const g = Math.hypot(gx, gy);
  return g === 0 ? -Math.min(a, b) : f / g;
}

/** Coverage in [0,1] for a signed distance, with a one-pixel ramp across the edge. */
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d / SS));

function over(dst, i, rgb, alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  dst[i] = dst[i] * (1 - a) + rgb[0] * a;
  dst[i + 1] = dst[i + 1] * (1 - a) + rgb[1] * a;
  dst[i + 2] = dst[i + 2] * (1 - a) + rgb[2] * a;
  dst[i + 3] = dst[i + 3] * (1 - a) + 255 * a;
}

// --- geometry, in output pixels then scaled -------------------------------------
const C = N / 2;
const half = N * 0.46;
const radius = N * 0.115;
const ORBIT_A = N * 0.335;
const ORBIT_B = N * 0.208;
const ORBIT_W = N * 0.032;
const ORBIT_TILT = -0.32;            // radians; a flat ellipse reads as a plate, not an orbit
const BODY_R = N * 0.088;
const POINT_R = N * 0.062;
const FLARE_R = N * 0.155;

// Apogee sits at the far end of the major axis, rotated with the orbit.
const APX = C + Math.cos(ORBIT_TILT) * ORBIT_A;
const APY = C + Math.sin(ORBIT_TILT) * ORBIT_A;

const buf = new Float32Array(N * N * 4);

for (let py = 0; py < N; py++) {
  for (let px = 0; px < N; px++) {
    const i = (py * N + px) * 4;
    const x = px + 0.5 - C;
    const y = py + 0.5 - C;

    // Backdrop, with a gentle vertical lift so the square is not a flat block.
    const bg = cover(roundedRect(x, y, half, radius));
    if (bg <= 0) continue;
    const lift = 1 + 0.35 * (1 - (py / N));
    over(buf, i, BACKDROP.map((c) => Math.min(255, c * lift)), bg);

    // Orbit ring, in the tilted frame.
    const rx = x * Math.cos(-ORBIT_TILT) - y * Math.sin(-ORBIT_TILT);
    const ry = x * Math.sin(-ORBIT_TILT) + y * Math.cos(-ORBIT_TILT);
    const ring = Math.abs(ellipse(rx, ry, ORBIT_A, ORBIT_B)) - ORBIT_W / 2;
    // Fade the near side so the ring reads as depth rather than a closed loop.
    const depth = 0.45 + 0.55 * ((ORBIT_A - rx) / (2 * ORBIT_A));
    over(buf, i, ORBIT, cover(ring) * bg * depth);

    // The orbited body.
    over(buf, i, BODY, cover(Math.hypot(x, y) - BODY_R) * bg);

    // Apogee: a soft flare under a hard point, so it glows without blooming.
    const fd = Math.hypot(x - (APX - C), y - (APY - C));
    over(buf, i, FLARE, Math.max(0, 1 - fd / FLARE_R) ** 3 * 0.75 * bg);
    over(buf, i, POINT, cover(fd - POINT_R) * bg);
  }
}

// --- downsample, encode ---------------------------------------------------------
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
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

writeFileSync(join(root, "build", "icon.png"), png(out, SIZE, SIZE));
console.log("wrote build/icon.png");
