/**
 * Season 2: forty authored families, six to nine per category, four bands each.
 *
 * Every family is one idea about what to train, stated in the units a player feels - how
 * big a target looks, how fast it crosses the view, how long before it turns, how long it
 * takes to kill - and converted to engine units only at the end. The reasons behind each
 * number are in docs/season-2-research.md; the short version, all measured and all
 * re-derived by tools/scenarioScience.ts into data/season-2/science.json:
 *
 *   - Sixty seconds everywhere. Run-to-run noise falls with length (Spearman -0.36 across
 *     296 scenarios in the local stats folder), and a ranked match is decided on the change
 *     from a baseline, so noise is unfairness.
 *   - No accuracy multiplier. Median noise 5.8% with one, 4.8% without, and scenarios with
 *     one reach fewer players and are replayed less (Spearman -0.16 and -0.11).
 *   - Static targets sit on arcs at one distance. On a flat wall a target at 40 degrees is
 *     further away, so smaller, than one straight ahead, and which one spawns becomes luck.
 *   - Band steps follow the progression Voltaic S5 uses across its own families: about
 *     0.87x target size, 1.10x speed and 0.87x strafe period per band.
 *   - Scoring is per kill for clicking and per landed tick for everything that holds fire,
 *     the two forms `core/scenario/difficulty.ts` can predict a board for.
 *
 * Each family names the popular scenarios it learns from. Those are references, not
 * copies: the file a family is built on is a template for its engine plumbing, and every
 * value that decides what the scenario asks of a player is set here.
 */

import {
  cloneProfile,
  importProfile,
  prune,
  renameCharacterInMap,
  setAddedBots,
  type BotSpawn,
  setBots,
  setHead,
  setProfile,
  setRoom,
  span,
  type Values,
  type Vec,
} from "../../src/core/scenario/forge.ts";
import { get, list, profile, type Sce } from "../../src/core/scenario/sce.ts";

export const BANDS = ["Novice", "Intermediate", "Advanced", "Expert"] as const;
export type Band = 0 | 1 | 2 | 3;

export type Category =
  | "Static Clicking"
  | "Dynamic Clicking"
  | "Precise Tracking"
  | "Reactive Tracking"
  | "Speed Switching"
  | "Evasive Switching";

/** The templates, by the exact scenario name KovaaK's gives them. */
export const TEMPLATES = {
  staticClick: "VT 1w4ts Novice S5",
  movingClick: "VT Floating Heads Novice S5",
  bounceClick: "VT Popcorn Novice S5",
  groundTrack: "VT Ground Novice S5",
  airTrack: "VT Aether Novice S5",
  groundSwitch: "VT DriftTS Novice S5",
  airSwitch: "VT EddieTS Novice S5",
  // The real thing for skeeTS: targets thrown by a movement ability, not walked.
  skeet: "Skeet Tracking",
  // A pressure scenario with a board: balloons that fire back and cost score when they hit.
  pressure: "cA fuglaapressure",
} as const;
export type TemplateKey = keyof typeof TEMPLATES;

export interface Family {
  /** Display name, and the scenario name after "Apogee ". */
  name: string;
  category: Category;
  subCategory: string;
  template: TemplateKey;
  /** One line a player reads before starting: what to do. */
  focus: string;
  /** Why the family is in the season, for the curation record. */
  why: string;
  /** Popular scenarios whose idea this family builds on. */
  learnsFrom: string[];
  /** Arm, Wrist, Fingertip or Blending, in Viscose's four words; the season's own call. */
  arm: "Arm" | "Wrist" | "Fingertip" | "Blending";
  /**
   * A design quantity this family deliberately takes past what popular scenarios of its
   * class ask (validate:season2, check 6), with the reason and the scenario that shows
   * players already play it. Anything not declared here is held to the popular range.
   */
  exceeds?: Array<{ quantity: "target size (deg)" | "angular speed (deg/s)" | "reversal period (s)"; why: string }>;
  /**
   * The board model's class when it is not the category's own. LosTS is evasive switching
   * with one target alive at a time, which the model, reasonably, reads as tracking.
   */
  modelClass?: "click" | "track" | "switch";
  /**
   * A scenario with a real board whose physics this family shares closely enough that its
   * board, moved by the model for what differs, predicts better than the pooled fit does.
   * skeeTS is Skeet Tracking's mechanism; the pooled model misreads thrown targets (Skeet
   * Tracking is among its worst switching misses), and the sibling board does not.
   */
  anchor?: string;
  /**
   * A pressure scenario: targets punish being left (fuglaa's balloons fire at the player,
   * and a hit costs score). See ClassifyOptions in core/scenario/difficulty.ts.
   */
  pressure?: boolean;
  build: (sce: Sce, band: Band, lib: Library) => void;
}

/** The other templates, for a recipe that needs a profile its own template lacks. */
export type Library = (template: TemplateKey) => Sce;

// ---- units ------------------------------------------------------------------------------

const RAD = Math.PI / 180;
/** Radius in world units of a target `deg` degrees across at `range`. */
const radiusFor = (deg: number, range: number) => range * Math.tan((deg / 2) * RAD);
/** Speed in world units per second that crosses `degPerSec` at `range`. */
const speedFor = (degPerSec: number, range: number) => range * degPerSec * RAD;
/** The value at band `b` of a quantity that starts at `v` and steps by `k` per band. */
const step = (v: number, k: number, b: Band) => v * Math.pow(k, b);

const SIZE = 0.87;
const SPEED = 1.1;
const PERIOD = 0.87;

/** MapScale every generated room uses; a room's map units are world units over this. */
const SCALE = 4;

// ---- shared head ---------------------------------------------------------------------------

function head(sce: Sce, f: Family, band: Band, extra: Values, description: string): void {
  const name = scenarioName(f, band);
  setHead(sce, {
    Name: name,
    Timelimit: 60,
    ScoreMultAccuracy: false,
    MultSqrtAcc: false,
    ScorePerDamage: 0,
    // 3.7 files tag with SearchTags; older ones (Skeet Tracking, 3.1) with GameTag and
    // AuthorsTag. Whichever the template carries.
    ...(get(sce.head, "SearchTags") !== undefined
      ? { SearchTags: `Apogee, Apogee Season 2, ${f.category}, ${BANDS[band]}` }
      : { GameTag: `Apogee Season 2, ${f.category}, ${BANDS[band]}`, AuthorsTag: "Apogee" }),
    DifficultyTag: band + 1,
    Description: `${description}[nl][nl]Apogee Season 2, ${f.category}, ${BANDS[band]}. ${f.focus}`,
    ...extra,
  });
}

export function scenarioName(f: Family, band: Band): string {
  return `Apogee ${f.name} ${BANDS[band]}`;
}

/**
 * One bot the recipe owns, cloned from the template's first bot, its character and one
 * dodge profile, and renamed so nothing of the template's naming survives in the file.
 */
function ownBot(
  sce: Sce,
  tag: string,
  { keepAbilities = false, keepDodges = false }: { keepAbilities?: boolean; keepDodges?: boolean } = {},
): { bot: string; character: string; dodge: string } {
  const firstBot = profile(sce, "Bot Profile", firstAddedBot(sce));
  if (!firstBot) throw new Error("template has no bot to clone");
  const fromBot = get(firstBot.lines, "Name")!;
  const fromChar = get(firstBot.lines, "CharacterProfile")!;
  const fromDodge = list(get(firstBot.lines, "DodgeProfileNames"))[0];
  const bot = `Apogee ${tag}`;
  const character = `Apogee ${tag} Body`;
  const dodge = `Apogee ${tag} Move`;
  cloneProfile(sce, "Bot Profile", fromBot, bot);
  cloneProfile(sce, "Character Profile", fromChar, character);
  // No abilities. Voltaic's Ground bots carry a blink - a teleport on a timer - which is
  // right for their reactive scenarios and wrong for most of these; the families that want
  // an interruption get it from their movement, where the file states it.
  if (!keepAbilities) setProfile(sce, "Character Profile", character, { AbilityProfileNames: ";;;" });
  // The template's map may admit only its own character at the bot spawns ("Head",
  // "Drifter"); the renamed one has to be admitted in its place.
  renameCharacterInMap(sce, fromChar, character);
  const botValues: Values = {
    CharacterProfile: character,
    RandomizeDodgeProfiles: false,
  };
  // keepDodges leaves the bot on its template's own dodge profiles, all of them, unchanged:
  // Meteor is meant to move exactly as Voltaic's Floating Heads do.
  if (fromDodge && !keepDodges) {
    cloneProfile(sce, "Dodge Profile", fromDodge, dodge);
    botValues.DodgeProfileNames = dodge;
    botValues.DodgeProfileWeights = "1.0";
  }
  setProfile(sce, "Bot Profile", bot, botValues);
  return { bot, character, dodge };
}

