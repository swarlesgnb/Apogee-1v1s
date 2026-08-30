/**
 * Run every sound the renderer can make, against a recording stub of the Web Audio API.
 *
 *   node tools/validateSound.mjs
 *
 * Sound only ever happens on a gesture, so none of it is reached by `npm run smoke`:
 * a ramp to an illegal value or an oscillator that is never started would first show up
 * when somebody clicked, and would show up as silence rather than as an error. This
 * plays all of them with no audio device in the room.
 *
 * The stub is strict where the real API is quiet. `exponentialRampToValueAtTime(0)` does
 * not throw in Chromium, it ignores the ramp and leaves the gain where it was, which is
 * audible as a click on the tail of a note and invisible everywhere else - so it throws
 * here.
 *
 * The renderer is a browser script with no exports, so the sound section is sliced out
 * of it by its own banner comment and evaluated. That is uglier than importing a module,
 * and it is what keeps the preview working: tools/buildUiPreview.ts inlines exactly one
 * script, so splitting sound into a file of its own would silently drop it from every
 * shared preview.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const src = readFileSync(join(root, "src/app/renderer/renderer.js"), "utf8").split(/\r?\n/);

const start = src.findIndex((l) => l.includes("==================================== sound */"));
const end = src.findIndex((l) => l.startsWith(" * The colour of a rank"));
if (start < 0 || end < 0) {
  console.error("could not find the sound section in renderer.js");
  process.exit(1);
}
const block = src.slice(start, end - 1).join("\n");

const calls = [];
const rec = (what, extra) => calls.push({ what, ...extra });

class Param {
  constructor(name) {
    this.name = name;
    this.value = 0;
  }
  setValueAtTime(v, t) {
    rec("setValueAtTime", { param: this.name, v, t });
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    if (v === 0) throw new Error(`exponential ramp to zero on ${this.name}`);
    if (t < 0) throw new Error(`ramp to a negative time on ${this.name}`);
    rec("expRamp", { param: this.name, v, t });
    return this;
  }
}

const node = (kind, extra = {}) => ({
  kind,
  connect: (dest) => {
    rec("connect", { from: kind, to: dest && dest.kind });
    return dest;
  },
  ...extra,
});

class Ctx {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = "running";
  }
  createGain() {
    return node("gain", { gain: new Param("gain") });
  }
  createOscillator() {
    let started = false;
    return node("osc", {
      type: "sine",
      frequency: new Param("frequency"),
      start: (t) => {
        started = true;
        rec("start", { t });
      },
      stop: (t) => {
        if (!started) throw new Error("stopped an oscillator that was never started");
        rec("stop", { t });
      },
    });
  }
  createBiquadFilter() {
    return node("filter", {
      type: "lowpass",
      frequency: new Param("filterFreq"),
      Q: { value: 1 },
    });
  }
  createBufferSource() {
    let started = false;
    return node("bufsrc", {
      buffer: null,
      playbackRate: { value: 1 },
      start: (t) => {
        started = true;
        rec("start", { t });
      },
      stop: (t) => {
        if (!started) throw new Error("stopped a buffer that was never started");
        rec("stop", { t });
      },
    });
  }
  createBuffer(channels, length) {
    if (!(length > 0)) throw new Error("empty noise buffer");
    return { length, getChannelData: () => new Float32Array(length) };
  }
  get destination() {
    return node("destination");
  }
}

// Node's own performance.now() counts from process start, which is the same shape as the
// browser's counting from page load - and that is exactly the clock the streak reads, so
// it is deliberately left alone rather than stubbed.
globalThis.window = { AudioContext: Ctx };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.$ = () => null;

const sound = new Function(
  `${block}\n;return { SOUNDS, playSound, setSound, streakStep, PENTATONIC, STREAK_MS };`,
)();

console.log("\napogee sound\n");

let failures = 0;

// playSound is gated behind `soundReady`, which the press section sets once boot is
// done. The recipes are called directly so this exercises the synthesis, not the gate.
for (const name of Object.keys(sound.SOUNDS)) {
  calls.length = 0;
  try {
    sound.SOUNDS[name]();
    const voices = calls.filter((c) => c.what === "start").length;
    const ramps = calls.filter((c) => c.what === "expRamp").length;
    if (voices === 0) throw new Error("made no sound at all");
    console.log(`  ok   ${name.padEnd(11)} ${voices} voice(s), ${ramps} ramps`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name.padEnd(11)} ${err.message}`);
  }
}

/**
 * The claim in renderer.js is that the press climbs while you keep pressing and resets
 * once you stop. Both halves are checked, because the reset is the half that breaks: an
 * origin of 0 rather than -Infinity makes the first press of the session read as a
 * continuation of a streak that never happened.
 */
const lapse = () => new Promise((r) => setTimeout(r, sound.STREAK_MS + 60));

// The tap above already took a step, so let it lapse or this measures a climb already
// in progress.
await lapse();

const climb = [];
for (let i = 0; i < sound.PENTATONIC.length + 3; i++) climb.push(sound.streakStep());
const top = sound.PENTATONIC[sound.PENTATONIC.length - 1];

console.log(`\n  climb        : ${climb.join(" ")}`);

if (climb[0] !== 0) {
  failures++;
  console.log(`  FAIL first press starts at ${climb[0]} rather than the root`);
}
if (!climb.every((v, i) => i === 0 || v >= climb[i - 1])) {
  failures++;
  console.log("  FAIL the climb is not monotonic");
}
if (climb[climb.length - 1] !== top) {
  failures++;
  console.log(`  FAIL the climb does not cap at ${top}`);
}

await lapse();
const resumed = sound.streakStep();
console.log(`  after a pause: ${resumed}`);
if (resumed !== 0) {
  failures++;
  console.log("  FAIL the streak did not reset once pressing stopped");
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nOK: ${Object.keys(sound.SOUNDS).length} sounds build, and the press streak climbs and resets`);
