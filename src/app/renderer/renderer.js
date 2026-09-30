"use strict";

/**
 * Apogee renderer.
 *
 * Runs in two hosts from one source, so the desktop app and the shareable preview
 * cannot drift apart:
 *
 *   ELECTRON  `window.apogee` exists (supplied by preload). Data is live: the main
 *             process watches the stats folder and pushes a new snapshot whenever a
 *             run lands.
 *
 *   PREVIEW   `window.__APOGEE_SNAPSHOT__` is inlined by tools/buildUiPreview.ts. Static,
 *             no Electron, opens anywhere.
 *
 * This file is a pure view. It never parses a CSV, computes a delta, or decides a
 * verdict; all of that arrives already settled.
 */

const HOST = typeof window.apogee !== "undefined" ? "electron" : "preview";

// The window has no title bar of its own, so the top bar has to leave room for the
// operating system's buttons - but only in the app. In the preview there is no window,
// and 150px of reserved nothing on the right of the bar looks like a bug.
document.documentElement.classList.add(HOST);

/**
 * The preload bridge, or null in the preview.
 *
 * Declared out here rather than inside the `HOST === "electron"` block it is mostly
 * used from. `refreshEligibility` is a top-level function that reaches for it, and a
 * `const` inside a block is invisible to one - so every call to it threw
 * `api is not defined`, from inside the `getState()` promise chain where nothing was
 * watching. The rejection took `render(snapshot)` down with it: signed in, with a
 * perfectly good snapshot in hand, the client sat on the first-run screen forever.
 * Signed out, the call never happened and nothing looked wrong, which is why it
 * survived.
 */
const api = HOST === "electron" ? window.apogee : null;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pct = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%";
const num = (v) => Math.round(v).toLocaleString();

/**
 * Scores keep a decimal below 1,000 and never round UP. A best of 78.54 against a target
 * of 79 read "79 -> 79, +0": the rank looked earned and never arrived. Points still to
 * find round up for the same reason, so a gap is never shown as nothing.
 */
const decimals = (v, below) => (Math.abs(v) < below && !Number.isInteger(v) ? 1 : 0);
const pts = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const f = 10 ** decimals(v, 1000);
  return (Math.floor(v * f + 1e-9) / f).toLocaleString(undefined, { maximumFractionDigits: 1 });
};
const need = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v <= 0) return "0";
  const f = 10 ** decimals(v, 100);
  return (Math.ceil(v * f - 1e-9) / f).toLocaleString(undefined, { maximumFractionDigits: 1 });
};
/** A threshold, shown as written. */
const tgt = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—"
  : v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 1000 ? 2 : 0 }));

/**
 * Declared up here rather than beside the press effects that used to own it: `countTo`
 * reads it too, and `render` runs at the bottom of this file in the static preview -
 * before the old declaration was reached, which made this a boot-time ReferenceError
 * rather than a missing animation.
 */
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ================================================================== counters */

/**
 * Move a readout to a new number instead of replacing it.
 *
 * Every figure in this file was assigned with `textContent`, which is correct and
 * silent: the rating after a match landed the same way it landed on the first paint,
 * so the one number the whole app exists to move changed without saying it had.
 *
 * Three rules, and the first is the one that matters:
 *
 * It only runs on a *change*. A readout with no previous value is set outright. A
 * counter that spins up from zero every time the app opens is decoration - it says
 * "here is a number" when the number has not done anything. This says "this moved",
 * which is a fact, and it is only true when something moved.
 *
 * The duration follows the distance. A rating that gained two points and one that
 * gained forty should not take the same time to arrive, or the small change reads as
 * laboured and the large one as instant. Both ends are clamped: under COUNT_MIN it is a
 * flicker nobody resolves, and over COUNT_MAX the player is waiting on an animation to
 * tell them something they can already read.
 *
 * It never runs on a hidden screen. `render` repaints every screen, not just the one
 * showing, and tweening nine readouts nobody is looking at is a frame the client is
 * spending beside a game that wants it.
 */
const COUNT_MIN = 320;
const COUNT_MAX = 800;
/** Milliseconds of travel per unit of change, before the clamp. */
const COUNT_PER_UNIT = 12;

/**
 * The JS twin of --ease-out. Quintic rather than the stylesheet's exact bezier: this is
 * the same family and the same shape to the eye, and a hand-solved bezier here would be
 * a second definition of the curve that could drift from the first.
 */
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

/**
 * What each keyed readout last showed.
 *
 * Keyed by a string the caller picks rather than by the element, because the screens
 * that need this rebuild their elements. A key has to name the *thing*, not the node:
 * "band:Static Clicking:2" is the same band across every render, while the div drawing
 * it is a different div every time.
 *
 * It is never cleared. The whole map is a few dozen numbers, and forgetting one means a
 * readout silently stops animating - which is the failure nobody would notice.
 */
const lastReadout = new Map();

/**
 * `format` turns the running value into what the element shows, so a counter can carry
 * a suffix or a separator without this knowing what either means.
 */
function countTo(el, value, format = (v) => String(Math.round(v)), key) {
  if (!el) return;

  // Cancel whatever was already running, and count from where it actually is rather
  // than from where the last tween was aiming: two results landing quickly should not
  // make the second one jump back to the first one's start.
  if (el._countRaf) {
    cancelAnimationFrame(el._countRaf);
    el._countRaf = 0;
  }

  // Where it was. On the hero stats that is the element itself, because those elements
  // outlive a render. The ranks and season screens throw their DOM away and build it
  // again on every snapshot, so an element there has never held a value and nothing
  // would ever animate - `key` is how a readout is recognised across the rebuild.
  const from = key === undefined ? el._countValue : lastReadout.get(key);
  const settle = () => {
    el._countValue = value;
    if (key !== undefined) lastReadout.set(key, value);
    el.textContent = format(value);
  };

  // No previous value, no change, reduced motion, or nobody looking: just be the number.
  if (from === undefined || from === value || reduceMotion.matches || !el.offsetParent) {
    settle();
    return;
  }

  const span = Math.abs(value - from);
  const ms = Math.min(COUNT_MAX, Math.max(COUNT_MIN, COUNT_MIN + span * COUNT_PER_UNIT));
  const start = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    if (t >= 1) {
      el._countRaf = 0;
      settle();
      return;
    }
    el.textContent = format(from + (value - from) * easeOutQuint(t));
    el._countRaf = requestAnimationFrame(step);
  };
  el._countRaf = requestAnimationFrame(step);
}

/* ==================================================================== sound */

/**
 * Every sound the app makes, synthesized here rather than shipped as audio files.
 *
 * Two reasons it is an oscillator and not a folder of samples. The client already owes
 * nothing to any service being reachable at runtime, and keeping that true should not
 * start costing a megabyte of .wav on every build. And the preview is one HTML file that
 * has to open anywhere: tools/buildUiPreview.ts inlines exactly one script, so a sample
 * would have to be base64 encoded into it and would double the file.
 *
 * Nothing is created until the first real gesture. An AudioContext constructed before
 * one starts suspended and stays suspended, and Chromium logs a warning about it on
 * every launch.
 *
 * The rules the palette below holds to, and where each came from:
 *
 *   An arcade voice: filtered pulse leads, triangle bass and percussive contacts,
 *   in D major. Short interfaces, syncopated run receipts, wider match fanfares.
 *
 *   Frequency buys restraint. The more often a sound plays, the shorter, quieter, drier
 *   and less pitched it is: a press is mostly a contact, a result is a phrase with a room
 *   around it. SOUND_TIERS below is that order; `validate:sound` holds its lengths and
 *   which tiers reach the room, and `measure:sound` renders every sound and holds its
 *   loudness.
 *
 *   Direction means something. Up is on and good, down is off and bad, and a draw takes
 *   a step that does not resolve. A toggle is one pulse, higher for on than for off.
 *
 *   Near and far. Frequent sounds are dry, close to the ear; only the rare moments are
 *   sent into the room, so the room itself is a signal that something mattered.
 *
 *   Variation, not a gimmick. A sound that repeats sample-identically becomes a texture
 *   within a minute. The press used to walk up a scale while you kept clicking, which
 *   was a novelty rather than feedback; now each press lands a few cents off the last.
 *
 *   Silence. The pointer crossing a control made a sound too. It fired dozens of times a
 *   minute, answered nothing, and was the first thing anybody would mute.
 */

const SOUND_KEY = "apogee.sound";
const SOUND_VOLUME_KEY = "apogee.sound.volume";
let soundVolume = 0.65;
try {
  const storedVolume = localStorage.getItem(SOUND_VOLUME_KEY);
  const parsedVolume = Number(storedVolume);
  if (storedVolume !== null && Number.isFinite(parsedVolume)) soundVolume = Math.max(0, Math.min(1, parsedVolume));
} catch { /* Use the default when local preferences are unavailable. */ }
let soundMaster = null;

/**
 * Master level.
 *
 * Deliberately low. This plays all evening beside a game the player actually wants to
 * hear, so the ceiling is "noticed" rather than "loud" - every individual sound below is
 * mixed against this, not against full scale.
 */
const SOUND_GAIN = 0.5;

let ac = null;
/** Where every voice lands, dry: a high-pass, a shelf off the top, then the compressor. */
let soundBus = null;
/** The room. Only the rare sounds send to it. */
let soundRoom = null;
let noiseBuf = null;

let soundOn = true;
try {
  soundOn = localStorage.getItem(SOUND_KEY) !== "off";
} catch (err) {
  /* storage can be unavailable; sound on is the right default either way */
}

/** Suppressed until boot has finished, so restoring a tab does not chime on launch. */
let soundReady = false;

function audio() {
  if (ac) return ac;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ac = new Ctx();

  // A soft compressor at the end, so a chord with the room behind it never clips and a
  // press under it is never lost. Gentle ratio and a wide knee: it is there to hold the
  // peaks, not to be heard pumping.
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -22;
  comp.knee.value = 18;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  const master = ac.createGain();
  soundMaster = master;
  master.gain.value = SOUND_GAIN * soundVolume;
  comp.connect(master);
  master.connect(ac.destination);

  // Below about 90 Hz a UI sound is felt through the desk rather than heard, and on laptop
  // speakers it is only distortion. Above 7 kHz is where synthesis sounds cheap: the
  // shelf takes the edge off without dulling the contact at the front of a press.
  const low = ac.createBiquadFilter();
  low.type = "highpass";
  low.frequency.value = 90;
  low.Q.value = 0.5;
  const top = ac.createBiquadFilter();
  top.type = "highshelf";
  top.frequency.value = 7000;
  top.gain.value = -6;
  low.connect(top);
  top.connect(comp);
  soundBus = low;

  const room = ac.createConvolver();
  room.buffer = roomImpulse(ac);
  const wet = ac.createGain();
  wet.gain.value = 0.6;
  room.connect(wet);
  wet.connect(low);
  soundRoom = room;

  return ac;
}

/**
 * A small room, made rather than sampled.
 *
 * Decaying noise, separate per channel so the tail is wide, darkened as it ages because
 * a real room absorbs the highs first: a tail that stays bright reads as a plate effect,
 * not a space. Twelve milliseconds of silence up front keep the dry strike distinct from
 * its reflection.
 */
function roomImpulse(ctx) {
  const n = Math.floor(ctx.sampleRate * 1.4);
  const gap = Math.floor(ctx.sampleRate * 0.012);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const a = 0.2 + 0.72 * t;
      lp = lp * a + (Math.random() * 2 - 1) * (1 - a);
      d[i] = i < gap ? 0 : lp * Math.pow(1 - t, 3);
    }
  }
  return buf;
}

/** A quarter-second of white noise, made once and re-read by every contact. */
function noiseBuffer(ctx) {
  if (noiseBuf) return noiseBuf;
  const n = Math.floor(ctx.sampleRate * 0.25);
  noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/**
 * Up, then away.
 *
 * Ramps to 0.0001 rather than to 0 because `exponentialRampToValueAtTime` cannot reach
 * zero: given it, the ramp is ignored and the gain stays where it was, which is audible
 * as a click on the tail of every note.
 */
function envelope(param, t0, peak, attack, dur) {
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

/** Dry to the bus, and to the room by `send`, panned by `pan`. */
function route(ctx, node, o) {
  let n = node;
  if (o.pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    n.connect(p);
    n = p;
  }
  n.connect(soundBus);
  if (o.send) {
    const s = ctx.createGain();
    s.gain.value = o.send;
    n.connect(s);
    s.connect(soundRoom);
  }
}

/**
 * One pitched voice.
 *
 * `from` glides onto the note, and only ever slowly: a sine that falls fast is how a
 * water drop is synthesised, which is what the first press sounded like on every click,
 * and `validate:sound` fails anything that does it. `fm` adds a short harmonic attack.
 * Pulse and saw voices use low-pass filtering for comfortable long sessions.
 */
function tone(o) {
  const ctx = audio();
  if (!ctx) return;
  const t0 = ctx.currentTime + (o.delay || 0);
  const dur = o.dur;
  const f = o.freq * Math.pow(2, (o.cents || 0) / 1200);

  const osc = ctx.createOscillator();
  osc.type = o.wave || "triangle";
  if (o.from) {
    osc.frequency.setValueAtTime(o.from * Math.pow(2, (o.cents || 0) / 1200), t0);
    osc.frequency.exponentialRampToValueAtTime(f, t0 + (o.glide || 0.03));
  } else {
    osc.frequency.setValueAtTime(f, t0);
  }
  const sources = [osc];

  if (o.fm) {
    const mod = ctx.createOscillator();
    mod.frequency.setValueAtTime(f * o.fm.ratio, t0);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f * o.fm.index, t0);
    depth.gain.exponentialRampToValueAtTime(f * o.fm.index * 0.02, t0 + o.fm.decay);
    mod.connect(depth);
    depth.connect(osc.frequency);
    sources.push(mod);
  }

  let node = osc;
  if (o.lowpass) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = o.lowpass;
    lp.Q.value = 0.7;
    node.connect(lp);
    node = lp;
  }
  const amp = ctx.createGain();
  envelope(amp.gain, t0, o.gain, o.attack || 0.003, dur);
  node.connect(amp);
  route(ctx, amp, o);
  for (const s of sources) {
    s.start(t0);
    s.stop(t0 + dur + 0.05);
  }
}

/**
 * Filtered noise: the contact at the front of a press, or air when it is long.
 *
 * Bandpass by default, and bandpass rings: a narrow band of noise short enough has a
 * pitch of its own, and two of them a step apart is a drip. The interface tier uses
 * highpass, which has no centre to hear as a note, and `validate:sound` holds it to that.
 *
 * Read from a random point in the buffer each time, so two presses are never the same
 * few hundred samples of noise.
 */
function tick(o) {
  const ctx = audio();
  if (!ctx) return;
  const t0 = ctx.currentTime + (o.delay || 0);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = o.type || "bandpass";
  filter.frequency.setValueAtTime(o.hz, t0);
  if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur);
  filter.Q.value = o.q == null ? 0.8 : o.q;
  const amp = ctx.createGain();
  envelope(amp.gain, t0, o.gain, o.attack || 0.0015, o.dur);
  src.connect(filter);
  filter.connect(amp);
  route(ctx, amp, o);
  src.start(t0, Math.random() * 0.2);
  src.stop(t0 + o.dur + 0.03);
}

/** The key, D major. Nothing below plays a pitch that is not in it. */
const NOTE = {
  D3: 146.83, A3: 220.0, B3: 246.94, D4: 293.66, E4: 329.63, Fs4: 369.99, A4: 440.0,
  D5: 587.33, E5: 659.25, Fs5: 739.99, A5: 880.0, D6: 1174.66, Fs6: 1479.98, A6: 1760.0,
};

/** A harmonic attack used for the unresolved draw cue. */
const CHIP = { ratio: 2, index: 0.35, decay: 0.045 };

/**
 * How far one press lands from the last, in cents.
 *
 * Small enough to be the same sound, large enough that thirty in a row are not one sound
 * thirty times. Never within a third of the range of the previous one, because a random
 * draw that happens to repeat is still a repeat.
 */
const PRESS_CENTS = 35;
let lastPressCents = 0;

function pressVariation() {
  let c;
  do c = (Math.random() * 2 - 1) * PRESS_CENTS;
  while (Math.abs(c - lastPressCents) < PRESS_CENTS / 3);
  lastPressCents = c;
  return c;
}

/**
 * The palette, ordered from most frequent to rarest, which is also quietest to loudest.
 *
 * Each entry is a whole sound rather than a note, because the ones that matter are two
 * or three voices a few milliseconds apart - that offset is what gives an arrival its
 * weight and a press its body.
 */
const SOUNDS = {
  /** A short, dry cabinet-button pulse for navigation. */
  nav() {
    tone({ freq: NOTE.A4, wave: "triangle", lowpass: 1600, dur: 0.045, gain: 0.022 });
  },

  /**
   * The everyday press. One dry tick of noise above 2.6 kHz, and nothing else.
   *
   * Two earlier versions both sounded like water. The first dropped a sine an octave in
   * 14ms under the contact, which is how a drop is synthesised. The second swapped it for
   * two bandpassed bursts a step apart, and a band of noise that short and narrow has a
   * pitch, so the pair was a drip again. Highpassed noise has no centre to hear as a
   * pitch, and one burst cannot step anywhere. The variation moves the cutoff.
   */
  tap() {
    const shift = Math.pow(2, pressVariation() / 1200);
    tick({ type: "highpass", hz: 2600 * shift, q: 0.5, dur: 0.006, gain: 0.14 });
  },

  /** A higher pulse confirms selection. */
  toggleOn() {
    tone({ freq: NOTE.D5, wave: "triangle", lowpass: 2200, dur: 0.035, gain: 0.026 });
  },

  /** A lower pulse confirms deselection. */
  toggleOff() {
    tone({ freq: NOTE.A4, wave: "triangle", lowpass: 1300, dur: 0.028, gain: 0.022 });
  },

  /** A three-note receipt when a run lands in the stats folder. */
  run() {
    [NOTE.D5, NOTE.A5, NOTE.D6].forEach((freq, i) => tone({ freq, wave: "triangle", lowpass: 3200, dur: i === 2 ? 0.24 : 0.09, gain: 0.036, delay: i * 0.065, send: 0.08 }));
  },

  /** Success: a short rising fourth. */
  ok() {
    tone({ freq: NOTE.A5, wave: "triangle", lowpass: 2800, dur: 0.09, gain: 0.037 });
    tone({ freq: NOTE.D6, wave: "triangle", lowpass: 3200, dur: 0.26, gain: 0.036, delay: 0.09, send: 0.12 });
  },

  /**
   * Something failed.
   *
   * The mirror of `ok`: down a fourth, low, no glass, and the last note doubled twenty
   * cents sharp so it beats slowly against itself - wrong, not alarming. Deliberately not
   * a buzzer: this fires on a failed upload while somebody is mid-session, and a harsh
   * sound there punishes the player for the network's problem.
   */
  error() {
    tone({ freq: NOTE.E4, dur: 0.14, gain: 0.055, lowpass: 1400 });
    tone({ freq: NOTE.B3, dur: 0.28, gain: 0.055, delay: 0.1, lowpass: 1100 });
    tone({ freq: NOTE.B3 * 1.0116, dur: 0.28, gain: 0.028, delay: 0.1, lowpass: 1100 });
  },

  /** The big commitment - Find opponent. Weight first, then a ring, so the commitment has a pitch. */
  press() {
    tick({ type: "highpass", hz: 1800, q: 0.5, dur: 0.025, gain: 0.13 });
    tone({ freq: NOTE.D3, wave: "triangle", dur: 0.21, gain: 0.14, lowpass: 900 });
    [NOTE.D4, NOTE.A4, NOTE.D5].forEach((freq, i) => tone({ freq, wave: "triangle", lowpass: 2300, dur: 0.12, gain: 0.045, delay: 0.04 + i * 0.065, send: 0.1 }));
  },

  /**
   * A draw. A step up that never arrives anywhere: the ear waits for the resolution a
   * win would have given it, which is what a draw is.
   */
  draw() {
    tone({ freq: NOTE.D5, fm: CHIP, dur: 0.4, gain: 0.04, send: 0.15 });
    tone({ freq: NOTE.E5, fm: CHIP, dur: 0.55, gain: 0.036, delay: 0.12, send: 0.2 });
  },

  /**
   * Soft on purpose. Losing already feels bad; the app does not need to press on it.
   * Down a major triad rather than a minor one, and close rather than roomy: that is it,
   * not a tragedy.
   */
  defeat() {
    tone({ freq: NOTE.A4, dur: 0.3, gain: 0.045, lowpass: 1600, send: 0.06 });
    tone({ freq: NOTE.Fs4, dur: 0.34, gain: 0.045, delay: 0.16, lowpass: 1300, send: 0.06 });
    tone({ freq: NOTE.D4, dur: 0.6, gain: 0.052, delay: 0.32, lowpass: 1000, send: 0.08 });
  },

  /**
   * An opponent was found. An approach, then an arrival.
   *
   * Air opening up and a tone rising with it lead the ear to a beat it can predict, and
   * the arrival lands on it: a low body and an open fifth spread across the stereo field,
   * in the room. The approach cuts rather than fades, so the arrival is the only thing
   * left when it hits.
   */
  matchFound() {
    [NOTE.D4, NOTE.A4, NOTE.D5].forEach((freq, i) => tone({ freq, wave: "triangle", lowpass: 2600, dur: 0.065, gain: 0.045, delay: i * 0.1 }));
    const at = 0.36;
    tick({ hz: 2200, dur: 0.02, gain: 0.09, delay: at });
    tone({ freq: NOTE.D3, dur: 0.35, gain: 0.18, delay: at, lowpass: 700 });
    tone({ freq: NOTE.D5, wave: "triangle", lowpass: 2300, dur: 0.7, gain: 0.055, delay: at, pan: -0.3, send: 0.2 });
    tone({ freq: NOTE.A5, wave: "triangle", lowpass: 3200, dur: 0.8, gain: 0.045, delay: at + 0.02, pan: 0.3, send: 0.2 });
  },

  /** A quest completed or a benchmark promotion. The chord, climbing left to right. */
  celebrate() {
    [NOTE.D5, NOTE.Fs5, NOTE.A5, NOTE.D6].forEach((f, i) => {
      tone({ freq: f, wave: "triangle", lowpass: 3400, dur: 0.9 - i * 0.1, gain: 0.04, delay: i * 0.085, pan: -0.45 + i * 0.3, send: 0.2 });
    });
    tone({ freq: NOTE.D4, dur: 0.6, gain: 0.07, delay: 0.21, lowpass: 800, send: 0.2 });
    tone({ freq: NOTE.A6, wave: "triangle", dur: 1.2, gain: 0.025, delay: 0.28, send: 0.25 });
  },

  /**
   * A win. The rarest sound in the app and the only one that gets everything: a rising
   * pickup, then the whole chord at once over a low floor, wide, with the most room.
   */
  victory() {
    [NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((f, i) => {
      tone({ freq: f, wave: "triangle", lowpass: 3300, dur: 0.14, gain: 0.05, delay: i * 0.09, send: 0.12 });
    });
    const at = 0.27;
    tick({ hz: 2600, dur: 0.02, gain: 0.08, delay: at });
    tone({ freq: NOTE.D3, dur: 0.7, gain: 0.15, delay: at, lowpass: 600, send: 0.15 });
    [NOTE.A5, NOTE.D6, NOTE.Fs6].forEach((f, i) => {
      tone({ freq: f, wave: "triangle", lowpass: 3800, dur: 1.3, gain: 0.04, delay: at + i * 0.012, pan: [-0.4, 0, 0.4][i], send: 0.3 });
    });
  },
};

/**
 * The order the palette claims, most frequent first. Every sound in a tier is shorter and
 * quieter than every sound in the next, and only the interface tier stays out of the room.
 */
const SOUND_TIERS = {
  interface: ["nav", "tap", "toggleOn", "toggleOff"],
  news: ["run", "ok", "error", "press", "draw", "defeat"],
  moments: ["matchFound", "celebrate", "victory"],
};

/**
 * Play one, and never let it matter.
 *
 * Named `playSound` rather than `play` because `renderTodo` builds a button it calls
 * `play`, and a local const would shadow this from inside the one place that most
 * wants to use it.
 *
 * A sound is the least important thing on screen, so anything the audio stack throws
 * takes sound out of the session rather than taking the click - or the render behind it -
 * down with it. That has to be a real off switch rather than a swallowed error per
 * press: a machine with no working output device would otherwise throw on every one.
 */
function playSound(name) {
  if (!soundOn || !soundReady) return;
  const make = SOUNDS[name];
  if (!make) return;

  try {
    const ctx = audio();
    if (!ctx) return;
    // A context can be suspended long after it was created - the first gesture is the
    // usual reason, a machine waking from sleep is the other.
    if (ctx.state === "suspended") void ctx.resume();
    make();
  } catch (err) {
    soundOn = false;
    console.warn("sound disabled for this session:", err && err.message);
  }
}

function setSound(on, announce) {
  soundOn = on;
  if (soundMaster && ac) soundMaster.gain.setTargetAtTime(on ? SOUND_GAIN * soundVolume : 0, ac.currentTime, 0.015);
  const btn = $("soundToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Sound on. Press M to mute" : "Muted. Press M to unmute";
  }
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch (err) {
    /* a preference that cannot be stored still applies to this session */
  }
  // Confirm unmuting by being audible. Muting confirms itself by going quiet.
  if (on && announce) playSound("toggleOn");
}

/** Volume changes the existing master bus, including any cue already playing. */
function setSoundVolume(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  soundVolume = Math.max(0, Math.min(1, parsed));
  if (soundMaster && ac) soundMaster.gain.setTargetAtTime(soundOn ? SOUND_GAIN * soundVolume : 0, ac.currentTime, 0.015);
  try { localStorage.setItem(SOUND_VOLUME_KEY, String(soundVolume)); } catch { /* Session-only preference. */ }
  const slider = $('soundVolume');
  if (slider) slider.value = String(Math.round(soundVolume * 100));
  const readout = $('soundVolumeReadout');
  if (readout) readout.textContent = Math.round(soundVolume * 100) + '%';
}


/**
 * The colour of a rank, looked up on the ladder that graded it.
 *
 * Every category names and colours its own ranks, so the overall ladder's palette has no
 * entry for "Blunderbuss" or "Amoeba": looking a category rank up
 * there returned undefined and every one of them rendered grey. `cat` is the category
 * object from the snapshot, which now carries its own ladder; omit it for a rank that
 * genuinely belongs to the overall ladder, like the consistency ceiling and floor.
 */
/**
 * Set a determinate fill, 0..1.
 *
 * Every bar in the client is one element scaled from its left edge rather than one
 * given a width, so this is where the clamp lives too - three of the callers were
 * clamping and three were not, and an unclamped share past 1 draws a bar out past the
 * end of its own track.
 */
function setFill(el, share) {
  if (!el) return;
  const at = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  el.style.transform = "scaleX(" + at.toFixed(4) + ")";
}

function rankColor(data, rankName, cat) {
  if (!rankName) return "var(--ink-dim)";
  return (
    (cat && cat.rankColors && cat.rankColors[rankName]) ||
    data.benchmark.rankColors[rankName] ||
    "#8891a3"
  );
}

/**
 * A rank's colour, lifted until it can be read on the ground.
 *
 * Rank colours are chosen to match rank names - Quasar is cyan because a quasar is,
 * Singularity is black because a singularity is - and several of them land below 2:1
 * against the client's near-black. Printed raw as text, that made whole columns of the
 * scenario tables unreadable: Musket is a dark grey on a dark ground, Primate a dark red.
 *
 * Mixed toward the light ground in 5% steps until it clears, which keeps the hue and
 * moves only what has to move. It is the same function the rank sheet measures with, so
 * a colour the sheet reports as failing is the colour this lifts, rather than two
 * different ideas of legible. Backgrounds and bars keep the raw colour: the problem is
 * text on a ground, not the colour.
 */
function rankInk(data, rankName, cat) {
  return legibleOnDark(rankColor(data, rankName, cat), RANK_TEXT_CONTRAST);
}

/**
 * The scenario a family's next rank is scored on, named so it can be found.
 *
 * The three variants of a family share a label, so "Pasu" alone names three different
 * scenarios in KovaaK's. When the next rank lives in a harder window - which is what
 * happens every four ranks - the window is the difference between a target the player
 * can act on and one they cannot.
 */
function targetName(s) {
  if (!s.nextRankLabel) return "";
  return s.nextRankWindowName
    ? s.nextRankLabel + " " + s.nextRankWindowName
    : s.nextRankLabel;
}

/** Rank insignia: the outer wings and earned pips advance with the ladder rung. */
function badge(tier, uid) {
  const rung = Math.max(1, Math.min(8, Number(/^tier-(\d+)$/.exec(String(tier.id ?? ""))?.[1] || 1)));
  const color = legibleOnDark(tier.color, RANK_TEXT_CONTRAST);
  const faces = [
    'M40 12 62 34 40 67 18 34Z',
    'M40 9 64 24 60 52 40 69 20 52 16 24Z',
    'M27 12h26l13 21-10 27-16 10-16-10-10-27Z',
    'M40 8 65 22 65 51 40 71 15 51V22Z',
    'M40 7 61 17 69 39 59 60 40 72 21 60 11 39 19 17Z',
    'M24 12 40 5 56 12 69 29 64 53 40 73 16 53 11 29Z',
    'M40 4 57 14 69 14 67 40 58 62 40 75 22 62 13 40 11 14 23 14Z',
    'M40 3 51 12 65 9 65 25 74 37 62 59 40 77 18 59 6 37 15 25 15 9 29 12Z'
  ];
  const ribs = rung >= 3 ? '<path d="M20 29 9 24l4 26 12 10M60 29l11-5-4 26-12 10" fill="none" stroke="currentColor" stroke-width="1.4"/>' : '';
  const crown = rung >= 6 ? '<path d="m25 15 2-10 13 6L53 5l2 10" fill="none" stroke="currentColor" stroke-width="1.5"/>' : '';
  const pips = Array.from({length:rung}, (_, i) => '<path d="m' + (40 + (i - (rung - 1) / 2) * 5) + ' 78 1.5 2-1.5 2-1.5-2Z" fill="currentColor"/>').join('');
  return '<svg class="rank-insignia material-' + rung + '" viewBox="0 0 80 86" role="img" aria-label="' + esc(tier.name) + '" style="color:' + esc(color) + '">' +
    '<path d="' + faces[rung-1] + '" fill="currentColor" fill-opacity=".17" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M40 16 58 27 40 38 22 27Z" fill="currentColor" fill-opacity=".48"/>' +
    '<path d="M22 27v23l18 14V38Z" fill="currentColor" fill-opacity=".1"/>' +
    '<path d="M58 27v23L40 64V38Z" fill="currentColor" fill-opacity=".28"/>' +
    '<path d="m22 27 18 11 18-11M40 38v26" fill="none" stroke="currentColor" stroke-opacity=".5"/>' + ribs + crown +
    '<path d="m29 46 11-21 11 21-11-6Zm3 5 8 7 8-7-8 2Z" fill="currentColor"/>' + pips + '</svg>';
}

/**
 * What a run's verification tier means, for the tooltip on the tier word. Players saw
 * "consistent" and "suspect" with no gloss; the definitions lived only in FAIR-PLAY.md,
 * and these are that table's rows, shortened.
 */
function tierMeaning(tier) {
  return {
    verified: "KovaaK's servers hold a matching record. Counts in full.",
    consistent: "No server record yet, but the file checks out and is near your verified best. Counts in full.",
    suspect: "Above your verified best with no server record. Counts, and is held for review.",
    rejected: "The file failed a check or was played outside the match. The match is void.",
  }[tier] || "";
}

/* Discipline marks describe movement; they never decide the scenario pool. */
const DISCIPLINES = {
  "Any": { key: "all", ink: "#d7fa52", cue: "Scenarios from all six categories", path: '<path d="M12 2 22 12 12 22 2 12ZM12 7v10M7 12h10"/>' },
  "Static Clicking": { key: "static", ink: "#f3ca6c", cue: "Click stationary targets quickly and accurately.", path: '<path d="M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5M12 7l5 5-5 5-5-5ZM12 10v4m-2-2h4"/>' },
  "Dynamic Clicking": { key: "dynamic", ink: "#ff9dae", cue: "Time your shots on moving targets.", path: '<path d="M3 18C5 9 9 5 17 5M14 2l5 3-5 3M7 18l4-4 4 4-4 4ZM20 11v6"/>' },
  "Precise Tracking": { key: "precise", ink: "#98e3ce", cue: "Keep your crosshair steady on the target.", path: '<path d="M2 12c4-7 16-7 20 0-4 7-16 7-20 0ZM12 8v8m-4-4h8M12 2v3m0 14v3"/>' },
  "Reactive Tracking": { key: "reactive", ink: "#a2bfff", cue: "Follow targets through sudden direction changes.", path: '<path d="M2 16l5-9 5 10 5-13 5 8M7 3v4m5 10v4M3 21h4m10 0h4"/>' },
  "Speed Switching": { key: "speed", ink: "#d7fa52", cue: "Move quickly from one target to the next.", path: '<path d="M3 4h6v6H3Zm12 10h6v6h-6ZM11 4h7l3 3-3 3M13 20H6l-3-3 3-3M9 15l6-6"/>' },
  "Evasive Switching": { key: "evasive", ink: "#cfb0f1", cue: "Finish each moving target before switching.", path: '<path d="M5 2l4 4-4 4-4-4Zm14 12l4 4-4 4-4-4ZM5 12c0 7 14-8 14 0M12 3l3 3-3 3"/>' },
};

function disciplineOf(name) { return DISCIPLINES[name] || DISCIPLINES.Any; }

function paintDiscipline(name) {
  const d = disciplineOf(name);
  const stage = document.querySelector('.queue-stage');
  if (!stage) return;
  stage.dataset.discipline = d.key;
  stage.style.setProperty('--discipline', d.ink);
  const mark = $('disciplineMark');
  if (mark) mark.style.setProperty('--discipline', d.ink);
  if (mark) mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d.path + '</svg>';
  if (mark && soundReady && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    mark.classList.remove('is-picking');
    requestAnimationFrame(() => mark.classList.add('is-picking'));
  }
  if ($('disciplineCue')) $('disciplineCue').textContent = d.cue;
  if ($('selectedDisciplineLabel')) $('selectedDisciplineLabel').textContent = name === 'Any' || !name ? 'All categories' : name;
}

function paintQueueJourney(state) {
  const index = state === 'working' ? 1 : state === 'held' ? 2 : 0;
  document.querySelectorAll('.queue-journey li').forEach((el, i) => {
    el.classList.toggle('current', i === index);
    el.classList.toggle('complete', i < index);
    if (i === index) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });
  if ($('queueSignal')) $('queueSignal').textContent = state === 'working'
    ? 'Looking for an opponent' : state === 'held' ? 'Match ready · play in KovaaK’s' : 'Choose a category';
}

function renderCommandFocus(data) {
  const host = $('commandFocus');
  if (!host) return;
  const category = data.categories.find(c => c.name === data.weakest);
  host.hidden = !category;
  if (!category) return;
  $('commandFocusName').textContent = category.name;
  $('commandFocusDetail').textContent = category.rankName
    ? category.rankName + ' · your lowest category standing' : 'Unranked · build your first baseline';
  $('commandFocusOpen').onclick = () => openScreen('profile');
}

/** Presentation of stored deltas only. Missing and excluded rounds never imply a loss. */
function roundPresentation(round) {
  if (!round.counted) return { label: 'Excluded', tone: 'neutral' };
  if (!Number.isFinite(round.delta)) return { label: 'Unavailable', tone: 'neutral' };
  if (!Number.isFinite(round.opponentDelta)) return { label: 'Recorded', tone: 'neutral' };
  if (round.delta === round.opponentDelta) return { label: 'Draw', tone: 'neutral' };
  return round.delta > round.opponentDelta ? { label: 'Won', tone: 'win' } : { label: 'Lost', tone: 'loss' };
}

function renderDebrief(rounds, provenance) {
  const host = $('debriefRounds');
  if (!host) return;
  host.replaceChildren();
  host.hidden = !rounds.length;
  $('debriefProvenance').textContent = provenance;
  rounds.forEach((r, i) => {
    const outcome = roundPresentation(r);
    const card = document.createElement('article');
    card.className = 'debrief-round ' + outcome.tone;
    card.style.setProperty('--round-index', String(i));
    const own = r.counted && Number.isFinite(r.delta) ? pct(r.delta) : "—";
    const other = r.counted && Number.isFinite(r.opponentDelta) ? pct(r.opponentDelta) : "—";
    card.innerHTML = '<div class="debrief-round-head"><span>ROUND ' + String(i + 1).padStart(2, '0') + '</span><b>' + outcome.label + '</b></div>' +
      '<h3>' + esc(r.scenario) + '</h3><div class="debrief-comparison"><span><small>You</small><strong>' + own + '</strong></span><span><small>Opponent</small><strong>' + other + '</strong></span></div>' +
      '<p>' + esc(!r.counted ? r.excludedReason || 'Not included in settlement' : 'Improvement over baseline') + '</p>';
    host.append(card);
  });
}

function renderMatchReadiness() {
  const host = $('matchReadiness');
  if (!host) return;
  const received = pendingScenarios.filter(s => s.done).length;
  host.textContent = received + ' / ' + pendingScenarios.length + ' runs received' + (HOST === 'preview' ? ' · example set' : '');
}

/** Scroll regions need a keyboard landing point when the window is narrower than a table. */
function prepareScrollRegions() {
  document.querySelectorAll('.rounds-wrap, .scen-wrap, .band-grid-wrap, .tn-bracket-wrap').forEach(el => {
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', el.classList.contains('tn-bracket-wrap') ? 'Tournament bracket, scroll horizontally for later rounds' : 'Results table, scroll horizontally for more columns');
  });
}

/* ------------------------------------------------------------------ status */

function setStatus(kind, text, path) {
  const dot = $("statusDot");
  dot.className = "dot" + (kind === "scanning" ? " scanning" : kind === "bad" ? " bad" : "");
  $("statusText").textContent = text;
  // Clipped in the bar, whole inside the popover. The end of a stats path is the part
  // worth reading; the beginning is C:\Program Files (x86)\Steam\steamapps every time.
  $("statusPath").textContent = path || "";
  const full = $("statusPathFull");
  if (full) full.textContent = path || "no folder yet";
}

/**
 * Stamp the running bundle into the status bar.
 *
 * Short form on screen, full timestamp in the tooltip. Electron holds a single-instance
 * lock, so `npm start` with a window already open focuses the old window instead of
 * replacing it: the app looks restarted while running the previous build. This is how
 * that shows up rather than being deduced an hour later.
 */
function showBuild(build) {
  const el = $("buildStamp");
  if (!el) return;
  if (!build || build === "dev") {
    el.textContent = "dev build";
    el.title = "Running from source, with no build stamp";
    return;
  }
  const when = new Date(build);
  el.textContent = Number.isNaN(when.getTime())
    ? "build " + build
    : "build " + when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  el.title = "Bundle built " + build;
}

function showError(message) {
  const banner = $("banner");
  banner.classList.remove("notice");
  if (!message) {
    banner.classList.remove("on");
    return;
  }
  banner.textContent = message;
  addDismiss(banner);
  banner.classList.add("on");
  playSound("error");
}

/**
 * A close control on the banner. It had none, so an error stayed over every screen the
 * player went on to until something else happened to replace it.
 */
function addDismiss(banner) {
  const close = document.createElement("button");
  close.type = "button";
  close.className = "banner-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "\u00d7";
  close.addEventListener("click", () => banner.classList.remove("on"));
  banner.append(close);
}

/**
 * Put a scenario's exact name on the clipboard, and say so on the name that was clicked.
 *
 * KovaaK's registers no URL scheme and its search wants the name as written, so this is
 * the shortest honest route from a tile to the scenario: nobody should have to retype
 * "Air CELESTIAL No UFO Easy Slowed" by hand. The confirmation sits on the name itself
 * for a moment rather than in the banner, because the banner is for news and a copy the
 * player just asked for is not news.
 */
function makeCopyable(el, name) {
  el.classList.add("copy-name");
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.title = name + " · click to copy";
  const copy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(name);
    } catch {
      return;
    }
    el.classList.add("copied");
    clearTimeout(el._copiedTimer);
    el._copiedTimer = setTimeout(() => el.classList.remove("copied"), 1400);
  };
  el.addEventListener("click", copy);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    void copy(e);
  });
}

/** The same banner, for something that worked. `quiet` for news nobody just asked for. */
/**
 * A found folder with no runs in it is a new KovaaK's install, not a missing folder. The
 * first-run panel kept saying "Find your stats folder" beside a status bar reading
 * "Watching", and pointed every locked tab at the folder chooser.
 */
function paintFolderFound() {
  const banner = $("banner");
  if (current || !currentPath || (banner.classList.contains("on") && !banner.classList.contains("notice"))) return;
  $("emptyHead").textContent = "Found your KovaaK's stats";
  $("emptyText").textContent = "Play any scenario in KovaaK's and it shows up here.";
  $("emptyPath").textContent = currentPath;
  $("emptyPath").hidden = false;
  $("emptyHelp").hidden = true;
  const choose = $("emptyChoose");
  choose.textContent = "Change folder";
  choose.classList.add("secondary");
}

/** Not found: the button becomes the one thing to do, and the path is one click away. */
function paintFolderMissing() {
  $("emptyHead").textContent = "Couldn't find your KovaaK's stats folder";
  $("emptyText").textContent = "Choose it once and Apogee remembers it.";
  $("emptyPath").hidden = true;
  $("emptyHelp").hidden = false;
  const choose = $("emptyChoose");
  choose.textContent = "Choose folder";
  choose.classList.remove("secondary");
}

function showNotice(message, quiet = false) {
  const banner = $("banner");
  banner.textContent = message;
  addDismiss(banner);
  banner.classList.add("on", "notice");
  if (!quiet) playSound("ok");
}

/**
 * Make a failure visible instead of letting it stop the app quietly.
 *
 * The `api is not defined` bug above survived because nothing was watching it. It threw
 * inside a promise chain with no `.catch`, the rejection went to a console nobody had
 * open, and the screen simply stopped half-rendered. Signed in, that looked like a
 * first-run screen that never advanced - a broken state with no error anywhere in it.
 *
 * So every unhandled rejection and every uncaught error now reaches the banner and turns
 * the status dot red. This repairs nothing; it means a broken build says so on the first
 * screen, rather than being deduced from a screenshot an hour later. `npm run smoke`
 * rejects a promise on purpose and fails unless the banner picks it up.
 */
function reportFailure(kind, err) {
  const message = err && err.message ? err.message : String(err || "unknown error");
  try {
    showError(kind + ": " + message);
    // The preview strips the status bar out entirely; the banner exists in both hosts.
    if ($("statusDot")) {
      setStatus("bad", "Problem", typeof currentPath === "string" ? currentPath : "");
    }
  } catch {
    // A reporter that throws on its way to reporting would hide the very thing it is
    // here to show. Whatever is left of the app keeps running.
  }
}

window.addEventListener("unhandledrejection", (e) => reportFailure("Background failure", e.reason));
window.addEventListener("error", (e) => reportFailure("Failure", e.error || e.message));

/* ------------------------------------------------------------------ render */

let current = null;
let selectedCategory = null;
/** Scenarios the current match asks for, ticked off as runs land. */
let pendingScenarios = [];
/** Which match `pendingScenarios` belongs to, so a repaint keeps rows already played. */
let pendingMatchId = null;

/**
 * The rating is the server's. The snapshot used to carry one worked out from a fixed
 * series of made-up results, so every player saw the same number and it never moved -
 * the one figure a ranked 1v1 has to move. Signed out or unplayed reads "unrated".
 */
let standing = null;
function paintRating() {
  renderSetup();
  const me = current?.player?.apogee;
  const rated = HOST !== "electron" ? me : standing && standing.matchesPlayed > 0 ? standing : null;
  $("myRating").textContent = rated ? Math.round(rated.rating) + " \u00b1" + Math.round(rated.rd) : "unrated";
  const hero = $("heroRating");
  if (!hero) return;
  if (rated) {
    countTo(hero, rated.rating);
    countTo($("heroRd"), rated.rd, (v) => "\u00b1" + Math.round(v) + " uncertainty");
  } else {
    hero.textContent = "Unrated";
    $("heroRd").textContent = HOST === "electron" && !standing && !signedIn
      ? "sign in to play rated" : "play a rated match to place";
  }
}
function refreshStanding() {
  if (HOST !== "electron" || !api || !api.getStanding) return;
  api.getStanding().then((s) => {
    standing = s && !s.error ? s : null;
    paintRating();
  }).catch(() => undefined);
}
/** Whether a Steam session is present, for the queue button's wording. */
let signedIn = false;

function render(data) {
  lastSnapshot = data;
  current = data;
  renderSetup();
  $("app").hidden = false;
  $("empty").hidden = true;
  document.body.classList.remove("awaiting-data");
  $("whoami").hidden = false;

  const me = data.player.apogee;
  // No season run yet: the snapshot still derives a tier from percentile 0, which named the
  // player the lowest rank while "next rank" named the same one. Unplaced is the fact.
  const placed = !!data.player.benchmarkRank;
  const tierName = placed ? me.tier.name : "Unplaced";

  // The whole chrome takes the player's rank colour: the selected tab's number, focus
  // rings, the badge, the one tile on the pool screen that is an instruction. The
  // alternative is a brand accent sitting next to the rank colour and competing with
  // the one signal that means something here.
  document.documentElement.style.setProperty("--accent", me.tier.color);

  $("myBadge").innerHTML = badge(me.tier, "me");
  $("myTier").textContent = tierName;
  $("myTier").style.color = legibleOnDark(me.tier.color, RANK_TEXT_CONTRAST);
  paintRating();
  // A streak counts from yesterday, so zero means nothing yesterday or today. "0-day
  // streak" was the first thing under a new player's name; the fact worth saying is how
  // to start one.
  $("myStreak").textContent = data.player.streak > 0
    ? data.player.streak + "-day streak"
    : "Start a streak today";

  $("heroBadge").innerHTML = badge(me.tier, "hero");
  document.querySelector(".rank-showcase").dataset.material = String(me.tier.id || "tier-1");
  $("heroName").textContent = tierName;
  $("heroName").style.color = legibleOnDark(me.tier.color, RANK_TEXT_CONTRAST);

  // Three separate facts, so they read as three. Run together on one line they were a
  // caption, and nobody reads a caption under a 34px tier name.
  // The four that move because the player played. The tier name, the scenario count and
  // the placement sentence below are not counters - they change by becoming a different
  // thing, not by travelling to a new value.
  paintRating();
  // "Top 100.0%" is a placement nobody has; below the lowest rung it is simply unplaced.
  if (placed) countTo($("heroPercentile"), Math.min(99.9, 100 - me.percentile), (v) => "top " + v.toFixed(1) + "%");
  else {
    const el = $("heroPercentile");
    if (el._countRaf) cancelAnimationFrame(el._countRaf);
    el._countRaf = 0;
    el._countValue = undefined;
    el.textContent = "not placed yet";
  }
  countTo($("heroRuns"), data.player.totalRuns, num);
  countTo(
    $("heroScenarios"),
    data.player.scenarioCount,
    (v) => "across " + Math.round(v) + " scenarios",
  );
  $("heroPlacement").textContent = data.player.benchmarkRank
    ? "Provisional. Estimated from your " + data.benchmark.name + " scores (" +
      num(data.player.benchmarkEnergy) + " season energy) until there is a live population."
    : "Play any " + data.benchmark.name + " scenario to be placed.";

  renderClimb(data);
  renderCommandFocus(data);
  prepareScrollRegions();
  renderCategories(data);
  renderPool(data);

  // The snapshot carries an illustrative match with an invented opponent, which is
  // useful in the preview and dishonest in the real client. In the app it is shown only
  // until a genuine result exists, and is replaced by an empty state instead.
  if (HOST === "electron" && !hasRealResult) renderNoResultYet();
  else if (HOST !== "electron") renderResult(data);

  renderRanks(data);
  renderSeasonView(data);
  renderScenarioRanks();
  renderProfile(data);
  renderCoverage(data);
  renderConsistency(data);
  renderQuests(data);

  $("footnote").textContent =
    (HOST === "electron"
      ? "Read from your KovaaK's stats folder"
      : "Static preview · example opponent") +
    " · " + num(data.player.totalRuns) + " runs · snapshot " +
    new Date(data.generatedAt).toLocaleString();

  // Every bar queued by the screens above, moved together. One forced layout for the
  // whole pass rather than one per bar, which on the ranks screen would be two dozen.
  flushFills();
}

/**
 * How much of the current rank is behind you, and whose name is above it.
 *
 * `progressToNextRank` and `nextRankName` were on every snapshot and rendered nowhere.
 * The screen the player presses Queue on said what they are and never what they are
 * climbing towards, which is the only reason to press it - so the one derived figure
 * that answers "what is this for" was the one figure being thrown away.
 *
 * The target's own colour on the target's name, because that is what the ladder uses
 * everywhere else and a rank named in plain ink reads as a label rather than a rank.
 */
function renderClimb(data) {
  const box = $("heroClimb");
  if (!box) return;

  const next = data.player.nextRankName;
  const at = data.player.progressToNextRank;

  // Nothing above the top rank, and nothing to draw for a player the snapshot has no
  // progress figure for. An empty bar reads as zero progress, which is a claim.
  if (!next || typeof at !== "number" || !Number.isFinite(at)) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  // Two ladders share one set of names: the tier above is a population percentile, this
  // is the benchmark rank the energy earns. Unlabelled, the card read "Current rank
  // Lunar" over "Next benchmark rank Lunar, 93% there" on the committed snapshot, which
  // says the player is climbing towards where they already are. Naming the rank being
  // climbed from makes it two facts rather than one contradiction; the Ranks screen uses
  // the same two names for the same two panels.
  const from = data.player.benchmarkRank;
  $("heroClimbFrom").textContent = from ? "Benchmark rank " + from + " →" : "Next benchmark rank";
  $("heroClimbTo").textContent = next;
  $("heroClimbTo").style.color = rankInk(data, next);
  $("heroClimbPct").textContent = Math.round(at * 100) + "% there";
  setFill($("heroClimbFill"), at);
}

/**
 * Which difficulty a match draws from, and whether the player is measured on it.
 *
 * A match is decided on delta against your own baseline, so a difficulty with no history
 * behind it cannot be graded: half rating weight at best, void at worst. With several
 * difficulties in a season, nothing on screen said which one the player was about to be
 * handed.
 */
/**
 * The scenarios a match can actually draw, and your best on each.
 *
 * The queue screen said "baselines on 4 of 6 of its scenarios" and never which six, which
 * is the one thing a player wants before pressing the button: a match is three of these,
 * and a scenario with no baseline is scored against nothing you have set. Reading the
 * practice pool rather than the snapshot's category rows on purpose - those carry one row
 * per family at whichever variant earned its rank, so filtering them by window returns the
 * scenarios that graded you rather than the ones you are about to be handed.
 */
function renderDraw(data) {
  const box = $("drawPanel");
  const host = $("drawRows");
  if (!box || !host) return;

  const all = practice && Array.isArray(practice.scenarios) ? practice.scenarios : null;
  const window = data.benchmark.matchPool ? data.benchmark.matchPool.window : null;
  if (!all || window === null || window === undefined) {
    box.hidden = true;
    return;
  }

  const everyCategory = selectedCategory === null || selectedCategory === "Any";
  const rows = all.filter(
    (s) => s.window === window && (everyCategory || s.category === selectedCategory),
  );
  if (rows.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  // `measured`, not `runs > 0`: a baseline needs enough runs for a median, and counting
  // any single run put this line at five where the pool note above it said four. One
  // screen, two numbers for the same fact, is worse than the number being absent.
  const measured = rows.filter((r) => r.measured).length;
  const count = $("drawCount");
  if (count) {
    count.textContent =
      rows.length + " scenarios · " + measured + " with a baseline";
  }

  host.textContent = "";
  let heading = null;
  for (const r of rows) {
    // Queueing Any draws from every category, so the list says which is which. One
    // category needs no heading: the chip above it already answered that.
    if (everyCategory && r.category !== heading) {
      const h = document.createElement("div");
      h.className = "draw-cat";
      h.textContent = r.category;
      host.append(h);
      heading = r.category;
    }

    const el = document.createElement("div");

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = r.label;
    nm.title = r.scenario;

    const sk = document.createElement("span");
    sk.className = "sk";
    sk.textContent = r.subCategory ?? "";

    const meter = document.createElement("span");
    meter.className = "meter";
    const bar = document.createElement("span");
    bar.className = "meter-fill";
    meter.append(bar);

    const base = document.createElement("span");
    base.className = "base";

    // Two bars, two meanings, decided by whether this scenario could grade a match at
    // all. A scenario that can shows how far into its next rank the player's best sits;
    // one that cannot shows the runs left before it can, which is the only one of the
    // two that is a reason to go and play something. `needsFor` reads the count off the
    // snapshot's own coverage rather than repeating MIN_RUNS_FOR_BASELINE here, so the
    // two cannot drift.
    if (r.measured) {
      const at = typeof r.progress === "number" ? r.progress : 0;
      setFill(bar, at);
      base.textContent = r.best === null ? "unplayed" : pts(r.best);
      base.title =
        num(r.runs) + " runs · baseline set" +
        (r.nextRankScore !== null && r.gap !== null
          ? " · " + need(r.gap) + " points to next rank"
          : "");
      el.className = "draw-row";
    } else {
      const left = needsFor(data, r.scenario);
      const of = r.runs + (left ?? 0);
      setFill(bar, of > 0 ? r.runs / of : 0);
      // A best that is not yet a baseline is still the player's own number, so it stays
      // in the title rather than being hidden. What the column says is the thing they
      // can act on.
      base.textContent =
        left === null ? "no baseline" : left + (left === 1 ? " run to go" : " runs to go");
      base.title =
        (r.runs === 0
          ? "no runs yet"
          : (r.runs === 1 ? "1 run" : num(r.runs) + " runs") + ", best " + pts(r.best)) +
        " · no baseline, scored against an estimate";
      el.className = "draw-row short" + (r.runs === 0 ? " none" : "");
    }

    const who = document.createElement("span");
    who.className = "draw-name";
    who.append(nm, sk);

    // Every row opens its scenario, the way the match rows do. The note by the button
    // told a new player to "play a few runs on those first", and this list was the only
    // place that named them, with nothing in it to press.
    el.append(who, meter, base, playButton(r.scenario) ?? document.createElement("span"));
    host.append(el);
  }

  const legend = $("drawLegend");
  if (legend) {
    legend.innerHTML =
      "Each match draws 3 at random. Bar shows <b>progress to next rank</b> where you " +
      "have a baseline, and <b>runs toward a baseline</b> where you don't.";
  }
}

/**
 * Runs still needed before a scenario holds a baseline, or null if it is not in coverage.
 *
 * The snapshot already computes this per scenario, so reading it is the difference
 * between one definition of "enough runs" and two that can disagree on screen.
 */
function needsFor(data, scenario) {
  for (const c of data.coverage ?? []) {
    for (const s of c.scenarios ?? []) {
      if (s.scenario === scenario) return typeof s.needs === "number" ? s.needs : null;
    }
  }
  return null;
}

function renderPool(data) {
  renderDraw(data);
  const btn = $("queueBtn");
  if (btn && !btn.classList.contains("working") && !btn.classList.contains("held")) {
    $("queueSub").textContent = commitSub(data);
    $("queueMeta").textContent = "matched on rating";
  }

  const note = $("poolNote");
  if (!note) return;

  const pool = data.benchmark.matchPool;
  const name = data.benchmark.matchPoolName;
  const coverage = data.coverage ?? [];

  if (!name || coverage.length === 0) {
    note.hidden = true;
    return;
  }

  note.hidden = false;

  // The category being queued, or every category when queueing Any.
  const relevant = coverage.filter(
    (c) =>
      c.window === pool.window &&
      (selectedCategory === "Any" || selectedCategory === null || c.category === selectedCategory),
  );

  const short = relevant.filter((c) => !c.matchable);
  const measured = relevant.reduce((n, c) => n + c.measured, 0);
  const total = relevant.reduce((n, c) => n + c.total, 0);

  if (short.length === 0) {
    note.className = "pool-note";
    note.innerHTML =
      `Matches draw from <b>${esc(name)}</b>. Baselines on ${measured} of ${total} ` +
      `scenarios.`;
    return;
  }

  note.className = "pool-note warn";
  note.innerHTML =
    `Matches draw from <b>${esc(name)}</b>. Baselines on only ` +
    `${measured} of ${total} scenarios` +
    `${short.length < relevant.length ? ` (short in ${esc(short.map((c) => c.category).join(", "))})` : ""}. ` +
    `A scenario without a baseline is scored against an estimate, which halves the ` +
    `match's weight and can void it. Play a few runs on those first.`;

  // "Those" were named only in the folded Scenario pool panel at the foot of the page, so
  // the sentence pointed at a list nobody could see from here.
  const draw = $("drawPanel");
  if (draw && !draw.hidden) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "pool-go";
    go.textContent = "Show which";
    go.addEventListener("click", () => {
      draw.open = true;
      draw.scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" });
    });
    note.append(go);
  }
}

/**
 * The one control on this screen, and the only place its text is written.
 *
 * It used to be a bare button whose label was assigned from five different places with
 * `textContent`, which is also why it could only ever say one word. It now carries what
 * pressing it will do - the category and the difficulty, the two facts that decide the
 * next ten minutes and which used to live two panels apart - so the sentence and the
 * button cannot drift apart.
 */
function setCommit(state, verb, sub, meta) {
  const btn = $("queueBtn");
  if (!btn) return;
  btn.classList.toggle("working", state === "working");
  btn.classList.toggle("held", state === "held");
  // Searching is the one state the orb field reacts to; see the orb notes in index.html.
  document.body.dataset.queue = state;
  paintQueueJourney(state);
  // And the one state that owns a WebGL context. Driven from here rather than from the
  // six call sites that reach it, so the context cannot outlive the search that made it.
  if (state === "working") mountSearchOrb();
  else unmountSearchOrb();
  $("queueVerb").textContent = verb;
  $("queueSub").textContent = sub ?? "";
  $("queueMeta").textContent = meta ?? "";
  setQueueLive(state, verb, meta);
}

/**
 * The same state, on the bar that never scrolls.
 *
 * Driven from `setCommit` rather than from the six call sites that reach it, so the bar
 * cannot disagree with the button: there is one place that decides what the queue is
 * doing and it now tells both. Idle says nothing at all - a chip reading "not queued" is
 * a permanent reminder of nothing.
 */
function setQueueLive(state, verb, meta) {
  const chip = $("queueLive");
  if (!chip) return;

  chip.hidden = state === "idle";
  chip.classList.toggle("held", state === "held");
  if (chip.hidden) return;

  $("queueLiveText").textContent = verb;
  $("queueLiveMeta").textContent = meta ?? "";
  chip.title =
    state === "working" ? "Searching · click to view" : "Open your match";
}

/** What a press would queue, in the button. */
function commitSub(data) {
  const where = !selectedCategory || selectedCategory === "Any"
    ? "Any category"
    : selectedCategory;
  const pool = data.benchmark.matchPoolName;
  return where + (pool ? " · " + pool : "") + " · 3 scenarios";
}

/** Back to offering a match, whatever it was last saying. */
function resetCommit(data) {
  const btn = $("queueBtn");
  if (!btn) return;
  // Signed out, the button used to say Find opponent, play the search, and then answer
  // "sign in first". It says what pressing it will actually do.
  if (HOST === "electron" && !signedIn) {
    setCommit("idle", "Sign in to queue", "Ranked uses your Steam account", "");
    btn.disabled = false;
    return;
  }
  setCommit("idle", "Find opponent", data ? commitSub(data) : "", "matched on rating");
  if (btn.dataset.gated !== "1") btn.disabled = false;
}

/* ============================================================ searching orb */

/**
 * A sphere with light moving inside it, while the server is looking for an opponent.
 *
 * Ported from a WebGL component published as a React one, and the port is the whole
 * point: the client has no React, no bundler for the renderer and a `script-src 'self'`
 * policy. A fragment shader survives all three - the GLSL is compiled by the driver, not
 * evaluated as script, so the policy has no opinion about it - while the component
 * around it does not.
 *
 * Two things were changed rather than copied.
 *
 * The colour ramp is inverted. The original builds up from vec3(0.99, 1.0, 1.0), so it
 * is a near-white sphere with the tint showing through the shaded side. On this app's
 * ground that is a 148px headlight, in a client whose stylesheet opens by saying nothing
 * is elevated. Here the ramp starts at the ground itself and climbs to --accent, so the
 * sphere is dark and the light is inside it. Same noise, opposite polarity.
 *
 * The lifetime is bounded. The original mounts with its component and runs until it
 * unmounts. This is created when the queue starts working and destroyed when it stops,
 * because a browser will only hand out a handful of WebGL contexts before it starts
 * dropping the oldest, and a client somebody leaves open all evening should not be
 * holding one to animate a state it left twenty minutes ago.
 */

const ORB_VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Domain-warped value noise: fbm of a point that has itself been displaced by fbm. That
 * is what makes the motion read as fluid rather than as a cloud sliding past - the warp
 * turns straight drift into something that folds.
 */
const ORB_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_color;
uniform vec3 u_ground;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.6;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.22;

  vec2 drift = vec2(
    sin(t) + 0.6 * sin(t * 1.7 + 1.3),
    cos(t * 0.8) + 0.6 * cos(t * 1.3 + 2.1)
  );

  vec2 p = vec2(uv.x * 1.8, uv.y * 1.0) + drift * 0.7;

  vec2 q = vec2(fbm(p + drift), fbm(p + vec2(3.2, 1.5) - drift));
  float f = fbm(p + 1.2 * q);

  float g = clamp(1.0 - uv.y, 0.0, 1.0);
  float anchor = smoothstep(0.0, 0.3, uv.y);
  float shade = clamp(g + (f - 0.5) * 0.8 * anchor, 0.0, 1.0);

  // Dark to lit, rather than the original's white to tinted. The base sits a little
  // off the ground so the disc has an edge to find; everything above it is accent.
  vec3 base = mix(u_ground, u_color, 0.10);
  vec3 mid  = mix(u_ground, u_color, 0.60);
  vec3 hot  = mix(u_color, vec3(1.0), 0.22);

  vec3 col = base;
  col = mix(col, mid, smoothstep(0.26, 0.56, shade));
  col = mix(col, hot, smoothstep(0.62, 0.92, shade));

  float edge = smoothstep(0.5, 0.49, distance(uv, vec2(0.5)));
  gl_FragColor = vec4(col * edge, edge);
}
`;

/** `#rrggbb` to the 0-1 triple a uniform wants. */
function orbRgb(hex, fallback) {
  const h = String(hex ?? "").replace("#", "").trim();
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return fallback;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function orbCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // Not thrown: a driver that will not compile this should cost the player an
    // animation, not the queue screen.
    console.error("searching orb:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** Everything the running orb owns, so unmount can put all of it back. */
let searchOrb = null;

function mountSearchOrb() {
  const host = $("orbSearch");
  if (!host || searchOrb) return;

  const canvas = document.createElement("canvas");
  // `alpha` so the ground shows through outside the disc, `antialias` off because the
  // only edge in the image is the one the shader already feathers itself.
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false });
  if (!gl) return;   // No WebGL: the button's sweep is still saying the same thing.

  const program = gl.createProgram();
  const vert = orbCompile(gl, gl.VERTEX_SHADER, ORB_VERT);
  const frag = orbCompile(gl, gl.FRAGMENT_SHADER, ORB_FRAG);
  if (!program || !vert || !frag) return;

  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("searching orb:", gl.getProgramInfoLog(program));
    return;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Both colours are read off the live stylesheet rather than written here: --accent is
  // the player's own tier colour and is rewritten on every snapshot, so the orb is their
  // colour, and --ground is the value the ramp above is built to start from.
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const ground = css.getPropertyValue("--ground").trim();
  gl.uniform3f(gl.getUniformLocation(program, "u_color"), ...orbRgb(accent, [0.54, 0.57, 0.59]));
  gl.uniform3f(gl.getUniformLocation(program, "u_ground"), ...orbRgb(ground, [0.12, 0.11, 0.09]));

  // Capped at 2: past that the shader is filling pixels nobody can resolve, and this is
  // the one place in the client running a per-pixel loop.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(148 * dpr);
  canvas.width = px;
  canvas.height = px;
  gl.viewport(0, 0, px, px);
  gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), px, px);
  const uTime = gl.getUniformLocation(program, "u_time");

  host.textContent = "";
  host.appendChild(canvas);
  host.hidden = false;

  // Reduced motion keeps the sphere and stops the weather: one frame, no loop. Same
  // bargain the orb field behind the app makes.
  const still = reduceMotion.matches;
  const start = performance.now();
  let raf = 0;
  const draw = (now) => {
    gl.uniform1f(uTime, still ? 0 : (now - start) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (!still) raf = requestAnimationFrame(draw);
  };

  // A lost context leaves a blank canvas behind and never recovers on its own. Rebuild
  // once, on the next frame, and only while the queue is still working.
  const onLost = (e) => {
    e.preventDefault();
    unmountSearchOrb();
    if (document.body.dataset.queue === "working") requestAnimationFrame(mountSearchOrb);
  };
  canvas.addEventListener("webglcontextlost", onLost);

  searchOrb = {
    stop() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      gl.deleteBuffer(buffer);
      // Ask the driver for the context back rather than waiting to be garbage collected:
      // the limit is on live contexts, not on unreachable ones.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
  draw(start);
}

/**
 * Bars, with the same rule the counters follow: move on a change, not on arrival.
 *
 * `setFill` alone cannot animate on these screens. A transition needs a previous value
 * committed to a live element, and a bar that was created a moment ago has none - it
 * simply renders at its final width, which is why the band cards' bars have never moved
 * despite the transition on them.
 *
 * So a bar with a remembered value is painted at the old one first and told the new one
 * afterwards. That costs a reflow to commit the starting frame, and doing it per bar
 * would be two dozen forced layouts in a loop on the ranks screen - so callers queue
 * their bars and `flushFills` pays for one reflow on behalf of all of them.
 */
const pendingFills = [];

function fillTo(el, share, key) {
  if (!el) return;
  const to = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  const from = lastReadout.get(key);
  lastReadout.set(key, to);

  if (from === undefined || from === to || reduceMotion.matches) {
    setFill(el, to);
    return;
  }
  setFill(el, from);
  pendingFills.push([el, to]);
}

/** One forced layout for every bar queued since the last flush, then the new values. */
function flushFills() {
  if (pendingFills.length === 0) return;
  // Reading a layout property is what commits the starting transforms above; without it
  // the browser coalesces both writes and the bar arrives at its new value with no
  // transition. `void` because the value is not wanted, only the side effect.
  void document.body.offsetWidth;
  for (const [el, to] of pendingFills) setFill(el, to);
  pendingFills.length = 0;
}

function unmountSearchOrb() {
  const host = $("orbSearch");
  if (searchOrb) {
    searchOrb.stop();
    searchOrb = null;
  }
  if (host) {
    host.hidden = true;
    host.textContent = "";
  }
}

let searchTimer = null;

/** Seconds the server has been looking. The one honest thing to show while waiting. */
function startSearchClock() {
  const started = Date.now();
  stopSearchClock();
  const tick = () => {
    const total = Math.floor((Date.now() - started) / 1000);
    const clock = Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    $("queueMeta").textContent = clock;
    // The clock is written here rather than through setCommit, so the bar is written here
    // too. A chip that froze at 0:00 while the button counted would read as a stuck queue.
    if ($("queueLiveMeta")) $("queueLiveMeta").textContent = clock;
  };
  tick();
  searchTimer = setInterval(tick, 1000);
}

function stopSearchClock() {
  if (searchTimer) clearInterval(searchTimer);
  searchTimer = null;
}

/**
 * The queue category, remembered.
 *
 * Somebody who queues Reactive Tracking every evening should not be handed their weakest
 * category on every launch instead. Per machine, like the last screen: a view preference
 * main has no business knowing. A category the season no longer has falls back to the
 * weakest rather than to a queue for nothing.
 */
const QUEUE_CATEGORY_KEY = "apogee.queueCategory";

function rememberedCategory(data) {
  let name = null;
  try {
    name = localStorage.getItem(QUEUE_CATEGORY_KEY);
  } catch {
    return null;
  }
  return name === "Any" || data.categories.some((c) => c.name === name) ? name : null;
}

function renderCategories(data) {
  const host = $("cats");
  host.textContent = "";
  if (selectedCategory === null) selectedCategory = rememberedCategory(data) ?? data.weakest;
  paintDiscipline(selectedCategory);

  ["Any"].concat(data.categories.map((c) => c.name)).forEach((name) => {
    const b = document.createElement("button");
    b.className = "cat";
    b.type = "button";
    const d = disciplineOf(name);
    b.dataset.discipline = d.key;
    b.style.setProperty('--discipline', d.ink);
    b.innerHTML = '<svg class="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d.path + '</svg>' +
      '<span><span class="cat-name">' + esc(name === "Any" ? "All categories" : name) +
      (name === data.weakest ? '<span class="cat-weak">Focus</span>' : '') +
      '</span><span class="cat-description">' + d.cue + '</span></span><span class="cat-check" aria-hidden="true"></span>';
    b.setAttribute("aria-label", name === data.weakest ? name + ", your weakest category" : name === "Any" ? "All categories" : name);
    b.setAttribute("aria-pressed", String(name === selectedCategory));
    b.addEventListener("click", () => {
      selectedCategory = name;
      try {
        localStorage.setItem(QUEUE_CATEGORY_KEY, name);
      } catch {
        /* A choice that cannot be stored still applies to this session. */
      }
      paintDiscipline(name);
      renderPool(data);
      Array.prototype.forEach.call(host.children, (c) =>
        c.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      // The choice is kept for the next queue; the match on screen stays put.
      if (activeMatch) return;
      $("opponent").classList.remove("on");
      resetCommit(data);
      renderEligibility();
    });
    host.append(b);
  });
}

/**
 * How the round is expected to go, drawn as one bar.
 *
 * Your side takes the rank colour and theirs takes a grey, rather than one rank colour
 * each. Queueing matches on rating, so most opponents hold the same rank you do - which
 * made the common case a single solid block of one colour and the split invisible. The
 * question this bar answers is how much of it is yours, and that has one subject.
 */
function drawOdds(p, color) {
  const yours = Math.max(0, Math.min(1, p));
  $("oddsBar").innerHTML =
    '<div style="flex:' + yours + ';background:' + esc(legibleOnDark(color, RANK_TEXT_CONTRAST)) + '"></div>' +
    '<div style="flex:' + (1 - yours) + ';background:var(--rule-3);' +
    'border-left:1px solid var(--well)"></div>';
}

function showOpponent(data) {
  const m = data.match;
  const me = data.player.apogee;

  $("oppBadge").innerHTML = badge(m.opponent.tier, "opp");
  $("oppName").textContent = m.opponent.name;
  $("oppTier").textContent = m.opponent.tier.name + " · " + m.opponent.rating;
  $("oppTier").style.color = legibleOnDark(m.opponent.tier.color, RANK_TEXT_CONTRAST);
  $("oppAge").textContent = "Example opponent · synthetic runs";

  const p = m.winProbability;
  drawOdds(p, me.tier.color);
  $("oddsYou").textContent = "you " + (p * 100).toFixed(0) + "%";
  $("oddsThem").textContent = (100 - p * 100).toFixed(0) + "% " + m.opponent.name;

  pendingScenarios = m.rounds.map((r) => ({ label: r.label, done: false }));
  renderTodo(true);

  arrive($("opponent"));
}

/* ----------------------------------------------------------- season editor */

/**
 * Edit the season this machine grades against.
 *
 * The working copy is held here and written only on Save, so a half-typed threshold
 * never becomes what the app measures people by. Main validates again before writing:
 * this side exists to make the edit pleasant, not to be the thing that guarantees it,
 * and a renderer is the wrong place for a rule that decides what a rank means.
 */
let seasonDraft = null;
/** The season and pool as they were when `seasonDraft` was taken. Null on an old main. */
let seasonFingerprint = null;
/** `data/apogee_ranks.json`, edited on the same screen and saved by the same button. */
let rankTheme = null;
let rankThemeFingerprint = null;
let rankThemeDirty = false;
/** Set after a refused save, so pressing Save again writes over what is on disk. */
let seasonForce = false;
/**
 * Energy one rank of one family is worth.
 *
 * Owned by src/core/benchmarks/energy.ts and delivered with the season, because the
 * renderer is a pure view and cannot import from the core. This was a literal 2500
 * inline in rebalanceEnergy - a third copy of a constant with one owner, which would
 * have let the season editor compute a different ladder to everything that grades a
 * score. The initialiser is a fallback for an older main process, not a default.
 */
let energyPerRank = 2500;

/**
 * Which window each category is being edited at.
 *
 * The editor used to lay all of it out at once: three categories, fifty-four scenarios and
 * twelve threshold columns in one table. Every number in it was reachable and none of them
 * was findable. A season is edited one difficulty at a time - that is how the thresholds
 * were decided and how they are read back - so the table follows, six scenarios against
 * four ranks, and the rest is a dropdown away rather than on screen.
 *
 * Kept per category rather than globally, because comparing Clicking Easy against Tracking
 * Hard is a real thing to want and a single shared selector would forbid it.
 */
const seasonWindowFor = new Map();

function seasonWindowOf(category) {
  return seasonWindowFor.get(category) ?? 0;
}

/**
 * A scenario slot nobody has filled yet.
 *
 * Adding a family and adding a difficulty are the same act from the season's point of
 * view: both create ranks that exist and have nothing measuring them. Rather than two
 * flows, both create *empty slots*, and filling a slot is one interaction wherever it came
 * from. The season cannot be saved while any slot is empty - which is the honest state,
 * since a family missing a window makes the ranks it covers unreachable.
 */
function isEmptySlot(scenario) {
  return !scenario.scenario;
}

/**
 * Entries the season cannot grade, and which nothing on screen shows.
 *
 * A scenario with no family, no window, or a category the season does not define renders
 * in no category block at all - so it is invisible, unremovable, and fails validation on
 * Save naming something the owner cannot find. Listing them is the difference between a
 * refusal and a fix.
 */
function seasonOrphans() {
  if (!seasonDraft || seasonWindowSize() <= 0) return [];
  const categories = new Set(seasonDraft.categories.map((c) => c.name));

  return seasonDraft.scenarios.filter(
    (x) =>
      !x.family ||
      typeof x.window !== "number" ||
      !categories.has(x.category),
  );
}

/** Every unfilled slot in the draft, for the Save gate. */
function seasonGaps() {
  if (!seasonDraft) return [];
  const emptyCategories = seasonDraft.categories
    .filter(c => !seasonDraft.scenarios.some(s => s.category === c.name))
    .map(c => `${c.name} needs a family, or remove the category`);
  return seasonDraft.scenarios
    .filter(isEmptySlot)
    .map((x) => `${x.family ?? "?"} · ${windowLabel(x.window ?? 0)}`).concat(emptyCategories);
}

/**
 * The percentiles each window's ranks sit at.
 *
 * Carried on the season by buildSeason. Without it a newly added scenario has nothing to
 * derive thresholds against, and the editor says so rather than inventing four numbers.
 */
function seasonLadder(window) {
  return seasonDraft?.derivedFrom?.perWindow?.[window] ?? null;
}

/* ---------------------------------------------------- rank colour readability */
/*
 * Mirrors core/report/contrast.ts. The renderer cannot import core - it is a plain script
 * with no bundler - so the arithmetic is repeated here and the two are kept deliberately
 * identical. Both grounds and the threshold are the same values; if one moves, move both -
 * and DARK_GROUND is also `--ground` in this file's own :root and DARK_CHROME.ground in
 * core/report/contrast.ts, which is the list the last palette change was missed on.
 *
 * It is worth the duplication: a colour that disappears is invisible to the person
 * choosing it, because the editor's own background is neither of the grounds it has to
 * survive, and finding out from a generated sheet after the fact is finding out too late.
 */
const DARK_GROUND = "#10121b";
const LIGHT_GROUND = "#eef1f6";
const MIN_CONTRAST = 2;

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Blend two hex colours, `pct` percent of the way from `a` to `b`. */
function mixHex(a, b, pct) {
  const hex = (c) => parseInt(/^#?([0-9a-f]{6})$/i.exec(String(c).trim())[1], 16);
  const x = hex(a);
  const y = hex(b);
  const t = pct / 100;
  const ch = (sh) => Math.round((((x >> sh) & 255) * (1 - t)) + (((y >> sh) & 255) * t));
  return (
    "#" +
    [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, "0")).join("")
  );
}

/**
 * A rank colour moved far enough from a ground to be read on it.
 *
 * The authored colour is the identity and stays the identity - this only moves it to the
 * same 2:1 the season editor flags below. Sixteen of season 1's ranks sit under that line
 * on the dark ground and ten of those are under 1.5:1; Primate is #331400 at 1.01, and
 * Gauss Cannon, Singularity and Orca are #000000, which as a card accent draws something
 * that reads as broken rather than as dark. `npm run docs:ranks` prints the count, and the
 * sheet it writes names all sixteen.
 *
 * Correcting here rather than in the season file is deliberate. The colours are chosen to
 * match the names - Singularity is black because that is what a singularity is - and a fix
 * written into the data would both lose that and hide the fact that it was needed. Anything
 * already clear of the line is returned untouched, so this is invisible on a season whose
 * colours are fine.
 *
 * The mirror of `src/core/report/contrast.ts`, which the rank sheet and the season editor
 * use. The renderer runs as plain script in two hosts and cannot import it, so it is
 * written twice on purpose - but only once each way, which is why the ground is an argument
 * rather than two near-identical functions.
 */
function legibleOn(color, ground, min) {
  if (!/^#[0-9a-f]{6}$/i.test(String(color).trim())) return color;
  const floor = min ?? MIN_CONTRAST;
  const away = luminance(ground) > 0.4 ? DARK_GROUND : LIGHT_GROUND;
  let out = color;
  for (let pct = 5; pct <= 100 && contrastRatio(out, ground) < floor; pct += 5) {
    out = mixHex(color, away, pct);
  }
  return out;
}

const legibleOnDark = (color, min) => legibleOn(color, "#304c5c", min);
const legibleOnLight = (color, min) => legibleOn(color, LIGHT_GROUND, min);

/** Body-size rank labels meet 4.5:1 against the brightest standard control surface. */
const RANK_TEXT_CONTRAST = 4.5;

/** What is wrong with a rank colour, or null when nothing is. */
function colourNote(color) {
  const onDark = contrastRatio(color, DARK_GROUND);
  const onLight = contrastRatio(color, LIGHT_GROUND);
  const darkBad = onDark < MIN_CONTRAST;
  const lightBad = onLight < MIN_CONTRAST;

  if (darkBad && lightBad) return `unreadable on both grounds`;
  if (darkBad) return `disappears on dark (${onDark.toFixed(1)}:1)`;
  if (lightBad) return `disappears on light (${onLight.toFixed(1)}:1)`;
  return null;
}

/**
 * The rating ladder, presented the way the season's ladders are.
 *
 * A live view rather than a copy: the getters read `rankTheme.tiers` and the setters write
 * back into them, so an edit made through the rows below is an edit to the theme that gets
 * saved. Building a snapshot and copying it back afterwards was the obvious shape and it
 * loses a rename, because the rows key colours by name and a copy has no way to know which
 * old name a new one came from.
 */
function ratingLadder() {
  const tiers = () => (rankTheme && rankTheme.tiers) || [];
  return {
    get rankNames() {
      return tiers().map((t) => t.name);
    },
    set rankNames(names) {
      tiers().forEach((t, i) => { t.name = names[i]; });
    },
    rankColors: new Proxy({}, {
      ownKeys: () => tiers().map((t) => t.name),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      has: (_t, name) => tiers().some((x) => x.name === name),
      get: (_t, name) => tiers().find((x) => x.name === name)?.color,
      set: (_t, name, value) => {
        const tier = tiers().find((x) => x.name === name);
        if (tier) tier.color = value;
        return true;
      },
      deleteProperty: () => true,
    }),
  };
}

/** Every colour used by more than one rank anywhere in the season. */
function duplicateColours() {
  if (!seasonDraft) return new Map();

  const seen = new Map();
  const ladders = [
    { title: "Overall", names: seasonDraft.rankNames, colors: seasonDraft.rankColors },
  ].concat(
    seasonDraft.categories.map((c) => ({
      title: c.name,
      names: c.rankNames,
      colors: c.rankColors,
    })),
  );

  // Placeholder ranks share a drab ramp on purpose, so flagging them as duplicates is
  // noise on top of the thing that actually needs doing, which is naming them.
  const placeholder = /^Rank \d+\**$/;

  for (const ladder of ladders) {
    for (const name of ladder.names) {
      if (placeholder.test(name)) continue;
      const colour = (ladder.colors[name] ?? "").toLowerCase();
      if (!colour) continue;
      const list = seen.get(colour) ?? [];
      list.push(`${ladder.title} ${name}`);
      seen.set(colour, list);
    }
  }

  for (const [colour, users] of [...seen]) if (users.length < 2) seen.delete(colour);
  return seen;
}

/** How many ranks one window covers, or 0 when the season is not windowed. */
function seasonWindowSize() {
  const size = seasonDraft?.windowSize;
  return typeof size === "number" && size > 0 ? size : 0;
}

/** Display name for a window, falling back to its number. */
function windowLabel(index) {
  return seasonDraft?.windows?.[index] ?? `window ${index + 1}`;
}

/**
 * Add or remove a rank on one ladder.
 *
 * The awkward part is not the ladder, it is everything keyed to its length. A category
 * with four ranks has four energy thresholds and every scenario in it has four score
 * thresholds; add a rank and touch only the names and the season stops validating, with
 * an error about a scenario nobody edited. So the arrays move together, here, once.
 *
 * `owner` is a category or the season itself - the overall ladder has ranks but no
 * scenarios, so it only carries names and colours.
 */
function addRank(owner, isCategory) {
  // A windowed category cannot grow one rank at a time: the ranks in a window are
  // graded by one scenario per family, so a rank with no scenario behind it is a rank
  // nobody can reach. Growing the ladder there means adding a window's worth of
  // scenarios first, which is what buildSeason does.
  if (isCategory && seasonWindowSize() > 0) return;

  const names = owner.rankNames;
  const n = names.length;

  // A name that is obviously placeholder and obviously unique. Reusing an existing one
  // would trip the duplicate check the moment it was saved.
  let name = `Tier ${n + 1}`;
  let suffix = n + 1;
  while (names.includes(name)) name = `Tier ${++suffix}`;

  names.push(name);
  owner.rankColors[name] = "#8891a3";

  // Extend every threshold list by one step, keeping the ascent. The step is the last
  // gap, which keeps a hand-tuned ladder's shape rather than imposing one.
  const extend = (arr) => {
    const last = arr[arr.length - 1] ?? 0;
    const gap = arr.length >= 2 ? last - arr[arr.length - 2] : Math.max(1, Math.round(last * 0.1));
    arr.push(last + Math.max(1, gap));
  };

  if (isCategory) {
    extend(owner.rankMaxes);
    seasonDraft.scenarios
      .filter((s) => s.category === owner.name)
      .forEach((s) => extend(s.rankMaxes));
  }
}

function removeRank(owner, index, isCategory) {
  if (owner.rankNames.length <= 1) return;
  if (isCategory && seasonWindowSize() > 0) return;

  const [name] = owner.rankNames.splice(index, 1);
  delete owner.rankColors[name];

  if (isCategory) {
    owner.rankMaxes.splice(index, 1);
    seasonDraft.scenarios
      .filter((s) => s.category === owner.name)
      .forEach((s) => s.rankMaxes.splice(index, 1));
  }
}

/**
 * Ask for a name, in place.
 *
 * Not `prompt()`: Electron does not implement it, so the button simply reported that it
 * was unsupported and nothing happened. Replacing the button with an input is better than
 * a dialog anyway - the answer appears where the thing being named will.
 *
 * Enter commits, Escape or clicking away cancels, and the button comes back either way.
 */
function askInline(button, placeholder, onName) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-ask";
  input.placeholder = placeholder;

  let settled = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    input.replaceWith(button);
  };

  const commit = () => {
    // Enter commits and then blurs, so without this guard the name is submitted twice -
    // harmless where the caller checks for duplicates and confusing everywhere else.
    if (settled) return;
    const name = input.value.trim();
    restore();
    if (name) onName(name);
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") restore();
  });
  input.addEventListener("blur", commit);

  button.replaceWith(input);
  input.focus();
}

/**
 * Add a family: one empty slot in every window of a category.
 *
 * A family is the unit the ladder grades, so it only exists once it has a variant in every
 * window. Creating all the slots at once and refusing to save until they are filled is what
 * makes that impossible to get half-right.
 */
function addFamily(category, family) {
  const size = seasonWindowSize();
  const windows = size > 0 ? (seasonDraft.windows ?? []).length : 1;

  for (let w = 0; w < windows; w++) {
    seasonDraft.scenarios.push({
      scenario: "",
      category,
      family,
      window: size > 0 ? w : undefined,
      label: family,
      leaderboardId: null,
      subCategory: seasonDraft.scenarios.find(s => s.category === category && s.subCategory)?.subCategory ?? category,
      rankMaxes: Array.from({ length: size > 0 ? (windowCut(w)?.ranks.length ?? size) : 1 }, (_, i) => i + 1),
    });
  }

  rebalanceEnergy(category);
}

/** Remove a family and every variant of it. Single variants are never removed alone. */
function removeFamily(category, family) {
  for (const slot of seasonDraft.scenarios) {
    if (slot.category === category && slot.family === family) gridCancelCut(slot);
  }
  seasonDraft.scenarios = seasonDraft.scenarios.filter(
    (x) => !(x.category === category && x.family === family),
  );
  rebalanceEnergy(category);
}

/**
 * Re-derive a category's energy thresholds after its family count changes.
 *
 * A family caps at 2500 per rank, so a category caps at families * 2500 * ranks and rank r
 * costs families * 2500 * r. Leave the old numbers in place after removing a family and
 * the top ranks become unreachable at any score - which the validator refuses, correctly,
 * but refusing on Save is a worse way to find out than simply not letting it happen.
 */
function rebalanceEnergy(category) {
  const cat = seasonDraft.categories.find((c) => c.name === category);
  if (!cat) return;

  const families = new Set(
    seasonDraft.scenarios.filter((x) => x.category === category).map((x) => x.family),
  ).size;

  // Sent with the season rather than restated here. This was a literal 2500 - a third
  // copy of a constant owned by src/core/benchmarks/energy.ts - and a change there would
  // have left the season editor quietly computing a different ladder to everything else.
  cat.rankMaxes = cat.rankNames.map((_, i) => families * energyPerRank * (i + 1));
  if (seasonWindowSize() > 0) editorSyncBands(cat, families);

}

/**
 * Add a difficulty: a window of ranks on every category, and a slot on every family.
 *
 * The ladder and the pool move together or not at all. Adding the ranks without the
 * scenarios makes them unreachable; adding the scenarios without the ranks makes them
 * ungraded. Both halves happen here, once.
 */
function editorSyncBands(cat, families) {
  const size = seasonWindowSize(), windows = seasonDraft.windows ?? [];
  const old = cat.bands ?? [];
  const apex = old.find(b => b.positional);
  cat.bands = windows.map((_, w) => {
    const count = Math.min(size + (seasonDraft.windowOverlap ?? 0), cat.rankNames.length - w * size);
    const names = cat.rankNames.slice(w * size, w * size + count);
    const colors = Object.fromEntries(names.map(n => [n, cat.rankColors[n] ?? "#8891a3"]));
    const positional = w === windows.length - 1 ? (apex?.positional ?? {topN: 3}) : null;
    if (positional) {
      const name = apex?.rankNames.at(-1) ?? "Apex";
      names.push(name); colors[name] = apex?.rankColors[name] ?? "#e5c47e";
    }
    return {window:w,rankNames:names,rankColors:colors,
      rankMaxes:Array.from({length:count},(_,i)=>families*energyPerRank*(i+1)),
      ...(positional ? {positional} : {})};
  });
}

function addWindow(name) {
  const size = seasonWindowSize();
  if (size <= 0) return;
  gridCutResults.clear();
  const families = gridFamilies();
  const w = seasonDraft.windows.length;
  seasonDraft.windows.push(name);
  if (seasonPercentiles?.ranks) {
    let tail = seasonPercentiles.ranks.at(-1);
    for (let i = 0; i < size; i++) { tail *= 0.75; seasonPercentiles.ranks.push(tail); }
  }
  for (const cat of seasonDraft.categories) {
    for (let i=0;i<size;i++) {
      let rank = `${name} ${i+1}`;
      while(cat.rankNames.includes(rank)) rank += "*";
      cat.rankNames.push(rank); cat.rankColors[rank] = "#8891a3";
    }
  }
  // The old top window now overlaps the new one. Its additional thresholds need a real cut.
  for (const slot of seasonDraft.scenarios) {
    const count = windowCut(slot.window ?? 0)?.ranks.length ?? size;
    if (slot.rankMaxes.length < count) {
      while(slot.rankMaxes.length < count) slot.rankMaxes.push((slot.rankMaxes.at(-1) ?? 0)+1);
      if(slot.scenario) { slot.source = {kind:"authored",why:CUT_WAITING}; gridCutResults.delete(cutKeyOf(slot)); }
    }
  }
  for (const f of families) seasonDraft.scenarios.push({scenario:"",category:f.category,family:f.family,
    subCategory:seasonDraft.scenarios.find(s=>familyKeyOf(s)===f.key)?.subCategory ?? f.category,
    window:w,label:f.family,leaderboardId:null,rankMaxes:Array.from({length:size},(_,i)=>i+1)});
  for (const cat of seasonDraft.categories) rebalanceEnergy(cat.name);
}

/** Remove the top difficulty, with the ranks it graded and the slots that filled it. */
function removeWindow() {
  const size = seasonWindowSize();
  const windows = (seasonDraft.windows ?? []).length;
  if (size <= 0 || windows <= 1) return;

  gridCutResults.clear();
  const window = windows - 1;
  if (seasonPercentiles?.ranks) seasonPercentiles.ranks = seasonPercentiles.ranks.slice(0, window * size);
  seasonDraft.windows = seasonDraft.windows.slice(0, window);
  seasonDraft.scenarios = seasonDraft.scenarios.filter((x) => (x.window ?? 0) !== window);
  // The percentiles go with it, or the next window added inherits a ladder for a window
  // that no longer exists and buildSeason refuses the season for having more ladders than
  // windows.
  if (seasonDraft.derivedFrom?.perWindow) {
    seasonDraft.derivedFrom.perWindow = seasonDraft.derivedFrom.perWindow.slice(0, window);
  }

  for (const cat of seasonDraft.categories) {
    for (const name of cat.rankNames.splice(window * size, size)) delete cat.rankColors[name];
    cat.rankMaxes.splice(window * size, size);
    rebalanceEnergy(cat.name);
  }
  for (const slot of seasonDraft.scenarios) {
    const count = windowCut(slot.window ?? 0)?.ranks.length ?? size;
    if (slot.rankMaxes.length > count) {
      slot.rankMaxes = slot.rankMaxes.slice(0, count);
      if (slot.source?.kind === "percentile") slot.source = {kind:"authored",why:"Retained thresholds after removing the top difficulty."};
    }
  }
  if ((seasonDraft.matchPool?.window ?? 0) >= window) seasonDraft.matchPool.window = window - 1;
  for (const [category] of seasonWindowFor) {
    if (seasonWindowOf(category) >= window) seasonWindowFor.set(category, window - 1);
  }
}

/**
 * Population shape for the ladder as currently edited.
 *
 * Debounced, because it is recomputed from a four-hundred-step sweep and every keystroke
 * in a threshold box would otherwise start one. Failure is quiet: this is a readout, and a
 * missing readout must never be mistaken for a broken season.
 */
let distributionTimer = null;

function scheduleDistribution() {
  if (HOST !== "electron" || !seasonDraft) return;
  if (distributionTimer) clearTimeout(distributionTimer);
  distributionTimer = setTimeout(renderDistribution, 400);
}

async function renderDistribution() {
  const host = $("seasonDist");
  if (!host || !seasonDraft) return;

  const result = await window.apogee.rankDistribution(seasonDraft);
  if (!result || result.error || !result.categories) {
    host.textContent = "";
    return;
  }

  host.textContent = "";

  for (const cat of result.categories) {
    const block = document.createElement("div");
    block.className = "dist-cat";

    const head = document.createElement("div");
    head.className = "dist-head";
    head.textContent = cat.category;
    block.append(head);

    const rows = [{ name: "unranked", share: cat.unranked, rank: 0 }].concat(cat.ranks);
    const peak = Math.max(...rows.map((r) => r.share), 0.0001);

    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "dist-row" + (row.share === 0 && row.rank > 0 ? " empty" : "");

      const label = document.createElement("span");
      label.className = "dist-name";
      label.textContent = row.rank > 0 ? `${row.rank}. ${row.name}` : "unranked";

      const track = document.createElement("span");
      track.className = "dist-track";
      const fill = document.createElement("span");
      fill.className = "dist-fill";
      fill.style.width = `${(row.share / peak) * 100}%`;
      track.append(fill);

      const value = document.createElement("span");
      value.className = "dist-val";
      value.textContent = row.share === 0 && row.rank > 0
        ? "nobody"
        : `${(row.share * 100).toFixed(1)}%`;

      line.append(label, track, value);
      block.append(line);
    }

    // A rank between two that are held, which nobody holds, is a promise the ladder does
    // not keep. Worth naming rather than leaving to be spotted in a row of bars.
    const held = cat.ranks.filter((r) => r.share > 0).map((r) => r.rank);
    const gaps = cat.ranks.filter(
      (r) => r.share === 0 && r.rank > held[0] && r.rank < held[held.length - 1],
    );

    if (gaps.length > 0) {
      const note = document.createElement("div");
      note.className = "dist-note";
      note.textContent =
        `${gaps.map((g) => g.name).join(", ")} sit${gaps.length === 1 ? "s" : ""} at the top ` +
        `of a window and nobody holds ${gaps.length === 1 ? "it" : "them"}: the next ` +
        `difficulty opens at almost the same percentile, so players cross both at once.`;
      block.append(note);
    }

    host.append(block);
  }
}

/**
 * Where an unsaved draft is kept between launches.
 *
 * The editor holds the draft in memory, and a season cannot be saved while a slot is
 * empty - which is exactly the state somebody is in halfway through adding a difficulty.
 * Closing the app there, or restarting it to pick up a build, threw the work away. An
 * afternoon's editing should not depend on never needing to restart.
 */
const SEASON_DRAFT_KEY = "apogee.seasonDraft";
let seasonStashTimer = null;
let seasonRevision = 0;
let seasonSaving = false;
let seasonHasChanges = false;

function scheduleDraftStash() {
  clearTimeout(seasonStashTimer);
  seasonStashTimer = setTimeout(stashDraft, 180);
}

window.addEventListener("pagehide", () => { if (seasonStashTimer) stashDraft(); });
window.addEventListener("beforeunload", () => { if (seasonStashTimer) stashDraft(); });

function stashDraft() {
  clearTimeout(seasonStashTimer);
  seasonStashTimer = null;
  if (!seasonDraft) return;
  try {
    localStorage.setItem(SEASON_DRAFT_KEY, JSON.stringify({
      ...seasonDraft,
      $editor: { fingerprint: seasonFingerprint, ladder: seasonPercentiles,
        rankTheme: rankThemeDirty ? rankTheme : null, rankThemeFingerprint },
    }));
  } catch {
    setSeasonStatus("Draft backup failed. Keep this window open until you save or export the draft.", "bad");
  }
}

function clearStashedDraft() {
  clearTimeout(seasonStashTimer);
  seasonStashTimer = null;
  try {
    localStorage.removeItem(SEASON_DRAFT_KEY);
  } catch {
    // Nothing to do: the stash is a convenience, not a source of truth.
  }
}

function stashedDraft() {
  try {
    const raw = localStorage.getItem(SEASON_DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function seasonDirty(dirty) {
  seasonHasChanges = dirty;
  if (dirty) seasonRevision++;
  // An unfilled slot is not a validation failure to discover on Save - it is visible work
  // in progress, and the gate says what is left rather than what is wrong.
  const gaps = seasonGaps();
  const orphans = seasonOrphans();
  // A replaced slot still carries the previous scenario's thresholds until its cut lands,
  // and saving then would publish numbers that belong to a different scenario.
  const { cutting, failed } = gridWaiting();

  $("seasonSave").disabled =
    seasonSaving || !dirty || gaps.length > 0 || orphans.length > 0 || cutting > 0 || failed > 0;
  $("seasonReload").disabled = !dirty || seasonSaving;

  const purge = $("seasonPurge");
  if (purge) {
    purge.hidden = orphans.length === 0;
    purge.textContent =
      orphans.length === 1
        ? `Remove 1 entry the season cannot grade`
        : `Remove ${orphans.length} entries the season cannot grade`;
  }

  if (orphans.length > 0) {
    scheduleDraftStash();
    setSeasonStatus(
      `${orphans.map((o) => o.scenario || "(unnamed)").slice(0, 3).join(", ")}` +
        (orphans.length > 3 ? ` and ${orphans.length - 3} more` : "") +
        " have no family or difficulty, so nothing can grade them",
      "bad",
    );
    return;
  }

  if (gaps.length > 0) {
    scheduleDraftStash();
    setSeasonStatus(
      `${gaps.length} slot${gaps.length === 1 ? "" : "s"} still to fill: ` +
        gaps.slice(0, 4).join(", ") +
        (gaps.length > 4 ? `, and ${gaps.length - 4} more` : ""),
      "bad",
    );
    return;
  }

  if (failed > 0) {
    scheduleDraftStash();
    setSeasonStatus(
      `${failed} slot${failed === 1 ? "" : "s"} could not be cut from ${failed === 1 ? "its" : "their"} ` +
        "board: type the thresholds, cut again, or pick another scenario",
      "bad",
    );
    return;
  }

  if (cutting > 0) {
    scheduleDraftStash();
    setSeasonStatus(`cutting thresholds for ${cutting} slot${cutting === 1 ? "" : "s"}…`, "");
    return;
  }

  if (dirty) {
    scheduleDraftStash();
    setSeasonStatus("unsaved changes", "");
  }
}

function setSeasonStatus(text, kind) {
  const el = $("seasonStatus");
  el.textContent = text;
  el.className = "season-status" + (kind ? " " + kind : "");
}

/** Scenarios not already in the season, with a suggested category and thresholds. */
let seasonAvailable = [];

/**
 * Where every scenario is published, and how many accounts are on its board.
 *
 * Keyed by name and covering the whole catalogue, not just what could be added, because
 * the rows that need it most are the ones already in the season.
 */
let seasonProvenance = {};

/** evxl's ten most-played benchmarks, in its own listing order. */
let seasonBenchmarks = [];

/** Fewest board entries a percentile threshold can be cut from and still mean anything. */
const MIN_BOARD = 5000;

/** "Voltaic S5 Advanced · 50,023 on the board", or as much of it as is known. */
function provenanceOf(name) {
  const p = seasonProvenance[name];
  if (!p) return { text: "—", title: "nothing committed names this scenario", thin: false };

  const thin = p.entries != null && p.entries < MIN_BOARD;
  const where = p.tiers?.length > 0 ? p.tiers : null;
  const board =
    p.entries == null ? "board not sampled" : `${num(p.entries)} on the board`;

  const lines = [where ? where.join("\n") : "in no committed benchmark", board];
  if (thin) lines.push(`under ${num(MIN_BOARD)} - a percentile of this board is noise`);

  return {
    text: where ? where[0] : "not in a committed benchmark",
    title: lines.join("\n"),
    thin,
    board,
  };
}

async function loadSeasonEditor() {
  const result = await window.apogee.getSeason();
  if (result.error) {
    setSeasonStatus(result.error, "bad");
    return;
  }

  gridCancelCuts();
  seasonForce = false;
  gridCutResults.clear();
  seasonDraft = result.season;
  seasonPercentiles = result.ladder ?? null;
  // What the replaced count and Revert measure against: the pool as it stood when this
  // rebuild began, kept on this machine so the count survives a restart and a save.
  seasonOriginal = gridBaseline(result.season);
  gridUndo.length = 0;
  gridRedo.length = 0;
  gridCuts.clear();
  // The rating ladder rides along, because it is edited on this screen and saved by the
  // same button. A main process without the handler simply leaves it null and the section
  // does not render, rather than failing the whole editor.
  if (window.apogee.getRankTheme) {
    const ranks = await window.apogee.getRankTheme();
    if (ranks && !ranks.error) {
      rankTheme = ranks.theme;
      rankThemeFingerprint = ranks.fingerprint ?? null;
      rankThemeDirty = false;
    }
  }
  // What the files looked like when this draft was taken. Sent back with the save, which
  // main refuses if they have moved on - see the note on `apogee:saveSeason`.
  seasonFingerprint = result.fingerprint ?? null;
  // Owned by src/core/benchmarks/energy.ts and sent with the season. The fallback is
  // only for an older main process; the value is not a preference.
  if (typeof result.energyPerRank === "number") energyPerRank = result.energyPerRank;

  // An unsaved draft from a previous session wins over what is on disk, because it is the
  // newer of the two and the only copy of that work. Discard puts the saved season back.
  const stashed = stashedDraft();
  const restored = stashed && (stashed.$editor?.rankTheme || JSON.stringify({...stashed, $editor: undefined}) !== JSON.stringify(result.season));
  if (restored) {
    const backup = stashed.$editor;
    delete stashed.$editor;
    seasonDraft = stashed;
    if (backup) {
      seasonFingerprint = backup.fingerprint ?? seasonFingerprint;
      seasonPercentiles = backup.ladder ?? seasonPercentiles;
      if (backup.rankTheme) {
        rankTheme = backup.rankTheme;
        rankThemeDirty = true;
        rankThemeFingerprint = backup.rankThemeFingerprint;
      }
    }
  }

  $("seasonNote").textContent = `${seasonDraft.name} · ${result.path}`;

  // The table is drawn twice on purpose. The first paint is the season, which is already
  // in hand; the second follows the picker, which is what carries where each scenario is
  // published and how big its board is. Drawing once and waiting would leave the screen
  // blank on the slow half of the load, and drawing once without waiting would leave every
  // source cell reading "—" until something else happened to redraw.
  renderSeasonEditor();
  const loadRevision = seasonRevision;
  await loadSeasonPicker();
  const editedDuringLoad = seasonRevision !== loadRevision;
  // A restored draft can hold slots whose cut had not landed when the app closed.
  if (restored) gridResumeCuts();
  if (seasonWindowSize() > 0) {
    if (!$("poolGridDetail").contains(document.activeElement)) gridPaintDetail();
    if ($("poolGridSearch").classList.contains("open")) gridRenderHits();
  } else renderSeasonEditor();

  if (restored || editedDuringLoad) {
    seasonDirty(true);
    if (restored) setSeasonStatus("restored unsaved changes from your last session", "");
  } else {
    clearStashedDraft();
    seasonDirty(false);
    setSeasonStatus("", "");
  }
}

/**
 * Fill the picker with what could be added.
 *
 * Ordered by how many runs this machine has on each, so the scenarios whose thresholds
 * can actually be suggested from real scores are the ones offered first.
 */
/**
 * Fill the picker with whatever matches the search.
 *
 * Capped, because the list is every scenario this machine has ever seen - about eight
 * hundred here - and a select with all of them in it is not a thing anybody can use.
 * The cap is why the count is shown: "showing 50 of 214" is the difference between a
 * list that is short and a list that is truncated.
 */
const SEASON_PICK_LIMIT = 50;

function fillSeasonPicker(query) {
  const pick = $("seasonPick");
  const needle = (query ?? "").trim().toLowerCase();

  // This row adds a scenario, so the ones already in the season are not offered.
  const addable = seasonAvailable.filter((s) => !s.inSeason);
  const matches = needle
    ? addable.filter((s) => s.name.toLowerCase().includes(needle))
    : addable;

  pick.innerHTML = '<option value="">Add a scenario…</option>';

  matches.slice(0, SEASON_PICK_LIMIT).forEach((s) => {
    const opt = document.createElement("option");
    // Indexed against the full list, so filtering never changes what a value means.
    opt.value = String(seasonAvailable.indexOf(s));
    opt.textContent =
      s.name + (s.runs > 0 ? `  ·  ${s.runs} runs, best ${pts(s.best)}` : "  ·  no history");
    pick.append(opt);
  });

  $("seasonAdd").disabled = true;
  $("seasonAddNote").textContent =
    matches.length > SEASON_PICK_LIMIT
      ? `showing ${SEASON_PICK_LIMIT} of ${matches.length}; narrow the search`
      : `${matches.length} match${matches.length === 1 ? "" : "es"}`;
}

async function loadSeasonPicker() {
  const result = await window.apogee.availableScenarios();
  if (!result || result.error) {
    $("seasonAddNote").textContent = result?.error ?? "";
    return;
  }

  seasonAvailable = result.scenarios;
  seasonProvenance = result.provenance ?? {};
  seasonBenchmarks = result.benchmarkOrder ?? [];
  renderSeasonSources();

  // On a windowed season this row would push a scenario with no family and no window,
  // which the validator refuses - so the season would become unsaveable with an error
  // about a field the person never saw. "+ family" replaces it and sits next to the
  // category it joins. The list itself is still loaded: the slot pickers read it.
  const manual = document.querySelector(".season-add");
  if (result.windowed) {
    if (manual) manual.hidden = true;
    $("seasonAddNote").textContent = "";
    return;
  }
  if (manual) manual.hidden = false;

  fillSeasonPicker($("seasonSearch").value);

  const cat = $("seasonPickCat");
  cat.innerHTML = "";
  (result.categories ?? []).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    cat.append(opt);
  });

  $("seasonAdd").disabled = true;
  $("seasonAddNote").textContent = `${seasonAvailable.length} available`;
}

/**
 * How far across the most-played benchmarks this season's pool actually reaches.
 *
 * This panel exists because the answer was once "two of ten" and nothing said so. The pool
 * was built out of Voltaic S5 and S5.5, twelve other benchmark definitions sat committed
 * beside them unused, and every screen in the editor was perfectly happy - a season is
 * valid whatever it draws on. The only symptom was that reworking the pool kept producing
 * a season that looked much like the last one.
 *
 * Counted per benchmark rather than per scenario, and a scenario several benchmarks name
 * counts for each of them: Voltaic S5 and S5.5 publish nearly the same list, so a pool
 * drawn from one is drawn from both and claiming two sources would be flattering.
 */
function renderSeasonSources() {
  const host = $("seasonSources");
  if (!host || !seasonDraft) return;

  const counts = new Map(seasonBenchmarks.map((b) => [b.name, 0]));
  let unattributed = 0;

  for (const scenario of seasonDraft.scenarios ?? []) {
    if (!scenario.scenario) continue;
    const from = seasonProvenance[scenario.scenario]?.benchmarks ?? [];
    const named = from.filter((b) => counts.has(b));
    if (named.length === 0) unattributed++;
    for (const b of named) counts.set(b, counts.get(b) + 1);
  }

  const most = Math.max(1, ...counts.values());

  host.textContent = "";
  for (const { name, players } of seasonBenchmarks) {
    const used = counts.get(name) ?? 0;

    const row = document.createElement("div");
    row.className = "source-row" + (used === 0 ? " unused" : "");

    const label = document.createElement("span");
    label.className = "sname";
    label.textContent = name;
    label.title =
      players == null
        ? `${name} - audience unmeasured`
        : `${name} - ${num(players)} accounts on its own scenarios`;

    const bar = document.createElement("span");
    bar.className = "sbar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.round((used / most) * 100)}%`;
    bar.append(fill);

    const count = document.createElement("span");
    count.className = "scount";
    count.textContent = used === 0 ? "none" : used;

    row.append(label, bar, count);
    host.append(row);
  }

  if (unattributed > 0) {
    const note = document.createElement("div");
    note.className = "source-row unused";
    note.title =
      "Scenarios no committed benchmark names. They are not forbidden, but nothing " +
      "outside this machine says what difficulty they are.";
    const label = document.createElement("span");
    label.className = "sname";
    label.textContent = "from no committed benchmark";
    const bar = document.createElement("span");
    bar.className = "sbar";
    const count = document.createElement("span");
    count.className = "scount";
    count.textContent = unattributed;
    note.append(label, bar, count);
    host.append(note);
  }
}

function renderSeasonEditor() {
  const s = seasonDraft;
  if (!s) return;

  // ---- one ladder per category, plus the overall ----
  //
  // Three categories are three ladders (PLAN.md §14), so each is edited on its own.
  // Sharing one control would make renaming Tracking's ranks quietly rename Clicking's,
  // which is exactly the conflation the split exists to undo.
  const ranks = $("seasonRanks");
  ranks.textContent = "";

  // The rating ladder is edited here too, through an adapter rather than a second editor.
  //
  // `data/apogee_ranks.json` is a different file with a different shape - tiers carrying a
  // percentile band, not names and colours keyed by name - but it is the same job, and it
  // paints more of the window than the season does. Presenting it as `rankNames` and
  // `rankColors` lets it reuse the rows below, including the contrast warning and the
  // duplicate-colour check, and writes straight back through to the tiers.
  // No Overall section: it is not edited any more, it is derived. The overall readout takes
  // its names and colours from the rating tiers below, so a box here would be one you could
  // type into and watch get overwritten on save.
  const ladders = s.categories
    .map((c) => ({ title: c.name, owner: c, isCategory: true }))
    .concat(
      rankTheme
        ? [{
            title: "Rating tiers, and the overall readout",
            owner: ratingLadder(),
            isCategory: false,
            isRating: true,
          }]
        : [],
    );

  const size = seasonWindowSize();

  ladders.forEach(({ title, owner, isCategory, isRating }) => {
    // Both files are saved by one button, so an edit has to mark the right one dirty.
    const touched = () => {
      if (isRating) rankThemeDirty = true;
      seasonDirty(true);
    };
    // Only a category's ladder is windowed. The overall one is a readout derived from
    // the three (PLAN.md §14) and has no scenarios under it, so it stays freely editable.
    const windowed = isCategory && size > 0;

    const group = document.createElement("div");
    group.className = "ladder-group";

    const heading = document.createElement("div");
    heading.className = "ladder-title";
    heading.textContent = title;
    group.append(heading);

    if (windowed) {
      const note = document.createElement("div");
      note.className = "ladder-note";
      note.textContent =
        `${owner.rankNames.length / size} windows of ${size}: ` +
        (seasonDraft.windows ?? []).join(" · ");
      group.append(note);
    }

    owner.rankNames.forEach((name, i) => {
      const row = document.createElement("div");
      row.className = "season-rank";

      const n = document.createElement("span");
      n.className = "n";
      n.textContent = i + 1;
      if (windowed) n.title = windowLabel(Math.floor(i / size));

      const text = document.createElement("input");
      text.type = "text";
      text.value = name;
      let textBefore;
      text.addEventListener("focus", () => { textBefore = gridSnapshot(); });
      text.addEventListener("change", () => { if (text.value !== name) gridRemember(textBefore); });
      text.addEventListener("input", () => {
        const previous = owner.rankNames[i];
        owner.rankNames[i] = text.value;
        // Colours are keyed by name, so a rename has to carry its colour across or the
        // rank silently loses it.
        if (owner.rankColors[previous] !== undefined) {
          owner.rankColors[text.value] = owner.rankColors[previous];
          delete owner.rankColors[previous];
        }
        touched();
      });

      const colour = document.createElement("input");
      colour.type = "color";
      colour.value = owner.rankColors[name] ?? "#8891a3";
      let colourBefore;
      colour.addEventListener("focus", () => { colourBefore = gridSnapshot(); });
      colour.addEventListener("change", () => { gridRemember(colourBefore); });

      // Said while the colour is being chosen, not after it has shipped. The editor's own
      // background is neither of the grounds a rank has to survive, so a near-black looks
      // like a colour here and like nothing in the client.
      const warn = document.createElement("span");
      warn.className = "colourwarn";

      const judge = () => {
        const value = colour.value;
        const note = colourNote(value);
        const shared = duplicateColours().get(value.toLowerCase());

        const problems = [];
        if (note) problems.push(note);
        if (shared && shared.length > 1) {
          problems.push(`also ${shared.filter((u) => !u.endsWith(` ${owner.rankNames[i]}`)).join(", ")}`);
        }

        warn.textContent = problems.length > 0 ? "!" : "";
        warn.title = problems.join(" · ");
        warn.hidden = problems.length === 0;
      };

      colour.addEventListener("input", () => {
        owner.rankColors[owner.rankNames[i]] = colour.value;
        judge();
        touched();
      });

      judge();

      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "rankdrop";
      drop.textContent = "×";
      drop.title = windowed
        ? "A windowed ladder loses ranks a window at a time, with the scenarios that grade them"
        : "Remove this rank";
      drop.disabled = owner.rankNames.length <= 1 || windowed;
      drop.addEventListener("click", () => {
        gridRemember();
        removeRank(owner, i, isCategory);
        renderSeasonEditor();
        seasonDirty(true);
      });

      row.append(n, text, colour, warn, drop);
      group.append(row);
    });

    const tools = document.createElement("div");
    tools.className = "ladder-tools";

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+ rank";
    add.disabled = windowed;
    add.title = windowed
      ? `This ladder is ${size} ranks per window. A new window needs a scenario per ` +
        `family to grade it, so it is built rather than added here.`
      : isCategory
        ? "Add a rank, and a threshold for it on every scenario in this category"
        : "Add a rank to the overall ladder";
    add.addEventListener("click", () => {
      gridRemember();
      addRank(owner, isCategory);
      renderSeasonEditor();
      seasonDirty(true);
    });

    tools.append(add);
    group.append(tools);

    ranks.append(group);
  });

  // Difficulties, which are a property of the whole season rather than of one ladder: a
  // window adds ranks to every category and a slot to every family, or it adds nothing.
  if (size > 0) {
    const group = document.createElement("div");
    group.className = "ladder-group";

    const heading = document.createElement("div");
    heading.className = "ladder-title";
    heading.textContent = "Difficulties";
    group.append(heading);

    const note = document.createElement("div");
    note.className = "ladder-note";
    note.textContent =
      `${(s.windows ?? []).length} windows of ${size} ranks. Adding one adds ${size} ranks ` +
      `to every category and an empty slot to every family.`;
    group.append(note);

    (s.windows ?? []).forEach((name, w) => {
      const row = document.createElement("div");
      row.className = "season-rank";

      const n = document.createElement("span");
      n.className = "n";
      n.textContent = w + 1;

      const text = document.createElement("input");
      text.type = "text";
      text.value = name;
      text.title = "What this difficulty is called. Display only.";
      text.addEventListener("input", () => {
        s.windows[w] = text.value;
        seasonDirty(true);
      });

      const spacer = document.createElement("span");

      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "rankdrop";
      drop.textContent = "×";
      // Only the top one: removing a middle window would renumber every window above it
      // and silently re-point every scenario in them.
      drop.disabled = w !== (s.windows ?? []).length - 1 || (s.windows ?? []).length <= 1;
      drop.title = drop.disabled
        ? "Only the hardest difficulty can be removed"
        : `Remove ${name}, its ${size} ranks, and its scenarios`;
      drop.addEventListener("click", () => {
        gridRemember();
        removeWindow();
        gridCancelCuts(); gridResumeCuts();
        renderSeasonEditor();
        seasonDirty(true);
      });

      row.append(n, text, spacer, drop);
      group.append(row);
    });

    const tools = document.createElement("div");
    tools.className = "ladder-tools";
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+ difficulty";
    add.addEventListener("click", () => {
      askInline(add, "New difficulty…", (name) => {
        if ((s.windows ?? []).includes(name)) {
          setSeasonStatus(`there is already a difficulty called ${name}`, "bad");
          return;
        }
        gridRemember();
        addWindow(name);
        gridCancelCuts(); gridResumeCuts();
        renderSeasonEditor();
        seasonDirty(true);
      });
    });
    tools.append(add);
    group.append(tools);

    ranks.append(group);
  }

  // Only a season that still carries its own per-window percentiles. Thresholds moved into
  // data/pool.json, and a heading over nothing would read as a section that failed to load.
  if (size > 0 && s.derivedFrom?.perWindow) {
    // The percentile ladder: the season's actual control surface.
    //
    // Every threshold is the score at one of these percentiles on that scenario's own
    // board. Moving rank 7 from the top 15% to the top 8% is one decision that should move
    // eighteen numbers, and expressing it by editing eighteen numbers by hand is how they
    // end up inconsistent with each other. Editing here re-derives them all.
    const pct = document.createElement("div");
    pct.className = "ladder-group";

    const pctTitle = document.createElement("div");
    pctTitle.className = "ladder-title";
    pctTitle.textContent = "Percentiles";
    pct.append(pctTitle);

    const pctNote = document.createElement("div");
    pctNote.className = "ladder-note";
    pctNote.textContent =
      "Share of each scenario's leaderboard a rank sits above. Editing re-derives every " +
      "threshold in that difficulty.";
    pct.append(pctNote);

    (s.windows ?? []).forEach((name, w) => {
      const ladder = seasonLadder(w);
      if (!ladder) return;

      const row = document.createElement("div");
      row.className = "pct-row";

      const label = document.createElement("span");
      label.className = "pct-name";
      label.textContent = name;
      row.append(label);

      ladder.forEach((fraction, i) => {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "pct";
        input.step = "0.1";
        input.min = "0";
        input.max = "100";
        input.value = (fraction * 100).toFixed(1);
        input.title = `Rank ${w * size + i + 1}: top ${(fraction * 100).toFixed(1)}%`;
        input.addEventListener("change", () => rederiveWindow(w, i, input));
        row.append(input);
      });

      pct.append(row);
    });

    ranks.append(pct);
  }

  // ---- scenario thresholds, one category and one difficulty at a time ----
  //
  // Each category gets its own block with its own difficulty dropdown, so what is on
  // screen is one category's scenarios against the ranks of one window. The whole ladder is
  // still editable; it is just not all editable at once, which is the difference between
  // a table you can work in and one you can only stare at.
  const head = $("seasonHead");
  head.innerHTML = "";

  const body = $("seasonBody");
  body.textContent = "";

  // A windowed season is edited in the pool grid; the table stays for one that is not.
  const useGrid = size > 0 && !!$("poolGrid");
  if ($("poolPanel")) $("poolPanel").hidden = !useGrid;
  if ($("seasonTablePanel")) $("seasonTablePanel").hidden = useGrid;
  if (useGrid) {
    wirePoolGrid();
    renderPoolGrid();
  }

  (useGrid ? [] : s.categories).forEach((cat) => {
    const windows = size > 0 ? cat.rankNames.length / size : 1;
    const window = Math.min(seasonWindowOf(cat.name), windows - 1);
    const offset = size > 0 ? window * size : 0;
    // The ranks this window actually grades, which is what the columns are.
    const ladder = size > 0 ? cat.rankNames.slice(offset, offset + size) : cat.rankNames;

    const header = document.createElement("tr");
    header.className = "cat-head";

    const title = document.createElement("th");
    title.colSpan = size > 0 ? 3 : 2;
    title.append(document.createTextNode(cat.name));

    if (size > 0) {
      const pick = document.createElement("select");
      pick.className = "winpick";
      pick.title = `Which difficulty of ${cat.name} to edit`;
      for (let w = 0; w < windows; w++) {
        const opt = document.createElement("option");
        opt.value = String(w);
        opt.textContent = `${windowLabel(w)}  ·  ranks ${w * size + 1}–${w * size + size}`;
        opt.selected = w === window;
        pick.append(opt);
      }
      pick.addEventListener("change", () => {
        seasonWindowFor.set(cat.name, Number(pick.value));
        // Only the table is redrawn: re-rendering the ladders would throw away a
        // half-typed rank name somebody is in the middle of.
        renderSeasonEditor();
      });
      title.append(pick);
    }

    if (size > 0) {
      // Adding a family belongs next to the category it joins, not in a toolbar that has
      // to ask which category you meant.
      const add = document.createElement("button");
      add.type = "button";
      add.className = "addfam";
      add.textContent = "+ family";
      add.title = `Add a scenario family to ${cat.name}, one slot per difficulty`;
      add.addEventListener("click", () => {
        askInline(add, `New ${cat.name} family…`, (name) => {
        if (!editorName(name)) return;
          const taken = s.scenarios.some((x) => x.category === cat.name && x.family === name);
          if (taken) {
            setSeasonStatus(`A family called ${name} already exists. Choose a different name.`, "bad");
            return;
          }
          addFamily(cat.name, name);
          renderSeasonEditor();
          seasonDirty(true);
          // Straight into the first of the four slots it just opened, so naming a family
          // and filling it is one movement rather than a name, a redraw and a hunt.
          focusNextSlot(cat.name, name, -1);
        });
      });
      title.append(add);
    }

    header.append(title);

    if (size > 0) {
      const source = document.createElement("th");
      source.textContent = "source";
      source.title =
        "Which benchmark and tier publishes this scenario, and how many accounts are on " +
        "its board. The tier is where the difficulty band comes from; the board is what " +
        "the thresholds are percentiles of.";
      header.append(source);

      const best = document.createElement("th");
      best.textContent = "your best";
      header.append(best);
    }

    for (const rank of ladder) {
      const th = document.createElement("th");
      th.textContent = rank;
      header.append(th);
    }
    header.append(document.createElement("th"));
    body.append(header);

    // One row per family, showing only the variant that grades the chosen window.
    const rows = s.scenarios
      .map((scenario, index) => ({ scenario, index }))
      .filter(
        (r) =>
          r.scenario.category === cat.name &&
          (size === 0 || (r.scenario.window ?? 0) === window),
      )
      .sort((a, b) =>
        (a.scenario.family ?? a.scenario.scenario).localeCompare(
          b.scenario.family ?? b.scenario.scenario,
        ),
      );

    if (rows.length === 0) {
      const empty = document.createElement("tr");
      empty.innerHTML =
        '<td colspan="' + (ladder.length + (size > 0 ? 6 : 3)) + '" class="empty">' +
        "No scenarios in this difficulty yet.</td>";
      body.append(empty);
      return;
    }

    rows.forEach(({ scenario, index }) => renderSeasonRow(body, scenario, index));
  });

  renderSeasonCategories();
  renderSeasonSources();
  scheduleDistribution();

  // Redrawing can change whether the season is complete - filling the last slot, or adding
  // a difficulty that opens eighteen - so the gate is re-read here rather than only where
  // an edit happens to call it.
  if (!$("seasonSave").disabled || seasonGaps().length > 0) {
    seasonDirty(!$("seasonReload").disabled || seasonGaps().length > 0);
  }
}

/**
 * Apply an edited percentile and re-derive every threshold it governs.
 *
 * The percentiles must fall across the WHOLE ladder, not merely inside one difficulty.
 *
 * Checking only within a window is what this used to do, and it is not the real rule. A
 * family is graded on the best of its variants, so a player holds the highest rank any
 * window gives them: if Advanced's last rank asks for the top 2.8% and Expert's first asks
 * for the top 15%, everyone who reaches the former reached the latter already, and four
 * ranks exist that nobody can hold. Season 1 shipped that twice - once with two handovers
 * stepping up, once with Expert repeating Advanced's four numbers exactly - and the editor
 * accepted both without complaint, because both descend perfectly well one window at a
 * time.
 *
 * Refused here rather than on Save, because by then every threshold in the window has
 * already moved.
 */
async function rederiveWindow(windowIndex, index, input) {
  const ladder = seasonLadder(windowIndex);
  if (!ladder) return;

  const value = Number(input.value) / 100;
  const proposed = ladder.slice();
  proposed[index] = value;

  // The whole ladder as one sequence, with this window's edit folded in.
  const size = seasonWindowSize() || proposed.length;
  const every = (seasonDraft?.derivedFrom?.perWindow ?? [])
    .map((w, i) => (i === windowIndex ? proposed : w))
    .flat();
  const at = windowIndex * size + index;
  const wrong = every.findIndex((f, i) => i > 0 && f >= every[i - 1]);

  if (!Number.isFinite(value) || value <= 0 || value > 1 || wrong > 0) {
    input.value = (ladder[index] * 100).toFixed(1);

    // Name the rank it collides with. "Percentiles have to fall" is true and does not say
    // which of the sixteen numbers is now in the way, which on a handover is never the one
    // being edited.
    const collision =
      wrong > 0 && (wrong === at || wrong - 1 === at)
        ? `: rank ${wrong + 1} asks for the top ${(every[wrong] * 100).toFixed(1)}%, ` +
          `which is no harder than rank ${wrong} at ${(every[wrong - 1] * 100).toFixed(1)}%`
        : "";

    setSeasonStatus(
      "percentiles have to fall across the whole ladder, not just within a difficulty: a " +
        "family is graded on its best variant, so a rank that is no harder than the one " +
        "below it is a rank nobody holds" +
        collision,
      "bad",
    );
    return;
  }

  const scenarios = seasonDraft.scenarios
    .filter((x) => (x.window ?? 0) === windowIndex && x.scenario)
    .map((x) => x.scenario);

  setSeasonStatus("re-deriving…", "");
  const result = await window.apogee.deriveWindow(scenarios, proposed);

  if (!result || result.error) {
    input.value = (ladder[index] * 100).toFixed(1);
    setSeasonStatus(result?.error ?? "could not re-derive", "bad");
    return;
  }

  for (const scenario of seasonDraft.scenarios) {
    const derived = result.derived[scenario.scenario];
    if (derived) scenario.rankMaxes = derived;
  }

  seasonDraft.derivedFrom.perWindow[windowIndex] = proposed;

  renderSeasonEditor();
  seasonDirty(true);

  if (result.missing.length > 0) {
    setSeasonStatus(
      `${result.missing.length} scenario(s) have no sampled board and kept their numbers`,
      "bad",
    );
  }
}

/**
 * The control that fills an empty slot.
 *
 * Choosing the scenario is only half of it: the season's thresholds are percentiles of
 * each scenario's own KovaaK's board, so the numbers are derived from that board rather
 * than typed. The main process samples it (and caches it, so `build:season` later derives
 * the same numbers this showed) and the four thresholds land in the row.
 */
/**
 * Put the caret in the slot somebody is most likely to fill next.
 *
 * The next unfilled difficulty of the same family, or the first slot of the next family
 * once this one is complete. Called after the redraw, because the redraw replaces every
 * input on the screen and an element captured before it is no longer in the document.
 */
function focusNextSlot(category, family, from) {
  const slots = [...document.querySelectorAll(".slotsearch")];
  if (slots.length === 0) return;

  const siblings = slots.filter(
    (el) => el.dataset.category === category && el.dataset.family === family,
  );
  const next =
    siblings.find((el) => Number(el.dataset.window) > from) ?? siblings[0] ?? slots[0];
  next.focus();
}

function slotPicker(scenario) {
  const wrap = document.createElement("div");
  wrap.className = "slotpick";

  // A text input with a datalist, not a select.
  //
  // A select of eight hundred scenarios cannot be searched, so the first version capped it
  // at three hundred - which meant most scenarios were not merely hard to find but absent.
  // A datalist gives native type-to-search over the whole list, filters as you type, and
  // needs no cap.
  const input = document.createElement("input");
  input.type = "text";
  input.className = "slotsearch";
  input.placeholder = `Search scenarios for ${scenario.family ?? "this slot"}…`;
  input.autocomplete = "off";
  input.spellcheck = false;
  // The redraw after a fill throws every one of these away, so the next slot is found
  // again from the DOM rather than held across it.
  input.dataset.category = scenario.category ?? "";
  input.dataset.family = scenario.family ?? "";
  input.dataset.window = String(scenario.window ?? 0);

  const listId = `slots-${(scenario.family ?? "x").replace(/\W/g, "")}-${scenario.window ?? 0}`;
  const list = document.createElement("datalist");
  list.id = listId;
  input.setAttribute("list", listId);

  // What the list is sorted and labelled by is the whole difference between this picker
  // and the one before it, so it is worth saying why.
  //
  // A slot is a category and a difficulty band. The two facts that decide whether a
  // scenario belongs in it are which benchmark and tier publish it - that is where its
  // band comes from - and how many accounts are on its board, because every threshold is a
  // percentile of that board and a percentile of two thousand scores is noise. Neither was
  // shown. The list was ordered by local run count, which ranks the scenarios this machine
  // happens to have played over the ones the slot is for, and every label read "no
  // history" because a pool drawn across ten benchmarks is mostly scenarios nobody here
  // has run.
  //
  // So: scenarios of this slot's own category first, then by board size, and each labelled
  // with where it is published and how many people are on it.
  const usable = (o) => !!o.leaderboardId && (o.entries ?? 0) >= MIN_BOARD;

  // Built on first focus rather than at render.
  //
  // A slot's list is every scenario this machine knows - the stats folder, the taxonomy
  // and every benchmark file, about 1,700 names - and `+ family` opens four slots at
  // once. Building them all up front meant an evening that added five families before
  // filling them rebuilt some 34,000 option elements, and re-sorted the whole list once
  // per slot, on every edit that redrew the editor. Nothing reads the list until the
  // input has focus, and `resolve` matches against `seasonAvailable` directly rather
  // than against the options, so the button and its status work before it exists.
  const buildOptions = () => {
    const options = [...seasonAvailable].sort(
      (a, b) =>
        Number(b.category === scenario.category) - Number(a.category === scenario.category) ||
        Number(usable(b)) - Number(usable(a)) ||
        (b.entries ?? 0) - (a.entries ?? 0) ||
        a.name.localeCompare(b.name),
    );

    for (const option of options) {
      const opt = document.createElement("option");
      opt.value = option.name;

      const where = option.tiers?.length > 0 ? option.tiers.join(", ") : null;
      const board =
        option.entries == null
          ? "board not sampled"
          : `${num(option.entries)} on the board${option.entries < MIN_BOARD ? ", thin" : ""}`;

      opt.label = !option.leaderboardId
        ? "no leaderboard - cannot derive thresholds"
        : [where, board, option.runs > 0 ? `${option.runs} runs here` : null]
            .filter(Boolean)
            .join("  ·  ");
      list.append(opt);
    }
  };

  input.addEventListener("focus", buildOptions, { once: true });

  const status = document.createElement("span");
  status.className = "slotnote";
  status.textContent = `${windowLabel(scenario.window ?? 0)} · empty`;

  const fill = async () => {
    const chosen = resolve();
    if (!chosen) {
      if (input.value.trim()) {
        status.textContent = "no single scenario matches that";
        status.className = "slotnote bad";
      }
      return;
    }

    if (!chosen.leaderboardId) {
      status.textContent = "no leaderboard for this scenario, so thresholds cannot be derived";
      status.className = "slotnote bad";
      return;
    }

    const ladder = seasonLadder(scenario.window ?? 0);
    if (!ladder) {
      status.textContent = "this season has no percentile ladder to derive from";
      status.className = "slotnote bad";
      return;
    }

    status.textContent = "sampling the leaderboard…";
    status.className = "slotnote";
    input.disabled = true;

    const result = await window.apogee.sampleScenario(chosen.name, chosen.leaderboardId, ladder);
    input.disabled = false;

    if (!result || result.error) {
      status.textContent = result?.error ?? "could not sample that scenario";
      status.className = "slotnote bad";
      return;
    }

    if (!applyScenario(scenario, chosen, result.rankMaxes)) {
      status.textContent = "that slot is no longer in the season";
      status.className = "slotnote bad";
      return;
    }

    renderSeasonEditor();
    seasonDirty(true);
    // A family is four slots and they are filled one after another, so the next one is
    // where the caret wants to be. Without this every scenario costs a trip to the mouse
    // to click the box directly below the one just finished.
    focusNextSlot(scenario.category, scenario.family, scenario.window ?? 0);
  };

  // An explicit button, not only the change event.
  //
  // The first version committed on `change` alone, which fires on blur or on picking a
  // datalist entry - so the whole interaction was invisible: you could search, see the
  // scenario you wanted, and have nothing to press. A visible control that says what it
  // will do is the difference between a form and a guess.
  const add = document.createElement("button");
  add.type = "button";
  add.className = "slotadd";
  add.textContent = "add";
  add.disabled = true;
  add.title = "Sample this scenario's leaderboard and fill the slot";
  add.addEventListener("click", fill);

  /**
   * The scenario the typed text refers to, if it refers to exactly one.
   *
   * Case-insensitive, and it accepts a partial name that matches only one scenario -
   * because an exact, case-sensitive match meant typing "pasu" resolved to nothing and
   * left the button dead with no explanation. Ambiguity is not resolved silently: two
   * matches means keep typing.
   */
  const resolve = () => {
    const term = input.value.trim().toLowerCase();
    if (!term) return null;

    const exact = seasonAvailable.find((o) => o.name.toLowerCase() === term);
    if (exact) return exact;

    const partial = seasonAvailable.filter((o) => o.name.toLowerCase().includes(term));
    return partial.length === 1 ? partial[0] : null;
  };

  /** Enabled only for a name that resolves, so the button never lies about what it can do. */
  const refresh = () => {
    const term = input.value.trim();
    const match = resolve();
    add.disabled = !match || !match.leaderboardId;

    if (!term) {
      status.textContent = `${windowLabel(scenario.window ?? 0)} · empty`;
      status.className = "slotnote";
    } else if (!match) {
      const near = seasonAvailable.filter((o) =>
        o.name.toLowerCase().includes(term.toLowerCase()),
      ).length;
      status.textContent =
        near > 1 ? `${near} scenarios match - keep typing` : "no scenario by that name yet";
      status.className = "slotnote";
    } else if (!match.leaderboardId) {
      // Known by name from the stats folder but not by board. The id is one lookup away,
      // so fetch it rather than declaring the scenario unusable.
      status.textContent = "looking up its leaderboard…";
      status.className = "slotnote";
      void findLeaderboardId(match, refresh, status);
    } else {
      status.textContent = "ready to add";
      status.className = "slotnote";
    }
  };

  // Typing searches KovaaK's itself, not only the few hundred names some committed file
  // happens to mention. Debounced so a word costs one request rather than one per letter,
  // and merged into the same datalist so local and remote results read as one list.
  let searchTimer = null;
  const remote = new Map();

  const searchRemote = async (term) => {
    if (term.length < 2) return;
    // One request per term for the life of the slot, and the same promise handed to
    // everyone waiting on it, so pressing Enter mid-search joins the search already
    // running instead of starting a second one.
    if (!remote.has(term)) remote.set(term, doSearch(term));
    await remote.get(term);
  };

  const doSearch = async (term) => {
    const found = await window.apogee.searchScenarios(term);
    if (!found || found.error || !found.scenarios) return;

    for (const hit of found.scenarios) {
      // A scenario already in the list is usually one from the stats folder, which knows
      // the name and not the board. Skipping the remote hit left it permanently
      // unaddable - findable, selectable, and refused for want of an id the search had
      // just returned. So an existing entry is completed rather than passed over.
      const existing = seasonAvailable.find((o) => o.name === hit.name);
      if (existing) {
        if (!existing.leaderboardId) existing.leaderboardId = hit.leaderboardId;
        if (!existing.category && hit.aimType) {
          existing.category = hit.aimType === "Target Switching" ? "Switching" : hit.aimType;
        }
        continue;
      }
      // Added to the shared list, so a scenario found once stays findable for every
      // other slot in this session without asking again.
      seasonAvailable.push({
        name: hit.name,
        category: hit.aimType === "Target Switching" ? "Switching" : hit.aimType,
        difficulty: null,
        leaderboardId: hit.leaderboardId,
        runs: 0,
        best: null,
        suggested: {},
      });

      const opt = document.createElement("option");
      opt.value = hit.name;
      opt.label = `${hit.entries.toLocaleString()} on the leaderboard`;
      list.append(opt);
    }

    // The typed name may have only just become resolvable.
    refresh();
  };

  input.addEventListener("input", () => {
    const term = input.value.trim();
    refresh();
    if (searchTimer) clearTimeout(searchTimer);
    if (term.length < 2 || remote.has(term)) return;
    searchTimer = setTimeout(() => void searchRemote(term), 350);
  });

  /*
   * Enter does whatever it takes, rather than whatever is ready.
   *
   * Both of the waits in this control are invisible, and Enter used to fall into either
   * of them silently. A name only KovaaK's knows is not resolvable until the debounced
   * search returns, so typing it and pressing Enter straight away did nothing at all. A
   * name the stats folder knows carries no leaderboard id, so the button was disabled
   * while the id was being fetched, and Enter did nothing then either. In both cases the
   * next keystroke or click worked, which reads as the key being unreliable rather than
   * as something still loading.
   *
   * So Enter flushes the debounce, waits for the search, fetches the id if that is what
   * is missing, and only then decides. Filling four slots is four names and four Enters.
   */
  const commit = async () => {
    if (searchTimer) clearTimeout(searchTimer);
    const term = input.value.trim();
    if (!term) return;

    // Neither wait is allowed to escape. Both reach KovaaK's, and a throw here would be
    // an unhandled rejection landing in the app-wide error banner - which says nothing
    // useful about a lookup that failed and buries the message that does.
    try {
      if (!resolve()) {
        status.textContent = "searching KovaaK's…";
        status.className = "slotnote";
        await searchRemote(term);
      }

      const match = resolve();
      if (match && !match.leaderboardId) await findLeaderboardId(match, refresh, status);
    } catch {
      status.textContent = "could not reach KovaaK's - try again";
      status.className = "slotnote bad";
      return;
    }

    refresh();
    if (!add.disabled) await fill();
  };

  input.addEventListener("change", () => void commit());

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    // The datalist swallows Enter as "accept this suggestion" and then submits nothing.
    e.preventDefault();
    void commit();
  });

  wrap.append(input, add, status);

  wrap.append(list);
  return wrap;
}

/**
 * Fill in a scenario's leaderboard id from KovaaK's, by exact name.
 *
 * Scenarios discovered from the stats folder carry a name and nothing else, and a name is
 * not enough: thresholds come from the board. One lookup turns "cannot be derived" into an
 * ordinary addable scenario, which is what somebody who has played it expects.
 */
// Keyed on the name and holding the promise, not just the fact of having asked. `refresh`
// fires this on every keystroke and Enter now waits on it, so a second caller has to join
// the lookup already running rather than return straight away and report "cannot derive"
// against an id that arrives a moment later.
const idLookups = new Map();

function findLeaderboardId(option, refresh, status) {
  if (!idLookups.has(option.name)) {
    idLookups.set(option.name, lookUpLeaderboardId(option, refresh, status));
  }
  return idLookups.get(option.name);
}

async function lookUpLeaderboardId(option, refresh, status) {
  const found = await window.apogee.searchScenarios(option.name);
  if (!found || found.error || !found.scenarios) {
    status.textContent = found?.error ?? "could not reach KovaaK's to look it up";
    status.className = "slotnote bad";
    return;
  }

  const hit = found.scenarios.find(
    (h) => h.name.toLowerCase() === option.name.toLowerCase(),
  );

  if (!hit) {
    status.textContent = "KovaaK's has no leaderboard for this scenario";
    status.className = "slotnote bad";
    return;
  }

  option.leaderboardId = hit.leaderboardId;
  refresh();
}

/**
 * Write a chosen scenario into its slot.
 *
 * The slot is found again by identity rather than trusted from the closure that started
 * the search. Sampling a leaderboard takes seconds, and anything that redraws the editor in
 * the meantime - a threshold edit, the difficulty dropdown, the distribution refreshing -
 * hands the row a new object. Writing to the one captured before the wait then updates
 * something no longer on screen, which looks exactly like the choice being thrown away.
 *
 * Returns false when the slot has gone, so the caller can say so instead of silently
 * doing nothing.
 */
function applyScenario(slot, chosen, rankMaxes) {
  // The exact object when it is still in the draft, which it usually is. The tuple lookup
  // is the fallback for a redraw that replaced it - and it can only be a fallback now that
  // a window may hold more than one scenario, since the tuple no longer identifies one.
  const live = seasonDraft?.scenarios.includes(slot)
    ? slot
    : (seasonDraft?.scenarios.find(
        (x) =>
          x.category === slot.category &&
          x.family === slot.family &&
          (x.window ?? 0) === (slot.window ?? 0) &&
          !x.scenario,
      ) ?? null);

  if (!live) return false;

  live.scenario = chosen.name;
  live.label = chosen.name.replace(/^VT\s+/, "").replace(/\s*S\d(\.\d)?\s*$/i, "").trim();
  live.leaderboardId = chosen.leaderboardId ?? null;
  live.rankMaxes = rankMaxes;
  return true;
}

/**
 * One editable scenario row.
 *
 * The row carries exactly the thresholds of the window on screen, so there is no padding
 * and no greyed-out cells: every input belongs to a rank this scenario actually grades.
 */
function renderSeasonRow(body, scenario, index) {
  const s = seasonDraft;
  const size = seasonWindowSize();
  const tr = document.createElement("tr");

  const name = document.createElement("td");

  if (isEmptySlot(scenario)) {
    // An unfilled slot. Rather than a name it carries the one control that fills it, so
    // the gap and the thing that closes it are in the same place.
    tr.className = "slot";
    name.append(slotPicker(scenario));
  } else {
    name.textContent = scenario.label ?? scenario.scenario;
    // The exact name KovaaK's uses, because that is what has to be launched and what the
    // leaderboard is keyed on, and the label is deliberately not it.
    name.title = scenario.scenario;
  }

  const cat = document.createElement("td");
  cat.textContent = scenario.category;

  tr.append(name, cat);

  if (size > 0) {
    // The family, and which of its difficulties are filled.
    //
    // The table shows one difficulty at a time, so a scenario chosen for another window is
    // off screen - which is indistinguishable from it not having been saved. This says, on
    // every row, how the whole family stands.
    const family = document.createElement("td");
    family.className = "family";

    const name = document.createElement("span");
    name.textContent = scenario.family ?? "";
    family.append(name);

    const siblings = (s.scenarios ?? []).filter(
      (x) => x.family === scenario.family && x.category === scenario.category,
    );

    const state = document.createElement("span");
    state.className = "famstate";
    state.textContent = (s.windows ?? [])
      .map((_, w) => (siblings.some((x) => (x.window ?? 0) === w && x.scenario) ? "●" : "○"))
      .join("");
    state.title = (s.windows ?? [])
      .map((label, w) => {
        const hit = siblings.find((x) => (x.window ?? 0) === w);
        return `${label}: ${hit?.scenario || "empty"}`;
      })
      .join("\n");
    family.append(state);

    tr.append(family);

    // Where this scenario comes from, and whether its board can carry a percentile.
    //
    // Both are properties of the scenario rather than of the season, so neither was in the
    // file the editor loads. They are the two things being judged when a slot is filled,
    // and leaving them out meant judging by name alone.
    const source = document.createElement("td");
    source.className = "source";
    if (isEmptySlot(scenario)) {
      source.textContent = "";
    } else {
      const p = provenanceOf(scenario.scenario);
      source.textContent = p.text;
      source.title = p.title;
      if (p.thin) source.classList.add("thin");
    }
    tr.append(source);

    // What has actually been scored here, from the season's own corpus figures. A
    // threshold is a judgement about scores, and making one with no scores in front of you
    // is guessing.
    const best = document.createElement("td");
    best.className = "corpus";
    best.textContent = scenario.corpus ? pts(scenario.corpus.best) : "—";
    best.title = scenario.corpus
      ? `${scenario.corpus.runs} runs, median ${num(scenario.corpus.median)}` +
        (scenario.corpus.reaches ? `, reaches ${scenario.corpus.reaches}` : ", unranked")
      : "no local history on this scenario";
    tr.append(best);
  }

  // A threshold typed by hand stops being a percentile and becomes a judgement. Both are
  // allowed - it is the season owner's ladder - but they are not the same claim, so an
  // overridden number is marked here and recorded as an override when the pool is written.
  const ladder = seasonLadder(scenario.window ?? 0);
  const derived = scenario.derivedRankMaxes ?? (scenario.overridden ? null : scenario.rankMaxes);

  scenario.rankMaxes.forEach((value, i) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.className = "thr";
    input.value = value;

    const off = derived && derived[i] !== value;
    if (off) {
      input.classList.add("override");
      input.title = `Hand-set. The percentiles give ${num(derived[i])}.`;
    } else if (ladder) {
      input.title = `Top ${(ladder[i] * 100).toFixed(1)}% of this scenario's leaderboard`;
    }

    input.addEventListener("input", () => {
      scenario.rankMaxes[i] = input.value === "" ? NaN : Number(input.value);
      input.classList.toggle("override", !!derived && derived[i] !== Number(input.value));
      seasonDirty(true);
    });
    td.append(input);
    tr.append(td);
  });

  const drop = document.createElement("td");
  drop.className = "rowacts";

  if (size > 0) {
    // How many scenarios this family has in this window decides what removing means.
    // Emptying the last one leaves the slot - the ranks it grades still need something -
    // while removing an extra takes the row away entirely.
    const here = s.scenarios.filter(
      (x) =>
        x.category === scenario.category &&
        x.family === scenario.family &&
        (x.window ?? 0) === (scenario.window ?? 0),
    );

    // Another scenario for the same difficulty. The family is graded on its best variant,
    // so a second one reads as "either of these proves the rank".
    const more = document.createElement("button");
    more.type = "button";
    more.className = "rowdrop";
    more.textContent = "+";
    more.title = `Another ${windowLabel(scenario.window ?? 0)} scenario for ${scenario.family}, graded as an alternative`;
    more.addEventListener("click", () => {
      s.scenarios.push({
        scenario: "",
        category: scenario.category,
        family: scenario.family,
        window: scenario.window ?? 0,
        label: scenario.family,
        leaderboardId: null,
        rankMaxes: scenario.rankMaxes.map((_, i) => i + 1),
      });
      renderSeasonEditor();
      seasonDirty(true);
    });
    drop.append(more);

    if (!isEmptySlot(scenario)) {
      // Clearing beats deleting: an accidental pick should cost the pick, not the family.
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "rowdrop";
      clear.textContent = here.length > 1 ? "remove" : "clear";
      clear.title =
        here.length > 1
          ? "Take this alternative out"
          : "Empty this slot, keeping the family and its other difficulties";
      clear.addEventListener("click", () => {
        if (here.length > 1) {
          s.scenarios.splice(index, 1);
        } else {
          scenario.scenario = "";
          scenario.leaderboardId = null;
          scenario.label = scenario.family;
        }
        renderSeasonEditor();
        seasonDirty(true);
      });
      drop.append(clear);
    } else if (here.length > 1) {
      // An unused extra slot is just clutter, and cannot be "cleared" any further.
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "rowdrop";
      remove.textContent = "remove";
      remove.title = "Take this empty alternative out";
      remove.addEventListener("click", () => {
        s.scenarios.splice(index, 1);
        renderSeasonEditor();
        seasonDirty(true);
      });
      drop.append(remove);
    }

    const family = document.createElement("button");
    family.type = "button";
    family.className = "rowdrop danger";
    family.textContent = "family";
    family.title = `Remove ${scenario.family} from every difficulty`;
    family.addEventListener("click", () => {
      removeFamily(scenario.category, scenario.family);
      renderSeasonEditor();
      seasonDirty(true);
    });
    drop.append(family);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rowdrop";
    btn.textContent = "remove";
    btn.title = "Take this scenario out of the season";
    btn.addEventListener("click", () => {
      s.scenarios.splice(index, 1);
      renderSeasonEditor();
      seasonDirty(true);
    });
    drop.append(btn);
  }

  tr.append(drop);

  body.append(tr);
}

/**
 * Category energy: what a category rank costs.
 *
 * Laid out one category per block rather than one row, because each has its own ladder
 * now and a shared header row would be wrong for two of the three.
 */
function renderSeasonCategories() {
  const s = seasonDraft;
  $("seasonCatHead").innerHTML = "";

  const catBody = $("seasonCatBody");
  catBody.textContent = "";

  s.categories.forEach((cat) => {
    const header = document.createElement("tr");
    header.innerHTML =
      "<th>" + esc(cat.name) + "</th>" +
      cat.rankNames.map((r) => "<th>" + esc(r) + "</th>").join("");
    catBody.append(header);

    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = "energy";
    tr.append(name);

    cat.rankMaxes.forEach((value, i) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number";
      input.className = "thr";
      input.value = value;
      input.addEventListener("input", () => {
        cat.rankMaxes[i] = input.value === "" ? NaN : Number(input.value);
        seasonDirty(true);
      });
      td.append(input);
      tr.append(td);
    });

    catBody.append(tr);
  });
}

/* --------------------------------------------------------------- the pool grid */
/*
 * Every slot of a windowed season on one screen: a row per family, a column per difficulty.
 *
 * The table this replaces showed one category at one difficulty. Replacing a scenario meant
 * clearing it, which threw its thresholds away, then searching into the empty slot, with the
 * whole editor redrawn after each step. Rebuilding a pool of 256 that way is a few thousand
 * clicks. Here a slot is replaced in place: select a cell, type, press Enter, and the caret
 * is on the next slot with the search still open. The new scenario's thresholds are cut from
 * its own board in the background while the next name is being typed, and nothing but the
 * cells that changed is redrawn.
 */

/** The pool's percentile ladder, `{ ranks, overlap }`, sent with the season. */
let seasonPercentiles = null;
/** Each slot as it is on disk, keyed by slot, for the replaced count, the "was" line and Revert. */
let seasonOriginal = new Map();
/** Cut state by slot and scenario: `{ state: "pending" | "error" | "check", message }`. */
const gridCuts = new Map();
/** What a finished cut produced, by slot and scenario, so it survives an undo and a redo. */
const gridCutResults = new Map();
const gridUndo = [];
const gridRedo = [];
const GRID_UNDO_LIMIT = 100;
/** How many boards are sampled at once. KovaaK's rate-limits well above this. */
const GRID_CUT_CONCURRENCY = 3;
/** Marks a slot whose thresholds are still the previous scenario's, until its cut lands. */
const CUT_WAITING = "Waiting for thresholds to be cut from this scenario's board.";
const HAND_SET =
  "Set by hand in the season editor and not yet explained. Replace this with the reason " +
  "the number is what it is.";

let gridSel = { family: null, window: 0 };
let gridFilter = "all";
let gridCategory = "";
let gridSearchSlot = null;
let gridSearchActive = 0;
let gridSearchHits = [];
let gridRemoteTimer = null;
const gridRemoteAsked = new Set();
const gridRemoteState = new Map();
const gridCutQueue = [];
let gridCutEpoch = 0;
const gridCutTokens = new Map();
let gridCutSerial = 0;
let gridCutsRunning = 0;

const slotKeyOf = (x) => `${x.category}/${x.family}/${x.window ?? 0}`;
const familyKeyOf = (x) => `${x.category}/${x.family}`;
const cutKeyOf = (x) => `${slotKeyOf(x)}|${x.scenario}`;

/** A rename is recorded new -> old, so the slot's original can still be found under it. */
function originalFamilyKey(key) {
  const renamed = seasonDraft?.$renamed ?? {};
  let at = key;
  for (let hops = 0; renamed[at] && hops < 50; hops++) at = renamed[at];
  return at;
}

function originalOf(slot) {
  const w = slot.window ?? 0;
  return (
    seasonOriginal.get(`${familyKeyOf(slot)}/${w}`) ??
    seasonOriginal.get(`${originalFamilyKey(familyKeyOf(slot))}/${w}`) ??
    null
  );
}

function isReplaced(slot) {
  if (!slot?.scenario) return false;
  const was = originalOf(slot);
  return !was || was.scenario !== slot.scenario;
}

/** The pool ladder's ranks and shares for one window, as `sampleScenario` wants them. */
function windowCut(window) {
  const size = seasonWindowSize();
  const all = seasonPercentiles?.ranks;
  if (!Array.isArray(all) || size <= 0) return null;
  const start = window * size;
  const count = Math.min(size + (seasonPercentiles.overlap ?? 0), all.length - start);
  if (count <= 0) return null;
  return {
    ranks: Array.from({ length: count }, (_, i) => start + i),
    fractions: all.slice(start, start + count),
  };
}

const pctText = (f) => `${Number((f * 100).toFixed(2))}%`;

function cutWhy(cut, total) {
  return (
    `Cut from this scenario's own KovaaK's board at the pool ladder's ranks ` +
    `${cut.ranks.map((r) => r + 1).join(", ")} - the top ${cut.fractions.map(pctText).join(", ")} ` +
    `of ${num(total)} entries. Chosen in the season editor.`
  );
}

/** Families in season order, grouped by category in the order the categories are listed. */
function gridFamilies() {
  const order = seasonDraft.categories.map((c) => c.name);
  const seen = new Map();
  for (const x of seasonDraft.scenarios) {
    const key = familyKeyOf(x);
    if (!seen.has(key)) seen.set(key, { key, category: x.category, family: x.family });
  }
  return [...seen.values()].sort(
    (a, b) => order.indexOf(a.category) - order.indexOf(b.category),
  );
}

function gridSlot(familyKey, window) {
  return (
    seasonDraft?.scenarios.find(
      (x) => familyKeyOf(x) === familyKey && (x.window ?? 0) === window,
    ) ?? null
  );
}

function gridDuplicates() {
  const where = new Map();
  for (const x of seasonDraft.scenarios) {
    if (!x.scenario) continue;
    const list = where.get(x.scenario) ?? [];
    list.push(`${x.family} · ${windowLabel(x.window ?? 0)}`);
    where.set(x.scenario, list);
  }
  return where;
}

/** Slots whose thresholds are not settled, for the counts and the Save gate. */
function gridWaiting() {
  if (!seasonDraft) return { cutting: 0, failed: 0 };
  let cutting = 0;
  let failed = 0;
  for (const x of seasonDraft.scenarios) {
    const state = gridCuts.get(cutKeyOf(x))?.state;
    if (state === "error" || state === "check") failed++;
    else if (state === "pending" || x.source?.why === CUT_WAITING) cutting++;
  }
  return { cutting, failed };
}

/* ---- the baseline ---- */

/**
 * The pool as it stood when this rebuild began.
 *
 * Kept in localStorage rather than read from disk on every load: a pool of 256 is rebuilt
 * over several evenings and saves, and a count that went back to zero at every restart would
 * say nothing about how far through it is. "Count from here" starts it again.
 */
const SEASON_BASELINE_KEY = "apogee.seasonBaseline";

function gridBaseline(season) {
  let slots = null;
  try {
    const raw = JSON.parse(localStorage.getItem(SEASON_BASELINE_KEY) ?? "null");
    if (raw && raw.season === season.name && Array.isArray(raw.slots)) slots = raw.slots;
  } catch {
    // Unreadable: start from what is on disk.
  }
  if (!slots) {
    slots = JSON.parse(JSON.stringify(season.scenarios));
    gridSaveBaseline(season.name, slots);
  }
  return new Map(slots.map((x) => [slotKeyOf(x), x]));
}

function gridSaveBaseline(name, slots) {
  try {
    localStorage.setItem(SEASON_BASELINE_KEY, JSON.stringify({ season: name, slots }));
  } catch {
    // Without storage the count lasts this session, which is still most of its use.
  }
}

/** After a save the renames are on disk, so the baseline takes the new names too. */
function gridFoldRenames() {
  const renamed = seasonDraft?.$renamed;
  if (!renamed || Object.keys(renamed).length === 0) return;
  const slots = [...seasonOriginal.values()];
  for (const [now, was] of Object.entries(renamed)) {
    const category = now.slice(0, now.indexOf("/"));
    const family = now.slice(now.indexOf("/") + 1);
    for (const slot of slots) if (familyKeyOf(slot) === was) { slot.family = family; slot.category = category; }
  }
  delete seasonDraft.$renamed;
  seasonOriginal = new Map(slots.map((x) => [slotKeyOf(x), x]));
  gridSaveBaseline(seasonDraft.name, slots);
}

function gridCountFromHere() {
  const slots = JSON.parse(JSON.stringify(seasonDraft.scenarios));
  seasonOriginal = new Map(slots.map((x) => [slotKeyOf(x), x]));
  gridSaveBaseline(seasonDraft.name, slots);
  renderPoolGrid();
}

/* ---- undo ---- */

function gridSnapshot() {
  return JSON.stringify({ season: seasonDraft, ladder: seasonPercentiles, rankTheme, rankThemeDirty, selection: gridSel });
}

function gridRemember(snapshot) {
  gridUndo.push(snapshot ?? gridSnapshot());
  if (gridUndo.length > GRID_UNDO_LIMIT) gridUndo.shift();
  gridRedo.length = 0;
  gridPaintBar();
}

function gridStep(direction) {
  const from = direction < 0 ? gridUndo : gridRedo;
  const to = direction < 0 ? gridRedo : gridUndo;
  if (from.length === 0) return;
  to.push(gridSnapshot());
  const snap = JSON.parse(from.pop());
  gridCancelCuts();
  seasonDraft = snap.season;
  seasonPercentiles = snap.ladder;
  rankTheme = snap.rankTheme;
  // A saved theme can still be undone; the restored copy needs writing again.
  rankThemeDirty = !!rankTheme;
  gridSel = snap.selection;
  gridResumeCuts();
  renderSeasonEditor();
  seasonDirty(true);
}

/* ---- cutting thresholds ---- */

function gridCancelCuts() {
  gridCutEpoch++;
  gridCutQueue.length = 0;
  gridCuts.clear();
  gridCutTokens.clear();
}

function gridCancelCut(slot) {
  gridCutTokens.delete(cutKeyOf(slot));
  gridCuts.delete(cutKeyOf(slot));
}

function gridQueueCut(slot) {
  gridCuts.set(cutKeyOf(slot), { state: "pending" });
  const token = ++gridCutSerial;
  gridCutTokens.set(cutKeyOf(slot), token);
  gridCutQueue.push({ key: slotKeyOf(slot), name: slot.scenario, window: slot.window ?? 0, epoch: gridCutEpoch, token });
  gridPumpCuts();
}

function gridPumpCuts() {
  while (gridCutsRunning < GRID_CUT_CONCURRENCY && gridCutQueue.length > 0) {
    const job = gridCutQueue.shift();
    gridCutsRunning++;
    void gridRunCut(job).finally(() => {
      gridCutsRunning--;
      gridPumpCuts();
    });
  }
}

/** The slot a job belongs to, if it still holds the scenario the job was started for. */
function gridLiveSlot(key, name) {
  return seasonDraft?.scenarios.find((x) => slotKeyOf(x) === key && x.scenario === name) ?? null;
}

function gridApplyCut(slot, result) {
  slot.leaderboardId = result.leaderboardId;
  slot.rankMaxes = result.rankMaxes.slice();
  slot.source = JSON.parse(JSON.stringify(result.source));
  const flat = slot.rankMaxes.findIndex((v, i) => i > 0 && v <= slot.rankMaxes[i - 1]);
  if (flat > 0) {
    gridCuts.set(cutKeyOf(slot), {
      state: "check",
      message:
        `The board is too flat here: two ranks both came out at ${num(slot.rankMaxes[flat])}. ` +
        `Set them by hand.`,
    });
  } else {
    gridCuts.delete(cutKeyOf(slot));
  }
}

async function gridRunCut(job) {
  const key = `${job.key}|${job.name}`;
  const currentJob = () => job.epoch === gridCutEpoch && gridCutTokens.get(key) === job.token;
  if (!currentJob()) return;
  // Every ending repaints the slot and re-reads the Save gate, which is what says how many
  // slots are still cutting or need a hand.
  const done = () => {
    if (!currentJob()) return;
    gridPaintSlot(job.key);
    seasonDirty(true);
  };
  const fail = (message) => {
    if (!currentJob()) return;
    if (!gridLiveSlot(job.key, job.name)) { gridCuts.delete(key); return; }
    gridCuts.set(key, { state: "error", message });
    done();
  };

  if (!gridLiveSlot(job.key, job.name)) {
    gridCuts.delete(key);
    return;
  }

  const cut = windowCut(job.window);
  if (!cut) return fail("There is no percentile ladder in data/pool.json to cut from. Type the thresholds.");

  try {
    const option = seasonAvailable.find((o) => o.name === job.name);
    let id = gridLiveSlot(job.key, job.name)?.leaderboardId ?? option?.leaderboardId ?? null;
    if (!id) {
      const found = await window.apogee.searchScenarios(job.name);
      const hit = found?.scenarios?.find((h) => h.name.toLowerCase() === job.name.toLowerCase());
      id = hit?.leaderboardId ?? null;
      if (option && id) option.leaderboardId = id;
    }
    if (!currentJob()) return;
    if (!id) return fail("KovaaK's has no leaderboard for this scenario. Type the thresholds.");

    let result = await window.apogee.sampleScenario(job.name, id, cut.fractions);
    // One patient retry. A burst of replacements is exactly when the limit is hit, and
    // saying "try again" for something that will work in half a minute is busywork.
    if (!currentJob()) return;
    if (result?.error && /rate-limit/i.test(result.error)) {
      gridCuts.set(key, { state: "pending", message: "KovaaK's is rate-limiting; retrying shortly" });
      done();
      await new Promise((resolve) => setTimeout(resolve, 20000));
      if (!currentJob()) return;
      result = await window.apogee.sampleScenario(job.name, id, cut.fractions);
    }
    if (!currentJob()) return;
    if (!result || result.error) return fail(result?.error ?? "Could not cut thresholds from that board.");

    const cutResult = {
      leaderboardId: id,
      rankMaxes: result.rankMaxes,
      source: {
        kind: "percentile",
        cut: {
          ranks: cut.ranks,
          topFractions: cut.fractions,
          leaderboardId: id,
          total: result.entries,
          sampledAt: result.sampledAt,
        },
        why: cutWhy(cut, result.entries),
      },
    };
    gridCutResults.set(key, cutResult);

    const slot = gridLiveSlot(job.key, job.name);
    if (!slot) {
      gridCuts.delete(key);
      return;
    }
    gridApplyCut(slot, cutResult);
    done();
    scheduleDistribution();
  } catch (err) {
    fail(err && err.message ? err.message : "Could not reach KovaaK's.");
  }
}

/**
 * After an undo or redo: a slot still waiting for its cut either gets the result that
 * landed while it was undone, or is queued again.
 */
function gridResumeCuts() {
  for (const slot of seasonDraft.scenarios) {
    if (slot.source?.why !== CUT_WAITING) continue;
    const key = cutKeyOf(slot);
    const landed = gridCutResults.get(key);
    if (landed) gridApplyCut(slot, landed);
    else if (gridCuts.get(key)?.state !== "pending") gridQueueCut(slot);
  }
}

/* ---- changing slots ---- */

/** The parts of the arm validate:pool accepts, easiest to name first. */
const ARM_PARTS = ["Fingertip", "Wrist", "Arm", "Blending"];

const labelFor = (name) => name.replace(/^VT\s+/, "").replace(/\s*S\d(\.\d)?\s*$/i, "").trim();

/**
 * Put a scenario in a slot.
 *
 * Its original slot's numbers come back if it is going back where it was, and a scenario
 * moved from another family in the same difficulty keeps the thresholds and source it had
 * there, since those were cut or authored for exactly these ranks. Anything else is cut
 * fresh from its board.
 */
function gridReplace(slot, option) {
  const was = originalOf(slot);
  const index = seasonDraft.scenarios.indexOf(slot);
  if (index < 0) return;

  gridCancelCut(slot);
  if (was && was.scenario === option.name) {
    seasonDraft.scenarios[index] = JSON.parse(JSON.stringify({ ...was, category: slot.category, family: slot.family }));
    return;
  }

  const moved = [...seasonOriginal.values()].find(
    (o) => o.scenario === option.name && (o.window ?? 0) === (slot.window ?? 0),
  );

  const previousArm = slot.arm;
  slot.scenario = option.name;
  slot.label = labelFor(option.name);
  for (const stale of ["sanity", "corpus", "arm", "armFrom"]) delete slot[stale];

  if (moved) {
    slot.label = moved.label ?? slot.label;
    slot.leaderboardId = moved.leaderboardId ?? option.leaderboardId ?? null;
    slot.rankMaxes = moved.rankMaxes.slice();
    slot.source = JSON.parse(JSON.stringify(moved.source ?? { kind: "authored", why: HAND_SET }));
    for (const carried of ["sanity", "arm", "armFrom"]) {
      if (moved[carried] !== undefined) slot[carried] = JSON.parse(JSON.stringify(moved[carried]));
    }
    gridCuts.delete(cutKeyOf(slot));
    return;
  }

  // validate:pool wants every variant to name the part of the arm it asks for. Viscose's
  // word where Viscose gives one, since the check refuses any other; otherwise the slot's
  // previous one, as the season's own guess, which the detail can change.
  if (ARM_PARTS.includes(option.publishedArm)) {
    slot.arm = option.publishedArm;
    slot.armFrom = "Viscose";
  } else {
    slot.arm = ARM_PARTS.includes(previousArm) ? previousArm : "Blending";
    slot.armFrom = "Apogee";
  }

  slot.leaderboardId = option.leaderboardId ?? null;
  slot.source = { kind: "authored", why: CUT_WAITING };
  const landed = gridCutResults.get(cutKeyOf(slot));
  if (landed) gridApplyCut(slot, landed);
  else gridQueueCut(slot);
}

function gridRevert(slot) {
  const was = originalOf(slot);
  if (!was) return;
  const index = seasonDraft.scenarios.indexOf(slot);
  if (index < 0) return;
  if (JSON.stringify({ ...was, category: slot.category, family: slot.family }) === JSON.stringify(slot)) return;
  gridRemember();
  gridCancelCut(slot);
  seasonDraft.scenarios[index] = JSON.parse(JSON.stringify({ ...was, category: slot.category, family: slot.family }));
  gridCuts.delete(cutKeyOf(slot));
  gridPaintSlot(slotKeyOf(slot));
  seasonDirty(true);
  scheduleDistribution();
}

function gridRecut(slot) {
  if (!slot?.scenario) return;
  gridRemember();
  gridCutResults.delete(cutKeyOf(slot));
  slot.source = { kind: "authored", why: CUT_WAITING };
  gridQueueCut(slot);
  gridPaintSlot(slotKeyOf(slot));
  seasonDirty(true);
}

function gridRenameFamily(familyKey, name) {
  const [category] = familyKey.split("/");
  if (!editorName(name)) return false;
  const next = `${category}/${name}`;
  if (next === familyKey) return true;
  if (seasonDraft.scenarios.some((x) => familyKeyOf(x) !== familyKey && x.family?.toLowerCase() === name.toLowerCase())) {
    setSeasonStatus(`A family called ${name} already exists. Choose a different name.`, "bad");
    return false;
  }
  gridRemember();
  const renamed = (seasonDraft.$renamed ??= {});
  const origin = originalFamilyKey(familyKey);
  delete renamed[familyKey];
  if (origin !== next) renamed[next] = origin;
  for (const x of seasonDraft.scenarios) {
    if (familyKeyOf(x) !== familyKey) continue;
    gridCancelCut(x);
    if (x.label === x.family) x.label = name;
    x.family = name;
  }
  gridSel.family = next;
  gridResumeCuts();
  renderPoolGrid();
  seasonDirty(true);
  return true;
}

/* ---- drawing ---- */

function gridVisible(family) {
  if (gridCategory && family.category !== gridCategory) return false;
  if (gridFilter === "all") return true;
  const windows = (seasonDraft.windows ?? []).length;
  const slots = Array.from({ length: windows }, (_, w) => gridSlot(family.key, w));
  if (gridFilter === "todo") return slots.some((s) => !s?.scenario || !isReplaced(s));
  if (gridFilter === "done") return slots.some((s) => isReplaced(s));
  if (gridFilter === "attention") {
    const dup = gridDuplicates();
    return slots.some(
      (s) =>
        !s || !s.scenario || gridCuts.has(cutKeyOf(s)) ||
        s.source?.why === CUT_WAITING || (dup.get(s.scenario)?.length ?? 0) > 1,
    );
  }
  return true;
}

function renderPoolGrid() {
  const host = $("poolGrid");
  if (!host || !seasonDraft) return;

  const windows = seasonDraft.windows ?? [];
  const size = seasonWindowSize();
  const families = gridFamilies().filter(gridVisible);
  if (!families.some((f) => f.key === gridSel.family)) gridSel.family = families[0]?.key ?? null;
  gridSel.window = Math.max(0, Math.min(gridSel.window, windows.length - 1));

  const table = document.createElement("table");
  table.className = "pgrid";

  const colgroup = document.createElement("colgroup");
  const famCol = document.createElement("col");
  famCol.className = "pg-famcol";
  colgroup.append(famCol);
  windows.forEach(() => colgroup.append(document.createElement("col")));
  table.append(colgroup);

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = "Family";
  headRow.append(corner);
  windows.forEach((name, w) => {
    const th = document.createElement("th");
    const cut = windowCut(w);
    th.textContent = name;
    const small = document.createElement("small");
    const count = cut ? cut.ranks.length : size;
    small.textContent = `ranks ${w * size + 1}–${w * size + count}`;
    th.append(small);
    headRow.append(th);
  });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  const dup = gridDuplicates();

  for (const cat of seasonDraft.categories) {
    const mine = families.filter((f) => f.category === cat.name);
    const shown = mine.filter(gridVisible);
    if ((gridCategory && cat.name !== gridCategory) || (gridFilter !== "all" && shown.length === 0)) continue;

    const catRow = document.createElement("tr");
    catRow.className = "pg-cat";
    const th = document.createElement("th");
    th.colSpan = windows.length + 1;
    const title = document.createElement("span");
    title.textContent = cat.name;
    const count = document.createElement("span");
    count.className = "pg-catcount";
    count.textContent = `${mine.length} famil${mine.length === 1 ? "y" : "ies"}`;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "pool-btn pool-addfam";
    add.dataset.category = cat.name;
    add.textContent = "+ family";
    add.title = `Add a family to ${cat.name}, with an empty slot in every difficulty`;
    add.addEventListener("click", () => {
      askInline(add, `New ${cat.name} family…`, (name) => {
        if (!editorName(name)) return;
        if (seasonDraft.scenarios.some((x) => x.family?.toLowerCase() === name.toLowerCase())) {
          setSeasonStatus(`A family called ${name} already exists. Choose a different name.`, "bad");
          return;
        }
        gridRemember();
        addFamily(cat.name, name);
        gridFilter = "all";
        gridSel = { family: `${cat.name}/${name}`, window: 0 };
        renderPoolGrid();
        renderSeasonCategories();
        seasonDirty(true);
        gridOpenSearch("");
      });
    });
    const rename = document.createElement("button");
    rename.type = "button"; rename.className = "pool-btn"; rename.textContent = "Rename";
    rename.setAttribute("aria-label", `Rename ${cat.name}`);
    rename.addEventListener("click", () => askInline(rename, cat.name, name => editorRenameCategory(cat, name)));
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "pool-btn danger"; remove.textContent = "Remove";
    remove.title = `Remove ${cat.name} and all its families. Undo restores them.`;
    remove.disabled = seasonDraft.categories.length <= 1;
    remove.addEventListener("click", () => editorRemoveCategory(cat));
    th.append(title, count, add, rename, remove);
    catRow.append(th);
    body.append(catRow);

    for (const family of shown) {
      const tr = document.createElement("tr");
      tr.dataset.family = family.key;
      const name = document.createElement("th");
      name.className = "pg-fam";
      name.textContent = family.family;
      name.title = family.family;
      tr.append(name);
      windows.forEach((_, w) => {
        const td = document.createElement("td");
        td.dataset.family = family.key;
        td.dataset.window = String(w);
        gridFillCell(td, gridSlot(family.key, w), dup);
        tr.append(td);
      });
      body.append(tr);
    }
  }

  table.append(body);
  host.replaceChildren(table);
  editorRenderToolbar();
  gridPaintBar();
  gridPaintDetail();
  gridSetSearchTarget();
}

function gridFillCell(td, slot, dup) {
  const selected = td.dataset.family === gridSel.family && Number(td.dataset.window) === gridSel.window;
  const cut = slot ? gridCuts.get(cutKeyOf(slot)) : null;
  const waiting = slot?.source?.why === CUT_WAITING;
  const shared = slot?.scenario ? (dup.get(slot.scenario) ?? []) : [];

  const classes = ["pg-cell"];
  if (!slot || !slot.scenario) classes.push("empty");
  else {
    if (isReplaced(slot)) classes.push("replaced");
    if (shared.length > 1) classes.push("dup");
  }
  if (cut) classes.push(cut.state);
  else if (waiting) classes.push("pending");
  if (selected) classes.push("sel");
  td.className = classes.join(" ");
  td.setAttribute("aria-selected", selected ? "true" : "false");

  const name = document.createElement("span");
  name.className = "pg-name";
  name.textContent = slot?.scenario ? slot.label || slot.scenario : "empty";

  const meta = document.createElement("span");
  meta.className = "pg-meta";
  if (cut?.state === "error") meta.textContent = "needs thresholds";
  else if (cut?.state === "check") meta.textContent = "check thresholds";
  else if (cut?.state === "pending" || waiting) meta.textContent = "cutting…";
  else if (slot?.scenario && slot.rankMaxes?.length) {
    meta.textContent = `${num(slot.rankMaxes[0])} → ${num(slot.rankMaxes[slot.rankMaxes.length - 1])}`;
  } else meta.textContent = "Enter to fill";

  td.replaceChildren(name, meta);

  const lines = [];
  if (slot?.scenario) lines.push(slot.scenario);
  const was = slot ? originalOf(slot) : null;
  if (slot?.scenario && isReplaced(slot)) lines.push(was ? `was ${was.scenario}` : "new slot");
  if (shared.length > 1) lines.push(`also in ${shared.filter((s) => s !== `${slot.family} · ${windowLabel(slot.window ?? 0)}`).join(", ")}`);
  if (cut?.message) lines.push(cut.message);
  td.title = lines.join("\n");
}

/** Redraw one slot, its detail if it is selected, and the counts. */
function gridPaintSlot(key) {
  const host = $("poolGrid");
  if (!host || !seasonDraft) return;
  const cut = key.lastIndexOf("/");
  const familyKey = key.slice(0, cut);
  const window = Number(key.slice(cut + 1));
  const dup = gridDuplicates();
  const slots = new Map(seasonDraft.scenarios.map(s => [slotKeyOf(s), s]));
  // Duplicates are a property of two cells, so every cell holding a scenario that is now
  // shared, or has just stopped being, is redrawn with it.
  for (const td of host.querySelectorAll("td.pg-cell")) {
    const slot = slots.get(`${td.dataset.family}/${td.dataset.window}`);
    const here = td.dataset.family === familyKey && Number(td.dataset.window) === window;
    if (here || td.classList.contains("dup") || (slot?.scenario && (dup.get(slot.scenario)?.length ?? 0) > 1)) {
      gridFillCell(td, slot, dup);
    }
  }
  if (gridSel.family === familyKey && gridSel.window === window && !$("poolGridDetail").contains(document.activeElement)) gridPaintDetail();
  gridPaintBar();
}

function gridPaintBar() {
  const bar = $("poolGridCount");
  if (!bar || !seasonDraft) return;
  const filled = seasonDraft.scenarios.filter((x) => x.scenario);
  const replaced = filled.filter(isReplaced).length;
  const { cutting, failed } = gridWaiting();
  const dup = [...gridDuplicates().values()].filter((l) => l.length > 1).length;
  const empty = seasonDraft.scenarios.length - filled.length;

  const parts = [`<b>${replaced}</b> of ${seasonDraft.scenarios.length} replaced`];
  if (cutting) parts.push(`<span class="pg-busy">${cutting} cutting</span>`);
  const attention = failed + dup + empty;
  if (attention) parts.push(`<span class="pg-warn">${attention} need${attention === 1 ? "s" : ""} a look</span>`);
  bar.innerHTML = parts.join(" · ");

  $("poolGridUndo").disabled = gridUndo.length === 0;
  $("poolGridRedo").disabled = gridRedo.length === 0;
}

let gridDetailsOpen = false;
function gridPaintDetail() {
  const host = $("poolGridDetail");
  if (!host || !seasonDraft) return;
  host.textContent = "";

  const familyKey = gridSel.family;
  if (!familyKey) return;
  const w = gridSel.window;
  const slot = gridSlot(familyKey, w);
  const [category] = familyKey.split("/");
  const family = familyKey.slice(category.length + 1);
  const cat = seasonDraft.categories.find((c) => c.name === category);
  const size = seasonWindowSize();
  const cut = windowCut(w);

  const add = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    host.append(el);
    return el;
  };

  const location = add("div", "pgd-where", `${family} · ${windowLabel(w)}`);

  const famRow = add("div", "pgd-family");
  const famInput = document.createElement("input");
  famInput.type = "text";
  famInput.value = family;
  famInput.title = "The family's name. Renaming it renames every difficulty's slot.";
  famInput.spellcheck = false;
  famInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") famInput.blur();
    if (e.key === "Escape") { famInput.value = family; gridFocus(); }
  });
  famInput.addEventListener("change", () => {
    const name = famInput.value.trim();
    if (!name || !gridRenameFamily(familyKey, name)) famInput.value = family;
  });
  const dropFamily = document.createElement("button");
  dropFamily.type = "button";
  dropFamily.className = "pool-btn danger";
  dropFamily.textContent = "Remove family";
  dropFamily.title = `Remove ${family} from every difficulty`;
  dropFamily.addEventListener("click", () => {
    gridRemember();
    removeFamily(category, family);
    renderPoolGrid();
    renderSeasonCategories();
    seasonDirty(true);
    scheduleDistribution();
    gridFocus();
  });
  famRow.append(famInput, dropFamily);

  const categoryField = add("label", "editor-field");
  categoryField.append(document.createTextNode("Move family to category"));
  const categoryPicker = document.createElement("select");
  seasonDraft.categories.forEach(c => categoryPicker.add(new Option(c.name, c.name)));
  categoryPicker.value = category;
  categoryPicker.addEventListener("change", () => editorMoveFamily(familyKey, categoryPicker.value));
  categoryField.append(categoryPicker);

  if (!slot || !slot.scenario) {
    add("p", "pgd-empty", "Empty. Press Enter, or start typing, to fill it.");
    return;
  }

  const nameRow = add("div", "pgd-name");
  const nameText = document.createElement("strong");
  nameText.textContent = slot.scenario;
  nameRow.append(nameText);
  const play = playButton(slot.scenario);
  if (play) nameRow.append(play);
  const actions = add("div", "pgd-tools");
  const replace = document.createElement("button");
  replace.type = "button"; replace.className = "pool-btn"; replace.textContent = "Replace";
  replace.addEventListener("click", () => gridOpenSearch(""));
  const clear = document.createElement("button");
  clear.type = "button"; clear.className = "pool-btn danger"; clear.textContent = "Clear slot";
  clear.addEventListener("click", () => { editorClearSlot(); gridFocus(); });
  actions.append(replace, clear);

  const field = (label, key, multiline = false) => {
    const wrap = add("label", "editor-field");
    wrap.append(document.createTextNode(label));
    const input = document.createElement(multiline ? "textarea" : "input");
    input.value = slot[key] ?? "";
    input.addEventListener("change", () => {
      if (input.value === (slot[key] ?? "")) return;
      gridRemember(); slot[key] = input.value;
      if (key === "focus" || key === "subCategory") {
        for (const sibling of seasonDraft.scenarios) if (familyKeyOf(sibling) === familyKey) sibling[key] = input.value;
      }
      seasonDirty(true);
      if (key === "label") {
        const td = $("poolGrid").querySelector("td.sel");
        if (td) gridFillCell(td, slot, gridDuplicates());
      }
    });
    wrap.append(input);
  };
  field("Display name", "label");
  field("Family practice cue", "focus", true);
  field("Family sub-category", "subCategory");

  const was = originalOf(slot);
  if (isReplaced(slot)) {
    const wasRow = add("div", "pgd-was");
    wasRow.append(document.createTextNode(was ? `was ${was.scenario}` : "new slot"));
    if (was) {
      const revert = document.createElement("button");
      revert.type = "button";
      revert.className = "pool-btn";
      revert.textContent = "Revert";
      revert.title = "Put the original scenario and its thresholds back (Backspace)";
      revert.addEventListener("click", () => { gridRevert(slot); gridFocus(); });
      wasRow.append(revert);
    }
  }

  const option = seasonAvailable.find((o) => o.name === slot.scenario);
  const p = provenanceOf(slot.scenario);
  const facts = [p.text, p.board];
  if (option?.runs) facts.push(`you: ${option.runs} runs, best ${pts(option.best)}`);
  const factRow = add("div", "pgd-facts" + (p.thin ? " thin" : ""), facts.filter(Boolean).join(" · "));
  factRow.title = p.title;

  // The sub-skill check in validate:pool, said while the choice is still being made.
  if (option?.subSkill && slot.subCategory && option.subSkill !== slot.subCategory) {
    add(
      "p",
      "pgd-warn",
      `The benchmarks file this under ${option.subSkill}, and the ${family} family is ${slot.subCategory}. ` +
        `Check that this scenario belongs in the family before saving.`,
    );
  }

  const armRow = add("label", "pgd-arm");
  const armLabel = document.createElement("span");
  armLabel.textContent = "Part of the arm";
  const arm = document.createElement("select");
  for (const part of ARM_PARTS) {
    const opt = document.createElement("option");
    opt.value = part;
    opt.textContent = part;
    arm.append(opt);
  }
  arm.value = ARM_PARTS.includes(slot.arm) ? slot.arm : "";
  const viscose = slot.armFrom === "Viscose";
  arm.disabled = viscose;
  arm.title = viscose
    ? "This arm classification comes from the Viscose benchmark."
    : "The season's own call: which part of the arm this scenario mostly asks for";
  const armFrom = document.createElement("small");
  armFrom.textContent = viscose ? "Viscose" : "Apogee";
  arm.addEventListener("keydown", (e) => e.stopPropagation());
  arm.addEventListener("change", () => {
    gridRemember();
    slot.arm = arm.value;
    slot.armFrom = "Apogee";
    seasonDirty(true);
  });
  armRow.append(armLabel, arm, armFrom);

  const shared = gridDuplicates().get(slot.scenario) ?? [];
  if (shared.length > 1) add("p", "pgd-warn", `Also used in ${shared.filter((s) => s !== `${family} · ${windowLabel(w)}`).join(", ")}.`);

  const state = gridCuts.get(cutKeyOf(slot));
  if (state?.state === "pending" || slot.source?.why === CUT_WAITING) {
    add("p", "pgd-busy", state?.message ?? "Cutting thresholds from its board…");
  } else if (state?.message) {
    add("p", "pgd-warn", state.message);
  }

  const thresholds = add("div", "pgd-thr");
  const derived = gridCutResults.get(cutKeyOf(slot))?.rankMaxes ?? null;
  const rankNames = cat ? cat.rankNames.slice(w * size, w * size + slot.rankMaxes.length) : [];
  let before = null;

  slot.rankMaxes.forEach((value, i) => {
    const row = document.createElement("label");
    row.className = "pgd-rung";
    const rank = document.createElement("span");
    rank.className = "pgd-rank";
    rank.textContent = rankNames[i] ?? `rank ${w * size + i + 1}`;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "thr";
    input.value = String(value);
    if (derived && derived[i] !== value) {
      input.classList.add("override");
      input.title = `Set by hand. The board gives ${num(derived[i])}.`;
    }
    const share = document.createElement("span");
    share.className = "pgd-share";
    share.textContent = cut?.fractions[i] != null ? `top ${pctText(cut.fractions[i])}` : "";

    input.addEventListener("focus", () => { before = gridSnapshot(); });
    input.addEventListener("paste", e => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!/[\t\n]/.test(text)) return;
      e.preventDefault();
      const values = text.trim().split(/\s+/).map(Number);
      if (editorPasteThresholds(slot, i, values)) {
        gridPaintDetail();
        const next = $("poolGridDetail").querySelectorAll("input.thr")[Math.min(i + values.length, slot.rankMaxes.length - 1)];
        next?.focus();
      }
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const inputs = [...thresholds.querySelectorAll("input")];
        const next = inputs[inputs.indexOf(input) + 1];
        if (next) next.focus();
        else gridFocus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        gridFocus();
      }
    });
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (input.value === "" || !Number.isFinite(next)) {
        input.value = String(slot.rankMaxes[i]);
        return;
      }
      if (next === slot.rankMaxes[i]) return;
      gridRemember(before);
      gridCancelCut(slot);
      slot.rankMaxes[i] = next;

      const landed = gridCutResults.get(cutKeyOf(slot));
      const original = originalOf(slot);
      if (landed && landed.rankMaxes.every((v, j) => v === slot.rankMaxes[j])) {
        slot.source = JSON.parse(JSON.stringify(landed.source));
      } else if (original && original.scenario === slot.scenario &&
                 original.rankMaxes.every((v, j) => v === slot.rankMaxes[j])) {
        slot.source = JSON.parse(JSON.stringify(original.source ?? { kind: "authored", why: HAND_SET }));
      } else {
        slot.source = { kind: "authored", why: HAND_SET };
      }

      const ascending = slot.rankMaxes.every((v, j) => Number.isFinite(v) && (j === 0 || v > slot.rankMaxes[j - 1]));
      if (ascending) gridCuts.delete(cutKeyOf(slot));
      else gridCuts.set(cutKeyOf(slot), { state: "check", message: "Thresholds have to rise from each rank to the next." });

      input.classList.toggle("override", !!derived && derived[i] !== next);
      const td = $("poolGrid").querySelector(`td[data-family="${CSS.escape(familyKey)}"][data-window="${w}"]`);
      if (td) gridFillCell(td, slot, gridDuplicates());
      gridPaintBar();
      seasonDirty(true);
      scheduleDistribution();
    });

    row.append(rank, input, share);
    thresholds.append(row);
  });

  const tools = add("div", "pgd-tools");
  const recut = document.createElement("button");
  recut.type = "button";
  recut.className = "pool-btn";
  recut.textContent = "Cut from board again";
  recut.title = `Replace these thresholds with the ${windowLabel(w)} shares of this scenario's board`;
  recut.disabled = !cut;
  recut.addEventListener("click", () => { gridRecut(slot); gridFocus(); });
  tools.append(recut);
  const reason = add("label", "editor-field");
  reason.append(document.createTextNode("Threshold rationale"));
  const why = document.createElement("textarea");
  why.value = slot.source?.why ?? "";
  why.addEventListener("change", () => {
    if (why.value === (slot.source?.why ?? "")) return;
    gridRemember();
    slot.source = {...(slot.source ?? {kind:"authored"}), why:why.value};
    seasonDirty(true);
  });
  reason.append(why);
  // Numbers stay in reach. Naming and family metadata remain available without pushing
  // the primary controls below the fold on a laptop.
  const notes = document.createElement("details");
  notes.className = "editor-notes"; notes.open = gridDetailsOpen;
  const summary = document.createElement("summary"); summary.textContent = "Names, family and notes";
  notes.append(summary);
  const warnings = [...host.querySelectorAll(".pgd-warn,.pgd-busy")];
  const primary = new Set([location,nameRow,actions,thresholds,tools,...warnings]);
  for (const child of [...host.children]) if (!primary.has(child)) notes.append(child);
  host.replaceChildren(location,nameRow,actions,...warnings,thresholds,tools,notes);
  notes.addEventListener("toggle", () => { if (notes.isConnected) gridDetailsOpen = notes.open; });
}

/* ---- moving around ---- */

function gridFocus() {
  const wrap = $("poolGrid");
  if (wrap) wrap.focus({ preventScroll: true });
}

function gridRowsOnScreen() {
  return [...($("poolGrid")?.querySelectorAll("tr[data-family]") ?? [])].map((tr) => tr.dataset.family);
}

let gridSelectionFrame = null;
function gridSelect(familyKey, window) {
  const host = $("poolGrid");
  if (!host) return;
  const previous = host.querySelector("td.pg-cell.sel");
  if (previous) {
    previous.classList.remove("sel");
    previous.setAttribute("aria-selected", "false");
  }
  gridSel = { family: familyKey, window };
  const td = host.querySelector(`td[data-family="${CSS.escape(familyKey)}"][data-window="${window}"]`);
  if (td) {
    td.classList.add("sel");
    td.setAttribute("aria-selected", "true");

  }
  cancelAnimationFrame(gridSelectionFrame);
  gridSelectionFrame = requestAnimationFrame(() => { if (td?.isConnected) gridReveal(td); gridPaintDetail(); });
  // The search box names the slot it will fill, so it follows the selection even while closed.
  gridSetSearchTarget();
}

function gridMove(dRow, dCol) {
  const rows = gridRowsOnScreen();
  if (rows.length === 0) return;
  const windows = (seasonDraft.windows ?? []).length;
  const at = Math.max(0, rows.indexOf(gridSel.family));
  const row = Math.max(0, Math.min(rows.length - 1, at + dRow));
  const col = Math.max(0, Math.min(windows - 1, gridSel.window + dCol));
  gridSelect(rows[row], col);
}

/** The next slot in reading order: across the family, then down to the next one. */
function gridAdvance(direction) {
  const rows = gridRowsOnScreen();
  const windows = (seasonDraft.windows ?? []).length;
  if (rows.length === 0 || windows === 0) return;
  let row = Math.max(0, rows.indexOf(gridSel.family));
  let col = gridSel.window + direction;
  if (col >= windows) { if (row === rows.length - 1) return false; col = 0; row++; }
  if (col < 0) { if (row === 0) return false; col = windows - 1; row--; }
  gridSelect(rows[row], col);
  return true;
}

/* ---- the search ---- */

function gridSetSearchTarget() {
  const slot = gridSlot(gridSel.family, gridSel.window);
  gridSearchSlot = slot;
  const label = $("poolGridTarget");
  if (!label) return;
  const family = gridSel.family ? gridSel.family.split("/").slice(1).join("/") : "";
  label.textContent = slot?.scenario
    ? `${family} · ${windowLabel(gridSel.window)} · now ${slot.label || slot.scenario}`
    : `${family} · ${windowLabel(gridSel.window)} · empty`;
}

function gridOpenSearch(seed) {
  const input = $("poolGridQuery");
  if (!input) return;
  gridSetSearchTarget();
  $("poolGridSearch").classList.add("open");
  input.setAttribute("aria-expanded", "true");
  input.value = seed ?? "";
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  gridRenderHits();
  gridSearchRemote(input.value.trim());
}

function gridCloseSearch(focusGrid) {
  gridSearchSlot = null;
  $("poolGridSearch")?.classList.remove("open");
  const input = $("poolGridQuery");
  if (input) { input.value = ""; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
  const list = $("poolGridHits");
  if (list) list.textContent = "";
  if (focusGrid) gridFocus();
}

/**
 * Scenarios matching every word typed, best first.
 *
 * Every word, in any order, so "pasu adv" finds VT Pasu Advanced S5. Ranked by how the name
 * matches, then by the things that decide whether a scenario belongs in the slot: the slot's
 * own category, a board big enough to cut from, and how many people are on it.
 */
function gridMatches(term, slot) {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const whole = term.trim().toLowerCase();
  const scored = [];
  for (const option of seasonAvailable) {
    const name = option.name.toLowerCase();
    if (!words.every((w) => name.includes(w))) continue;
    let score = 0;
    if (name === whole) score += 1000;
    else if (name.startsWith(whole)) score += 400;
    else if (name.startsWith(words[0])) score += 150;
    if (slot && option.category === slot.category) score += 60;
    if (option.leaderboardId && (option.entries ?? 0) >= MIN_BOARD) score += 40;
    score += Math.min(30, Math.log10((option.entries ?? 0) + 1) * 6);
    if (option.runs) score += Math.min(10, option.runs / 5);
    scored.push({ option, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.option.name.localeCompare(b.option.name))
    .slice(0, 40)
    .map((s) => s.option);
}

function gridRenderHits() {
  const list = $("poolGridHits");
  const input = $("poolGridQuery");
  if (!list || !input) return;
  const term = input.value.trim();
  const previous = gridSearchHits[gridSearchActive]?.name;
  gridSearchHits = gridMatches(term, gridSearchSlot);
  const keep = gridSearchHits.findIndex((o) => o.name === previous);
  gridSearchActive = keep >= 0 ? keep : 0;
  list.textContent = "";

  if (!term) {
    const hint = document.createElement("div");
    hint.className = "pg-hint";
    hint.textContent =
      "Type a scenario name. Enter puts it here and moves on · Tab keeps this one · " +
      "Esc closes";
    list.append(hint);
    return;
  }
  if (gridSearchHits.length === 0) {
    const hint = document.createElement("div");
    hint.className = "pg-hint";
    const remote = gridRemoteState.get(term.toLowerCase());
    hint.textContent = term.length < 2 ? "Type at least two characters to search KovaaK's."
      : remote === "done" ? "No matching scenarios here or on KovaaK's."
      : remote === "error" ? "KovaaK's search is unavailable. Edit the search to retry; local results still work."
      : "Searching KovaaK's…";
    list.append(hint);
    return;
  }

  const where = new Map();
  for (const x of seasonDraft.scenarios) {
    if (x.scenario) where.set(x.scenario, `${x.family} · ${windowLabel(x.window ?? 0)}`);
  }

  gridSearchHits.forEach((option, i) => {
    const row = document.createElement("div");
    row.className = "pg-hit" + (i === gridSearchActive ? " active" : "");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", i === gridSearchActive ? "true" : "false");

    const name = document.createElement("span");
    name.className = "pg-hit-name";
    name.textContent = option.name;

    const meta = document.createElement("span");
    meta.className = "pg-hit-meta";
    const thin = option.entries != null && option.entries < MIN_BOARD;
    const facts = [];
    if (option.category) facts.push(option.category);
    if (option.tiers?.length) facts.push(option.tiers[0]);
    facts.push(option.entries == null ? "board not sampled" : `${num(option.entries)} on the board${thin ? ", thin" : ""}`);
    if (option.runs) facts.push(`${option.runs} run${option.runs === 1 ? "" : "s"} here`);
    meta.textContent = facts.join(" · ");

    row.append(name, meta);
    const used = where.get(option.name);
    if (used) {
      const tag = document.createElement("span");
      tag.className = "pg-hit-used";
      tag.textContent = `in ${used}`;
      row.append(tag);
    }
    if (thin) row.classList.add("thin");

    // mousedown, not click: a click lands after the input's blur would have closed the list.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      gridSearchActive = i;
      gridPick();
    });
    list.append(row);
  });

  gridHighlightHit();
}

function gridSearchRemote(term) {
  if (gridRemoteTimer) clearTimeout(gridRemoteTimer);
  const key = term.toLowerCase();
  if (term.length < 2 || gridRemoteAsked.has(key)) return;
  gridRemoteTimer = setTimeout(async () => {
    gridRemoteAsked.add(key);
    gridRemoteState.set(key, "pending");
    let found = null;
    try {
      found = await window.apogee.searchScenarios(term);
    } catch {
      found = null;
    }
    gridRemoteState.set(key, found && !found.error ? "done" : "error");
    if (!found || found.error) gridRemoteAsked.delete(key);
    for (const hit of found?.scenarios ?? []) {
      const category = hit.aimType === "Target Switching" ? "Switching" : hit.aimType;
      const existing = seasonAvailable.find((o) => o.name === hit.name);
      if (existing) {
        if (!existing.leaderboardId) existing.leaderboardId = hit.leaderboardId;
        if (!existing.category && category) existing.category = category;
        if (existing.entries == null && hit.entries) existing.entries = hit.entries;
        continue;
      }
      seasonAvailable.push({
        name: hit.name,
        category,
        difficulty: null,
        leaderboardId: hit.leaderboardId,
        entries: hit.entries ?? null,
        runs: 0,
        best: null,
        suggested: {},
      });
    }
    if ($("poolGridSearch").classList.contains("open") && $("poolGridQuery")?.value.trim().toLowerCase() === key) gridRenderHits();
  }, 250);
}

function gridPick() {
  const option = gridSearchHits[gridSearchActive];
  const slot = gridSlot(gridSel.family, gridSel.window);
  if (!option || !slot) return;
  if (option.name !== slot.scenario) {
    gridRemember();
    gridReplace(slot, option);
    gridPaintSlot(`${gridSel.family}/${gridSel.window}`);
    seasonDirty(true);
    scheduleDistribution();
  }
  if ($("poolAutoAdvance")?.checked !== false) gridAdvance(1);
  const input = $("poolGridQuery");
  input.value = "";
  gridRenderHits();
  input.focus();
}

/* ---- wiring, once ---- */

function editorName(name) {
  if (!name.trim() || /[\/|\x00-\x1f]/.test(name) || name.length > 80) {
    setSeasonStatus("Use a name of 1–80 characters, without / or |.", "bad");
    return false;
  }
  return true;
}

function gridReveal(td) {
  // Only scroll the grid. scrollIntoView also moves the entire page on each keypress.
  const host = $("poolGrid");
  const top = td.offsetTop, bottom = top + td.offsetHeight;
  const inset = host.querySelector("thead")?.offsetHeight ?? 0;
  if (top < host.scrollTop + inset) host.scrollTop = Math.max(0, top - inset);
  else if (bottom > host.scrollTop + host.clientHeight) host.scrollTop = bottom - host.clientHeight;
  if (td.offsetLeft < host.scrollLeft) host.scrollLeft = td.offsetLeft;
  else if (td.offsetLeft + td.offsetWidth > host.scrollLeft + host.clientWidth) {
    host.scrollLeft = td.offsetLeft + td.offsetWidth - host.clientWidth;
  }
}

function gridHighlightHit() {
  const list = $("poolGridHits");
  [...list.querySelectorAll(".pg-hit")].forEach((row, i) => {
    row.classList.toggle("active", i === gridSearchActive);
    row.setAttribute("aria-selected", String(i === gridSearchActive));
    row.id = `pool-hit-${i}`;
  });
  $("poolGridQuery").setAttribute("aria-activedescendant", `pool-hit-${gridSearchActive}`);
  const row = list.querySelector(".active");
  if (row) {
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }
}

function editorClearSlot() {
  const slot = gridSlot(gridSel.family, gridSel.window);
  if (!slot?.scenario) return;
  gridRemember();
  gridCancelCut(slot);
  const replacement = { category: slot.category, family: slot.family, window: slot.window,
    subCategory: slot.subCategory, scenario: "", label: slot.family, leaderboardId: null,
    rankMaxes: slot.rankMaxes.map((_, i) => i + 1) };
  seasonDraft.scenarios[seasonDraft.scenarios.indexOf(slot)] = replacement;
  gridPaintSlot(slotKeyOf(replacement));
  gridSetSearchTarget();
  seasonDirty(true);
  scheduleDistribution();
}

function editorStructureChanged() {
  gridCancelCuts();
  gridResumeCuts();
  renderSeasonEditor();
  seasonDirty(true);
}

function editorAddCategory(name) {
  name = name.trim();
  if (!editorName(name)) return false;
  if (seasonDraft.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    setSeasonStatus(`There is already a category called ${name}.`, "bad");
    return false;
  }
  const template = seasonDraft.categories.find(c => c.name === gridCategory) ?? seasonDraft.categories[0];
  if (!template) return false;
  gridRemember();
  const category = { name, rankNames: template.rankNames.slice(), rankColors: {...template.rankColors}, rankMaxes: template.rankMaxes.slice() };
  seasonDraft.categories.push(category);
  let family = `${name} 1`;
  while (seasonDraft.scenarios.some(s => s.family === family)) family += " new";
  addFamily(name, family);
  gridCategory = name;
  gridFilter = "all";
  gridSel = { family: `${name}/${family}`, window: 0 };
  editorStructureChanged();
  gridOpenSearch("");
  return true;
}

function editorRenameCategory(category, name) {
  name = name.trim();
  if (!editorName(name) || name === category.name) return false;
  if (seasonDraft.categories.some(c => c !== category && c.name.toLowerCase() === name.toLowerCase())) {
    setSeasonStatus(`There is already a category called ${name}.`, "bad"); return false;
  }
  gridRemember();
  const oldName = category.name;
  const renamed = (seasonDraft.$renamed ??= {});
  for (const f of gridFamilies().filter(f => f.category === oldName)) {
    const origin = originalFamilyKey(f.key);
    delete renamed[f.key];
    const next = `${name}/${f.family}`;
    if (next !== origin) renamed[next] = origin;
    if (gridSel.family === f.key) gridSel.family = next;
  }
  for (const slot of seasonDraft.scenarios) if (slot.category === oldName) slot.category = name;
  category.name = name;
  if (gridCategory === oldName) gridCategory = name;
  editorStructureChanged();
  return true;
}

function editorRemoveCategory(category) {
  if (seasonDraft.categories.length <= 1) return;
  gridRemember();
  seasonDraft.categories = seasonDraft.categories.filter(c => c !== category);
  seasonDraft.scenarios = seasonDraft.scenarios.filter(s => s.category !== category.name);
  if (gridCategory === category.name) gridCategory = "";
  editorStructureChanged();
  gridFocus();
}

function editorMoveFamily(key, category) {
  const slots = seasonDraft.scenarios.filter(s => familyKeyOf(s) === key);
  if (!slots.length || slots[0].category === category) return;
  const oldCategory = slots[0].category, family = slots[0].family;
  if (seasonDraft.scenarios.some(s => s.category === category && s.family === family)) {
    setSeasonStatus(`${category} already contains ${family}.`, "bad"); return;
  }
  gridRemember();
  const next = `${category}/${family}`, origin = originalFamilyKey(key);
  const renamed = (seasonDraft.$renamed ??= {});
  delete renamed[key];
  if (origin !== next) renamed[next] = origin;
  slots.forEach(s => { s.category = category; });
  rebalanceEnergy(oldCategory); rebalanceEnergy(category);
  gridSel.family = next;
  if (gridCategory) gridCategory = category;
  editorStructureChanged();
}

function editorRenderToolbar() {
  const picker = $("poolCategory");
  if (!picker) return;
  if (!seasonDraft.categories.some(c => c.name === gridCategory)) gridCategory = "";
  picker.replaceChildren(new Option("All categories", ""), ...seasonDraft.categories.map(c => new Option(c.name, c.name)));
  picker.value = gridCategory;
  for (const b of document.querySelectorAll("[data-grid-filter]")) b.setAttribute("aria-pressed", String(b.dataset.gridFilter === gridFilter));
  if (document.activeElement !== $("seasonName")) $("seasonName").value = seasonDraft.name;
}

/** A rectangular TSV paste replaces only explicitly named cells. One undo covers it all. */
function editorPaste(text) {
  const matrix = text.replace(/\r/g, "").replace(/\n+$/, "").split("\n").map(line => line.split("\t"));
  const rows = gridRowsOnScreen(), start = rows.indexOf(gridSel.family);
  if (start < 0 || !text.trim()) return false;
  const names = new Map(seasonAvailable.map(s => [s.name.toLowerCase(), s]));
  const changes = [], problems = [];
  const columns = (seasonDraft.windows ?? []).length;
  const oneColumn = matrix.every(row => row.length === 1);
  matrix.forEach((row, r) => row.forEach((value, c) => {
    const name = value.trim();
    if (!name) return;
    // A line-separated list fills in reading order; TSV keeps its spreadsheet shape.
    const offset = gridSel.window + r;
    const targetRow = oneColumn ? start + Math.floor(offset / columns) : start + r;
    const targetColumn = oneColumn ? offset % columns : gridSel.window + c;
    const slot = targetColumn < columns ? gridSlot(rows[targetRow], targetColumn) : null;
    if (!slot) { problems.push(`No slot for “${name}”`); return; }
    const option = names.get(name.toLowerCase());
    if (!option) { problems.push(`Search once to load “${name}” before pasting it`); return; }
    if (slot.scenario !== option.name) changes.push({slot,option});
  }));
  if (problems.length) { setSeasonStatus(`${problems.slice(0, 2).join(". ")}. Nothing pasted.`, "bad"); return false; }
  if (!changes.length) return true;
  gridRemember();
  changes.forEach(({slot,option}) => gridReplace(slot, option));
  renderPoolGrid();
  seasonDirty(true);
  scheduleDistribution();
  gridCloseSearch(true);
  return true;
}

function editorExportDraft() {
  const contents = JSON.stringify({ format: "apogee-season-draft", version: 1, season: seasonDraft,
    ladder: seasonPercentiles, rankTheme: rankThemeDirty ? rankTheme : null }, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = `${seasonDraft.name.replace(/[^a-z0-9_-]+/gi, "-")}-draft.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function editorPasteThresholds(slot, start, values) {
  if (!values.length || values.some(n => !Number.isFinite(n)) || start + values.length > slot.rankMaxes.length) {
    setSeasonStatus("Paste one number per remaining rank, separated by tabs or new lines. Nothing changed.", "bad"); return false;
  }
  const proposed = slot.rankMaxes.slice();
  proposed.splice(start, values.length, ...values);
  if (proposed.some((n,i) => !Number.isFinite(n) || n < 0 || (i > 0 && n <= proposed[i-1]))) {
    setSeasonStatus("Thresholds must rise from each rank to the next. Nothing changed.", "bad"); return false;
  }
  gridRemember(); gridCancelCut(slot);
  slot.rankMaxes = proposed; slot.source = {kind:"authored",why:HAND_SET};
  gridPaintSlot(slotKeyOf(slot)); seasonDirty(true); scheduleDistribution();
  return true;
}

function editorAddFamilies(category, text) {
  const names = text.split(/\r?\n/).map(n => n.trim()).filter(Boolean);
  if (!seasonDraft.categories.some(c => c.name === category)) return "Choose a category.";
  if (!names.length || names.length > 100) return "Enter between 1 and 100 family names.";
  const existing = new Set(seasonDraft.scenarios.map(s => s.family?.toLowerCase()));
  for (const name of names) {
    if (!editorName(name)) return "Family names must be 1–80 characters without / or |.";
    if (existing.has(name.toLowerCase())) return `A family named ${name} already exists. Nothing added.`;
    existing.add(name.toLowerCase());
  }
  gridRemember();
  names.forEach(name => addFamily(category, name));
  gridCategory = category; gridFilter = "all";
  gridSel = {family:`${category}/${names[0]}`,window:0};
  editorStructureChanged();
  return null;
}

function editorImportDraft(raw) {
  const draft = raw?.season;
  if (raw?.format !== "apogee-season-draft" || raw.version !== 1 || !draft ||
      typeof draft.name !== "string" || !Array.isArray(draft.categories) || !draft.categories.length ||
      !Array.isArray(draft.scenarios) || !Array.isArray(draft.rankNames) || !draft.rankColors ||
      !Array.isArray(draft.windows) || !draft.windows.length || !draft.windows.every(w => typeof w === "string") ||
      !Number.isInteger(draft.windowSize) || draft.windowSize < 1 ||
      draft.categories.some(c => !c || typeof c.name !== "string" || !c.name.trim() ||
        !Array.isArray(c.rankNames) || !c.rankNames.every(n => typeof n === "string") || !c.rankColors || !Array.isArray(c.rankMaxes)) ||
      draft.scenarios.some(s => !s || typeof s.scenario !== "string" || typeof s.category !== "string" ||
        typeof s.family !== "string" || !Array.isArray(s.rankMaxes) || !Number.isInteger(s.window))) {
    throw new Error("This is not a supported Apogee season draft export.");
  }
  if (raw.ladder && (!Array.isArray(raw.ladder.ranks) || raw.ladder.ranks.length !== draft.windows.length * draft.windowSize ||
      raw.ladder.ranks.some((n,i,a) => !Number.isFinite(n) || n <= 0 || n > 1 || (i > 0 && n >= a[i-1])))) {
    throw new Error("The draft's percentile ladder is invalid.");
  }
  if (raw.rankTheme && (!Array.isArray(raw.rankTheme.tiers) || raw.rankTheme.tiers.some(t => !t || typeof t.name !== "string" || typeof t.color !== "string"))) {
    throw new Error("The draft's rating tiers are invalid.");
  }
  gridRemember();
  gridCancelCuts(); gridCutResults.clear();
  seasonDraft = structuredClone(draft); delete seasonDraft.$editor;
  seasonPercentiles = structuredClone(raw.ladder ?? seasonPercentiles);
  if (raw.rankTheme) { rankTheme = structuredClone(raw.rankTheme); rankThemeDirty = true; }
  gridCategory = ""; gridFilter = "all";
  editorStructureChanged();
}

function wirePoolGrid() {
  const wrap = $("poolGrid");
  if (!wrap || wrap.dataset.wired) return;
  wrap.dataset.wired = "1";
  $("poolCategory").addEventListener("change", e => {
    gridCategory = e.target.value; renderPoolGrid(); gridFocus();
  });
  $("poolAddCategory").addEventListener("click", e => askInline(e.target, "Category name…", editorAddCategory));
  $("poolAddFamily").addEventListener("click", () => {
    const category = gridCategory || gridSlot(gridSel.family, gridSel.window)?.category || seasonDraft.categories[0]?.name;
    const add = [...wrap.querySelectorAll(".pool-addfam")].find(b => b.dataset.category === category);
    add?.click();
  });
  $("poolAddWindow").addEventListener("click", e => askInline(e.target, "Difficulty name…", name => {
    if (!editorName(name) || seasonDraft.windows.includes(name)) return;
    gridRemember(); addWindow(name); editorStructureChanged();
  }));
  $("seasonName").addEventListener("change", e => {
    const name = e.target.value.trim();
    if (!name) { e.target.value = seasonDraft.name; return; }
    if (name === seasonDraft.name) return;
    gridRemember(); seasonDraft.name = name; seasonDirty(true);
  });
  $("seasonExportDraft").addEventListener("click", editorExportDraft);
  $("seasonImportDraft").addEventListener("click", () => $("seasonImportFile").click());
  $("seasonImportFile").addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Draft files must be smaller than 5 MB.");
      editorImportDraft(JSON.parse(await file.text()));
    } catch (error) { setSeasonStatus(error.message, "bad"); }
    e.target.value = "";
  });
  $("poolBatchFamilies").addEventListener("click", () => {
    const category = $("seasonBatchCategory");
    category.replaceChildren(...seasonDraft.categories.map(c => new Option(c.name,c.name)));
    category.value = gridCategory || gridSlot(gridSel.family,gridSel.window)?.category || seasonDraft.categories[0].name;
    $("seasonBatchNames").value = ""; $("seasonBatchError").textContent = "";
    $("seasonBatchDialog").showModal(); $("seasonBatchNames").focus();
  });
  $("seasonBatchCancel").addEventListener("click", () => $("seasonBatchDialog").close());
  $("seasonBatchForm").addEventListener("submit", e => {
    e.preventDefault();
    const error = editorAddFamilies($("seasonBatchCategory").value, $("seasonBatchNames").value);
    if (error) { $("seasonBatchError").textContent = error; return; }
    $("seasonBatchDialog").close(); gridOpenSearch("");
  });
  $("poolCompact").addEventListener("change", e => $("poolPanel").classList.toggle("compact", e.target.checked));
  const paste = e => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (e.target === wrap || /[\t\n]/.test(text)) { e.preventDefault(); editorPaste(text); }
  };
  wrap.addEventListener("paste", paste);
  $("poolGridQuery").addEventListener("paste", paste);

  wrap.addEventListener("mousedown", (e) => {
    const td = e.target.closest("td.pg-cell");
    if (!td) return;
    e.preventDefault();
    gridCloseSearch(false);
    gridSelect(td.dataset.family, Number(td.dataset.window));
    gridFocus();
  });
  wrap.addEventListener("dblclick", (e) => {
    if (e.target.closest("td.pg-cell")) gridOpenSearch("");
  });

  wrap.addEventListener("keydown", (e) => {
    if (e.target !== wrap || e.isComposing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    let handled = true;
    if (ctrl && (k === "z" || k === "Z")) gridStep(e.shiftKey ? 1 : -1);
    else if (ctrl && (k === "y" || k === "Y")) gridStep(1);
    else if (ctrl || e.altKey) handled = false;
    else if (k === "ArrowUp") gridMove(-1, 0);
    else if (k === "ArrowDown") gridMove(1, 0);
    else if (k === "ArrowLeft") gridMove(0, -1);
    else if (k === "ArrowRight") gridMove(0, 1);
    else if (k === "PageUp") gridMove(-10, 0);
    else if (k === "PageDown") gridMove(10, 0);
    else if (k === "Home") gridMove(0, -99);
    else if (k === "End") gridMove(0, 99);
    else if (k === "Enter" && e.shiftKey) {
      cancelAnimationFrame(gridSelectionFrame); gridPaintDetail();
      $("poolGridDetail")?.querySelector("input.thr")?.focus();
    }
    else if (k === "Enter" || k === "F2") gridOpenSearch("");
    else if (k === "Delete") editorClearSlot();
    else if (k === "Tab") gridAdvance(e.shiftKey ? -1 : 1);
    else if (k === "Backspace") {
      const slot = gridSlot(gridSel.family, gridSel.window);
      if (slot) gridRevert(slot);
    } else if (k.length === 1 && k !== " ") gridOpenSearch(k);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  const input = $("poolGridQuery");
  input.addEventListener("input", () => {
    gridRenderHits();
    gridSearchRemote(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    e.stopPropagation();
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "s") { e.preventDefault(); $("seasonSave").click(); return; }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      if (gridSearchHits.length === 0) return;
      gridSearchActive = (gridSearchActive + (k === "ArrowDown" ? 1 : -1) + gridSearchHits.length) % gridSearchHits.length;
      gridHighlightHit();
    } else if (k === "Enter") {
      e.preventDefault();
      if (gridSearchHits.length > 0) gridPick();
    } else if (k === "Tab") {
      e.preventDefault();
      gridAdvance(e.shiftKey ? -1 : 1);
      input.value = "";
      gridRenderHits();
    } else if (k === "Escape") {
      e.preventDefault();
      gridCloseSearch(true);
    } else if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z") && input.value === "") {
      e.preventDefault();
      gridStep(e.shiftKey ? 1 : -1);
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== input) gridCloseSearch(false);
    }, 120);
  });
  input.addEventListener("focus", () => {
    if (!gridSearchSlot) gridSetSearchTarget();
    $("poolGridSearch").classList.add("open");
    input.setAttribute("aria-expanded", "true");
    gridRenderHits();
  });

  $("poolGridUndo").addEventListener("click", () => gridStep(-1));
  $("poolGridRedo").addEventListener("click", () => gridStep(1));
  $("poolGridReset").addEventListener("click", () => {
    gridCountFromHere();
    gridFocus();
  });

  for (const button of document.querySelectorAll("[data-grid-filter]")) {
    button.addEventListener("click", () => {
      gridFilter = button.dataset.gridFilter;
      for (const b of document.querySelectorAll("[data-grid-filter]")) {
        b.setAttribute("aria-pressed", b === button ? "true" : "false");
      }
      renderPoolGrid();
      gridFocus();
    });
  }

  $("screen-season")?.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault(); e.stopPropagation();
      const save = $("seasonSave");
      if (save && !save.disabled) save.click();
    } else if ((key === "z" || key === "y") && !e.target.closest("input,textarea,select,[contenteditable=true]")) {
      e.preventDefault(); e.stopPropagation(); gridStep(key === "y" || e.shiftKey ? 1 : -1);
    }
  }, true);
}

/* ------------------------------------------------------------------ ranks */

/**
 * The two ladders, side by side, and what closes the gap on each.
 *
 * Apogee's ladder and the benchmark's are different claims and are kept visually apart
 * on purpose (PLAN.md §4): one is where you sit against other players, the other is
 * what Voltaic says about your scores. Showing them on one page is the clearest way to
 * make that difference legible rather than the easiest way to blur it, so each keeps
 * its own colours - Apogee's tiers from the theme, the benchmark's from the benchmark.
 */
/**
 * The player's view of the season.
 *
 * The editor next door reads the same file. Neither is a security boundary - the
 * season ships inside the app, so anyone can already open it - and this exists for a
 * different reason: on an evening when nobody is queueing, the season is the only
 * thing left to play against, and "what should I grind" should not require reading
 * JSON. The ladders come from the snapshot, which already carries every category's
 * names, colours and thresholds; only the scenario pool needs the season file, so the
 * screen renders without it and fills the pool in when it arrives.
 */
let seasonPool = window.__APOGEE_SEASON__ ?? null;

/**
 * The pool measured against local history: one row per scenario, not per family.
 *
 * Fetched separately from the season because it depends on the stats folder rather than
 * the season file, and because it has to be re-read after a run - a personal best that is
 * one refresh stale is worse than none, since the player has the real number on screen in
 * KovaaK's while they are looking at this one.
 */
let practice =
  typeof window.__APOGEE_PRACTICE__ !== "undefined" ? window.__APOGEE_PRACTICE__ : null;

/**
 * Which difficulty the pool is showing, or null before anything has been chosen.
 *
 * Held here rather than recomputed per render: the screen repaints on every run that
 * lands, and a band that reset itself under the player mid-session would be worse than
 * not remembering at all.
 */
let seasonBand = null;

/**
 * Which category the pool is showing, or null for all six.
 *
 * Remembered per machine for the reason the queue category is: somebody working through
 * Reactive Tracking this week should come back to it, not to the top of a list of six. A
 * category the season no longer has falls back to all of them when the pool renders.
 */
const SEASON_CATEGORY_KEY = "apogee.seasonCategory";
let seasonCategory = null;
try {
  seasonCategory = localStorage.getItem(SEASON_CATEGORY_KEY);
} catch {
  /* storage unavailable: start on all six */
}

/**
 * A tier's percentile band, phrased the way the rest of the app phrases standing.
 *
 * The stored band is the share of the population the player is above, so Supernova is
 * [97, 100]. Printed raw that reads as a score near the bottom of a hundred rather than
 * the top three percent, which is exactly backwards, and it was the first thing anyone
 * asked about. The hero card already says "top 41.3%"; this matches it.
 */
function tierBand(percentile) {
  const [lo, hi] = percentile;
  if (hi >= 100) return "top " + (100 - lo) + "%";
  if (lo <= 0) return "bottom " + hi + "%";
  return "top " + (100 - hi) + "\u2013" + (100 - lo) + "%";
}

/**
 * A button that opens one scenario in KovaaK's, or null outside the desktop app.
 *
 * Shared by the Season pool and the Scenarios table so the two cannot drift apart on what
 * a failed launch looks like.
 */
function playButton(scenario) {
  if (HOST !== "electron" || !api || !api.launchScenario) return null;
  const play = document.createElement("button");
  play.type = "button";
  play.className = "scen-play";
  play.textContent = "Play";
  play.title = "Open " + scenario + " in KovaaK's";
  play.addEventListener("click", async () => {
    play.disabled = true;
    const prev = play.textContent;
    play.textContent = "…";
    try {
      const r = await api.launchScenario(scenario);
      if (r && r.error) {
        showError(r.error);
        play.textContent = prev;
      } else {
        play.textContent = "Opened";
        // Back to Play, so the same button can open it again after a restart of the game.
        setTimeout(() => { play.textContent = prev; }, 3000);
      }
    } finally {
      play.disabled = false;
    }
  });
  return play;
}

/** The scenario that the next rank is scored on, which is not always the one being played. */
function nextRankTarget(s) {
  return s.nextRankIsNewScenario && s.nextRankScenario ? s.nextRankScenario : s.name;
}

/* ---------------------------------------------------------- scenario ranks */

/**
 * What the Scenarios table is filtered and sorted by. Held across repaints for the same
 * reason as `seasonBand`: a run landing mid-grind repaints the table, and a filter that
 * reset itself would lose the scenario the player was watching.
 */
const scenarioView = { category: null, window: null, sort: "closest", query: "" };

/** Every word, any order, against the name, label and family. */
function matchesQuery(row, query) {
  const words = query.toLowerCase().split(/s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [row.scenario, row.name, row.label, row.family, row.category].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * The playlist that holds exactly what the Scenarios filter shows, when one exists: a
 * difficulty is chosen, and either one category or all of them. One press from "this is
 * what I want to practice" to having it in KovaaK's.
 */
function renderScenarioInstall() {
  const btn = $("scInstall");
  if (!btn) return;
  const windows = (practice && practice.season && practice.season.windows) || [];
  const w = scenarioView.window;
  const name = w === null || !windows[w] ? null
    : "Apogee " + (scenarioView.category === null ? "All" : scenarioView.category) + " " + windows[w];
  const offered = name && (practice.playlists || []).some((p) => p.name === name);
  btn.hidden = HOST !== "electron" || !offered;
  if (!offered) return;
  const installed = new Set(practice.installedNames || []).has(name);
  btn.textContent = installed ? "Installed in KovaaK's · " + name : "Install as a KovaaK's playlist · " + name;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api.installPlaylists([name]);
      if (r && r.error) showError(r.error);
      else showNotice("“" + name + "” is in KovaaK's Playlists. If the game is open, restart it to load it.");
    } finally {
      btn.disabled = false;
      refreshPractice();
    }
  };
}

/**
 * Every scenario in the season with the rank its best run earns on it.
 *
 * The Ranks table lists only the variant carrying each family, and only where a next rank
 * is left, so a player grinding one scenario had nowhere to see what that scenario is worth
 * on its own. The rank index is the core's (`practiceRows`), already offset onto the
 * sixteen-rank ladder; this only looks the name up in the category's ladder, which is the
 * same name every other screen prints for that index.
 */
/**
 * A practice row's ladder rank by index: its name, the season's colour for it, and that
 * colour lifted to read as text on the ground. Null name below the first threshold.
 */
function practiceRank(row, index) {
  const cats = (practice && practice.season && practice.season.categories) || [];
  const ladder = cats.find((c) => c.name === row.category);
  const name = ladder && index !== null && index !== undefined ? ladder.rankNames?.[index] ?? null : null;
  const colour = name ? ladder.rankColors?.[name] ?? null : null;
  return { name, colour, ink: colour ? legibleOnDark(colour, RANK_TEXT_CONTRAST) : null };
}

function renderScenarioRanks() {
  const body = $("scRanksBody");
  if (!body) return;

  const all = practice && Array.isArray(practice.scenarios) ? practice.scenarios : [];
  const cats = (practice && practice.season && practice.season.categories) || [];
  const windows = (practice && practice.season && practice.season.windows) || [];
  const ladderOf = new Map(cats.map((c) => [c.name, c]));

  const filterRow = (host, options, key) => {
    if (!host) return;
    host.textContent = "";
    [{ value: null, label: "All" }, ...options].forEach((o) => {
      const on = scenarioView[key] === o.value;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pool-band" + (on ? " on" : "");
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = o.label;
      btn.addEventListener("click", () => {
        scenarioView[key] = o.value;
        renderScenarioRanks();
      });
      host.append(btn);
    });
  };
  filterRow($("scCats"), cats.map((c) => ({ value: c.name, label: c.name })), "category");
  filterRow($("scBands"), windows.map((name, w) => ({ value: w, label: name })), "window");
  renderScenarioInstall();
  const search = $("scSearch");
  if (search && !search.dataset.wired) {
    search.dataset.wired = "1";
    search.addEventListener("input", () => {
      scenarioView.query = search.value;
      renderScenarioRanks();
    });
  }

  document.querySelectorAll(".sc-sort").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.sort === scenarioView.sort));
  });

  const nameAt = (row, index) => {
    const ladder = ladderOf.get(row.category);
    return ladder && index !== null && index !== undefined ? ladder.rankNames[index] ?? null : null;
  };
  const inkFor = (row, name) => {
    const colour = name ? ladderOf.get(row.category)?.rankColors?.[name] : null;
    return colour ? legibleOnDark(colour, RANK_TEXT_CONTRAST) : null;
  };

  const shown = all
    .map((r, order) => ({ r, order }))
    .filter(
      ({ r }) =>
        (scenarioView.category === null || r.category === scenarioView.category) &&
        (scenarioView.window === null || r.window === scenarioView.window) &&
        matchesQuery(r, scenarioView.query),
    );

  // Closest is in proportion to the target, as on the Ranks screen: 300 points is nothing
  // on a 90,000 scenario and most of a rank on a 1,200 one. Maxed rows go last because
  // nothing on them can move, unplayed ones just above because their gap is the whole
  // threshold.
  const closeness = (r) =>
    r.nextRankScore === null ? 3 : r.best === null ? 2 : r.gap / Math.max(1, r.nextRankScore);
  const sorters = {
    closest: (a, b) => closeness(a.r) - closeness(b.r) || a.order - b.order,
    rank: (a, b) =>
      (b.r.rankIndex ?? -1) - (a.r.rankIndex ?? -1) ||
      (b.r.progress ?? 0) - (a.r.progress ?? 0) ||
      a.order - b.order,
    category: (a, b) => a.order - b.order,
  };
  shown.sort(sorters[scenarioView.sort] || sorters.closest);

  const ranked = shown.filter(({ r }) => r.rankIndex !== null).length;
  const maxed = shown.filter(({ r }) => r.nextRankScore === null).length;
  if ($("scNote")) {
    $("scNote").textContent =
      shown.length === 0
        ? ""
        : num(ranked) + " of " + num(shown.length) + " ranked" +
          (maxed > 0 ? " · " + num(maxed) + " maxed" : "");
  }

  body.textContent = "";
  if (shown.length === 0) {
    body.innerHTML =
      '<tr><td colspan="9" class="empty">' +
      (all.length === 0 ? "Season not loaded yet." : "No scenarios match these filters.") +
      "</td></tr>";
    return;
  }

  for (const { r } of shown) {
    const held = nameAt(r, r.rankIndex);
    const maxedHere = r.nextRankScore === null;
    const next = maxedHere ? null : nameAt(r, r.nextRankIndex);

    const tr = document.createElement("tr");
    tr.className = "sc-row" + (maxedHere ? " maxed" : "") + (r.runs === 0 ? " untouched" : "");
    // Read by the smoke test, which holds the painted names to the core's rank indices.
    tr.dataset.rank = held ?? "";
    tr.innerHTML =
      "<td>" + esc(r.label) + ' <span class="win">' + esc(r.windowName) + "</span></td>" +
      "<td>" + esc(r.category) + "</td>" +
      // A played score short of its band's first rank names that rank. Above Novice a
      // band opens where Novice's fifth rank sits, and "unranked" there read to the
      // playtest as a broken ladder rather than a rung not reached yet.
      '<td class="sc-rank">' + esc(held ?? (r.runs > 0 && next ? "below " + next : "unranked")) + "</td>" +
      "<td>" + (r.best === null ? '<span class="base">unplayed</span>' : pts(r.best)) + "</td>" +
      '<td class="sc-rank">' + (maxedHere ? "maxed" : esc(next ?? "")) + "</td>" +
      "<td>" + (maxedHere ? "" : tgt(r.nextRankScore)) + "</td>" +
      '<td class="sc-gap">' + (maxedHere || r.gap === null ? "" : "+" + need(r.gap)) + "</td>" +
      '<td class="sc-prog"><span class="sc-bar"><i></i></span></td>' +
      '<td class="sc-act"></td>';

    const heldInk = inkFor(r, held);
    if (heldInk) tr.children[2].style.color = heldInk;
    const nextInk = inkFor(r, next);
    if (nextInk) tr.children[4].style.color = nextInk;
    const bar = tr.querySelector(".sc-bar i");
    bar.style.width = (maxedHere ? 1 : r.progress ?? 0) * 100 + "%";
    if (heldInk) bar.style.background = heldInk;

    tr.title =
      r.scenario + " · " + (r.runs === 1 ? "1 run" : num(r.runs) + " runs") +
      (maxedHere ? " · all ranks held" : " · " + Math.round((r.progress ?? 0) * 100) + "% to next rank");

    const play = playButton(r.scenario);
    if (play) tr.querySelector(".sc-act").append(play);
    body.append(tr);
  }
}

document.querySelectorAll(".sc-sort").forEach((b) => {
  b.addEventListener("click", () => {
    scenarioView.sort = b.dataset.sort;
    renderScenarioRanks();
  });
});

/**
 * The category rail beside the pool, and the select that stands in for it in a narrow
 * window. Both are drawn from the same entries, so they cannot disagree about a count.
 *
 * @param inBand the pool rows in the band on screen, every category.
 */
function renderPoolNav(inBand, data) {
  const nav = $("svCatNav");
  if (!nav) return;
  nav.textContent = "";

  const choose = (name) => {
    seasonCategory = name;
    try {
      if (name === null) localStorage.removeItem(SEASON_CATEGORY_KEY);
      else localStorage.setItem(SEASON_CATEGORY_KEY, name);
    } catch {
      /* remembered until the app closes */
    }
    if (current) renderSeasonView(current);
  };

  const entries = [{ name: null, label: "All categories", rows: inBand }].concat(
    practice.season.categories.map((c) => ({
      name: c.name,
      label: c.name,
      rows: inBand.filter((r) => r.category === c.name),
    })),
  );

  const list = document.createElement("div");
  list.className = "pool-nav-list";
  const select = document.createElement("select");
  select.className = "pool-nav-pick";
  select.setAttribute("aria-label", "Category");

  for (const entry of entries) {
    const on = entry.name === seasonCategory;
    const due = entry.rows.filter((r) => r.isNext).length;
    const standing = entry.name && (data.categories || []).find((c) => c.name === entry.name);
    const colour =
      standing && standing.rankColors ? standing.rankColors[standing.rankName] : null;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pool-nav-item" + (on ? " on" : "");
    btn.setAttribute("aria-pressed", String(on));
    btn.innerHTML =
      // The dot's slot is always drawn, so every name and the rank line under it start
      // at the same indent whether or not a next rank is scored in that category.
      '<span class="nm"><span class="due' + (due > 0 ? "" : " off") + '"></span>' + esc(entry.label) + "</span>" +
      '<span class="n">' + entry.rows.length + "</span>" +
      (entry.name
        ? '<span class="rk"' +
          (colour ? ' style="--rank-ink:' + esc(legibleOnDark(colour, RANK_TEXT_CONTRAST)) + '"' : "") +
          ">" + esc((standing && standing.rankName) || "unranked") + "</span>"
        : "");
    btn.title =
      entry.label + " · " + entry.rows.length + " scenarios" +
      (due > 0 ? " · " + due + " next ranks scored here" : "");
    btn.addEventListener("click", () => choose(entry.name));
    list.append(btn);

    const option = document.createElement("option");
    option.value = entry.name ?? "";
    option.textContent = entry.label + " (" + entry.rows.length + ")";
    option.selected = on;
    select.append(option);
  }

  select.addEventListener("change", () => choose(select.value || null));
  nav.append(select, list);
}

function renderSeasonView(data) {
  const me = data.player.apogee;
  const tiers = Array.isArray(data.theme) ? data.theme : [];
  const windows = data.benchmark.windows ?? [];
  const size = data.benchmark.windowSize ?? 4;

  // ---- what this season is ----
  const stats = $("svStats");
  if (stats) {
    stats.textContent = "";
    // seasonPool arrives over IPC and is null until it does - and never arrives at all
    // in the static preview, which is the file people are shown. The practice pool holds
    // the same scenarios, so the two headline counts on this panel fall back to it
    // rather than printing an em dash where a number belongs.
    const pool = seasonPool && Array.isArray(seasonPool.scenarios)
      ? seasonPool.scenarios
      : practice && Array.isArray(practice.scenarios) ? practice.scenarios : null;
    const families = pool ? new Set(pool.map((x) => x.family)).size : null;
    // Four counts and a name. The counts travel when the pool changes - which is what
    // editing a season does, and the reason this panel is worth watching while editing
    // rather than a thing to re-read afterwards. The fifth cell is the window's name and
    // is not a quantity, so it is written rather than counted.
    const cells = [
      [pool ? pool.length : null, "scenarios", num],
      [families, "families"],
      [windows.length || null, "difficulty windows"],
      [data.categories.length, "categories"],
      [windows[seasonPool ? (seasonPool.matchPool?.window ?? 1) : 1] ?? "\u2014", "matches draw from", null],
    ];
    cells.forEach(([v, k, format]) => {
      const el = document.createElement("div");
      el.className = "sv-stat";
      el.innerHTML = '<span class="v"></span><span class="k">' + esc(k) + '</span>';
      const slot = el.querySelector(".v");
      if (format === null || typeof v !== "number") {
        // An em dash where a number belongs is not a value to count to, and counting
        // toward one from a real number would draw a bar back to nothing on a screen
        // that has simply not received its pool yet.
        slot.textContent = String(v ?? "\u2014");
        lastReadout.delete("sv:" + k);
      } else {
        countTo(slot, v, format, "sv:" + k);
      }
      stats.append(el);
    });
  }

  if ($("svName")) $("svName").textContent = seasonPool ? seasonPool.name : "Season";
  if ($("svNote")) {
    $("svNote").textContent = seasonPool
      ? (seasonPool.status === "draft" ? "draft \u00b7 ranks can still move" : "published \u00b7 frozen")
      : "";
  }

  // ---- overall tiers, highest first ----
  const host = $("svTiers");
  if (host) {
    host.textContent = "";
    [...tiers].reverse().forEach((tier) => {
      const here = me && tier.id === me.tier.id;

      const el = document.createElement("div");
      el.className = "sv-tier" + (here ? " here" : "");
      el.style.setProperty("--tier", tier.color);
      // The rule keeps the season's colour; the name takes the readable version of it.
      el.style.setProperty("--tier-ink", legibleOnDark(tier.color, RANK_TEXT_CONTRAST));
      el.innerHTML =
        '<span class="nm">' + esc(tier.name) + '</span>' +
        '<span class="pc">' + esc(tierBand(tier.percentile)) + '</span>' +
        '<span class="you">' +
        (here ? "you \u00b7 top " + (100 - me.percentile).toFixed(1) + "%" : "") + '</span>';
      host.append(el);
    });
  }

  // ---- one ladder per category ----
  const cats = $("svCats");
  if (!cats) return;
  cats.textContent = "";

  data.categories.forEach((cat) => {
    const names = cat.rankNames ?? [];
    const maxes = cat.rankMaxes ?? [];
    // Two of them, and the names say which is safe where: a plate is a background and
    // keeps the season's colour exactly; ink is text on the ground and gets lifted.
    const plateOf = (n) =>
      cat.rankColors && cat.rankColors[n] ? cat.rankColors[n] : "var(--ink-dim)";
    const inkOf = (n) =>
      cat.rankColors && cat.rankColors[n]
        ? legibleOnDark(cat.rankColors[n], RANK_TEXT_CONTRAST)
        : "var(--ink-dim)";
    const here = names.indexOf(cat.rankName); // -1 when unranked

    const box = document.createElement("div");
    box.className = "sv-cat";

    const head = document.createElement("div");
    head.className = "sv-cat-head";
    head.innerHTML =
      '<span class="sv-cat-name">' + esc(cat.name) + '</span>' +
      '<span class="sv-cat-now" style="color:' + esc(inkOf(cat.rankName)) + '">' +
      esc(cat.rankName || "unranked") + ' \u00b7 ' + num(cat.energy) + ' energy</span>';
    box.append(head);

    // The whole ladder as one bar, lit to where they stand.
    const rail = document.createElement("div");
    rail.className = "sv-rail";
    names.forEach((n, i) => {
      const seg = document.createElement("span");
      if (i <= here) seg.style.background = plateOf(n);
      rail.append(seg);
    });
    box.append(rail);

    const wins = document.createElement("div");
    wins.className = "sv-wins";

    for (let w = 0; w * size < names.length; w++) {
      const win = document.createElement("div");
      win.className = "sv-win";

      const label = document.createElement("span");
      label.className = "sv-win-name";
      label.textContent = windows[w] ?? "window " + (w + 1);
      win.append(label);

      const grid = document.createElement("div");
      grid.className = "sv-grid";

      names.slice(w * size, w * size + size).forEach((n, j) => {
        const i = w * size + j;
        const cell = document.createElement("div");
        cell.className = "sv-rank" + (i === here ? " here" : i < here ? " done" : "");
        cell.style.setProperty("--rank", plateOf(n));
        cell.style.setProperty("--rank-ink", inkOf(n));
        cell.innerHTML =
          '<span class="rn"><span class="nm">' + esc(n) + '</span>' +
          '<span class="ix">' + (i + 1) + '</span></span>' +
          '<span class="en">' + (maxes[i] != null ? num(maxes[i]) + " energy" : "") + '</span>';
        grid.append(cell);
      });

      win.append(grid);
      wins.append(win);
    }

    box.append(wins);
    cats.append(box);
  });

  // ---- the pool, as a run-list ----
  //
  // One difficulty at a time. Every benchmark this pool is drawn from is played that way
  // - you pick Advanced and you get Advanced's scenarios - and four difficulties of
  // twenty-two families at once was a list of eighty-eight rows nobody was going to read.
  // The switcher is the same cut as the playlists and the same cut as a match's band, so
  // the three agree.
  //
  // Grouped by category and sub-skill, and no further. Which family a scenario belongs to
  // is how the ladder grades it, not something to read on the way to pressing Play.
  const poolHost = $("svPool");
  if (!poolHost) return;

  const rows = practice && Array.isArray(practice.scenarios) ? practice.scenarios : null;
  if (!rows) {
    poolHost.textContent = "";
    if ($("svDiffs")) $("svDiffs").textContent = "";
    if ($("svCatNav")) $("svCatNav").textContent = "";
    if ($("svPoolNote")) {
      $("svPoolNote").textContent = seasonPool ? num(seasonPool.scenarios.length) + " scenarios" : "";
    }
    poolHost.innerHTML =
      '<p class="rank-lede">' +
      (HOST === "electron" ? "Reading your history…" : "The scenario pool is not available here.") +
      "</p>";
    renderPlaylists();
    return;
  }

  const bands = practice.season.windows || [];
  if (seasonCategory !== null && !practice.season.categories.some((c) => c.name === seasonCategory)) {
    seasonCategory = null;
  }
  const inView = (r) => seasonCategory === null || r.category === seasonCategory;
  const dueIn = bands.map((_, w) => rows.filter((r) => r.window === w && r.isNext && inView(r)).length);

  // Which band to open on: the one holding the most of the player's next ranks. That is
  // the question the screen exists to answer, and defaulting to the easiest band would
  // land an unplayed pool on Novice and a good player on something they maxed months ago.
  if (seasonBand === null) {
    const best = dueIn.indexOf(Math.max(...dueIn));
    seasonBand =
      best >= 0 && dueIn[best] > 0
        ? best
        : seasonPool
          ? (seasonPool.matchPool?.window ?? 1)
          : 1;
  }
  if (seasonBand >= bands.length) seasonBand = 0;

  const diffs = $("svDiffs");
  if (diffs) {
    diffs.textContent = "";
    bands.forEach((name, w) => {
      const inBand = rows.filter((r) => r.window === w && inView(r));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pool-band" + (w === seasonBand ? " on" : "");
      btn.innerHTML =
        (dueIn[w] > 0 ? '<span class="due"></span>' : "") +
        esc(name) +
        '<span class="n">' + inBand.length + "</span>";
      btn.title =
        name + " · " + inBand.length + " scenarios" +
        (dueIn[w] > 0 ? " · " + dueIn[w] + " next ranks scored here" : "");
      btn.addEventListener("click", () => {
        seasonBand = w;
        if (current) renderSeasonView(current);
      });
      diffs.append(btn);
    });
  }

  renderPoolNav(rows.filter((r) => r.window === seasonBand), data);

  const shown = rows.filter((r) => r.window === seasonBand && inView(r));
  if ($("svPoolNote")) {
    const played = shown.filter((r) => r.runs > 0).length;
    // Counted from the rows on screen rather than stated, so the claim is about the band
    // being looked at and cannot go stale when the pool changes underneath it.
    const from = new Set();
    for (const r of shown) for (const o of r.origins ?? []) from.add(o.benchmark);
    $("svPoolNote").innerHTML =
      num(shown.length) + ' scenarios · <span class="sv-played"></span> played' +
      (from.size > 0 ? " · from " + num(from.size) + " benchmarks" : "");
    // Keyed to the band and the category, because that is what the sentence is about.
    // Switching either changes this number for a different reason than playing does, and
    // counting between two cuts' totals would animate a comparison nobody asked for.
    countTo(
      $("svPoolNote").querySelector(".sv-played"),
      played,
      num,
      "svplayed:" + seasonBand + ":" + (seasonCategory ?? "all"),
    );
  }

  poolHost.textContent = "";

  for (const category of practice.season.categories) {
    const inCategory = shown.filter((r) => r.category === category.name);
    if (inCategory.length === 0) continue;

    const block = document.createElement("div");
    block.className = "pool-cat";

    const standing = (data.categories || []).find((c) => c.name === category.name);
    const colour =
      (standing && standing.rankColors && standing.rankColors[standing.rankName]) || null;

    const head = document.createElement("div");
    head.className = "pool-cat-head";
    head.innerHTML =
      "<h3>" + esc(category.name) + "</h3>" +
      '<span class="rule"></span>' +
      '<span class="rk"' +
        (colour ? ' style="--rank-ink:' + esc(legibleOnDark(colour, RANK_TEXT_CONTRAST)) + '"' : "") +
        ">" +
      esc((standing && standing.rankName) || "unranked") +
      "</span>";
    block.append(head);

    const guide = (seasonPool?.categories || []).find((c) => c.name === category.name);
    const scenarioNotes = new Map((seasonPool?.scenarios || []).map((s) => [s.scenario, s]));
    if (guide?.description) {
      const intro = document.createElement("div");
      intro.className = "pool-circuit-intro";
      // The category's name is already the heading above, so without a headline of its
      // own the explanation stands alone rather than repeating it.
      if (guide.headline) {
        const title = document.createElement("strong");
        title.textContent = guide.headline;
        intro.append(title);
      }
      const copy = document.createElement("p");
      copy.textContent = guide.description;
      const route = document.createElement("span");
      route.className = "pool-circuit-route";
      const playedHere = inCategory.filter((r) => r.runs > 0).length;
      route.textContent =
        inCategory.length + " scenarios · " +
        (playedHere === inCategory.length ? "all played" : playedHere + " played") +
        " · play in order";
      intro.append(copy, route);
      block.append(intro);
    }

    const subs = [];
    for (const r of inCategory) {
      const key = r.subCategory || "—";
      if (!subs.includes(key)) subs.push(key);
    }

    for (const sub of subs) {
      const inSub = inCategory.filter((r) => (r.subCategory || "—") === sub);

      const group = document.createElement("div");
      group.className = "pool-sub";

      const subHead = document.createElement("div");
      subHead.className = "pool-sub-head";
      // A category that is one sub-skill named after itself printed its name twice, a
      // heading and then the same words as a sub-heading directly under it. The played
      // count it carried is on the intro's route line instead.
      if (subs.length === 1 && sub === category.name && guide?.description) subHead.hidden = true;
      const maxed = inSub.filter((r) => r.nextRankScore === null).length;
      subHead.innerHTML =
        '<span class="pool-sub-name">' + esc(sub) + "</span>" +

        '<span class="pool-sub-note">' +
        (maxed === inSub.length
          ? "maxed here"
          : '<span class="sub-played"></span> of ' + inSub.length + " played") +
        "</span>";
      if (maxed !== inSub.length) {
        countTo(
          subHead.querySelector(".sub-played"),
          inSub.filter((r) => r.runs > 0).length,
          undefined,
          "subplayed:" + seasonBand + ":" + sub,
        );
      }
      group.append(subHead);

      // The tiles sit in their own grid inside the group, so the sub-skill's label stays
      // full-width above them rather than becoming a first column of the grid.
      const tiles = document.createElement("div");
      tiles.className = "pool-tiles";
      group.append(tiles);

      inSub.forEach((v, circuitIndex) => {
        const maxedHere = v.nextRankScore === null;
        const held = practiceRank(v, v.rankIndex);
        const nextRank = maxedHere ? null : practiceRank(v, v.nextRankIndex);

        // Progress through the current rank step is the row's own ground rather than a
        // bar in a column of its own. Tinted with the rank this scenario holds, which the
        // tile now names, rather than the category's: a fill coloured for a rank the tile
        // never showed was a colour with nothing to read it against.
        const row = document.createElement("div");
        row.className =
          "pool-row" +
          (v.isNext ? " next" : "") +
          (maxedHere ? " done" : "") +
          (v.runs === 0 ? " untouched" : "");
        const tint = held.colour || colour;
        if (tint) {
          row.style.setProperty("--rank", tint);
          row.style.setProperty("--rank-ink", legibleOnDark(tint, RANK_TEXT_CONTRAST));
        }
        row.style.setProperty("--fill", (maxedHere ? 1 : (v.progress ?? 0)) * 100 + "%");

        const nm = document.createElement("span");
        nm.className = "nm";
        const nmText = document.createElement("span");
        nmText.className = "nm-text";
        nmText.textContent = v.label;
        makeCopyable(nmText, v.scenario);
        nm.append(nmText);
        // The position in the circuit, since the category says to play it in order. A
        // per-family focus line follows it only where the season still carries one.
        const focus = scenarioNotes.get(v.scenario)?.focus;
        const cue = document.createElement("span");
        cue.className = "pool-focus";
        cue.textContent = String(circuitIndex + 1).padStart(2, "0") + (focus ? " / " + focus : "");
        nm.append(cue);
        // The part of the arm the scenario loads most. On the tile rather than the
        // sub-skill heading because it is per scenario: Whisphere's own rungs are filed
        // under two different parts. Viscose's word where Viscose tags this exact
        // scenario, the season's own call otherwise, and the two are drawn differently
        // so a guess never passes for a citation.
        const arm = scenarioNotes.get(v.scenario)?.arm;
        if (arm) {
          const cited = scenarioNotes.get(v.scenario)?.armFrom === "Viscose";
          const mech = document.createElement("span");
          mech.className = "pool-mech" + (cited ? "" : " called");
          mech.textContent = arm;
          mech.title = cited
            ? "Viscose files this scenario under " + arm
            : arm + ": the season's own call. No benchmark publishes one for this scenario";
          nm.append(mech);
        }
        // Where the scenario came from, and what this score is worth there.
        //
        // This is the argument for the whole pool on one line: nothing here was invented,
        // and a session on this ladder is a session on the ladders people already grind.
        // 184 of the 256 carry at least one mark since the fun rebuild, which chose some
        // families for replay over benchmark membership.
        //
        // The mark is the benchmark's own abbreviation in the benchmark's own brand
        // colour, and it fills in solid once the score holds a rank there - so an unplayed
        // row shows where it counts and a played one shows how it is doing, in the same
        // width. The rank name is not printed: five marks with five rank names is a
        // paragraph, and the row already has a rank of its own that this must not compete
        // with. It is on the hover instead, which is where the rest of the row's detail
        // already lives.
        if (v.origins && v.origins.length > 0) {
          const marks = document.createElement("span");
          marks.className = "pool-from";
          for (const o of v.origins) {
            const chip = document.createElement("span");
            chip.className = "from-chip" + (o.rankName ? " held" : "");
            chip.textContent = o.abbreviation;
            chip.style.setProperty("--from", o.color);
            if (o.rankName && o.rankColor) {
              chip.style.setProperty("--from-rank", legibleOnDark(o.rankColor, RANK_TEXT_CONTRAST));
            }
            chip.title =
              o.benchmark + (o.difficulty ? " " + o.difficulty : "") +
              " · " +
              (o.rankName
                ? o.rankName + (o.nextName ? ", " + tgt(o.nextScore) + " for " + o.nextName : "")
                : o.nextName
                  ? tgt(o.nextScore) + " for " + o.nextName
                  : "not ranked here");
            marks.append(chip);
          }
          nm.append(marks);
        }

        // The three facts the row no longer spends a column on, on the one element
        // wide enough to be an easy hover target.
        nm.title =
          v.scenario +
          " · " +
          (v.runs === 1 ? "1 run" : num(v.runs) + " runs") +
          " · " +
          (maxedHere
            ? "all ranks held"
            : Math.round((v.progress ?? 0) * 100) + "% to next rank");

        // Best and target read as one line - what you have, what the rank wants.
        const nums = document.createElement("span");
        nums.className = "pool-num";

        const pb = document.createElement("span");
        pb.className = "pb" + (v.best === null ? " none" : "");
        pb.textContent = v.best === null ? "unplayed" : pts(v.best);

        const to = document.createElement("span");
        to.className = "to";
        to.textContent = maxedHere ? "" : "→";

        const targetEl = document.createElement("span");
        targetEl.className = "tgt" + (maxedHere ? " max" : "");
        targetEl.textContent = maxedHere ? "maxed" : tgt(v.nextRankScore);
        if (!maxedHere && v.best !== null) targetEl.title = need(v.gap || 0) + " to go";

        nums.append(pb, to, targetEl);

        // The ranks those two numbers stand for, under them: the one the best holds and
        // the one the target buys. A tile that said "842 → 900" left the player working
        // out from the ladder above what either was worth, which is the whole question
        // when working through the pool one scenario at a time.
        //
        // And the last run, when it was not the best: what that score alone reaches here,
        // so an attempt can be read the moment it lands without comparing it to anything.
        const rk = document.createElement("span");
        rk.className = "pool-rk";
        const heldEl = document.createElement("span");
        heldEl.className = "held" + (held.name ? "" : " none");
        heldEl.textContent = held.name ?? "unranked";
        if (held.ink) heldEl.style.color = held.ink;
        rk.append(heldEl);
        if (nextRank && nextRank.name) {
          const arrow = document.createElement("span");
          arrow.className = "to";
          arrow.textContent = "→";
          const nx = document.createElement("span");
          nx.className = "next";
          nx.textContent = nextRank.name;
          if (nextRank.ink) nx.style.color = nextRank.ink;
          rk.append(arrow, nx);
        }
        if (v.last !== null && v.last !== v.best) {
          const lastRank = practiceRank(v, v.lastRankIndex);
          // Below this difficulty's first threshold a run proves nothing here, but
          // "unranked" beside a tile that holds a rank reads as the run having lost it.
          // Naming the rank it fell short of says what actually happened.
          const floorRank = practiceRank(v, v.window * ((practice.season && practice.season.windowSize) || 4));
          const lastEl = document.createElement("span");
          lastEl.className = "last";
          lastEl.textContent =
            "last " + num(v.last) + " · " +
            (lastRank.name ?? (floorRank.name ? "below " + floorRank.name : "unranked"));
          lastEl.title = "Your most recent run here, and the rank that score alone reaches";
          rk.append(lastEl);
        }

        row.append(nm, nums, rk);

        const play = playButton(v.scenario);
        if (play) row.append(play);

        tiles.append(row);
      });

      block.append(group);
    }

    poolHost.append(block);
  }

  renderPlaylists();
}

/**
 * The playlists for the band on screen.
 *
 * A deep link opens one scenario and needs nothing on disk; a playlist is how a whole
 * band gets run back to back. There is one per category per band - all six separately -
 * plus one of everything at that band, and each is installable on its own because an
 * evening of tracking should not require writing every file for skills you are not
 * practising.
 *
 * KovaaK's reads playlists at startup, so the restart caveat is printed rather than left
 * to be discovered: a playlist that is genuinely on disk and genuinely not in the menu
 * looks exactly like the app having failed.
 */
/** The chip last written, so the redraw that follows a click can confirm it. */
let lastWritten = null;
function renderPlaylists() {
  const host = $("svPlaylists");
  if (!host) return;

  if (HOST !== "electron" || !api || !api.installPlaylists || !practice || !practice.playlistDir) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const bands = practice.season.windows || [];
  const band = seasonBand === null ? 0 : seasonBand;
  const here = (practice.playlists || []).filter((p) => p.window === band);

  const title = $("svListsTitle");
  if (title) title.textContent = "Install as KovaaK's playlists · " + (bands[band] || "");

  const note = $("svInstallNote");
  if (note && !note.dataset.done) {
    note.textContent =
      "Written to KovaaK's Playlists folder. Restart the game to load them.";
  }

  const chips = $("svChips");
  if (!chips) return;
  chips.textContent = "";

  // Installed, by name. A chip that cannot say whether it has already been written is a
  // chip you have to click to find out, and clicking to find out is what made this list
  // hard to work through.
  const installed = new Set(practice.installedNames || []);

  /**
   * Write, then redraw from what is actually on disk.
   *
   * Nothing here changes a chip's text. The old version swapped the label for "Writing…"
   * and then "Installed", and since the chips are a wrapping row, every chip after the one
   * being clicked moved twice per click - so the next chip was never where it had just
   * been. State goes on a class and a fixed-size mark instead, and the row never reflows.
   */
  const install = async (btn, names) => {
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1";
    btn.classList.add("is-writing");
    showError(null);
    try {
      const r = await api.installPlaylists(names);
      if (r && r.error) {
        showError(r.error);
        return;
      }
      practice.installed = r.installed;
      practice.installedNames = r.installedNames || [];
      if (note) {
        note.dataset.done = "1";
        note.textContent = r.dir + " · " + r.note;
      }
      // Said out loud, because rewriting a playlist that was already installed changes
      // nothing a chip can show: the mark was filled before the click and is filled after
      // it, so the click read as ignored and got pressed again.
      lastWritten = { label: btn.dataset.label, band, at: Date.now() };
      renderPlaylists();
    } finally {
      delete btn.dataset.busy;
      btn.classList.remove("is-writing");
    }
  };

  /** Mark, label, count - always all three, always the same size, whatever the state. */
  const chipFor = (label, count, isIn) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pool-chip" + (isIn ? " is-installed" : "");
    // Not a checkmark glyph: the mark is drawn by the stylesheet, so it occupies the same
    // box in both states and the label beside it never moves.
    chip.innerHTML =
      '<span class="mark" aria-hidden="true"></span>' +
      '<span class="lbl">' + esc(label) + "</span>" +
      '<span class="n">' + count + "</span>";
    // The state is on the button itself, so it reaches a screen reader without the
    // stylesheet and without a second label to keep in step.
    chip.setAttribute("aria-pressed", isIn ? "true" : "false");
    chip.dataset.label = label;
    if (lastWritten && lastWritten.band === band && lastWritten.label === label && Date.now() - lastWritten.at < 1500) {
      chip.classList.add("just-written");
      setTimeout(() => chip.classList.remove("just-written"), 1200);
    }
    return chip;
  };

  for (const list of here) {
    const isIn = installed.has(list.name);
    const chip = chipFor(list.category || "Everything", list.scenarios, isIn);
    if (list.category === null) chip.classList.add("all");
    chip.title = isIn
      ? "“" + list.name + "” is in KovaaK's Playlists folder. Writing it again is safe."
      : "Install “" + list.name + "” in KovaaK's";
    chip.addEventListener("click", () => install(chip, [list.name]));
    chips.append(chip);
  }

  const every = practice.playlists || [];
  const allIn = every.length > 0 && every.every((p) => installed.has(p.name));
  const all = chipFor("All bands", every.length, allIn);
  all.classList.add("all");
  all.title = allIn
    ? "Every playlist for this season is installed. Writing them again is safe."
    : "Install every playlist for this season";
  all.addEventListener("click", () => install(all, null));
  chips.append(all);

  // What the mark means, said once, rather than left to be worked out from the colours.
  const legend = $("svChipLegend");
  if (legend) {
    const n = every.filter((p) => installed.has(p.name)).length;
    const status = n === 0
      ? "None installed yet. A ticked mark means the playlist is already in KovaaK's."
      : n + " of " + every.length + " installed. A ticked mark means it is already in KovaaK's.";
    legend.textContent = lastWritten && lastWritten.band === band
      ? "Wrote " + (lastWritten.label === "All bands" ? "every playlist" : lastWritten.label + " · " + (bands[band] || "")) +
        ". Restart KovaaK's to load it. " + status
      : status;
  }
}

/**
 * One band, in full: every rank it can award and what each one asks for.
 *
 * A band card on the Ranks page says which rank you hold and how far through it you are,
 * and that is all it has room for. The question it raises - what are the others, and what
 * would it take - had no answer anywhere in the app. Energy is the only thing the ladder
 * grades on, and energy is a sum over scenarios, so "what would it take" is genuinely a
 * per-scenario question and cannot be answered by one number.
 *
 * Hence the matrix. One row per scenario, one column per rank, and the cell is the score
 * that rank wants on that scenario. A row reads as a run of filled cells ending where the
 * player is, and the first unfilled cell in each row is the only number on the page that is
 * an instruction.
 *
 * Drawn entirely from the snapshot and the practice list, both of which the window already
 * holds, so opening this fetches nothing and works with the app offline.
 */
/** Where Ranks was scrolled when a band opened, so Back returns there. */
let ranksScroll = null;
function openBand(category, window_) {
  ranksScroll = document.querySelector(".scroll")?.scrollTop ?? null;
  bandOpen = { category, window: window_ };
  renderBand();
  const tab = document.querySelector('.tab[data-screen="band"]');
  if (tab) tab.click();
}

/** Which band the detail page is showing, or null. */
let bandOpen = null;

function renderBand() {
  if (!bandOpen || !current) return;
  const cat = current.categories.find((c) => c.name === bandOpen.category);
  const band = cat && (cat.bands ?? []).find((b) => b.window === bandOpen.window);
  if (!band) return;

  const bandName = band.windowName || "Band " + (band.window + 1);
  $("bandTitle").textContent = cat.name + " · " + bandName;
  $("bandLede").textContent =
    "Every rank in this band and its threshold on each of the " + band.total +
    " scenarios. Ranks here apply to this band only.";

  $("bandNote").textContent =
    band.played === 0
      ? "not played yet"
      : (band.rankName ? bandRankLabel(band) : "below the first rank") +
        " · " + num(band.energy) + " energy";

  // ---- the ladder ----
  const ladder = $("bandLadder");
  ladder.textContent = "";

  band.rankNames.forEach((name, i) => {
    const positional = band.positional && i === band.rankNames.length - 1;
    const colour = band.rankColors?.[name] ?? null;
    const held = band.rankName === name;
    const above = band.rankIndex === null || band.rankIndex === undefined
      ? !held
      : i > band.rankIndex;

    const li = document.createElement("li");
    li.className = "band-rung" + (held ? " here" : above ? " above" : "");
    if (colour) li.style.setProperty("--rank-ink", legibleOnDark(colour, RANK_TEXT_CONTRAST));

    li.innerHTML =
      '<span class="idx">' + (i + 1) + "</span>" +
      '<span class="swatch" style="background:' + esc(colour || "var(--rule-3)") + '"></span>' +
      '<span class="nm">' + esc(name) + "</span>" +
      '<span class="cost">' +
      // The positional rank has no threshold by construction: it is held by standing on the
      // board, so printing a number beside it would be inventing one.
      (positional
        ? "top " + band.positional.topN + " on the board"
        : band.rankMaxes && band.rankMaxes[i] !== undefined
          ? num(band.rankMaxes[i]) + " energy"
          : "") +
      "</span>" +
      '<span class="state">' + (held ? "you" : above ? "" : "cleared") + "</span>";
    ladder.append(li);
  });

  // ---- the matrix ----
  const rows = (practice?.scenarios ?? []).filter(
    (r) => r.category === cat.name && r.window === band.window,
  );
  const scored = band.rankNames.filter(
    (_, i) => !(band.positional && i === band.rankNames.length - 1),
  );

  countTo($("bandGridNote"), rows.length, (v) => Math.round(v) + " scenarios", "band:scenarios");
  $("bandGridLede").textContent = rows.length === 0
    ? "Practice list not loaded yet."
    : "Filled: score beaten. Outlined: your next target on that scenario. Every scenario " +
      "counts the same, so the easiest outlined cell is the quickest next rank.";

  const table = $("bandMatrix");
  table.textContent = "";
  if (rows.length === 0) return;

  const head = document.createElement("thead");
  head.innerHTML =
    "<tr><th style=\"text-align:left\">Scenario</th><th>Best</th>" +
    scored.map((n) => "<th>" + esc(n) + "</th>").join("") +
    "</tr>";
  table.append(head);

  const body = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.className = "scen-name";
    nameCell.textContent = r.label;
    nameCell.title = r.scenario;
    tr.append(nameCell);

    const bestCell = document.createElement("td");
    bestCell.className = "best" + (r.best === null ? " none" : "");
    bestCell.textContent = r.best === null ? "unplayed" : pts(r.best);
    tr.append(bestCell);

    // The first threshold this score has not beaten. Marked once per row: the ones above
    // it are also unbeaten, and outlining all of them would say "everything is next".
    const nextIndex = r.rankMaxes.findIndex((t) => r.best === null || r.best < t);

    scored.forEach((name, i) => {
      const target = r.rankMaxes[i];
      const td = document.createElement("td");
      const cleared = target !== undefined && r.best !== null && r.best >= target;
      td.className = "cell" + (cleared ? " cleared" : i === nextIndex ? " next" : "");
      const colour = band.rankColors?.[name];
      if (colour) td.style.setProperty("--cell", colour);
      td.textContent = target === undefined ? "" : tgt(target);
      // .title is text, not HTML: escaping here showed "Small &amp; Slow".
      td.title =
        r.label + " · " + name +
        (target === undefined
          ? ""
          : cleared
            ? " · cleared"
            : r.best === null
              ? " · wants " + tgt(target)
              : " · " + need(target - r.best) + " to go");
      tr.append(td);
    });

    body.append(tr);
  }
  table.append(body);
}

function renderRanks(data) {
  const me = data.player.apogee;
  const tiers = data.theme;

  // render() calls this before the profile, consistency and quest screens, so throwing
  // here would take all of them down with it. A snapshot missing a tier list is a
  // reason to show nothing on this page, not to break the other four.
  if (!me || !Array.isArray(tiers) || tiers.length === 0) {
    $("ladderNote").textContent = "no ladder data in this snapshot";
    $("ladder").textContent = "";
    return;
  }

  // ---- Apogee ladder ----
  $("ladderNote").textContent = `${tiers.length} tiers · by population percentile`;
  $("ladderLede").textContent =
    "Your position against all players. Tiers are population percentiles, so they " +
    "stay stable as the player base grows.";

  const ladder = $("ladder");
  ladder.textContent = "";

  // Highest tier first: a ladder reads top-down, and the top is what people are
  // climbing toward.
  // Unplaced marks no rung: the lowest tier is where percentile 0 falls, not a placement.
  const placed = !!data.player.benchmarkRank;
  [...tiers].reverse().forEach((tier) => {
    const here = placed && tier.id === me.tier.id;
    const li = document.createElement("li");
    li.className = here ? "here" : "";
    li.style.setProperty("--tier", tier.color);
    li.style.setProperty("--tier-ink", legibleOnDark(tier.color, RANK_TEXT_CONTRAST));
    li.innerHTML =
      '<span class="rung" aria-hidden="true">' + badge(tier, "ladder-" + tier.id) + "</span>" +
      '<span class="tier-name">' + esc(tier.name) + "</span>" +
      (here
        ? '<span class="you">you · top <span class="you-pc"></span>%</span>'
        : '<span class="band">' + esc(tierBand(tier.percentile)) + "</span>");
    // One key for the line, not one per tier: the row moves between tiers as the player
    // climbs, and a key per tier would make the percentile restart from nothing at every
    // promotion - which is the one moment it most wants to be continuous.
    if (here) {
      countTo(li.querySelector(".you-pc"), Math.min(99.9, 100 - me.percentile), (v) => v.toFixed(1), "ladder:you");
    }
    ladder.append(li);
  });

  // ---- benchmark standing, per category ----
  const bench = data.benchmark;
  $("benchNote").textContent = `${bench.name} ${bench.difficulty}`;
  $("benchLede").textContent =
    `Your ${bench.name} standing, from scores alone. Each band is ranked separately, ` +
    "so you hold a rank in every band you've played. " +
    // The overall energy ladder shares its eight names with the tier above it, so naming
    // it here showed two different ranks side by side. The energy is the useful part.
    (data.player.benchmarkRank
      ? `Season energy: ${num(data.player.benchmarkEnergy)}.`
      : "Play any season scenario to place.");

  const host = $("catRanks");
  host.textContent = "";

  // Four ladders per category, not one ladder cut into four.
  //
  // A band is a complete benchmark - its own scenarios, its own four ranks, its own top -
  // so a player holds a rank in each band they have played and there is no single rung to
  // point at. The strip this replaces drew one sixteen-rung ladder grouped by window,
  // which looked almost exactly like this and meant something else: rung 5 sat above rung
  // 4, and comparing those two is precisely the question the split refuses to answer.
  //
  // Three states here, and flattening any two of them lies. A band with no runs is
  // unmeasured; a band with runs but below its first threshold is measured and unranked;
  // the rest hold a rank. Drawing the first two the same way tells a player they are bad
  // at Expert when the truth is they have never launched it.
  data.categories.forEach((cat) => {
    const bands = cat.bands ?? [];

    const el = document.createElement("div");
    el.className = "cat-rank";

    const held = bands.filter((b) => b.rankName).length;
    const top = document.createElement("div");
    top.className = "cat-rank-top";
    top.innerHTML =
      '<span class="cat-rank-name">' + esc(cat.name) + "</span>" +
      '<span class="cat-rank-rank">' +
      (bands.length
        ? '<span class="held-n"></span> of ' + bands.length + " bands held"
        : esc(cat.rankName || "unranked")) +
      "</span>";
    // Taking a band is the thing this screen exists to report, so the count moves when
    // it happens. It is a whole number that steps by one: the tween is short by its own
    // clamp and reads as the number turning over rather than as a spinner.
    if (bands.length) countTo(top.querySelector(".held-n"), held, undefined, "held:" + cat.name);
    el.append(top);

    const grid = document.createElement("div");
    grid.className = "band-grid";

    bands.forEach((b) => {
      const unplayed = b.played === 0;
      // The band matches are drawn from. Saying so here is what connects this screen to
      // the Queue tab: without it the ladder and the thing you actually play are two
      // unrelated lists that happen to share names.
      const queued = (data.benchmark.matchPool?.window ?? -1) === b.window;
      // A button, not a div. The card opens a page, so it has to be reachable by keyboard
      // and announced as something that does anything - which a div with a click handler
      // is not, however it looks.
      const card = document.createElement("button");
      card.type = "button";
      card.className =
        "band-card" + (unplayed ? " unplayed" : b.rankName ? " held" : " below") +
        (queued ? " queued" : "");
      card.addEventListener("click", () => openBand(cat.name, b.window));
      // An unplayed band is achromatic; one that is merely below its first rank still
      // shows that rank's colour, so the progress bar under it is pointing somewhere.
      const plate = unplayed
        ? "var(--ink-dim)"
        : rankColor(data, b.rankName ?? b.rankNames[0], b);
      card.style.setProperty("--rank", plate);
      card.style.setProperty(
        "--rank-ink",
        unplayed ? "var(--ink-dim)" : legibleOnDark(plate, RANK_TEXT_CONTRAST),
      );

      const head = document.createElement("div");
      head.className = "band-head";
      head.innerHTML =
        '<span class="band-title">' + esc(b.windowName) +
        (queued ? ' <span class="band-q">queued</span>' : "") + "</span>" +
        '<span class="band-cov" title="scenarios in this band you have run">' +
        b.played + "/" + b.total + "</span>";
      card.append(head);

      const name = document.createElement("div");
      name.className = "band-rank";
      name.textContent = unplayed
        ? "not played"
        : b.rankName
          ? bandRankLabel(b)
          : "below " + (b.rankNames[0] ?? "rank 1");
      card.append(name);

      // One pip per rank in this band, and only this band. The pip the player holds is
      // filled and ringed; the ones under it are filled; the ones above are outlines.
      const rungs = document.createElement("div");
      rungs.className = "band-rungs";
      b.rankNames.slice(0, b.positional ? -1 : undefined).forEach((rankName, i) => {
        const pip = document.createElement("span");
        pip.className =
          "pip" + (i < b.rankIndex ? " done" : i === b.rankIndex ? " here" : "");
        // No per-pip colour: within one band these are four steps of one climb, and
        // painting each its own rank colour made a four-colour jumble that read as a
        // legend for something. The name in its own colour is above them; the pips say
        // how far along it you are.
        pip.title = rankName + " · " + num(b.rankMaxes[i] ?? 0) + " energy";
        rungs.append(pip);
      });
      card.append(rungs);

      const foot = document.createElement("div");
      foot.className = "band-foot";
      // The positional rank is not in the ladder a score can climb, so it is not what
      // comes "next" - `rankNames` carries it but `rankMaxes` does not, and the engine
      // stops one below it. Named separately or it would read as an ordinary rank the
      // player is a few points short of.
      const hardRanks = b.positional ? b.rankNames.length - 1 : b.rankNames.length;
      const next = b.rankIndex + 1 < hardRanks ? b.rankNames[b.rankIndex + 1] : null;
      if (unplayed) {
        foot.innerHTML = '<span class="band-note">no runs yet</span>';
      } else if (!next && b.positional && b.positional.eligible) {
        // Eligible is the whole claim. Only the server sees the board order, so saying
        // anything stronger here would be the client awarding itself the rarest rank in
        // the game off data it does not have.
        foot.innerHTML =
          '<span class="band-note await">eligible for ' + esc(b.positional.rankName) +
          " · awaiting the board</span>";
      } else if (!next) {
        foot.innerHTML = '<span class="band-note top">band maxed</span>';
      } else {
        // Keyed on the band rather than on the element: this card is rebuilt on every
        // snapshot, so the bar and the percentage only know they moved because the key
        // remembers what they were. Playing a category lights up the bands that changed
        // and leaves the rest still, which is the whole point of animating them at all.
        const bandKey = cat.name + ":" + b.window;
        foot.innerHTML =
          '<span class="band-track"><i></i></span>' +
          '<span class="band-note"><span class="band-pct"></span>% to ' + esc(next) + "</span>";
        fillTo(foot.querySelector(".band-track i"), b.progressToNextRank ?? 0, "bandbar:" + bandKey);
        countTo(
          foot.querySelector(".band-pct"),
          Math.round((b.progressToNextRank ?? 0) * 100),
          undefined,
          "bandpct:" + bandKey,
        );
      }
      card.append(foot);

      grid.append(card);
    });

    el.append(grid);

    // What the next rank costs, and where it is scored.
    const climbing = cat.scenarios
      .filter((x) => x.nextRankName && x.gap > 0)
      .sort((a, b) => a.gap / Math.max(1, a.nextRankScore) - b.gap / Math.max(1, b.nextRankScore))[0];

    const note = document.createElement("div");
    note.className = "cat-rank-note";
    note.innerHTML = climbing
      ? "Closest: " + need(climbing.gap) + " point" + (climbing.gap === 1 ? "" : "s") + " on <b>" +
        esc(climbing.nextRankIsNewScenario ? targetName(climbing) : climbing.label) +
        "</b> for " + esc(climbing.nextRankName) +
        (climbing.nextRankIsNewScenario
          ? ' <span class="onscen">harder scenario than your current one</span>'
          : "")
      : "Every scenario here is at its top rank.";
    // "Closest: 1 point on X" is advice; the button makes it one press from playing it.
    const go = climbing ? playButton(nextRankTarget(climbing)) : null;
    if (go) note.append(" ", go);
    el.append(note);

    host.append(el);
  });

  // ---- what it takes ----
  // The category travels with each row, because the rank names in it are that category's
  // and looking them up on the overall ladder returns nothing.
  const rows = data.categories
    .reduce((all, c) => all.concat(c.scenarios.map((s) => ({ s, cat: c }))), [])
    .filter(({ s }) => s.nextRankName && s.gap > 0)
    // Proportional, as the category's "Closest" note sorts: one point on a 900-point
    // scenario and one on a 15,000-point one are not the same distance.
    .sort((a, b) => a.s.gap / Math.max(1, a.s.nextRankScore) - b.s.gap / Math.max(1, b.s.nextRankScore));

  const body = $("nextRankBody");
  settled(body);
  body.textContent = "";

  if (rows.length === 0) {
    body.innerHTML =
      '<tr><td colspan="6" style="color:var(--ink-dim)">' +
      "Every scenario is at its highest rank for this difficulty.</td></tr>";
    return;
  }

  rows.forEach(({ s, cat }) => {
    const ink = rankInk(data, s.rankName, cat);
    const nextInk = rankInk(data, s.nextRankName, cat);
    const tr = document.createElement("tr");

    // Where the target score is scored. On a windowed ladder the next rank crosses into a
    // harder variant every fourth rank, and then the gap is against a scenario that is
    // not the one in the first column - so that column says so rather than implying the
    // player just needs a few more points on what they were already playing.
    const target = s.nextRankIsNewScenario
      ? " <span class=\"onscen\">on " + esc(targetName(s)) + "</span>"
      : "";

    tr.innerHTML =
      "<td>" + esc(s.label) + (s.windowName ? ' <span class="win">' + esc(s.windowName) + "</span>" : "") + "</td>" +
      '<td style="color:' + esc(ink) + '">' +
        esc(s.rankName || (s.runs > 0 && s.nextRankName && !s.nextRankIsNewScenario ? "below " + s.nextRankName : "unranked")) +
        "</td>" +
      '<td class="c-best"></td>' +
      '<td style="color:' + esc(nextInk) + '">' + esc(s.nextRankName) + "</td>" +
      "<td>" + tgt(s.nextRankScore) + target + "</td>" +
      '<td class="c-gap"></td>';
    // In the name cell rather than a column of its own, which pushed the table past the
    // page at 940px.
    const go = playButton(nextRankTarget(s));
    if (go) tr.firstElementChild.append(" ", go);

    // The two columns that move because the player played. The target beside them is a
    // threshold and does not move, so it is written rather than counted - a number that
    // travels when it has not changed is a lie about what just happened.
    //
    // Keyed on the scenario, not the row: this table re-sorts as gaps close, so the row
    // holding a scenario is a different row every render.
    countTo(tr.querySelector(".c-best"), s.score, pts, "best:" + s.label);
    countTo(tr.querySelector(".c-gap"), s.gap, (v) => "+" + need(v), "gap:" + s.label);
    body.append(tr);
  });
}

/* ------------------------------------------------------- match countdown */

let clockTimer = null;

/**
 * Count down to the match deadline.
 *
 * The server decides when a match expires and charges a loss for running out, so this
 * is a readout rather than a rule: it never ends anything itself, and if the two ever
 * disagree the server is right. Its job is only to make sure the deadline is never a
 * surprise, which matters more at five minutes than it did at six hours.
 */
function startMatchClock(expiresAt) {
  stopMatchClock();

  const clock = $("matchClock");
  const deadline = expiresAt ? new Date(expiresAt).getTime() : NaN;

  if (!Number.isFinite(deadline)) {
    clock.hidden = true;
    return;
  }

  clock.hidden = false;

  const tick = () => {
    const left = deadline - Date.now();

    if (left <= 0) {
      clock.textContent = "time up";
      clock.className = "match-clock out";
      stopMatchClock();
      // "time up" and nothing else was a dead end. Say what it means and what to do.
      if (activeMatch && !activeMatch.seeding && !activeMatch.tournament && pendingScenarios.some((s) => !s.done)) {
        $("matchHint").textContent = "Time's up. This match has expired and counts as a forfeit. Close it to queue again.";
        $("cancelMatchBtn").textContent = "Close match";
      }
      return;
    }

    const total = Math.floor(left / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    clock.textContent = `${mins}:${String(secs).padStart(2, "0")} left`;
    clock.className = "match-clock" + (left < 60_000 ? " low" : "");
  };

  tick();
  clockTimer = setInterval(tick, 1000);
}

function stopMatchClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

/**
 * The three scenarios, and which of them are done.
 *
 * `arriving` is passed only when a match has just landed. The list is rebuilt from
 * scratch every time a run comes in, so animating unconditionally would replay the
 * entrance under the player three times a match, on rows they are in the middle of
 * reading, for an event they did not cause. It plays once, when the match appears.
 */
/**
 * The player's own best on a scenario a match is asking for, or null.
 *
 * A match round is won on the bigger improvement over your own baseline, so the number
 * that decides it is your own best - and the to-do list named three scenarios and left
 * the rest of the row empty. Matched on the scenario name first; a match round can carry
 * a display label with the window appended ("beanTS Larger int"), so a practice row whose
 * scenario name begins the label counts too. No match means nothing is drawn rather than
 * a zero, which would read as a best of nothing.
 */
function bestOn(label) {
  const rows = practice && Array.isArray(practice.scenarios) ? practice.scenarios : null;
  if (!rows || !label) return null;
  let hit = rows.find((r) => r.scenario === label);
  if (!hit) hit = rows.find((r) => r.scenario && label.indexOf(r.scenario) === 0);
  return hit && hit.best !== null && hit.best !== undefined ? hit : null;
}

function renderTodo(arriving) {
  renderMatchReadiness();
  const list = $("todoList");
  list.textContent = "";

  pendingScenarios.forEach((s, i) => {
    const li = document.createElement("li");
    li.className =
      (s.done ? "done" : "pending") +
      (arriving ? " arriving" : "") +
      // Marked by the run that landed, cleared here, so the tick plays on the one row
      // that changed and on the one render that changed it.
      (s.justDone ? " just" : "");
    s.justDone = false;
    li.style.setProperty("--i", String(i));
    const mine = bestOn(s.label);
    li.innerHTML =
      '<span class="n">' + (s.tier === "rejected" ? "!" : s.done ? "✓" : i + 1) + "</span>" +
      "<span>" + esc(s.label) + "</span>" +
      (s.tier ? '<span class="tier-tag" title="' + esc(tierMeaning(s.tier)) + '">received · ' + esc(s.tier) + "</span>" : s.uploading ? '<span class="tier-tag">Submitting…</span>' : s.failed ? '<span class="tier-tag">Upload failed · retry</span>' : '<span class="tier-tag">Awaiting run</span>') +
      (mine
        ? '<span class="scen-best" title="' +
          esc(num(mine.runs) + " runs on this scenario") +
          '">to beat <b>' + esc(pts(mine.best)) + "</b></span>"
        : "");

    // Each scenario opens itself. KovaaK's reads its playlists at startup, so a playlist
    // written mid-session is not in the menu; a deep link needs nothing on disk and
    // nothing refreshed, and works whether or not the game is already running.
    if (!s.done && HOST === "electron" && window.apogee && window.apogee.launchScenario) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "scen-play";
      play.textContent = "Play";
      play.title = "Open " + s.label + " in KovaaK's";
      play.addEventListener("click", async () => {
        play.disabled = true;
        const prev = play.textContent;
        play.textContent = "Opening…";
        try {
          const r = await window.apogee.launchScenario(s.label);
          if (r && r.error) {
            showError(r.error);
            play.textContent = prev;
          } else {
            play.textContent = "Opened";
          }
        } finally {
          play.disabled = false;
        }
      });
      li.append(play);
    }

    list.append(li);
  });
}

function renderResult(data) {
  const m = data.match;
  renderDebrief(m.rounds.map(r => ({ scenario: r.label, counted: true, delta: r.you.delta, opponentDelta: r.them.delta })), 'Example match · synthetic opponent and rating movement');
  const won = m.verdict === "win";

  $("verdictBig").textContent =
    won ? "Victory" : m.verdict === "draw" ? "Draw" : "Defeat";
  $("verdictBig").style.color =
    won ? "var(--up)" : m.verdict === "draw" ? "var(--ink)" : "var(--down)";
  $("verdictScores").textContent =
    pct(m.playerMatchScore) + " vs " + pct(m.opponentMatchScore) + " against baseline" +
    (m.ratingWeight < 1 ? "   ·   reduced weight (provisional baselines)" : "");
  renderScoreline(m.rounds.map((r) => ({
    counted: true,
    delta: r.you.delta,
    opponentDelta: r.them.delta,
  })));
  $("ratingMove").innerHTML =
    (won ? "+18" : "−14") + '<span class="after">rating</span>';
  $("ratingMove").style.color = won ? "var(--up)" : "var(--down)";
  $("explain").textContent = m.explanation;

  const body = $("roundsBody");
  settled(body);
  body.textContent = "";
  m.rounds.forEach((r) => {
    const youWon = r.you.delta > r.them.delta;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(r.label) + "</td>" +
      "<td>" + pts(r.you.score) + '<div class="base">base ' + num(r.you.baseline) + "</div></td>" +
      '<td class="' + (r.you.delta >= 0 ? "up" : "down") + '">' + pct(r.you.delta) + "</td>" +
      "<td>" + pts(r.them.score) + '<div class="base">base ' + num(r.them.baseline) + "</div></td>" +
      '<td class="' + (r.them.delta >= 0 ? "up" : "down") + '">' + pct(r.them.delta) + "</td>" +
      '<td class="' + (youWon ? "won-round" : "") + '">' + (r.you.delta === r.them.delta ? "draw" : youWon ? "won" : "lost") + "</td>";
    body.append(tr);
  });
}

/** True once a genuine match has settled in this session. */
let hasRealResult = false;

/** Empty state for the result tab before any real match has been played. */
function renderNoResultYet() {
  renderDebrief([], "Your results appear after a completed match");
  $("verdictBig").textContent = "No matches yet";
  $("verdictBig").style.color = "var(--ink-mid)";
  $("verdictScores").textContent =
    "Queue a category and play the 3 scenarios. Results show here.";
  $("ratingMove").textContent = "";
  // Nothing has been played, so there are no rounds to score.
  if ($("scoreline")) $("scoreline").hidden = true;
  $("explain").textContent =
    "Each round goes to the bigger improvement over baseline, so players of any rank " +
    "can be matched.";
  settled($("roundsBody"));
  $("roundsBody").textContent = "";
  // A table of headers over no rows looked like a result that failed to load.
  const table = $("roundsBody").closest?.(".rounds-wrap");
  if (table) table.hidden = true;

  // This is the tab a new player opens to see what a match is, and it ended on a
  // sentence. The result row below is where "Queue again" lives once there is a result,
  // so the way back to the queue sits in the same place before there is one.
  const box = $("rematch");
  const go = $("queueAgainBtn");
  if (box && go && !activeMatch) {
    box.hidden = false;
    $("rematchBtn").hidden = true;
    $("rematchNote").textContent = "Your result lands here as soon as the third run is read.";
    go.hidden = false;
    go.disabled = false;
    go.textContent = "Go to the queue";
    go.onclick = () => openScreen("queue");
  }
}

/**
 * Render a real settled match.
 *
 * Distinct from `renderResult`, which draws the snapshot's illustrative match. This one
 * shows what actually happened, including the rating change and each run's verification
 * tier, because a player is entitled to see why a result went the way it did.
 */
/**
 * The three rounds as marks and a tally.
 *
 * A match is best of three, and the only place that said so was the last column of the
 * table underneath. Drawn from the same test the table rows use, so the marks and the
 * words in the column can never disagree; a round nobody could win - unopposed, or
 * excluded - is neither colour rather than being counted as a loss.
 */
function renderScoreline(rounds) {
  const box = $("scoreline");
  const marks = $("scoreMarks");
  if (!box || !marks) return;

  const list = Array.isArray(rounds) ? rounds : [];
  if (list.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  marks.textContent = "";
  let mine = 0;
  let theirs = 0;
  let draws = 0;
  for (const r of list) {
    const outcome = roundPresentation(r);
    if (outcome.label === 'Won') mine++;
    if (outcome.label === 'Lost') theirs++;
    if (outcome.label === 'Draw') draws++;
    const m = document.createElement("span");
    m.className = "score-mark" + (outcome.label === 'Won' ? ' won' : outcome.label === 'Lost' ? ' lost' : outcome.label === 'Draw' ? ' draw' : '');
    m.title = outcome.label === 'Excluded' ? r.excludedReason || 'Excluded' : outcome.label;
    m.setAttribute('aria-label', 'Round ' + (marks.children.length + 1) + ': ' + m.title);
    marks.append(m);
  }

  const tally = $("scoreTally");
  if (tally) {
    // Nothing was contested, so there is no score to print - and "0-0" would read as a
    // draw rather than as a set of runs with nobody on the other side.
    tally.textContent = mine + theirs + draws === 0
      ? list.length + (list.length === 1 ? " round recorded" : " rounds recorded")
      : mine + "–" + theirs + " on rounds" + (draws ? " · " + draws + " drawn" : "");
  }
}

/**
 * Offer to duel the player you just finished against.
 *
 * The obvious thing to want after a result, and until now it was two screens away: back
 * to Play, open the picker, find the name, send. It sends a duel rather than requeueing,
 * because "again, with them" is a person and the queue cannot be asked for one.
 *
 * Hidden when there is nobody to send it to. A seeding match had no opponent, a void did
 * not count, and a match still open is one you are in the middle of.
 */
/** The result currently on the Last match screen, so its rematch can be redrawn. */
let lastSettled = null;

function renderRematch(settled) {
  const box = $("rematch");
  if (!box) return;

  // Held, because whether this button can be pressed depends on the match state and that
  // moves after the result is drawn: queue again and it must go dead, abandon and it must
  // come back. Redrawing from the stored result is cheaper than tracking both.
  if (settled) lastSettled = settled;

  // A tournament result offers the way back to the tournament rather than a duel: the
  // rematch there is the next fixture, and a duel would be a rated match nobody asked for.
  const leg = settled && settled.tournament;
  if (leg) {
    box.hidden = false;
    if ($("queueAgainBtn")) $("queueAgainBtn").hidden = true;
    const back = $("rematchBtn");
    back.hidden = false;
    back.textContent = "Back to " + leg.name;
    back.disabled = false;
    $("rematchNote").textContent = leg.label + " · unrated";
    back.onclick = () => {
      openScreen("tournaments");
      tnOpen(leg.id);
    };
    return;
  }

  const opponent = settled && settled.opponent;
  const category = settled && settled.category;
  // Void is refused here as well as server-side, where the opponent already comes back
  // null. Whether to draw a button is this side's decision, so it is this side's job to
  // check it rather than to lean on the shape of somebody else's answer.
  //
  // "Any" never reaches a contested result - the server records the category actually
  // drawn - but a duel cannot be sent in one, so refusing beats offering a button whose
  // only outcome is a 400.
  const sendable =
    opponent && category && category !== "Any" && settled.verdict !== "void";

  // The loop is result, then queue again. It took a tab switch, a scroll and a click.
  const again = $("queueAgainBtn");
  if (again) {
    again.hidden = !settled && !lastSettled;
    again.disabled = Boolean(activeMatch);
    again.textContent = activeMatch ? "Match in progress" : "Queue again";
    again.onclick = () => {
      openScreen("queue");
      if (!activeMatch && !$("queueBtn").disabled) $("queueBtn").click();
    };
  }
  const button = $("rematchBtn");
  button.hidden = !sendable;
  box.hidden = !sendable && (!again || again.hidden);
  if (!sendable) {
    $("rematchNote").textContent = activeMatch ? "Finish or abandon your current match first." : "";
    return;
  }

  button.textContent = "Duel " + opponent.displayName;
  button.disabled = Boolean(activeMatch);
  $("rematchNote").textContent = activeMatch
    ? "Finish or abandon your current match first."
    : "You play your 3 first, then they answer.";

  // Replaced rather than added to. This runs on every result, and a listener per match
  // would send one duel for every match played this session.
  button.onclick = async () => {
    if (!current || !current.benchmark || !current.benchmark.matchPool) {
      showError("The season pool has not loaded yet.");
      return;
    }
    const result = await onRowAction(button, "Sending\u2026", () =>
      api.sendDuel(opponent.playerId, category, current.benchmark.matchPool));
    if (result && result.match) {
      showNotice("Duel sent to " + opponent.displayName + ". Play your 3 and it goes to them.");
      activeMatch = result.match;
      paintActiveMatch();
      document.querySelector('.tab[data-screen="queue"]').click();
    }
  };
}

function renderSettled(s) {
  hasRealResult = true;
  renderDebrief(s.rounds || [], s.tournament ? 'Tournament set · ranked rating unchanged' : s.verdict === 'void' ? 'Voided set · no rating change' : s.seeding || s.verdict == null ? 'Recorded set · no opponent result' : 'Settled match · server result');
  renderRematch(s);

  // A seeding match has no opponent and therefore no verdict. Without this it fell
  // through to the losing branch and announced DEFEAT in red over three runs that beat
  // their baselines - which is not a wrong colour, it is a wrong claim about what
  // happened.
  const isSeeding = s.seeding || s.verdict == null;
  const won = s.verdict === "win";
  const isVoid = s.verdict === "void";

  $("verdictBig").textContent = isSeeding
    ? s.tournament ? "First leg in" : "Run set recorded"
    : isVoid ? "Void"
    : won ? "Victory" : s.verdict === "draw" ? "Draw" : "Defeat";
  $("verdictBig").style.color = isSeeding
    ? "var(--ink)"
    : isVoid ? "var(--ink-mid)"
    : won ? "var(--up)" : s.verdict === "draw" ? "var(--ink)" : "var(--down)";

  $("verdictScores").textContent = isSeeding
    ? (Number.isFinite(s.yourMatchScore) ? pct(s.yourMatchScore) : "unavailable") + " against your own baselines · " +
      (s.tournament ? s.tournament.label + ", they answer next" : "no opponent yet")
    : isVoid
      ? (s.voidReason || "match could not be settled")
      : (Number.isFinite(s.yourMatchScore) ? pct(s.yourMatchScore) : "unavailable") + " vs " + (Number.isFinite(s.theirMatchScore) ? pct(s.theirMatchScore) : "unavailable") +
        " against baseline" +
        (s.ratingWeight < 1 ? `   ·   ${Math.round(s.ratingWeight * 100)}% weight (provisional)` : "");

  renderScoreline(s.rounds);

  const change = s.ratingChange;
  // The change is the news and the new rating is the context, so they stop being one
  // run-on mono string with a middot in it.
  $("ratingMove").innerHTML = s.tournament
    ? 'unrated<span class="after">tournament</span>'
    : isSeeding
    ? 'not rated<span class="after">seeding</span>'
    : isVoid ? 'no change<span class="after">void</span>'
    : !Number.isFinite(change) ? 'unavailable<span class="after">rating change</span>'
    : `${change >= 0 ? "+" : "−"}${Math.abs(change)}` +
      `<span class="after">rating ${esc(Number.isFinite(s.ratingAfter) ? String(s.ratingAfter) : "unavailable")}</span>`;
  $("ratingMove").style.color = isSeeding || isVoid || s.tournament
    ? "var(--ink-dim)"
    : change > 0 ? "var(--up)" : change < 0 ? "var(--down)" : "var(--ink-mid)";

  // A void's reason arrives as `message`, and it names the scenario that ended early.
  $("explain").textContent = s.explanation || s.message || "";

  const body = $("roundsBody");
  settled(body);
  body.textContent = "";
  const table = body.closest?.(".rounds-wrap");
  if (table) table.hidden = false;
  // The server does not send the opponent's raw scores, so that column was a dash on
  // every real result. Their improvement, which decides the round, is still shown.
  body.closest?.("table")?.classList.add("no-them");
  (s.rounds || []).forEach((r) => {
    const yours = r.delta;
    // Null means there is nobody on the other side, which is not the same as an
    // opponent who scored their baseline exactly. Treating it as zero is what turned
    // three unopposed rounds into three "won" rows under a DEFEAT banner.
    const hasOpponent = r.counted && Number.isFinite(r.opponentDelta);
    const theirs = r.opponentDelta;
    const youWon = roundPresentation(r).label === "Won";

    const outcome = !r.counted ? esc(r.excludedReason || "excluded") : roundPresentation(r).label.toLowerCase();

    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(r.scenario) + "</td>" +
      "<td>" + (Number.isFinite(r.score) ? pts(r.score) : "—") + '<div class="base">base ' + (Number.isFinite(r.baseline) ? num(r.baseline) : "—") +
        (r.verificationTier && r.verificationTier !== "verified"
          ? ' · <span title="' + esc(tierMeaning(r.verificationTier)) + '">' + esc(r.verificationTier) + "</span>"
          : "") +
        "</div></td>" +
      '<td class="' + (Number.isFinite(yours) ? yours >= 0 ? "up" : "down" : "") + '">' +
        (r.counted && Number.isFinite(yours) ? pct(yours) : "—") + "</td>" +
      "<td>—</td>" +
      (hasOpponent
        ? '<td class="' + (theirs >= 0 ? "up" : "down") + '">' + pct(theirs) + "</td>"
        : "<td>—</td>") +
      '<td class="' + (youWon ? "won-round" : "") + '">' + outcome + "</td>";
    body.append(tr);
  });
}

/**
 * Which difficulties hold enough history to grade the player honestly.
 *
 * Built because the ladder now spans several difficulties and a player is realistically
 * measured on one of them. That is not a failing - it is what playing a benchmark looks
 * like - but it decides which matches mean anything, so it belongs on screen rather than
 * in a validator nobody runs.
 */
function renderCoverage(data) {
  const host = $("coverage");
  if (!host) return;

  const coverage = data.coverage ?? [];
  host.textContent = "";

  if (coverage.length === 0) {
    host.innerHTML = '<p class="rank-lede">No season loaded.</p>';
    return;
  }

  for (const category of [...new Set(coverage.map((c) => c.category))]) {
    const rows = coverage.filter((c) => c.category === category);

    const block = document.createElement("div");
    block.className = "cover-cat";

    const head = document.createElement("div");
    head.className = "cover-head";
    head.textContent = category;
    block.append(head);

    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "cover-row" + (row.matchable ? " ready" : "");

      const name = document.createElement("span");
      name.className = "cover-name";
      name.textContent = row.windowName;

      const track = document.createElement("span");
      track.className = "cover-track";
      const fillEl = document.createElement("span");
      fillEl.className = "cover-fill";
      setFill(fillEl, row.total > 0 ? row.measured / row.total : 0);
      track.append(fillEl);

      const value = document.createElement("span");
      value.className = "cover-val";
      value.textContent = `${row.measured}/${row.total}`;
      value.title = row.matchable
        ? "enough scenarios measured to draw a match from"
        : "not enough measured scenarios to draw a match from";

      line.append(name, track, value);
      block.append(line);
    }

    // The cheapest thing to play next, which is the only actionable part of this panel.
    const locked = rows.filter((r) => !r.matchable);
    if (locked.length > 0) {
      const cheapest = locked
        .map((r) => {
          const need = r.scenarios
            .filter((x) => !x.measured)
            .sort((a, b) => a.needs - b.needs)
            .slice(0, Math.max(0, 3 - r.measured));
          return { row: r, need, cost: need.reduce((n, x) => n + x.needs, 0) };
        })
        .filter((x) => x.need.length > 0)
        .sort((a, b) => a.cost - b.cost)[0];

      if (cheapest) {
        const next = document.createElement("div");
        next.className = "cover-next";
        next.textContent =
          `${cheapest.row.windowName} needs ${cheapest.cost} more run${cheapest.cost === 1 ? "" : "s"}: ` +
          cheapest.need.map((x) => `${x.label} +${x.needs}`).join(", ");
        block.append(next);
      }
    }

    host.append(block);
  }
}

function renderProfile(data) {
  // With nothing played there is no weakest category, only an unplayed one.
  const played = data.categories.filter((c) => c.energy > 0);
  $("weakNote").textContent = played.length < 2
    ? "Not enough runs yet to compare categories"
    : data.weakest + " is your weakest category";

  const maxEnergy = Math.max.apply(null, data.categories.map((c) => c.energy));
  const wmap = $("wmap");
  wmap.textContent = "";

  data.categories.forEach((cat) => {
    // Flat, not a gradient fading up from 25% alpha.
    //
    // The bar is a measurement - this category's energy against the strongest one - and
    // a bar that is dark at the start and full at the end reads as though the left half
    // counts for less than the right half. It does not. The three of these were also the
    // only gradients left in the client, and being written as an inline style is the
    // reason `npm run audit:look` never saw them.
    const ink = legibleOnDark(rankColor(data, cat.rankName, cat), RANK_TEXT_CONTRAST);
    const row = document.createElement("div");
    row.className = "wrow";
    row.innerHTML =
      '<div class="lbl"><svg class="discipline-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' + disciplineOf(cat.name).path + '</svg><span>' + esc(cat.name) + "</span></div>" +
      '<div class="wtrack"><div class="wfill" style="width:' +
        ((cat.energy / maxEnergy) * 100).toFixed(1) +
        "%;background:" + esc(ink) + '"></div></div>' +
      '<div class="wval"><span class="wenergy">' + num(cat.energy) + '</span>' +
        '<span style="color:' + esc(ink) + '">' + esc(cat.rankName || "—") + "</span></div>";
    wmap.append(row);
  });

  const body = $("scenBody");
  settled(body);
  body.textContent = "";

  // One row per family, showing the variant that earned the rank. Which variant that is
  // matters - it is the scenario the score in this row belongs to - so the window is on
  // the label, and the target names its own scenario when the next rank moves up a window.
  data.categories
    .reduce((all, c) => all.concat(c.scenarios.map((s) => ({ s, cat: c }))), [])
    .sort((a, b) => a.s.energy - b.s.energy)
    .forEach(({ s, cat }) => {
      const ink = rankInk(data, s.rankName, cat);
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(s.label) +
          (s.windowName ? ' <span class="win">' + esc(s.windowName) + "</span>" : "") + "</td>" +
        "<td>" + esc(s.subCategory || "—") + "</td>" +
        "<td>" + (s.score ? pts(s.score) : "—") + "</td>" +
        '<td style="color:' + esc(ink) + '">' + esc(s.rankName || "—") + "</td>" +
        "<td>" + num(s.energy) + "</td>" +
        "<td>" + s.runs + "</td>" +
        "<td>" +
          (s.gap != null
            ? "+" + need(s.gap) + " → " + esc(s.nextRankName) +
              (s.nextRankIsNewScenario
                ? ' <span class="onscen">on ' + esc(targetName(s)) + "</span>"
                : "")
            : '<span style="color:var(--ink-dim)">max</span>') +
        "</td>";
      body.append(tr);
    });
}

/**
 * Ceiling versus floor.
 *
 * Both ranks come from the same Voltaic energy engine; only the score fed in differs.
 * That is what makes "Diamond ceiling, Platinum floor" a real statement rather than a
 * figure of speech.
 */
function renderConsistency(data) {
  const c = data.consistency;
  const body = $("consistencyBody");
  // Returning early left the previous snapshot's ceiling and rows on screen.
  if (!c || c.scenarios.length === 0) {
    $("ceilRank").textContent = "—";
    $("ceilEnergy").textContent = "";
    $("floorRank").textContent = "—";
    $("floorEnergy").textContent = "";
    $("gapVal").textContent = "—";
    settled(body);
    body.innerHTML = '<tr><td colspan="6" style="color:var(--ink-dim)">Play any season scenario 5 times to see your floor.</td></tr>';
    return;
  }

  const inkOf = (rank) =>
    data.benchmark.rankColors[rank]
      ? legibleOnDark(data.benchmark.rankColors[rank], RANK_TEXT_CONTRAST)
      : "var(--ink-mid)";

  $("ceilRank").textContent = c.ceilingRank || "unranked";
  $("ceilRank").style.color = inkOf(c.ceilingRank);
  $("ceilEnergy").textContent = num(c.ceilingEnergy) + " energy";

  $("floorRank").textContent = c.floorRank || "unranked";
  $("floorRank").style.color = inkOf(c.floorRank);
  $("floorEnergy").textContent = num(c.floorEnergy) + " energy";

  $("gapVal").textContent = (c.gap * 100).toFixed(1) + "%";

  settled(body);
  body.textContent = "";

  const worst = c.scenarios.length ? c.scenarios[0].gap : 1;

  c.scenarios.forEach((s) => {
    // Bar width is relative to the worst gap, so the ordering is legible at a glance
    // rather than every row looking similar.
    const width = worst > 0 ? Math.max(2, (s.gap / worst) * 90) : 2;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(s.label) + "</td>" +
      "<td>" + num(s.ceiling) + "</td>" +
      '<td style="color:var(--ink-dim)">' + num(s.median) + "</td>" +
      "<td>" + num(s.floor) + "</td>" +
      "<td>" + (s.gap * 100).toFixed(1) + "%</td>" +
      '<td><span class="gapbar" style="width:' + width.toFixed(0) + 'px"></span></td>';
    body.append(tr);
  });
}

const QUEST_UNITS = {
  runs: ["run", "runs"],
  scenarios: ["scenario", "scenarios"],
  matches: ["match", "matches"],
  wins: ["win", "wins"],
  days: ["day", "days"],
  sets: ["set", "sets"],
  ranks: ["rank-up", "rank-ups"],
  categories: ["category", "categories"],
  families: ["family", "families"],
  bests: ["new best", "new bests"],
};

/**
 * What is left, in the quest's own unit.
 *
 * "3 of 5 runs" says it far better than "60%", and a score quest reads as the best run
 * since the board was issued against the number it has to reach - not the all-time best,
 * which is what the quest was issued from and cannot move it.
 */
function questCounter(q) {
  if (q.complete) return "done";
  if (q.unit === "score") {
    return q.progress > 0 ? "best " + num(q.progress) + " / " + num(q.target) : "target " + num(q.target);
  }
  const unit = QUEST_UNITS[q.unit] || [q.unit, q.unit];
  return num(q.progress) + " of " + num(q.target) + " " + unit[q.target === 1 ? 0 : 1];
}

function questCard(q, board) {
  // Two colours, and both of them mean something, plus the one that says it is over.
  //
  // Every quest used to take `theme[3 + i]` - the i-th tier's colour, by row position.
  // It said nothing: the fourth quest was blue because it was fourth. Five saturated
  // ramp colours down one column is the rainbow this client is otherwise careful not
  // to be, and it made five bars compete when the list has no ranking in it.
  //
  // A floor quest is warn because it is a different ask: every run in the window has
  // to clear the bar, not one of them. Everything else takes the accent.
  const colour = q.complete ? "var(--up)" : q.slot === "floor" ? "var(--warn)" : "var(--accent)";

  const el = document.createElement("div");
  el.className = "quest quest-" + q.slot + (q.complete ? " done" : "");
  el.innerHTML =
    "<div><h3>" + esc(q.title) + '<span class="slot-tag">' + esc(q.slot) + "</span></h3>" +
      "<p>" + esc(q.detail) + "</p></div>" +
    '<div class="xp"><span class="qsteps">' + esc(questCounter(q)) + "</span>" + num(q.xp) + " XP</div>" +
    '<div class="qtrack"><div class="qfill"></div></div>';
  const fill = el.querySelector(".qfill");
  fill.style.transform = "scaleX(" + q.fraction.toFixed(4) + ")";
  fill.style.background = colour;

  if (!q.complete) {
    const actions = document.createElement("div");
    actions.className = "qactions";
    // A quest that names a scenario can open it, so the one step between reading the
    // quest and doing it is a click rather than a search in KovaaK's.
    if (q.scenario) {
      const play = playButton(q.scenario);
      if (play) actions.append(play);
    }
    if (HOST === "electron" && api && api.rerollQuest && board.canReroll && q.slot !== "weekly") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qreroll";
      btn.textContent = "Reroll";
      btn.title = "Swap this for another quest. One reroll a day.";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const r = await api.rerollQuest(q.id);
        // Success needs nothing here: main rebuilds and the new board arrives as a snapshot.
        if (r && r.error) {
          showError(r.error);
          btn.disabled = false;
        }
      });
      actions.append(btn);
    }
    if (actions.childElementCount > 0) el.append(actions);
  }
  return el;
}

function renderQuests(data) {
  const board = data.quests;
  const host = $("questList");
  const week = $("questWeekly");
  host.textContent = "";
  if (week) week.textContent = "";
  // A snapshot written before the board existed carries a bare list. Nothing is better
  // than throwing halfway through `render`, which would leave every screen after it stale.
  if (!board || !Array.isArray(board.daily)) return;

  board.daily.forEach((q) => host.append(questCard(q, board)));

  if ($("questNote")) {
    $("questNote").textContent = board.canReroll ? "one reroll left today" : "new board at midnight";
  }

  const bonus = $("questBonus");
  if (bonus) {
    const done = board.daily.filter((q) => q.complete).length;
    bonus.classList.toggle("earned", board.bonus.earned);
    bonus.innerHTML = board.bonus.earned
      ? "Board cleared · <b>+" + num(board.bonus.xp) + " XP</b> on a " + num(board.bonus.streak) + "-day streak"
      : "Clear all three for <b>+" + num(board.bonus.xp) + " XP</b>" +
        (board.bonus.streak > 1 ? " on a " + num(board.bonus.streak) + "-day streak" : "") +
        " · " + done + " of " + board.daily.length + " done";
  }

  if (week) {
    if (board.weekly) week.append(questCard(board.weekly, board));
    else week.innerHTML = '<p class="rank-lede">No weekly quest yet. It is issued with your first run of the week.</p>';
  }
  if ($("questWeekNote")) {
    $("questWeekNote").textContent = board.weekEnds
      ? "closes end of " + new Date(board.weekEnds + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" })
      : "";
  }
}

/* ------------------------------------------------- quest completion */

/**
 * Completions queue rather than overwrite.
 *
 * Finishing the fifth run of a set can complete two quests at once, and a card that
 * silently replaced the previous one would rob the player of an award they earned.
 */
const celebrationQueue = [];
let celebrating = false;
let celebrationReturnFocus = null;

function showCelebration(payload) {
  celebrationQueue.push(payload);
  if (!celebrating) nextCelebration();
}

function nextCelebration() {
  const payload = celebrationQueue.shift();
  if (!payload) {
    celebrating = false;
    $("celebrate").hidden = true;
    document.querySelectorAll(".rail, .main").forEach(el => { el.inert = false; });
    if (celebrationReturnFocus?.isConnected) celebrationReturnFocus.focus();
    celebrationReturnFocus = null;
    return;
  }

  if (!celebrating) celebrationReturnFocus = document.activeElement;
  celebrating = true;
  document.querySelectorAll(".rail, .main").forEach(el => { el.inert = true; });
  $('celebrate').dataset.kind = payload.promotion ? 'promotion' : 'quest';
  $('celebrateEmblem').hidden = !payload.promotion;
  $('celebrateXp').hidden = Boolean(payload.promotion);
  document.querySelector('.celebrate-level').hidden = Boolean(payload.promotion);
  if (payload.promotion) {
    $('celebrateKicker').textContent = 'Benchmark promotion';
    $('celebrateTitle').textContent = payload.promotion.to;
    $('celebrateDetail').textContent = payload.promotion.from + ' → ' + payload.promotion.to + ' · measured from local training scores. Ranked rating is separate.';
    $('celebrate').hidden = false;
    $('celebrateClose').textContent = 'Continue';
    $('celebrateClose').focus();
    playSound('celebrate');
    return;
  }
  const { quest, level } = payload;

  $("celebrateKicker").textContent =
    quest.kind === "board_clear" ? "Board cleared"
    : quest.slot === "weekly" ? "Weekly quest complete"
    : quest.kind === "clean_set" ? "Floor raised"
    : quest.kind === "personal_best" ? "New best"
    : "Quest complete";
  $("celebrateTitle").textContent = quest.title;
  $("celebrateDetail").textContent = quest.detail;
  $("celebrateXp").textContent = "+" + quest.xp + " XP";

  $("celebrateLevel").textContent = "Level " + level.level;
  $("celebrateLevelXp").textContent =
    level.xpIntoLevel.toLocaleString() + " / " + level.xpForNextLevel.toLocaleString();

  $("celebrate").hidden = false;
  $("celebrateClose").focus();
  playSound("celebrate");
  // Fill from zero so the bar visibly moves rather than appearing already full.
  setFill($("celebrateFill"), 0);
  requestAnimationFrame(() => {
    setFill($("celebrateFill"), level.progress);
  });

  // More waiting? Say so, so the button does not look like it dismissed them all.
  $("celebrateClose").textContent =
    celebrationQueue.length > 0 ? `Next (${celebrationQueue.length} more)` : "Close";
}

function renderProgression(p) {
  const chip = $("levelChip");
  if (!chip) return;
  chip.hidden = false;
  chip.textContent =
    `lvl ${p.level.level} · ${p.level.xpIntoLevel.toLocaleString()}/` +
    `${p.level.xpForNextLevel.toLocaleString()} xp`;
  chip.title = `${p.totalXp.toLocaleString()} XP lifetime · ${p.completedToday} quest(s) done today`;
}

/* --------------------------------------------------------------- queue gate */

/**
 * Whether this account may queue, as last reported by main. Null means signed out, or
 * that the count could not be read - in both cases the gate stays out of the way and the
 * server remains the thing that actually decides.
 */
let eligibility = null;

/**
 * Show how far off queueing is, and stop the button pretending otherwise.
 *
 * The button is disabled here rather than only refusing on press, because a player who
 * cannot queue yet should be able to see that without discovering it the hard way. The
 * server checks again regardless: this is a courtesy, not a control.
 */
function renderEligibility() {
  renderSetup();
  const gate = $("queueGate");
  const btn = $("queueBtn");
  if (!gate || !btn) return;

  if (!eligibility || eligibility.eligible) {
    gate.classList.remove("on");
    if (btn.dataset.gated === "1") {
      btn.disabled = false;
      delete btn.dataset.gated;
    }
    return;
  }

  const { uploaded, required, missing } = eligibility;
  // Any runs on this PC the server has not seen are sent without asking. This used to wait
  // until there were enough local runs to open ranked outright, which left a player short
  // of that to find an Upload button; in the first outside playtest the tester never
  // found it. The button here appears only after the automatic upload has failed.
  const local = current && current.player ? current.player.totalRuns : 0;
  const pending = signedIn && local > uploaded;
  $("queueGateText").innerHTML = uploadBusy
    ? "Uploading your runs\u2026"
    : pending
      ? 'Ranked opens at <span class="gate-count">' + num(required) + "</span> uploaded runs. " +
        num(uploaded) + " uploaded so far."
      : 'Play <span class="gate-count">' + num(missing) + "</span> more runs to open ranked.";
  const gateUpload = $("queueGateUpload");
  if (gateUpload) {
    gateUpload.hidden = !(pending && uploadFailed && !uploadBusy);
    gateUpload.textContent = "Try the upload again";
  }
  setFill($("queueGateFill"), uploaded / required);
  gate.classList.add("on");
  if (pending && !autoUploaded && !uploadBusy) {
    autoUploaded = true;
    $("uploadBtn").click();
  }

  // Marked so the paths that re-enable the button on a category change or a finished
  // match do not quietly hand it back.
  btn.disabled = true;
  btn.dataset.gated = "1";
}

/** One automatic upload per session: if it fails, the gate offers a retry. */
let autoUploaded = false;
let uploadBusy = false;
let uploadFailed = false;

function refreshEligibility() {
  if (!api || !api.queueEligibility) return;
  api.queueEligibility().then((state) => {
    eligibility = state;
    renderEligibility();
  }).catch((err) => {
    // Swallowed silently until now. Eligibility is what gates the queue button, so a
    // failed check leaves the button asserting something untrue, which is worth saying
    // out loud. Called on boot, on sign-in and when a match ends - never on a timer, so
    // this cannot become a stream of banners.
    reportFailure("Could not check whether you can queue", err);
  });
}

/**
 * A band's rank as a player reads it: "Diamond complete" once every scenario in the band
 * has reached Diamond on its own score, the way evxl labels a benchmark, and plain
 * "Diamond" while the rank is energy carrying a scenario that is still below it.
 */
function bandRankLabel(band) {
  return band.complete ? band.rankName + " complete" : band.rankName;
}

/* ------------------------------------------------------------------ getting started */

/**
 * The checklist on the Arena screen, for the steps a new player cannot see from here.
 *
 * Every step is read off state the app already holds, so it cannot disagree with the
 * screen: the stats folder from the snapshot, sign-in from the session, the run count
 * from the same eligibility the queue gate uses, a match from the server's rating or a
 * settle seen here. The match is remembered once seen, because a finished step must not
 * come undone.
 *
 * Desktop only. The standalone preview has no session and nothing to press.
 */
const SETUP_KEY = "apogee.setup";

function setupFlags() {
  try {
    return JSON.parse(localStorage.getItem(SETUP_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function setSetupFlag(key) {
  const flags = setupFlags();
  if (flags[key]) return;
  flags[key] = true;
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(flags));
  } catch {
    /* storage unavailable: the step is still read live */
  }
}

const SETUP_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

function setupSteps() {
  const local = current && current.player ? current.player.totalRuns : 0;
  const required = eligibility ? eligibility.required : null;
  const uploaded = eligibility ? eligibility.uploaded : 0;

  if (standing && standing.matchesPlayed > 0) setSetupFlag("match");
  const flags = setupFlags();

  // Three steps. The first outside playtest had five, with the upload as a step of its own
  // and a button to press; the tester stalled on it. Signing in now starts the upload by
  // itself (renderEligibility), so the step that asks for sign-in carries its progress,
  // and duels are found from the queue screen once there is a match to be proud of.
  const uploading = signedIn && eligibility && !eligibility.eligible;
  return [
    {
      title: "Find your KovaaK's stats",
      detail: local > 0 ? num(local) + " runs found." : "Found by itself on most installs.",
      done: local > 0,
      action: "Choose folder",
      run: () => $("btnChoose").click(),
    },
    {
      title: "Sign in with Steam",
      detail: !signedIn
        ? "Reads your Steam name, avatar and friends list. Nothing else."
        : uploading
          ? uploadBusy
            ? "Uploading your runs…"
            : local > uploaded
              ? num(uploaded) + " of " + num(required) + " runs uploaded."
              : "Play " + num(eligibility.missing) + " more runs to open ranked."
          : "Signed in.",
      progress: uploading && required ? Math.min(1, uploaded / required) : null,
      done: signedIn && Boolean(eligibility && eligibility.eligible),
      action: signedIn ? null : "Sign in",
      run: () => $("btnSignIn").click(),
    },
    {
      title: "Play your first match",
      detail: "Pick a category and press Find opponent.",
      done: Boolean(flags.match),
      action: "Go to the queue",
      run: () => {
        const stage = document.querySelector(".queue-stage");
        if (stage) stage.scrollIntoView({ behavior: "smooth", block: "start" });
        $("queueBtn").focus({ preventScroll: true });
      },
    },
  ];
}

/**
 * Called from render(), the session handler and every state change below, so it must
 * never throw into them: a checklist is not worth a first-run screen that never advances.
 */
function renderSetup() {
  try {
    paintSetup();
  } catch (err) {
    console.warn("getting started:", err);
  }
}

function paintSetup() {
  const panel = $("setupPanel");
  const list = $("setupList");
  if (!panel || !list) return;
  if (HOST !== "electron" || setupFlags().hidden) {
    panel.hidden = true;
    return;
  }

  const steps = setupSteps();
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) {
    // Finished is finished: the panel does not come back if a step later reads as undone,
    // say after signing out.
    setSetupFlag("hidden");
    panel.hidden = true;
    return;
  }

  const next = steps.findIndex((s) => !s.done);
  list.textContent = "";
  steps.forEach((step, i) => {
    const li = document.createElement("li");
    li.className = "setup-step" + (step.done ? " done" : "") + (i === next ? " next" : "");

    const mark = document.createElement("span");
    mark.className = "setup-mark";
    if (step.done) mark.innerHTML = SETUP_CHECK;
    else mark.textContent = String(i + 1);

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "setup-title";
    title.textContent = step.title;
    const detail = document.createElement("p");
    detail.className = "setup-detail";
    detail.textContent = step.detail;
    body.append(title, detail);
    if (!step.done && step.progress != null) {
      const bar = document.createElement("span");
      bar.className = "setup-bar";
      const fill = document.createElement("i");
      fill.style.width = Math.round(step.progress * 100) + "%";
      bar.append(fill);
      body.append(bar);
    }

    li.append(mark, body);
    if (!step.done && step.action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "go";
      btn.textContent = step.action;
      btn.addEventListener("click", step.run);
      li.append(btn);
    }
    list.append(li);
  });

  $("setupNote").textContent = done + " of " + steps.length + " done";
  panel.hidden = false;
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function showRunToast(run) {
  $("toastScen").textContent = run.scenario;
  $("toastScore").textContent = pts(run.score);
  $("toast").classList.add("on");
  playSound("run");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("on"), 4200);

  // Detection is local evidence only. Completion waits for main's submission receipt.
  let changed = false;
  pendingScenarios.forEach((s) => {
    if (!s.done && run.scenario === s.label) {
      s.uploading = true;
      s.failed = false;
      changed = true;
    }
  });
  if (changed) renderTodo();
  $('toastNote').textContent = run.localPersonalBest ? 'Local personal best · previous ' + num(run.localPersonalBest.previous) : 'Run detected locally';
  $('toast').classList.toggle('personal-best', Boolean(run.localPersonalBest));
}

/* ------------------------------------------------------------------ wiring */

/** Send the player to a screen as though they had pressed its tab. */
function openScreen(name) {
  const tab = document.querySelector('.tab[data-screen="' + name + '"]');
  if (tab) tab.click();
}

// A rank badge invites a press. Before this it was decoration, and pressing it did
// nothing, which teaches people the display is inert.
["myRankLink", "heroRankLink"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("click", () => openScreen("ranks"));
});

// The season editor is offered only to an admin. It is not a security boundary - the
// season is a file on this machine and anyone here can open it in a text editor - it
// just keeps a tab nobody else can use out of everybody else's way.
/**
 * Show or hide the season editor for whoever is signed in right now.
 *
 * Runs at boot and again on every session change. Revealing the tab once and never
 * looking again left it on screen across a sign-out, so the next account to sign in
 * inherited an editor it could not save with: main re-checks `isAdmin` on all four
 * season handlers, so nothing could be written, but a stranded editor showing the
 * pool and its thresholds is not something to hand a player.
 */
async function refreshAdminTabs() {
  const tabs = [$("tabSeason"), $("tabAdmin")].filter(Boolean);
  if (tabs.length === 0 || !window.apogee || !window.apogee.isAdmin) return;

  const r = await window.apogee.isAdmin().catch(() => null);
  const admin = Boolean(r && r.admin);

  for (const tab of tabs) {
    // Hiding a tab out from under someone standing on it would leave the screen up
    // with no way back to it, so send them to Queue first.
    if (!admin && tab.getAttribute("aria-selected") === "true") {
      document.querySelector('.tab[data-screen="queue"]').click();
    }
    tab.hidden = !admin;
  }

  numberTabs();
  // The remembered screen is restored at boot, before this has run, so a tab that is
  // still hidden at that point is skipped and an admin who was last in one of these two
  // screens always reopens on Queue. Try again now that they exist - but only from the
  // default screen, so this can never pull somebody off a screen they chose since.
  if (admin && $("screen-queue").classList.contains("active")) restoreScreen();
  if (admin) await loadSeasonEditor();
}

// The pool lives in the season file rather than the snapshot, so it is fetched once and
// the season screen is repainted when it lands. Everything else on that screen renders
// without it.
if (HOST === "electron" && window.apogee && window.apogee.getSeason) {
  void window.apogee.getSeason().then((r) => {
    if (!r || !r.season) return;
    seasonPool = r.season;
    if (typeof r.energyPerRank === "number") energyPerRank = r.energyPerRank;
    if (current) renderSeasonView(current);
    // Somebody already standing on the look editor when the season lands would otherwise
    // be looking at "the season has not loaded yet" until they navigated away and back.
    if ($("screen-admin")?.classList.contains("active")) renderAdminRanks();
  });
}

/**
 * Personal bests for the whole pool.
 *
 * Re-read rather than fetched once, because the watcher rebuilds the snapshot after every
 * run and a practice list still showing yesterday's best - while KovaaK's shows today's -
 * is the one thing this screen must not do.
 */
let apexData = null;

/**
 * The apex board.
 *
 * Renders from the committed samplings, so it is there with no session and no network -
 * and it names the scenario each row is scored on, because a board that shows a number
 * without naming what it is a number on is the confusing half of a windowed ladder all
 * over again.
 */
/**
 * What to chase on this scenario next.
 *
 * A whole point is ten times fewer people above you, so it is the same amount of work
 * wherever a player sits - which a round rank is not. Shown as the score and the
 * position it buys, because a target nobody can act on is decoration.
 */
let apexBoardCategory = "Overall";
let apexBoard = null;

/**
 * The last snapshot rendered, so the board can read the season's positional rank.
 *
 * The board knows where a player sits and nothing about what that position is worth; the
 * snapshot knows the rank and whether they are eligible and nothing about position. The
 * rank is held only where the two meet, and neither half can be dropped: eligibility on
 * its own is a claim the client could make about itself, and position on its own would
 * hand the rank to whoever is third on a board they have not qualified for.
 */
let lastSnapshot = null;

/**
 * The public board: who is ahead of you, and by how much.
 *
 * Server-served rather than read from a table. `apex_standing` is read-self, because a
 * leaderboard being public does not make the population enumerable - what a client sees
 * about another player is the server's decision, the same rule opponent names follow.
 *
 * Absent rows are absent players, not zeros: somebody who has never refreshed is simply
 * not on the board yet, and showing them at zero would be inventing a standing.
 */
/**
 * What the board position is worth, when the season has a rank only it can award.
 *
 * Says nothing unless the player is eligible - the rank is not something to dangle at
 * somebody who has not cleared the band under it, and the board already says where they
 * sit.
 */
function positionalNote() {
  const cat = (lastSnapshot?.categories ?? []).find((c) => c.name === apexBoardCategory);
  const band = (cat?.bands ?? []).find((b) => b.positional);
  const p = band?.positional;
  if (!p || !p.eligible) return "";

  const rank = apexBoard?.you?.rank ?? null;
  if (rank === null) {
    return " \u00b7 eligible for " + p.rankName + " once on the board";
  }
  return rank <= p.topN
    ? " \u00b7 you hold " + p.rankName
    : " \u00b7 eligible for " + p.rankName + " at #" + p.topN;
}

function renderApexBoard() {
  const note = $("apexBoardNote");
  const body = $("apexBoardBody");
  if (!body) return;

  body.textContent = "";

  if (!apexBoard) {
    if (note) note.textContent = "sign in to see your position";
    return;
  }
  if (apexBoard.error) {
    if (note) note.textContent = apexBoard.error;
    return;
  }

  if (note) {
    const mine =
      apexBoard.you && apexBoard.you.rank
        ? "you are #" + num(apexBoard.you.rank) + " of " + num(apexBoard.population)
        : "you are not on this board yet";
    // The refresh runs before the read and is allowed to fail - a rate limit is the
    // likely cause and the board is still worth showing. Saying so beats letting a
    // standing that did not update look like one that did.
    const stale = apexBoard.refreshed === false ? " \u00b7 not refreshed just now" : "";
    note.textContent =
      mine + " \u00b7 " + num(apexBoard.population) + " ranked" + stale + positionalNote();
  }

  if (apexBoard.entries.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4">Nobody on this board yet.</td>';
    body.append(tr);
    return;
  }

  apexBoard.entries.forEach((e) => {
    const tr = document.createElement("tr");
    if (e.you) tr.className = "apex-you";
    tr.innerHTML =
      "<td>" + num(e.rank) + "</td>" +
      "<td>" + esc(e.displayName) + "</td>" +
      "<td>" + esc(e.points.toFixed(2)) + "</td>" +
      "<td>" + e.graded + " of " + e.families + "</td>";
    body.append(tr);
  });
}

/** One tab per category, plus the derived overall. */
function renderApexTabs() {
  const host = $("apexTabs");
  if (!host) return;
  host.textContent = "";

  const names = ["Overall"].concat(
    apexData && apexData.categories ? apexData.categories.map((c) => c.name) : [],
  );

  names.forEach((name) => {
    const b = document.createElement("button");
    b.className = "apex-tab";
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(name === apexBoardCategory));
    b.textContent = name;
    b.addEventListener("click", () => {
      if (name === apexBoardCategory) return;
      apexBoardCategory = name;
      renderApexTabs();
      refreshApexBoard();
    });
    host.append(b);
  });
}

function refreshApexBoard() {
  if (HOST !== "electron" || !api || !api.apexBoard) return;
  void api.apexBoard(apexBoardCategory).then((r) => {
    apexBoard = r || null;
    renderApexBoard();
  });
}

function nextLabel(f) {
  if (!f.next) return "\u2014";
  return num(Math.round(f.next.score)) + " \u2192 #" + num(f.next.rank);
}

function renderApex() {
  if (!apexData || apexData.error) {
    const note = $("apexNote");
    if (note) note.textContent = apexData && apexData.error ? apexData.error : "";
    return;
  }

  if ($("apexName")) $("apexName").textContent = apexData.season.name + " \u00b7 apex";
  if ($("apexNote")) {
    // Board positions come from a committed sample, not from KovaaK's live, so the
    // date is part of the claim rather than a footnote. Without it "#7,307 of
    // 119,424" reads as current, which it is not.
    const asOf = apexData.sampledAt
      ? " \u00b7 boards as of " + new Date(apexData.sampledAt).toLocaleDateString()
      : "";
    $("apexNote").textContent =
      apexData.graded + " of " + apexData.total + " families scored" + asOf;
  }

  const stats = $("apexStats");
  if (stats) {
    stats.textContent = "";
    const cells = [[apexData.points.toFixed(2), "points"]];
    apexData.categories.forEach((c) => cells.push([c.points.toFixed(2), c.name.toLowerCase()]));
    cells.forEach(([v, k]) => {
      const el = document.createElement("div");
      el.className = "sv-stat";
      el.innerHTML = '<span class="v">' + esc(String(v)) + '</span>' +
                     '<span class="k">' + esc(k) + '</span>';
      stats.append(el);
    });
  }

  const host = $("apexCategories");
  if (!host) return;
  host.textContent = "";

  apexData.categories.forEach((cat) => {
    const panel = document.createElement("div");
    panel.className = "panel";

    const head = document.createElement("div");
    head.className = "phead";
    head.innerHTML =
      "<h2>" + esc(cat.name) + "</h2>" +
      '<span class="note">' + esc(cat.points.toFixed(2)) + " points \u00b7 " +
      cat.graded + " of " + cat.total + " scored</span>";
    panel.append(head);

    const body = document.createElement("div");
    body.className = "pbody";

    const table = document.createElement("table");
    table.className = "scen";
    table.innerHTML =
      "<thead><tr><th>Family</th><th>Scored on</th><th>Your best</th>" +
      "<th>Board position</th><th>Points</th><th>Next</th></tr></thead>";

    const tbody = document.createElement("tbody");

    // Best first, so what a player is proudest of is at the top and the unplayed rows
    // collect at the bottom, where they read as "not yet" rather than as failures.
    [...cat.families].sort((a, b) => b.points - a.points).forEach((f) => {
      const tr = document.createElement("tr");
      const where = f.boardRank === null || f.boardTotal === null
        ? "\u2014"
        : "#" + num(f.boardRank) + " of " + num(f.boardTotal);
      tr.innerHTML =
        "<td>" + esc(f.family) + "</td>" +
        "<td>" + esc(f.label) + "</td>" +
        "<td>" + (f.score === null ? "\u2014" : num(Math.round(f.score))) + "</td>" +
        "<td>" + esc(where) + "</td>" +
        "<td>" + (f.score === null ? "\u2014" : esc(f.points.toFixed(2))) + "</td>" +
        "<td>" + esc(nextLabel(f)) + "</td>";
      tbody.append(tr);
    });

    table.append(tbody);
    body.append(table);
    panel.append(body);
    host.append(panel);
  });
}

/**
 * Re-read on every snapshot, for the same reason the practice list is: a new personal
 * best moves a board position, and showing yesterday's is the one thing it must not do.
 */
function refreshApex() {
  if (HOST !== "electron" || !api || !api.apex) return;
  void api.apex().then((r) => {
    if (!r) return;
    apexData = r;
    renderApex();
    renderApexTabs();
    refreshApexBoard();
  });
}

refreshApex();

function refreshPractice() {
  if (HOST !== "electron" || !api || !api.practice) return;
  void api.practice().then((r) => {
    if (!r || r.error) return;
    practice = r;
    window.dispatchEvent(new CustomEvent('apogee:practice-ready', { detail:r }));
    // Not behind `current`: the table needs only the practice list, and a machine with no
    // runs yet never gets a snapshot but still has a season to show.
    renderScenarioRanks();
    if (current) {
      renderSeasonView(current);
      // The queue screen lists what a match can draw, which is the same pool. Without
      // this it stays empty until something else happens to re-render it, which on the
      // screen the app opens on is until the player leaves and comes back.
      renderDraw(current);
    }
  });
  refreshApex();
}

refreshPractice();

// The editor's markup, and not just the admin flag: everything below binds to elements
// by id, so a rebuild that drops the Season section throws on the first `addEventListener`
// and takes the whole renderer down with it - sign-in unbound, Ranks unpainted, every
// button dead. And only for an admin, which is the one person who would not read it as
// somebody else's bug. Cost of the guard is one lookup; cost of not having it was a
// client that would not start.
const hasSeasonEditor = HOST === "electron" && window.apogee.isAdmin && $("seasonSave") !== null;

async function saveSeasonDraft() {
  if (seasonSaving || !seasonDraft) return;
  const btn = $("seasonSave");
  const revision = seasonRevision;
  const draftToSave = structuredClone(seasonDraft);
  draftToSave.$editorLadder = structuredClone(seasonPercentiles);
  const themeToSave = structuredClone(rankTheme);
  seasonSaving = true;
  $("seasonReload").disabled = true;
  stashDraft();
  try {
    btn.disabled = true;
    setSeasonStatus("saving…", "");

    // The rating ladder first, and only when it changed. It is a separate file, so a
    // season that saves while the ranks fail to leaves the two disagreeing - and the
    // ranks are the cheaper of the two to redo.
    if (rankThemeDirty && rankTheme && window.apogee.saveRankTheme) {
      const ranks = await window.apogee.saveRankTheme(themeToSave, rankThemeFingerprint, seasonForce);
      if (!ranks || ranks.error) {
        setSeasonStatus(ranks?.error ?? "Rating tiers could not be saved.", "bad");
        if (ranks?.stale) seasonForce = true;
        btn.disabled = false;
        return;
      }
      rankThemeDirty = JSON.stringify(rankTheme) !== JSON.stringify(themeToSave);
      if (window.apogee.getRankTheme) {
        const fresh = await window.apogee.getRankTheme();
        if (fresh && !fresh.error) rankThemeFingerprint = fresh.fingerprint ?? null;
      }
    }

    const result = await window.apogee.saveSeason(draftToSave, seasonFingerprint, seasonForce);

    if (!result || result.error) {
      // Say what is wrong and leave the draft alone: the numbers on screen are the ones
      // that need fixing, so throwing them away would be the worst possible response.
      //
      // A stale draft is the one case where the draft is the problem rather than the
      // numbers in it, so the message points at Discard - which is the only way out, and
      // is not obvious from a status line that has only ever meant "fix this row".
      setSeasonStatus(result?.error ?? "The season could not be saved. Your draft is still here.", "bad");
      // Arm the override rather than blocking. The draft on screen can be the only copy of
      // an afternoon's work, and a guard whose only other exit is Discard trades "you might
      // overwrite the file" for "you will certainly lose your own".
      if (result?.stale) seasonForce = true;
      btn.disabled = false;
      return;
    }
    seasonForce = false;
    if (result.fingerprint) seasonFingerprint = result.fingerprint;

    // Name the files. A save that reports success without saying where wrote to the
    // build output for an afternoon before anybody noticed.
    const where = (result.paths ?? [result.path]).filter(Boolean);
    setSeasonStatus(
      where.length > 1
        ? `saved to ${where.length} files, including the source · rebuilding`
        : `saved to ${where[0] ?? "disk"} · rebuilding`,
      "good",
    );
    // Saved, so the stash is no longer the newer copy of anything.
    if (seasonRevision === revision) {
      clearStashedDraft();
      gridFoldRenames();
      seasonDirty(false);
    } else {
      seasonDirty(true);
      setSeasonStatus("Saved. Newer edits are still in the draft; save again when ready.", "");
    }
  } catch (error) {
    setSeasonStatus(`Save failed: ${error?.message ?? error}. Your draft is still here.`, "bad");
  } finally {
    seasonSaving = false;
    $("seasonReload").disabled = !seasonHasChanges;
    const waiting = gridWaiting();
    btn.disabled = !seasonHasChanges || seasonGaps().length > 0 || seasonOrphans().length > 0 || waiting.cutting > 0 || waiting.failed > 0;
  }
  }

if (hasSeasonEditor) {
  void refreshAdminTabs();

  $("seasonSave").addEventListener("click", saveSeasonDraft);

  $("seasonPurge").addEventListener("click", () => {
    const orphans = new Set(seasonOrphans());
    if (orphans.size === 0) return;
    seasonDraft.scenarios = seasonDraft.scenarios.filter((x) => !orphans.has(x));
    for (const cat of seasonDraft.categories) rebalanceEnergy(cat.name);
    renderSeasonEditor();
    seasonDirty(true);
    setSeasonStatus(`removed ${orphans.size} ungradeable entr${orphans.size === 1 ? "y" : "ies"}`, "good");
  });

  $("seasonReload").addEventListener("click", () => {
    if (seasonSaving) return;
    // Discard means the season on disk, not the draft that was being restored.
    clearStashedDraft();
    void loadSeasonEditor();
  });

  $("seasonSearch").addEventListener("input", () => {
    fillSeasonPicker($("seasonSearch").value);
  });

  // Choosing a scenario preselects the category KovaaK's already assigns it, so the
  // common case is one click rather than two decisions.
  $("seasonPick").addEventListener("change", () => {
    const pick = $("seasonPick");
    const chosen = seasonAvailable[Number(pick.value)];
    $("seasonAdd").disabled = !chosen;

    if (!chosen) {
      $("seasonAddNote").textContent = `${seasonAvailable.length} available`;
      return;
    }

    if (chosen.category) {
      const cat = $("seasonPickCat");
      const match = Array.prototype.find.call(cat.options, (o) => o.value === chosen.category);
      if (match) cat.value = chosen.category;
    }

    $("seasonAddNote").textContent =
      chosen.runs >= 5
        ? `thresholds suggested from ${chosen.runs} runs`
        : "no history here, so thresholds start as placeholders";
  });

  $("seasonAdd").addEventListener("click", () => {
    const chosen = seasonAvailable[Number($("seasonPick").value)];
    if (!chosen || !seasonDraft) return;

    // This row adds a bare scenario, with no family and no window, which a windowed season
    // refuses - and refuses at Save, long after the fact, naming a scenario that renders
    // nowhere because its category never matched a block. Hiding the row was not enough:
    // it is hidden after the picker loads, so it is clickable until then.
    if (seasonWindowSize() > 0) {
      setSeasonStatus(
        "this season is windowed - use + family, so the scenario gets a slot in every difficulty",
        "bad",
      );
      return;
    }

    seasonDraft.scenarios.push({
      scenario: chosen.name,
      category: $("seasonPickCat").value,
      label: chosen.name.replace(/^VT\s+/, "").replace(/\s*S\d(\.\d)?\s*$/i, "").trim(),
      leaderboardId: null,
      // Already the right length for this ladder and already ascending, so adding a
      // scenario never leaves the season in a state that refuses to save.
      // Suggestions are per category, since each ladder has its own length.
      rankMaxes: (chosen.suggested[$("seasonPickCat").value] ?? []).slice(),
    });

    renderSeasonEditor();
    seasonDirty(true);
    void loadSeasonPicker();
  });
}

/* ======================================================================= theme */
/*
 * The player's own chrome: a base and an accent, on this machine.
 *
 * Rank colours are not part of it. They belong to the season and every player sees the
 * same ones, so --accent, which the chrome takes from the player's rank, stays exactly
 * where render() puts it, and so do the plates, the ladders and the orb. What a player
 * picks is everything around their rank, never the rank.
 *
 * A base changes hue and never luminance. Each of its tokens is solved to the stock
 * token's relative luminance, rounded so a surface never comes out lighter than stock and
 * an ink never darker, and contrast is a function of luminance alone. So every ratio
 * measured on the stock palette holds on every base without being measured again: the
 * admin editor's pairs, the ramp validate:orb signs off, and the rank-name lift, which
 * `legibleOnDark` computes against the stock control and would otherwise have to be
 * re-derived per base. `npm run validate:theme` checks all of that rather than trusting
 * this paragraph.
 *
 * That is also why there is no light base. The rank colours are lifted against a dark
 * control; a light ground would need a second lift for every rank on every screen, and
 * the season's colours were chosen against the dark one.
 *
 * The accent is free, and lifted until it reads: it is text on the selected tab, on the
 * brand well and on a raised control, so it is moved toward the light ground until it
 * clears BRAND_CONTRAST on the brightest of the three. A player who picks near-black
 * gets a colour that is still theirs in hue and is still legible, and the menu says so.
 *
 * Everything above the "on screen" banner below is pure and is evaluated by
 * tools/validateTheme.mjs, which is why it touches neither the document nor storage.
 */

const THEME_KEY = "apogee.theme";

/** Text on the selected tab and the brand well is body text, so it gets the body floor. */
const BRAND_CONTRAST = 4.5;

/**
 * The tokens a base rewrites, and which way each may round.
 *
 * A surface rounds darker and an ink rounds lighter, so every ink-on-surface pair is at
 * least as far apart as it is on stock. Rules are borders nobody reads text against, so
 * they take whichever side is nearer.
 */
const THEME_RAMP = [
  ["--ground", "surface"],
  ["--panel", "surface"],
  ["--well", "surface"],
  ["--control", "surface"],
  ["--control-hi", "surface"],
  ["--chrome", "surface"],
  ["--card", "surface"],
  ["--sunk", "surface"],
  ["--raised", "surface"],
  ["--slot", "surface"],
  ["--tab-on", "surface"],
  ["--rule", "rule"],
  ["--rule-2", "rule"],
  ["--rule-3", "rule"],
  ["--tab-on-line", "rule"],
  ["--ink", "ink"],
  ["--ink-mid", "ink"],
  ["--ink-dim", "ink"],
  ["--tab-on-ink", "ink"],
  ["--tab-on-key", "ink"],
];

const THEME_BRAND = ["--brand", "--brand-ink", "--brand-well", "--brand-line", "--brand-dim"];

/** Every token the theme reads as stock, from the stylesheet with no theme applied. */
const THEME_TOKENS = [...THEME_RAMP.map(([name]) => name), ...THEME_BRAND];

/*
 * `sat` is the ground's saturation; every other token keeps its stock saturation in the
 * same proportion, which is what keeps the rules greyer than the grounds and the inks
 * nearly neutral, the way the stock ramp has them. Ink is the stylesheet as shipped and
 * is never solved: it is the reference the others are solved against.
 */
const THEME_BASES = [
  { id: "ink", name: "Ink", hue: null, sat: 0 },
  { id: "graphite", name: "Graphite", hue: 220, sat: 0.05 },
  { id: "navy", name: "Navy", hue: 214, sat: 0.5 },
  { id: "pine", name: "Pine", hue: 160, sat: 0.24 },
  { id: "plum", name: "Plum", hue: 285, sat: 0.26 },
  { id: "ember", name: "Ember", hue: 18, sat: 0.28 },
];

/** Null is the stylesheet's own brand colour; the custom picker covers everything else. */
const THEME_ACCENTS = [
  { hex: null, name: "Default" },
  { hex: "#6cb4ff", name: "Sky" },
  { hex: "#4fd1a5", name: "Mint" },
  { hex: "#f2b35b", name: "Amber" },
  { hex: "#ff7d8c", name: "Coral" },
  { hex: "#d9dde6", name: "Silver" },
];

const THEME_STOCK = { base: "ink", accent: null };

/** The shape stored under THEME_KEY, or stock for anything that is not one. */
function themeFrom(raw) {
  const base = THEME_BASES.some((b) => b.id === raw?.base) ? raw.base : THEME_STOCK.base;
  const accent = /^#[0-9a-f]{6}$/i.test(String(raw?.accent)) ? raw.accent.toLowerCase() : null;
  return { base, accent };
}

function isStockTheme(theme) {
  return theme.base === THEME_STOCK.base && theme.accent === null;
}

function hexHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return "#" + [f(0), f(8), f(4)]
    .map((v) => Math.round(v * 255).toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The colour of this hue and saturation whose luminance is `target`, rounded by `kind`.
 *
 * Lightness is searched on the rounded hex itself, so the two ends the search leaves are
 * the adjacent 8-bit colours either side of the target and the rounding direction is a
 * choice between them rather than an accident of Math.round.
 */
function atLuminance(h, s, target, kind) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(hslHex(h, s, mid)) < target) lo = mid;
    else hi = mid;
  }
  const under = hslHex(h, s, lo);
  const over = hslHex(h, s, hi);
  if (kind === "surface") return under;
  if (kind === "ink") return over;
  return target - luminance(under) <= luminance(over) - target ? under : over;
}

/**
 * What the theme paints over the stylesheet: only the tokens it changes.
 *
 * Stock returns nothing, so the stock theme is the stylesheet itself and not a copy of
 * it that could drift.
 */
function themeTokens(stock, theme) {
  const base = THEME_BASES.find((b) => b.id === theme.base) || THEME_BASES[0];
  const out = {};

  if (base.hue !== null) {
    const ref = hexHsl(stock["--ground"])[1];
    for (const [name, kind] of THEME_RAMP) {
      if (!stock[name]) continue;
      const sat = Math.min(1, ref > 0 ? (hexHsl(stock[name])[1] * base.sat) / ref : base.sat);
      out[name] = atLuminance(base.hue, sat, luminance(stock[name]), kind);
    }
  }

  const t = Object.assign({}, stock, out);

  if (theme.accent) {
    Object.assign(out, accentTokens(t, theme.accent));
  } else if (base.hue !== null) {
    // The stock brand on a new ground: the colour stays, the tints it casts are re-cast
    // onto this ground rather than left tinted toward the stock one.
    Object.assign(out, brandTints(t["--ground"], stock["--brand"]));
  }
  return out;
}

/** The well, the line and the ghost figure: the brand at three strengths over a ground. */
function brandTints(ground, brand) {
  return {
    "--brand-well": mixHex(ground, brand, 17),
    "--brand-line": mixHex(ground, brand, 34),
    "--brand-dim": mixHex(ground, brand, 35),
  };
}

/**
 * The accent, lifted, and what it tints.
 *
 * Lifting brightens the tints it casts, which can put the brightest surface back over the
 * line, so the lift is repeated against the new surfaces until it stops moving. Each pass
 * only ever lifts further and each tint takes a fixed share of it, so it settles in two
 * passes on every colour validate:theme sweeps; six is the ceiling, not the expectation.
 */
function accentTokens(t, raw) {
  let brand = raw;
  let tints = null;
  let tabOn = null;
  for (let pass = 0; pass < 6; pass++) {
    tints = brandTints(t["--ground"], brand);
    tabOn = mixHex(t["--tab-on"], brand, 12);
    const brightest = [tints["--brand-well"], tabOn, t["--control-hi"]]
      .reduce((a, b) => (luminance(b) > luminance(a) ? b : a));
    const next = legibleOn(raw, brightest, BRAND_CONTRAST);
    if (next === brand) break;
    brand = next;
  }
  return Object.assign(tints, {
    "--brand": brand,
    "--brand-ink": mixHex(t["--ground"], brand, 8),
    "--tab-on": tabOn,
    "--tab-on-line": mixHex(t["--tab-on-line"], brand, 30),
    "--tab-on-key": brand,
  });
}

/* ------------------------------------------------------------ theme: on screen */

/*
 * Read once, at boot, before anything is painted inline on :root. The admin editor paints
 * its overrides inline and render() paints --accent there, and a stock read after either
 * would take an override for the stylesheet.
 */
const themeStock = readThemeStock();
let theme = loadTheme();
paintTheme();

function readThemeStock() {
  const sheet = $("playerTheme");
  if (sheet) sheet.disabled = true;
  const css = getComputedStyle(document.documentElement);
  const out = {};
  for (const name of THEME_TOKENS) {
    const value = css.getPropertyValue(name).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(value)) out[name] = value;
  }
  if (sheet) sheet.disabled = false;
  return out;
}

function loadTheme() {
  try {
    return themeFrom(JSON.parse(localStorage.getItem(THEME_KEY) || "null"));
  } catch {
    return { ...THEME_STOCK };
  }
}

/*
 * Its own <style>, appended after the stylesheets so it wins over their :root, and not
 * inline on :root, so an admin override still wins over it and the admin editor can
 * switch it off to read the stylesheet's own values as its defaults.
 */
function paintTheme() {
  const tokens = themeTokens(themeStock, theme);
  const lines = Object.entries(tokens).map(([name, value]) => "  " + name + ": " + value + ";");
  let sheet = $("playerTheme");
  if (lines.length === 0) {
    if (sheet) sheet.remove();
    return;
  }
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = "playerTheme";
    document.head.appendChild(sheet);
  }
  sheet.textContent = ":root {\n" + lines.join("\n") + "\n}";
}

function setTheme(next) {
  theme = themeFrom(next);
  paintTheme();
  try {
    if (isStockTheme(theme)) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, JSON.stringify(theme));
  } catch {
    /* A theme that cannot be stored still applies to this session. */
  }
  syncThemeMenu();
}

/*
 * Built once and then only synced. Rebuilding on every change would replace the colour
 * input while it is being dragged, and the native picker closes when its input leaves the
 * document.
 */
function buildThemeMenu() {
  const bases = $("themeBases");
  const accents = $("themeAccents");
  if (!bases || !accents) return;

  for (const base of THEME_BASES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-base";
    button.dataset.base = base.id;
    const chip = document.createElement("span");
    chip.className = "theme-chip";
    chip.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    const label = document.createElement("span");
    label.textContent = base.name;
    button.append(chip, label);
    button.addEventListener("click", () => setTheme({ base: base.id, accent: theme.accent }));
    bases.appendChild(button);
  }

  for (const accent of THEME_ACCENTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-accent";
    button.dataset.accent = accent.hex || "";
    button.title = accent.name;
    button.setAttribute("aria-label", accent.name + " accent");
    button.style.setProperty("--c", accent.hex || themeStock["--brand"] || "#b8a5ff");
    button.addEventListener("click", () => setTheme({ base: theme.base, accent: accent.hex }));
    accents.insertBefore(button, $("themeCustomWrap"));
  }

  $("themeCustom").addEventListener("input", (e) =>
    setTheme({ base: theme.base, accent: e.target.value }));
  $("themeReset").addEventListener("click", () => setTheme(THEME_STOCK));
  syncThemeMenu();
}

function syncThemeMenu() {
  const bases = $("themeBases");
  if (!bases) return;

  for (const button of bases.querySelectorAll(".theme-base")) {
    const id = button.dataset.base;
    button.setAttribute("aria-pressed", String(id === theme.base));
    // Each base previewed with the accent that is chosen now, since that is what picking
    // it will look like.
    const t = Object.assign({}, themeStock, themeTokens(themeStock, { base: id, accent: theme.accent }));
    const [ground, panel, brand] = button.querySelectorAll(".theme-chip i");
    ground.style.setProperty("--c", t["--ground"]);
    panel.style.setProperty("--c", t["--panel"]);
    brand.style.setProperty("--c", t["--brand"]);
  }

  const preset = THEME_ACCENTS.some((a) => a.hex === theme.accent);
  for (const button of $("themeAccents").querySelectorAll(".theme-accent[data-accent]")) {
    button.setAttribute("aria-pressed", String((button.dataset.accent || null) === theme.accent));
  }
  const wrap = $("themeCustomWrap");
  wrap.classList.toggle("on", !preset);
  wrap.style.setProperty("--c", preset ? "transparent" : theme.accent);
  if (!preset) $("themeCustom").value = theme.accent;

  const painted = themeTokens(themeStock, theme)["--brand"];
  $("themeNote").textContent = theme.accent && painted && painted !== theme.accent
    ? "Lifted from " + theme.accent + " to " + painted + " so it stays readable on this ground."
    : "Rank colours belong to the season and look the same to everyone.";
  $("themeReset").disabled = isStockTheme(theme);
}

buildThemeMenu();

/**
 * The screen the player was last on.
 *
 * Someone who spends their evening on Consistency should not be handed Queue every
 * launch. Stored per machine in the renderer rather than in main's settings file: it is
 * a view preference, and main has no business knowing which tab is open.
 */
const LAST_SCREEN_KEY = "apogee.lastScreen";

function rememberScreen(name) {
  try {
    localStorage.setItem(LAST_SCREEN_KEY, name);
  } catch {
    /* Private mode, or storage disabled. The tab still works, it just forgets. */
  }
}

function restoreScreen() {
  let name = null;
  try {
    name = localStorage.getItem(LAST_SCREEN_KEY);
  } catch {
    return;
  }
  if (!name || name === "queue") return;

  const tab = document.querySelector('.tab[data-screen="' + name + '"]');
  // Skip a tab that is not there any more: the Season tab is admin-only, and it is
  // revealed after boot, so a remembered "season" simply lands on Queue.
  if (tab && !tab.hidden) tab.click();
}

/** Screens that work before any stats are read. */
const STANDALONE_SCREENS = new Set(["mixtape", "expedition"]);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.id ||= "nav-" + tab.dataset.screen;
  tab.setAttribute("aria-controls", "screen-" + tab.dataset.screen);
  tab.setAttribute("tabindex", tab.getAttribute("aria-selected") === "true" ? "0" : "-1");
  const panel = $("screen-" + tab.dataset.screen);
  if (panel) {
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.setAttribute("tabindex", "0");
  }
  tab.addEventListener("click", () => {
    // Before any stats are read, the screens that draw from them are empty. Nine tabs
    // used to open onto a blank page; they point back at the one thing to do instead.
    if (document.body.classList.contains("awaiting-data") && !STANDALONE_SCREENS.has(tab.dataset.screen)) {
      const choose = $("emptyChoose");
      if (choose) choose.focus();
      return;
    }
    // An error belongs to what the player was doing; moving on leaves it behind.
    if (tab.getAttribute("aria-selected") !== "true" && $("banner").classList.contains("on") &&
        !$("banner").classList.contains("notice")) showError(null);
    // Only when the screen actually changes. Every route into a tab goes through
    // `.click()`, including the one that re-selects the tab already showing, and a
    // navigation sound for going nowhere is just a noise.
    if (tab.getAttribute("aria-selected") !== "true") playSound("nav");
    document.querySelectorAll(".tab").forEach((t) => {
      t.setAttribute("aria-selected", "false");
      t.setAttribute("tabindex", "-1");
      t.classList.remove("active-parent");
    });
    tab.setAttribute("tabindex", "0");
    tab.setAttribute("aria-selected", "true");
    if (tab.dataset.screen === "band") {
      const parentTab = document.querySelector('.tab[data-screen="ranks"]');
      parentTab.classList.add("active-parent");
      parentTab.setAttribute("tabindex", "0");
      tab.setAttribute("tabindex", "-1");
      $("screen-band").setAttribute("aria-labelledby", "bandTitle");
    }
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $("screen-" + tab.dataset.screen).classList.add("active");
    // The orb field reads this to decide how far to lift on this screen. Set here
    // rather than in each caller because every route into a tab goes through .click().
    document.body.dataset.screen = tab.dataset.screen;
    document.querySelector(".scroll").scrollTop = 0;
    rememberScreen(tab.dataset.screen);
    // Drawn on the way in rather than at boot: the editors are cheap to build and stale
    // the moment the season or a save lands, so the screen is always redrawn from the
    // draft it is about to show.
    if (tab.dataset.screen === "admin") renderAdmin();
  });
});

if ($("bandBack")) {
  const backToRanks = () => {
    const tab = document.querySelector('.tab[data-screen="ranks"]');
    if (tab) tab.click();
    // Back where the card was, not the top of Ranks.
    if (ranksScroll !== null) requestAnimationFrame(() => { document.querySelector(".scroll").scrollTop = ranksScroll; });
  };
  $("bandBack").addEventListener("click", backToRanks);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("screen-band")?.classList.contains("active") &&
        !document.querySelector("dialog[open]")) backToRanks();
  });
}

restoreScreen();

/**
 * Put each tab's shortcut on the tab itself, and in its tooltip.
 *
 * The keycap is on screen rather than only in a tooltip because a shortcut nobody
 * discovers is a shortcut nobody has. The rail collapses to icons on a narrow window,
 * and the tooltip is the only thing left naming the screen, so it carries the label
 * as well as the number.
 *
 * Re-run whenever a tab appears: revealing the admin-only Season tab renumbers
 * everything after it, and a tooltip that lies is worse than none.
 */
function numberTabs() {
  const tabs = [...document.querySelectorAll(".tab")].filter((tab) => !tab.hidden);
  tabs.forEach((tab, i) => {
    const label = tab.querySelector(".tab-label");
    const name = label ? label.textContent : "";
    tab.setAttribute("aria-label", name);
    const key = i < 9 ? String(i + 1) : "";

    const cap = tab.querySelector(".tab-key");
    if (cap) cap.textContent = key;

    tab.title = key ? name + " · press " + key : name;
  });
}

numberTabs();

/**
 * Close the status popover the way every other popover on the machine closes.
 *
 * <details> gives the disclosure for nothing, but it only knows how to be toggled by
 * its own summary: left alone it stays open over the content until you go back and
 * press it again, which is not what a click somewhere else means.
 */
document.addEventListener("pointerdown", (e) => {
  document.querySelectorAll("details[open]:not(.pool-disclosure)").forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector("details[open]:not(.pool-disclosure)");
  if (open) open.open = false;
});

/**
 * Number keys select a tab, and the arrows walk them.
 *
 * This is an app people leave open all evening between runs, and the tab strip is the
 * only navigation there is. The numbers follow what is on screen rather than a fixed
 * list, because the Season tab is only there for an admin, and hard-coding 4 = Season would
 * put every later tab one place out for everybody else.
 */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  // Never steal a keystroke from something being typed into, including the season
  // editor's inline name fields.
  const target = e.target;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
    return;
  }

  // A modal is showing: its own Escape handling owns the keyboard.
  const modal = $("celebrate");
  if (modal && !modal.hidden) return;
  if ($('arcadeCommand')?.open) return;

  const tabs = [...document.querySelectorAll(".tab")].filter((tab) => !tab.hidden);
  if (tabs.length === 0) return;

  if (/^[1-9]$/.test(e.key)) {
    const tab = tabs[Number(e.key) - 1];
    if (tab) {
      tab.click();
      e.preventDefault();
    }
    return;
  }

  // The rail runs down the side, so up and down are what the shape suggests. Left and
  // right stay wired for anyone who learned them when the tabs were a strip.
  if (target?.closest(".nav") && (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const here = tabs.indexOf(target.closest(".tab"));
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = tabs[(Math.max(0, here) + step + tabs.length) % tabs.length];
    next.click();
    next.focus();
    e.preventDefault();
  }
});

/* ------------------------------------------------------------------ match */

/** The live match, once one has been found. Null between matches. */
let activeMatch = null;

/**
 * Render the opponent and the scenarios to play.
 *
 * Takes a real match from the server when there is one, and falls back to the snapshot's
 * illustrative match only in the static preview, where no server exists.
 */
/**
 * Put the match the client is holding back on screen.
 *
 * Called from three places that all mean the same thing - it was just created, it was
 * recovered on restart, or a snapshot finally arrived to paint it against - so the
 * decision about what the button says lives here rather than three times.
 *
 * Does nothing without a snapshot. Recovery fires before the first render, and painting a
 * match against no player would be a panel of blanks.
 */
function paintActiveMatch() {
  if (!activeMatch || !current) return;
  const arriving = pendingMatchId !== activeMatch.matchId;

  setCommit(
    "held",
    activeMatch.tournament
      ? "Tournament fixture"
      : activeMatch.duel?.to
      ? "Duel sent"
      : activeMatch.duel?.from
        ? "Duel accepted"
        : activeMatch.resumed
          ? "Match already open"
          : activeMatch.seeding
            ? "Seeding the pool"
            : "Match in progress",
    "Play the 3 below in KovaaK's · abandon to queue again",
    "",
  );
  // Pressing the held button takes the player to the match rather than doing nothing.
  $("queueBtn").disabled = false;
  $("queueBtn").dataset.held = "1";
  showRealMatch(activeMatch, current);
  if (activeMatch.scenarios.length && pendingScenarios.every((s) => s.done)) markAllIn();
  if (duelBoard) renderDuels(duelBoard);
  // The match used to land below the fold, behind the rank card and the duels panel.
  if (arriving && document.querySelector(".tab[data-screen=queue][aria-selected=true]")) {
    $("opponent").scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" });
    $("playMatchBtn").focus({ preventScroll: true });
  }
}

/** Every run is in: nothing left to play, and abandoning now would forfeit a finished set. */
function markAllIn() {
  $("matchHint").textContent = "All runs in. Getting your result\u2026";
  $("playMatchBtn").disabled = true;
  const abandon = $("cancelMatchBtn");
  abandon.disabled = true;
  abandon.textContent = "Settling\u2026";
  stopMatchClock();
  $("matchClock").hidden = true;
}

function showRealMatch(match, data) {
  const me = data.player.apogee;

  // The payoff of pressing Find opponent. Seeding gets the same riser: the player still
  // has three scenarios to go and play, which is the thing the sound is announcing.
  // Once per match: a repaint after a run is not a new match.
  const sameMatch = pendingMatchId === match.matchId;
  if (!sameMatch) playSound("matchFound");

  // A seeding match has no opponent: the pool was empty, so the server handed out three
  // scenarios to play against nobody. Everything downstream is identical, which is the
  // point, so only the opponent card changes.
  if (match.seeding || !match.opponent) {
    $("oppBadge").innerHTML = badge(me.tier, "opp");
    // A duel you sent looks like a seeding match to everything downstream, because that
    // is what it is - but it is not waiting on a pool, it is waiting on a person, and
    // saying "no opponent yet" about somebody you just named would be nonsense.
    const sentTo = match.duel?.to ?? null;
    $("oppName").textContent = sentTo || "No opponent yet";
    $("oppTier").textContent = sentTo ? "duel sent" : "seeding the pool";
    $("oppTier").style.color = legibleOnDark(me.tier.color, RANK_TEXT_CONTRAST);
    $("oppAge").textContent = sentTo
      ? "play your 3, then they answer"
      : match.poolSize == null
        ? "match already in progress"
        : match.poolSize === 0
          ? "you are first in this category"
          : `pool of ${match.poolSize}, none close enough to your rating`;

    // No odds to show against nobody, and a half-filled bar would imply a coin flip.
    $("oddsBar").innerHTML =
      '<div style="flex:1;background:' + esc(me.tier.color) + ';opacity:.25"></div>';
    $("oddsYou").textContent = "unrated";
    $("oddsThem").textContent = "no rating change";
  } else {
    // A rating does not identify a tier without the live population distribution.
    const oppTier = { color: "#b6c7dd" };

    $("oppBadge").innerHTML = '<span class="opponent-monogram" aria-hidden="true">' + esc(tnInitials(match.opponent.displayName)) + "</span>";
    $("oppName").textContent = match.opponent.displayName;
    $("oppTier").textContent = `rating ${match.opponent.rating}` +
      (match.opponent.provisional ? " · provisional" : "");
    $("oppTier").style.color = legibleOnDark(oppTier.color, RANK_TEXT_CONTRAST);

    const played = new Date(match.opponent.playedAt);
    const days = Math.max(0, Math.round((Date.now() - played.getTime()) / 86400000));
    $("oppAge").textContent =
      `stored run · ${days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago"}` +
      ` · pool of ${match.poolSize}`;

    const p = match.winProbability;
    if (Number.isFinite(p)) {
      drawOdds(p, me.tier.color);
      $("oddsYou").textContent = "you " + (p * 100).toFixed(0) + "%";
      $("oddsThem").textContent = (100 - p * 100).toFixed(0) + "% " + match.opponent.displayName;
    } else {
      $("oddsBar").replaceChildren();
      $("oddsYou").textContent = "Match estimate unavailable";
      $("oddsThem").textContent = "";
    }
  }

  // Rows already played stay played: a repaint used to flip them back to "Awaiting run",
  // and a match recovered after a restart asked again for runs the server already had.
  const prior = new Map(sameMatch ? pendingScenarios.map((s) => [s.id, s]) : []);
  const filed = new Set(match.submittedScenarioIds || []);
  pendingScenarios = match.scenarios.map((s) => ({
    id: s.id,
    label: s.name,
    done: Boolean(prior.get(s.id)?.done) || filed.has(s.id),
    tier: prior.get(s.id)?.tier ?? null,
  }));
  pendingMatchId = match.matchId;
  renderTodo(!sameMatch);

  // A new match means a new playlist to write, so the button goes back to offering it.
  $("playMatchBtn").textContent = "Play in KovaaK's";
  $("playMatchBtn").disabled = false;
  $("cancelMatchBtn").disabled = false;
  $("cancelMatchBtn").textContent = "Abandon match";
  const left = pendingScenarios.filter((s) => !s.done).length;
  $("matchHint").textContent = left > 0 && left < pendingScenarios.length
    ? left + " scenario" + (left === 1 ? "" : "s") + " left. Your earlier runs already count."
    : match.resumed
    ? "Match already open. Finish or abandon it to queue again."
    : match.seeding || !match.opponent
      ? "Unrated. Your runs become the first entry in this pool. First run on each " +
        "scenario counts."
      : "First run on each scenario counts. Scores are read automatically.";

  // A tournament leg looks like a seeding match or a pool match to everything above, and
  // is neither: the opponent is named, nothing is rated, and the pool never sees it.
  const leg = match.tournament;
  if (leg) {
    $("oppName").textContent = leg.opponentName;
    $("oppTier").textContent = leg.label + " · unrated";
    $("oppTier").style.color = "var(--ink-mid)";
    $("oppAge").textContent = leg.leg === 1
      ? "you play first · they answer with the same three"
      : "answering their three · " + leg.name;
    $("oddsBar").innerHTML = '<div style="flex:1;background:var(--brand);opacity:.25"></div>';
    $("oddsYou").textContent = "unrated";
    $("oddsThem").textContent = leg.name;
    $("matchHint").textContent = leg.leg === 1
      ? "Only your first run on each counts. " + leg.opponentName +
        " plays the same three after you, and the fixture goes to whoever improves more."
      : leg.opponentName + " has played these three. Only your first run on each counts.";
  }

  startMatchClock(match.expiresAt);

  $("matchActions").hidden = false;
  arrive($("opponent"));
}

/**
 * Show a panel as something that arrived rather than as a repaint.
 *
 * The class is stripped once the animation has run so a later repaint of the same
 * panel - a run landing, a category chip - does not replay it. Removing it on
 * `animationend` rather than a timer keeps the two from disagreeing about the length.
 */
function arrive(el) {
  if (!el) return;
  el.classList.add("on");
  el.classList.remove("arriving");
  // Reading offsetWidth restarts the animation when a second match lands in the same
  // session; without it the class is re-added in the same frame it was removed and the
  // browser never sees a change.
  void el.offsetWidth;
  el.classList.add("arriving");
  el.addEventListener("animationend", () => el.classList.remove("arriving"), { once: true });
}

$("queueBtn").addEventListener("click", async () => {
  if (!current) return;

  const btn = $("queueBtn");

  if (HOST !== "electron") {
    // No server in the preview; show the illustrative match instead.
    showOpponent(current);
    setCommit("held", "Example set", "Illustrative opponent and runs", "Preview only");
    return;
  }

  if (!signedIn) {
    const signed = await api.signIn();
    if (signed && signed.error) showError(signed.error);
    return;
  }
  if (activeMatch) {
    $("opponent").scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" });
    return;
  }

  btn.disabled = true;
  setCommit("working", "Searching", "matching on rating · " +
    (!selectedCategory || selectedCategory === "Any" ? "any category" : selectedCategory), "0:00");
  startSearchClock();
  $("opponent").classList.remove("on");
  showError(null);

  // A rejected call used to leave the button on "Searching" for good.
  let result;
  try {
    result = await window.apogee.findMatch(selectedCategory, current.benchmark.matchPool);
  } catch (err) {
    result = { error: err && err.message ? err.message : String(err) };
  } finally {
    stopSearchClock();
    btn.disabled = false;
  }

  if (result.error) {
    resetCommit(current);
    showError(result.error);
    // The server refuses a queue with too little history behind it. Re-read the count so
    // the gate below the button agrees with what was just said, however the two got out
    // of step - a fresh sign-in, a second window, a backfill on another machine.
    refreshEligibility();
    return;
  }

  // Neither an empty pool nor an existing match is an error now: the server hands back
  // a seeding match for the first, and the match you already have for the second, so
  // there is always something on screen and always a way out of it.
  // Nothing to press while a match is open; the way out is Abandon, on the match.
  // paintActiveMatch owns what the button says, so the queue and the three other routes
  // into a match cannot describe the same state differently.
  activeMatch = result.match;
  paintActiveMatch();
});

/* ------------------------------------------------------------------ account */

function renderSession(session, configured) {
  const btn = $("btnSignIn");
  const panel = $("signedIn");
  if (!btn || !panel) return;

  // The header holds the sign-in control, so it has to be visible before there is any
  // snapshot to show. Otherwise a new user with no stats yet has nothing to click.
  $("whoami").hidden = false;

  signedIn = Boolean(session);
  renderSetup();
  if (!activeMatch) resetCommit(current);
  if (session) refreshStanding();
  else {
    standing = null;
    paintRating();
  }
  // No snapshot yet means no rank to show: an empty bordered pill was a tab stop to nowhere.
  const rankLink = $("myRankLink");
  if (rankLink) rankLink.hidden = !current;

  if (session) {
    btn.hidden = true;
    panel.hidden = false;
    $("accountName").textContent = session.displayName;
    // The SteamID is shown truncated: enough to confirm the right account is linked,
    // without putting a full identifier on screen during a stream.
    $("accountSteam").textContent = `steam …${String(session.steamId).slice(-6)}`;
    return;
  }

  panel.hidden = true;
  btn.hidden = false;
  btn.disabled = !configured;
  btn.textContent = configured ? "Sign in with Steam" : "Sign-in unavailable";
  btn.title = configured
    ? "Opens Steam sign-in in your browser"
    : "This build has no Supabase settings. Fill in .env and rebuild.";
}

/**
 * Give every table its rows before there are any.
 *
 * A table drawn empty and then filled moves everything under it the moment the first
 * snapshot lands, which on this app is every table on five screens at once. These are
 * the real rows at their real height, ruled, holding a dash in each cell, and they are
 * replaced wholesale by the first render.
 *
 * Not animated. A gradient sweeping across grey blocks is the most imitated loading
 * state there is, and it would be the only thing on screen pretending to be busy while
 * the app is genuinely just reading a folder - which the status bar already says.
 */
function reserveTables() {
  // Roughly what each one holds once the folder has been read. Short is better than
  // long: a table that shrinks looks finished, one that grows looks like it stalled.
  const tables = [
    ["roundsBody", 3],
    ["nextRankBody", 5],
    ["scenBody", 8],
    ["consistencyBody", 6],
  ];

  for (const [id, rows] of tables) {
    const body = $(id);
    if (!body || body.children.length > 0) continue;

    const columns = body.closest("table")?.querySelectorAll("thead th").length ?? 0;
    if (columns === 0) continue;

    body.innerHTML = ("<tr>" + "<td></td>".repeat(columns) + "</tr>").repeat(rows);
    body.closest("table")?.classList.add("pending");
  }
}

/** Drop the reserved rows the first time a table is written for real. */
function settled(body) {
  body?.closest("table")?.classList.remove("pending");
}

/* ====================================================== admin: look and copy ====
 *
 * The chrome's colours and the app's own words, edited from inside the app.
 *
 * The validator, the store and the four IPC handlers were already here and this is the
 * half that draws them. Every change is painted onto the live document first and written
 * only on Save, because the thing being judged is the app and not a swatch of it: whether
 * a ground is too warm is a question about the screen it is read on.
 *
 * Nothing here can change what a rank means. Ratings, deltas, verification tiers and
 * thresholds are computed server-side and the client has no write grant on any of them,
 * so the worst a bad override does is make one machine ugly - which is why this is
 * allowed to be a local file, and why Reset sits on the same screen as the damage.
 *
 * Rank names and colours are the exception and are shown here read-only. They belong to
 * the season, a database trigger freezes them once it is published, and the season editor
 * already writes them through the checks that enforce it. A second write path into the
 * same file would be a quiet way to desync the two.
 */

/*
 * The stylesheet's own values and the markup's own words, captured before anything is
 * painted over them.
 *
 * Without this an override is a one-way door. Read the ground back after setting it and
 * the answer is the override, so the default is gone the moment it is used and Reset has
 * nothing to reset to - which is the state a half-finished repaint least survives.
 */
const tokenDefaults = {};
const copyDefaults = new Map();

let adminSpec = { tokens: [], pairs: [], maxCopy: 600 };
let adminSaved = { version: 1, updatedAt: null, tokens: {}, copy: {} };
let adminDraft = { tokens: {}, copy: {} };
let adminPath = "";

function captureCopyDefaults() {
  for (const el of document.querySelectorAll("[data-copy]")) {
    const key = el.dataset.copy;
    // Collapsed, because the markup wraps its longer strings across lines and the browser
    // renders that as single spaces anyway. An editor showing the source indentation is
    // showing something nobody typed and nobody sees.
    if (!copyDefaults.has(key)) {
      copyDefaults.set(key, el.textContent.replace(/\s+/g, " ").trim());
    }
  }
}

function readTokenDefaults() {
  // With the player's theme switched off. A default read through it would be whichever
  // base this machine happens to have picked, and Reset would reset to that.
  const sheet = $("playerTheme");
  if (sheet) sheet.disabled = true;
  const root = getComputedStyle(document.documentElement);
  for (const spec of adminSpec.tokens) {
    const raw = root.getPropertyValue(spec.name).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(raw)) tokenDefaults[spec.name] = raw;
  }
  if (sheet) sheet.disabled = false;
}

/** What is painted right now: the stylesheet, with the draft over the top. */
function resolvedTokens() {
  return Object.assign({}, tokenDefaults, adminDraft.tokens);
}

function applyLook() {
  const root = document.documentElement;
  for (const spec of adminSpec.tokens) {
    const override = adminDraft.tokens[spec.name];
    if (override) root.style.setProperty(spec.name, override);
    else root.style.removeProperty(spec.name);
  }
  for (const [key, fallback] of copyDefaults) {
    const text = key in adminDraft.copy ? adminDraft.copy[key] : fallback;
    for (const el of document.querySelectorAll('[data-copy="' + key + '"]')) {
      if (el.textContent !== text) el.textContent = text;
    }
  }
  // A tab's number and its tooltip are read off its label, so both follow a renamed tab.
  numberTabs();
}

function adminChanged() {
  return JSON.stringify([adminDraft.tokens, adminDraft.copy]) !==
    JSON.stringify([adminSaved.tokens, adminSaved.copy]);
}

function markAdminDirty() {
  const dirty = adminChanged();
  $("adminSave").disabled = !dirty;
  $("adminRevert").disabled = !dirty;
  const tokens = Object.keys(adminDraft.tokens).length;
  const copy = Object.keys(adminDraft.copy).length;
  $("adminTokenNote").textContent = tokens + " changed";
  $("adminCopyNote").textContent = copy + " changed";
  $("adminPath").textContent = adminPath;
}

function adminNote(message, kind) {
  const banner = $("adminNote");
  banner.classList.remove("notice");
  if (!message) {
    banner.classList.remove("on");
    return;
  }
  banner.textContent = message;
  if (kind === "notice") banner.classList.add("notice");
  banner.classList.add("on");
}

/* ---------------------------------------------------------------- chrome ---- */

function renderAdminTokens() {
  const host = $("adminTokens");
  host.textContent = "";
  let group = null;
  for (const spec of adminSpec.tokens) {
    if (spec.group !== group) {
      group = spec.group;
      const head = document.createElement("div");
      head.className = "adm-group";
      head.textContent = group;
      host.appendChild(head);
    }
    host.appendChild(adminTokenRow(spec));
  }
  renderAdminContrast();
}

function adminTokenRow(spec) {
  const row = document.createElement("div");
  row.className = "adm-row";

  const current = () => adminDraft.tokens[spec.name] || tokenDefaults[spec.name] || "#000000";

  const swatch = document.createElement("input");
  swatch.type = "color";
  swatch.className = "adm-swatch";
  swatch.value = current();
  swatch.setAttribute("aria-label", spec.label + ", pick a colour");

  const name = document.createElement("div");
  name.className = "adm-name";
  name.textContent = spec.label;
  const variable = document.createElement("span");
  variable.textContent = spec.name;
  name.appendChild(variable);

  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "adm-hex";
  hex.spellcheck = false;
  hex.value = current();
  hex.setAttribute("aria-label", spec.label + " as hex");

  const note = document.createElement("p");
  note.className = "adm-note";
  note.textContent = spec.note;

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "adm-reset";
  reset.textContent = "Reset";
  reset.disabled = !(spec.name in adminDraft.tokens);

  // `from` keeps a field out of its own way: writing the parsed value back into the text
  // box on every keystroke moves the caret to the end, which makes editing the middle of
  // a hex impossible.
  const set = (next, from) => {
    const value = String(next).trim().toLowerCase();
    const ok = /^#[0-9a-f]{6}$/.test(value);
    hex.classList.toggle("bad", !ok);
    if (!ok) return;

    // Only what differs from the stylesheet is stored, so a colour typed back to its own
    // default leaves no entry behind to explain later.
    if (value === tokenDefaults[spec.name]) delete adminDraft.tokens[spec.name];
    else adminDraft.tokens[spec.name] = value;

    if (from !== "hex") hex.value = value;
    if (from !== "swatch") swatch.value = value;
    reset.disabled = !(spec.name in adminDraft.tokens);
    applyLook();
    renderAdminContrast();
    markAdminDirty();
  };

  hex.addEventListener("input", () => set(hex.value, "hex"));
  swatch.addEventListener("input", () => set(swatch.value, "swatch"));
  reset.addEventListener("click", () => set(tokenDefaults[spec.name], "reset"));

  row.append(swatch, name, hex, note, reset);
  return row;
}

/*
 * Measured and reported, never enforced.
 *
 * Refusing to save a palette that fails would trap somebody in the middle of a repaint,
 * and the middle is nearly always worse than either end of it. Saying "Ink on Ground is
 * 2.10:1" while they work is the useful half; deciding for them is not.
 */
function renderAdminContrast() {
  const box = $("adminContrast");
  const resolved = resolvedTokens();
  const label = (token) => {
    const spec = adminSpec.tokens.find((t) => t.name === token);
    return spec ? spec.label : token;
  };

  const failing = [];
  for (const pair of adminSpec.pairs) {
    const a = resolved[pair.token];
    const b = resolved[pair.against];
    if (!a || !b) continue;
    const ratio = contrastRatio(a, b);
    if (ratio < pair.need) failing.push({ pair, ratio });
  }

  box.textContent = "";
  box.hidden = failing.length === 0;
  if (box.hidden) return;

  for (const entry of failing) {
    const line = document.createElement("div");
    line.append(label(entry.pair.token) + " on " + label(entry.pair.against) + " is ");
    const figure = document.createElement("b");
    figure.textContent = entry.ratio.toFixed(2) + ":1";
    line.append(figure, ", under the " + entry.pair.need + " it needs.");
    box.appendChild(line);
  }
}

/* ------------------------------------------------------------------ copy ---- */

function renderAdminCopy() {
  const host = $("adminCopy");
  const filter = $("adminCopySearch").value.trim().toLowerCase();
  host.textContent = "";

  let shown = 0;
  for (const key of [...copyDefaults.keys()].sort()) {
    const fallback = copyDefaults.get(key);
    const current = key in adminDraft.copy ? adminDraft.copy[key] : fallback;
    if (
      filter &&
      !key.includes(filter) &&
      !fallback.toLowerCase().includes(filter) &&
      !current.toLowerCase().includes(filter)
    ) continue;
    host.appendChild(adminCopyRow(key, fallback));
    shown++;
  }

  if (shown === 0) {
    const empty = document.createElement("p");
    empty.className = "adm-lede";
    empty.textContent = "Nothing matches that.";
    host.appendChild(empty);
  }
}

function adminCopyRow(key, fallback) {
  const row = document.createElement("div");
  row.className = "adm-copy-row";
  if (key in adminDraft.copy) row.classList.add("changed");

  const label = document.createElement("div");
  label.className = "adm-key";
  label.textContent = key;
  // What the string says with no override, so an edit is always a comparison.
  const original = document.createElement("span");
  original.textContent = fallback;
  label.appendChild(original);

  const box = document.createElement("textarea");
  box.className = "adm-text";
  box.rows = 1;
  box.spellcheck = false;
  box.value = key in adminDraft.copy ? adminDraft.copy[key] : fallback;
  box.setAttribute("aria-label", key);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "adm-reset";
  reset.textContent = "Reset";
  reset.disabled = !(key in adminDraft.copy);

  // The three rules main validates by, checked here so a refusal is visible as it is
  // typed rather than at the end of a long session of it. Main checks again, because the
  // side that decides is the side that checks.
  const set = (next, fromBox) => {
    const value = String(next);
    const ok =
      value.length <= adminSpec.maxCopy &&
      !/[<>]/.test(value) &&
      !/[\u0000-\u001f\u007f]/.test(value);
    box.classList.toggle("bad", !ok);
    if (!ok) return;

    if (value === fallback) delete adminDraft.copy[key];
    else adminDraft.copy[key] = value;

    if (!fromBox) box.value = value;
    row.classList.toggle("changed", key in adminDraft.copy);
    reset.disabled = !(key in adminDraft.copy);
    applyLook();
    markAdminDirty();
  };

  box.addEventListener("input", () => set(box.value, true));
  reset.addEventListener("click", () => set(fallback, false));

  row.append(label, box, reset);
  return row;
}

/* -------------------------------------------------------- ranks, read only ---- */

/*
 * The season's ranks with their contrast against the ground, and no way to edit them here.
 *
 * The measurement is the reason to show them at all: it is the figure that decides
 * whether a colour can carry a name, and the season editor makes you go looking for it.
 * Editing stays there, where the fingerprint check and the published-season refusal live.
 */
function renderAdminRanks() {
  const host = $("adminRanks");
  host.textContent = "";

  if (!seasonPool) {
    const waiting = document.createElement("p");
    waiting.className = "adm-lede";
    waiting.textContent = "The season has not loaded yet.";
    host.appendChild(waiting);
    $("adminRankNote").textContent = "";
    return;
  }

  const ground = resolvedTokens()["--ground"] || DARK_GROUND;
  const ladders = [{
    title: "Overall",
    names: seasonPool.rankNames || [],
    colors: seasonPool.rankColors || {},
  }];
  for (const cat of seasonPool.categories || []) {
    ladders.push({ title: cat.name, names: cat.rankNames || [], colors: cat.rankColors || {} });
  }

  let low = 0;
  let total = 0;
  for (const ladder of ladders) {
    const head = document.createElement("div");
    head.className = "adm-cat";
    head.textContent = ladder.title;
    host.appendChild(head);

    for (const rankName of ladder.names) {
      const colour = ladder.colors[rankName];
      if (!colour) continue;
      total++;
      const ratio = contrastRatio(colour, ground);
      if (ratio < MIN_CONTRAST) low++;
      host.appendChild(adminRankRow(rankName, colour, ratio));
    }
  }

  $("adminRankNote").textContent =
    total + " ranks, " + low + " under " + MIN_CONTRAST + ":1 on this ground";

  const go = document.createElement("button");
  go.type = "button";
  go.className = "adm-reset";
  go.style.marginTop = "var(--s3)";
  go.textContent = "Edit in the season editor";
  go.addEventListener("click", () => {
    const tab = $("tabSeason");
    if (tab && !tab.hidden) tab.click();
    else adminNote("The season editor is not open on this account.");
  });
  host.appendChild(go);
}

function adminRankRow(rankName, colour, ratio) {
  const row = document.createElement("div");
  row.className = "adm-rank-row";

  const swatch = document.createElement("span");
  swatch.className = "adm-swatch";
  swatch.style.background = colour;
  swatch.style.cursor = "default";

  const name = document.createElement("div");
  name.className = "adm-name";
  name.textContent = rankName;

  const hex = document.createElement("div");
  hex.className = "adm-key";
  hex.textContent = colour;

  const figure = document.createElement("div");
  figure.className = "adm-ratio" + (ratio < MIN_CONTRAST ? " low" : "");
  figure.textContent = ratio.toFixed(2) + ":1";

  row.append(swatch, name, hex, figure, document.createElement("span"));
  return row;
}

/* ----------------------------------------------------------------- store ---- */

function renderAdmin() {
  renderAdminTokens();
  renderAdminCopy();
  renderAdminRanks();
  markAdminDirty();
}

function adminRejections(rejected) {
  if (!rejected || rejected.length === 0) return "";
  const named = rejected.slice(0, 4).map((r) => r.key + " (" + r.why + ")").join(", ");
  const rest = rejected.length > 4 ? ", and " + (rejected.length - 4) + " more" : "";
  return " Refused: " + named + rest + ".";
}

function adoptOverrides(overrides, options) {
  adminSaved = overrides || adminSaved;
  adminDraft = {
    tokens: Object.assign({}, adminSaved.tokens),
    copy: Object.assign({}, adminSaved.copy),
  };
  applyLook();
  if (!options || options.draw !== false) renderAdmin();
}

/*
 * Read on every boot, by everybody.
 *
 * Not behind the admin check: the app has to be painted before there is a session to ask
 * about, and a machine that has overrides should show them in the first frame rather than
 * snapping to them a second later. Writing is what the role gates, and main re-checks it
 * on all four write handlers.
 */
async function loadAdminLook() {
  const r = await api.adminOverrides().catch(() => null);
  if (!r) return;

  adminSpec = {
    tokens: r.tokens || [],
    pairs: r.pairs || [],
    maxCopy: r.maxCopy || adminSpec.maxCopy,
  };
  adminPath = r.path || "";
  readTokenDefaults();
  adoptOverrides(r.overrides, { draw: false });

  if (r.error) {
    adminNote("The overrides file could not be read, so none are applied: " + r.error);
  } else if (r.rejected && r.rejected.length > 0) {
    adminNote("Some overrides on disk are not allowed and were not applied." +
      adminRejections(r.rejected));
  }
}

function wireAdmin() {
  $("adminCopySearch").addEventListener("input", renderAdminCopy);

  $("adminSave").addEventListener("click", async () => {
    const r = await api
      .saveAdminOverrides({ version: 1, tokens: adminDraft.tokens, copy: adminDraft.copy })
      .catch((err) => ({ error: String(err) }));
    if (!r || r.error) {
      adminNote(r && r.error ? r.error : "the save did not go through");
      return;
    }
    adminPath = r.path || adminPath;
    adoptOverrides(r.overrides);
    adminNote("Saved." + adminRejections(r.rejected), "notice");
  });

  $("adminRevert").addEventListener("click", () => {
    adoptOverrides(adminSaved);
    adminNote("Back to the last save.", "notice");
  });

  $("adminReset").addEventListener("click", async () => {
    const r = await api.resetAdminOverrides().catch((err) => ({ error: String(err) }));
    if (!r || r.error) {
      adminNote(r && r.error ? r.error : "the reset did not go through");
      return;
    }
    adoptOverrides(r.overrides);
    adminNote("Back to the stylesheet and the markup.", "notice");
  });

  $("adminExport").addEventListener("click", async () => {
    const r = await api.exportAdminOverrides().catch((err) => ({ error: String(err) }));
    if (!r || r.canceled) return;
    if (r.error) adminNote(r.error);
    else adminNote("Written to " + r.path, "notice");
  });

  $("adminImport").addEventListener("click", async () => {
    const r = await api.importAdminOverrides().catch((err) => ({ error: String(err) }));
    if (!r || r.canceled) return;
    if (r.error) {
      adminNote(r.error);
      return;
    }
    adoptOverrides(r.overrides);
    adminNote("Imported." + adminRejections(r.rejected), "notice");
  });
}

/* ====================================================================== duels ====
 *
 * The inbox, what you sent, and who else is here.
 *
 * A duel is a match somebody addressed at you. Answering one starts an ordinary rated
 * match against the three scenarios they already played, so everything below is a list
 * and two buttons - the interesting parts are all server-side and none of them are here.
 *
 * What this deliberately never shows is how the sender did. It is not in the payload, and
 * if it were, choosing which duels to answer by the sender's score is picking the ones you
 * expect to win.
 */

let duelBoard = null;
let duelCategory = null;

/** How long is left, in the roughest unit that is still true. */
function untilExpiry(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.round(ms / 3600000);
  if (hours < 1) return "under an hour left";
  if (hours < 48) return hours + "h left";
  return Math.round(hours / 24) + "d left";
}

/**
 * Run an action on a row's button, saying so while it happens.
 *
 * The shape every per-row action here uses: disable it, say what is happening, put the
 * label back whatever the outcome. A button left greyed after a failure looks like the
 * app broke rather than like the action did.
 */
async function onRowAction(button, working, run) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = working;
  try {
    const result = await run();
    if (result && result.error) showError(result.error);
    return result;
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function renderDuels(board) {
  duelBoard = board;
  renderSetup();
  const panel = $("duels");
  const list = $("duelList");
  if (!panel || !list) return;

  const incoming = (board && board.incoming) || [];
  const outgoing = (board && board.outgoing) || [];

  panel.hidden = !board;
  setDuelCount(incoming.filter((d) => d.ready).length);
  if (!board) return;

  list.textContent = "";
  for (const duel of incoming) list.append(incomingRow(duel));
  for (const duel of outgoing) list.append(outgoingRow(duel));

  const ready = incoming.filter((d) => d.ready).length;
  const waiting = incoming.length - ready;
  $("duelNote").textContent = incoming.length
    ? [ready ? ready + " waiting on you" : null, waiting ? waiting + " still being played" : null]
        .filter(Boolean)
        .join(" \u00b7 ")
    : outgoing.length
      ? outgoing.length + " sent"
      : "";
}

function incomingRow(duel) {
  const row = document.createElement("div");
  row.className = "duel-row" + (duel.ready ? "" : " waiting");

  const who = document.createElement("div");
  who.className = "duel-who";
  const name = document.createElement("div");
  name.className = "duel-name";
  // Steam-supplied text. textContent rather than markup, for the same reason every other
  // player's name on this screen goes through esc().
  name.textContent = duel.from.displayName;
  const sub = document.createElement("span");
  sub.className = "duel-sub";
  sub.textContent = duel.ready
    ? "rating " + duel.from.rating + (duel.from.provisional ? " \u00b7 provisional" : "") +
      " \u00b7 " + untilExpiry(duel.expiresAt)
    : "playing their 3 now";
  who.append(name, sub);

  const answers = document.createElement("div");
  answers.className = "duel-answers";

  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "go";
  accept.textContent = "Accept";

  // Said here rather than discovered on the server. A button that can only fail is worse
  // than one that says why it is off.
  if (!duel.ready) {
    accept.disabled = true;
    accept.title = "They have not finished playing this one yet";
  } else if (activeMatch) {
    accept.disabled = true;
    accept.title = "Finish or abandon your current match first";
  }

  accept.addEventListener("click", async () => {
    // Accepting is rated and starts a match on the spot, which is a bigger commitment
    // than anything else on this panel. Declining costs nothing and does not ask.
    const ok = window.confirm(
      "Accept " + duel.from.displayName + "'s duel?\n\n" +
        "You play the same 3 scenarios they did. The result is rated.",
    );
    if (!ok) return;

    const result = await onRowAction(accept, "Starting\u2026", () =>
      api.answerDuel(duel.id, "accept"));
    if (result && result.match) {
      activeMatch = result.match;
      paintActiveMatch();
      showNotice("Duel accepted. Play the 3 below in KovaaK's.");
    }
  });

  const decline = document.createElement("button");
  decline.type = "button";
  decline.textContent = "Decline";
  decline.addEventListener("click", () =>
    onRowAction(decline, "\u2026", () => api.answerDuel(duel.id, "decline")));

  answers.append(accept, decline);
  row.append(who, answers);
  return row;
}

function outgoingRow(duel) {
  const row = document.createElement("div");
  row.className = "duel-row" + (duel.status === "open" ? "" : " waiting");

  const who = document.createElement("div");
  who.className = "duel-who";
  const name = document.createElement("div");
  name.className = "duel-name";
  name.textContent = duel.to.displayName;
  const sub = document.createElement("span");
  sub.className = "duel-sub";
  sub.textContent =
    duel.status !== "open"
      ? "you sent this \u00b7 " + duel.status
      : !duel.played
        ? "you sent this \u00b7 play your 3 so they can answer"
        : "you sent this \u00b7 waiting on them \u00b7 " + untilExpiry(duel.expiresAt);
  who.append(name, sub);

  const answers = document.createElement("div");
  answers.className = "duel-answers";

  // Only an open one can be taken back. A resolved row is here to be read.
  if (duel.status === "open") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Take back";
    cancel.addEventListener("click", () =>
      onRowAction(cancel, "\u2026", () => api.answerDuel(duel.id, "cancel")));
    answers.append(cancel);
  }

  row.append(who, answers);
  return row;
}

/* ----------------------------------------------------------------- picking ---- */

function renderRoster() {
  const host = $("rosterList");
  if (!host || !duelBoard) return;

  const filter = ($("rosterFilter").value || "").trim().toLowerCase();
  const friendIds = new Set((duelBoard.friends || []).map((f) => f.playerId));

  // Shortlist first, then everybody, each by how recently they played. A roster you have
  // to search to find the three people you actually duel is working against you.
  const seen = new Set();
  const people = [...(duelBoard.friends || []), ...(duelBoard.roster || [])].filter((p) => {
    if (seen.has(p.playerId)) return false;
    seen.add(p.playerId);
    return !filter || p.displayName.toLowerCase().includes(filter);
  });

  host.textContent = "";
  // Steam only shares a friends list set to public. Without it a friend who has not
  // finished a match yet is not on this list at all, and nothing else would say why.
  if (duelBoard.steamFriends === "private") {
    const hint = document.createElement("p");
    hint.className = "roster-empty";
    hint.textContent =
      "Your Steam friends list is private, so friends who haven't played a match yet can't be listed. " +
      "Set Friends List to Public in Steam's privacy settings, or ask them to finish one match.";
    host.append(hint);
  }
  if (people.length === 0) {
    const empty = document.createElement("p");
    empty.className = "roster-empty";
    empty.textContent = filter
      ? "Nobody by that name has played yet."
      : "No other players have finished a match yet.";
    host.append(empty);
    return;
  }

  for (const person of people) host.append(rosterRow(person, friendIds.has(person.playerId)));
}

function rosterRow(person, isFriend) {
  const row = document.createElement("div");
  row.className = "roster-row";

  const who = document.createElement("div");
  who.className = "duel-who";
  const name = document.createElement("div");
  name.className = "duel-name";
  name.textContent = person.displayName;
  const sub = document.createElement("span");
  sub.className = "duel-sub";
  const played = person.lastPlayedAt
    ? "last played " + new Date(person.lastPlayedAt).toLocaleDateString()
    : "no matches yet";
  sub.textContent = person.steamFriend ? "Steam friend · " + played : played;
  who.append(name, sub);

  const rating = document.createElement("span");
  rating.className = "roster-rating";
  // A question mark rather than a hidden number: a rating that has not settled is still
  // the best guess anybody has, and hiding it says less than marking it.
  rating.textContent = person.provisional ? person.rating + "?" : String(person.rating);
  rating.title = person.provisional ? "Their rating has not settled yet" : "Their rating";

  const send = document.createElement("button");
  send.type = "button";
  send.className = "go";
  send.textContent = "Duel";
  send.disabled = Boolean(activeMatch);
  if (activeMatch) send.title = "Finish or abandon your current match first";
  send.addEventListener("click", async () => {
    if (!duelCategory) {
      showError("Pick a category to duel in first.");
      return;
    }
    if (!current || !current.benchmark || !current.benchmark.matchPool) {
      showError("The season pool has not loaded yet.");
      return;
    }
    const result = await onRowAction(send, "\u2026", () =>
      api.sendDuel(person.playerId, duelCategory, current.benchmark.matchPool));
    if (result && result.match) {
      showNotice("Duel sent to " + person.displayName + ". Play your 3 and it goes to them.");
      $("duelRoster").hidden = true;
      activeMatch = result.match;
      paintActiveMatch();
    }
  });

  const star = document.createElement("button");
  star.type = "button";
  star.className = "roster-star" + (isFriend ? " on" : "");
  star.textContent = isFriend ? "\u2605" : "\u2606";
  star.title = isFriend ? "Remove from your shortlist" : "Pin to the top of this list";
  star.addEventListener("click", async () => {
    star.disabled = true;
    try {
      const r = await api.setFriend(person.playerId, !isFriend);
      if (r && r.error) showError(r.error);
    } finally {
      star.disabled = false;
    }
  });

  const actions = document.createElement("div");
  actions.className = "duel-answers";
  actions.append(send, star);

  row.append(who, rating, actions);
  return row;
}

/**
 * The category a duel is sent in.
 *
 * Its own choice rather than the queue's, because they are different questions. The queue
 * can say Any; a duel cannot, since there is one opponent and they were chosen, so
 * "whatever you have" describes nothing. send-duel refuses it either way.
 */
function renderDuelCategories() {
  const host = $("duelCats");
  if (!host || !current) return;

  const names = (current.categories || []).map((c) => c.name).filter(Boolean);
  if (!duelCategory || !names.includes(duelCategory)) duelCategory = names[0] || null;

  host.textContent = "";
  for (const name of names) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cat";
    chip.textContent = name;
    chip.setAttribute("aria-pressed", String(name === duelCategory));
    chip.addEventListener("click", () => {
      duelCategory = name;
      renderDuelCategories();
    });
    host.append(chip);
  }
}

/**
 * The count on the bar, so an inbox is visible from every screen.
 *
 * Only the ones that can actually be answered. A duel somebody is still playing is worth
 * a line in the panel and is not worth a number on the chrome, because there is nothing
 * to go and do about it.
 */
function setDuelCount(ready) {
  const chip = $("duelLive");
  if (!chip) return;
  chip.hidden = ready === 0;
  if (ready > 0) $("duelLiveText").textContent = ready === 1 ? "1 duel" : ready + " duels";
}

/* ================================================================ tournaments */

/**
 * Tournaments: the list, the host form, and one tournament in full.
 *
 * A pure view like the rest of this file. The server decides who is entered, who plays
 * whom and who won; this draws what list-tournaments sends, which has no score in it
 * anywhere. Every name goes in through textContent and never through markup: these are
 * Steam names shown to everybody on a bracket, and sooner or later one of them will be
 * an `<img onerror>`.
 */

let tnList = null;
let tnView = null;
let tnOpenId = null;
let tnTab = null;
let tnPoll = null;
/** In the preview: the example tournaments, one per stage, drawn by the real engine. */
let tnSamples = null;
const tnForm = { name: "", category: null, groupCount: 4, groupSize: 4, qualifiers: 2, seeding: "seeded" };

const TN_PHASE = {
  registration: "Open for entry",
  groups: "Group stage",
  playoffs: "Playoffs",
  completed: "Finished",
  cancelled: "Cancelled",
};

/** How often an open tournament is re-read while its screen is showing. See the list-tournaments limit. */
const TN_POLL_MS = 30000;

const TN_MARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="m3 20 9-17 9 17M3 20l9-6 9 6M8 11h8M12 3l0 11"/></svg>';

function tnEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function tnButton(label, kind, onClick) {
  const b = tnEl("button", "tn-btn" + (kind ? " " + kind : ""), label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function tnPill(phase, turn) {
  const kind = turn ? "turn"
    : phase === "registration" ? "open"
    : phase === "groups" || phase === "playoffs" ? "live"
    : phase === "completed" ? "done" : "off";
  const pill = tnEl("span", "tn-pill " + kind);
  pill.append(tnEl("span", "dot"), document.createTextNode(turn ? "Your fixture" : TN_PHASE[phase] || phase));
  return pill;
}

/** Two letters for the monogram, from whatever in the name is a letter or a digit. */
function tnInitials(name) {
  const letters = [...String(name).replace(/[^\p{L}\p{N}]/gu, "")];
  return (letters.slice(0, 2).join("") || "?").toUpperCase();
}

function tnWho(name, you, mark) {
  const who = tnEl("span", "tn-who");
  who.append(tnEl("span", "tn-mono" + (you ? " you" : ""), tnInitials(name)));
  const b = tnEl("b", null, name);
  if (mark) b.append(tnEl("sup", null, mark));
  who.append(b);
  return who;
}

function tnEmpty(title, body) {
  const box = tnEl("div", "tn-empty");
  box.append(tnEl("strong", null, title), document.createTextNode(body));
  return box;
}

/** "A1" is how the view names a group place. On screen it reads as one. */
function tnPlace(label) {
  const m = /^([A-H])([12])$/.exec(label);
  return m ? "Group " + m[1] + " · " + (m[2] === "1" ? "1st" : "2nd") : label;
}

/* ------------------------------------------------------------------ the list */

function renderTournaments(list) {
  tnList = list;
  setTournamentCount(list);
  const host = $("tnIndex");
  if (!host) return;
  host.textContent = "";

  const wrap = tnEl("div", "tn-index");
  const main = tnEl("div");
  const side = tnEl("div");

  if (!list) {
    const empty = HOST === "electron" && signedIn
      ? tnEmpty("Couldn't load tournaments", "The server did not answer. They reload on their own while this screen is open.")
      : tnEmpty(HOST === "electron" ? "Sign in to play" : "Loading", "Sign in to see and join tournaments.");
    // "Sign in to play" with nothing to press, and the only sign-in button at the foot of
    // the rail. The same button, so the two cannot behave differently.
    if (HOST === "electron" && !signedIn && $("btnSignIn") && !$("btnSignIn").disabled) {
      const signIn = tnButton("Sign in with Steam", "primary", () => $("btnSignIn").click());
      signIn.style.marginTop = "16px";
      empty.append(document.createElement("br"), signIn);
    }
    main.append(empty);
  } else {
    const live = (t) => t.phase === "groups" || t.phase === "playoffs";
    const mine = (t) => t.entered || t.hostedByYou;
    const sections = [
      ["Yours", list.filter((t) => mine(t) && (live(t) || t.phase === "registration"))],
      ["Open for entry", list.filter((t) => !mine(t) && t.phase === "registration")],
      ["Being played", list.filter((t) => !mine(t) && live(t))],
      ["Finished", list.filter((t) => t.phase === "completed" || t.phase === "cancelled")],
    ];
    const any = sections.some(([, rows]) => rows.length > 0);
    if (!any) {
      main.append(tnEmpty(
        "Nothing running yet",
        "Host one. Entry opens immediately; start it once enough players check in.",
      ));
    }
    for (const [title, rows] of sections) {
      if (rows.length === 0) continue;
      main.append(tnEl("div", "tn-section-k", title));
      const cards = tnEl("div", "tn-cards");
      rows.forEach((t) => cards.append(tnCard(t)));
      main.append(cards);
    }
  }

  side.append(tnHostPanel());
  wrap.append(main, side);
  host.append(wrap);
}

function tnCard(t) {
  const card = tnEl("button", "tn-card" + (t.yourTurn ? " turn" : ""));
  card.type = "button";

  card.append(tnEl("span", "tn-card-name", t.name));

  const meta = tnEl("span", "tn-card-meta");
  meta.append(
    tnEl("span", null, t.category + " · " + t.windowName),
    tnEl("span", null, t.groupCount + " groups of " + t.groupSize),
    tnEl("span", null, t.hostedByYou ? "You are hosting" : "Hosted by " + t.hostName),
  );
  if (t.championName) meta.append(tnEl("span", null, "Won by " + t.championName));
  card.append(meta);

  const sideCol = tnEl("span", "tn-card-side");
  sideCol.append(tnPill(t.phase, t.yourTurn));
  if (t.phase === "registration") {
    const fill = tnEl("span", "tn-fill");
    const bar = tnEl("i");
    bar.style.width = Math.round((t.entrants / Math.max(1, t.capacity)) * 100) + "%";
    fill.append(bar);
    sideCol.append(fill, tnEl("span", "tn-count", t.entrants + "/" + t.capacity + " · " + t.checkedIn + " checked in"));
  } else {
    sideCol.append(tnEl("span", "tn-count", t.entrants + " players"));
  }
  card.append(sideCol);

  card.addEventListener("click", () => tnOpen(t.id));
  return card;
}

/* ------------------------------------------------------------------ hosting */

function tnSeg(options, value, onPick) {
  const seg = tnEl("div", "tn-seg");
  for (const [v, label] of options) {
    const b = tnEl("button", null, label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(v === value));
    b.addEventListener("click", () => onPick(v));
    seg.append(b);
  }
  return seg;
}

function tnField(label, control) {
  const field = tnEl("div", "tn-field");
  field.append(tnEl("span", null, label), control);
  return field;
}

function tnHostPanel() {
  const panel = tnEl("div", "panel tn-host");
  const head = tnEl("div", "phead");
  head.append(tnEl("h2", null, "Host a tournament"), tnEl("span", "note", "Unrated"));
  const body = tnEl("div", "pbody");
  panel.append(head, body);

  const redraw = () => {
    const fresh = tnHostPanel();
    panel.replaceWith(fresh);
  };

  const name = tnEl("input", "tn-input");
  name.type = "text";
  name.maxLength = 48;
  name.placeholder = "Friday Night Tracking";
  name.value = tnForm.name;
  name.addEventListener("input", () => { tnForm.name = name.value; });
  body.append(tnField("Name", name));

  const categories = ["Any", ...((current && current.categories) || []).map((c) => c.name).filter(Boolean)];
  if (!tnForm.category || !categories.includes(tnForm.category)) tnForm.category = categories[1] || "Any";
  body.append(tnField("Every fixture is drawn from", tnSeg(
    categories.map((c) => [c, c === "Any" ? "Any category" : c]),
    tnForm.category,
    (v) => { tnForm.category = v; redraw(); },
  )));

  body.append(tnField("Groups", tnSeg([[2, "2"], [4, "4"], [8, "8"]], tnForm.groupCount,
    (v) => { tnForm.groupCount = v; redraw(); })));
  body.append(tnField("Players per group", tnSeg([3, 4, 5, 6, 7, 8].map((n) => [n, String(n)]), tnForm.groupSize,
    (v) => { tnForm.groupSize = v; redraw(); })));
  body.append(tnField("Through from each group", tnSeg([[1, "Top 1"], [2, "Top 2"]], tnForm.qualifiers,
    (v) => { tnForm.qualifiers = v; redraw(); })));
  body.append(tnField("Draw", tnSeg([["seeded", "Seeded by rating"], ["shuffle", "Random"]], tnForm.seeding,
    (v) => { tnForm.seeding = v; redraw(); })));

  const g = tnForm.groupCount;
  const s = tnForm.groupSize;
  const q = tnForm.qualifiers;
  const capacity = g * s;
  const groupFixtures = g * s * (s - 1) / 2;
  const spots = g * q;
  const minimum = g * Math.max(3, q + 1);
  const sum = tnEl("p", "tn-sum");
  sum.append(
    tnEl("b", null, "Up to " + capacity + " players. "),
    document.createTextNode(
      groupFixtures + " group fixtures when full, then a " + spots + "-player bracket. " +
      "It needs " + minimum + " checked in to start. The window is " +
      ((current && current.benchmark && current.benchmark.difficulty) || "the season's") + ".",
    ),
  );
  body.append(sum);

  const create = tnButton("Open it for entry", "primary", async () => {
    if (HOST !== "electron") {
      showNotice("Tournaments are hosted from the desktop app.");
      return;
    }
    const pool = current && current.benchmark && current.benchmark.matchPool;
    if (!pool) {
      showError("The season pool has not loaded yet.");
      return;
    }
    if (!tnForm.name.trim()) {
      showError("Give it a name.");
      name.focus();
      return;
    }
    const result = await onRowAction(create, "Opening…", () => api.createTournament({
      name: tnForm.name.trim(),
      category: tnForm.category,
      window: pool.window,
      groupCount: g,
      groupSize: s,
      qualifiers: q,
      seeding: tnForm.seeding,
    }));
    if (result && result.view) {
      tnForm.name = "";
      showNotice(result.view.name + " is open for entry.");
      renderTournamentView(result.view);
    }
  });
  body.append(create);
  return panel;
}

/* ------------------------------------------------------------ fetching, acting */

/** The bar chip: a fixture of yours can be played right now, somewhere. */
function setTournamentCount(list) {
  const chip = $("tnLive");
  if (!chip) return;
  const ready = (list || []).filter((t) => t.yourTurn).length;
  chip.hidden = ready === 0;
  if (ready > 0) $("tnLiveText").textContent = ready === 1 ? "Your fixture" : ready + " fixtures";
}

let tnLastList = "";
let tnLastView = "";
async function tnRefresh() {
  if (HOST !== "electron") return;
  const r = await api.tournaments(tnOpenId || undefined).catch(() => null);
  if (!r || r.error) {
    if (r && r.error && tnOpenId) showError(r.error);
    return;
  }
  // Nothing redraws while the player is typing into a form, and nothing redraws at all
  // when nothing changed: a redraw threw away focus and a half-typed cancel reason.
  const typing = document.activeElement && document.activeElement.closest &&
    document.activeElement.closest("#tnIndex .tn-host, #tnDetail input, #tnDetail textarea, #tnDetail select");
  if (typing) return;
  const list = JSON.stringify(r.tournaments || null);
  if (r.tournaments && list !== tnLastList) {
    tnLastList = list;
    renderTournaments(r.tournaments);
  }
  const view = JSON.stringify(r.view || null);
  if (tnOpenId && r.view && view !== tnLastView) {
    tnLastView = view;
    renderTournamentView(r.view);
  }
}

function tnOpen(id) {
  if (HOST !== "electron") {
    if (tnSamples && tnSamples[id]) renderTournamentView(tnSamples[id], id);
    return;
  }
  tnLastView = "";
  tnOpenId = id;
  tnTab = null;
  void tnRefresh();
}

function tnClose() {
  tnOpenId = null;
  tnView = null;
  tnTab = null;
  $("tnDetail").hidden = true;
  $("tnIndex").hidden = false;
  $("screen-tournaments").classList.remove("detail");
  renderTournaments(tnList);
  document.querySelector(".scroll").scrollTop = 0;
}

/** Run an action whose answer is the tournament as it now stands, and draw that. */
async function tnAct(button, working, run) {
  if (HOST !== "electron") {
    showNotice("Tournaments are played from the desktop app.");
    return null;
  }
  const result = await onRowAction(button, working, run);
  if (result && result.view) renderTournamentView(result.view);
  return result;
}

async function tnPlayFixture(button, view, next) {
  if (HOST !== "electron") {
    showNotice("Fixtures are played from the desktop app.");
    return;
  }
  const result = await onRowAction(button, "Opening…", () =>
    api.playFixture(view.id, next.fixtureId, next.attempt));
  if (result && result.match) {
    activeMatch = result.match;
    paintActiveMatch();
    openScreen("queue");
    showNotice(next.label + " is open. Play the three below in KovaaK's.");
  } else {
    void tnRefresh();
  }
}

/* ------------------------------------------------------------ one tournament */

function renderTournamentView(view, sampleKey) {
  tnView = view;
  const index = $("tnIndex");
  const detail = $("tnDetail");
  if (!index || !detail) return;
  if (!view) {
    detail.hidden = true;
    index.hidden = false;
    return;
  }
  tnOpenId = sampleKey || view.id;
  index.hidden = true;
  detail.hidden = false;
  $("screen-tournaments").classList.add("detail");
  detail.textContent = "";

  const names = new Map(view.entrants.map((e) => [e.playerId, e.name]));
  const nameOf = (id) => names.get(id) || "player";
  const me = view.you.playerId;
  if (!tnTab) tnTab = view.phase === "registration" ? "players" : view.phase === "playoffs" || view.phase === "completed" ? "bracket" : "groups";

  const back = tnEl("button", "tn-back", "All tournaments");
  back.type = "button";
  back.addEventListener("click", tnClose);

  const wrap = tnEl("div");
  wrap.style.display = "grid";
  wrap.style.gap = "18px";
  wrap.append(back, tnHero(view, nameOf));

  if (view.phase === "completed" && view.champion) {
    const banner = tnEl("div", "panel tn-banner won");
    const text = tnEl("div");
    text.append(
      tnEl("b", null, view.champion.playerId === me ? "You won it." : view.champion.name + " won it."),
      tnEl("p", null, "Full results in the bracket below."),
    );
    banner.append(text);
    wrap.append(banner);
  } else if (view.phase === "cancelled") {
    const banner = tnEl("div", "panel tn-banner off");
    const text = tnEl("div");
    text.append(
      tnEl("b", null, "Cancelled by the host."),
      tnEl("p", null, view.cancellationReason || "No reason given."),
    );
    banner.append(text);
    wrap.append(banner);
  }

  const nextPanel = tnNextPanel(view, nameOf);
  if (nextPanel) wrap.append(nextPanel);
  wrap.append(tnStats(view));
  const hostPanel = tnHostControls(view);
  if (hostPanel) wrap.append(hostPanel);

  const tabs = tnEl("div", "tn-tabs");
  tabs.setAttribute("role", "tablist");
  const played = view.fixtures.filter((f) => f.stage === "playoff").length;
  for (const [key, label, count] of [
    ["groups", "Groups", view.groups.length || null],
    ["bracket", "Bracket", played || null],
    ["players", "Players", view.entrants.length],
    ["rules", "Rules", null],
  ]) {
    const b = tnEl("button", null, label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(tnTab === key));
    if (count) b.append(tnEl("b", null, count));
    b.addEventListener("click", () => {
      tnTab = key;
      renderTournamentView(tnView, sampleKey);
    });
    tabs.append(b);
  }
  wrap.append(tabs);

  const body = tnTab === "bracket" ? tnBracket(view, nameOf)
    : tnTab === "players" ? tnPlayers(view)
    : tnTab === "rules" ? tnRules(view)
    : tnGroups(view, nameOf);
  wrap.append(body);
  detail.append(wrap);
}

function tnHero(view, nameOf) {
  const panel = tnEl("div", "panel");
  const hero = tnEl("div", "tn-hero");
  const left = tnEl("div");

  const eyebrow = tnEl("div", "tn-eyebrow");
  eyebrow.append(tnPill(view.phase, false));
  if (view.phase === "groups") {
    const ready = view.fixtures.filter((f) => f.stage === "group" && f.status === "ready");
    const rounds = Math.max(0, ...view.fixtures.filter((f) => f.stage === "group").map((f) => f.round));
    if (ready.length) eyebrow.append(tnEl("span", null, "Round " + Math.min(...ready.map((f) => f.round)) + " of " + rounds));
  } else if (view.phase === "playoffs") {
    const round = view.bracket.find((r) => r.slots.some((s) => s.fixtureId && !s.winnerId));
    if (round) eyebrow.append(tnEl("span", null, round.title));
  }
  eyebrow.append(tnEl("span", "tn-muted", "Unrated"));
  left.append(eyebrow, tnEl("h2", "tn-name", view.name));

  const tags = tnEl("div", "tn-tags");
  [
    view.category + " · " + view.windowName,
    view.config.groupCount + " groups of up to " + view.config.groupSize,
    "Top " + view.config.qualifiers + " go through",
    view.playoffSpots + "-player bracket",
    view.config.seeding === "seeded" ? "Seeded by rating" : "Random draw",
    view.host.you ? "You are hosting" : "Hosted by " + view.host.name,
  ].forEach((t) => tags.append(tnEl("span", null, t)));
  left.append(tags);

  const crest = tnEl("div", "tn-crest" + (view.champion ? " won" : ""));
  const inner = tnEl("div");
  inner.innerHTML = TN_MARK;
  inner.append(tnEl("small", null, "Champion"), tnEl("b", null, view.champion ? view.champion.name : "Undecided"));
  crest.append(inner);
  hero.append(left, crest);
  panel.append(hero);

  // Where it is. Registration, groups, bracket, champion.
  const order = ["registration", "groups", "playoffs", "completed"];
  const reached = view.phase === "cancelled"
    ? (view.fixtures.some((f) => f.stage === "playoff") ? 2 : view.groups.length ? 1 : 0)
    : order.indexOf(view.phase);
  const checked = view.entrants.filter((e) => e.checkedIn).length;
  const steps = tnEl("div", "tn-steps");
  [
    ["Entry", view.entrants.length + " entered · " + checked + " checked in"],
    ["Groups", view.config.groupCount + " groups, everyone plays everyone"],
    ["Bracket", view.playoffSpots + " players, single elimination"],
    ["Champion", view.champion ? view.champion.name : "Undecided"],
  ].forEach(([title, sub], i) => {
    const done = view.phase === "cancelled" ? i <= reached : i < reached || (i === 3 && view.phase === "completed");
    const now = view.phase !== "cancelled" && i === reached && view.phase !== "completed";
    const step = tnEl("div", "tn-step" + (now ? " now" : done ? " done" : ""));
    step.append(tnEl("span", "n", i === 3 ? "▲" : "0" + (i + 1)));
    const text = tnEl("div");
    text.style.minWidth = "0";
    text.append(tnEl("b", null, title), tnEl("small", null, sub));
    step.append(text);
    steps.append(step);
  });
  panel.dataset.phase = view.phase;
  panel.classList.add("tn-event-hero");
  panel.append(steps);
  return panel;
}

function tnStats(view) {
  const panel = tnEl("div", "panel tn-stats");
  const stat = (label, value, small) => {
    const box = tnEl("div", "tn-stat");
    const b = tnEl("b", null, value);
    if (small) b.append(tnEl("small", null, small));
    box.append(tnEl("span", null, label), b);
    panel.append(box);
  };
  stat("Players", view.entrants.length, "of " + view.capacity);
  stat("Groups", view.config.groupCount, "top " + view.config.qualifiers + " through");
  stat("Bracket", view.playoffSpots, "players");
  stat("Fixtures decided", view.fixturesSettled, view.fixturesTotal ? "of " + view.fixturesTotal : "none drawn yet");
  return panel;
}

/** The one panel on the page you can act on: your fixture, or your entry. */
function tnNextPanel(view, nameOf) {
  const me = view.you.playerId;
  const panel = tnEl("div", "panel tn-next");
  const left = tnEl("div");
  const right = tnEl("div", "tn-row");

  if (view.phase === "registration") {
    const taken = view.entrants.length + " of " + view.capacity + " places taken.";
    panel.classList.toggle("go", !view.you.entered || !view.you.checkedIn);
    left.append(tnEl("div", "tn-next-k", "Entry"));
    if (!view.you.entered) {
      left.append(tnEl("div", "tn-vs", "Entries are open."));
      left.append(tnEl("p", null, taken + " Enter, then check in before the host starts it."));
      right.append(tnButton("Enter", "primary", (e) =>
        tnAct(e.currentTarget, "Entering…", () => api.joinTournament(view.id))));
    } else if (!view.you.checkedIn) {
      left.append(tnEl("div", "tn-vs", "You are entered."));
      left.append(tnEl("p", null,
        "Check in to confirm. Players not checked in at the start are left out of the draw."));
      right.append(
        tnButton("Check in", "primary", (e) =>
          tnAct(e.currentTarget, "Checking in…", () => api.checkIn(view.id, true))),
        tnButton("Withdraw", "quiet", (e) =>
          tnAct(e.currentTarget, "…", () => api.leaveTournament(view.id))),
      );
    } else {
      left.append(tnEl("div", "tn-vs", "You are checked in."));
      left.append(tnEl("p", null, taken + " The groups are drawn when the host starts it."));
      right.append(
        tnButton("Check out", "quiet", (e) =>
          tnAct(e.currentTarget, "…", () => api.checkIn(view.id, false))),
        tnButton("Withdraw", "quiet", (e) =>
          tnAct(e.currentTarget, "…", () => api.leaveTournament(view.id))),
      );
    }
    panel.append(left, right);
    return panel;
  }

  if (view.phase !== "groups" && view.phase !== "playoffs") return null;
  if (!view.you.entered) return null;

  const next = view.next;
  if (!next) {
    left.append(tnEl("div", "tn-next-k", view.you.out ? "Out" : "Between rounds"));
    left.append(tnEl("div", "tn-vs", view.you.out ? "Eliminated." : "Nothing to play right now."));
    left.append(tnEl("p", null, view.you.out
      ? "Follow the rest of it on the bracket below."
      : "Your next fixture opens when the rest of your round is done."));
    panel.append(left);
    return panel;
  }

  const opp = next.opponentName;
  panel.classList.toggle("go", next.action !== "wait");
  left.append(tnEl("div", "tn-next-k", next.label + (next.replay ? " · replay" : "")));
  const vs = tnEl("div", "tn-vs");
  vs.append(tnWho(nameOf(me), true), tnEl("span", "v", "VS"), tnWho(opp, false));
  left.append(vs);

  const copy = next.action === "resume"
    ? "Your leg is open. Play your 3 in KovaaK's; scores are read automatically."
    : next.action === "wait" && next.leg === 1
      ? "Your 3 are in. Waiting on " + opp + " to play the same 3."
      : next.action === "wait"
        ? opp + " is playing their 3 now. You play the same 3 next."
        : next.leg === 1
          ? "You play first: 3 scenarios, first run on each counts. " + opp +
            " then plays the same 3. Bigger improvement over baseline wins."
          : opp + " has played their 3. Same 3 for you. Bigger improvement over baseline wins.";
  left.append(tnEl("p", null, copy));

  if (next.action !== "wait") {
    const holding = activeMatch && !(activeMatch.tournament && activeMatch.tournament.fixtureId === next.fixtureId);
    const play = tnButton(next.action === "resume" ? "Resume" : "Play fixture", "primary", (e) =>
      tnPlayFixture(e.currentTarget, view, next));
    if (holding) {
      play.disabled = true;
      play.title = "Finish or abandon your current match first";
    }
    right.append(play);
  }
  panel.append(left, right);
  return panel;
}

function tnHostControls(view) {
  if (!view.host.you || view.phase === "completed" || view.phase === "cancelled") return null;
  const panel = tnEl("div", "panel tn-host-panel");
  const head = tnEl("div", "phead");
  head.append(tnEl("h2", null, "Hosting"), tnEl("span", "note", "Only you see this"));
  const body = tnEl("div", "pbody");
  panel.append(head, body);

  if (view.phase === "registration") {
    const checked = view.entrants.filter((e) => e.checkedIn);
    const unchecked = view.entrants.filter((e) => !e.checkedIn);
    const enough = checked.length >= view.minimumToStart;
    body.append(tnEl("p", "tn-note",
      checked.length + " checked in, " + view.minimumToStart + " needed. Starting fixes the roster and the seeds, " +
      "draws the groups and opens round one."));
    if (unchecked.length) {
      body.append(tnEl("div", "tn-warn",
        unchecked.length + (unchecked.length === 1 ? " player has" : " players have") +
        " not checked in and will be left out: " + unchecked.map((e) => e.name).join(", ") + "."));
    }
    const start = tnButton("Start the tournament", "primary", async (e) => {
      const ok = window.confirm(
        "Start " + view.name + "?\n\n" + checked.length + " players are drawn into " +
        view.config.groupCount + " groups" + (unchecked.length ? ", and " + unchecked.length + " left out" : "") +
        ". Nobody can enter after this.",
      );
      if (!ok) return;
      await tnAct(e.currentTarget, "Drawing…", () => api.startTournament(view.id, view.revision));
    });
    start.disabled = !enough;
    if (!enough) start.title = "Needs " + view.minimumToStart + " checked in";
    const row = tnEl("div", "tn-row");
    row.append(start);
    body.append(row);
  } else {
    body.append(tnEl("p", "tn-note",
      "Results update automatically as fixtures are played."));
  }

  const cancelRow = tnEl("div", "tn-row");
  const cancel = tnButton("Cancel tournament", "warn", () => {
    cancel.hidden = true;
    const reason = tnEl("input", "tn-input");
    reason.type = "text";
    reason.maxLength = 160;
    reason.placeholder = "Why, for everybody entered";
    reason.style.maxWidth = "360px";
    const confirmBtn = tnButton("Confirm cancel", "warn", (e) => {
      if (!reason.value.trim()) {
        reason.focus();
        return;
      }
      return tnAct(e.currentTarget, "Cancelling…", () => api.cancelTournament(view.id, reason.value.trim()));
    });
    const keep = tnButton("Keep it", "quiet", () => renderTournamentView(tnView));
    cancelRow.append(reason, confirmBtn, keep);
    reason.focus();
  });
  cancelRow.append(cancel);
  body.append(cancelRow);
  return panel;
}

/* ------------------------------------------------------------ the four tabs */

function tnFixtureStatus(f, nameOf) {
  if (f.status === "completed") {
    return f.outcome && f.outcome.kind === "forfeit" ? ["Forfeit", ""]
      : f.outcome && f.outcome.kind === "draw" ? ["Draw", ""] : ["Decided", ""];
  }
  if (f.status === "waiting") return ["Later round", ""];
  const replay = f.attempt > 1 ? " · replay" : "";
  switch (f.progress) {
    case "first-playing": return [nameOf(f.firstBy) + " playing" + replay, "play"];
    case "first-played": return ["Waiting on the answer" + replay, "play"];
    case "second-playing": return ["Answer in play" + replay, "play"];
    case "settling": return ["Settling" + replay, "play"];
    default: return [(f.yours ? "Your fixture" : "Ready") + replay, "play"];
  }
}

function tnFixtureCard(f, nameOf, me, groupName) {
  const card = tnEl("div", "tn-fx" + (f.status === "ready" ? " ready" : "") + (f.yours && f.status !== "completed" ? " mine" : ""));
  const top = tnEl("div", "tn-fx-top");
  const [status, kind] = tnFixtureStatus(f, nameOf);
  top.append(tnEl("span", null, groupName || f.label), tnEl("span", "st " + kind, status));
  card.append(top);
  for (const id of [f.a, f.b]) {
    const won = f.outcome && f.outcome.winnerId === id;
    const lost = f.outcome && f.outcome.winnerId && f.outcome.winnerId !== id;
    const row = tnEl("div", "tn-fx-row" + (won ? " won" : lost ? " lost" : ""));
    row.append(
      tnWho(nameOf(id), id === me),
      tnEl("span", "r", !f.outcome ? "" : f.outcome.kind === "draw" ? "D" : won ? "W" : "L"),
    );
    card.append(row);
  }
  return card;
}

function tnGroups(view, nameOf) {
  const out = tnEl("div");
  out.style.display = "grid";
  out.style.gap = "22px";
  if (view.groups.length === 0) {
    out.append(tnEmpty("Groups are drawn at the start",
      "When the host starts it, the checked-in players are seeded and dealt into " + view.config.groupCount +
      " groups. Until then, see the Players tab."));
    return out;
  }

  const me = view.you.playerId;
  const grid = tnEl("div", "tn-groups");
  for (const group of view.groups) {
    const card = tnEl("div", "panel tn-group");
    const head = tnEl("div", "phead");
    const title = tnEl("div", "tn-group-title");
    title.append(tnEl("span", "tn-letter", group.letter), tnEl("h2", null, group.name));
    head.append(title, tnEl("span", "note", group.played + " of " + group.total + " played"));

    const table = tnEl("table", "tn-table");
    const thead = tnEl("thead");
    const hr = tnEl("tr");
    ["#", "Player", "W-D-L", "Pts"].forEach((h) => hr.append(tnEl("th", null, h)));
    thead.append(hr);
    const tbody = tnEl("tbody");
    for (const s of group.standings) {
      const tr = tnEl("tr", (s.qualifies ? "q" : "") + (s.playerId === me ? " you" : ""));
      const who = tnEl("td");
      who.append(tnWho(nameOf(s.playerId), s.playerId === me, s.seedFallback ? "*" : null));
      tr.append(tnEl("td", null, s.rank), who,
        tnEl("td", null, s.won + "-" + s.drawn + "-" + s.lost), tnEl("td", null, s.points));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const foot = tnEl("div", "tn-foot");
    foot.append(
      tnEl("span", null, group.played === group.total ? "Final table" : "Provisional"),
      tnEl("span", null, "Top " + view.config.qualifiers + " go through"),
    );
    card.append(head, table, foot);
    grid.append(card);
  }
  out.append(grid);
  if (view.groups.some((g) => g.standings.some((s) => s.seedFallback))) {
    out.append(tnEl("p", "tn-note",
      "* Tied on points, head-to-head and wins, so seed decided it. Raw scores are never used."));
  }

  const groupFixtures = view.fixtures.filter((f) => f.stage === "group");
  const groupNameOf = new Map(view.groups.map((g) => [g.id, g.name]));
  const rounds = [...new Set(groupFixtures.map((f) => f.round))].sort((a, b) => a - b);
  const list = tnEl("div", "tn-rounds");
  for (const round of rounds) {
    const fixtures = groupFixtures.filter((f) => f.round === round)
      .sort((a, b) => Number(b.yours) - Number(a.yours) || a.id.localeCompare(b.id));
    const decided = fixtures.filter((f) => f.status === "completed").length;
    const k = tnEl("div", "tn-round-k", "Round " + round);
    k.append(tnEl("span", null, decided + " of " + fixtures.length + " decided"));
    const cards = tnEl("div", "tn-fixtures");
    fixtures.forEach((f) => cards.append(tnFixtureCard(f, nameOf, me, groupNameOf.get(f.groupId))));
    const block = tnEl("div");
    block.append(k, cards);
    list.append(block);
  }
  out.append(list);
  return out;
}

function tnBracket(view, nameOf) {
  const me = view.you.playerId;
  const wrap = tnEl("div", "tn-bracket-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Tournament bracket, scroll horizontally for later rounds");
  const bracket = tnEl("div", "tn-bracket");
  const byId = new Map(view.fixtures.map((f) => [f.id, f]));
  for (const round of view.bracket) {
    const col = tnEl("div", "tn-col");
    const k = tnEl("div", "tn-col-k", round.title);
    k.append(tnEl("span", null, round.slots.length === 1 ? "1 match" : round.slots.length + " matches"));
    const body = tnEl("div", "tn-col-body");
    for (const slot of round.slots) {
      const fixture = slot.fixtureId ? byId.get(slot.fixtureId) : null;
      const mine = fixture && fixture.yours && fixture.status !== "completed";
      const box = tnEl("div", "tn-slot" + (fixture ? "" : " tbd") + (mine ? " mine" : ""));
      for (const [id, from] of [[slot.a, slot.aFrom], [slot.b, slot.bFrom]]) {
        const won = slot.winnerId && slot.winnerId === id;
        const lost = slot.winnerId && id && slot.winnerId !== id;
        const row = tnEl("div", "tn-slot-row" + (won ? " won" : lost ? " lost" : ""));
        if (id) row.append(tnWho(nameOf(id), id === me), tnEl("span", "tn-count", won ? "W" : lost ? "L" : ""));
        else row.append(tnEl("span", "from", tnPlace(from)), tnEl("span"));
        box.append(row);
      }
      if (fixture && fixture.status !== "completed") box.title = tnFixtureStatus(fixture, nameOf)[0];
      body.append(box);
    }
    col.append(k, body);
    bracket.append(col);
  }
  const crown = tnEl("div", "tn-crown");
  const crest = tnEl("div", "tn-crest inline" + (view.champion ? " won" : ""));
  const inner = tnEl("div");
  inner.innerHTML = TN_MARK;
  inner.append(tnEl("small", null, "Champion"), tnEl("b", null, view.champion ? view.champion.name : "Undecided"));
  crest.append(inner);
  crown.append(crest);
  bracket.append(crown);
  wrap.append(bracket);

  const out = tnEl("div");
  out.style.display = "grid";
  out.style.gap = "12px";
  if (!view.fixtures.some((f) => f.stage === "playoff")) {
    out.append(tnEl("p", "tn-note",
      "Filled in once every group fixture is decided. Players from the same group cannot meet again before the final."));
  }
  out.append(wrap);
  return out;
}

function tnPlayers(view) {
  const grid = tnEl("div", "tn-roster");
  if (view.entrants.length === 0) {
    return tnEmpty("Nobody has entered yet", "Entries are open.");
  }
  const groupName = new Map(view.groups.map((g) => [g.id, g.name]));
  const drawn = view.groups.length > 0;
  for (const e of view.entrants) {
    const row = tnEl("div", "tn-entrant" + (e.you ? " you" : ""));
    const text = tnEl("div");
    text.style.minWidth = "0";
    text.append(
      tnEl("div", "tn-entrant-name", e.name + (e.you ? " (you)" : "")),
      tnEl("div", "tn-entrant-sub", drawn
        ? (e.groupId ? groupName.get(e.groupId) : "Not checked in at the draw")
        : e.checkedIn ? "Checked in" : "Entered, not checked in"),
    );
    const sideBox = tnEl("div", "tn-entrant-side");
    if (!drawn) {
      const pill = tnEl("span", "tn-pill " + (e.checkedIn ? "open" : "off"));
      pill.append(tnEl("span", "dot"), document.createTextNode(e.checkedIn ? "In" : "Waiting"));
      sideBox.append(pill);
      if (view.host.you && view.phase === "registration" && !e.you) {
        sideBox.append(tnButton("Remove", "quiet", (ev) => {
          if (!window.confirm("Remove " + e.name + " from " + view.name + "?")) return;
          return tnAct(ev.currentTarget, "…", () => api.removeEntrant(view.id, e.playerId));
        }));
      }
    }
    // The seed once there is one; before the draw there is not, and an empty column reads
    // as something missing, so the monogram stands in.
    row.append(
      drawn ? tnEl("span", "tn-seed", e.seed) : tnEl("span", "tn-mono" + (e.you ? " you" : ""), tnInitials(e.name)),
      text,
      sideBox,
    );
    grid.append(row);
  }
  const out = tnEl("div");
  out.style.display = "grid";
  out.style.gap = "12px";
  out.append(tnEl("p", "tn-note", drawn
    ? "Seeds were fixed at the draw, " + (view.config.seeding === "seeded" ? "strongest first by ladder rating." : "then the groups were drawn at random.")
    : "Seeds are set at the draw, from ladder rating. Until then the list is in the order people entered."), grid);
  return out;
}

function tnRules(view) {
  const g = view.config.groupCount;
  const q = view.config.qualifiers;
  const rules = [
    ["Groups, then the bracket",
      g + " groups, snake-seeded. Everyone in a group plays everyone else once, and the top " +
      q + " of each go through to a " + view.playoffSpots + "-player knockout."],
    ["One fixture, one match",
      "Each fixture is a standard Apogee match: 3 scenarios, scored against your own baselines, won by the bigger improvement. One player goes first; the other plays the same 3 after."],
    ["Points",
      "Win 3, draw 1, loss 0. Level on points goes to the results between the players who are level, then wins, then seed, and the table marks it when the seed decided. Raw scores never decide anything."],
    ["Replays",
      "A void match is played again at either stage. In the bracket a draw is played again too; in a group it stands. Abandoning your answer forfeits the fixture, and abandoning a first leg means it is played again."],
    ["Fair play",
      "Runs are verified the same way as ranked runs. A rejected run voids the match, and the fixture is replayed."],
    ["Unrated",
      "Tournament matches are unrated and stay out of the matchmaking pool. The runs still count toward your history and baselines."],
  ];
  const grid = tnEl("div", "tn-rules");
  rules.forEach(([title, copy], i) => {
    const card = tnEl("div", "tn-rule");
    card.append(tnEl("span", null, "0" + (i + 1)), tnEl("h3", null, title), tnEl("p", null, copy));
    grid.append(card);
  });
  return grid;
}

/* ------------------------------------------------------------ the screen */

function tnScreenShown(shown) {
  if (tnPoll) {
    clearInterval(tnPoll);
    tnPoll = null;
  }
  if (!shown) return;
  if (HOST !== "electron") return;
  void tnRefresh();
  // Somebody else's leg finishing is not something this client hears about, so while the
  // screen is up it asks. Hidden windows do not ask: nobody is reading them.
  tnPoll = setInterval(() => {
    if (document.visibilityState === "visible") void tnRefresh();
  }, TN_POLL_MS);
}

// Every route onto a screen goes through a tab's click, so this is the one place that
// knows the tournament screen came up or went away.
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => tnScreenShown(tab.dataset.screen === "tournaments")));

// Before anything can paint over them. Everything below reads these as the value to
// go back to, so they have to be taken while they are still the only value there is.
captureCopyDefaults();

/**
 * Keep the window buttons on the top bar's own ground.
 *
 * The operating system paints minimise, maximise and close on a strip main sets, and that
 * strip only knows the colour it is told. The top bar's colour is whatever the stylesheets
 * compute - the arcade look, the theme menu and Expedition all move it - so it is read off
 * the element and sent whenever a theme, a screen or a stylesheet could have changed it.
 */
function syncWindowChrome() {
  const bar = document.querySelector(".topbar");
  if (!bar || !window.apogee || !window.apogee.setWindowChrome) return;
  const hex = (css) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(css || "");
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
    return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  };
  const style = getComputedStyle(bar);
  const color = hex(style.backgroundColor) || hex(getComputedStyle(document.body).backgroundColor);
  const probe = document.createElement("span");
  probe.style.color = "var(--ink-mid)";
  bar.append(probe);
  const symbolColor = hex(getComputedStyle(probe).color);
  probe.remove();
  if (!color || !symbolColor) return;
  const key = color + symbolColor;
  if (key === syncWindowChrome.last) return;
  syncWindowChrome.last = key;
  window.apogee.setWindowChrome({ color, symbolColor });
}

if (HOST === "electron") {
  reserveTables();

  {
    let pending = 0;
    const later = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(syncWindowChrome);
    };
    const watch = new MutationObserver(later);
    watch.observe(document.documentElement, { attributes: true, subtree: false });
    watch.observe(document.body, { attributes: true, attributeFilter: ["class", "data-screen", "style"] });
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
    later();
  }

  wireAdmin();
  void loadAdminLook();

  // The board once on the way in. Main broadcasts it after the session is restored, but
  // that is a network round trip and this window may have finished loading long before -
  // so the panel asks as well as listening, and whichever arrives first paints it.
  void api.duels().then((r) => {
    if (r && r.board) renderDuels(r.board);
  }).catch(() => undefined);

  $("btnRescan").addEventListener("click", () => api.rescan());
  $("btnOpen").addEventListener("click", () => api.openStatsFolder());
  const choose = async () => {
    const chosen = await api.chooseFolder();
    if (chosen && typeof chosen === "object" && chosen.error) showError(chosen.error);
    else if (typeof chosen === "string") {
      currentPath = chosen;
      setStatus("scanning", "Scanning\u2026", currentPath);
    }
  };
  $("btnChoose").addEventListener("click", choose);
  $("emptyChoose").addEventListener("click", choose);

  $("btnSignIn").addEventListener("click", async () => {
    const result = await api.signIn();
    if (result && result.error) showError(result.error);
  });

  // A listener added this way is invisible from outside: there is no way to ask an
  // element whether anything is bound to it. The smoke test checks that the sign-in
  // button is present, visible and enabled, and a button that is all three with
  // nothing behind it looks identical - so the binding leaves a mark it can read.
  $("btnSignIn").dataset.wired = "1";

  $("btnSignOut").addEventListener("click", async () => {
    if (activeMatch && !activeMatch.seeding &&
        !window.confirm("You have a match open. Signing out leaves it to expire, which counts as a forfeit.\n\nSign out anyway?")) return;
    await api.signOut();
  });

  api.onSession((session) => {
    renderSession(session, true);
    // Uploading only makes sense once there is an account to attach runs to.
    $("uploadRow").hidden = !session;
    // A "sign in first" left over from before signing in is no longer true.
    if (session && !$("banner").classList.contains("notice")) showError(null);

    // Signing out clears the gate rather than leaving the last account's progress on
    // screen; signing in asks for this one's.
    if (!session) {
      eligibility = null;
      renderEligibility();
    } else {
      refreshEligibility();
    }
  });

  // Pushed by main when a backfill finishes, so the count moves without a relaunch.
  if (api.onEligibility) {
    api.onEligibility((state) => {
      eligibility = state;
      renderEligibility();
    });
  }

  // ---- history upload ----------------------------------------------------
  const gateUpload = $("queueGateUpload");
  if (gateUpload) gateUpload.addEventListener("click", () => $("uploadBtn").click());

  $("uploadBtn").addEventListener("click", async () => {
    const btn = $("uploadBtn");
    btn.disabled = true;
    uploadBusy = true;
    renderEligibility();
    $("uploadTrack").hidden = false;
    showError(null);

    let result;
    try {
      result = await api.uploadHistory();
    } catch (err) {
      result = { error: err && err.message ? err.message : String(err) };
    }

    btn.disabled = false;
    uploadBusy = false;
    uploadFailed = Boolean(result.error || (result.result && result.result.errors.length));
    refreshEligibility();
    if (result.error) {
      showError(result.error);
      return;
    }

    const r = result.result;
    const b = result.baselines;
    $("uploadTitle").textContent = "History uploaded";
    $("uploadSub").textContent =
      `${r.uploaded.toLocaleString()} runs on the server` +
      (b ? ` · ${b.solid} baselines ready` : "") +
      (r.skipped ? ` · ${r.skipped} unreadable files skipped` : "") +
      (r.errors.length ? ` · ${r.errors.length} batch error(s)` : "");
    btn.textContent = "Upload again";
    if (r.errors.length) showError(r.errors[0]);
  });

  api.onUploadProgress((p) => {
    if (p.phase === "baselines") {
      setFill($("uploadFill"), 1);
      $("uploadSub").textContent = "Computing your baselines…";
      return;
    }
    const pct = p.total ? (p.uploaded / p.total) * 100 : 0;
    setFill($("uploadFill"), pct / 100);
    $("uploadSub").textContent =
      `${p.uploaded.toLocaleString()} of ${p.total.toLocaleString()} runs` +
      ` · batch ${p.batch}/${p.batches}`;
  });

  // ---- match lifecycle ---------------------------------------------------
  api.onMatch((match) => {
    activeMatch = match;
    if (!match) {
      // An abandon can move the rating; show where it landed.
      refreshStanding();
      pendingMatchId = null;
      delete $("queueBtn").dataset.held;
      delete $("cancelMatchBtn").dataset.settle;
      if (duelBoard) renderDuels(duelBoard);
      $("opponent").classList.remove("on");
      $("matchActions").hidden = true;
      resetCommit(current);
      renderEligibility();
      if (lastSettled) renderRematch(lastSettled);
      return;
    }
    // A non-null match used to set the variable and paint nothing, which was already
    // wrong before duels: main recovers a match left open by a previous run and
    // broadcasts it, so restarting mid-match showed an empty Play screen while the
    // watcher quietly submitted runs against a match the player could not see.
    paintActiveMatch();
    // The rematch button on the last result is only pressable with no match open.
    if (lastSettled) renderRematch(lastSettled);
  });

  api.onMatchProgress((p) => {
    if (p.matchId && activeMatch && p.matchId !== activeMatch.matchId) return;
    if (p.status === "submitted") {
      const s = pendingScenarios.find((x) => x.id === p.scenarioId);
      if (s) {
        s.done = true;
        s.tier = p.verificationTier;
        s.uploading = false;
        s.failed = false;
        s.justDone = true;
        renderTodo();
      }
      // The clock only runs while nobody is playing, so a landed run restarts it.
      // Without this the countdown keeps draining toward a deadline the server has
      // already moved, and reads as though playing cost the player time.
      if (p.expiresAt) {
        if (activeMatch) activeMatch.expiresAt = p.expiresAt;
        startMatchClock(p.expiresAt);
      }

      if (p.remaining && p.remaining.length) {
        $("matchHint").textContent = p.remaining.length + " scenario" + (p.remaining.length === 1 ? "" : "s") + " left";
      } else {
        markAllIn();
      }
    } else if (p.status === "settle-failed") {
      // The runs are in and only the result is missing. Main retries on its own; the
      // button is for a player who would rather not wait for it.
      $("matchHint").textContent = "Your runs are in, but the result could not be fetched. " +
        (p.retrying ? "Retrying\u2026 " : "") + p.message;
      const retry = $("cancelMatchBtn");
      retry.disabled = false;
      retry.textContent = "Get result";
      retry.dataset.settle = "1";
    } else if (p.status === "failed") {
      const s = pendingScenarios.find(x => x.id === p.scenarioId);
      if (s) { s.uploading = false; s.failed = true; s.done = false; renderTodo(); }
      showError(`Could not submit that run: ${p.message} Play it again to count it.`);
    } else if (p.status === "already-submitted") {
      $("matchHint").textContent = p.message;
    }
  });

  api.onMatchSettled((settled) => {
    // Any settled match, an unopposed one included: that is what puts a player in
    // other people's duel lists, which is the point of the step.
    setSetupFlag("match");
    renderSetup();
    activeMatch = null;
    pendingMatchId = null;
    delete $("queueBtn").dataset.held;
    delete $("cancelMatchBtn").dataset.settle;
    refreshStanding();
    if (duelBoard) renderDuels(duelBoard);
    $("matchActions").hidden = true;
    $("opponent").classList.remove("on");
    resetCommit(current);
    renderEligibility();
    renderSettled(settled);
    if (settled && settled.tournament) void tnRefresh();
    // Only a loss sounds like one. A seeding set has a null verdict and fell through to
    // "defeat", so while the population is zero every player's first result - three runs
    // recorded, nothing lost - played the losing sting. A void or a first tournament leg
    // has no loser either.
    const verdict = settled ? settled.verdict : null;
    playSound(verdict === "win" ? "victory"
      : verdict === "draw" || verdict === "void" ? "draw"
      : verdict === "loss" ? "defeat" : "ok");

    // Jump to the result, because that is the payoff and nobody should have to hunt
    // for it after finishing three scenarios.
    document.querySelector('.tab[data-screen="result"]').click();
  });

  // Abandoning a contested match is a forfeit and costs a loss, so it asks first. A
  // seeding match has no opponent and costs nothing, so it does not.
  $("cancelMatchBtn").addEventListener("click", async () => {
    // After a failed settle the same button asks for the result instead of forfeiting.
    if ($("cancelMatchBtn").dataset.settle === "1") {
      const btn = $("cancelMatchBtn");
      btn.disabled = true;
      btn.textContent = "Getting result\u2026";
      const result = await api.settleMatch();
      if (result && result.error) {
        btn.disabled = false;
        btn.textContent = "Get result";
        $("matchHint").textContent = "Your runs are in, but the result could not be fetched. " + result.error;
      } else {
        delete btn.dataset.settle;
      }
      return;
    }
    const contested = activeMatch && !activeMatch.seeding && activeMatch.opponent;

    if (contested) {
      const name = activeMatch.opponent.displayName;
      const leg = activeMatch.tournament;
      const ok = window.confirm(leg
        ? `Forfeit ${leg.label} against ${name}?\n\nThe fixture goes to them. Nothing is rated.`
        : `Forfeit this match against ${name}?\n\n` +
          "Counts as a loss and lowers your rating. You can queue again right away.",
      );
      if (!ok) return;
    }

    const btn = $("cancelMatchBtn");
    btn.disabled = true;
    btn.textContent = "Ending…";

    try {
      const result = await api.cancelMatch();

      if (result && result.error) showError(result.error);
      else if (result && result.rated) {
        showError(null);
        showNotice(
          `Forfeited. ${result.ratingBefore} → ${result.ratingAfter} (${result.ratingChange})`,
        );
      } else if (result && result.message) {
        showError(null);
        showNotice(result.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Abandon match";
      // A countdown still ticking on a match that no longer exists is its own bug.
      stopMatchClock();
      $("matchClock").hidden = true;
      resetCommit(current);
      renderEligibility();
      $("opponent").classList.remove("on");
      activeMatch = null;
    }
  });

  // Writes the three scenarios into KovaaK's as a playlist, then starts the game.
  //
  // Two steps, not one, because KovaaK's registers no URL scheme: nothing can launch it
  // straight into a scenario, so the playlist has to be waiting on disk. The button says
  // what the player then has to do rather than pretending the game opened itself.
  $("playMatchBtn").addEventListener("click", async () => {
    const btn = $("playMatchBtn");

    // The shareable preview runs this same file with no main process behind it.
    if (HOST !== "electron" || !api.launchMatch) {
      $("matchHint").textContent =
        "Launching KovaaK's only works in the desktop app.";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Starting…";

    try {
      const result = await api.launchMatch();

      if (result && result.error) {
        showError(result.error);
        btn.textContent = "Play in KovaaK's";
        return;
      }

      // Point at the per-scenario buttons rather than the playlist. KovaaK's reads its
      // playlists folder only at startup, so if the game was already running the
      // playlist is on disk and not in the menu, and telling someone to go find it
      // there is telling them to go look for something that is not going to be there.
      $("matchHint").textContent = !result.launched
        ? `Playlist "${result.playlistName}" is ready, but Steam did not start the game. ` +
          "Launch KovaaK's yourself, or use the Play buttons above."
        : result.jumpedTo
          ? `Opening ${result.jumpedTo}. Use the Play buttons for the other two, ` +
            `or restart KovaaK's to get the "${result.playlistName}" playlist, which it ` +
            "only picks up at startup."
          : `In KovaaK's, open Playlists and pick "${result.playlistName}".`;

      // Back to an offer, not a state. Left reading "Opening KovaaK's" it looks stuck,
      // and pressing it again is a reasonable thing to want.
      btn.textContent = "Play in KovaaK's";
    } catch (err) {
      showError(String(err));
      btn.textContent = "Play in KovaaK's";
    } finally {
      // Re-enable regardless: writing again is harmless and is the obvious thing to try
      // if the game was already running when the playlist landed.
      btn.disabled = false;
    }
  });

  // ---- quests ------------------------------------------------------------
  api.onProgression(renderProgression);
  api.onQuestComplete(showCelebration);

  $("celebrateClose").addEventListener("click", nextCelebration);
  $('celebrate').addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); $('celebrateClose').focus(); }
  });

  // Escape dismisses, because a modal that traps you is worse than no modal.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("celebrate").hidden) nextCelebration();
  });

  // The button stays pressable while waiting: a closed tab or the wrong Steam account
  // used to mean three minutes of a disabled button. Pressing again restarts; Cancel stops.
  api.onSigningIn(({ signingIn }) => {
    const btn = $("btnSignIn");
    btn.disabled = false;
    btn.textContent = signingIn ? "Waiting for Steam \u00b7 click to restart" : "Sign in with Steam";
    if (!signingIn) $("signinHelp").hidden = true;
  });
  const cancelSignIn = $("signinCancel");
  if (cancelSignIn) cancelSignIn.addEventListener("click", () => void api.cancelSignIn());

  if (api.onNotice) {
    api.onNotice((message) => {
      if (message) showNotice(message, true);
      else if ($("banner").classList.contains("notice")) showError(null);
    });
  }

  // If the browser does not appear, the flow is still completable by hand. Showing the
  // link turns a dead end into an inconvenience.
  api.onSignInUrl(({ url }) => {
    const help = $("signinHelp");
    help.hidden = false;
    $("signinLink").textContent = url;
    $("signinLink").dataset.url = url;
  });

  /*
   * Report a problem: the diagnostics on the clipboard, then the issue page.
   *
   * The navigation is cancelled and re-issued rather than left to the anchor, because
   * the clipboard write needs this document focused and opening the browser first takes
   * that away - the copy then rejects with "Document is not focused" and the report
   * arrives with nothing attached, which is the failure this link exists to prevent.
   *
   * The page opens either way. A report without the build stamp is worth more than no
   * report, so a clipboard that refuses is not a reason to strand somebody here.
   */
  // The chip is a way back to the thing it is reporting on, from wherever you drifted to
  // while the queue ran.
  api.onDuels((board) => renderDuels(board));

  // Pushed by main after sign-in, after every action and after a leg settles. Null is a
  // sign-out, and somebody else's tournaments must not stay on screen for the next account.
  api.onTournaments((list) => {
    if (!list && tnOpenId) {
      tnOpenId = null;
      tnView = null;
      $("tnDetail").hidden = true;
      $("tnIndex").hidden = false;
    }
    if ($("tnIndex").hidden) {
      tnList = list;
      setTournamentCount(list);
    } else {
      renderTournaments(list);
    }
  });

  void api.tournaments().then((r) => renderTournaments(r && r.tournaments ? r.tournaments : null))
    .catch(() => renderTournaments(null));
  // The remembered screen may already be this one, restored before the listener above existed.
  if (document.body.dataset.screen === "tournaments") tnScreenShown(true);

  $("tnLive").addEventListener("click", () => {
    openScreen("tournaments");
    const mine = (tnList || []).find((t) => t.yourTurn);
    if (mine) tnOpen(mine.id);
  });

  // Opened in place. The picker is built on the way in rather than kept current, because
  // it is a list of everybody and most sessions never look at it.
  $("duelPickBtn").addEventListener("click", async () => {
    const roster = $("duelRoster");
    const opening = roster.hidden;
    roster.hidden = !opening;
    if (!opening) return;

    renderDuelCategories();
    renderRoster();
    // Re-read on open, so somebody who signed in five minutes ago sees whoever has played
    // since. The board is refreshed after every action anyway; this covers doing nothing.
    const r = await api.duels();
    if (r && r.board) {
      renderDuels(r.board);
      renderRoster();
    }
  });

  $("rosterFilter").addEventListener("input", renderRoster);

  $("setupHide").addEventListener("click", () => {
    setSetupFlag("hidden");
    renderSetup();
  });

  $("duelLive").addEventListener("click", () => {
    const tab = document.querySelector('.tab[data-screen="queue"]');
    if (tab) tab.click();
    const panel = $("duels");
    if (panel && !panel.hidden) panel.scrollIntoView({ block: "nearest" });
  });

  $("queueLive").addEventListener("click", () => {
    const tab = document.querySelector('.tab[data-screen="queue"]');
    if (tab) tab.click();
    const match = $("opponent");
    if (match && match.classList.contains("on")) {
      match.scrollIntoView({ block: "nearest" });
    }
  });

  $("reportProblem").addEventListener("click", async (event) => {
    event.preventDefault();
    const link = $("reportProblem");
    const url = link.href;
    let copied = false;
    try {
      const text = await api.diagnostics();
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Falls through to opening the page. Help > Copy diagnostics still works.
    }
    if (copied) {
      // Put back whatever it said, not the string this file was written with: the label
      // is overridable copy, and restoring a literal would quietly undo the override the
      // first time anybody used the link.
      const label = link.textContent;
      link.textContent = "Diagnostics copied";
      setTimeout(() => { link.textContent = label; }, 2400);
    }
    window.open(url, "_blank", "noreferrer");
  });
  $("reportProblem").dataset.wired = "1";

  $("signinCopy").addEventListener("click", async () => {
    const url = $("signinLink").dataset.url || "";
    try {
      await navigator.clipboard.writeText(url);
      $("signinCopy").textContent = "Copied";
    } catch {
      $("signinCopy").textContent = "Select and copy";
    }
    setTimeout(() => { $("signinCopy").textContent = "Copy link"; }, 1800);
  });

  api.onSnapshot((snapshot) => {
    showError(null);
    render(snapshot);
    setStatus("ok", "Watching", snapshot ? currentPath : "");
    // A new snapshot means a new run landed, which means a personal best on the practice
    // list may have moved. Re-read rather than leave it: the number this screen shows is
    // the same one the player just watched KovaaK's print.
    refreshPractice();

    // A match recovered on restart arrives before the first snapshot, so there was
    // nothing to paint it against when it did. This is the other half of that: if the
    // client is holding a match and the panel is not up, put it up now.
    if (activeMatch && !$("opponent").classList.contains("on")) paintActiveMatch();
  });

  // A saved season has to land on every screen that draws a rank, not just the editor.
  //
  // `render` repaints the ladders, the family rows and the weakness map off the snapshot;
  // the practice list and the apex board hold their own copy and have to be asked again.
  // Pulling state rather than waiting for `onSnapshot` is deliberate: on a machine with no
  // stats folder, or one whose folder holds no runs yet, no snapshot is ever sent and the
  // window would keep the old names until it was restarted.
  api.onSeasonChanged(() => {
    void api.getState().then((state) => {
      if (state.snapshot) render(state.snapshot);
    });
    refreshPractice();
  });

  api.onRun((run) => showRunToast(run));
  if (api.onBenchmarkPromotion) api.onBenchmarkPromotion(promotion => showCelebration({ promotion }));

  // The band page is drawn from the snapshot, so a run landing while it is open has to
  // redraw it. `render` does not, because the page is not part of the snapshot's own tree.
  api.onSnapshot(() => renderBand());

  api.onScanning(({ scanning }) => {
    setStatus(scanning ? "scanning" : "ok", scanning ? "Scanning…" : "Watching", currentPath);
    if (!scanning) paintFolderFound();
  });

  api.onError((message) => {
    showError(message);
    setStatus("bad", "Problem", currentPath);
  });

  var currentPath = "";
  api.getState().then((state) => {
    currentPath = state.statsDir || "";
    showBuild(state.build);
    renderSession(state.session, state.configured);
    // onSession was the only place this was shown, so a session restored before this
    // window subscribed, or a reload, left the upload panel hidden while signed in.
    $("uploadRow").hidden = !state.session;
    if (state.session) refreshEligibility();
    if (state.notice) showNotice(state.notice, true);
    if (!state.snapshot) document.body.classList.add("awaiting-data");
    if (state.match) {
      activeMatch = state.match;
      if (current) paintActiveMatch();
    }
    if (state.snapshot) {
      render(state.snapshot);
      setStatus("ok", "Watching", currentPath);
    } else {
      setStatus(state.lastError ? "bad" : "scanning", state.lastError ? "Problem" : "Scanning…", currentPath);
      if (state.lastError) {
        showError(state.lastError);
        paintFolderMissing();
      } else if (!state.scanning) paintFolderFound();
    }
  });
} else {
  // Static preview: the snapshot is inlined, and neither folder controls nor sign-in
  // apply without a main process behind them.
  //
  // The controls are removed rather than merely hidden. A disabled-looking button that
  // silently does nothing reads as a broken app, and a preview shared with someone else
  // gives them no way to know the difference.
  $("status").remove();
  const account = $("account");
  if (account) account.remove();

  const note = $("previewNote");
  if (note) note.hidden = false;

  render(window.__APOGEE_SNAPSHOT__);

  // The example tournaments, one per stage, built by the real engine with invented players.
  tnSamples = window.__APOGEE_TOURNAMENT__ || null;
  if (tnSamples) {
    $("tnPreviewNote").hidden = false;
    renderTournaments(Object.entries(tnSamples).map(([key, v]) => ({
      id: key,
      name: v.name,
      phase: v.phase,
      hostName: v.host.name,
      hostedByYou: v.host.you,
      entered: v.you.entered,
      entrants: v.entrants.length,
      checkedIn: v.entrants.filter((e) => e.checkedIn).length,
      capacity: v.capacity,
      category: v.category,
      windowName: v.windowName,
      groupCount: v.config.groupCount,
      groupSize: v.config.groupSize,
      qualifiers: v.config.qualifiers,
      championName: v.champion ? v.champion.name : null,
      yourTurn: Boolean(v.next && v.next.action !== "wait"),
      updatedAt: v.updatedAt,
    })));
  }
}

/* Pointer sounds are delegated once; arena.css owns interruptible press feedback. */

/** Everything that takes a press. `summary` is here because the status pill is one. */
const PRESSABLE = 'button, summary, [role="button"], .cat, .rank-link';

/**
 * Which sound a control makes.
 *
 * Tabs are excluded and handled at their own click listener: `openScreen`, the number
 * keys and the jump to the result screen all reach a tab through `.click()`, which fires
 * no pointer event, and a navigation that is silent by mouse-or-keyboard depending is
 * worse than one that is silent throughout.
 */
function pressSound(el) {
  if (el.classList.contains("tab")) return null;
  if (el.classList.contains("commit")) return "press";
  if (el.hasAttribute("aria-pressed")) {
    return el.getAttribute("aria-pressed") === "true" ? "toggleOff" : "toggleOn";
  }
  return "tap";
}

document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest && e.target.closest(PRESSABLE);
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;

    const sound = pressSound(el);
    if (sound) playSound(sound);
  },
  true,
);

/** Mute from the keyboard, because that is what somebody reaches for mid-match. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "m" && e.key !== "M") return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const target = e.target;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
    return;
  }
  setSound(!soundOn, true);
});

const soundToggle = $("soundToggle");
if (soundToggle) {
  soundToggle.addEventListener("click", () => setSound(!soundOn, true));
}

const volumeSlider = $('soundVolume');
if (volumeSlider) {
  volumeSlider.addEventListener('input', () => setSoundVolume(Number(volumeSlider.value) / 100));
  volumeSlider.value = String(Math.round(soundVolume * 100));
  $('soundVolumeReadout').textContent = Math.round(soundVolume * 100) + '%';
}
let lastSoundPreview = -Infinity;
document.querySelectorAll('[data-sound-preview]').forEach(button => {
  button.addEventListener('click', () => {
    if (performance.now() - lastSoundPreview < 1800) return;
    lastSoundPreview = performance.now();
    if (!soundOn) setSound(true, false);
    playSound(button.dataset.soundPreview);
  });
});
document.querySelectorAll('[data-arcade-route]').forEach(button => {
  button.addEventListener('click', () => openScreen(button.dataset.arcadeRoute));
});

/** The jump menu routes through the existing tabs, keeping all screen lifecycles intact. */
function mountArcadeCommand() {
  const dialog = $('arcadeCommand');
  const input = $('arcadeCommandSearch');
  const list = $('arcadeCommandList');
  if (!dialog || !input || !list) return;
  let opener = null;
  const descriptions = {
    mixtape: 'Build a practice playlist.',
    queue: 'Queue a ranked match.', seasonview: 'Season benchmarks and your next rank.',
    tournaments: 'Groups, brackets and fixtures.', result: 'Rounds and rating change from your last match.',
    profile: 'Category strengths and weak spots.', quests: 'Current quests.',
    scenarios: 'Search every scenario.', ranks: 'Rank thresholds and where you sit.',
    consistency: 'How steady your recent scores are.', admin: 'Local appearance and app settings.',
    season: 'Manage the season definition.'
  };
  function renderRoutes() {
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    document.querySelectorAll('.nav .tab').forEach(tab => {
      if (tab.hidden) return;
      const label = tab.querySelector('.tab-label')?.textContent || '';
      const description = descriptions[tab.dataset.screen] || '';
      if (query && !(label + ' ' + description).toLowerCase().includes(query)) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'arcade-command-route';
      button.innerHTML = '<span class="arcade-command-icon" aria-hidden="true">' + (tab.querySelector('svg')?.outerHTML || '') + '</span><span><strong>' + esc(label) + '</strong><small>' + esc(description) + '</small></span><span aria-hidden="true">↗</span>';
      button.addEventListener('click', () => {
        dialog.close();
        openScreen(tab.dataset.screen);
      });
      list.append(button);
    });
    $('arcadeCommandEmpty').hidden = list.childElementCount > 0;
  }
  function show() {
    if (dialog.open || !$('celebrate').hidden) return;
    opener = document.activeElement;
    input.value = '';
    renderRoutes();
    dialog.showModal();
    input.focus();
  }
  $('arcadeJump').addEventListener('click', show);
  $('arcadeCommandClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  input.addEventListener('input', renderRoutes);
  dialog.addEventListener('keydown', event => {
    const routes = [...list.querySelectorAll('button')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!routes.length) return;
      const index = routes.indexOf(document.activeElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : routes.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + routes.length) % routes.length;
      routes[next].focus();
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      routes[0]?.click();
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (dialog.open) dialog.close(); else show();
    }
  });
}
mountArcadeCommand();

// Reflect the stored preference on the control before anything can be heard, then let
// the rest of the app make noise.
setSound(soundOn, false);
soundReady = true;
