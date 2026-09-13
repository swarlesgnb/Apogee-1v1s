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
 * It also holds the palette to the rules a stub can honestly check, measured off the calls
 * rather than taken from the comments: every pitch is in the key, each tier rings shorter
 * than the next, only the rarer tiers reach the room, and presses never repeat. Loudness
 * is not one of them; `npm run measure:sound` renders the sounds and checks that.
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
/** Every filter a sound builds, so the interface tier can be held to having no resonant one. */
const filters = [];

class Param {
  constructor(name, owner) {
    this.name = name;
    this.owner = owner;
    this.value = 0;
  }
  setValueAtTime(v, t) {
    rec("setValueAtTime", { param: this.name, owner: this.owner, v, t });
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    if (v === 0) throw new Error(`exponential ramp to zero on ${this.name}`);
    if (t < 0) throw new Error(`ramp to a negative time on ${this.name}`);
    rec("expRamp", { param: this.name, owner: this.owner, v, t });
    return this;
  }
}

let ids = 0;
const node = (kind, extra = {}) => {
  const self = {
    kind,
    id: ++ids,
    connect: (dest) => {
      rec("connect", { from: self.id, fromKind: kind, to: dest && dest.id, toKind: dest && dest.kind });
      return dest;
    },
    ...extra,
  };
  return self;
};
const value = (v = 0) => ({ value: v });

class Ctx {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = "running";
  }
  createGain() {
    const n = node("gain");
    n.gain = new Param("gain", n.id);
    return n;
  }
  createOscillator() {
    let started = false;
    const n = node("osc", {
      type: "sine",
      start: (t) => {
        started = true;
        rec("start", { t });
      },
      stop: (t) => {
        if (!started) throw new Error("stopped an oscillator that was never started");
        rec("stop", { t });
      },
    });
    n.frequency = new Param("frequency", n.id);
    return n;
  }
  createBiquadFilter() {
    const n = node("filter", { type: "lowpass", Q: value(1), gain: value(0) });
    n.frequency = new Param("filterFreq", n.id);
    filters.push(n);
    return n;
  }
  createBufferSource() {
    let started = false;
    return node("bufsrc", {
      buffer: null,
      playbackRate: value(1),
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
    if (!(length > 0)) throw new Error("empty buffer");
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, numberOfChannels: channels, getChannelData: (c) => data[c] };
  }
  createDynamicsCompressor() {
    return node("compressor", {
      threshold: value(), knee: value(), ratio: value(), attack: value(), release: value(),
    });
  }
  createConvolver() {
    return node("room", { buffer: null });
  }
  createStereoPanner() {
    return node("pan", { pan: value() });
  }
  get destination() {
    return node("destination");
  }
}

// Node's own performance.now() counts from process start, which is the same shape as the
// browser's counting from page load, so it is deliberately left alone rather than stubbed.
globalThis.window = { AudioContext: Ctx };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.$ = () => null;

const sound = new Function(
  `${block}\n;return { SOUNDS, SOUND_TIERS, NOTE, PRESS_CENTS, pressVariation, audio, get room() { return soundRoom; } };`,
)();

console.log("\napogee sound\n");

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};

// Built once so the master chain's own calls are not counted against the first sound.
sound.audio();
const roomId = sound.room.id;

const key = Object.values(sound.NOTE);
/** In the key at any octave, within a quarter-tone either side so the press's variation passes. */
const inKey = (f) =>
  key.some((k) => {
    const cents = 1200 * Math.log2(f / k);
    return Math.abs(cents - Math.round(cents / 1200) * 1200) < 45;
  });