/** The first bot the template adds, through a rotation if it uses one. */
function firstAddedBot(sce: Sce): string {
  const entry = list(get(sce.head, "AddedBots"))[0] ?? "";
  const name = entry.replace(/\.(bot|rot)$/i, "");
  if (/\.rot$/i.test(entry)) {
    const rot = profile(sce, "Bot Rotation Profile", name);
    return list(get(rot?.lines ?? [], "ProfileNames"))[0]?.replace(/\.bot$/i, "") ?? "";
  }
  return name;
}

function weaponOf(sce: Sce): string {
  const player = profile(sce, "Character Profile", get(sce.head, "PlayerProfile") ?? "");
  return list(get(player?.lines ?? [], "WeaponProfileNames"))[0];
}

/** Jump height, on whichever of the two forms the character carries. */
function jumpVelocity(sce: Sce, character: string, v: number): Values {
  const c = profile(sce, "Character Profile", character)!;
  return get(c.lines, "JumpVelocity") !== undefined ? { JumpVelocity: v } : { JumpVelocityMin: v, JumpVelocityMax: v };
}

function finish(sce: Sce): void {
  prune(sce);
}

// ---- rooms for fixed targets ---------------------------------------------------------------

/**
 * Spawn points on a sphere of radius `range` (world units) around the player, at every
 * yaw/pitch pair given, in map units for a MapScale of SCALE.
 *
 * A square grid, deliberately. Voltaic lays its 1wXts fields out in a diamond "so that
 * nearby spawns are more likely to be diagonally oriented", and that was tried here: every
 * other row shifted half a step. Simulating the flick a player actually makes - from a
 * target to the nearest other live one - showed the square grid already spreads flicks
 * about as evenly as random directions would (Constellation: 33% near-horizontal, 42%
 * diagonal, 25% near-vertical, against 25/50/25 for uniform), because with several targets
 * alive the nearest one is rarely the adjacent spawn. The diamond pushed that to 26/55/19,
 * trading vertical flicks, which this season sets out to train more, for diagonal ones.
 */
function arc(range: number, yaws: number[], pitches: number[]): Vec[] {
  const r = range / SCALE;
  const out: Vec[] = [];
  for (const yaw of yaws) {
    for (const pitch of pitches) {
      out.push({
        x: r * Math.cos(pitch * RAD) * Math.cos(yaw * RAD),
        y: r * Math.cos(pitch * RAD) * Math.sin(yaw * RAD),
        z: r * Math.sin(pitch * RAD),
      });
    }
  }
  return out;
}

/** The smallest box that holds every spawn with a margin, and the player at the origin. */
function roomAround(spawns: Vec[], margin = 64) {
  const xs = spawns.map((s) => s.x);
  const ys = spawns.map((s) => s.y);
  const zs = spawns.map((s) => s.z);
  return {
    min: { x: -margin, y: Math.min(...ys, 0) - margin, z: Math.min(...zs, 0) - margin },
    max: { x: Math.max(...xs) + margin, y: Math.max(...ys, 0) + margin, z: Math.max(...zs, 0) + margin },
  };
}

function fixedTargets(sce: Sce, f: Family, band: Band, spawns: Array<Vec | BotSpawn>): void {
  const points = spawns.map((x) => ("at" in x ? x.at : x));
  setRoom(sce, { ...roomAround(points), spawns }, `Apogee ${f.name} ${BANDS[band]}.json`);
  setHead(sce, { MapScale: SCALE });
}

// ---- static clicking -----------------------------------------------------------------------

interface StaticSpec {
  alive: number;
  /** Target diameter in degrees at Novice. */
  deg: number;
  yaws: number[];
  pitches: number[];
  /** Second ring further out, as a multiple of the first; 0 for none. */
  depthRing?: number;
  range?: number;
}

function staticClick(f: Family, spec: StaticSpec, description: string) {
  return (sce: Sce, band: Band) => {
    const range = spec.range ?? 2048;
    const deg = step(spec.deg, SIZE, band);
    const { bot, character } = ownBot(sce, f.name);
    setProfile(sce, "Character Profile", character, {
      MainBBRadius: radiusFor(deg, range),
      MainBBHeight: 2 * radiusFor(deg, range),
      MaxHealth: 1,
      MaxSpeed: 0,
      Gravity: 0,
    });
    let spawns = arc(range, spec.yaws, spec.pitches);
    if (spec.depthRing) spawns = [...spawns, ...arc(range * spec.depthRing, spec.yaws, spec.pitches)];
    fixedTargets(sce, f, band, spawns);
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 10, ScorePerHit: 0, AimTypeTag: "Clicking", AimSubTypeTag: "Static" }, description);
    finish(sce);
  };
}

// ---- moving clicking -----------------------------------------------------------------------

interface MovingClickSpec {
  alive: number;
  deg: number;
  /** Degrees per second at Novice. */
  speed: number;
  /** Seconds between left/right reversals at Novice, [min, max]. */
  strafe: [number, number];
  /** Seconds between up/down reversals; null keeps the float on one height band. */
  upDown?: [number, number] | null;
  hits?: number;
  range?: number;
  /** Flies: no gravity, and rises and falls on its own toggle instead of hopping. */
  flyer?: boolean;
  /**
   * Straight runs that turn only at the walls: instant acceleration, no gravity, no hops,
   * no forward/back and no held distance, the way Floating Heads Timing 400% moves.
   */
  bounce?: boolean;
  /**
   * A fast vertical buzz on top of the movement: up/down reversals every `times` seconds at
   * `speed` degrees a second, so the target shakes as it goes. Needs `flyer`.
   */
  vibrate?: { times: [number, number]; speed: number };
  /** Move in a generated open room, spawning on a ring at the held range. Needs `flyer`. */
  openRoom?: boolean;
  /** Keep the template's dodge profiles exactly as they are; only size and speed change. */
  templateMovement?: boolean;
  /** A dead stop of this many seconds, [min, max], at every change of direction. */
  stopAtTurns?: [number, number];
}

function movingClick(f: Family, spec: MovingClickSpec, description: string) {
  return (sce: Sce, band: Band) => {
    const range = spec.range ?? 2000;
    const deg = step(spec.deg, SIZE, band);
    const speed = step(spec.speed, SPEED, band);
    const k = Math.pow(PERIOD, band);
    const { bot, character, dodge } = ownBot(sce, f.name, { keepDodges: spec.templateMovement });
    setProfile(sce, "Character Profile", character, {
      MainBBRadius: radiusFor(deg, range),
      MainBBHeight: 2 * radiusFor(deg, range),
      MaxSpeed: speedFor(speed, range),
      MaxHealth: spec.hits ?? 1,
    });
    if (spec.templateMovement) {
      setBots(sce, [{ bot, count: spec.alive }]);
      head(sce, f, band, { ScorePerKill: 10, ScorePerHit: 0, AimTypeTag: "Clicking", AimSubTypeTag: "Dynamic" }, description);
      finish(sce);
      return;
    }
    const dodgeValues: Values = {
      MinTargetDistance: range * 0.95,
      MaxTargetDistance: range * 1.05,
      MinLRTimeChange: spec.strafe[0] * k,
      MaxLRTimeChange: spec.strafe[1] * k,
    };
    if (spec.upDown) {
      dodgeValues.ToggleUpDownMinTime = spec.upDown[0] * k;
      dodgeValues.ToggleUpDownMaxTime = spec.upDown[1] * k;
    } else if (spec.upDown === null) {
      // One height band. The template's heads stay aloft by hopping against a little
      // gravity; with neither, each keeps the height it spawned at and only moves sideways.
      // (A longer vertical toggle was the first attempt; 30 s is past anything the corpus
      // uses, and it would not have stopped the hops anyway.)
      dodgeValues.JumpFrequency = 0;
      setProfile(sce, "Character Profile", character, { Gravity: 0 });
    }
    if (spec.flyer) {
      setProfile(sce, "Character Profile", character, { IsFlyer: true, Gravity: 0, FlightVelocityUp: speedFor(speed, range) * 0.8, FlightVelocityDown: speedFor(speed, range) * 0.8 });
      dodgeValues.JumpFrequency = 0;
    }
    if (spec.bounce) {
      setProfile(sce, "Character Profile", character, { BounceOffWalls: true, Acceleration: 100000, Gravity: 0 });
      Object.assign(dodgeValues, { ToggleForwardBack: false, JumpFrequency: 0, MinTargetDistance: 1, MaxTargetDistance: 100000 });
    }
    if (spec.stopAtTurns) {
      // Instant stops and starts, so a turn reads as a full stop rather than a slow-down.
      setProfile(sce, "Character Profile", character, { Acceleration: 100000 });
      Object.assign(dodgeValues, { StrafeSwapMinPause: spec.stopAtTurns[0], StrafeSwapMaxPause: spec.stopAtTurns[1], ToggleForwardBack: false, JumpFrequency: 0 });
    }
    if (spec.vibrate) {
      const buzz = speedFor(spec.vibrate.speed, range);
      setProfile(sce, "Character Profile", character, { FlightVelocityUp: buzz, FlightVelocityDown: buzz });
      Object.assign(dodgeValues, { ToggleUpDownMinTime: spec.vibrate.times[0], ToggleUpDownMaxTime: spec.vibrate.times[1] });
    }
    setProfile(sce, "Dodge Profile", dodge, dodgeValues);
    if (spec.openRoom) {
      // A ring of spawns at the held range, inside a room with a wide margin: nothing in the
      // arena for the targets to meet but the player's line of sight.
      const ringSpawns = arc(range, span(-40, 40, 9), [-8, 0, 8]);
      setRoom(sce, { ...roomAround(ringSpawns, 900), spawns: ringSpawns }, `Apogee ${f.name} ${BANDS[band]}.json`);
      setHead(sce, { MapScale: SCALE });
    }
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 10, ScorePerHit: 0, AimTypeTag: "Clicking", AimSubTypeTag: "Dynamic" }, description);
    finish(sce);
  };
}

