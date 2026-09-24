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

/**
 * Put these entries in the scenario as its added bots: `name.bot` for a bot, `name.rot`
 * for a rotation. The general form of `setBots`, for scenarios whose slots rotate.
 */
export function setAddedBots(sce: Sce, entries: string[]): void {
  for (const e of entries) {
    const bare = e.replace(/\.(bot|rot)$/i, "");
    const type = /\.rot$/i.test(e) ? "Bot Rotation Profile" : "Bot Profile";
    if (!profile(sce, type, bare)) throw new Error(`no ${type} called ${bare}`);
  }
  set(sce.head, "AddedBots", entries.join(";"));
  set(sce.head, "BotMaxLives", entries.map(() => "0").join(";"));
  set(sce.head, "BotTeams", entries.map(() => "2").join(";"));
  set(sce.head, "BotCharacters", [...new Set(entries)].join(";"));
}

/**
 * Copy a profile section from another file into this one under a new name.
 *
 * For the one case the template itself cannot supply: a Bot Rotation Profile, which a
 * static template has no use for and a wave scenario needs. The copy is a section KovaaK's
 * wrote, with only its Name changed; the caller sets the rest through `set`.
 */
export function importProfile(sce: Sce, from: Sce, type: string, name: string, as: string): SceSection {
  const source = profile(from, type, name);
  if (!source) throw new Error(`no ${type} called ${name} to import`);
  const copy: SceSection = { type, lines: source.lines.map((l) => ({ ...l })) };
  set(copy.lines, "Name", as);
  const mapAt = sce.sections.findIndex((s) => s.type === "Map Data");
  sce.sections.splice(mapAt < 0 ? sce.sections.length : mapAt, 0, copy);
  return copy;
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
    // A character names its abilities with the file extension the editor unpacks them to
    // (`Ground 1 Blink.abilmov`); the profile's own Name has none.
    for (const a of list(get(c.lines, "AbilityProfileNames"))) {
      const bare = a.replace(/\.abil\w+$/i, "");
      for (const s of sce.sections) {
        if (!s.type.endsWith("Ability Profile") || get(s.lines, "Name")?.toLowerCase() !== bare.toLowerCase()) continue;
        keep.add(key(s.type, bare));
        // A weapon ability fires a weapon of its own. Leaving it out left Gravity Well's
        // balloons with a burst that pointed at nothing: they arrived and never went off.
        const weapon = get(s.lines, "WeaponProfile");
        if (weapon) keep.add(key("Weapon Profile", weapon));
      }
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
  spawns: Array<Vec | BotSpawn>;
  /** Named points bots can be sent along, by a spawn's `path`. */
  waypoints?: Array<{ name: string; at: Vec }>;
}

/**
 * A bot spawn with more than a position.
 *
 * `admits` restricts it to one character (`PermittedCharacterProfiles`), which is how a
 * star of a constellation gets exactly one bot. `path` names waypoints the bot walks, in
 * order, from the moment it spawns, and `looping` sends it round again; the bot's dodge
 * profile must say `WaypointLogic=FollowAimAtTarget` for it to follow them. Both are the
 * Map Creator's own spawn-point properties, read off ZipTrack - THE FINALS, which moves
 * its targets this way.
 */
export interface BotSpawn {
  at: Vec;
  admits?: string;
  path?: string[];
  looping?: boolean;
}

const isBotSpawn = (s: Vec | BotSpawn): s is BotSpawn => "at" in s;

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

  const point = (at: Vec, mask: number, rotationZ: number, extra: Omit<BotSpawn, "at"> = {}): JsonObject => {
    const o = structuredClone(spawn) as JsonObject;
    o.location = triple(at);
    o.rotation = triple({ x: 0, y: 0, z: rotationZ });
    // The team mask is what separates player from bots here. The copied spawn's own
    // character list is dropped: the prototype is often the template's player spawn, which
    // admits only `Player`, and a bot spawn that admits only the player spawns no bots.
    o.properties = (o.properties as Array<{ name: string; value: unknown }>).map((p) => {
      if (p.name === "TeamMask") return { ...p, value: mask };
      if (p.name === "PermittedCharacterProfiles") return { ...p, value: extra.admits ?? "" };
      if (p.name === "Path") return { ...p, value: (extra.path ?? []).join(",") };
      if (p.name === "LoopingPath") return { ...p, value: Boolean(extra.looping) };
      return { ...p };
    });
    return o;
  };
  objects.push(point({ x: 0, y: 0, z: 0 }, 1, 0));
  for (const s of room.spawns) objects.push(isBotSpawn(s) ? point(s.at, 2, 180, s) : point(s, 2, 180));
  // A waypoint is a spawn-sized game object with a name and a pause: the shape ZipTrack's
  // map gives them, built on the spawn prototype so its scale and type come from a file
  // KovaaK's wrote.
  for (const w of room.waypoints ?? []) {
    const o = structuredClone(spawn) as JsonObject;
    o.name = "Waypoint";
    o.location = triple(w.at);
    o.rotation = triple({ x: 0, y: 0, z: 0 });
    o.properties = [
      { name: "Name", value: w.name },
      { name: "BotPauseTimeMin", value: 0.0 },
      { name: "BotPauseTimeMax", value: 0.0 },
    ];
    objects.push(o);
  }

  map.objects = objects;
  section.raw = JSON.stringify(map, null, 4).replace(/\n/g, sce.eol);
  set(sce.head, "MapName", mapName);
}

/**
 * Rename a character in the spawn points of an embedded JSON map.
 *
 * A Map Creator spawn point can admit only named character profiles
 * (`PermittedCharacterProfiles`, comma-separated). A template's map names the template's
 * characters, so a recipe that renames a character has to rename it here too, or the
 * renamed bots have nowhere they are allowed to spawn. Returns how many spawns changed.
 */
export function renameCharacterInMap(sce: Sce, from: string, to: string): number {
  const section = sce.sections.find((s) => s.type === "Map Data");
  if (!section?.raw || !section.raw.trimStart().startsWith("{")) return 0;
  const map = JSON.parse(section.raw) as { objects: JsonObject[] };
  let changed = 0;
  for (const o of map.objects) {
    for (const p of (o.properties as Array<{ name: string; value: unknown }> | undefined) ?? []) {
      if (p.name !== "PermittedCharacterProfiles" || typeof p.value !== "string" || !p.value) continue;
      const names = p.value.split(",").map((n) => n.trim());
      if (!names.some((n) => n.toLowerCase() === from.toLowerCase())) continue;
      p.value = names.map((n) => (n.toLowerCase() === from.toLowerCase() ? to : n)).join(",");
      changed++;
    }
  }
  if (changed) section.raw = JSON.stringify(map, null, 4).replace(/\n/g, sce.eol);
  return changed;
}

/** `n` evenly spaced values from `lo` to `hi` inclusive. */
export function span(lo: number, hi: number, n: number): number[] {
  if (n === 1) return [(lo + hi) / 2];
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

export type { SceLine };
