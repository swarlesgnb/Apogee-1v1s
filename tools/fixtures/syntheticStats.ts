/**
 * A synthetic KovaaK's stats folder, so the app can be run and measured without anybody's
 * real history.
 *
 * Nothing in this repository can be exercised end to end without a stats folder, and the
 * only one the code has ever seen is the owner's, on a Windows drive. This writes one that
 * the real parser reads and the real verification grades Consistent: the same three-block
 * layout (`parseStatsFile.ts`), counters that agree with each other the way every hard check
 * in `verify/consistency.ts` demands, and, where the repository has learned a scenario's
 * scoring relation (`data/score_models.json`), scores that follow it.
 *
 * Where the numbers come from:
 *
 *   SEASON 1    Each Apogee scenario's own file (`data/season-1/scenarios/*.sce`) supplies
 *               its scoring rule (ScorePerKill, ScorePerHit, ScorePerDamage,
 *               ScoreLossPerMiss), its length, the player's weapon (damage and fire rate)
 *               and the bot's health. A run's counters are drawn first and its score is
 *               computed from them by that rule, so the file says what KovaaK's would have
 *               written. Score levels are placed on the scenario's own rank thresholds
 *               (`rankMaxes`), across bands that overlap by two ranks as the season does.
 *               The `Hash:` line is the MD5 of the committed file, which is what
 *               `hash_known` holds Apogee's scenarios to on the server.
 *
 *   LIBRARY     Scenarios with both a learned score model and a weapon model plus a known
 *               world record, so every hard check that can apply does apply. The counters
 *               are solved so `score = stat * k`, `score = Damage Done * scorePerDamage` and
 *               `Damage Possible = Shots * damagePerShot` all hold, and tick-fire scenarios
 *               (`shotRates`) stay under their firing ceiling. Scores stay under the world
 *               record. The Voltaic S5 Intermediate set (the default benchmark's) is always
 *               in the pool; the rest is drawn by popularity.
 *
 *   A PLAYER    Play days ending today (and yesterday, so a streak exists), sessions of
 *               back-to-back runs at a minute plus loading each, playlists of a few
 *               scenarios repeated two to six times, a learning curve over the whole
 *               history, a warm-up dip at the start of each session, day-to-day form and
 *               per-run noise. Season scenarios only appear in the last `seasonDays` days,
 *               because they did not exist before the season shipped.
 *
 * Seeded: the same options and the same `end` give the same bytes. Without `end` the
 * history ends at the moment it is generated, which is what the app needs for "today".
 *
 *   npx tsx tools/fixtures/syntheticStats.ts --out <dir> [--preset new|regular|veteran]
 *        [--runs N] [--seed N] [--end 2026-10-03T18:00] [--season-days N] [--clean]
 *   npx tsx tools/fixtures/syntheticStats.ts --out <dir> --one [--count N] [--scenario <name>]
 *
 * `--one` adds a single run ending now to an existing folder, for timing how long a new
 * run takes to reach the screen. The app writes Apogee's scenario files and playlists into
 * `<dir>/../Saved/SaveGames/`, as it does beside a real stats folder, so give it a folder
 * of its own: `--out .cache/fixture/veteran/stats` rather than a bare temporary root.
 *
 * What it is not: a model of how any real player improves, or of KovaaK's file format
 * beyond what this repository reads. Fields the parser ignores are written with plausible
 * constant values. It cannot stand in for the corpus measurements in `validate:verify`:
 * those prove the checks pass on real runs, and a generator built to pass them proves
 * nothing about that.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { get, list, num, parseSce, profile, sections } from "../../src/core/scenario/sce.ts";

const DATA = fileURLToPath(new URL("../../data/", import.meta.url));

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface SyntheticOptions {
  /** Stats files to write. */
  runs: number;
  /** PRNG seed. */
  seed?: number;
  /** The last run ends shortly before this instant. Defaults to now. */
  end?: Date;
  /** How many days before `end` the season scenarios have existed. */
  seasonDays?: number;
  /** Share of sessions in the season period that are spent on season scenarios. */
  seasonShare?: number;
  /** Skill at the first run and at the last, 0..1 (0.6 is around the Advanced band). */
  skillStart?: number;
  skillEnd?: number;
  /** Mean runs on a day the game was opened. Measured median on a real corpus: 42. */
  runsPerDay?: number;
  /** Share of calendar days on which the game is opened at all. */
  playRate?: number;
  /** How many library scenarios this player rotates through. */
  librarySize?: number;
}

export type PresetName = "new" | "regular" | "veteran";

