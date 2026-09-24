/**
 * Build a scenario by editing a real one.
 *
 * Every season-2 scenario starts as a file KovaaK's itself wrote - a template - and is
 * changed only through the operations here. Writing one from nothing would mean knowing
 * the full key set a current build expects, which nothing publishes; editing a file the
 * game already loads means the only keys that change are the ones a recipe names, and
 * `set` refuses a key the template does not carry, so a typo cannot become a silently
 * ignored setting.
 *
 * Profiles refer to each other by name (scenario -> bot -> character -> weapon, bot ->
 * dodge and aim), so `prune` walks those references from the scenario head and drops
 * whatever the recipe left unreachable. A season scenario therefore carries no profile
 * that nothing uses, and none of its template's names unless a recipe kept them.
 */

import { get, list, profile, set, type Sce, type SceLine, type SceSection } from "./sce.ts";

export type Values = Record<string, string | number | boolean>;

export function setHead(sce: Sce, values: Values): void {
  for (const [k, v] of Object.entries(values)) set(sce.head, k, v);
}

export function setProfile(sce: Sce, type: string, name: string, values: Values): void {
  const p = profile(sce, type, name);
  if (!p) throw new Error(`no ${type} called ${name}`);
  for (const [k, v] of Object.entries(values)) set(p.lines, k, v);
}

/**
 * Copy a profile under a new name, placed after the last profile of its type so the file
 * keeps KovaaK's grouping. Returns the copy.
 */
export function cloneProfile(sce: Sce, type: string, from: string, to: string): SceSection {
  const source = profile(sce, type, from);
  if (!source) throw new Error(`no ${type} called ${from} to copy`);
  if (profile(sce, type, to)) throw new Error(`${type} ${to} already exists`);
  const copy: SceSection = { type, lines: source.lines.map((l) => ({ ...l })) };
  set(copy.lines, "Name", to);
  let at = -1;
  sce.sections.forEach((s, i) => {
    if (s.type === type) at = i;
  });
  sce.sections.splice(at + 1, 0, copy);
  return copy;
}

/**
 * Put these bots in the scenario, `count` of each alive at once.
 *
 * Writes every head key that is indexed per added bot, so none of them is left one entry
 * short: KovaaK's pairs `AddedBots`, `BotMaxLives` and `BotTeams` by position.
 */
export function setBots(sce: Sce, bots: Array<{ bot: string; count: number }>): void {
  const added: string[] = [];
  for (const { bot, count } of bots) {
    if (!profile(sce, "Bot Profile", bot)) throw new Error(`no Bot Profile called ${bot}`);
    for (let i = 0; i < count; i++) added.push(`${bot}.bot`);
  }
  set(sce.head, "AddedBots", added.join(";"));
  set(sce.head, "BotMaxLives", added.map(() => "0").join(";"));
  set(sce.head, "BotTeams", added.map(() => "2").join(";"));
  set(sce.head, "BotCharacters", [...new Set(added)].join(";"));
}

/** Drop every profile the head cannot reach. Returns the names dropped, for the log. */
export function prune(sce: Sce): string[] {
  const keep = new Set<string>();
  // Case-folded, as `profile` resolves names: a reference spelt `Player` keeps `player`.
  const key = (type: string, name: string) => `${type}\u0000${name.toLowerCase()}`;
  const visitCharacter = (name: string) => {
    const c = profile(sce, "Character Profile", name);
    if (!c || keep.has(key(c.type, name))) return;
    keep.add(key(c.type, name));
    for (const w of list(get(c.lines, "WeaponProfileNames"))) keep.add(key("Weapon Profile", w));
    for (const a of list(get(c.lines, "AbilityProfileNames"))) {
      for (const s of sce.sections) if (s.type.endsWith("Ability Profile") && get(s.lines, "Name") === a) keep.add(key(s.type, a));
    }
  };
  visitCharacter(get(sce.head, "PlayerProfile") ?? "");
  for (const entry of list(get(sce.head, "AddedBots"))) {
    const name = entry.replace(/\.(bot|rot)$/i, "");
    const rot = /\.rot$/i.test(entry) ? profile(sce, "Bot Rotation Profile", name) : undefined;
    const bots = rot ? list(get(rot.lines, "ProfileNames")).map((b) => b.replace(/\.bot$/i, "")) : [name];
    if (rot) keep.add(key(rot.type, name));
    for (const b of bots) {
      const bp = profile(sce, "Bot Profile", b);
      if (!bp) continue;
      keep.add(key(bp.type, b));
      visitCharacter(get(bp.lines, "CharacterProfile") ?? "");
      for (const d of list(get(bp.lines, "DodgeProfileNames"))) keep.add(key("Dodge Profile", d));
      for (const a of list(get(bp.lines, "AimingProfileNames"))) keep.add(key("Aim Profile", a));
      for (const w of list(get(bp.lines, "WeaponProfileNames") ?? get(bp.lines, "WeaponsProfileNames"))) keep.add(key("Weapon Profile", w));
    }
  }
  const dropped: string[] = [];
  sce.sections = sce.sections.filter((s) => {
    if (s.type === "Map Data") return true;
    const name = get(s.lines, "Name") ?? "";
    if (keep.has(key(s.type, name))) return true;
    dropped.push(`${s.type}: ${name}`);
    return false;
  });
  return dropped;
}

