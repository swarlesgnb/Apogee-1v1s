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

/**
 * A plate, stamped with the tier's rung.
 *
 * It was a faceted hexagon filled with a two-stop gradient and thrown behind a
 * coloured drop-shadow, on the argument that a silhouette carries identity before a
 * colour does. It does - but eight identical hexagons in eight colours is one
 * silhouette, so the argument bought nothing and the glow made the badge the brightest
 * thing on a screen it is not the subject of. This is flat, square, and carries the
 * rung number, which is the fact the badge is standing in for.
 *
 * The rung is punched out of the plate in whichever of the ground or the ink reads
 * better on that tier's colour. It cannot be a fixed dark: the tier colours are chosen
 * to match the tier names, so the ladder runs from Cosmonaut's #008080 to Quasar's
 * #00FFFF, and a single stamp colour is unreadable on one end or the other.
 *
 * `uid` is no longer needed - nothing here is referenced by id - but the call sites
 * pass it and it costs nothing to keep the signature.
 */
function badge(tier, uid) {
  // Tier ids are "tier-1" through "tier-8"; the number in one is the rung.
  const rung = /^tier-(\d+)$/.exec(String(tier.id ?? ""))?.[1] ?? "";
  const stamp =
    contrastRatio(tier.color, DARK_GROUND) >= contrastRatio(tier.color, LIGHT_GROUND)
      ? DARK_GROUND
      : LIGHT_GROUND;
  return (
    '<svg viewBox="0 0 60 68" role="img" aria-label="' + esc(tier.name) + '">' +
    '<rect x="3" y="4" width="54" height="60" fill="' + esc(tier.color) + '"/>' +
    (rung
      ? '<text x="30" y="43" text-anchor="middle" fill="' + esc(stamp) + '" ' +
        'font-family="Cascadia Mono, ui-monospace, Consolas, monospace" ' +
        'font-size="30" font-weight="600">' + esc(rung) + "</text>"
      : "") +
    "</svg>"
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
  lastSnapshot = data;
  current = data;
  $("app").hidden = false;
  $("empty").hidden = true;
  $("whoami").hidden = false;

  const me = data.player.apogee;

  // The whole chrome takes the player's rank colour: the selected tab's number, focus
  // rings, the badge, the one tile on the pool screen that is an instruction. The
  // alternative is a brand accent sitting next to the rank colour and competing with
  // the one signal that means something here.
  document.documentElement.style.setProperty("--accent", me.tier.color);

  $("myBadge").innerHTML = badge(me.tier, "me");
  $("myTier").textContent = me.tier.name;
  $("myTier").style.color = legibleOnDark(me.tier.color, RANK_TEXT_CONTRAST);
  $("myRating").textContent = me.rating + " ±" + me.rd;
  $("myStreak").textContent = data.player.streak + "-day streak";

  $("heroBadge").innerHTML = badge(me.tier, "hero");
  $("heroName").textContent = me.tier.name;
  $("heroName").style.color = legibleOnDark(me.tier.color, RANK_TEXT_CONTRAST);

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

  renderClimb(data);
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
      "three of " + rows.length + ", " + measured + " with a baseline";
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
      base.textContent = r.best === null ? "unplayed" : num(r.best);
      base.title =
        num(r.runs) + " runs, enough to score a match against" +
        (r.nextRankScore !== null && r.gap !== null
          ? ". " + num(r.gap) + " more points reaches the next rank on it"
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
          ? "nothing of yours on this scenario yet"
          : (r.runs === 1 ? "1 run" : num(r.runs) + " runs") + ", best " + num(r.best)) +
        ". A scenario with no baseline is scored against a guess.";
      el.className = "draw-row short" + (r.runs === 0 ? " none" : "");
    }

    const who = document.createElement("span");
    who.className = "draw-name";
    who.append(nm, sk);

    el.append(who, meter, base);
    host.append(el);
  }

  const legend = $("drawLegend");
  if (legend) {
    legend.innerHTML =
      "A match is three of these, drawn at random. The bar on a scenario you have a " +
      "baseline for is <b>how far into its next rank</b> your best sits; on one you do " +
      "not, it is <b>how close it is to counting</b>.";
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
  $("queueVerb").textContent = verb;
  $("queueSub").textContent = sub ?? "";
  $("queueMeta").textContent = meta ?? "";
}

/** What a press would queue, in the button. */
function commitSub(data) {
  const where = !selectedCategory || selectedCategory === "Any"
    ? "Any category"
    : selectedCategory;
  const pool = data.benchmark.matchPoolName;
  return where + (pool ? " · " + pool : "") + " · three scenarios";
}

