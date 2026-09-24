/**
 * What a scenario asks of the player, measured from its file.
 *
 * Everything a player feels about a scenario that a file can state is here as a number in
 * the units the player experiences it in: a target's size and speed as angles seen from
 * where the player stands, a flick as the angle between two spawn points, a kill as the
 * time the weapon needs. Raw engine units mean nothing across scenarios - a radius of 60
 * is a large target at a MapScale of 1 and a small one at 10 - so they never leave this
 * file.
 *
 * What a file cannot state is left out rather than guessed: where a moving bot actually
 * goes (its dodge profile says how often it turns, not where it ends up), how a playlist
 * of bot rotations is weighted in practice, and anything that depends on the player's own
 * FOV. The features that survive are the ones `tools/scenarioCorpus.ts` can relate to real
 * leaderboards.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bool, get, list, num, parseSce, profile, sections, type Sce, type SceLine } from "./sce.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TargetFeatures {
  bot: string;
  /** How many of the scenario's simultaneous bots use this profile. */
  count: number;
  shape: string;
  /** World units. */
  radius: number;
  height: number;
  health: number;
  regenPerSec: number;
  /** Top ground speed, world units per second. Zero for a target that never moves. */
  speed: number;
  /** World units per second squared: how sharply it starts, stops and reverses. */
  acceleration: number;
  gravity: number;
  jumpVelocity: number;
  flyer: boolean;
  /** Strafe reversal interval, seconds, from the first dodge profile. */
  strafeMin: number | null;
  strafeMax: number | null;
  jumpFrequency: number | null;
  /** Distances the dodge profile keeps from the player, world units. */
  keepMin: number | null;
  keepMax: number | null;
}

export interface GeometryFeatures {
  source: "embedded" | "embedded-json" | "reflex-file" | "json-file";
  playerSpawns: number;
  botSpawns: number;
  /** Median distance from the player's spawn to a bot spawn, world units. */
  distance: number;
  /**
   * Median angle between two bot spawns seen from the player, degrees. The typical flick on
   * a scenario whose bots appear at random spawns.
   */
  spreadDeg: number;
  /** Full horizontal and vertical extent of the spawn field, degrees. */
  yawExtentDeg: number;
  pitchExtentDeg: number;
  /**
   * Expected angle from a target to the nearest of the others alive with it, degrees, with
   * every alive target at a uniformly random spawn. The flick a player who always takes the
   * closest target makes; equal to a random pair's angle when only two are alive.
   */
  nearestDeg: number;
  /**
   * The distance the main target is actually shot at: its dodge profile's held range when
   * it moves and has one, otherwise `distance`.
   */
  engagement?: number;
}

export interface ScenarioFeatures {
  name: string;
  timelimit: number;
  scoring: {
    perKill: number;
    perDamage: number;
    perTime: number;
    toWin: number;
    accuracyMult: boolean;
    /** With accuracyMult, the score is multiplied by the square root of accuracy instead. */
    sqrtAccuracy: boolean;
    timeRefilledByKill: number;
    lossPerDamageTaken: number;
    perHit: number;
  };
  /**
   * Scenario-wide multipliers newer files carry. `size` scales every target (a "30% smaller"
   * cut is often nothing but `TargetSizeBaseMultiplier=0.7`); `time` is `Timescale` times
   * `TimeDilationBaseMultiplier`, which slows every target alike. `adaptive` marks a file
   * that resizes or slows targets during the run from the player's performance, where no
   * fixed geometry describes what was played.
   */
  multipliers: { size: number; time: number; adaptive: boolean };
  weapon: {
    name: string;
    hitscan: boolean;
    damage: number;
    interval: number;
    /**
     * Fires while held. Read from `Category` (SemiAuto / FullyAuto), not `FullyAutomatic`:
     * the Voltaic S5 tracking gun fires while held and still carries FullyAutomatic=false.
     * Null in older files that have neither.
     */
    fullyAutomatic: boolean | null;
    magazine: number;
    /** Rounds a shot costs. Above one with a magazine is a reload economy: misses cost time. */
    ammoPerShot: number;
  } | null;
  /** Bots alive at once. */
  concurrent: number;
  targets: TargetFeatures[];
  geometry: GeometryFeatures | null;
  mapScale: number;
  /** The quantities a player feels, from the most numerous target. Null where unknowable. */
  derived: {
    /** Angular diameter of the target at the median spawn distance, degrees. */
    targetDeg: number | null;
    /** Target speed as an angular rate at that distance, degrees per second. */
    angularSpeed: number | null;
    /** Fitts' index of difficulty of the typical flick, bits: log2(spread / size + 1). */
    fittsId: number | null;
    /** The same for the flick to the nearest alive target. */
    fittsIdNearest: number | null;
    /** Hits to kill with the player's weapon. */
    shotsToKill: number | null;
    /** Fastest possible kill once on target, seconds. */
    ttk: number | null;
    /** Mean seconds between strafe reversals. */
    strafePeriod: number | null;
  };
}