/** What one sound did: how long it rings and whether it reaches the room. */
const profile = {};
for (const name of Object.keys(sound.SOUNDS)) {
  calls.length = 0;
  filters.length = 0;
  try {
    sound.SOUNDS[name]();
    const voices = calls.filter((c) => c.what === "start").length;
    if (voices === 0) throw new Error("made no sound at all");

    const length = Math.max(...calls.filter((c) => c.what === "stop").map((c) => c.t));
    const roomy = calls.some((c) => c.what === "connect" && c.to === roomId);

    // The interface tier plays under every click, so it is held to the two things that
    // made the first two presses sound like water: more than one burst, and a filter that
    // rings. A short burst through a bandpass has a pitch, and two a step apart is a drip.
    if (sound.SOUND_TIERS.interface.includes(name)) {
      if (voices > 1) throw new Error(`plays ${voices} bursts; an interface sound is one, because two short ones a step apart read as a drip`);
      const ringing = filters.filter((f) => f.type === "bandpass" || f.Q.value > 0.71);
      if (ringing.length) {
        throw new Error(`filters through ${ringing.map((f) => `${f.type} Q ${f.Q.value}`).join(", ")}, which rings at this length`);
      }
    }

    // A pitch is where a carrier starts and where it settles. Modulators sit at a ratio
    // of their carrier by design and are not notes, so only oscillators that feed a node
    // count; a modulator feeds its depth gain, which feeds a frequency parameter.
    const depths = new Set(
      calls.filter((c) => c.what === "connect" && c.fromKind === "gain" && c.to === undefined).map((c) => c.from),
    );
    const modulators = new Set(
      calls.filter((c) => c.what === "connect" && c.fromKind === "osc" && depths.has(c.to)).map((c) => c.from),
    );
    const pitches = calls
      .filter((c) => c.param === "frequency" && !modulators.has(c.owner))
      .map((c) => c.v);
    const outOfKey = pitches.filter((f) => !inKey(f));
    if (outOfKey.length) throw new Error(`plays out of key: ${outOfKey.map((f) => f.toFixed(1)).join(", ")} Hz`);

    // A sine whose pitch falls fast is how a water drop is synthesised, and the first
    // palette's press did exactly that under every click in the app: an octave in 14ms.
    // Nothing may fall more than three semitones in under 100ms.
    const from = new Map();
    for (const c of calls) {
      if (c.param !== "frequency" || modulators.has(c.owner)) continue;
      if (c.what === "setValueAtTime") from.set(c.owner, c);
      else if (c.what === "expRamp") {
        const s = from.get(c.owner);
        if (s && c.v < s.v / Math.pow(2, 3 / 12) && c.t - s.t < 0.1) {
          throw new Error(
            `falls ${(12 * Math.log2(s.v / c.v)).toFixed(0)} semitones in ${((c.t - s.t) * 1000).toFixed(0)}ms, which is a droplet`,
          );
        }
      }
    }

    profile[name] = { length, roomy };
    console.log(
      `  ok   ${name.padEnd(11)} ${String(voices).padStart(2)} voice(s), rings ${(length * 1000).toFixed(0).padStart(4)}ms` +
        `${roomy ? ", in the room" : ""}`,
    );
  } catch (err) {
    fail(`${name.padEnd(11)} ${err.message}`);
  }
}

/*
 * The order the palette claims, read from SOUND_TIERS in the renderer. Lengths and the
 * room are checked here; loudness is not, because what a sound peaks at is what its
 * voices sum to after the compressor and the room, and a stub cannot sum them. An
 * earlier version of this compared the loudest single voice, which ranked a four-note
 * chord below one click. `npm run measure:sound` renders them and checks loudness.
 */
const INTERFACE = sound.SOUND_TIERS.interface;
const NEWS = sound.SOUND_TIERS.news;
const MOMENTS = sound.SOUND_TIERS.moments;
const named = [...INTERFACE, ...NEWS, ...MOMENTS];
const missing = Object.keys(sound.SOUNDS).filter((n) => !named.includes(n));
if (missing.length) fail(`sounds with no place in the order: ${missing.join(", ")}`);
const phantom = named.filter((n) => !(n in sound.SOUNDS));
if (phantom.length) fail(`tiers name sounds that do not exist: ${phantom.join(", ")}`);

const longest = (names) => Math.max(...names.map((n) => profile[n]?.length ?? 0));
const shortest = (names) => Math.min(...names.map((n) => profile[n]?.length ?? Infinity));
if (longest(INTERFACE) >= shortest(NEWS)) fail("an interface sound rings as long as a piece of news");
if (longest(NEWS) >= shortest(MOMENTS)) fail("a piece of news rings as long as a moment");
for (const n of INTERFACE) if (profile[n]?.roomy) fail(`${n} is an interface sound and reaches the room`);
for (const n of MOMENTS) if (!profile[n]?.roomy) fail(`${n} is a moment and never reaches the room`);

console.log(
  `\n  tiers        : interface <= ${(longest(INTERFACE) * 1000).toFixed(0)}ms dry, ` +
    `news ${(shortest(NEWS) * 1000).toFixed(0)}-${(longest(NEWS) * 1000).toFixed(0)}ms, ` +
    `moments >= ${(shortest(MOMENTS) * 1000).toFixed(0)}ms in the room`,
);

/*
 * Presses vary without repeating. Checked on a long run, because the failure this guards
 * is a texture: the same sound thirty times in a row, which a short run would not show.
 */
const run = Array.from({ length: 200 }, () => sound.pressVariation());
const bound = run.every((c) => Math.abs(c) <= sound.PRESS_CENTS);
const apart = run.every((c, i) => i === 0 || Math.abs(c - run[i - 1]) >= sound.PRESS_CENTS / 3);
const spread = Math.max(...run) - Math.min(...run);
console.log(`  presses      : 200 in a row span ${spread.toFixed(0)} cents, none within ${(sound.PRESS_CENTS / 3).toFixed(0)} of the last`);
if (!bound) fail(`a press strays past ${sound.PRESS_CENTS} cents`);
if (!apart) fail("two presses in a row landed on nearly the same pitch");
if (spread < sound.PRESS_CENTS) fail("presses barely vary");

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nOK: ${Object.keys(sound.SOUNDS).length} sounds build, stay in key, keep their lengths and their room, and presses never repeat`);