/**
 * Three players the app has to work for. `new` has fewer runs than ranked's 50-run gate,
 * `regular` plays a few weeks of evenings, and `veteran` has the size of the folder the
 * cold-start measurements in folderCache.ts were taken on, and then some.
 */
export const PRESETS: Record<PresetName, Required<Omit<SyntheticOptions, "seed" | "end">>> = {
  new: { runs: 30, seasonDays: 21, seasonShare: 0.5, skillStart: 0.08, skillEnd: 0.13, runsPerDay: 15, playRate: 1, librarySize: 6 },
  regular: { runs: 1500, seasonDays: 21, seasonShare: 0.55, skillStart: 0.15, skillEnd: 0.4, runsPerDay: 35, playRate: 0.7, librarySize: 24 },
  veteran: { runs: 15000, seasonDays: 28, seasonShare: 0.6, skillStart: 0.2, skillEnd: 0.62, runsPerDay: 42, playRate: 0.75, librarySize: 60 },
};

/** A preset's numbers for any run count: the nearest preset by size, resized. */
export function optionsFor(runs: number): Required<Omit<SyntheticOptions, "seed" | "end">> {
  const base = runs <= 100 ? PRESETS.new : runs <= 4000 ? PRESETS.regular : PRESETS.veteran;
  return { ...base, runs };
}

