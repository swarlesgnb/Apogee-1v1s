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

/* ==================================================================== sound */

/**
 * Every sound the app makes, synthesized here rather than shipped as audio files.
 *
 * Three reasons it is an oscillator and not a folder of samples. The client already owes
 * nothing to any service being reachable at runtime, and keeping that true should not
 * start costing a megabyte of .wav on every build. The preview is one HTML file that has
 * to open anywhere, and tools/buildUiPreview.ts inlines exactly one script, so a sample
 * would have to be base64 encoded into it and would double the file. And a synthesized
 * press can be *tuned* per press: the pitch walks up while you keep clicking, which is
 * the whole point of `streakStep` below and is not a thing a fixed recording can do.
 *
 * Nothing is created until the first real gesture. An AudioContext constructed before
 * one starts suspended and stays suspended, and Chromium logs a warning about it on
 * every launch.
 */

const SOUND_KEY = "apogee.sound";

/**
 * Master level.
 *
 * Deliberately low. This plays all evening beside a game the player actually wants to
 * hear, so the ceiling is "noticed" rather than "loud" - every individual sound below is
 * mixed against this, not against full scale.
 */
const SOUND_GAIN = 0.42;

let ac = null;
let masterGain = null;
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
  masterGain = ac.createGain();
  masterGain.gain.value = SOUND_GAIN;
  masterGain.connect(ac.destination);
  return ac;
}

/** A quarter-second of white noise, made once and re-read by every transient. */
function noiseBuffer(ctx) {
  if (noiseBuf) return noiseBuf;
  const n = Math.floor(ctx.sampleRate * 0.25);
  noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/**
 * One oscillator, shaped.
 *
 * The envelope ramps to 0.0001 rather than to 0 because `exponentialRampToValueAtTime`
 * cannot reach zero: given it, the ramp is ignored and the gain stays where it was,
 * which is audible as a click on the tail of every note.
 *
 * `sweepTo` is most of what separates a sound that reads as a gesture from one that
 * reads as a beep: a fixed pitch is a menu, a pitch that moves is a thing happening.
 */
function voice(o) {
  const ctx = audio();
  if (!ctx) return;

  const t0 = ctx.currentTime + (o.delay || 0);
  const dur = o.dur || 0.12;
  const peak = o.gain == null ? 0.2 : o.gain;

  const osc = ctx.createOscillator();
  osc.type = o.type || "sine";
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.sweepTo) osc.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + dur);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack == null ? 0.004 : o.attack));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  let node = osc;
  if (o.filterHz) {
    const filter = ctx.createBiquadFilter();
    filter.type = o.filterType || "lowpass";
    filter.frequency.value = o.filterHz;
    if (o.q) filter.Q.value = o.q;
    node.connect(filter);
    node = filter;
  }

  node.connect(gain);
  gain.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/**
 * A burst of filtered noise - the transient half of a press.
 *
 * A tone on its own sounds like a notification. What makes a press sound like a switch
 * closing is the short broadband tick in front of the tone: bandpassed up high and given
 * about twenty milliseconds, it reads as the plastic rather than as static. Removing
 * this line is the single biggest downgrade available to the click below.
 */
function noise(o) {
  const ctx = audio();
  if (!ctx) return;

  const t0 = ctx.currentTime + (o.delay || 0);
  const dur = o.dur || 0.03;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);

  const filter = ctx.createBiquadFilter();
  filter.type = o.filterType || "bandpass";
  filter.frequency.setValueAtTime(o.filterHz || 1800, t0);
  if (o.sweepTo) filter.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + dur);
  filter.Q.value = o.q == null ? 1 : o.q;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(o.gain == null ? 0.12 : o.gain, t0 + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

const semitone = (base, n) => base * Math.pow(2, n / 12);

/**
 * The click climbs while you keep clicking.
 *
 * This is the one thing here that is not decoration. A control that answers with the
 * same sound every time is furniture within a minute; one that walks up a scale while
 * you keep pressing, and quietly resets once you stop, is the thing that makes a person
 * press it again to hear where it goes.
 *
 * The walk is a major pentatonic, so no two steps can sound sour against each other - a
 * chromatic climb hits intervals that read as a mistake, which is the opposite of
 * rewarding. It caps at the top of the array rather than climbing forever, because past
 * about two octaves a click stops being a click and becomes a whistle.
 */
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const STREAK_MS = 450;
let streak = 0;
// Not 0. `performance.now()` counts from when the page loaded, so a zero here reads as
// "pressed at load" and the first click of the session - any click inside the first
// 450ms - comes back already one step up the scale instead of at the root.
let lastPress = Number.NEGATIVE_INFINITY;

function streakStep() {
  const now = performance.now();
  streak = now - lastPress < STREAK_MS ? Math.min(streak + 1, PENTATONIC.length - 1) : 0;
  lastPress = now;
  return PENTATONIC[streak];
}

/**
 * The palette.
 *
 * Each entry is a whole sound rather than a note, because the interesting ones are two
 * or three voices a few milliseconds apart - that offset is what gives a fanfare its
 * shape and a press its body.
 */
const SOUNDS = {
  /** The everyday press. Transient, then a short body that falls slightly. */
  tap() {
    const n = streakStep();
    noise({ dur: 0.021, gain: 0.13, filterHz: semitone(2200, n), q: 1.2 });
    voice({
      freq: semitone(440, n), sweepTo: semitone(360, n),
      type: "triangle", dur: 0.07, gain: 0.13, filterHz: 2600,
    });
  },

  /** The big commitment - Find opponent. The same shape an octave down, and heavier. */
  press() {
    noise({ dur: 0.03, gain: 0.16, filterHz: 1500, q: 0.9 });
    voice({ freq: 220, sweepTo: 150, type: "triangle", dur: 0.16, gain: 0.2, filterHz: 1800 });
    voice({ freq: 660, sweepTo: 560, type: "sine", dur: 0.1, gain: 0.07, delay: 0.012 });
  },

  /** Under the pointer. Nearly subliminal on purpose - it is felt, not heard. */
  hover() {
    voice({ freq: 2600, type: "sine", dur: 0.022, gain: 0.022 });
  },

  /** Moving between screens. A short filtered sweep, not a note. */
  nav() {
    noise({ dur: 0.16, gain: 0.05, filterHz: 500, sweepTo: 2600, q: 0.7 });
    voice({ freq: 520, sweepTo: 780, type: "sine", dur: 0.11, gain: 0.05 });
  },

  toggleOn() {
    voice({ freq: 620, type: "triangle", dur: 0.06, gain: 0.11 });
    voice({ freq: 930, type: "triangle", dur: 0.09, gain: 0.1, delay: 0.05 });
  },

  toggleOff() {
    voice({ freq: 930, type: "triangle", dur: 0.06, gain: 0.1 });
    voice({ freq: 620, type: "triangle", dur: 0.09, gain: 0.09, delay: 0.05 });
  },

  /** Something worked. Three notes of a major triad, fast enough to read as one event. */
  ok() {
    voice({ freq: 660, type: "sine", dur: 0.09, gain: 0.11 });
    voice({ freq: 880, type: "sine", dur: 0.09, gain: 0.11, delay: 0.055 });
    voice({ freq: 1320, type: "sine", dur: 0.14, gain: 0.09, delay: 0.11 });
  },

  /**
   * Something failed.
   *
   * Low, lowpassed and slightly detuned against itself. Deliberately not a buzzer: this
   * fires on a failed upload while somebody is mid-session, and a harsh sound there
   * punishes the player for the network's problem.
   */
  error() {
    voice({ freq: 170, sweepTo: 120, type: "sawtooth", dur: 0.22, gain: 0.1, filterHz: 700 });
    voice({ freq: 174, sweepTo: 123, type: "sawtooth", dur: 0.22, gain: 0.08, filterHz: 700 });
  },

  /** A run landed in the stats folder. Bell-like, because it is good news arriving. */
  run() {
    voice({ freq: 1180, type: "sine", dur: 0.16, gain: 0.1 });
    voice({ freq: 1770, type: "sine", dur: 0.22, gain: 0.05, delay: 0.02 });
    voice({ freq: 2360, type: "sine", dur: 0.3, gain: 0.025, delay: 0.04 });
  },

  /** A quest completed or a floor raised. The one place a real fanfare is earned. */
  celebrate() {
    [523, 659, 784, 1047].forEach((f, i) => {
      voice({ freq: f, type: "triangle", dur: 0.34, gain: 0.11, delay: i * 0.075 });
      voice({ freq: f * 2, type: "sine", dur: 0.28, gain: 0.035, delay: i * 0.075 + 0.01 });
    });
    voice({ freq: 1568, type: "sine", dur: 0.7, gain: 0.05, delay: 0.31 });
    noise({ dur: 0.5, gain: 0.03, filterHz: 3000, sweepTo: 8000, q: 0.5, delay: 0.3 });
  },

  /** An opponent was found. A riser, because something is about to start. */
  matchFound() {
    noise({ dur: 0.34, gain: 0.06, filterHz: 400, sweepTo: 4200, q: 0.6 });
    voice({ freq: 300, sweepTo: 900, type: "triangle", dur: 0.34, gain: 0.1 });
    voice({ freq: 900, type: "sine", dur: 0.18, gain: 0.11, delay: 0.34 });
    voice({ freq: 1200, type: "sine", dur: 0.24, gain: 0.09, delay: 0.42 });
  },

  victory() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => {
      voice({ freq: f, type: "triangle", dur: 0.4, gain: 0.12, delay: i * 0.09 });
    });
    voice({ freq: 2093, type: "sine", dur: 0.9, gain: 0.05, delay: 0.42 });
    noise({ dur: 0.6, gain: 0.035, filterHz: 2500, sweepTo: 9000, q: 0.5, delay: 0.4 });
  },

  /** Soft on purpose. Losing already feels bad; the app does not need to press on it. */
  defeat() {
    [440, 370, 294].forEach((f, i) => {
      voice({ freq: f, type: "sine", dur: 0.36, gain: 0.09, delay: i * 0.13 });
    });
  },
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
  const btn = $("soundToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Sound on — mute (M)" : "Muted — unmute (M)";
  }
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch (err) {
    /* a preference that cannot be stored still applies to this session */
  }
  // Confirm unmuting by being audible. Muting confirms itself by going quiet.
  if (on && announce) playSound("toggleOn");
}