const RAD = 180 / Math.PI;

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function angleBetween(a: Vec3, b: Vec3): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  return Math.acos(Math.max(-1, Math.min(1, dot / (la * lb)))) * RAD;
}

interface Spawn {
  at: Vec3;
  /** Bitmask: 1 team A may use it, 2 team B may. */
  teams: number;
}

/**
 * Spawns from a Reflex-format map, with Y up rotated to Z up so both formats agree.
 *
 * A Reflex spawn names the team that may *not* use it (`Bool8 teamA 0`), and a spawn
 * naming neither is open to both.
 */
export function reflexSpawns(map: string): Spawn[] {
  const spawns: Spawn[] = [];
  const blocks = map.split(/\n\s*entity\s*\n/);
  for (const block of blocks) {
    if (!/type PlayerSpawn/.test(block)) continue;
    const pos = /Vector3 position (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(block);
    const at = pos ? { x: +pos[1], y: +pos[3], z: +pos[2] } : { x: 0, y: 0, z: 0 };
    let teams = 3;
    if (/Bool8 teamA 0/.test(block)) teams &= ~1;
    if (/Bool8 teamB 0/.test(block)) teams &= ~2;
    spawns.push({ at, teams });
  }
  return spawns;
}

/**
 * Spawns from a KovaaK's Map Creator JSON map, which is already Z up.
 *
 * Bots can also spawn anywhere inside a `SpawnVolume`, a box. It is sampled on a 3x3x3
 * grid of its extent (a unit cube is 100 units, times the object's scale) and the box's
 * rotation is ignored: in the maps measured the volumes are walls or slabs turned about
 * the vertical, which leaves an axis-aligned box's extent unchanged or nearly so.
 */
export function jsonSpawns(json: string): Spawn[] {
  const map = JSON.parse(json) as { objects?: Array<Record<string, unknown>> };
  const spawns: Spawn[] = [];
  const triple = (v: unknown, fallback: number) => {
    const [x, y, z] = String(v ?? "").split(",").map((n) => Number.parseFloat(n));
    return { x: Number.isFinite(x) ? x : fallback, y: Number.isFinite(y) ? y : fallback, z: Number.isFinite(z) ? z : fallback };
  };
  for (const o of map.objects ?? []) {
    if (o.name !== "SpawnPoint" && o.name !== "SpawnVolume") continue;
    const at = triple(o.location, 0);
    const props = (o.properties as Array<{ name: string; value: unknown }>) ?? [];
    const teams = Number(props.find((p) => p.name === "TeamMask")?.value ?? 3) || 3;
    if (o.name === "SpawnPoint") {
      spawns.push({ at, teams });
      continue;
    }
    const scale = triple(o.scale, 1);
    for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) for (const k of [-1, 0, 1]) {
      spawns.push({ at: { x: at.x + i * 50 * scale.x, y: at.y + j * 50 * scale.y, z: at.z + k * 50 * scale.z }, teams });
    }
  }
  return spawns;
}