// ---- clicking on paths -------------------------------------------------------------------------

interface PathSpec {
  deg: number;
  speed: number;
  range: number;
  /** The routes, in degrees off the line of sight, for this band. */
  routes: (band: Band) => Array<{ points: Array<[number, number]>; looping: boolean }>;
  alive: number;
}

/**
 * Targets that walk authored routes: straight lanes for Shooting Stars, inward spirals for
 * Gravity Well. The route is a chain of waypoints in a generated room; the bot flies, turns
 * instantly, and its dodge profile hands movement to the waypoints
 * (`WaypointLogic=FollowAimAtTarget`) with sideways and forward/back dodging off - the
 * set-up ZipTrack - THE FINALS moves its targets with.
 */
function pathClick(f: Family, spec: PathSpec, description: string) {
  return (sce: Sce, band: Band) => {
    const deg = step(spec.deg, SIZE, band);
    const speed = step(spec.speed, SPEED, band);
    const { bot, character, dodge } = ownBot(sce, f.name);
    const maxSpeed = speedFor(speed, spec.range);
    setProfile(sce, "Character Profile", character, {
      MainBBRadius: radiusFor(deg, spec.range),
      MainBBHeight: 2 * radiusFor(deg, spec.range),
      MaxSpeed: maxSpeed,
      Acceleration: 100000,
      Friction: 100000,
      Gravity: 0,
      IsFlyer: true,
      FlightVelocityUp: maxSpeed,
      FlightVelocityDown: maxSpeed,
      MaxHealth: 1,
    });
    setProfile(sce, "Dodge Profile", dodge, {
      ToggleLeftRight: false,
      ToggleForwardBack: false,
      JumpFrequency: 0,
      MinTargetDistance: 1,
      MaxTargetDistance: 100000,
      WaypointLogic: "FollowAimAtTarget",
      WaypointTurnRate: 100000,
    });
    const routes = spec.routes(band);
    const waypoints: Array<{ name: string; at: Vec }> = [];
    const spawns: BotSpawn[] = [];
    routes.forEach((route, r) => {
      const names = route.points.map((_, i) => `${f.name} ${r + 1}-${i + 1}`);
      route.points.forEach(([yaw, pitch], i) => waypoints.push({ name: names[i], at: arc(spec.range, [yaw], [pitch])[0] }));
      spawns.push({ at: arc(spec.range, [route.points[0][0]], [route.points[0][1]])[0], path: names, looping: route.looping });
    });
    const all = [...spawns.map((x) => x.at), ...waypoints.map((w) => w.at)];
    setRoom(sce, { ...roomAround(all), spawns, waypoints }, `Apogee ${f.name} ${BANDS[band]}.json`);
    setHead(sce, { MapScale: SCALE });
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 10, ScorePerHit: 0, AimTypeTag: "Clicking", AimSubTypeTag: "Dynamic" }, description);
    finish(sce);
  };
}

/** Straight lanes across the view, alternating direction, each with a little rise or fall. */
function lanes(count: number, halfWidth: number, pitchSpan: number, slope: number) {
  return () =>
    span(-pitchSpan, pitchSpan, count).map((pitch, i) => {
      const dir = i % 2 === 0 ? 1 : -1;
      const rise = (i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0.5) * slope;
      // Every lane starts at its own height and rises or falls toward the far side: starting
      // lanes off-centre by half their rise put two same-side starts 0.18 degrees apart.
      return {
        points: [[-halfWidth * dir, pitch], [halfWidth * dir, pitch + rise]] as Array<[number, number]>,
        looping: true,
      };
    });
}

// ---- constellations -------------------------------------------------------------------------------

/**
 * Seven stars of each, by right ascension (hours) and declination (degrees), J2000, to
 * about an arcminute - near enough that the shape on screen is the shape in the sky. Every
 * constellation has seven so every wave fills the same seven slots.
 */
const CONSTELLATIONS: Array<{ name: string; stars: Array<[number, number]> }> = [
  { name: "Big Dipper", stars: [[11.062, 61.75], [11.031, 56.38], [11.897, 53.69], [12.257, 57.03], [12.9, 55.96], [13.399, 54.93], [13.792, 49.31]] },
  { name: "Little Dipper", stars: [[2.53, 89.26], [17.537, 86.59], [16.766, 82.04], [15.734, 77.79], [16.292, 75.76], [15.345, 71.83], [14.845, 74.16]] },
  { name: "Orion", stars: [[5.919, 7.41], [5.419, 6.35], [5.533, -0.3], [5.603, -1.2], [5.679, -1.94], [5.796, -9.67], [5.242, -8.2]] },
  { name: "Cassiopeia", stars: [[0.153, 59.15], [0.675, 56.54], [0.945, 60.72], [1.43, 60.24], [1.907, 63.67], [0.818, 57.82], [0.55, 62.93]] },
  { name: "Cygnus", stars: [[20.69, 45.28], [20.37, 40.26], [20.77, 33.97], [19.75, 45.13], [19.512, 27.96], [19.938, 35.08], [21.216, 30.23]] },
  { name: "Leo", stars: [[10.139, 11.97], [10.122, 16.76], [10.333, 19.84], [10.278, 23.42], [9.764, 23.77], [11.235, 20.52], [11.818, 14.57]] },
];

/**
 * Gnomonic projection about each constellation's centre, flipped so east is on the left
 * as it is looking up, then scaled so the constellation fills a field `halfWidth` by
 * `halfHeight` degrees. Returns [yaw, pitch] per star.
 */
export function projectConstellation(stars: Array<[number, number]>, halfWidth: number, halfHeight: number): Array<[number, number]> {
  const v = stars.map(([h, d]) => {
    const ra = (h * 15 * Math.PI) / 180, dec = (d * Math.PI) / 180;
    return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  });
  const c = [0, 1, 2].map((i) => v.reduce((a, x) => a + x[i], 0));
  const len = Math.hypot(c[0], c[1], c[2]);
  const ra0 = Math.atan2(c[1], c[0]), dec0 = Math.asin(c[2] / len);
  const flat = stars.map(([h, d]) => {
    const ra = (h * 15 * Math.PI) / 180, dec = (d * Math.PI) / 180;
    const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
    const x = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc;
    const y = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
    return [-x, y];
  });
  const cx = (Math.max(...flat.map((p) => p[0])) + Math.min(...flat.map((p) => p[0]))) / 2;
  const cy = (Math.max(...flat.map((p) => p[1])) + Math.min(...flat.map((p) => p[1]))) / 2;
  const w = Math.max(...flat.map((p) => Math.abs(p[0] - cx))) || 1;
  const h = Math.max(...flat.map((p) => Math.abs(p[1] - cy))) || 1;
  const k = Math.min(halfWidth / w, halfHeight / h);
  return flat.map(([x, y]) => [(x - cx) * k, (y - cy) * k]);
}

interface ConstellationSpec {
  deg: number;
  halfWidth: number;
  halfHeight: number;
}

/**
 * Real constellations, one wave at a time: every star of one is up at once, and the next
 * appears when the last star of this one falls.
 *
 * The mechanism is Revosect's StrawberryClick's, whose description says it outright
 * ("after killing 3 big bots, 6 smaller bots will spawn"): every bot is in SpawnGroup 1,
 * so the group respawns only when all of it is dead, and each of the seven slots is a
 * fixed-order Bot Rotation Profile - star 1 of the Big Dipper, then star 1 of the Little
 * Dipper, and so on - so the slots advance together. Each star's bot has its own character,
 * admitted by only its own spawn point, which pins it to its place in the shape. A static
 * template has no rotation profile, so one is imported from Voltaic's Ground.
 */