/**
 * The colour of a rank, looked up on the ladder that graded it.
 *
 * Clicking, Tracking and Switching each name and colour their own ranks, so the overall
 * ladder's palette has no entry for "D" or "Neanderthal": looking a category rank up
 * there returned undefined and every one of them rendered grey. `cat` is the category
 * object from the snapshot, which now carries its own ladder; omit it for a rank that
 * genuinely belongs to the overall ladder, like the consistency ceiling and floor.
 */
function rankColor(data, rankName, cat) {
  if (!rankName) return "var(--ink-dim)";
  return (
    (cat && cat.rankColors && cat.rankColors[rankName]) ||
    data.benchmark.rankColors[rankName] ||
    "#8891a3"
  );
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

/**
 * A faceted emblem rather than a plain disc: rank badges are read at a glance and at
 * small sizes, so the silhouette has to carry identity before the colour does.
 */
function badge(tier, uid) {
  const g = "g" + uid;
  const f = "f" + uid;
  return (
    '<svg viewBox="0 0 60 68" role="img" aria-label="' + esc(tier.name) + '">' +
    '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0.35" y2="1">' +
    '<stop offset="0" stop-color="' + esc(tier.gradient[1]) + '"/>' +
    '<stop offset="1" stop-color="' + esc(tier.gradient[0]) + '"/></linearGradient>' +
    '<filter id="' + f + '" x="-60%" y="-60%" width="220%" height="220%">' +
    '<feDropShadow dx="0" dy="0" stdDeviation="3.2" flood-color="' + esc(tier.glow) +
    '" flood-opacity="0.85"/></filter></defs>' +
    '<path d="M30 1.5 56.5 15v27.5L30 66.5 3.5 42.5V15z" fill="url(#' + g +
    ')" filter="url(#' + f + ')"/>' +
    '<path d="M30 1.5 56.5 15v27.5L30 66.5 3.5 42.5V15z" fill="none" stroke="' +
    esc(tier.glow) + '" stroke-opacity=".5" stroke-width="1.1"/>' +
    '<path d="M30 12 46 20.5v20L30 55 14 40.5v-20z" fill="none" stroke="#fff" ' +
    'stroke-opacity=".22" stroke-width="1.3"/></svg>'
  );
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
  banner.classList.add("on");
  playSound("error");
}

/** The same banner, for something that worked. */
function showNotice(message) {
  const banner = $("banner");
  banner.textContent = message;
  banner.classList.add("on", "notice");
  playSound("ok");
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

function render(data) {
  current = data;
  $("app").hidden = false;
  $("empty").hidden = true;
  $("whoami").hidden = false;

  const me = data.player.apogee;

  // The whole chrome takes the player's rank colour: nav selection, the glow behind the
  // badge, focus rings, the queue button's shadow. The alternative is a brand accent
  // sitting next to the rank colour and competing with the one signal that means
  // something here.
  document.documentElement.style.setProperty("--accent", me.tier.color);

  $("myBadge").innerHTML = badge(me.tier, "me");
  $("myTier").textContent = me.tier.name;
  $("myTier").style.color = me.tier.color;
  $("myRating").textContent = me.rating + " ±" + me.rd;
  $("myStreak").textContent = data.player.streak + "-day streak";

  $("heroBadge").innerHTML = badge(me.tier, "hero");
  $("heroName").textContent = me.tier.name;
  $("heroName").style.color = me.tier.color;

  // Three separate facts, so they read as three. Run together on one line they were a
  // caption, and nobody reads a caption under a 34px tier name.
  $("heroRating").textContent = me.rating;
  $("heroRd").textContent = "±" + me.rd + " uncertainty";
  $("heroPercentile").textContent = "top " + (100 - me.percentile).toFixed(1) + "%";
  $("heroRuns").textContent = num(data.player.totalRuns);
  $("heroScenarios").textContent = "across " + data.player.scenarioCount + " scenarios";
  $("heroPlacement").textContent =
    "Placement is provisional: with no live population yet, your tier is estimated " +
    "from your " + data.benchmark.name + " " + data.benchmark.difficulty + " standing (" +
    data.player.benchmarkRank + ", " + num(data.player.benchmarkEnergy) + " energy).";

  renderCategories(data);
  renderPool(data);

  // The snapshot carries an illustrative match with an invented opponent, which is
  // useful in the preview and dishonest in the real client. In the app it is shown only
  // until a genuine result exists, and is replaced by an empty state instead.
  if (HOST === "electron" && !hasRealResult) renderNoResultYet();
  else if (HOST !== "electron") renderResult(data);

  renderRanks(data);
  renderSeasonView(data);
  renderProfile(data);
  renderCoverage(data);
  renderConsistency(data);
  renderQuests(data);

  $("footnote").textContent =
    (HOST === "electron"
      ? "Live from your KovaaK's stats folder. "
      : "Static preview. ") +
    "Every number here is computed from " + num(data.player.totalRuns) +
    " real runs; the opponent is synthetic. Snapshot " +
    new Date(data.generatedAt).toLocaleString() + ".";
}

/**
 * Which difficulty a match draws from, and whether the player is measured on it.
 *
 * A match is decided on delta against your own baseline, so a difficulty with no history
 * behind it cannot be graded: half rating weight at best, void at worst. With several
 * difficulties in a season, nothing on screen said which one the player was about to be
 * handed.
 */
function renderPool(data) {
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
      `Matches draw from <b>${esc(name)}</b>. You have baselines on ` +
      `${measured} of ${total} of its scenarios, so your scores are what you will be ` +
      `measured against.`;
    return;
  }

  note.className = "pool-note warn";
  note.innerHTML =
    `Matches draw from <b>${esc(name)}</b>, and you have baselines on only ` +
    `${measured} of ${total} of its scenarios` +
    `${short.length < relevant.length ? ` (short in ${esc(short.map((c) => c.category).join(", "))})` : ""}. ` +
    `A scenario with no baseline is scored against a guess, which halves what the match ` +
    `is worth and can void it. Play a few runs of them first.`;
}

function renderCategories(data) {
  const host = $("cats");
  host.textContent = "";
  if (selectedCategory === null) selectedCategory = data.weakest;

  ["Any"].concat(data.categories.map((c) => c.name)).forEach((name) => {
    const b = document.createElement("button");
    b.className = "cat";
    b.type = "button";
    b.textContent = name === data.weakest ? name + " · weakest" : name;
    b.setAttribute("aria-pressed", String(name === selectedCategory));
    b.addEventListener("click", () => {
      selectedCategory = name;
      renderPool(data);
      Array.prototype.forEach.call(host.children, (c) =>
        c.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      $("opponent").classList.remove("on");
      $("queueBtn").disabled = false;
      $("queueBtn").textContent = "Find opponent";
      renderEligibility();
    });
    host.append(b);
  });
}

function showOpponent(data) {
  const m = data.match;
  const me = data.player.apogee;

  $("oppBadge").innerHTML = badge(m.opponent.tier, "opp");
  $("oppName").textContent = m.opponent.name;
  $("oppTier").textContent = m.opponent.tier.name + " · " + m.opponent.rating;
  $("oppTier").style.color = m.opponent.tier.color;
  $("oppAge").textContent = "stored run · 3 days ago";

  const p = m.winProbability;
  $("oddsBar").innerHTML =
    '<div style="flex:' + p + ';background:' + esc(me.tier.color) + '"></div>' +
    '<div style="flex:' + (1 - p) + ';background:' + esc(m.opponent.tier.color) + '"></div>';
  $("oddsYou").textContent = "you " + (p * 100).toFixed(0) + "%";
  $("oddsThem").textContent = (100 - p * 100).toFixed(0) + "% " + m.opponent.name;

  pendingScenarios = m.rounds.map((r) => ({ label: r.label, done: false }));
  renderTodo();

  $("opponent").classList.add("on");
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
  return seasonDraft.scenarios
    .filter(isEmptySlot)
    .map((x) => `${x.family ?? "?"} · ${windowLabel(x.window ?? 0)}`);
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
 * identical. Both grounds and the threshold are the same values; if one moves, move both.
 *
 * It is worth the duplication: a colour that disappears is invisible to the person
 * choosing it, because the editor's own background is neither of the grounds it has to
 * survive, and finding out from a generated sheet after the fact is finding out too late.
 */
const DARK_GROUND = "#06080c";
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
    if (e.key === "Enter") commit();
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
      rankMaxes: Array.from({ length: size > 0 ? size : 1 }, (_, i) => i + 1),
    });
  }

  rebalanceEnergy(category);
}

