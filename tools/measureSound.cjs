/**
 * Render every sound through Chromium's own Web Audio engine and measure what comes out.
 *
 *   npm run measure:sound              print the table, check the loudness order
 *   npm run measure:sound -- <dir>     also write a WAV of each sound there, to listen to
 *
 * `validate:sound` runs the palette against a stub, which can say how long a sound rings
 * and whether it reaches the room but not how loud it is: loudness is what the voices sum
 * to after the compressor and the room, and only rendering them says that. So this renders
 * each one offline, through the same code the app plays, and measures the result.
 *
 * Loudness here is A-weighted and momentary - the loudest 50ms - because a short sound is
 * judged by its loudest moment, and the ear hears a low note as quieter than its level.
 * Measured unweighted, the first draft of this palette put the error's two low notes
 * within 2.2 dB of a win, which is not what anybody hears. The weighting filter is checked against its published response before a
 * single sound is measured, so a wrong coefficient fails here rather than skewing the table.
 *
 * Electron rather than node because node has no Web Audio; this is the one tool that
 * needs a browser engine to tell the truth.
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const RATE = 48000;
const outDir = process.argv[2] && !process.argv[2].startsWith("-") ? path.resolve(process.argv[2]) : null;

const lines = fs.readFileSync(path.join(__dirname, "..", "src/app/renderer/renderer.js"), "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.includes("==================================== sound */"));
const end = lines.findIndex((l) => l.startsWith(" * The colour of a rank"));
if (start < 0 || end < 0) {
  console.error("could not find the sound section in renderer.js");
  process.exit(1);
}
const block = lines.slice(start, end - 1).join("\n");

// IEC 61672 A-weighting as a 6th-order IIR at 48 kHz, bilinear transform.
const AW_B = [0.234301792299513, -0.468603584599026, -0.234301792299513, 0.937207168598053,
  -0.234301792299513, -0.468603584599026, 0.234301792299513];
const AW_A = [1, -4.113043408775872, 6.553121752655046, -4.990849294163383,
  1.785737302937575, -0.246190595319487, 0.011224250033231];

function aWeight(x) {
  const y = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let acc = 0;
    for (let k = 0; k < 7 && k <= n; k++) {
      acc += AW_B[k] * x[n - k];
      if (k > 0) acc -= AW_A[k] * y[n - k];
    }
    y[n] = acc;
  }
  return y;
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

/** The filter's gain at one frequency, measured on a steady sine after it settles. */
function weightAt(hz) {
  const x = Float64Array.from({ length: RATE }, (_, i) => Math.sin((2 * Math.PI * hz * i) / RATE));
  const y = aWeight(x);
  const rms = (a) => Math.sqrt(a.slice(RATE / 2).reduce((s, v) => s + v * v, 0) / (RATE / 2));
  return db(rms(y) / rms(x));
}

// Published A-weighting: 0 dB at 1 kHz, -19.1 at 100 Hz, -8.6 at 250 Hz, +1.0 at 4 kHz.
const REFERENCE = [[1000, 0], [100, -19.1], [250, -8.6], [4000, 1.0]];
for (const [hz, want] of REFERENCE) {
  const got = weightAt(hz);
  if (Math.abs(got - want) > 0.5) {
    console.error(`A-weighting is ${got.toFixed(1)} dB at ${hz} Hz, published ${want}; not measuring with it`);
    process.exit(1);
  }
}

/** The loudest 50ms, A-weighted, both channels. */
function momentary(L, R) {
  const wl = aWeight(L);
  const wr = aWeight(R);
  const win = RATE * 0.05;
  const hop = RATE * 0.005;
  let best = 0;
  for (let s = 0; s + win <= wl.length; s += hop) {
    let sum = 0;
    for (let i = s; i < s + win; i++) sum += (wl[i] * wl[i] + wr[i] * wr[i]) / 2;
    best = Math.max(best, sum / win);
  }
  return db(Math.sqrt(best));
}

function wav(L, R) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  const s16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    buf.writeInt16LE(s16(L[i]), o);
    buf.writeInt16LE(s16(R[i]), o + 2);
  }
  return buf;
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html,<html></html>");
    const { names, tiers } = await win.webContents.executeJavaScript(`(() => {
      window.$ = () => null;
      ${block}
      window.__sound = { SOUNDS, ctx: () => ac, reset() { ac = null; soundBus = null; soundRoom = null; noiseBuf = null; } };
      return { names: Object.keys(SOUNDS), tiers: SOUND_TIERS };
    })()`);

    const rows = {};
    for (const name of names) {
      const r = await win.webContents.executeJavaScript(`(async () => {
        window.AudioContext = class extends OfflineAudioContext { constructor() { super(2, ${RATE} * 3, ${RATE}); } };
        __sound.reset();
        __sound.SOUNDS[${JSON.stringify(name)}]();
        const out = await __sound.ctx().startRendering();
        return { L: Array.from(out.getChannelData(0)), R: Array.from(out.getChannelData(1)) };
      })()`);
      let peak = 0;
      for (let i = 0; i < r.L.length; i++) peak = Math.max(peak, Math.abs(r.L[i]), Math.abs(r.R[i]));
      let last = 0;
      for (let i = 0; i < r.L.length; i++) if (Math.max(Math.abs(r.L[i]), Math.abs(r.R[i])) > peak * 0.001) last = i;
      rows[name] = { peak: db(peak), loud: momentary(r.L, r.R), ringMs: (last / RATE) * 1000 };
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `${name}.wav`), wav(r.L.slice(0, last + 480), r.R.slice(0, last + 480)));
      }
    }

    console.log("\napogee sound, rendered\n");
    console.log("  tier       sound         loudness dB(A)   peak dBFS   rings ms");
    for (const [tier, members] of Object.entries(tiers)) {
      for (const n of members) {
        const r = rows[n];
        console.log(`  ${tier.padEnd(10)} ${n.padEnd(12)} ${r.loud.toFixed(1).padStart(15)} ${r.peak.toFixed(1).padStart(11)} ${r.ringMs.toFixed(0).padStart(10)}`);
      }
    }

    const order = Object.entries(tiers);
    const clip = names.filter((n) => rows[n].peak > -1);
    if (clip.length) {
      code = 1;
      console.log(`  FAIL within 1 dB of clipping: ${clip.join(", ")}`);
    }
    for (let i = 0; i + 1 < order.length; i++) {
      const [lowTier, low] = order[i];
      const [highTier, high] = order[i + 1];
      const loudestLow = Math.max(...low.map((n) => rows[n].loud));
      const quietestHigh = Math.min(...high.map((n) => rows[n].loud));
      const ok = loudestLow < quietestHigh;
      if (!ok) code = 1;
      console.log(
        `  ${ok ? "ok  " : "FAIL"} every ${lowTier} sound is quieter than every ${highTier} sound ` +
          `(${loudestLow.toFixed(1)} < ${quietestHigh.toFixed(1)} dB(A))`,
      );
    }
    if (outDir) console.log(`\n  wrote ${names.length} WAVs to ${outDir}`);
    console.log(code === 0 ? "\nOK: the palette renders in its order" : "\nthe palette is out of order");
  } catch (err) {
    console.error(err);
    code = 1;
  }
  app.exit(code);
});