function mapSpawns(sce: Sce, mapsDir: string | null): { spawns: Spawn[]; source: GeometryFeatures["source"] } | null {
  const embedded = sce.sections.find((s) => s.type === "Map Data")?.raw;
  if (embedded && /type PlayerSpawn/.test(embedded)) {
    return { spawns: reflexSpawns(embedded.replace(/\r\n/g, "\n")), source: "embedded" };
  }
  // Files saved by a 3.x build carry the Map Creator's JSON map verbatim in the same
  // section, which is how a shared scenario takes its map with it.
  if (embedded && embedded.trimStart().startsWith("{")) {
    try {
      const spawns = jsonSpawns(embedded);
      if (spawns.length) return { spawns, source: "embedded-json" };
    } catch {
      /* fall through to the named map file */
    }
  }
  const name = get(sce.head, "MapName");
  if (!name || !mapsDir) return null;
  const file = join(mapsDir, name);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (name.endsWith(".json")) return { spawns: jsonSpawns(text), source: "json-file" };
  return { spawns: reflexSpawns(text.replace(/\r\n/g, "\n")), source: "reflex-file" };
}

/**
 * Split spawns between the player and the bots.
 *
 * `PlayerTeam=2` puts the player on team B and anything else on team A. Checked against
 * the size of the two groups on every map where they differ, since a scenario has one
 * player and usually many bot spawns: `npm run validate:sce` counts how often the player's
 * group is the smaller one. A spawn open to both teams is used by both.
 */
function splitSpawns(spawns: Spawn[], playerTeam: number): { player: Vec3[]; bots: Vec3[] } | null {
  const mine = playerTeam === 2 ? 2 : 1;
  const theirs = mine === 1 ? 2 : 1;
  const player = spawns.filter((s) => s.teams & mine).map((s) => s.at);
  const bots = spawns.filter((s) => s.teams & theirs).map((s) => s.at);
  if (player.length === 0 || bots.length === 0) return null;
  return { player, bots };
}