/** Remove a family and every variant of it. Single variants are never removed alone. */
function removeFamily(category, family) {
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

  cat.rankMaxes = cat.rankNames.map((_, i) => families * 2500 * (i + 1));
}

/**
 * Add a difficulty: a window of ranks on every category, and a slot on every family.
 *
 * The ladder and the pool move together or not at all. Adding the ranks without the
 * scenarios makes them unreachable; adding the scenarios without the ranks makes them
 * ungraded. Both halves happen here, once.
 */
function addWindow(name) {
  const size = seasonWindowSize();
  if (size <= 0) return;

  seasonDraft.windows = (seasonDraft.windows ?? []).concat(name);
  const window = seasonDraft.windows.length - 1;

  // A window needs percentiles as much as it needs ranks and scenarios.
  //
  // Without them every slot in the new difficulty refuses to fill - "this season has no
  // percentile ladder to derive from" - because thresholds are derived from a percentile
  // and there is none for a window nobody gave one. The ladder and the pool moved together
  // here from the start; the percentiles were the third thing and were left behind.
  //
  // The new window reuses the percentiles of the one below it, not smaller ones.
  //
  // Percentiles are percentiles of a *board*, and a new window means harder scenarios,
  // which means a different and stronger population. "Top 8%" of an Advanced board is a
  // far higher bar than "top 8%" of an Easy one, so the same numbers on a harder board
  // already describe a harder rank - that is the whole mechanism the windows run on.
  //
  // Continuing to shrink them instead was wrong and the arithmetic said so: carrying on
  // from a window that closes at 0.1% produced 0.11%, 0.05%, 0.05%, 0.05% - three ranks
  // pinned to the floor and no longer descending. There is no room above one in a
  // thousand; the room is on the next board along.
  seasonDraft.derivedFrom ??= {};
  const ladders = (seasonDraft.derivedFrom.perWindow ??= []);
  const below = ladders[window - 1];

  ladders[window] =
    below && below.length === size
      ? below.slice()
      : Array.from({ length: size }, (_, i) => Number((0.5 / 2 ** i).toFixed(4)));

  for (const cat of seasonDraft.categories) {
    for (let i = 0; i < size; i++) {
      let rank = `${name} ${i + 1}`;
      while (cat.rankNames.includes(rank)) rank += "*";
      cat.rankNames.push(rank);
      cat.rankColors[rank] = "#8891a3";
    }
    // Derived from the family count rather than extrapolated from the last gap, which is
    // how a ladder ends up with ranks nobody can reach.
    rebalanceEnergy(cat.name);
  }

  const families = [];
  for (const x of seasonDraft.scenarios) {
    const key = `${x.category}/${x.family}`;
    if (!families.some((f) => `${f.category}/${f.family}` === key)) {
      families.push({ category: x.category, family: x.family });
    }
  }

  for (const f of families) {
    seasonDraft.scenarios.push({
      scenario: "",
      category: f.category,
      family: f.family,
      window,
      label: f.family,
      leaderboardId: null,
      rankMaxes: Array.from({ length: size }, (_, i) => i + 1),
    });
  }
}

/** Remove the top difficulty, with the ranks it graded and the slots that filled it. */
function removeWindow() {
  const size = seasonWindowSize();
  const windows = (seasonDraft.windows ?? []).length;
  if (size <= 0 || windows <= 1) return;

  const window = windows - 1;
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
  }
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

function stashDraft() {
  if (!seasonDraft) return;
  try {
    localStorage.setItem(SEASON_DRAFT_KEY, JSON.stringify(seasonDraft));
  } catch {
    // A draft too large to stash is still a working draft; losing the safety net is not
    // worth interrupting the edit for.
  }
}