/** Back to offering a match, whatever it was last saying. */
function resetCommit(data) {
  const btn = $("queueBtn");
  if (!btn) return;
  setCommit("idle", "Find opponent", data ? commitSub(data) : "", "matched on rating");
  if (btn.dataset.gated !== "1") btn.disabled = false;
}

let searchTimer = null;

/** Seconds the server has been looking. The one honest thing to show while waiting. */
function startSearchClock() {
  const started = Date.now();
  stopSearchClock();
  const tick = () => {
    const total = Math.floor((Date.now() - started) / 1000);
    $("queueMeta").textContent =
      Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  };
  tick();
  searchTimer = setInterval(tick, 1000);
}

function stopSearchClock() {
  if (searchTimer) clearInterval(searchTimer);
  searchTimer = null;
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
    '<div style="flex:' + yours + ';background:' + esc(color) + '"></div>' +
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
  $("oppAge").textContent = "stored run · 3 days ago";

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
 * identical. Both grounds and the threshold are the same values; if one moves, move both -
 * and DARK_GROUND is also `--ground` in this file's own :root and DARK_CHROME.ground in
 * core/report/contrast.ts, which is the list the last palette change was missed on.
 *
 * It is worth the duplication: a colour that disappears is invisible to the person
 * choosing it, because the editor's own background is neither of the grounds it has to
 * survive, and finding out from a generated sheet after the fact is finding out too late.
 */
const DARK_GROUND = "#1e1b18";
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

const legibleOnDark = (color, min) => legibleOn(color, DARK_GROUND, min);
const legibleOnLight = (color, min) => legibleOn(color, LIGHT_GROUND, min);

/**
 * The floor for a rank name set as text.
 *
 * MIN_CONTRAST is 2, which the rank sheet uses because the names there are set at 29px
 * beside a printed specimen of the same colour, and large text carries a low ratio. In
 * the client the same names are 12px in a column forty rows deep.
 *
 * Measured against the season rather than picked: of its 153 named colours, 17 sit below
 * 2:1 on this ground and 42 below 3.5:1, with Gauss Cannon and Primate at 1.01, Pronghorn
 * at 1.16 and Orca at 1.23. At the sheet's threshold those seventeen still came out as
 * smudges at table size. 3.5 is WCAG's large-text floor of 3 with a little over, which is
 * the honest description of this text: small, but bold and in a column of its own.
 *
 * The counts rose when the grounds were lifted out of near-black: 13 were under 2:1 and 32
 * under 3.5:1 on the old ground. A lighter ground costs a dark rank colour contrast, and
 * absorbing exactly that is what this function is for, so nothing else had to move - but
 * the numbers are restated rather than left describing a ground the app no longer paints.
 *
 * `npm run audit:look` re-derives the three counts above.
 */
const RANK_TEXT_CONTRAST = 3.5;

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

  // Sent with the season rather than restated here. This was a literal 2500 - a third
  // copy of a constant owned by src/core/benchmarks/energy.ts - and a change there would
  // have left the season editor quietly computing a different ladder to everything else.
  cat.rankMaxes = cat.rankNames.map((_, i) => families * energyPerRank * (i + 1));
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
  // screen is one category's scenarios against the ranks of one window. The whole ladder is
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
        : `${num(option.entries)} on the board${option.entries < MIN_BOARD ? ", thin" : ""}`;

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
    // seasonPool arrives over IPC and is null until it does - and never arrives at all
    // in the static preview, which is the file people are shown. The practice pool holds
    // the same scenarios, so the two headline counts on this panel fall back to it
    // rather than printing an em dash where a number belongs.
    const pool = seasonPool && Array.isArray(seasonPool.scenarios)
      ? seasonPool.scenarios
      : practice && Array.isArray(practice.scenarios) ? practice.scenarios : null;
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
    // Counted from the rows on screen rather than stated, so the claim is about the band
    // being looked at and cannot go stale when the pool changes underneath it.
    const from = new Set();
    for (const r of shown) for (const o of r.origins ?? []) from.add(o.benchmark);
    $("svPoolNote").textContent =
      num(shown.length) + " scenarios · " + num(played) + " played" +
      (from.size > 0 ? " · from " + num(from.size) + " benchmarks" : "");
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

      // The tiles sit in their own grid inside the group, so the sub-skill's label stays
      // full-width above them rather than becoming a first column of the grid.
      const tiles = document.createElement("div");
      tiles.className = "pool-tiles";
      group.append(tiles);

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
        if (colour) {
          row.style.setProperty("--rank", colour);
          row.style.setProperty("--rank-ink", legibleOnDark(colour, RANK_TEXT_CONTRAST));
        }
        row.style.setProperty("--fill", (maxedHere ? 1 : (v.progress ?? 0)) * 100 + "%");

        const nm = document.createElement("span");
        nm.className = "nm";
        const nmText = document.createElement("span");
        nmText.className = "nm-text";
        nmText.textContent = v.label;
        nm.append(nmText);
        // Only Viscose publishes a mechanic, and only for tracking, so this shows on
        // twenty-four of the hundred and eight and nowhere else. It sits on the tile
        // rather than the sub-skill heading because it belongs to the family: Control
        // Tracking holds a Wrist family, an Arm one and a Blending one, and a single tag
        // over the group would have mislabelled two of the three.
        if (v.mechanic) {
          const mech = document.createElement("span");
          mech.className = "pool-mech";
          mech.textContent = v.mechanic;
          mech.title = "Viscose files this family under " + v.mechanic;
          nm.append(mech);
        }
        // Where the scenario came from, and what this score is worth there.
        //
        // This is the argument for the whole pool on one line: nothing here was invented,
        // and a session on this ladder is a session on the ladders people already grind.
        // 197 of the 208 carry at least one mark, a third of them two or more.
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
                ? o.rankName + (o.nextName ? ", " + num(o.nextScore) + " for " + o.nextName : "")
                : o.nextName
                  ? num(o.nextScore) + " for " + o.nextName
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
        }

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
function openBand(category, window_) {
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
    "Every rank this band can award, and the score each one wants on each of its " +
    band.total + " scenarios. A band is a whole benchmark: these ranks are its own, and " +
    "holding one says nothing about the band above it.";

  $("bandNote").textContent =
    band.played === 0
      ? "not played yet"
      : (band.rankName ? band.rankName : "below the first rank") +
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

  $("bandGridNote").textContent = rows.length + " scenarios";
  $("bandGridLede").textContent = rows.length === 0
    ? "The practice list has not loaded, so the per-scenario scores are not available yet."
    : "A filled cell is a score you have already beaten. The outlined one in each row is " +
      "the next score that moves you, and every scenario counts the same, so the cheapest " +
      "outlined cell is the cheapest rank.";

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
    bestCell.textContent = r.best === null ? "unplayed" : num(r.best);
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
      td.textContent = target === undefined ? "" : num(target);
      td.title =
        esc(r.label) + " · " + name +
        (target === undefined
          ? ""
          : cleared
            ? " · cleared"
            : r.best === null
              ? " · wants " + num(target)
              : " · " + num(Math.round(target - r.best)) + " to go");
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
    "Where you sit against everyone else playing. Tiers are population percentiles, " +
    "so they keep their meaning as the ladder grows.";

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
    `Your ${bench.name} standing: what your scores are worth, not who you beat. Each ` +
    "band is its own benchmark, so you hold a rank in every band you have played. " +
    `Overall you are ${data.player.benchmarkRank} at ${num(data.player.benchmarkEnergy)} energy.`;

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
      (bands.length ? held + " of " + bands.length + " bands held" : esc(cat.rankName || "unranked")) +
      "</span>";
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
        : (b.rankName ?? "below " + (b.rankNames[0] ?? "rank 1"));
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
        const pct = Math.round((b.progressToNextRank ?? 0) * 100);
        foot.innerHTML =
          '<span class="band-track"><i style="width:' + pct + '%"></i></span>' +
          '<span class="band-note">' + pct + "% to " + esc(next) + "</span>";
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
      '<td style="color:' + esc(ink) + '">' + esc(s.rankName || "unranked") + "</td>" +
      "<td>" + num(s.score) + "</td>" +
      '<td style="color:' + esc(nextInk) + '">' + esc(s.nextRankName) + "</td>" +
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
      '<span class="n">' + (s.done ? "✓" : i + 1) + "</span>" +
      "<span>" + esc(s.label) + "</span>" +
      (s.tier ? '<span class="tier-tag">' + esc(s.tier) + "</span>" : "") +
      (mine
        ? '<span class="scen-best" title="' +
          esc(num(mine.runs) + " runs on this scenario") +
          '">to beat <b>' + esc(num(mine.best)) + "</b></span>"
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
  // Nothing has been played, so there are no rounds to score.
  if ($("scoreline")) $("scoreline").hidden = true;
  $("explain").textContent =
    "Matches are decided on how far above your own baseline you played, not on raw " +
    "score, so both players get a real contest whatever their rank.";
  settled($("roundsBody"));
  $("roundsBody").textContent = "";
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
  for (const r of list) {
    const hasOpponent = r.opponentDelta != null;
    const contested = r.counted && hasOpponent;
    const youWon = contested && (r.delta ?? 0) > (r.opponentDelta ?? 0);
    if (contested) {
      if (youWon) mine++;
      else theirs++;
    }
    const m = document.createElement("span");
    m.className = "score-mark" + (contested ? (youWon ? " won" : " lost") : "");
    m.title = !r.counted
      ? r.excludedReason || "excluded"
      : !hasOpponent ? "recorded, nobody on the other side"
      : youWon ? "won" : "lost";
    marks.append(m);
  }

  const tally = $("scoreTally");
  if (tally) {
    // Nothing was contested, so there is no score to print - and "0-0" would read as a
    // draw rather than as a set of runs with nobody on the other side.
    tally.textContent = mine + theirs === 0
      ? list.length + (list.length === 1 ? " round recorded" : " rounds recorded")
      : mine + "–" + theirs + " on rounds";
  }
}

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

  renderScoreline(s.rounds);

  const change = s.ratingChange;
  // The change is the news and the new rating is the context, so they stop being one
  // run-on mono string with a middot in it.
  $("ratingMove").innerHTML = isSeeding
    ? 'not rated<span class="after">seeding</span>'
    : isVoid ? 'no change<span class="after">void</span>'
    : `${change >= 0 ? "+" : "−"}${Math.abs(change)}` +
      `<span class="after">rating ${esc(String(s.ratingAfter))}</span>`;
  $("ratingMove").style.color = isSeeding || isVoid
    ? "var(--ink-dim)"
    : change > 0 ? "var(--up)" : change < 0 ? "var(--down)" : "var(--ink-mid)";

  $("explain").textContent = s.explanation;

  const body = $("roundsBody");
  settled(body);
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
      '<div class="lbl">' + esc(cat.name) + "</div>" +
      '<div class="wtrack"><div class="wfill" style="width:' +
        ((cat.energy / maxEnergy) * 100).toFixed(1) +
        "%;background:" + esc(ink) + '"></div></div>' +
      '<div class="wval">' + num(cat.energy) + " · " +
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
        "<td>" + (s.score ? num(s.score) : "—") + "</td>" +
        '<td style="color:' + esc(ink) + '">' + esc(s.rankName || "—") + "</td>" +
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

  const body = $("consistencyBody");
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

function renderQuests(data) {
  const host = $("questList");
  host.textContent = "";
  data.quests.forEach((q) => {
    // Two colours, and both of them mean something.
    //
    // Every quest used to take `theme[3 + i]` - the i-th tier's colour, by row position.
    // It said nothing: the fourth quest was blue because it was fourth. Five saturated
    // ramp colours down one column is the rainbow this client is otherwise careful not
    // to be, and it made five bars compete when the list has no ranking in it.
    //
    // A floor quest is warn because it is a different ask: every run in the window has
    // to clear the bar, not one of them. Everything else takes the player's own rank
    // colour, which is what carries chroma everywhere else here.
    const colour = q.isFloor ? "var(--warn)" : "var(--accent)";

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
      '<div class="qtrack"><div class="qfill" style="transform:scaleX(' +
        Math.max(0, Math.min(1, q.progress)).toFixed(4) +
        ");background:" + esc(colour) + '"></div></div>';
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
  setFill($("celebrateFill"), 0);
  requestAnimationFrame(() => {
    setFill($("celebrateFill"), level.progress);
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
  setFill($("queueGateFill"), uploaded / required);
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
      s.justDone = true;
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
    return " \u00b7 eligible for " + p.rankName + ", once you are on the board";
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
    // The refresh runs before the read and is allowed to fail - a rate limit is the
    // likely cause and the board is still worth showing. Saying so beats letting a
    // standing that did not update look like one that did.
    const stale = apexBoard.refreshed === false ? " \u00b7 not refreshed just now" : "";
    note.textContent =
      mine + " \u00b7 " + num(apexBoard.population) + " ranked" + stale + positionalNote();
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

if (hasSeasonEditor) {
  void refreshAdminTabs();

  $("seasonSave").addEventListener("click", async () => {
    const btn = $("seasonSave");
    btn.disabled = true;
    setSeasonStatus("saving…", "");

    // The rating ladder first, and only when it changed. It is a separate file, so a
    // season that saves while the ranks fail to leaves the two disagreeing - and the
    // ranks are the cheaper of the two to redo.
    if (rankThemeDirty && rankTheme && window.apogee.saveRankTheme) {
      const ranks = await window.apogee.saveRankTheme(rankTheme, rankThemeFingerprint, seasonForce);
      if (ranks && ranks.error) {
        setSeasonStatus(ranks.error, "bad");
        if (ranks.stale) seasonForce = true;
        btn.disabled = false;
        return;
      }
      rankThemeDirty = false;
      if (window.apogee.getRankTheme) {
        const fresh = await window.apogee.getRankTheme();
        if (fresh && !fresh.error) rankThemeFingerprint = fresh.fingerprint ?? null;
      }
    }

    const result = await window.apogee.saveSeason(seasonDraft, seasonFingerprint, seasonForce);

    if (result && result.error) {
      // Say what is wrong and leave the draft alone: the numbers on screen are the ones
      // that need fixing, so throwing them away would be the worst possible response.
      //
      // A stale draft is the one case where the draft is the problem rather than the
      // numbers in it, so the message points at Discard - which is the only way out, and
      // is not obvious from a status line that has only ever meant "fix this row".
      setSeasonStatus(result.error, "bad");
      // Arm the override rather than blocking. The draft on screen can be the only copy of
      // an afternoon's work, and a guard whose only other exit is Discard trades "you might
      // overwrite the file" for "you will certainly lose your own".
      if (result.stale) seasonForce = true;
      btn.disabled = false;
      return;
    }
    seasonForce = false;

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
    // Drawn on the way in rather than at boot: the editors are cheap to build and stale
    // the moment the season or a save lands, so the screen is always redrawn from the
    // draft it is about to show.
    if (tab.dataset.screen === "admin") renderAdmin();
  });
});

if ($("bandBack")) {
  $("bandBack").addEventListener("click", () => {
    const tab = document.querySelector('.tab[data-screen="ranks"]');
    if (tab) tab.click();
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
    $("oppTier").style.color = legibleOnDark(me.tier.color, RANK_TEXT_CONTRAST);
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
    $("oppTier").style.color = legibleOnDark(oppTier.color, RANK_TEXT_CONTRAST);

    const played = new Date(match.opponent.playedAt);
    const days = Math.max(0, Math.round((Date.now() - played.getTime()) / 86400000));
    $("oppAge").textContent =
      `stored run · ${days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago"}` +
      ` · pool of ${match.poolSize}`;

    const p = match.winProbability ?? 0.5;
    drawOdds(p, me.tier.color);
    $("oddsYou").textContent = "you " + (p * 100).toFixed(0) + "%";
    $("oddsThem").textContent = (100 - p * 100).toFixed(0) + "% " + match.opponent.displayName;
  }

  pendingScenarios = match.scenarios.map((s) => ({
    id: s.id,
    label: s.name,
    done: false,
    tier: null,
  }));
  renderTodo(true);

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
    return;
  }

  btn.disabled = true;
  setCommit("working", "Searching", "matching you on rating in " +
    (!selectedCategory || selectedCategory === "Any" ? "any category" : selectedCategory), "0:00");
  startSearchClock();
  $("opponent").classList.remove("on");
  showError(null);

  const result = await window.apogee.findMatch(selectedCategory, current.benchmark.matchPool);

  stopSearchClock();
  btn.disabled = false;

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
  setCommit(
    "held",
    result.match.resumed
      ? "Match already open"
      : result.match.seeding
        ? "Seeding the pool"
        : "Match in progress",
    "Play the three below in KovaaK's. Abandon it to queue again.",
    "",
  );
  // Nothing to press while a match is open; the way out is Abandon, on the match.
  btn.disabled = true;
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
  const root = getComputedStyle(document.documentElement);
  for (const spec of adminSpec.tokens) {
    const raw = root.getPropertyValue(spec.name).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(raw)) tokenDefaults[spec.name] = raw;
  }
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

// Before anything can paint over them. Everything below reads these as the value to
// go back to, so they have to be taken while they are still the only value there is.
captureCopyDefaults();

if (HOST === "electron") {
  reserveTables();

  wireAdmin();
  void loadAdminLook();

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
      $("opponent").classList.remove("on");
      $("matchActions").hidden = true;
      resetCommit(current);
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
    resetCommit(current);
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

  // The band page is drawn from the snapshot, so a run landing while it is open has to
  // redraw it. `render` does not, because the page is not part of the snapshot's own tree.
  api.onSnapshot(() => renderBand());

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
  if (el.classList.contains("commit")) return "press";
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