/** Small deterministic PRNG, so a rebuilt corpus reproduces the same numbers. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nearestFlick(points: Vec3[], alive: number): number {
  const n = Math.max(2, Math.round(alive));
  if (points.length < 2) return 0;
  const rand = mulberry32(points.length * 7919 + n);
  const pick = () => points[Math.floor(rand() * points.length)];
  let total = 0;
  const trials = 400;
  for (let t = 0; t < trials; t++) {
    const from = pick();
    let best = Infinity;
    for (let k = 1; k < n; k++) best = Math.min(best, angleBetween(from, pick()));
    total += best;
  }
  return total / trials;
}

function geometry(sce: Sce, mapsDir: string | null, scale: number, alive: number): GeometryFeatures | null {
  const found = mapSpawns(sce, mapsDir);
  if (!found) return null;
  const split = splitSpawns(found.spawns, num(sce.head, "PlayerTeam", 1));
  if (!split) return null;

  // The player's centroid, not each player spawn: multi-spawn players are almost always a
  // cluster a few units apart.
  const p = split.player.reduce((acc, v) => ({ x: acc.x + v.x, y: acc.y + v.y, z: acc.z + v.z }), { x: 0, y: 0, z: 0 });
  const origin = { x: p.x / split.player.length, y: p.y / split.player.length, z: p.z / split.player.length };
  const rel = split.bots.map((v) => ({ x: (v.x - origin.x) * scale, y: (v.y - origin.y) * scale, z: (v.z - origin.z) * scale }));

  const distances = rel.map((v) => Math.hypot(v.x, v.y, v.z));
  const pairs: number[] = [];
  // Capped so a 2,000-spawn map does not cost four million angles.
  const stride = Math.max(1, Math.floor(rel.length / 80));
  for (let i = 0; i < rel.length; i += stride) {
    for (let j = i + stride; j < rel.length; j += stride) pairs.push(angleBetween(rel[i], rel[j]));
  }
  const yaws = rel.map((v) => Math.atan2(v.y, v.x) * RAD);
  const pitches = rel.map((v) => Math.atan2(v.z, Math.hypot(v.x, v.y)) * RAD);
  // Yaw wraps; measure extent around the median heading so a field behind the player does
  // not read as 360 degrees wide.
  const heading = median(yaws);
  const wrapped = yaws.map((y) => ((y - heading + 540) % 360) - 180);

  return {
    source: found.source,
    playerSpawns: split.player.length,
    botSpawns: split.bots.length,
    distance: median(distances),
    spreadDeg: pairs.length ? median(pairs) : 0,
    yawExtentDeg: Math.max(...wrapped) - Math.min(...wrapped),
    pitchExtentDeg: Math.max(...pitches) - Math.min(...pitches),
    nearestDeg: nearestFlick(rel, alive),
  };
}

function characterOf(sce: Sce, name: string): SceLine[] | undefined {
  return profile(sce, "Character Profile", name)?.lines;
}

function target(sce: Sce, bot: string, count: number): TargetFeatures | null {
  const botLines = profile(sce, "Bot Profile", bot)?.lines;
  if (!botLines) return null;
  const chr = characterOf(sce, get(botLines, "CharacterProfile") ?? "");
  if (!chr) return null;
  const dodgeName = list(get(botLines, "DodgeProfileNames"))[0];
  const dodge = dodgeName ? profile(sce, "Dodge Profile", dodgeName)?.lines : undefined;
  const noDodging = bool(botLines, "NoDodging");
  const d = (k: string) => (dodge && !noDodging ? num(dodge, k, NaN) : NaN);
  const orNull = (v: number) => (Number.isFinite(v) ? v : null);
  return {
    bot,
    count,
    shape: get(chr, "MainBBType") ?? "",
    radius: num(chr, "MainBBRadius", 0),
    height: num(chr, "MainBBHeight", 0),
    health: num(chr, "MaxHealth", 0),
    regenPerSec: num(chr, "HealthRegenPerSec", 0),
    speed: noDodging ? 0 : num(chr, "MaxSpeed", 0),
    acceleration: num(chr, "Acceleration", 0),
    gravity: num(chr, "Gravity", 0),
    // Newer characters carry a range instead of one value.
    jumpVelocity: num(chr, "JumpVelocity", num(chr, "JumpVelocityMax", 0)),
    flyer: bool(chr, "IsFlyer"),
    strafeMin: orNull(d("MinLRTimeChange")),
    strafeMax: orNull(d("MaxLRTimeChange")),
    jumpFrequency: orNull(d("JumpFrequency")),
    keepMin: orNull(d("MinTargetDistance")),
    keepMax: orNull(d("MaxTargetDistance")),
  };
}

/** `AddedBots` entries are bots (`x.bot`) or rotations of bots (`x.rot`). */
function addedBots(sce: Sce): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of list(get(sce.head, "AddedBots"))) {
    const name = entry.replace(/\.(bot|rot)$/i, "");
    if (/\.rot$/i.test(entry)) {
      const rot = profile(sce, "Bot Rotation Profile", name)?.lines;
      const members = list(get(rot ?? [], "ProfileNames")).map((m) => m.replace(/\.bot$/i, ""));
      // A rotation fields one bot at a time; its members share that slot.
      for (const m of members) counts.set(m, (counts.get(m) ?? 0) + 1 / Math.max(1, members.length));
    } else {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

export function scenarioFeatures(sce: Sce, mapsDir: string | null = null): ScenarioFeatures {
  const h = sce.head;
  const scale = num(h, "MapScale", 1) || 1;
  const bots = addedBots(sce);
  const targets = [...bots]
    .map(([bot, count]) => target(sce, bot, count))
    .filter((t): t is TargetFeatures => t !== null)
    // Most numerous first; among equals, the larger. Revosect's Pasu fills its arena with
    // "Knocker" helper bots that push the targets off the walls - four of one kind, as many
    // as the targets - and taking a 4-unit, hundred-health helper for the target put that
    // scenario 13x off the model. No flag in the file separates helpers from targets:
    // `Untargetable=true` is on Voltaic's real, shootable targets too.
    .sort((a, b) => b.count - a.count || b.radius - a.radius);

  const player = characterOf(sce, get(h, "PlayerProfile") ?? "");
  const weaponName = list(get(player ?? [], "WeaponProfileNames"))[0];
  const weaponLines = weaponName ? profile(sce, "Weapon Profile", weaponName)?.lines : undefined;
  const weapon = weaponLines
    ? {
        name: weaponName,
        hitscan: (get(weaponLines, "Type") ?? "Hitscan") === "Hitscan",
        damage: num(weaponLines, "DamagePerShot", 0) * (num(weaponLines, "ShotsPerClick", 1) || 1),
        interval: num(weaponLines, "TimeBetweenShots", 0),
        fullyAutomatic: get(weaponLines, "Category") !== undefined
          ? get(weaponLines, "Category") === "FullyAuto"
          : get(weaponLines, "FullyAutomatic") === undefined ? null : bool(weaponLines, "FullyAutomatic"),
        magazine: num(weaponLines, "MagazineMax", 0),
        ammoPerShot: num(weaponLines, "AmmoPerShot", 1),
      }
    : null;

  const concurrent = [...bots.values()].reduce((a, b) => a + b, 0);
  const multipliers = {
    size: num(h, "TargetSizeBaseMultiplier", 1) || 1,
    time: (num(h, "Timescale", 1) || 1) * (num(h, "TimeDilationBaseMultiplier", 1) || 1),
    adaptive: bool(h, "IsTargetSizeActive") || bool(h, "IsTimeDilationActive"),
  };
  const geo = geometry(sce, mapsDir, scale, concurrent);
  const main = targets[0];
  // A moving bot holds a distance band from the player set by its dodge profile, and that,
  // not its spawn, is the range it is shot at: Voltaic's Ground bots spawn on the far side
  // of the arena and close to 900-1100 units. 100,000 is the editor's "no limit".
  const range = main && main.speed > 0 && main.keepMin !== null && main.keepMax !== null && main.keepMax < 50_000
    ? (main.keepMin + main.keepMax) / 2
    : geo?.distance ?? 0;
  if (geo) geo.engagement = range;
  const targetDeg = main && geo && range > 0 ? 2 * Math.atan((main.radius * multipliers.size) / range) * RAD : null;
  const angularSpeed = main && geo && range > 0 ? ((main.speed * multipliers.time) / range) * RAD : null;
  const fittsId = targetDeg && geo && geo.spreadDeg > 0 ? Math.log2(geo.spreadDeg / targetDeg + 1) : null;
  const fittsIdNearest = targetDeg && geo && geo.nearestDeg > 0 ? Math.log2(geo.nearestDeg / targetDeg + 1) : null;
  const shotsToKill = main && weapon && weapon.damage > 0 && main.health > 0 ? Math.ceil(main.health / weapon.damage - 1e-9) : null;
  const ttk = shotsToKill && weapon ? (shotsToKill - 1) * weapon.interval : null;
  const strafePeriod = main && main.strafeMin !== null && main.strafeMax !== null ? (main.strafeMin + main.strafeMax) / 2 : null;

  return {
    name: get(h, "Name") ?? "",
    timelimit: num(h, "Timelimit", 0),
    scoring: {
      perKill: num(h, "ScorePerKill", 0),
      perDamage: num(h, "ScorePerDamage", 0),
      perTime: num(h, "ScorePerTime", 0),
      toWin: num(h, "ScoreToWin", 0),
      accuracyMult: bool(h, "ScoreMultAccuracy"),
      sqrtAccuracy: bool(h, "MultSqrtAcc"),
      timeRefilledByKill: num(h, "TimeRefilledByKill", 0),
      lossPerDamageTaken: num(h, "ScoreLossPerDamageTaken", 0),
      perHit: num(h, "ScorePerHit", 0),
    },
    multipliers,
    weapon,
    concurrent,
    targets,
    geometry: geo,
    mapScale: scale,
    derived: { targetDeg, angularSpeed, fittsId, fittsIdNearest, shotsToKill, ttk, strafePeriod },
  };
}

export function readScenario(path: string): Sce {
  return parseSce(readFileSync(path, "utf8"));
}

export { sections };