function constellation(f: Family, spec: ConstellationSpec, description: string) {
  return (sce: Sce, band: Band, lib: Library) => {
    const range = 2048;
    const deg = step(spec.deg, SIZE, band);
    const { bot, character } = ownBot(sce, f.name);
    setProfile(sce, "Character Profile", character, { MainBBRadius: radiusFor(deg, range), MainBBHeight: 2 * radiusFor(deg, range), MaxHealth: 1, MaxSpeed: 0, Gravity: 0 });
    setProfile(sce, "Bot Profile", bot, { SpawnGroup: 1, UseMinimumRespawnTime: true });
    const slots = CONSTELLATIONS[0].stars.length;
    const members: string[][] = Array.from({ length: slots }, () => []);
    const spawns: BotSpawn[] = [];
    for (const c of CONSTELLATIONS) {
      const at = projectConstellation(c.stars, spec.halfWidth, spec.halfHeight);
      at.forEach(([yaw, pitch], i) => {
        const star = `Apogee ${c.name} ${i + 1}`;
        cloneProfile(sce, "Character Profile", character, `${star} Body`);
        cloneProfile(sce, "Bot Profile", bot, star);
        setProfile(sce, "Bot Profile", star, { CharacterProfile: `${star} Body` });
        members[i].push(star);
        spawns.push({ at: arc(range, [yaw], [pitch])[0], admits: `${star} Body` });
      });
    }
    const ground = lib("groundTrack");
    const rot = (list(get(ground.head, "AddedBots"))[0] ?? "").replace(/\.rot$/i, "");
    const entries: string[] = [];
    members.forEach((names, i) => {
      const slot = `Apogee ${f.name} Slot ${i + 1}`;
      const section = importProfile(sce, ground, "Bot Rotation Profile", rot, slot);
      const values: Record<string, string> = {
        ProfileNames: names.join(";"),
        ProfileWeights: names.map(() => "1.0").join(";"),
        Randomized: "false",
        AllowRepeatEntries: "true",
      };
      for (const [k, v] of Object.entries(values)) {
        const line = section.lines.find((l) => l.key === k);
        if (!line) throw new Error(`rotation profile has no ${k}`);
        line.value = v;
      }
      entries.push(`${slot}.rot`);
    });
    fixedTargets(sce, f, band, spawns);
    setAddedBots(sce, entries);
    head(sce, f, band, { ScorePerKill: 10, ScorePerHit: 0, AimTypeTag: "Clicking", AimSubTypeTag: "Static" }, description);
    finish(sce);
  };
}

interface BounceSpec {
  alive: number;
  deg: number;
  speed: number;
  gravity: number;
  range?: number;
}

function bounceClick(f: Family, spec: BounceSpec, description: string) {
  return (sce: Sce, band: Band) => {
    const range = spec.range ?? 2150;
    const deg = step(spec.deg, SIZE, band);
    const speed = step(spec.speed, SPEED, band);
    const { bot, character, dodge } = ownBot(sce, f.name);
    setProfile(sce, "Character Profile", character, {
      MainBBRadius: radiusFor(deg, range),
      MainBBHeight: 2 * radiusFor(deg, range),
      MaxSpeed: speedFor(speed, range),
      // Heavier with each band, so the arcs get shorter and the window to click narrows.
      Gravity: spec.gravity * Math.pow(1.12, band),
      MaxHealth: 1,
    });
    setProfile(sce, "Dodge Profile", dodge, { MinTargetDistance: range * 0.93, MaxTargetDistance: range * 1.07 });
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 10, ScorePerHit: 0, AimTypeTag: "Clicking", AimSubTypeTag: "Dynamic" }, description);
    finish(sce);
  };
}

// ---- tracking --------------------------------------------------------------------------------

interface TrackSpec {
  deg: number;
  speed: number;
  strafe: [number, number];
  range: number;
  /** Seconds to reach full speed from a stop; long is smooth, short is snappy. */
  rampSeconds: number;
  /** Seconds a strafe pauses before reversing, [min, max]. */
  pause?: [number, number];
  forwardBack?: [number, number];
  upDown?: [number, number];
  jump?: { frequency: number; velocity: number; gravity: number };
  /** The bot turns within this window after being hit, [min, max] seconds, ignoring the given share. */
  juke?: { delay: [number, number]; ignore: number };
  /**
   * Now and then, stop dead: a second dodge profile that barely moves and waits `pause`
   * seconds between moves, switched to at random for `share` of the profile changes, which
   * come every `every` seconds.
   */
  hold?: { pause: [number, number]; every: [number, number]; share: number };
  /**
   * Ground Plaza's blink: the template's own dash ability, a tenth of a second at a speed
   * that covers `degrees` of view, once every `every` seconds at Novice and 0.7x as long each
   * band after.
   */
  blink?: { every: number; degrees: number };
}

function track(f: Family, spec: TrackSpec, description: string, sub: "Precise" | "Reactive") {
  return (sce: Sce, band: Band) => {
    const deg = step(spec.deg, SIZE, band);
    const speed = step(spec.speed, SPEED, band);
    const k = Math.pow(PERIOD, band);
    const { bot, character, dodge } = ownBot(sce, f.name, { keepAbilities: Boolean(spec.blink) });
    const maxSpeed = speedFor(speed, spec.range);
    if (spec.blink) {
      const ability = list(get(profile(sce, "Character Profile", character)!.lines, "AbilityProfileNames"))[0]?.replace(/\.abil\w+$/i, "");
      if (!ability) throw new Error("the template's target has no blink to keep");
      const duration = Number(get(profile(sce, "Movement Ability Profile", ability)!.lines, "AbilityDuration"));
      setProfile(sce, "Movement Ability Profile", ability, {
        MaxCharges: 1,
        ChargeTimer: spec.blink.every * Math.pow(0.7, band),
        MainVelocity: (spec.range * Math.tan(spec.blink.degrees * RAD)) / duration,
      });
    }
    const chr: Values = {
      MainBBRadius: radiusFor(deg, spec.range),
      MaxSpeed: maxSpeed,
      Acceleration: maxSpeed / spec.rampSeconds,
      // A target that never dies and never decays: tracking is scored on time on target,
      // and a respawn gap would be a pause nobody chose. The templates' tracking guns do
      // 0.1 damage a second, so 5,000 outlasts any run; a million, the first choice, is
      // past the largest health any scenario on record uses (10,000).
      MaxHealth: 5000,
      HealthRegenPerSec: 0,
    };
    if (f.template === "groundTrack") chr.MainBBHeight = 2 * radiusFor(deg, spec.range) * 2.6;
    else chr.MainBBHeight = 2 * radiusFor(deg, spec.range);
    if (spec.jump) {
      Object.assign(chr, jumpVelocity(sce, character, spec.jump.velocity));
      chr.Gravity = spec.jump.gravity;
    }
    if (spec.upDown) {
      chr.FlightVelocityUp = maxSpeed * 0.8;
      chr.FlightVelocityDown = maxSpeed * 0.8;
    }
    setProfile(sce, "Character Profile", character, chr);
    const d: Values = {
      MinTargetDistance: spec.range * 0.85,
      MaxTargetDistance: spec.range * 1.15,
      MinLRTimeChange: spec.strafe[0] * k,
      MaxLRTimeChange: spec.strafe[1] * k,
      StrafeSwapMinPause: spec.pause ? spec.pause[0] : 0,
      StrafeSwapMaxPause: spec.pause ? spec.pause[1] : 0,
      ToggleForwardBack: Boolean(spec.forwardBack),
      JumpFrequency: spec.jump ? spec.jump.frequency : 0,
      DamageReactionChangesDirection: Boolean(spec.juke),
    };
    if (spec.forwardBack) {
      d.MinFBTimeChange = spec.forwardBack[0];
      d.MaxFBTimeChange = spec.forwardBack[1];
    }
    if (spec.upDown) {
      d.ToggleUpDownMinTime = spec.upDown[0] * k;
      d.ToggleUpDownMaxTime = spec.upDown[1] * k;
    }
    if (spec.juke) {
      d.DamageReactionMinimumDelay = spec.juke.delay[0];
      d.DamageReactionMaximumDelay = spec.juke.delay[1];
      d.DamageReactionChanceToIgnore = spec.juke.ignore;
      d.DamageReactionCooldown = 0.6;
    }
    setProfile(sce, "Dodge Profile", dodge, d);
    if (spec.hold) {
      const hold = `Apogee ${f.name} Hold`;
      cloneProfile(sce, "Dodge Profile", dodge, hold);
      setProfile(sce, "Dodge Profile", hold, {
        MinLRTimeChange: 0.02,
        MaxLRTimeChange: 0.04,
        StrafeSwapMinPause: spec.hold.pause[0],
        StrafeSwapMaxPause: spec.hold.pause[1],
      });
      setProfile(sce, "Bot Profile", bot, {
        DodgeProfileNames: `${dodge};${hold}`,
        DodgeProfileWeights: `${(1 - spec.hold.share).toFixed(2)};${spec.hold.share.toFixed(2)}`,
        DodgeProfileMinChangeTime: spec.hold.every[0],
        DodgeProfileMaxChangeTime: spec.hold.every[1],
        RandomizeDodgeProfiles: true,
      });
    }
    setBots(sce, [{ bot, count: 1 }]);
    head(sce, f, band, { ScorePerKill: 0, ScorePerHit: 1, AimTypeTag: "Tracking", AimSubTypeTag: sub }, description);
    finish(sce);
  };
}