// ---- rooms --------------------------------------------------------------------------------

export interface Vec {
  x: number;
  y: number;
  z: number;
}

/**
 * A box room in map units, the player at the origin facing +X.
 *
 * `spawns` are bot spawn points. Map units become world units through the scenario's
 * MapScale, which the recipe sets. Spawn volumes are deliberately not offered: whether a
 * volume's location is its centre or its corner is not something any template settles,
 * and a room is only worth generating if where its targets appear is known exactly.
 */
export interface Room {
  min: Vec;
  max: Vec;
  spawns: Vec[];
}

type JsonObject = Record<string, unknown>;

const fmt = (v: number) => v.toFixed(6);
const triple = (v: Vec) => `${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}`;

/**
 * Replace a template's embedded JSON map with a generated room.
 *
 * Brushes and spawn objects are copied from the template's own objects and only their
 * placement is changed, so materials and every property KovaaK's writes on a spawn point
 * come from a file it wrote. A brush's `location` is its minimum corner and its `scale`
 * is its size over 100 - read off the template, whose walls meet exactly under that
 * reading - and the six walls are thick slabs so nothing can be shot or seen through.
 */
export function setRoom(sce: Sce, room: Room, mapName: string): void {
  const section = sce.sections.find((s) => s.type === "Map Data");
  if (!section?.raw || !section.raw.trimStart().startsWith("{")) {
    throw new Error("the template's map is not an embedded JSON map");
  }
  const map = JSON.parse(section.raw) as { objects: JsonObject[] } & JsonObject;
  const brush = map.objects.find((o) => o.type === "brush");
  const spawn = map.objects.find((o) => o.name === "SpawnPoint");
  if (!brush || !spawn) throw new Error("the template's map has no brush or no spawn point to copy");

  const T = 1024;
  const { min: a, max: b } = room;
  const slabs: Array<[Vec, Vec]> = [
    [{ x: a.x - T, y: a.y - T, z: a.z - T }, { x: b.x + T, y: a.y, z: b.z + T }], // -Y
    [{ x: a.x - T, y: b.y, z: a.z - T }, { x: b.x + T, y: b.y + T, z: b.z + T }], // +Y
    [{ x: a.x - T, y: a.y - T, z: a.z - T }, { x: a.x, y: b.y + T, z: b.z + T }], // -X
    [{ x: b.x, y: a.y - T, z: a.z - T }, { x: b.x + T, y: b.y + T, z: b.z + T }], // +X
    [{ x: a.x - T, y: a.y - T, z: a.z - T }, { x: b.x + T, y: b.y + T, z: a.z }], // floor
    [{ x: a.x - T, y: a.y - T, z: b.z }, { x: b.x + T, y: b.y + T, z: b.z + T }], // ceiling
  ];
  const objects: JsonObject[] = slabs.map(([lo, hi]) => ({
    ...structuredClone(brush),
    location: triple(lo),
    scale: triple({ x: (hi.x - lo.x) / 100, y: (hi.y - lo.y) / 100, z: (hi.z - lo.z) / 100 }),
    rotation: triple({ x: 0, y: 0, z: 0 }),
  }));

  const point = (at: Vec, mask: number, rotationZ: number): JsonObject => {
    const o = structuredClone(spawn) as JsonObject;
    o.location = triple(at);
    o.rotation = triple({ x: 0, y: 0, z: rotationZ });
    o.properties = (o.properties as Array<{ name: string; value: unknown }>).map((p) =>
      p.name === "TeamMask" ? { ...p, value: mask } : { ...p },
    );
    return o;
  };
  objects.push(point({ x: 0, y: 0, z: 0 }, 1, 0));
  for (const s of room.spawns) objects.push(point(s, 2, 180));

  map.objects = objects;
  section.raw = JSON.stringify(map, null, 4).replace(/\n/g, sce.eol);
  set(sce.head, "MapName", mapName);
}

/** Points on a grid, inclusive of both ends, at depth `x`. */
export function grid(x: number, ys: number[], zs: number[]): Vec[] {
  const out: Vec[] = [];
  for (const y of ys) for (const z of zs) out.push({ x, y, z });
  return out;
}

/** `n` evenly spaced values from `lo` to `hi` inclusive. */
export function span(lo: number, hi: number, n: number): number[] {
  if (n === 1) return [(lo + hi) / 2];
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

/**
 * Map-unit offset for an angle at a depth: the lateral distance at which a point `depth`
 * units ahead sits `deg` degrees off the player's line of sight.
 */
export function atAngle(depth: number, deg: number): number {
  return depth * Math.tan((deg * Math.PI) / 180);
}

export type { SceLine };
