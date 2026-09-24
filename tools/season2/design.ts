/**
 * Season 2: thirty-six authored families, six per category, four bands each.
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
  atAngle,
  cloneProfile,
  prune,
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
  build: (sce: Sce, band: Band) => void;
}

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
    SearchTags: `Apogee, Apogee Season 2, ${f.category}, ${BANDS[band]}`,
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
function ownBot(sce: Sce, tag: string): { bot: string; character: string; dodge: string } {
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
  const botValues: Values = {
    CharacterProfile: character,
    RandomizeDodgeProfiles: false,
  };
  if (fromDodge) {
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

function fixedTargets(sce: Sce, f: Family, band: Band, spawns: Vec[]): void {
  setRoom(sce, { ...roomAround(spawns), spawns }, `Apogee ${f.name} ${BANDS[band]}.json`);
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
}

function movingClick(f: Family, spec: MovingClickSpec, description: string) {
  return (sce: Sce, band: Band) => {
    const range = spec.range ?? 2000;
    const deg = step(spec.deg, SIZE, band);
    const speed = step(spec.speed, SPEED, band);
    const k = Math.pow(PERIOD, band);
    const { bot, character, dodge } = ownBot(sce, f.name);
    setProfile(sce, "Character Profile", character, {
      MainBBRadius: radiusFor(deg, range),
      MainBBHeight: 2 * radiusFor(deg, range),
      MaxSpeed: speedFor(speed, range),
      MaxHealth: spec.hits ?? 1,
    });
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
      // One height band: no vertical toggles and no hops.
      dodgeValues.ToggleUpDownMinTime = 30;
      dodgeValues.ToggleUpDownMaxTime = 30;
      dodgeValues.JumpFrequency = 0;
    }
    setProfile(sce, "Dodge Profile", dodge, dodgeValues);
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 10, ScorePerHit: 0, AimTypeTag: "Clicking", AimSubTypeTag: "Dynamic" }, description);
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
}

function track(f: Family, spec: TrackSpec, description: string, sub: "Precise" | "Reactive") {
  return (sce: Sce, band: Band) => {
    const deg = step(spec.deg, SIZE, band);
    const speed = step(spec.speed, SPEED, band);
    const k = Math.pow(PERIOD, band);
    const { bot, character, dodge } = ownBot(sce, f.name);
    const maxSpeed = speedFor(speed, spec.range);
    const chr: Values = {
      MainBBRadius: radiusFor(deg, spec.range),
      MaxSpeed: maxSpeed,
      Acceleration: maxSpeed / spec.rampSeconds,
      // A target that never dies and never decays: tracking is scored on time on target,
      // and a respawn gap would be a pause nobody chose.
      MaxHealth: 1_000_000,
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
    if (maxSpeed > 0) chr.Acceleration = maxSpeed * 4;
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
    }
    setBots(sce, [{ bot, count: spec.alive }]);
    head(sce, f, band, { ScorePerKill: 0, ScorePerHit: 1, AimTypeTag: "Target Switching", AimSubTypeTag: sub }, description);
    finish(sce);
  };
}

// ---- the families -----------------------------------------------------------------------------

const ring = (lo: number, hi: number, n: number) => [...span(-hi, -lo, n), ...span(lo, hi, n)];

function family(f: Omit<Family, "build">, build: (f: Family) => Family["build"]): Family {
  const out = { ...f, build: (() => {}) as Family["build"] };
  out.build = build(out);
  return out;
}

export const FAMILIES: Family[] = [
  // ---- Static Clicking
  family(
    {
      name: "Meridian", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Flick sideways and stop dead; every target sits on one level.",
      why: "Horizontal flicks isolated. Wide Wall and 1w3ts mix both axes, so a player who over-travels sideways and one who under-travels vertically get the same score and no hint which they are.",
      learnsFrom: ["Wide Wall 3 Targets", "VT 1w3ts Intermediate S5"],
    },
    (f) => staticClick(f, { alive: 3, deg: 1.6, yaws: ring(5, 30, 6), pitches: [-1.5, 0, 1.5] }, "Three targets on one horizontal band. One click each."),
  ),
  family(
    {
      name: "Zenith", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Flick up and down; the sideways movement is only ever a correction.",
      why: "Vertical flicks isolated. Of the 58 static clicking scenarios measured with 10,000 or more players, 51 spawn targets over a field wider than it is tall (data/season-2/science.json), so vertical stopping gets the least practice.",
      learnsFrom: ["cA y-axis flick", "1wall6targets TE"],
    },
    (f) => staticClick(f, { alive: 3, deg: 1.6, yaws: [-1.5, 0, 1.5], pitches: ring(4, 22, 6) }, "Three targets on one vertical band. One click each."),
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
      name: "Horizon", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Arm",
      focus: "Big flicks across the room; commit to the distance and stop on the target.",
      why: "Large-amplitude flicks, which small-field scenarios never ask for. Targets are larger to keep the index of difficulty in the same range as the rest of the category.",
      learnsFrom: ["Odd-Angleshot Avasive", "ww6t Avasive Easier"],
    },
    (f) => staticClick(f, { alive: 3, deg: 2.2, yaws: ring(18, 60, 7), pitches: span(-10, 10, 5) }, "Three targets spread wide across the room. One click each."),
  ),
  family(
    {
      name: "Constellation", category: "Static Clicking", subCategory: "Static Clicking", template: "staticClick", arm: "Wrist",
      focus: "Five targets up at once; keep a rhythm and take the nearest one next.",
      why: "The tempo of 1wall 6targets small and Tile Frenzy (1.29 million and 0.74 million players, data/fun_audit.json), on a field where every target is the same distance away.",
      learnsFrom: ["1wall 6targets small", "Tile Frenzy", "1wall6targets TE"],
    },
    (f) => staticClick(f, { alive: 5, deg: 1.9, yaws: span(-20, 20, 9), pitches: span(-12, 12, 7) }, "Five targets alive at once in a medium field. One click each."),
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

  // ---- Dynamic Clicking
  family(
    {
      name: "Drift", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Wrist",
      focus: "Slow floaters; match their drift for a moment, then click.",
      why: "The entry to moving targets: slow, long-lived paths that reward confirming the shot rather than guessing it. Floating Heads Timing 400% has the most players of any dynamic-clicking scenario in data/fun_audit.json (352,281).",
      learnsFrom: ["Floating Heads Timing 400%", "VT Floating Heads Novice S5"],
    },
    (f) => movingClick(f, { alive: 5, deg: 1.9, speed: 12, strafe: [4, 8] }, "Five targets floating slowly. One click each."),
  ),
  family(
    {
      name: "Pendulum", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Wrist",
      focus: "Side-to-side swings; click on the swing, not only at the turn.",
      why: "Pasu's long horizontal strafes with a predictable reversal, kept on one height so the skill is horizontal timing alone.",
      learnsFrom: ["1wall5targets_pasu", "VT Pasu Novice S5"],
    },
    (f) => movingClick(f, { alive: 3, deg: 2.2, speed: 22, strafe: [1.4, 2.0], upDown: null }, "Three targets swinging side to side. One click each."),
  ),
  family(
    {
      name: "Hopper", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "bounceClick", arm: "Wrist",
      focus: "Read the arc; the top of the bounce is the slowest moment.",
      why: "Gravity arcs. A bot under gravity is the one design feature that goes with both more replay and more reach (Spearman +0.10 and +0.13 over 614 catalogued scenarios): small, but the only positive signal on both.",
      learnsFrom: ["VT Popcorn Novice S5", "VT Bounceshot Intermediate"],
    },
    (f) => bounceClick(f, { alive: 5, deg: 2.0, speed: 17, gravity: 1.0 }, "Five targets bouncing around the room. One click each."),
  ),
  family(
    {
      name: "Jitter", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Fingertip",
      focus: "Short, erratic twitches; stay with the target instead of chasing its last position.",
      why: "Reactive micro-clicking: short strafes at low speed, so the target never travels far but never holds still either.",
      learnsFrom: ["cA 5ts vibrate", "VT Floating Heads Novice S5"],
    },
    (f) => movingClick(f, { alive: 4, deg: 1.8, speed: 10, strafe: [0.25, 0.5], upDown: [0.3, 0.6] }, "Four targets twitching in short bursts. One click each."),
  ),
  family(
    {
      name: "Comet", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Arm",
      focus: "Fast crossers; move with the target and click inside the motion.",
      why: "High-speed dynamic clicks. Speed is the other axis of difficulty besides size: at the board median the fitted model prices a doubling of angular speed, 20 to 40 degrees a second, at about 0.8 bits of Fitts difficulty.",
      learnsFrom: ["VT Pasu Intermediate S5", "Aimerz+ pipeClick Easy S1"],
    },
    (f) => movingClick(f, { alive: 3, deg: 2.6, speed: 34, strafe: [2, 3], upDown: [2, 3] }, "Three fast targets crossing the view. One click each."),
  ),
  family(
    {
      name: "Triplet", category: "Dynamic Clicking", subCategory: "Dynamic Clicking", template: "movingClick", arm: "Wrist",
      focus: "Three hits to kill; keep matching the movement between clicks.",
      why: "Multi-click confirmation on a moving target, which one-hit scenarios never ask for: a miss on the second click is a lost rhythm, not a lost target.",
      learnsFrom: ["VT Popcorn Intermediate S5", "Tamspeed 2bp Iron"],
    },
    (f) => movingClick(f, { alive: 3, deg: 2.1, speed: 14, strafe: [1.2, 2.4], hits: 3 }, "Three moving targets, three hits each."),
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
      name: "Lift", category: "Precise Tracking", subCategory: "Precise Tracking", template: "airTrack", arm: "Wrist",
      focus: "Mostly up and down; keep the crosshair level with it through each turn.",
      why: "Vertical smoothness, which ground tracking barely tests. The target flies, turns vertically about as often as it strafes, and strafes slowly.",
      learnsFrom: ["Centering II 180 Intermediate", "VT Aether Novice S5"],
    },
    (f) => track(f, { deg: 4.0, speed: 30, strafe: [2.6, 3.6], upDown: [0.9, 1.4], range: 1200, rampSeconds: 0.35 }, "One flying target moving mostly up and down.", "Precise"),
  ),
  family(
    {
      name: "Loop", category: "Precise Tracking", subCategory: "Precise Tracking", template: "airTrack", arm: "Arm",
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
      name: "Orbit", category: "Precise Tracking", subCategory: "Precise Tracking", template: "groundTrack", arm: "Arm",
      focus: "A close target sweeping wide; track with your arm, not only your wrist.",
      why: "Close range means large angular speed at a modest real speed: the arm-tracking demand Smoothbot and Close Long Strafes are played for.",
      learnsFrom: ["Close Long Strafes Invincible", "SYW (Smooth Your Wrist) FIXED"],
    },
    (f) => track(f, { deg: 7.5, speed: 80, strafe: [1.3, 2.0], forwardBack: [1.5, 2.5], range: 650, rampSeconds: 0.3 }, "One close target sweeping across the view.", "Precise"),
  ),

  // ---- Reactive Tracking
  family(
    {
      name: "Duel", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Arm",
      focus: "Close, snappy strafes; react to the turn, do not predict it.",
      why: "The close-range strafe duel of Close Fast Strafes (117,749 players, 22.4 plays each, data/fun_audit.json).",
      learnsFrom: ["Close Fast Strafes Invincible", "VT Ground Novice S5"],
    },
    (f) => track(f, { deg: 6.0, speed: 72, strafe: [0.35, 0.8], range: 1000, rampSeconds: 0.08 }, "One target close by, strafing sharply.", "Reactive"),
  ),
  family(
    {
      name: "Skirmish", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Wrist",
      focus: "Strafes and range changes; the target shrinks and grows as it moves.",
      why: "Mid-range reactive tracking with forward and back movement, so size and speed change under the player during a strafe.",
      learnsFrom: ["Ground Plaza Sparky V3", "VT Ground Intermediate S5"],
    },
    (f) => track(f, { deg: 4.2, speed: 52, strafe: [0.5, 1.1], forwardBack: [0.8, 1.5], range: 1400, rampSeconds: 0.1 }, "One target at mid range strafing and changing distance.", "Reactive"),
  ),
  family(
    {
      name: "Stutter", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Wrist",
      focus: "It stops before it turns; stop with it.",
      why: "Stop-start movement: a pause before each reversal punishes the player who keeps moving on momentum, a common reactive-tracking fault.",
      learnsFrom: ["Flicker Plaza rAim Easy Less Blinks", "Leapstrafes Control wobin Easier"],
    },
    (f) => track(f, { deg: 4.8, speed: 58, strafe: [0.4, 0.9], pause: [0.1, 0.35], range: 1150, rampSeconds: 0.08 }, "One target that pauses before each change of direction.", "Reactive"),
  ),
  family(
    {
      name: "Aerial", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "groundTrack", arm: "Blending",
      focus: "Jumps and short strafes together; follow it up as well as across.",
      why: "Reactive tracking through the air, the pattern of Air Angelic 4, which nine of evxl's listed benchmarks use.",
      learnsFrom: ["Air Angelic 4 Voltaic", "Air Pure Intermediate"],
    },
    (f) => track(f, { deg: 4.4, speed: 46, strafe: [0.45, 1.0], range: 1300, rampSeconds: 0.1, jump: { frequency: 0.7, velocity: 650, gravity: 1.0 } }, "One target jumping and strafing.", "Reactive"),
  ),
  family(
    {
      name: "Wasp", category: "Reactive Tracking", subCategory: "Reactive Tracking", template: "airTrack", arm: "Wrist",
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
      name: "Relay", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Kill, then move straight to the next; no pause between targets.",
      why: "The core speed-switching loop on still targets in a compact field: the time between targets is what the score measures.",
      learnsFrom: ["VT skyTS Novice", "beanTS"],
    },
    (f) => switching(f, { alive: 3, deg: 2.4, ttk: 0.25, speed: 0, range: 2000, field: { yaws: span(-18, 18, 9), pitches: span(-10, 10, 5) } }, "Three still targets close together. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "Span", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Arm",
      focus: "Wide switches; land the flick, then hold.",
      why: "Speed switching across a wide field, where the flick between targets is most of the time spent.",
      learnsFrom: ["voxTS Viscose Varied", "VT DotTS Novice S5"],
    },
    (f) => switching(f, { alive: 3, deg: 2.8, ttk: 0.25, speed: 0, range: 2000, field: { yaws: ring(10, 50, 6), pitches: span(-9, 9, 4) } }, "Three still targets spread wide. Hold fire to kill.", "Speed"),
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
      name: "Cluster", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Fingertip",
      focus: "Six small targets packed tight; short, exact moves.",
      why: "Precision switching: small targets and small moves, the micro side of speed switching.",
      learnsFrom: ["Pokeball Frenzy Auto Small Wide", "patCircleSwitch NR"],
    },
    (f) => switching(f, { alive: 6, deg: 1.5, ttk: 0.2, speed: 0, range: 2200, field: { yaws: span(-10, 10, 9), pitches: span(-6, 6, 6) } }, "Six small still targets packed together. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "Drifters", category: "Speed Switching", subCategory: "Speed Switching", template: "airSwitch", arm: "Wrist",
      focus: "Slow floaters; the switch is the skill, the tracking only has to be clean.",
      why: "Speed switching on slow movers, the bridge to evasive switching: EddieTS (185,895 players on its Novice cut) at a gentler pace.",
      learnsFrom: ["VT EddieTS Novice S5", "waldoTS"],
    },
    (f) => switching(f, { alive: 4, deg: 2.6, ttk: 0.3, speed: 12, strafe: [2.5, 3.8], upDown: [1.2, 1.8], range: 2500 }, "Four slow floating targets. Hold fire to kill.", "Speed"),
  ),
  family(
    {
      name: "Finisher", category: "Speed Switching", subCategory: "Speed Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Each target takes a while; stay on it to the end, then switch.",
      why: "Longer kills on still targets: the discipline of finishing before leaving, which short-kill scenarios never test.",
      learnsFrom: ["VT ControlTS Novice S5", "patTargetSwitch easy"],
    },
    (f) => switching(f, { alive: 4, deg: 2.3, ttk: 0.5, speed: 0, range: 2000, field: { yaws: span(-26, 26, 10), pitches: span(-12, 12, 5) } }, "Four still targets that take longer to kill. Hold fire to kill.", "Speed"),
  ),

  // ---- Evasive Switching
  family(
    {
      name: "Swarm", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Three strafing targets; kill one without losing track of the others.",
      why: "The standard evasive-switching problem, targets that move while you are on them and while you are not, at the pace of DriftTS.",
      learnsFrom: ["VT DriftTS Novice S5", "domiSwitch Easy"],
    },
    (f) => switching(f, { alive: 3, deg: 2.9, ttk: 0.45, speed: 28, strafe: [0.6, 1.1], range: 1900 }, "Three targets strafing. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "Skeet", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Blending",
      focus: "Targets thrown into the air; catch each one on its arc.",
      why: "Airborne switching. Skeet Tracking has the most players of any evasive-switching scenario in data/fun_audit.json (385,771, 31.3 plays each).",
      learnsFrom: ["Skeet Tracking", "B180T Voltaic Easy"],
    },
    (f) => switching(f, { alive: 3, deg: 2.9, ttk: 0.4, speed: 24, strafe: [1.2, 2.0], range: 1900, jump: { frequency: 1.0, velocity: 900, gravity: 0.8 } }, "Three targets jumping in arcs. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "Hive", category: "Evasive Switching", subCategory: "Evasive Switching", template: "airSwitch", arm: "Wrist",
      focus: "Fliers changing direction on every axis; pick the next one before this one dies.",
      why: "Three-dimensional evasive switching: FlyTS's pattern with vertical reversals on their own clock.",
      learnsFrom: ["VT FlyTS Intermediate S5", "VT EddieTS Intermediate S5"],
    },
    (f) => switching(f, { alive: 4, deg: 2.7, ttk: 0.4, speed: 22, strafe: [0.8, 1.4], upDown: [0.6, 1.1], range: 2200 }, "Four flying targets moving in every direction. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "Mender", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Wrist",
      focus: "Targets heal when left alone; finish every kill you start.",
      why: "Regeneration makes leaving early costly: a half-killed target is back to full a second later. Regen Control and tamTargetSwitch are played for exactly this.",
      learnsFrom: ["tamTargetSwitch Control Hard", "VT ControlTS Intermediate S5"],
    },
    (f) => switching(f, { alive: 3, deg: 2.8, ttk: 0.55, speed: 22, strafe: [0.7, 1.3], range: 1900, regen: { perSecond: 1.2, delay: 0.35 } }, "Three strafing targets that heal when not being hit. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "Scatter", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Arm",
      focus: "Fast targets far apart; big switches onto moving targets.",
      why: "Evasive switching with speed and distance together: the largest angular demand in the category.",
      learnsFrom: ["VT Penta Bounce Intermediate S5", "patTargetSwitch"],
    },
    (f) => switching(f, { alive: 3, deg: 3.2, ttk: 0.4, speed: 40, strafe: [0.9, 1.6], range: 1700 }, "Three fast targets spread apart. Hold fire to kill.", "Evasive"),
  ),
  family(
    {
      name: "Brawl", category: "Evasive Switching", subCategory: "Evasive Switching", template: "groundSwitch", arm: "Arm",
      focus: "Close targets moving fast across the view; stay with them, then turn to the next.",
      why: "Close-range evasive switching, where modest real speeds become large angular speeds and every switch is also a tracking catch-up.",
      learnsFrom: ["VT DriftTS Intermediate S5", "Close Fast Strafes Invincible"],
    },
    (f) => switching(f, { alive: 3, deg: 5.0, ttk: 0.45, speed: 55, strafe: [0.5, 1.0], range: 1000 }, "Three close targets strafing fast. Hold fire to kill.", "Evasive"),
  ),
];

export function buildScenario(template: Sce, f: Family, band: Band): Sce {
  const sce: Sce = structuredClone(template);
  f.build(sce, band);
  return sce;
}

export { atAngle };