// ---- switching -------------------------------------------------------------------------------

interface SwitchSpec {
  alive: number;
  deg: number;
  /** Seconds of fire to kill one target at Novice. */
  ttk: number;
  /** Degrees per second; 0 for targets that hold still on generated spawns. */
  speed: number;
  strafe?: [number, number];
  range: number;
  /** Fixed targets: where they may appear. */
  field?: { yaws: number[]; pitches: number[] };
  jump?: { frequency: number; velocity: number; gravity: number };
  upDown?: [number, number];
  /** Health regained per second while not being hit, as a share of max health. */
  regen?: { perSecond: number; delay: number };
  /** Seconds to full speed; longer turns reversals into curves. Default a quarter second. */
  ramp?: number;
  /**
   * Move in a generated open room rather than the template's arena. DriftTS's arena has a
   * solid box round the player about 1,150 units out, and targets held closer than that
   * pressed against it and stuck - Brawl's did, at 900-1,100.
   */
  openRoom?: boolean;
}

function switching(f: Family, spec: SwitchSpec, description: string, sub: "Speed" | "Evasive") {
  return (sce: Sce, band: Band) => {
    const deg = step(spec.deg, SIZE, band);
    const speed = step(spec.speed, SPEED, band);
    const k = Math.pow(PERIOD, band);
    const { bot, character, dodge } = ownBot(sce, f.name);
    // Fire rate is the template's; the kill time is set through health so the gun feels the
    // same in every switching family.
    const weapon = weaponOf(sce);
    setProfile(sce, "Weapon Profile", weapon, { DamagePerShot: 1, TimeBetweenShots: 0.01 });
    const health = spec.ttk / 0.01;
    const maxSpeed = speedFor(speed, spec.range);
    const chr: Values = {
      MainBBRadius: radiusFor(deg, spec.range),
      MainBBHeight: 2 * radiusFor(deg, spec.range),
      MaxHealth: health,
      MaxSpeed: maxSpeed,
      HealthRegenPerSec: spec.regen ? health * spec.regen.perSecond : 0,
      HealthRegenDelay: spec.regen ? spec.regen.delay : 0,
    };
    if (maxSpeed > 0) chr.Acceleration = maxSpeed / (spec.ramp ?? 0.25);
    // Without a jump the targets hold the height they spawned at: fixed targets must not
    // sink, and strafing ones should stay on the plane they were placed in.
    chr.Gravity = spec.jump ? spec.jump.gravity : 0;
    if (spec.jump) Object.assign(chr, jumpVelocity(sce, character, spec.jump.velocity));
    setProfile(sce, "Character Profile", character, chr);
    if (profile(sce, "Dodge Profile", dodge)) {
      const d: Values = {
        MinTargetDistance: spec.range * 0.9,
        MaxTargetDistance: spec.range * 1.1,
        JumpFrequency: spec.jump ? spec.jump.frequency : 0,
      };
      if (spec.strafe) {
        d.MinLRTimeChange = spec.strafe[0] * k;
        d.MaxLRTimeChange = spec.strafe[1] * k;
      }
      if (spec.upDown) {
        d.ToggleUpDownMinTime = spec.upDown[0] * k;
        d.ToggleUpDownMaxTime = spec.upDown[1] * k;
      }
      setProfile(sce, "Dodge Profile", dodge, d);
    }
    if (spec.speed === 0) {
      setProfile(sce, "Bot Profile", bot, { NoDodging: true });
      fixedTargets(sce, f, band, arc(spec.range, spec.field!.yaws, spec.field!.pitches));
    } else if (spec.openRoom) {
      // Spawns on a ring at the held range; a wide margin so strafing never reaches a wall.
      const ringSpawns = arc(spec.range, span(-40, 40, 9), [-6, 0, 6]);
      setRoom(sce, { ...roomAround(ringSpawns, 900), spawns: ringSpawns }, `Apogee ${f.name} ${BANDS[band]}.json`);
      setHead(sce, { MapScale: SCALE });
    }
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 0, ScorePerHit: 1, AimTypeTag: "Target Switching", AimSubTypeTag: sub }, description);
    finish(sce);
  };
}

// ---- pressure -----------------------------------------------------------------------------------

interface PressureSpec {
  alive: number;
  deg: number;
  /** Game speed at Novice, and its step each band. */
  timescale: number;
  timescaleStep: number;
  /** The template's own balloon distance: 100 units across at 0.631 degrees (validate:sce's reader). */
  range: number;
}

/**
 * A pressure scenario on cA fuglaapressure's own mechanism: still balloons that aim at the
 * player and fire a moment later, every hit costing score, so a balloon left alive is a loss
 * and not only a delay. The template's map is kept as it is - its author notes the pressure
 * logic breaks if the map changes - and its scoring is kept too. What the bands change is the
 * balloons' size and the game's speed: faster, the balloons fire sooner in real time. The
 * limit is set in game time so every run lasts sixty real seconds, as cA fuglaapressure's
 * 108 at timescale 1.8 does.
 */
function pressureClick(f: Family, spec: PressureSpec, description: string) {
  return (sce: Sce, band: Band) => {
    const deg = step(spec.deg, SIZE, band);
    const { bot, character } = ownBot(sce, f.name);
    setProfile(sce, "Character Profile", character, { MainBBRadius: radiusFor(deg, spec.range), MainBBHeight: 2 * radiusFor(deg, spec.range) });
    const timescale = spec.timescale + spec.timescaleStep * band;
    setBots(sce, [{ bot, count: spec.alive }]);
    head(
      sce,
      f,
      band,
      {
        Timescale: timescale,
        Timelimit: 60 * timescale,
        // The template's own scoring: half a point per damage, a point lost per damage taken.
        ScorePerDamage: Number(get(sce.head, "ScorePerDamage")),
        ScorePerKill: 0,
        ScorePerHit: 0,
        AimTypeTag: "Clicking",
        AimSubTypeTag: "Static",
      },
      description,
    );
    finish(sce);
  };
}

// ---- skeet ------------------------------------------------------------------------------------

interface SkeetSpec {
  alive: number;
  deg: number;
  ttk: number;
  /** Skeet Tracking's own field: its targets fly about 960 units out (validate:sce's reader). */
  range: number;
}

/**
 * Clay pigeons: Skeet Tracking's targets have no walking speed at all and are thrown by a
 * movement ability - sideways along their strafe, and up - every couple of seconds, and
 * gravity draws the arc. The ability is kept (it is the scenario); its throw grows by the
 * speed step each band, and the kill time is set, as for every switching family, through
 * health against a 100-shots-a-second gun.
 */
function skeet(f: Family, spec: SkeetSpec, description: string) {
  return (sce: Sce, band: Band) => {
    const deg = step(spec.deg, SIZE, band);
    const { bot, character } = ownBot(sce, f.name, { keepAbilities: true });
    const weapon = weaponOf(sce);
    setProfile(sce, "Weapon Profile", weapon, { DamagePerShot: 1, TimeBetweenShots: 0.01 });
    setProfile(sce, "Character Profile", character, {
      MainBBRadius: radiusFor(deg, spec.range),
      MainBBHeight: 2 * radiusFor(deg, spec.range),
      MaxHealth: spec.ttk / 0.01,
    });
    const ability = list(get(profile(sce, "Character Profile", character)!.lines, "AbilityProfileNames"))[0]?.replace(/\.abil\w+$/i, "");
    if (ability) {
      const a = profile(sce, "Movement Ability Profile", ability)!;
      const k = Math.pow(SPEED, band);
      setProfile(sce, "Movement Ability Profile", ability, { MainVelocity: Number(get(a.lines, "MainVelocity")) * k, UpVelocity: Number(get(a.lines, "UpVelocity")) * k });
    }
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 0, ScorePerHit: 1, ScorePerDamage: 0, AimTypeTag: "Target Switching", AimSubTypeTag: "Evasive" }, description);
    finish(sce);
  };
}

// ---- the families -----------------------------------------------------------------------------

const ring = (lo: number, hi: number, n: number) => [...span(-hi, -lo, n), ...span(lo, hi, n)];