// ---------------------------------------------------------------------------
// seeded randomness
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and good enough to make a history look lived in. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Dice {
  constructor(private readonly next: () => number) {}
  float(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hi: number): number {
    return Math.floor(this.float(lo, hi + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  gauss(sd = 1): number {
    const u = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next()) * sd;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    const total = items.reduce((s, t) => s + Math.max(0, weight(t)), 0);
    let r = this.next() * total;
    for (const t of items) {
      r -= Math.max(0, weight(t));
      if (r <= 0) return t;
    }
    return items[items.length - 1];
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

/** A stable number from a string, so per-scenario traits do not depend on draw order. */
function hashSeed(text: string): number {
  return createHash("md5").update(text).digest().readUInt32LE(0);
}

// ---------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------

/** How a scenario turns counters into a score, and what the file has to agree with. */
export interface ScenarioSpec {
  name: string;
  source: "season" | "library";
  seconds: number;
  hash: string;
  bot: string;
  weapon: string;
  /** Damage per landed shot, and per shot fired (they differ under a headshot multiplier). */
  damagePerHit: number;
  damagePerShot: number;
  /** Hits a target takes to die. Infinity for a target that cannot. */
  hitsPerKill: number;
  /** Shots the weapon fires per held second, or null for a click-per-shot weapon. */
  ticksPerSecond: number | null;
  /** Upper bound on clicks per second. */
  maxShotsPerSecond: number;
  /** score = kills*perKill + hits*perHit + damage*perDamage - misses*perMiss */
  perKill: number;
  perHit: number;
  perDamage: number;
  perMiss: number;
  /** Library only: the world record, never exceeded. */
  worldRecord: number | null;
  /** Season only: the scenario's band and its own rank thresholds. */
  window: number | null;
  category: string | null;
  rankMaxes: number[] | null;
}

interface SeasonFile {
  windows: string[];
  scenarios: { scenario: string; category: string; window: number; rankMaxes: number[] }[];
}

interface ScoreModels {
  models: Record<string, { stat: "kills" | "hitCount" | "damageDone"; k: number }>;
  weaponModels: Record<string, { scorePerDamage: number; damagePerShot: number }>;
  shotRates: Record<string, number>;
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA, ...segments), "utf8")) as T;
}

let catalogCache: { season: ScenarioSpec[]; library: ScenarioSpec[] } | null = null;

/** Every scenario the generator can write, read once from the committed data. */
export function catalog(): { season: ScenarioSpec[]; library: ScenarioSpec[] } {
  if (catalogCache) return catalogCache;

  const season = readJson<SeasonFile>("seasons", "season-1.json");
  const seasonSpecs: ScenarioSpec[] = [];
  for (const s of season.scenarios) {
    const path = join(DATA, "season-1", "scenarios", `${s.scenario}.sce`);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    const sce = parseSce(bytes.toString("utf8"));
    const head = sce.head;

    const player = profile(sce, "Character Profile", get(head, "PlayerProfile") ?? list(get(head, "PlayerCharacters"))[0] ?? "");
    const weaponName = list(player ? get(player.lines, "WeaponProfileNames") : undefined)[0];
    const weapon = (weaponName && profile(sce, "Weapon Profile", weaponName)) || sections(sce, "Weapon Profile")[0];
    const botProfile = sections(sce, "Bot Profile")[0];
    const botChar = botProfile ? profile(sce, "Character Profile", get(botProfile.lines, "CharacterProfile") ?? "") : undefined;

    const damagePerShot = weapon ? num(weapon.lines, "DamagePerShot", 1) : 1;
    const between = weapon ? num(weapon.lines, "TimeBetweenShots", 0.1) : 0.1;
    const auto = weapon ? get(weapon.lines, "Category") === "FullyAuto" : false;
    const health = botChar ? num(botChar.lines, "MaxHealth", 1) : 1;
    const hitsPerKill = damagePerShot > 0 ? Math.ceil(health / damagePerShot - 1e-9) : Infinity;

    seasonSpecs.push({
      name: s.scenario,
      source: "season",
      seconds: Math.round(num(head, "Timelimit", 60) / num(head, "Timescale", 1)),
      hash: createHash("md5").update(bytes).digest("hex"),
      bot: (botProfile && get(botProfile.lines, "Name")) || "Target",
      weapon: (weapon && get(weapon.lines, "Name")) || "BB Gun",
      damagePerHit: damagePerShot,
      damagePerShot,
      // A target that takes hundreds of hits is one that is not meant to die in a run.
      hitsPerKill: hitsPerKill > 400 ? Infinity : Math.max(1, hitsPerKill),
      ticksPerSecond: auto ? 1 / between : null,
      maxShotsPerSecond: Math.min(1 / between, 8),
      perKill: num(head, "ScorePerKill", 0),
      perHit: num(head, "ScorePerHit", 0),
      perDamage: num(head, "ScorePerDamage", 0),
      perMiss: num(head, "ScoreLossPerMiss", 0),
      worldRecord: null,
      window: s.window,
      category: s.category,
      rankMaxes: s.rankMaxes,
    });
  }

  const models = readJson<ScoreModels>("score_models.json");
  const taxonomy = readJson<{ scenarios: { name: string; topScore: number | null; plays: number | null }[] }>(
    "scenario_taxonomy.json",
  );
  const durations = new Map(
    readJson<{ durations: { scenario: string; seconds: number | null }[] }>("scenario_durations.json").durations
      .filter((d) => d.seconds != null)
      .map((d) => [d.scenario, d.seconds!]),
  );
  const library: (ScenarioSpec & { plays: number })[] = [];
  for (const t of taxonomy.scenarios) {
    const model = models.models[t.name];
    const weaponModel = models.weaponModels[t.name];
    if (!model || !weaponModel || !t.topScore || t.topScore <= 0) continue;
    // A name that cannot be a Windows file name never reaches a real stats folder.
    if (t.name !== t.name.trim() || /[<>:"/\\|?*]/.test(t.name)) continue;
    const tickRate = models.shotRates[t.name] ?? null;

    // Damage per hit is what makes the summary model and the weapon model one relation.
    // `damageDone` models score damage directly, so they need the two rates to agree.
    let damagePerHit: number;
    let perKill = 0;
    let perHit = 0;
    let perDamage = 0;
    if (model.stat === "damageDone") {
      if (Math.abs(model.k - weaponModel.scorePerDamage) / weaponModel.scorePerDamage > 0.001) continue;
      damagePerHit = weaponModel.damagePerShot;
      perDamage = model.k;
    } else {
      damagePerHit = model.k / weaponModel.scorePerDamage;
      if (model.stat === "kills") perKill = model.k;
      else perHit = model.k;
    }
    // A kills model on a tick-fire weapon would need kills that do not come from hits.
    if (model.stat === "kills" && tickRate) continue;

    // Tracking scenarios score per tick, and not every one has a learned tick rate (that
    // needs the fastest and median runs to agree). One whose record needs more hits a
    // second than anyone can click is held, at a rate that reaches the record.
    const seconds = durations.get(t.name) ?? 60;
    const hitValue = perHit + damagePerHit * perDamage + perKill;
    const recordHitsPerSecond = t.topScore / hitValue / seconds;
    let ticks = tickRate;
    if (!ticks && recordHitsPerSecond > 6) {
      if (model.stat === "kills") continue;
      ticks = Math.max(20, Math.ceil(recordHitsPerSecond / 0.9 / 10) * 10);
    }

    library.push({
      name: t.name,
      source: "library",
      seconds,
      hash: createHash("md5").update(`library:${t.name}`).digest("hex"),
      bot: "Target",
      weapon: ticks ? "LG" : "pistol",
      damagePerHit,
      damagePerShot: weaponModel.damagePerShot,
      hitsPerKill: ticks ? Infinity : 1,
      ticksPerSecond: ticks,
      maxShotsPerSecond: 8,
      perKill,
      perHit,
      perDamage,
      perMiss: 0,
      worldRecord: t.topScore,
      window: null,
      category: null,
      rankMaxes: null,
      plays: t.plays ?? 0,
    });
  }
  library.sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));

  catalogCache = { season: seasonSpecs, library };
  return catalogCache;
}

// ---------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------

export interface RunCounters {
  kills: number;
  hits: number;
  shots: number;
  score: number;
}

/** score from counters, by the scenario's own rule. */
export function scoreOf(spec: ScenarioSpec, c: Omit<RunCounters, "score">): number {
  const misses = c.shots - c.hits;
  return (
    c.kills * spec.perKill + c.hits * spec.perHit + c.hits * spec.damagePerHit * spec.perDamage - misses * spec.perMiss
  );
}

/** What a hit is worth on this scenario, kills and damage included. */
function valuePerHit(spec: ScenarioSpec): number {
  const killShare = Number.isFinite(spec.hitsPerKill) ? spec.perKill / spec.hitsPerKill : 0;
  return spec.perHit + spec.damagePerHit * spec.perDamage + killShare;
}

/**
 * Counters that land near a target score. The score itself is then computed from them, so
 * the file is coherent however far the draw is from the target.
 */
export function countersFor(spec: ScenarioSpec, target: number, skill: number, dice: Dice): RunCounters {
  const v = valuePerHit(spec);
  let hits: number;
  let shots: number;

  if (spec.ticksPerSecond) {
    // The trigger is held: shots are the clock, and the score decides how many of them hit.
    // 0.985 to 0.999 of every tick keeps clear of the firing-rate ceiling's 1.1 headroom.
    shots = Math.round(spec.seconds * spec.ticksPerSecond * dice.float(0.985, 0.999));
    hits = Math.round(Math.max(target, 0) / Math.max(v, 1e-9));
    hits = Math.max(0, Math.min(hits, Math.round(shots * 0.97)));
  } else {
    // Clicking: accuracy rises with skill, and the shots are what the score needs at it.
    const accuracy = Math.min(0.97, Math.max(0.45, 0.66 + 0.28 * skill + dice.gauss(0.04)));
    const perShot = accuracy * v - (1 - accuracy) * spec.perMiss;
    shots = Math.max(1, Math.round(Math.max(target, v) / Math.max(perShot, 1e-9)));
    shots = Math.min(shots, Math.floor(spec.seconds * spec.maxShotsPerSecond));
    hits = Math.max(1, Math.min(shots, Math.round(shots * accuracy)));
  }

  const kills = Number.isFinite(spec.hitsPerKill) ? Math.floor(hits / spec.hitsPerKill) : 0;
  const counters = { kills, hits, shots };
  return { ...counters, score: scoreOf(spec, counters) };
}

/** `1020.0`, `4521.312`: KovaaK's prints at least one decimal and never an exponent. */
function fmt(value: number, decimals = 6): string {
  const fixed = value.toFixed(decimals).replace(/0+$/, "");
  return fixed.endsWith(".") ? `${fixed}0` : fixed;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `21:05:28.997` from a local Date. */
function clock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/** `VT Frogtagon Intermediate S5 - Challenge - 2026.08.15-21.06.28 Stats.csv`, local time. */
export function fileNameFor(scenario: string, endedAt: Date): string {
  const d = endedAt;
  return (
    `${scenario} - Challenge - ${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}-` +
    `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())} Stats.csv`
  );
}

const KILL_HEADER =
  "Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,Efficiency,Cheated,OverShots";
const WEAPON_HEADER =
  "Weapon,Shots,Hits,Damage Done,Damage Possible,,Sens Scale,Horiz Sens,Vert Sens,FOV,Hide Gun,Crosshair," +
  "Crosshair Scale,Crosshair Color,ADS Sens,ADS Zoom Scale,Avg Target Scale,Avg Time Dilation";

/**
 * The file KovaaK's writes when a run ends: per-kill rows, the weapon block, the tail.
 *
 * `endedAt` is when the file was written (the filename's stamp, whole seconds), and the
 * run started `spec.seconds` plus a fraction earlier, which is how `runDurationSeconds`
 * reads it back.
 */
export function renderRun(spec: ScenarioSpec, c: RunCounters, endedAt: Date, dice: Dice): string {
  const startedAt = new Date(endedAt.getTime() - spec.seconds * 1000 - dice.int(80, 900));
  const misses = c.shots - c.hits;
  const lines: string[] = [KILL_HEADER];

  if (c.kills > 0) {
    // Misses before each kill, at random; whatever is left over came after the last one.
    const weights = Array.from({ length: c.kills }, () => dice.float(0.2, 1.8));
    const sum = weights.reduce((a, b) => a + b, 0);
    const trailing = Math.round(misses * dice.float(0, 0.1));
    let left = misses - trailing;
    const span = spec.seconds * 1000 - 300;
    let previous = startedAt.getTime() + 150;
    for (let i = 0; i < c.kills; i++) {
      const missed = i === c.kills - 1 ? left : Math.min(left, Math.round(((misses - trailing) * weights[i]) / sum));
      left -= missed;
      // One slot per kill, a random point inside it: monotonic by construction.
      const at = startedAt.getTime() + 150 + Math.round(span * ((i + dice.float(0.15, 0.95)) / c.kills));
      const shots = spec.hitsPerKill + missed;
      const ttk = Math.max(0, (at - previous) / 1000);
      previous = at;
      const damageDone = spec.hitsPerKill * spec.damagePerHit;
      const damagePossible = shots * spec.damagePerShot;
      lines.push(
        [
          i + 1,
          clock(new Date(at)),
          spec.bot,
          spec.weapon,
          `${ttk.toFixed(6)}s`,
          shots,
          spec.hitsPerKill,
          (spec.hitsPerKill / shots).toFixed(6),
          damageDone.toFixed(6),
          damagePossible.toFixed(6),
          (damagePossible > 0 ? damageDone / damagePossible : 0).toFixed(6),
          "false",
          0,
        ].join(","),
      );
    }
  }

  const damageDone = c.hits * spec.damagePerHit;
  const damagePossible = c.shots * spec.damagePerShot;
  const sens = "0.35";
  lines.push(
    "",
    WEAPON_HEADER,
    [spec.weapon, c.shots, c.hits, fmt(damageDone), fmt(damagePossible), "", "Valorant", sens, sens, "103.0",
      "true", "default.png", "1.0", "FFFFFF", "1.0", "1.0", "1.0", "1.0"].join(","),
    "",
  );

  const avgTtk = c.kills > 0 ? (spec.seconds / c.kills).toFixed(6) : "0.000000";
  const tail: [string, string][] = [
    ["Kills", String(c.kills)],
    ["Deaths", "0"],
    ["Fight Time", fmt(spec.seconds + dice.float(0, 0.01), 3)],
    ["Avg TTK", avgTtk],
    ["Damage Done", fmt(damageDone)],
    ["Damage Taken", "0.0"],
    ["Midairs", "0"],
    ["Midaired", "0"],
    ["Directs", "0"],
    ["Directed", "0"],
    ["Distance Traveled", "0.0"],
    ["Hit Count", String(c.hits)],
    ["Miss Count", String(misses)],
    ["Score", fmt(c.score)],
    ["Scenario", spec.name],
    ["Hash", spec.hash],
    ["Game Version", "3.7.0.2025-06-16-11-28-40-8b3a2c5d3e"],
    ["Challenge Start", clock(startedAt)],
    ["Input Lag", "0"],
    ["Max FPS (config)", "0"],
    ["Sens Scale", "Valorant"],
    ["Sens Increment", "0.0"],
    ["Horiz Sens", sens],
    ["Vert Sens", sens],
    ["FOV", "103.0"],
    ["FOVScale", "Overwatch"],
    ["Hide Gun", "true"],
    ["Crosshair", "default.png"],
    ["Crosshair Scale", "1.0"],
    ["Crosshair Color", "FFFFFF"],
    ["Resolution", "1920x1080"],
    ["Avg FPS", (238 + dice.gauss(3)).toFixed(1)],
    ["Resolution Scale", "100.0"],
    ["Pause Count", "0"],
    ["Pause Duration", "0.0"],
  ];
  for (const [key, value] of tail) lines.push(`${key}:,${value}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// skill to score
// ---------------------------------------------------------------------------

/** Ranks per band and how far each band starts above the last (season-1.json: 6 and 4). */
const BAND_RANKS = 6;
const BAND_STEP = 4;

/** Where on the whole season ladder (rank index across bands) a skill sits. */
function ladderPosition(skill: number): number {
  return skill * 17 - 1.5;
}

/** A score on a season scenario at a position on its own band's thresholds. */
function seasonScore(spec: ScenarioSpec, skill: number): number {
  const r = spec.rankMaxes!;
  const p = ladderPosition(skill) - BAND_STEP * (spec.window ?? 0);
  if (p < 0) return r[0] * Math.max(0.35, 1 + 0.45 * Math.max(p, -1.4));
  const top = r.length - 1;
  if (p >= top) {
    const step = r.length > 1 ? r[top] - r[top - 1] : r[top] * 0.05;
    return r[top] + step * Math.min(p - top, 1.5);
  }
  const lo = Math.floor(p);
  return r[lo] + (r[lo + 1] - r[lo]) * (p - lo);
}

function libraryScore(spec: ScenarioSpec, skill: number): number {
  return spec.worldRecord! * Math.min(0.9, Math.max(0.08, 0.22 + 0.7 * skill));
}

/** Which bands a skill plays: the one it is mid-way up, most. */
function bandWeight(window: number, skill: number): number {
  const p = ladderPosition(skill) - BAND_STEP * window;
  if (p < -2 || p > BAND_RANKS + 1) return 0;
  return Math.exp(-(((p - 2.5) / 1.8) ** 2));
}

// ---------------------------------------------------------------------------
// a history
// ---------------------------------------------------------------------------

export interface SyntheticRun {
  file: string;
  content: string;
  scenario: string;
  source: "season" | "library";
  score: number;
  endedAt: Date;
}

const DAY_MS = 86_400_000;

function localMidnight(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

function addDays(day: Date, days: number): Date {
  // Calendar arithmetic, not milliseconds, so a DST change does not shift the day.
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

/**
 * Every run of a synthetic history, oldest first.
 *
 * A generator so 15,000 runs need not be held in memory at once.
 */
export function* generateRuns(options: SyntheticOptions): Generator<SyntheticRun> {
  const o = { ...optionsFor(options.runs), ...stripUndefined(options) };
  const seed = options.seed ?? 1;
  const dice = new Dice(rng(seed));
  const end = options.end ?? new Date();
  const { season, library: allLibrary } = catalog();

  // The player's library: the default benchmark's Intermediate set they grind, plus
  // whatever else is popular, rotated by taste.
  const benchmark = allLibrary.filter((s) => / Intermediate S5$/.test(s.name) && s.name.startsWith("VT "));
  const rest = allLibrary.filter((s) => !benchmark.includes(s));
  const fromBenchmark = Math.min(benchmark.length, Math.max(3, Math.round(o.librarySize / 3)));
  const library = [
    ...benchmark.slice(0, fromBenchmark),
    ...dice.shuffle(rest.slice(0, 120)).slice(0, Math.max(0, o.librarySize - fromBenchmark)),
  ];
  const favourite = new Map(library.map((s, i) => [s.name, 1 / (1 + i * 0.15)]));

  // Per-scenario aptitude: some categories come easier than others, and the same scenario
  // always comes out the same way for a given seed.
  const aptitude = (name: string) => (rng(hashSeed(`${seed}:${name}`))() - 0.5) * 0.08;

  // -- calendar ------------------------------------------------------------
  const today = localMidnight(end);
  const playDays = Math.max(1, Math.ceil(o.runs / o.runsPerDay));
  const span = Math.max(playDays, Math.ceil(playDays / o.playRate));
  const days: Date[] = [];
  for (let back = span - 1; back >= 0; back--) {
    const day = addDays(today, -back);
    // Today and yesterday always, so a streak and a "played today" exist.
    if (back <= 1 || dice.chance(o.playRate)) days.push(day);
  }
  while (days.length > playDays && days.length > 2) days.splice(dice.int(0, days.length - 3), 1);

  // Runs per day: uneven, the way real days are (median 42, busiest 207 on the corpus).
  const shares = days.map(() => Math.max(0.15, -Math.log(Math.max(dice.float(), 1e-6))));
  const shareSum = shares.reduce((a, b) => a + b, 0);
  const perDay = shares.map((s) => Math.max(1, Math.floor((o.runs * s) / shareSum)));
  let assigned = perDay.reduce((a, b) => a + b, 0);
  for (let i = perDay.length - 1; assigned < o.runs; i = (i - 1 + perDay.length) % perDay.length) {
    perDay[i]++;
    assigned++;
  }
  for (let i = 0; assigned > o.runs; i = (i + 1) % perDay.length) {
    if (perDay[i] > 1) {
      perDay[i]--;
      assigned--;
    }
  }
  // Today only has the hours before `end` in it. Whatever does not fit was played on the
  // days before, so the folder still holds the number of runs asked for.
  const RUN_MS = 85_000;
  const todayCapacity = Math.max(1, Math.floor((end.getTime() - today.getTime() - 30 * 60_000) / RUN_MS));
  const last = perDay.length - 1;
  if (perDay[last] > todayCapacity && last > 0) {
    let excess = perDay[last] - todayCapacity;
    perDay[last] = todayCapacity;
    for (let i = last - 1; excess > 0; i = i > 0 ? i - 1 : last - 1, excess--) perDay[i]++;
  }

  const seasonFrom = addDays(today, -(o.seasonDays - 1)).getTime();
  const runsOn = new Map<string, number>();
  let index = 0;

  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    const count = perDay[d];
    const isToday = day.getTime() === today.getTime();
    const seasonOpen = day.getTime() >= seasonFrom;
    const form = dice.gauss(0.025);

    // Lay the day's runs out as sessions, then place them on the clock.
    const plan: { spec: ScenarioSpec; warm: number }[] = [];
    while (plan.length < count) {
      const sessionRuns = Math.min(count - plan.length, Math.max(4, Math.round(dice.float(12, 45))));
      const skillNow = skillAt(o, index + plan.length);
      const onSeason = seasonOpen && dice.chance(o.seasonShare);
      let picks: ScenarioSpec[];
      if (onSeason) {
        const windows = [...new Set(season.map((s) => s.window!))];
        const w = dice.weighted(windows, (win) => bandWeight(win, skillNow) + 0.001);
        const inBand = season.filter((s) => s.window === w);
        picks = dice.shuffle([...inBand]).slice(0, dice.int(3, 6));
      } else {
        picks = [];
        const want = Math.min(library.length, dice.int(3, 8));
        while (picks.length < want) {
          const s = dice.weighted(library, (x) => (picks.includes(x) ? 0 : favourite.get(x.name) ?? 0.1));
          picks.push(s);
        }
      }
      let warm = 0;
      while (warm < sessionRuns) {
        for (const spec of picks) {
          const reps = dice.int(2, 6);
          for (let r = 0; r < reps && warm < sessionRuns; r++) {
            plan.push({ spec, warm });
            warm++;
          }
          if (warm >= sessionRuns) break;
        }
      }
    }

    // Seconds each run takes from one file to the next: the run, then loading and a breath.
    const gaps = plan.map(
      (p, i) => p.spec.seconds + dice.int(6, 22) + (!isToday && i > 0 && p.warm === 0 ? dice.int(600, 3600) : 0),
    );
    const total = gaps.reduce((a, b) => a + b, 0);
    let startMs: number;
    if (isToday) {
      // Today's play finished a few minutes ago.
      startMs = end.getTime() - dice.int(4, 25) * 60_000 - total * 1000;
      startMs = Math.max(startMs, day.getTime() + 60_000);
    } else {
      const latestStart = day.getTime() + DAY_MS - 10 * 60_000 - total * 1000;
      startMs = Math.min(day.getTime() + dice.int(15 * 60, 21 * 60) * 60_000, latestStart);
      startMs = Math.max(startMs, day.getTime() + 60_000);
    }

    let at = startMs;
    for (let i = 0; i < plan.length; i++) {
      const { spec, warm } = plan[i];
      at += gaps[i] * 1000;
      const endedAt = new Date(Math.floor(at / 1000) * 1000);
      if (endedAt.getTime() > end.getTime()) break; // nothing is played after `end`

      const prior = runsOn.get(spec.name) ?? 0;
      runsOn.set(spec.name, prior + 1);
      const skill = skillAt(o, index) + aptitude(spec.name);
      const familiar = 1 - 0.12 * Math.exp(-prior / 12);
      const warmup = warm === 0 ? -0.04 : warm === 1 ? -0.02 : 0;
      const noise = 1 + form + warmup + dice.gauss(0.035);
      const base = spec.source === "season" ? seasonScore(spec, skill) : libraryScore(spec, skill);
      let target = base * familiar * noise;
      if (spec.worldRecord) target = Math.min(target, spec.worldRecord * 0.95);

      const counters = countersFor(spec, target, skill, dice);
      const content = renderRun(spec, counters, endedAt, dice);
      index++;
      yield {
        file: fileNameFor(spec.name, endedAt),
        content,
        scenario: spec.name,
        source: spec.source,
        score: counters.score,
        endedAt,
      };
    }
  }
}

function skillAt(o: Required<Omit<SyntheticOptions, "seed" | "end">>, index: number): number {
  const x = Math.min(1, index / Math.max(1, o.runs - 1));
  const curve = (1 - Math.exp(-3 * x)) / (1 - Math.exp(-3));
  return o.skillStart + (o.skillEnd - o.skillStart) * curve;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

export interface WriteSummary {
  dir: string;
  files: number;
  seasonRuns: number;
  libraryRuns: number;
  scenarios: number;
  first: Date | null;
  last: Date | null;
  bytes: number;
  ms: number;
}

/**
 * Write a synthetic history into `dir` (created if missing). With `clean`, any stats files
 * already there are removed first, so the folder holds exactly this history.
 *
 * Two runs can end in the same second only if they are the same scenario played twice in
 * a second, which the schedule never does; a collision would overwrite, and is counted.
 */
export function writeStatsFolder(dir: string, options: SyntheticOptions & { clean?: boolean }): WriteSummary {
  const started = performance.now();
  mkdirSync(dir, { recursive: true });
  if (options.clean) {
    for (const f of readdirSync(dir)) if (f.endsWith("Stats.csv")) rmSync(join(dir, f));
  }
  const writtenAt = Date.now();
  const seen = new Set<string>();
  const scenarios = new Set<string>();
  let seasonRuns = 0;
  let libraryRuns = 0;
  let bytes = 0;
  let first: Date | null = null;
  let last: Date | null = null;
  for (const run of generateRuns(options)) {
    const path = join(dir, run.file);
    writeFileSync(path, run.content);
    // The file's own time, so anything that sorts by it sees the history in order. Never in
    // the future, though: the folder cache skips a file modified in the last 400 ms as one
    // still being written, and a history ending later today would be skipped until then.
    const mtime = new Date(Math.min(run.endedAt.getTime(), writtenAt - 1000));
    utimesSync(path, mtime, mtime);
    seen.add(run.file);
    scenarios.add(run.scenario);
    if (run.source === "season") seasonRuns++;
    else libraryRuns++;
    bytes += run.content.length;
    first ??= run.endedAt;
    last = run.endedAt;
  }
  return {
    dir,
    files: seen.size,
    seasonRuns,
    libraryRuns,
    scenarios: scenarios.size,
    first,
    last,
    bytes,
    ms: Math.round(performance.now() - started),
  };
}

/**
 * One more run, ending now, written into an existing folder. For timing the path from a
 * file landing to the screen showing it.
 */
export function appendRun(dir: string, options: { scenario?: string; seed?: number; skill?: number; at?: Date } = {}): SyntheticRun {
  const { season, library } = catalog();
  const all = [...season, ...library];
  const dice = new Dice(rng(options.seed ?? Date.now() % 2 ** 31));
  const spec = options.scenario
    ? all.find((s) => s.name === options.scenario)
    : dice.pick(season.filter((s) => s.window === 0));
  if (!spec) throw new Error(`no scenario named ${options.scenario}`);
  const skill = options.skill ?? 0.3;
  const target = spec.source === "season" ? seasonScore(spec, skill) : libraryScore(spec, skill);
  const counters = countersFor(spec, target, skill, dice);
  const endedAt = new Date(Math.floor((options.at ?? new Date()).getTime() / 1000) * 1000);
  const content = renderRun(spec, counters, endedAt, dice);
  const file = fileNameFor(spec.name, endedAt);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
  return { file, content, scenario: spec.name, source: spec.source, score: counters.score, endedAt };
}

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args: string[]): void {
  const out = flag(args, "--out");
  if (!out) {
    console.error(
      "usage: tsx tools/fixtures/syntheticStats.ts --out <stats dir> [--preset new|regular|veteran] " +
        "[--runs N] [--seed N] [--end ISO] [--season-days N] [--clean] | --one [--count N] [--scenario name]",
    );
    process.exit(2);
  }
  const dir = resolve(out);

  if (args.includes("--one")) {
    // `--count N` writes N runs a run-length apart, the last ending now, for staging several
    // arrivals in one go.
    const count = Math.max(1, Number(flag(args, "--count") ?? 1));
    const seed = Number(flag(args, "--seed") ?? Date.now() % 2 ** 31);
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const run = appendRun(dir, {
        scenario: flag(args, "--scenario"),
        seed: seed + i,
        at: new Date(now - (count - 1 - i) * 75_000),
      });
      console.log(`wrote ${run.file} (score ${run.score})`);
    }
    return;
  }

  const presetName = (flag(args, "--preset") ?? "veteran") as PresetName;
  const preset = PRESETS[presetName];
  if (!preset) {
    console.error(`unknown preset ${presetName}`);
    process.exit(2);
  }
  const runs = Number(flag(args, "--runs") ?? preset.runs);
  const endArg = flag(args, "--end");
  const seasonDays = flag(args, "--season-days");
  const summary = writeStatsFolder(dir, {
    ...(flag(args, "--runs") ? optionsFor(runs) : preset),
    runs,
    seed: Number(flag(args, "--seed") ?? 1),
    end: endArg ? new Date(endArg) : undefined,
    seasonDays: seasonDays ? Number(seasonDays) : undefined,
    clean: args.includes("--clean"),
  });
  console.log(`stats folder : ${summary.dir}`);
  console.log(`runs         : ${summary.files} (${summary.seasonRuns} season, ${summary.libraryRuns} library)`);
  console.log(`scenarios    : ${summary.scenarios}`);
  console.log(`played       : ${summary.first?.toISOString() ?? "-"} .. ${summary.last?.toISOString() ?? "-"}`);
  console.log(`size         : ${(summary.bytes / 1e6).toFixed(1)} MB in ${summary.ms} ms`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