function clearStashedDraft() {
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
  // An unfilled slot is not a validation failure to discover on Save - it is visible work
  // in progress, and the gate says what is left rather than what is wrong.
  const gaps = seasonGaps();
  const orphans = seasonOrphans();

  $("seasonSave").disabled = !dirty || gaps.length > 0 || orphans.length > 0;
  $("seasonReload").disabled = !dirty;

  const purge = $("seasonPurge");
  if (purge) {
    purge.hidden = orphans.length === 0;
    purge.textContent =
      orphans.length === 1
        ? `Remove 1 entry the season cannot grade`
        : `Remove ${orphans.length} entries the season cannot grade`;
  }

  if (orphans.length > 0) {
    stashDraft();
    setSeasonStatus(
      `${orphans.map((o) => o.scenario || "(unnamed)").slice(0, 3).join(", ")}` +
        (orphans.length > 3 ? ` and ${orphans.length - 3} more` : "") +
        " have no family or difficulty, so nothing can grade them",
      "bad",
    );
    return;
  }

  if (gaps.length > 0) {
    stashDraft();
    setSeasonStatus(
      `${gaps.length} slot${gaps.length === 1 ? "" : "s"} still to fill: ` +
        gaps.slice(0, 4).join(", ") +
        (gaps.length > 4 ? `, and ${gaps.length - 4} more` : ""),
      "bad",
    );
    return;
  }

  if (dirty) {
    stashDraft();
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

  seasonDraft = result.season;

  // An unsaved draft from a previous session wins over what is on disk, because it is the
  // newer of the two and the only copy of that work. Discard puts the saved season back.
  const stashed = stashedDraft();
  const restored = stashed && JSON.stringify(stashed) !== JSON.stringify(result.season);
  if (restored) seasonDraft = stashed;

  $("seasonNote").textContent = `${seasonDraft.name} · ${result.path}`;

  // The table is drawn twice on purpose. The first paint is the season, which is already
  // in hand; the second follows the picker, which is what carries where each scenario is
  // published and how big its board is. Drawing once and waiting would leave the screen
  // blank on the slow half of the load, and drawing once without waiting would leave every
  // source cell reading "—" until something else happened to redraw.
  renderSeasonEditor();
  await loadSeasonPicker();
  renderSeasonEditor();

  if (restored) {
    seasonDirty(true);
    setSeasonStatus("restored unsaved changes from your last session", "");
  } else {
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

  const matches = needle
    ? seasonAvailable.filter((s) => s.name.toLowerCase().includes(needle))
    : seasonAvailable;

  pick.innerHTML = '<option value="">Add a scenario…</option>';

  matches.slice(0, SEASON_PICK_LIMIT).forEach((s) => {
    const opt = document.createElement("option");
    // Indexed against the full list, so filtering never changes what a value means.
    opt.value = String(seasonAvailable.indexOf(s));
    opt.textContent =
      s.name + (s.runs > 0 ? `  ·  ${s.runs} runs, best ${num(s.best)}` : "  ·  no history");
    pick.append(opt);
  });

  $("seasonAdd").disabled = true;
  $("seasonAddNote").textContent =
    matches.length > SEASON_PICK_LIMIT
      ? `showing ${SEASON_PICK_LIMIT} of ${matches.length} — narrow the search`
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

  const ladders = s.categories
    .map((c) => ({ title: c.name, owner: c, isCategory: true }))
    .concat([{ title: "Overall", owner: s, isCategory: false }]);

  const size = seasonWindowSize();

  ladders.forEach(({ title, owner, isCategory }) => {
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
      text.addEventListener("input", () => {
        const previous = owner.rankNames[i];
        owner.rankNames[i] = text.value;
        // Colours are keyed by name, so a rename has to carry its colour across or the
        // rank silently loses it.
        if (owner.rankColors[previous] !== undefined) {
          owner.rankColors[text.value] = owner.rankColors[previous];
          delete owner.rankColors[previous];
        }
        seasonDirty(true);
      });

      const colour = document.createElement("input");
      colour.type = "color";
      colour.value = owner.rankColors[name] ?? "#8891a3";

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
        seasonDirty(true);
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
        removeWindow();
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
        addWindow(name);
        renderSeasonEditor();
        seasonDirty(true);
      });
    });
    tools.append(add);
    group.append(tools);

    ranks.append(group);

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
  // screen is six scenarios against the four ranks of one window. The whole ladder is
  // still editable; it is just not all editable at once, which is the difference between
  // a table you can work in and one you can only stare at.
  const head = $("seasonHead");
  head.innerHTML = "";

  const body = $("seasonBody");
  body.textContent = "";

  s.categories.forEach((cat) => {
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
          const taken = s.scenarios.some((x) => x.category === cat.name && x.family === name);
          if (taken) {
            setSeasonStatus(`${cat.name} already has a family called ${name}`, "bad");
            return;
          }
          addFamily(cat.name, name);
          renderSeasonEditor();
          seasonDirty(true);
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
        ? ` — rank ${wrong + 1} asks for the top ${(every[wrong] * 100).toFixed(1)}%, ` +
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
        : `${num(option.entries)} on the board${option.entries < MIN_BOARD ? " — thin" : ""}`;

    opt.label = !option.leaderboardId
      ? "no leaderboard - cannot derive thresholds"
      : [where, board, option.runs > 0 ? `${option.runs} runs here` : null]
          .filter(Boolean)
          .join("  ·  ");
    list.append(opt);
  }

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

  input.addEventListener("change", () => {
    refresh();
    if (!add.disabled) fill();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    refresh();
    if (!add.disabled) fill();
  });

  // Typing searches KovaaK's itself, not only the few hundred names some committed file
  // happens to mention. Debounced so a word costs one request rather than one per letter,
  // and merged into the same datalist so local and remote results read as one list.
  let searchTimer = null;
  const remote = new Map();

  input.addEventListener("input", () => {
    const term = input.value.trim();
    refresh();
    if (searchTimer) clearTimeout(searchTimer);
    if (term.length < 2 || remote.has(term)) return;

    searchTimer = setTimeout(async () => {
      const found = await window.apogee.searchScenarios(term);
      if (!found || found.error || !found.scenarios) return;
      remote.set(term, true);

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
    }, 350);
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
const idLookups = new Set();

async function findLeaderboardId(option, refresh, status) {
  if (idLookups.has(option.name)) return;
  idLookups.add(option.name);

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
    best.textContent = scenario.corpus ? num(scenario.corpus.best) : "—";
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
let seasonPool = null;

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

function renderSeasonView(data) {
  const me = data.player.apogee;
  const tiers = Array.isArray(data.theme) ? data.theme : [];
  const windows = data.benchmark.windows ?? [];
  const size = data.benchmark.windowSize ?? 4;

  // ---- what this season is ----
  const stats = $("svStats");
  if (stats) {
    stats.textContent = "";
    const pool = seasonPool && Array.isArray(seasonPool.scenarios) ? seasonPool.scenarios : null;
    const families = pool ? new Set(pool.map((x) => x.family)).size : null;
    const cells = [
      [pool ? num(pool.length) : "\u2014", "scenarios"],
      [families === null ? "\u2014" : String(families), "families"],
      [String(windows.length || "\u2014"), "difficulty windows"],
      [String(data.categories.length), "categories"],
      [windows[seasonPool ? (seasonPool.matchPool?.window ?? 1) : 1] ?? "\u2014", "matches draw from"],
    ];
    cells.forEach(([v, k]) => {
      const el = document.createElement("div");
      el.className = "sv-stat";
      el.innerHTML = '<span class="v">' + esc(String(v)) + '</span>' +
                     '<span class="k">' + esc(k) + '</span>';
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
      const g = Array.isArray(tier.gradient) ? tier.gradient : [tier.color, tier.color];
      const el = document.createElement("div");
      el.className = "sv-tier" + (here ? " here" : "");
      el.style.setProperty("--tier", tier.color);
      el.style.setProperty("--glow", tier.glow ?? tier.color);
      el.style.setProperty("--g1", g[0]);
      el.style.setProperty("--g2", g[1] ?? g[0]);
      el.innerHTML =
        '<span class="swatch"></span>' +
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
    const colorOf = (n) => (cat.rankColors && cat.rankColors[n]) || "var(--ink-dim)";
    const here = names.indexOf(cat.rankName); // -1 when unranked

    const box = document.createElement("div");
    box.className = "sv-cat";

    const head = document.createElement("div");
    head.className = "sv-cat-head";
    head.innerHTML =
      '<span class="sv-cat-name">' + esc(cat.name) + '</span>' +
      '<span class="sv-cat-now" style="color:' + esc(colorOf(cat.rankName)) + '">' +
      esc(cat.rankName || "unranked") + ' \u00b7 ' + num(cat.energy) + ' energy</span>';
    box.append(head);

    // The whole ladder as one bar, lit to where they stand.
    const rail = document.createElement("div");
    rail.className = "sv-rail";
    names.forEach((n, i) => {
      const seg = document.createElement("span");
      if (i <= here) seg.style.background = colorOf(n);
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
        cell.style.setProperty("--rank", colorOf(n));
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
  const dueIn = bands.map((_, w) => rows.filter((r) => r.window === w && r.isNext).length);

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
      const inBand = rows.filter((r) => r.window === w);
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

  const shown = rows.filter((r) => r.window === seasonBand);
  if ($("svPoolNote")) {
    const played = shown.filter((r) => r.runs > 0).length;
    $("svPoolNote").textContent =
      num(shown.length) + " scenarios · " + num(played) + " played";
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
      '<span class="rk"' + (colour ? ' style="--rank:' + esc(colour) + '"' : "") + ">" +
      esc((standing && standing.rankName) || "unranked") +
      "</span>";
    block.append(head);

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
      const maxed = inSub.filter((r) => r.nextRankScore === null).length;
      subHead.innerHTML =
        '<span class="pool-sub-name">' + esc(sub) + "</span>" +
        '<span class="pool-sub-note">' +
        (maxed === inSub.length
          ? "maxed here"
          : inSub.filter((r) => r.runs > 0).length + " of " + inSub.length + " played") +
        "</span>";
      group.append(subHead);

      inSub.forEach((v) => {
        const maxedHere = v.nextRankScore === null;

        // Progress through the current rank step is the row's own ground rather than a
        // bar in a column of its own, coloured with the rank being climbed toward so the
        // fill and the ladder read as the same thing.
        const row = document.createElement("div");
        row.className =
          "pool-row" +
          (v.isNext ? " next" : "") +
          (maxedHere ? " done" : "") +
          (v.runs === 0 ? " untouched" : "");
        if (colour) row.style.setProperty("--rank", colour);
        row.style.setProperty("--fill", (maxedHere ? 1 : (v.progress ?? 0)) * 100 + "%");

        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = v.label;
        // The three facts the row no longer spends a column on, on the one element
        // wide enough to be an easy hover target.
        nm.title =
          v.scenario +
          " · " +
          (v.runs === 1 ? "1 run" : num(v.runs) + " runs") +
          " · " +
          (maxedHere
            ? "every rank this scenario can prove"
            : Math.round((v.progress ?? 0) * 100) + "% of the way to the next rank");

        // Best and target read as one line - what you have, what the rank wants.
        const nums = document.createElement("span");
        nums.className = "pool-num";

        const pb = document.createElement("span");
        pb.className = "pb" + (v.best === null ? " none" : "");
        pb.textContent = v.best === null ? "unplayed" : num(v.best);

        const to = document.createElement("span");
        to.className = "to";
        to.textContent = maxedHere ? "" : "→";

        const tgt = document.createElement("span");
        tgt.className = "tgt" + (maxedHere ? " max" : "");
        tgt.textContent = maxedHere ? "maxed" : num(v.nextRankScore);
        if (!maxedHere && v.best !== null) tgt.title = num(v.gap || 0) + " to go";

        nums.append(pb, to, tgt);
        row.append(nm, nums);

        if (HOST === "electron" && api && api.launchScenario) {
          const play = document.createElement("button");
          play.type = "button";
          play.className = "scen-play";
          play.textContent = "Play";
          play.title = "Open " + v.scenario + " in KovaaK's";
          play.addEventListener("click", async () => {
            play.disabled = true;
            const prev = play.textContent;
            play.textContent = "…";
            try {
              const r = await api.launchScenario(v.scenario);
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
          row.append(play);
        } else {
          row.append(document.createElement("span"));
        }

        group.append(row);
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
 * band gets run back to back. There is one per category per band - Clicking, Tracking and
 * Switching separately - plus one of everything at that band, and each is installable on
 * its own because an evening of tracking should not require writing twelve files for
 * skills you are not practising.
 *
 * KovaaK's reads playlists at startup, so the restart caveat is printed rather than left
 * to be discovered: a playlist that is genuinely on disk and genuinely not in the menu
 * looks exactly like the app having failed.
 */
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
  if (title) title.textContent = "Playlists · " + (bands[band] || "");

  const note = $("svInstallNote");
  if (note && !note.dataset.done) {
    note.textContent =
      "Written into KovaaK's own Playlists folder. Restart the game to see them.";
  }

  const chips = $("svChips");
  if (!chips) return;
  chips.textContent = "";

  const install = async (btn, names, label) => {
    btn.disabled = true;
    const prev = btn.innerHTML;
    btn.textContent = "Writing…";
    try {
      const r = await api.installPlaylists(names);
      if (r && r.error) {
        showError(r.error);
        btn.innerHTML = prev;
      } else {
        btn.textContent = "Installed";
        practice.installed = r.installed;
        if (note) {
          note.dataset.done = "1";
          note.textContent = r.dir + " · " + r.note;
        }
        setTimeout(() => {
          btn.innerHTML = prev;
          btn.disabled = false;
        }, 1600);
        return;
      }
    } finally {
      btn.disabled = false;
    }
  };

  for (const list of here) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pool-chip" + (list.category === null ? " all" : "");
    chip.innerHTML =
      esc(list.category || "Everything") +
      '<span class="n">' + list.scenarios + "</span>";
    chip.title = "Write “" + list.name + "” into KovaaK's";
    chip.addEventListener("click", () => install(chip, [list.name]));
    chips.append(chip);
  }

  const all = document.createElement("button");
  all.type = "button";
  all.className = "pool-chip all";
  all.innerHTML =
    "All bands" + '<span class="n">' + (practice.playlists || []).length + "</span>";
  all.title = "Write every playlist this season implies";
  all.addEventListener("click", () => install(all, null));
  chips.append(all);
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
    "Where you sit against everyone else playing. Tiers are population percentiles, " +
    "so a tier keeps its meaning as the ladder grows rather than inflating.";

  const ladder = $("ladder");
  ladder.textContent = "";

  // Highest tier first: a ladder reads top-down, and the top is what people are
  // climbing toward.
  [...tiers].reverse().forEach((tier) => {
    const here = tier.id === me.tier.id;
    const li = document.createElement("li");
    li.className = here ? "here" : "";
    li.style.setProperty("--tier", tier.color);
    li.innerHTML =
      '<span class="rung">' + (tiers.indexOf(tier) + 1) + "</span>" +
      '<span class="tier-name">' + esc(tier.name) + "</span>" +
      (here
        ? '<span class="you">you · top ' + (100 - me.percentile).toFixed(1) + "%</span>"
        : '<span class="band">' + esc(tierBand(tier.percentile)) + "</span>");
    ladder.append(li);
  });

  // ---- benchmark standing, per category ----
  const bench = data.benchmark;
  $("benchNote").textContent = `${bench.name} ${bench.difficulty}`;
  $("benchLede").textContent =
    `Your ${bench.name} standing, which is a stat rather than a ladder position: it ` +
    "says what your scores are worth, not who you beat. Overall you are " +
    `${data.player.benchmarkRank} at ${num(data.player.benchmarkEnergy)} energy.`;

  const host = $("catRanks");
  host.textContent = "";

  // One twelve-rank ladder per category, cut into its windows.
  //
  // This used to be a single bar of six coloured segments, which was right when a category
  // had four ranks and one set of scenarios. With twelve ranks across three difficulties
  // the useful questions changed: how far up am I, which difficulty am I being graded in,
  // and what does the next rank cost - on which scenario, since every fourth rank is graded
  // by a harder one than the rank below it.
  data.categories.forEach((cat) => {
    const size = data.benchmark.windowSize ?? cat.rankNames.length;
    const windows = data.benchmark.windows ?? [];
    const depth = cat.rankNames.length;
    const here = cat.rankNames.indexOf(cat.rankName); // -1 when unranked
    const colour = rankColor(data, cat.rankName, cat);

    const el = document.createElement("div");
    el.className = "cat-rank";

    const top = document.createElement("div");
    top.className = "cat-rank-top";
    top.innerHTML =
      '<span class="cat-rank-name">' + esc(cat.name) + "</span>" +
      '<span class="cat-rank-rank" style="color:' + esc(colour) + '">' +
      esc(cat.rankName || "unranked") + " · " + num(cat.energy) + " energy</span>";
    el.append(top);

    // The ladder itself: one cell per rank, grouped into window bands.
    const strip = document.createElement("div");
    strip.className = "ladder-strip";

    for (let w = 0; w * size < depth; w++) {
      const band = document.createElement("div");
      band.className = "band";

      const label = document.createElement("span");
      label.className = "band-name";
      label.textContent = windows[w] ?? `window ${w + 1}`;
      band.append(label);

      const rungs = document.createElement("div");
      rungs.className = "band-rungs";

      for (let i = w * size; i < Math.min(depth, w * size + size); i++) {
        const name = cat.rankNames[i];
        const rung = document.createElement("span");
        rung.className =
          "rung" + (i < here ? " done" : i === here ? " here" : "");
        rung.style.setProperty("--rank", rankColor(data, name, cat));
        rung.title = `${name} · rank ${i + 1} of ${depth} · ${num(cat.rankMaxes ? cat.rankMaxes[i] : 0)} energy`;
        rung.textContent = String(i + 1);
        rungs.append(rung);
      }

      band.append(rungs);
      strip.append(band);
    }

    el.append(strip);

    // What the next rank costs, and where it is scored.
    const climbing = cat.scenarios
      .filter((x) => x.nextRankName && x.gap > 0)
      .sort((a, b) => a.gap / Math.max(1, a.nextRankScore) - b.gap / Math.max(1, b.nextRankScore))[0];

    const note = document.createElement("div");
    note.className = "cat-rank-note";
    note.innerHTML = climbing
      ? "Closest: " + num(climbing.gap) + " points on <b>" +
        esc(climbing.nextRankIsNewScenario ? targetName(climbing) : climbing.label) +
        "</b> for " + esc(climbing.nextRankName) +
        (climbing.nextRankIsNewScenario
          ? ' <span class="onscen">a harder scenario than the one ranking you now</span>'
          : "")
      : "Every scenario here is at its top rank.";
    el.append(note);

    host.append(el);
  });

  // ---- what it takes ----
  // The category travels with each row, because the rank names in it are that category's
  // and looking them up on the overall ladder returns nothing.
  const rows = data.categories
    .reduce((all, c) => all.concat(c.scenarios.map((s) => ({ s, cat: c }))), [])
    .filter(({ s }) => s.nextRankName && s.gap > 0)
    .sort((a, b) => a.s.gap - b.s.gap);

  const body = $("nextRankBody");
  body.textContent = "";

  if (rows.length === 0) {
    body.innerHTML =
      '<tr><td colspan="6" style="color:var(--ink-dim)">' +
      "Every scenario is at its highest rank for this difficulty.</td></tr>";
    return;
  }

  rows.forEach(({ s, cat }) => {
    const colour = rankColor(data, s.rankName, cat);
    const next = rankColor(data, s.nextRankName, cat);
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
      '<td style="color:' + esc(colour) + '">' + esc(s.rankName || "unranked") + "</td>" +
      "<td>" + num(s.score) + "</td>" +
      '<td style="color:' + esc(next) + '">' + esc(s.nextRankName) + "</td>" +
      "<td>" + num(s.nextRankScore) + target + "</td>" +
      "<td>+" + num(s.gap) + "</td>";
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

function renderTodo() {
  const list = $("todoList");
  list.textContent = "";

  pendingScenarios.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = s.done ? "done" : "pending";
    li.innerHTML =
      '<span class="n">' + (s.done ? "✓" : i + 1) + "</span>" +
      "<span>" + esc(s.label) + "</span>" +
      (s.tier ? '<span class="tier-tag">' + esc(s.tier) + "</span>" : "");

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
  const won = m.verdict === "win";

  $("verdictBig").textContent =
    won ? "Victory" : m.verdict === "draw" ? "Draw" : "Defeat";
  $("verdictBig").style.color =
    won ? "var(--up)" : m.verdict === "draw" ? "var(--ink)" : "var(--down)";
  $("verdictScores").textContent =
    pct(m.playerMatchScore) + " vs " + pct(m.opponentMatchScore) + " against baseline" +
    (m.ratingWeight < 1 ? "   ·   reduced weight (provisional baselines)" : "");
  $("ratingMove").textContent = won ? "+18 SR" : "−14 SR";
  $("ratingMove").style.color = won ? "var(--up)" : "var(--down)";
  $("explain").textContent = m.explanation;

  const body = $("roundsBody");
  body.textContent = "";
  m.rounds.forEach((r) => {
    const youWon = r.you.delta > r.them.delta;
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(r.label) + "</td>" +
      "<td>" + num(r.you.score) + '<div class="base">base ' + num(r.you.baseline) + "</div></td>" +
      '<td class="' + (r.you.delta >= 0 ? "up" : "down") + '">' + pct(r.you.delta) + "</td>" +
      "<td>" + num(r.them.score) + '<div class="base">base ' + num(r.them.baseline) + "</div></td>" +
      '<td class="' + (r.them.delta >= 0 ? "up" : "down") + '">' + pct(r.them.delta) + "</td>" +
      '<td class="' + (youWon ? "won-round" : "") + '">' + (youWon ? "won" : "lost") + "</td>";
    body.append(tr);
  });
}

/** True once a genuine match has settled in this session. */
let hasRealResult = false;

/** Empty state for the result tab before any real match has been played. */
function renderNoResultYet() {
  $("verdictBig").textContent = "No matches yet";
  $("verdictBig").style.color = "var(--ink-mid)";
  $("verdictScores").textContent =
    "Queue for a category, play the three scenarios, and the result lands here.";
  $("ratingMove").textContent = "";
  $("explain").textContent =
    "Matches are decided on how far above your own baseline you played, not on raw " +
    "score, so both players get a real contest whatever their rank.";
  $("roundsBody").textContent = "";
}

/**
 * Render a real settled match.
 *
 * Distinct from `renderResult`, which draws the snapshot's illustrative match. This one
 * shows what actually happened, including the rating change and each run's verification
 * tier, because a player is entitled to see why a result went the way it did.
 */
function renderSettled(s) {
  hasRealResult = true;

  // A seeding match has no opponent and therefore no verdict. Without this it fell
  // through to the losing branch and announced DEFEAT in red over three runs that beat
  // their baselines - which is not a wrong colour, it is a wrong claim about what
  // happened.
  const isSeeding = s.seeding || s.verdict == null;
  const won = s.verdict === "win";
  const isVoid = s.verdict === "void";

  $("verdictBig").textContent = isSeeding
    ? "Run set recorded"
    : isVoid ? "Void"
    : won ? "Victory" : s.verdict === "draw" ? "Draw" : "Defeat";
  $("verdictBig").style.color = isSeeding
    ? "var(--ink)"
    : isVoid ? "var(--ink-mid)"
    : won ? "var(--up)" : s.verdict === "draw" ? "var(--ink)" : "var(--down)";

  $("verdictScores").textContent = isSeeding
    ? pct(s.yourMatchScore ?? 0) + " against your own baselines · no opponent yet"
    : isVoid
      ? (s.voidReason || "match could not be settled")
      : pct(s.yourMatchScore ?? 0) + " vs " + pct(s.theirMatchScore ?? 0) +
        " against baseline" +
        (s.ratingWeight < 1 ? `   ·   ${Math.round(s.ratingWeight * 100)}% weight (provisional)` : "");

  const change = s.ratingChange;
  $("ratingMove").textContent = isSeeding
    ? "not rated"
    : isVoid ? "no change"
    : `${change >= 0 ? "+" : "−"}${Math.abs(change)} · ${s.ratingAfter}`;
  $("ratingMove").style.color = isSeeding || isVoid
    ? "var(--ink-dim)"
    : change > 0 ? "var(--up)" : change < 0 ? "var(--down)" : "var(--ink-mid)";

  $("explain").textContent = s.explanation;

  const body = $("roundsBody");
  body.textContent = "";
  s.rounds.forEach((r) => {
    const yours = r.delta ?? 0;
    // Null means there is nobody on the other side, which is not the same as an
    // opponent who scored their baseline exactly. Treating it as zero is what turned
    // three unopposed rounds into three "won" rows under a DEFEAT banner.
    const hasOpponent = r.opponentDelta != null;
    const theirs = r.opponentDelta ?? 0;
    const youWon = r.counted && hasOpponent && yours > theirs;

    const outcome = !r.counted
      ? esc(r.excludedReason || "excluded")
      : !hasOpponent ? "recorded"
      : youWon ? "won" : "lost";

    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(r.scenario) + "</td>" +
      "<td>" + num(r.score) + '<div class="base">base ' + num(r.baseline) +
        (r.verificationTier && r.verificationTier !== "verified"
          ? " · " + esc(r.verificationTier)
          : "") +
        "</div></td>" +
      '<td class="' + (yours >= 0 ? "up" : "down") + '">' +
        (r.counted ? pct(yours) : "—") + "</td>" +
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
    host.innerHTML = '<p class="rank-lede">No season loaded, so nothing to measure against.</p>';
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
      const fill = document.createElement("span");
      fill.className = "cover-fill";
      fill.style.width = `${row.total > 0 ? (row.measured / row.total) * 100 : 0}%`;
      track.append(fill);

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
          `${cheapest.cost} more runs unlocks ${cheapest.row.windowName}: ` +
          cheapest.need.map((x) => `${x.label} +${x.needs}`).join(", ");
        block.append(next);
      }
    }

    host.append(block);
  }
}

function renderProfile(data) {
  $("weakNote").textContent = data.weakest + " is your weakest category";

  const maxEnergy = Math.max.apply(null, data.categories.map((c) => c.energy));
  const wmap = $("wmap");
  wmap.textContent = "";

  data.categories.forEach((cat) => {
    const colour = rankColor(data, cat.rankName, cat);
    const row = document.createElement("div");
    row.className = "wrow";
    row.innerHTML =
      '<div class="lbl">' + esc(cat.name) + "</div>" +
      '<div class="wtrack"><div class="wfill" style="width:' +
        ((cat.energy / maxEnergy) * 100).toFixed(1) +
        "%;background:linear-gradient(90deg," + esc(colour) + "40," + esc(colour) + ')"></div></div>' +
      '<div class="wval">' + num(cat.energy) + " · " + esc(cat.rankName || "—") + "</div>";
    wmap.append(row);
  });

  const body = $("scenBody");
  body.textContent = "";

  // One row per family, showing the variant that earned the rank. Which variant that is
  // matters - it is the scenario the score in this row belongs to - so the window is on
  // the label, and the target names its own scenario when the next rank moves up a window.
  data.categories
    .reduce((all, c) => all.concat(c.scenarios.map((s) => ({ s, cat: c }))), [])
    .sort((a, b) => a.s.energy - b.s.energy)
    .forEach(({ s, cat }) => {
      const colour = rankColor(data, s.rankName, cat);
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(s.label) +
          (s.windowName ? ' <span class="win">' + esc(s.windowName) + "</span>" : "") + "</td>" +
        "<td>" + esc(s.subCategory || "—") + "</td>" +
        "<td>" + (s.score ? num(s.score) : "—") + "</td>" +
        '<td style="color:' + esc(colour) + '">' + esc(s.rankName || "—") + "</td>" +
        "<td>" + num(s.energy) + "</td>" +
        "<td>" + s.runs + "</td>" +
        "<td>" +
          (s.gap != null
            ? "+" + num(s.gap) + " → " + esc(s.nextRankName) +
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
  if (!c) return;

  const colorOf = (rank) => data.benchmark.rankColors[rank] || "var(--ink-mid)";

  $("ceilRank").textContent = c.ceilingRank || "unranked";
  $("ceilRank").style.color = colorOf(c.ceilingRank);
  $("ceilEnergy").textContent = num(c.ceilingEnergy) + " energy";

  $("floorRank").textContent = c.floorRank || "unranked";
  $("floorRank").style.color = colorOf(c.floorRank);
  $("floorEnergy").textContent = num(c.floorEnergy) + " energy";

  $("gapVal").textContent = (c.gap * 100).toFixed(1) + "%";

  const body = $("consistencyBody");
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

function renderQuests(data) {
  const host = $("questList");
  host.textContent = "";
  data.quests.forEach((q, i) => {
    // Floor quests get a single consistent colour rather than one from the rank ramp:
    // they are a different kind of ask, and looking different is the point.
    const colour = q.isFloor
      ? "var(--warn)"
      : data.theme[Math.min(data.theme.length - 1, 3 + i)].color;

    const el = document.createElement("div");
    el.className = "quest" + (q.isFloor ? " quest-floor" : "");

    // "4 of 5 runs" says what is left far better than "80%" on a quest whose whole
    // point is that every run in the window has to clear the bar.
    const counter = q.steps
      ? '<span class="qsteps">' + q.steps.done + " of " + q.steps.total + " runs</span>"
      : "";

    el.innerHTML =
      "<div><h3>" + esc(q.title) +
        (q.isFloor ? '<span class="floor-tag">floor</span>' : "") +
        "</h3><p>" + esc(q.detail) + "</p></div>" +
      '<div class="xp">' + counter + q.xp + " XP</div>" +
      '<div class="qtrack"><div class="qfill" style="width:' +
        (q.progress * 100).toFixed(1) + "%;background:" + esc(colour) + '"></div></div>';
    host.append(el);
  });
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

function showCelebration(payload) {
  celebrationQueue.push(payload);
  if (!celebrating) nextCelebration();
}

function nextCelebration() {
  const payload = celebrationQueue.shift();
  if (!payload) {
    celebrating = false;
    $("celebrate").hidden = true;
    return;
  }

  celebrating = true;
  const { quest, level } = payload;

  const isFloor =
    quest.kind === "floor_rank_up" ||
    quest.kind === "close_the_spread" ||
    quest.kind === "no_disasters";

  $("celebrateKicker").textContent = isFloor ? "Floor raised" : "Quest complete";
  $("celebrateTitle").textContent = quest.title;
  $("celebrateDetail").textContent = quest.detail;
  $("celebrateXp").textContent = "+" + quest.xp + " XP";

  $("celebrateLevel").textContent = "Level " + level.level;
  $("celebrateLevelXp").textContent =
    level.xpIntoLevel.toLocaleString() + " / " + level.xpForNextLevel.toLocaleString();

  $("celebrate").hidden = false;
  playSound("celebrate");
  // Fill from zero so the bar visibly moves rather than appearing already full.
  $("celebrateFill").style.width = "0%";
  requestAnimationFrame(() => {
    $("celebrateFill").style.width = (level.progress * 100).toFixed(1) + "%";
  });

  // More waiting? Say so, so the button does not look like it dismissed them all.
  $("celebrateClose").textContent =
    celebrationQueue.length > 0 ? `Next (${celebrationQueue.length} more)` : "Nice";
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
  $("queueGateText").innerHTML =
    'Ranked opens at <span class="gate-count">' + num(required) + "</span> uploaded runs. " +
    'You have <span class="gate-count">' + num(uploaded) + "</span> \u2014 " +
    num(missing) + " to go.";
  $("queueGateFill").style.width = Math.min(100, (uploaded / required) * 100).toFixed(1) + "%";
  gate.classList.add("on");

  // Marked so the paths that re-enable the button on a category change or a finished
  // match do not quietly hand it back.
  btn.disabled = true;
  btn.dataset.gated = "1";
}

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

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function showRunToast(run) {
  $("toastScen").textContent = run.scenario;
  $("toastScore").textContent = num(run.score);
  $("toast").classList.add("on");
  playSound("run");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("on"), 4200);

  // Tick the scenario off the match to-do list if it was one we asked for.
  let changed = false;
  pendingScenarios.forEach((s) => {
    if (!s.done && run.scenario.indexOf(s.label) !== -1) {
      s.done = true;
      changed = true;
    }
  });
  if (changed) renderTodo();
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
async function refreshSeasonTab() {
  const tab = $("tabSeason");
  if (!tab || !window.apogee || !window.apogee.isAdmin) return;

  const r = await window.apogee.isAdmin().catch(() => null);
  const admin = Boolean(r && r.admin);

  // Hiding the tab out from under someone standing on it would leave the screen up
  // with no way back to it, so send them to Queue first.
  if (!admin && tab.getAttribute("aria-selected") === "true") {
    document.querySelector('.tab[data-screen="queue"]').click();
  }

  tab.hidden = !admin;
  numberTabs();
  if (admin) await loadSeasonEditor();
}

// The pool lives in the season file rather than the snapshot, so it is fetched once and
// the season screen is repainted when it lands. Everything else on that screen renders
// without it.
if (HOST === "electron" && window.apogee && window.apogee.getSeason) {
  void window.apogee.getSeason().then((r) => {
    if (!r || !r.season) return;
    seasonPool = r.season;
    if (current) renderSeasonView(current);
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
 * The public board: who is ahead of you, and by how much.
 *
 * Server-served rather than read from a table. `apex_standing` is read-self, because a
 * leaderboard being public does not make the population enumerable - what a client sees
 * about another player is the server's decision, the same rule opponent names follow.
 *
 * Absent rows are absent players, not zeros: somebody who has never refreshed is simply
 * not on the board yet, and showing them at zero would be inventing a standing.
 */
function renderApexBoard() {
  const note = $("apexBoardNote");
  const body = $("apexBoardBody");
  if (!body) return;

  body.textContent = "";

  if (!apexBoard) {
    if (note) note.textContent = "sign in to see where you stand";
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
    note.textContent = mine + " \u00b7 " + num(apexBoard.population) + " ranked";
  }

  if (apexBoard.entries.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4">Nobody has refreshed onto this board yet.</td>';
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
    if (current) renderSeasonView(current);
  });
  refreshApex();
}

refreshPractice();

if (HOST === "electron" && window.apogee.isAdmin) {
  void refreshSeasonTab();

  $("seasonSave").addEventListener("click", async () => {
    const btn = $("seasonSave");
    btn.disabled = true;
    setSeasonStatus("saving…", "");

    const result = await window.apogee.saveSeason(seasonDraft);

    if (result && result.error) {
      // Say what is wrong and leave the draft alone: the numbers on screen are the ones
      // that need fixing, so throwing them away would be the worst possible response.
      setSeasonStatus(result.error, "bad");
      btn.disabled = false;
      return;
    }

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
    clearStashedDraft();
    seasonDirty(false);
  });

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

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    // Only when the screen actually changes. Every route into a tab goes through
    // `.click()`, including the one that re-selects the tab already showing, and a
    // navigation sound for going nowhere is just a noise.
    if (tab.getAttribute("aria-selected") !== "true") playSound("nav");
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $("screen-" + tab.dataset.screen).classList.add("active");
    rememberScreen(tab.dataset.screen);
  });
});

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
  document.querySelectorAll("details[open]").forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector("details[open]");
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
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown") {
    const here = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
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
function showRealMatch(match, data) {
  const me = data.player.apogee;

  // The payoff of pressing Find opponent. Seeding gets the same riser: the player still
  // has three scenarios to go and play, which is the thing the sound is announcing.
  playSound("matchFound");

  // A seeding match has no opponent: the pool was empty, so the server handed out three
  // scenarios to play against nobody. Everything downstream is identical, which is the
  // point, so only the opponent card changes.
  if (match.seeding || !match.opponent) {
    $("oppBadge").innerHTML = badge(me.tier, "opp");
    $("oppName").textContent = "No opponent yet";
    $("oppTier").textContent = "seeding the pool";
    $("oppTier").style.color = me.tier.color;
    $("oppAge").textContent =
      match.poolSize == null
        ? "match already in progress"
        : match.poolSize === 0
          ? "you are first in this category"
          : `pool of ${match.poolSize}, none close enough to your rating`;

    // No odds to show against nobody, and a half-filled bar would imply a coin flip.
    $("oddsBar").innerHTML =
      '<div style="flex:1;background:' + esc(me.tier.color) + ';opacity:.25"></div>';
    $("oddsYou").textContent = "unrated";
    $("oddsThem").textContent = "nothing at stake";
  } else {
    const oppTier = data.match.opponent.tier;

    $("oppBadge").innerHTML = badge(oppTier, "opp");
    $("oppName").textContent = match.opponent.displayName;
    $("oppTier").textContent = `rating ${match.opponent.rating}` +
      (match.opponent.provisional ? " · provisional" : "");
    $("oppTier").style.color = oppTier.color;

    const played = new Date(match.opponent.playedAt);
    const days = Math.max(0, Math.round((Date.now() - played.getTime()) / 86400000));
    $("oppAge").textContent =
      `stored run · ${days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago"}` +
      ` · pool of ${match.poolSize}`;

    const p = match.winProbability ?? 0.5;
    $("oddsBar").innerHTML =
      '<div style="flex:' + p + ';background:' + esc(me.tier.color) + '"></div>' +
      '<div style="flex:' + (1 - p) + ';background:' + esc(oppTier.color) + '"></div>';
    $("oddsYou").textContent = "you " + (p * 100).toFixed(0) + "%";
    $("oddsThem").textContent = (100 - p * 100).toFixed(0) + "% " + match.opponent.displayName;
  }

  pendingScenarios = match.scenarios.map((s) => ({
    id: s.id,
    label: s.name,
    done: false,
    tier: null,
  }));
  renderTodo();

  // A new match means a new playlist to write, so the button goes back to offering it.
  $("playMatchBtn").textContent = "Play in KovaaK's";
  $("playMatchBtn").disabled = false;
  $("matchHint").textContent = match.resumed
    ? "You already had this match open. Finish it, or abandon it to queue again."
    : match.seeding || !match.opponent
      ? "Nothing is rated yet. Play these three and your run set becomes the first " +
        "entry in the pool. Only your first run on each counts."
      : "Only your first run on each scenario counts. Apogee picks them up automatically.";

  startMatchClock(match.expiresAt);

  $("matchActions").hidden = false;
  $("opponent").classList.add("on");
}

$("queueBtn").addEventListener("click", async () => {
  if (!current) return;

  const btn = $("queueBtn");

  if (HOST !== "electron") {
    // No server in the preview; show the illustrative match instead.
    showOpponent(current);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Searching…";
  $("searching").classList.add("on");
  $("opponent").classList.remove("on");
  showError(null);

  const result = await window.apogee.findMatch(selectedCategory, current.benchmark.matchPool);

  $("searching").classList.remove("on");
  btn.disabled = false;

  if (result.error) {
    btn.textContent = "Find opponent";
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
  btn.textContent = result.match.resumed
    ? "Match already open"
    : result.match.seeding
      ? "Seeding the pool"
      : "Match in progress";
  activeMatch = result.match;
  showRealMatch(result.match, current);
});

/* ------------------------------------------------------------------ account */

function renderSession(session, configured) {
  const btn = $("btnSignIn");
  const panel = $("signedIn");
  if (!btn || !panel) return;

  // The header holds the sign-in control, so it has to be visible before there is any
  // snapshot to show. Otherwise a new user with no stats yet has nothing to click.
  $("whoami").hidden = false;

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
    ? "Opens your browser to authenticate with Steam"
    : "This build has no Supabase settings. Fill in .env and rebuild.";
}

if (HOST === "electron") {
  $("btnRescan").addEventListener("click", () => api.rescan());
  $("btnOpen").addEventListener("click", () => api.openStatsFolder());
  const choose = () => api.chooseFolder();
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
    await api.signOut();
  });

  api.onSession((session) => {
    renderSession(session, true);
    // Uploading only makes sense once there is an account to attach runs to.
    $("uploadRow").hidden = !session;

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
  $("uploadBtn").addEventListener("click", async () => {
    const btn = $("uploadBtn");
    btn.disabled = true;
    $("uploadTrack").hidden = false;
    showError(null);

    const result = await api.uploadHistory();

    btn.disabled = false;
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
      $("uploadFill").style.width = "100%";
      $("uploadSub").textContent = "Computing your baselines…";
      return;
    }
    const pct = p.total ? (p.uploaded / p.total) * 100 : 0;
    $("uploadFill").style.width = pct.toFixed(1) + "%";
    $("uploadSub").textContent =
      `${p.uploaded.toLocaleString()} of ${p.total.toLocaleString()} runs` +
      ` · batch ${p.batch}/${p.batches}`;
  });

  // ---- match lifecycle ---------------------------------------------------
  api.onMatch((match) => {
    activeMatch = match;
    if (!match) {
      $("opponent").classList.remove("on");
      $("matchActions").hidden = true;
      $("queueBtn").textContent = "Find opponent";
      $("queueBtn").disabled = false;
      renderEligibility();
    }
  });

  api.onMatchProgress((p) => {
    if (p.status === "submitted") {
      const s = pendingScenarios.find((x) => x.id === p.scenarioId);
      if (s) {
        s.done = true;
        s.tier = p.verificationTier;
        renderTodo();
      }
      // The clock only runs while nobody is playing, so a landed run restarts it.
      // Without this the countdown keeps draining toward a deadline the server has
      // already moved, and reads as though playing cost the player time.
      if (p.expiresAt) {
        if (activeMatch) activeMatch.expiresAt = p.expiresAt;
        startMatchClock(p.expiresAt);
      }

      $("matchHint").textContent = p.remaining && p.remaining.length
        ? `${p.remaining.length} scenario(s) left`
        : "All runs in. Settling…";
    } else if (p.status === "failed") {
      showError(`Could not submit that run: ${p.message}`);
    } else if (p.status === "already-submitted") {
      $("matchHint").textContent = p.message;
    }
  });

  api.onMatchSettled((settled) => {
    activeMatch = null;
    $("matchActions").hidden = true;
    $("opponent").classList.remove("on");
    $("queueBtn").textContent = "Find opponent";
    $("queueBtn").disabled = false;
    renderEligibility();
    renderSettled(settled);
    playSound(settled && settled.verdict === "win" ? "victory"
      : settled && settled.verdict === "draw" ? "ok" : "defeat");

    // Jump to the result, because that is the payoff and nobody should have to hunt
    // for it after finishing three scenarios.
    document.querySelector('.tab[data-screen="result"]').click();
  });

  // Abandoning a contested match is a forfeit and costs a loss, so it asks first. A
  // seeding match has no opponent and costs nothing, so it does not.
  $("cancelMatchBtn").addEventListener("click", async () => {
    const contested = activeMatch && !activeMatch.seeding && activeMatch.opponent;

    if (contested) {
      const name = activeMatch.opponent.displayName;
      const ok = window.confirm(
        `Forfeit this match against ${name}?\n\n` +
          "It counts as a loss and your rating drops. You can queue again straight away.",
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
      $("queueBtn").textContent = "Find opponent";
      $("queueBtn").disabled = false;
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
          ? `Opening ${result.jumpedTo}. Use the Play buttons for the other two — ` +
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

  // Escape dismisses, because a modal that traps you is worse than no modal.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("celebrate").hidden) nextCelebration();
  });

  api.onSigningIn(({ signingIn }) => {
    const btn = $("btnSignIn");
    btn.disabled = signingIn;
    btn.textContent = signingIn ? "Check your browser…" : "Sign in with Steam";
    if (!signingIn) $("signinHelp").hidden = true;
  });

  // If the browser does not appear, the flow is still completable by hand. Showing the
  // link turns a dead end into an inconvenience.
  api.onSignInUrl(({ url }) => {
    const help = $("signinHelp");
    help.hidden = false;
    $("signinLink").textContent = url;
    $("signinLink").dataset.url = url;
  });

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
  });

  api.onRun((run) => showRunToast(run));

  api.onScanning(({ scanning }) => {
    setStatus(scanning ? "scanning" : "ok", scanning ? "Scanning…" : "Watching", currentPath);
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
    if (state.session) refreshEligibility();
    if (state.snapshot) {
      render(state.snapshot);
      setStatus("ok", "Watching", currentPath);
    } else {
      setStatus(state.lastError ? "bad" : "scanning", state.lastError ? "Problem" : "Scanning…", currentPath);
      if (state.lastError) {
        showError(state.lastError);
        $("emptyText").textContent = state.lastError;
      }
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
}

/* ==================================================================== press */

/**
 * What a press looks and sounds like, wired once for the whole app.
 *
 * There are thirty-odd click handlers in this file and more added by the season editor
 * at runtime. Giving each one a sound and a bounce by hand would mean editing all of
 * them, missing several, and missing every control that does not exist yet - so this
 * listens on the document in the capture phase instead. Capture rather than bubble
 * because a handler that calls `stopPropagation` is making a decision about its own
 * behaviour, not about whether the button it is on gets to feel pressed.
 *
 * The visual is deliberately not `:active`. That pseudo-class ends the instant the
 * button is released, which cuts the spring back off halfway and is what makes a press
 * feel cheap; a class removed on `pointerup` can outlive the release by the 340ms the
 * bounce actually needs.
 */

/** Everything that takes a press. `summary` is here because the status pill is one. */
const PRESSABLE = 'button, summary, [role="button"], .cat, .rank-link';

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** The ring is drawn here rather than inside the control - see the CSS for why. */
const fxLayer = document.createElement("div");
fxLayer.className = "fx-layer";
document.body.appendChild(fxLayer);

function ring(x, y) {
  if (reduceMotion.matches) return;
  const el = document.createElement("span");
  el.className = "fx-ring";
  el.style.left = x + "px";
  el.style.top = y + "px";
  fxLayer.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

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
  if (el.classList.contains("queue-btn")) return "press";
  if (el.hasAttribute("aria-pressed")) {
    return el.getAttribute("aria-pressed") === "true" ? "toggleOff" : "toggleOn";
  }
  return "tap";
}

let pressed = null;

document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest && e.target.closest(PRESSABLE);
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;

    pressed = el;
    el.classList.remove("released");
    el.classList.add("pressing");
    ring(e.clientX, e.clientY);

    const sound = pressSound(el);
    if (sound) playSound(sound);
  },
  true,
);

/**
 * Release on the window, not on the control.
 *
 * A press that starts on a button and ends anywhere else still ends, and a button left
 * holding `pressing` stays visibly squashed until the next time it is touched.
 */
window.addEventListener("pointerup", () => {
  if (!pressed) return;
  const el = pressed;
  pressed = null;
  el.classList.remove("pressing");
  if (reduceMotion.matches) return;
  el.classList.add("released");
  el.addEventListener("animationend", () => el.classList.remove("released"), { once: true });
});

window.addEventListener("pointercancel", () => {
  if (pressed) pressed.classList.remove("pressing");
  pressed = null;
});

/**
 * The pointer crossing a control.
 *
 * Throttled and very quiet. Untreated this fires on every pixel of movement across a
 * grid of tabs and turns into a rattle, which is the fastest way to make somebody reach
 * for the mute button the app just grew.
 */
let lastHover = null;
let lastHoverAt = 0;

document.addEventListener("pointerover", (e) => {
  const el = e.target.closest && e.target.closest(PRESSABLE);
  if (!el || el === lastHover || el.disabled) {
    if (!el) lastHover = null;
    return;
  }
  lastHover = el;

  const now = performance.now();
  if (now - lastHoverAt < 70) return;
  lastHoverAt = now;
  playSound("hover");
});

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

// Reflect the stored preference on the control before anything can be heard, then let
// the rest of the app make noise.
setSound(soundOn, false);
soundReady = true;