/*
 * Two limits every spawn field below keeps, both checked by validate:season2:
 *
 *   - Nothing spawns more than 45 degrees off centre. At the 103-degree horizontal FOV the
 *     templates lock to, 51.5 is the edge of the screen, and a target past it has to be
 *     found before it can be flicked to, which turns a flick drill into a search. Horizon
 *     first went to 60.
 *   - Neighbouring spawn points are further apart than the Novice target is wide, so two
 *     live targets can never overlap. Meridian and Zenith first put rows 1.5 degrees apart
 *     for a 1.6-degree target.
 */

function family(f: Omit<Family, "build">, build: (f: Family) => Family["build"]): Family {
  const out = { ...f, build: (() => {}) as Family["build"] };
  out.build = build(out);
  return out;
}

export const FAMILIES: Family[] = [
  // ---- Static Clicking
  family(
    {
      name: "Galaga", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Five targets on one level; flick sideways and stop dead.",
      why: "Horizontal flicks isolated. Wide Wall and 1w3ts mix both axes, so a player who over-travels sideways and one who under-travels vertically get the same score and no hint which they are.",
      learnsFrom: ["Wide Wall 3 Targets", "VT 1w3ts Intermediate S5"],
    },
    (f) => staticClick(f, { alive: 5, deg: 1.6, yaws: ring(3, 32, 8), pitches: [-2, 0, 2] }, "Five targets on one horizontal band. One click each."),
  ),
  family(
    {
      name: "Zenith", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Flick up and down; the sideways movement is only ever a correction.",
      why: "Vertical flicks isolated. Of the 58 static clicking scenarios measured with 10,000 or more players, 51 spawn targets over a field wider than it is tall (data/season-2/science.json), so vertical stopping gets the least practice.",
      learnsFrom: ["cA y-axis flick", "1wall6targets TE"],
    },
    (f) => staticClick(f, { alive: 3, deg: 1.6, yaws: [-2, 0, 2], pitches: ring(4, 22, 6) }, "Three targets on one vertical band. One click each."),
  ),
  family(
    {
      name: "Pinpoint", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Fingertip",
      focus: "Small moves, smaller targets; settle the crosshair before you click.",
      why: "Micro-correction at close spacing, the skill behind 1w2ts and Raw Mouse Control; RawMouseControlClicking3 is replayed 51.6 times per player (data/fun_audit.json).",
      learnsFrom: ["1w2ts Perfected", "RawMouseControlClicking3"],
    },
    (f) => staticClick(f, { alive: 2, deg: 0.95, yaws: span(-7, 7, 8), pitches: span(-4.5, 4.5, 6) }, "Two small targets close together. One click each."),
  ),
  family(
    {
      name: "Stars", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Arm",
      focus: "A wide formation; big flicks across it, in both directions.",
      why: "Large-amplitude flicks over a wide two-dimensional field, where Galaga keeps to one line. Targets are larger to keep the index of difficulty in the same range as the rest of the category.",
      learnsFrom: ["Odd-Angleshot Avasive", "ww6t Avasive Easier"],
    },
    (f) => staticClick(f, { alive: 4, deg: 2.2, yaws: span(-44, 44, 12), pitches: span(-12, 12, 4) }, "Four targets in a wide formation. One click each."),
  ),
  family(
    {
      name: "Constellation", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Clear the whole constellation; the next one appears when its last star falls.",
      why: "Real star patterns as waves - the Big Dipper, the Little Dipper, Orion, Cassiopeia, Cygnus, Leo - seven stars each, so every wave is a route to plan as well as seven flicks to make.",
      learnsFrom: ["StrawberryClick Revosect Int", "1wall 6targets small"],
    },
    (f) => constellation(f, { deg: 1.7, halfWidth: 22, halfHeight: 14 }, "Real constellations, seven stars at a time. Clear one and the next appears."),
  ),
  family(
    {
      name: "Parallax", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Targets at two distances; read the size before you decide how far to move.",
      why: "Depth. The far ring is half the angular size of the near one, so the same flick distance asks for two different stopping precisions within one run.",
      learnsFrom: ["5 Sphere Hipfire", "Pokeball Frenzy Auto TE Wide"],
    },
    (f) => staticClick(f, { alive: 3, deg: 2.2, yaws: span(-22, 22, 8), pitches: span(-11, 11, 5), depthRing: 2, range: 1400 }, "Three targets on two rings, near and far. One click each."),
  ),
  family(
    {
      name: "Nebula", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Six small targets up at once; take the nearest, keep the rhythm.",
      why: "The 1wall 6targets shape - the most-played static scenario measured, 1.29 million players (data/fun_audit.json) - at every band, so the category always has a six-target scenario.",
      learnsFrom: ["1wall 6targets small", "1wall6targets TE"],
    },
    (f) => staticClick(f, { alive: 6, deg: 1.5, yaws: span(-18, 18, 10), pitches: span(-11, 11, 7) }, "Six small targets alive at once. One click each."),
  ),

  // ---- Dynamic Clicking
  family(
    {
      name: "Gravclick", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Wrist",
      focus: "Slow floaters; match their drift for a moment, then click.",
      why: "The entry to moving targets: slow, long-lived paths that reward confirming the shot rather than guessing it. Floating Heads Timing 400% has the most players of any dynamic-clicking scenario in data/fun_audit.json (352,281).",
      learnsFrom: ["Floating Heads Timing 400%", "VT Floating Heads Novice S5"],
    },
    (f) => movingClick(f, { alive: 5, deg: 1.9, speed: 12, strafe: [4, 8] }, "Five targets floating slowly. One click each."),
  ),
  family(
    {
      name: "Pendulum", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Wrist",
      focus: "Slow swings from wall to wall; click on the swing, not only at the turn.",
      why: "A pendulum: slow, straight, level runs that turn only at the walls, so the swing is long and even and the skill is horizontal timing alone. Its movement is Floating Heads Timing 400%'s, slowed down.",
      learnsFrom: ["1wall5targets_pasu", "VT Pasu Novice S5"],
    },
    (f) => movingClick(f, { alive: 4, deg: 3.0, speed: 8, strafe: [6.5, 7], upDown: null, bounce: true }, "Four targets swinging slowly from wall to wall. One click each."),
  ),
  family(
    {
      name: "Antigrav", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "bounceClick", arm: "Wrist",
      focus: "Read the arc; the top of the bounce is the slowest moment.",
      why: "Gravity arcs. A bot under gravity is the one design feature that goes with both more replay and more reach (Spearman +0.10 and +0.13 over 614 catalogued scenarios): small, but the only positive signal on both.",
      learnsFrom: ["VT Popcorn Novice S5", "VT Bounceshot Intermediate"],
    },
    (f) => bounceClick(f, { alive: 5, deg: 2.0, speed: 17, gravity: 1.0 }, "Five targets bouncing around the room. One click each."),
  ),
  family(
    {
      name: "Electric", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Fingertip",
      focus: "Straight runs, a dead stop at every turn, and a charged-up buzz all the while.",
      why: "Linear motion with a vibration on top: the target runs straight, stops dead before it changes direction, and shakes up and down many times a second the whole time - so the stop is the moment to click, and the player reads it through the noise, the micro-adjustment cA 5ts vibrate is played for.",
      learnsFrom: ["cA 5ts vibrate", "VT Floating Heads Novice S5"],
    },
    (f) => movingClick(f, { alive: 4, deg: 2.0, speed: 12, strafe: [1.5, 2.5], upDown: null, flyer: true, stopAtTurns: [0.35, 0.6], vibrate: { times: [0.04, 0.08], speed: 8 } }, "Four targets running straight, stopping dead at every turn, buzzing all the while. One click each."),
  ),
  family(
    {
      name: "Sun and Moon", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Arm",
      focus: "Two fast crossers in an open sky; move with the target and click inside the motion.",
      why: "High-speed dynamic clicks. Speed is the other axis of difficulty besides size: at the board median the fitted model prices a doubling of angular speed, 20 to 40 degrees a second, at about half a bit of Fitts difficulty (0.55).",
      learnsFrom: ["VT Pasu Intermediate S5", "Aimerz+ pipeClick Easy S1"],
    },
    (f) => movingClick(f, { alive: 2, deg: 2.6, speed: 34, strafe: [2, 3], upDown: [2, 3], flyer: true, openRoom: true }, "Two fast targets crossing an open room. One click each."),
  ),
  family(
    {
      name: "Shooting Stars", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Wrist",
      focus: "Straight lines across the sky; lead nothing, match the line and click.",
      why: "Linear motion, the Floating Heads idea made exact: every target runs a straight lane from one side of the view to the other and back, rising or falling a little on the way, so the path is readable at a glance and the only question is timing.",
      learnsFrom: ["Floating Heads Timing 400%", "Star Clicking 30% Larger"],
    },
    (f) => pathClick(f, { alive: 6, deg: 2.0, speed: 20, range: 2048, routes: lanes(12, 36, 16, 6) }, "Six targets running straight lanes back and forth. One click each."),
  ),
  family(
    {
      name: "Gravity Well", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "pressure", arm: "Wrist",
      pressure: true,
      anchor: "cA fuglaapressure",
      modelClass: "click",
      focus: "Pop them before they fire; every hit you take costs you.",
      why: "Speed clicking under pressure, on fuglaa's design: still balloons that aim at the player and shoot a moment later, so a target left alive costs score rather than only time. The game runs faster each band, and the balloons shoot sooner with it.",
      learnsFrom: ["cA fuglaapressure", "fuglaaPressure"],
    },
    (f) => pressureClick(f, { alive: 5, deg: 1.6, timescale: 1.0, timescaleStep: 0.2, range: 18160 }, "Balloons that fire back: pop each one before it hits you. Every hit costs score."),
  ),
  family(
    {
      name: "Meteor", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Wrist",
      focus: "Floating heads: big, slow drifters; confirm the shot before you click.",
      why: "Voltaic's Floating Heads movement exactly - its own two dodge profiles, untouched - with larger, slower targets, so the most-played floating movement is in the season at a Novice anyone can start on.",
      learnsFrom: ["VT Floating Heads Novice S5", "VT Floating Heads Viscose Easier"],
    },
    (f) => movingClick(f, { alive: 5, deg: 2.8, speed: 10, strafe: [1, 2], templateMovement: true }, "Five large targets floating as Voltaic's Floating Heads do. One click each."),
  ),
  family(
    {
      name: "Satellite", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Arm",
      focus: "Fliers circling you as they rise and fall; follow the orbit and click.",
      why: "psalmTS's motion as a clicking task: targets strafe round the player on long, even runs while climbing and dropping, linear in each axis and curved together.",
      learnsFrom: ["psalmTS angelic click", "VT psalmTS Novice"],
    },
    (f) => movingClick(f, { alive: 3, deg: 3.0, speed: 14, strafe: [3, 4], upDown: [1.2, 2.0], flyer: true, openRoom: true }, "Three flying targets circling in an open room while rising and falling. One click each."),
  ),

  // ---- Precise Tracking
  family(
    {
      name: "Glide", category: "Precise Tracking", subCategory: "Precise Tracking", template: "groundTrack", arm: "Arm",
      focus: "Long, smooth strafes; ease into each turn with the target.",
      why: "Smoothness on the ground. The target accelerates over a third of a second, so its reversals are gentle and following them cleanly is the whole skill.",
      learnsFrom: ["SmoothBot Invincible Goated", "VT PGT Novice S5"],
    },
    (f) => track(f, { deg: 4.6, speed: 48, strafe: [1.4, 2.2], range: 1200, rampSeconds: 0.33 }, "One target on the ground, strafing smoothly.", "Precise"),
  ),
  family(
    {
      name: "Blastoff", category: "Precise Tracking", subCategory: "Precise Tracking", template: "airTrack", arm: "Wrist",
      focus: "Mostly up and down; keep the crosshair level with it through each turn.",
      why: "Vertical smoothness, which ground tracking barely tests. The target flies, turns vertically about as often as it strafes, and strafes slowly.",
      learnsFrom: ["Centering II 180 Intermediate", "VT Aether Novice S5"],
    },
    (f) => track(f, { deg: 4.0, speed: 30, strafe: [2.6, 3.6], upDown: [0.9, 1.4], range: 1200, rampSeconds: 0.35 }, "One flying target moving mostly up and down.", "Precise"),
  ),
  family(
    {
      name: "Orbit", category: "Precise Tracking", subCategory: "Precise Tracking", template: "airTrack", arm: "Arm",
      focus: "Curves in both directions; follow the path, do not cut its corners.",
      why: "Two-axis smooth tracking: horizontal and vertical reversals on similar clocks draw curves rather than lines.",
      learnsFrom: ["PGTI Voltaic Easy", "Smoothsphere Viscose Easier"],
    },
    (f) => track(f, { deg: 3.6, speed: 40, strafe: [1.2, 1.8], upDown: [1.0, 1.6], range: 1500, rampSeconds: 0.4 }, "One flying target moving in smooth curves.", "Precise"),
  ),
  family(
    {
      name: "Thread", category: "Precise Tracking", subCategory: "Precise Tracking", template: "groundTrack", arm: "Fingertip",
      focus: "A small, slow target; precision over speed.",
      why: "Fine control: at this size the tolerance for drift is under a degree, and at this speed there is no excuse for it.",
      learnsFrom: ["Controlsphere rAim Easy", "Whisphere Small & Slow 55%"],
    },
    (f) => track(f, { deg: 2.2, speed: 20, strafe: [1.6, 2.6], range: 1800, rampSeconds: 0.35 }, "One small target strafing slowly.", "Precise"),
  ),
  family(
    {
      name: "Arc", category: "Precise Tracking", subCategory: "Precise Tracking", template: "groundTrack", arm: "Blending",
      focus: "Long jumps under low gravity; carry the crosshair along the arc.",
      why: "Smooth diagonal tracking: slow strafes combined with floaty jumps, so the path is an arc rather than a line or a zig-zag.",
      learnsFrom: ["VT PGT Novice S5", "Air Angelic 4 Voltaic Easy"],
    },
    (f) => track(f, { deg: 4.0, speed: 36, strafe: [1.8, 2.8], range: 1400, rampSeconds: 0.35, jump: { frequency: 0.6, velocity: 700, gravity: 0.45 } }, "One target strafing and jumping in long arcs.", "Precise"),
  ),
  family(
    {
      name: "AlienTrack", category: "Precise Tracking", subCategory: "Precise Tracking", template: "groundTrack", arm: "Arm",
      focus: "A close target sweeping wide that blinks now and then; track it, and find it again after the jump.",
      why: "Close range means large angular speed at a modest real speed, the arm-tracking demand Smoothbot and Close Long Strafes are played for; and Ground Plaza's blink, a short teleport, rare at Novice and more frequent every band, so recovery joins smoothness.",
      learnsFrom: ["Close Long Strafes Invincible", "Ground Plaza Sparky V3"],
    },
    (f) => track(f, { deg: 7.5, speed: 80, strafe: [1.3, 2.0], forwardBack: [1.5, 2.5], range: 650, rampSeconds: 0.3, blink: { every: 6, degrees: 16 } }, "One close target sweeping across the view, blinking now and then.", "Precise"),
  ),

  // ---- Reactive Tracking
  family(
    {
      name: "Pong", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Arm",
      focus: "Close, snappy strafes; react to the turn, do not predict it.",
      why: "The close-range strafe duel of Close Fast Strafes (117,749 players, 22.4 plays each, data/fun_audit.json).",
      learnsFrom: ["Close Fast Strafes Invincible", "VT Ground Novice S5"],
    },
    (f) => track(f, { deg: 6.0, speed: 72, strafe: [0.35, 0.8], range: 1000, rampSeconds: 0.08 }, "One target close by, strafing sharply.", "Reactive"),
  ),
  family(
    {
      name: "Pong3D", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Wrist",
      focus: "Strafes and range changes; the target shrinks and grows as it moves.",
      why: "Mid-range reactive tracking with forward and back movement, so size and speed change under the player during a strafe.",
      learnsFrom: ["Ground Plaza Sparky V3", "VT Ground Intermediate S5"],
    },
    (f) => track(f, { deg: 4.2, speed: 52, strafe: [0.5, 1.1], forwardBack: [0.8, 1.5], range: 1400, rampSeconds: 0.1 }, "One target at mid range strafing and changing distance.", "Reactive"),
  ),
  family(
    {
      name: "Stutter", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Wrist",
      focus: "It stops before it turns, and now and then stops dead for a second or two; stop with it.",
      why: "Stop-start movement: a pause before each reversal, and every so often a full stop of a second or two, punish the player who keeps moving on momentum, a common reactive-tracking fault.",
      learnsFrom: ["Flicker Plaza rAim Easy Less Blinks", "Leapstrafes Control wobin Easier"],
    },
    (f) => track(f, { deg: 4.8, speed: 58, strafe: [0.4, 0.9], pause: [0.1, 0.35], range: 1150, rampSeconds: 0.08, hold: { pause: [1.2, 1.8], every: [2.5, 4], share: 0.3 } }, "One target that pauses before each change of direction, and sometimes stops dead.", "Reactive"),
  ),
  family(
    {
      name: "Hover", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Blending",
      focus: "Jumps and short strafes together; follow it up as well as across.",
      why: "Reactive tracking through the air, the pattern of Air Angelic 4, which nine of evxl's listed benchmarks use.",
      learnsFrom: ["Air Angelic 4 Voltaic", "Air Pure Intermediate"],
    },
    (f) => track(f, { deg: 4.4, speed: 46, strafe: [0.45, 1.0], range: 1300, rampSeconds: 0.1, jump: { frequency: 0.7, velocity: 650, gravity: 1.0 } }, "One target jumping and strafing.", "Reactive"),
  ),
  family(
    {
      name: "UFO", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "airTrack", arm: "Wrist",
      focus: "A flier changing direction on both axes; react on whichever one moves.",
      why: "Three-dimensional reactive tracking: short horizontal and vertical reversals on independent clocks.",
      learnsFrom: ["VT Aether Novice S5", "Air CELESTIAL No UFO Easy"],
    },
    (f) => track(f, { deg: 5.2, speed: 62, strafe: [0.35, 0.75], upDown: [0.35, 0.8], range: 1000, rampSeconds: 0.12 }, "One flying target changing direction in every axis.", "Reactive"),
  ),
  family(
    {
      name: "Feint", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Wrist",
      focus: "Being tracked makes it turn; stay on it through the dodge.",
      why: "Reactive dodging: the target reverses shortly after it is hit, so the longer a player holds on, the more it tests the recovery rather than the lock.",
      learnsFrom: ["1wall 6targets small", "Close Fast Strafes Invincible"],
    },
    (f) => track(f, { deg: 5.0, speed: 60, strafe: [0.6, 1.3], range: 1150, rampSeconds: 0.08, juke: { delay: [0.15, 0.3], ignore: 0.35 } }, "One target that dodges when it is hit.", "Reactive"),
  ),

  // ---- Speed Switching
  family(
    {
      name: "DNA", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Kill, then move straight to the next; no pause between targets.",
      why: "The core speed-switching loop on still targets in a compact field: the time between targets is what the score measures.",
      learnsFrom: ["VT skyTS Novice", "beanTS"],
    },
    (f) => switching(f, { alive: 3, deg: 2.4, ttk: 0.25, speed: 0, range: 2000, field: { yaws: span(-18, 18, 9), pitches: span(-10, 10, 5) } }, "Three still targets close together. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "CockpiTS", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Arm",
      focus: "Wide switches; land the flick, then hold.",
      why: "Speed switching across a wide field, where the flick between targets is most of the time spent.",
      learnsFrom: ["voxTS Viscose Varied", "VT DotTS Novice S5"],
    },
    (f) => switching(f, { alive: 3, deg: 2.8, ttk: 0.25, speed: 0, range: 2000, field: { yaws: ring(10, 45, 6), pitches: span(-9, 9, 4) } }, "Three still targets spread wide. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "Column", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Switch up and down; stop on each one before you fire.",
      why: "Vertical switching, the axis the rest of the category barely uses.",
      learnsFrom: ["VT psalmTS Novice", "Pokeball 1w4ts 30%"],
    },
    (f) => switching(f, { alive: 3, deg: 2.4, ttk: 0.25, speed: 0, range: 2000, field: { yaws: [-3, 0, 3], pitches: ring(4, 24, 6) } }, "Three still targets stacked vertically. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "Asteroids", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Fingertip",
      focus: "Six small targets packed tight; short, exact moves.",
      why: "Precision switching: small targets and small moves, the micro side of speed switching.",
      learnsFrom: ["Pokeball Frenzy Auto Small Wide", "patCircleSwitch NR"],
    },
    (f) => switching(f, { alive: 6, deg: 1.5, ttk: 0.2, speed: 0, range: 2200, field: { yaws: span(-10, 10, 9), pitches: span(-6, 6, 6) } }, "Six small still targets packed together. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "RockeTS", category: "Speed Switching", subCategory: "Speed Switching", template: "airSwitch", arm: "Wrist",
      focus: "Slow floaters that fall fast; the switch is the skill, the tracking only has to be clean.",
      why: "Speed switching on slow movers, the bridge to evasive switching: EddieTS (185,895 players on its Novice cut) at a gentler pace, with short kills so the switch dominates.",
      learnsFrom: ["VT EddieTS Novice S5", "waldoTS"],
    },
    (f) => switching(f, { alive: 4, deg: 2.6, ttk: 0.18, speed: 12, strafe: [2.5, 3.8], upDown: [1.2, 1.8], range: 2500 }, "Four slow floating targets that fall quickly. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "MartianTS", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Each target takes a while; stay on it to the end, then switch.",
      why: "Longer kills on still targets: the discipline of finishing before leaving, which short-kill scenarios never test.",
      learnsFrom: ["VT ControlTS Novice S5", "patTargetSwitch easy"],
    },
    (f) => switching(f, { alive: 4, deg: 2.3, ttk: 0.5, speed: 0, range: 2000, field: { yaws: span(-26, 26, 10), pitches: span(-12, 12, 5) } }, "Four still targets that take longer to kill. Hold fire to kill.", "Speed"),
  ),

  // ---- Evasive Switching
  family(
    {
      name: "FleeTS", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Six strafing targets; kill one without losing track of the others.",
      why: "The standard evasive-switching problem, targets that move while you are on them and while you are not, at the pace of DriftTS.",
      learnsFrom: ["VT DriftTS Novice S5", "domiSwitch Easy"],
    },
    (f) => switching(f, { alive: 6, deg: 2.9, ttk: 0.45, speed: 28, strafe: [0.7, 1.3], range: 1900 }, "Six targets strafing. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "skeeTS", category: "Evasive Switching", subCategory: "Evasive Switching", template: "skeet", arm: "Blending",
      anchor: "Skeet Tracking",
      focus: "Clay pigeons thrown across the field; catch each one on its arc.",
      why: "Skeet Tracking's own mechanism - targets with no walking speed, thrown sideways and up by a movement ability, falling under gravity. It has the most players of any evasive-switching scenario in data/fun_audit.json (385,771, 31.3 plays each).",
      learnsFrom: ["Skeet Tracking", "Skeet Clicking"],
    },
    (f) => skeet(f, { alive: 4, deg: 2.8, ttk: 0.5, range: 960 }, "Four clay pigeons thrown in arcs. Hold fire to kill."),
  ),
  family(
    {
      name: "comeTS", category: "Evasive Switching", subCategory: "Evasive Switching", template: "airSwitch", arm: "Wrist",
      focus: "Fliers sweeping round in curves; pick the next one before this one dies.",
      why: "Three-dimensional evasive switching on curved paths: horizontal and vertical reversals on matching clocks with slow acceleration, so each target sweeps round in an arc instead of zig-zagging.",
      learnsFrom: ["VT FlyTS Intermediate S5", "VT EddieTS Intermediate S5"],
    },
    (f) => switching(f, { alive: 4, deg: 2.7, ttk: 0.4, speed: 22, strafe: [1.2, 1.6], upDown: [1.2, 1.6], range: 2200, ramp: 0.7 }, "Four flying targets sweeping round in curves. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "QuantumTS", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Targets heal when left alone; finish every kill you start.",
      why: "Regeneration makes leaving early costly: a half-killed target is back to full a second later. Regen Control and tamTargetSwitch are played for exactly this.",
      learnsFrom: ["tamTargetSwitch Control Hard", "VT ControlTS Intermediate S5"],
    },
    (f) => switching(f, { alive: 3, deg: 2.8, ttk: 0.55, speed: 22, strafe: [0.7, 1.3], range: 1900, regen: { perSecond: 1.2, delay: 0.35 } }, "Three strafing targets that heal when not being hit. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "LosTS", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Wrist",
      modelClass: "track",
      focus: "One tough target; stay on it, and find it again the moment it respawns.",
      why: "One evasive target with enough health to take a sustained effort, which respawns somewhere new when it dies: the kill-then-reacquire loop of switching with nothing else on screen to hide behind.",
      learnsFrom: ["VT DriftTS Novice S5", "Close Fast Strafes Invincible"],
    },
    (f) => switching(f, { alive: 1, deg: 3.4, ttk: 1.5, speed: 34, strafe: [0.6, 1.2], range: 1700, openRoom: true }, "One strafing target with plenty of health that respawns elsewhere when it dies. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "InvadersTS", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Arm",
      focus: "Close targets moving fast across the view; stay with them, then turn to the next.",
      why: "Close-range evasive switching, where modest real speeds become large angular speeds and every switch is also a tracking catch-up.",
      learnsFrom: ["VT DriftTS Intermediate S5", "Close Fast Strafes Invincible"],
    },
    (f) => switching(f, { alive: 3, deg: 5.0, ttk: 0.45, speed: 55, strafe: [0.7, 1.2], range: 1000, openRoom: true }, "Three close targets strafing fast. Hold fire to kill.", "Evasive"),
  ),
];

export function buildScenario(template: Sce, f: Family, band: Band, lib: Library): Sce {
  const sce: Sce = structuredClone(template);
  f.build(sce, band, lib);
  return sce;
}

