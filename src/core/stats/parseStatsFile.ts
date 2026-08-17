/**
 * Parser for KovaaK's `* Stats.csv` files.
 *
 * Every downstream system (baselines, matches, verification, quests) reads runs
 * through this module, so it has two hard requirements:
 *
 *   1. Never throw on malformed input. Crashes and alt-F4 mid-run leave truncated
 *      files in the stats folder; a watcher that dies on one bad file is useless.
 *   2. Surface enough raw material for anti-cheat to do its job later (§5 of PLAN.md),
 *      which means keeping the per-kill rows, not just the summary.
 *
 * File layout (three blocks separated by blank lines):
 *
 *   Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,...     <- per-kill rows
 *   Weapon,Shots,Hits,Damage Done,Damage Possible,...           <- weapon summary
 *   Kills:,102                                                  <- key/value tail
 *   Score:,1020.0
 *   Scenario:,VT Frogtagon Intermediate S5
 *   Hash:,ec8acdea37fa767767d705e389db1463
 */

export interface KillRow {
  killNumber: number;
  timestamp: string;
  bot: string;
  weapon: string;
  ttk: number | null;
  shots: number;
  hits: number;
  accuracy: number | null;
  damageDone: number | null;
  damagePossible: number | null;
  overShots: number | null;
}

export interface WeaponSummary {
  weapon: string;
  shots: number | null;
  hits: number | null;
  damageDone: number | null;
  damagePossible: number | null;
}

export interface ParsedRun {
  /** Scenario name from the file body, which is authoritative over the filename. */
  scenario: string;
  score: number;
  kills: number | null;
  hitCount: number | null;
  missCount: number | null;
  accuracy: number | null;
  avgTtk: number | null;
  damageDone: number | null;
  /** Scenario integrity hash; must match KovaaK's server record. */
  hash: string | null;
  /** Wall-clock start, e.g. "21:05:28.997". Pairs with `epoch` server-side. */
  challengeStart: string | null;
  /** Derived from the filename, which is the only place the date appears. */
  playedAt: Date | null;
  gameVersion: string | null;
  avgFps: number | null;
  resolution: string | null;
  sensScale: string | null;
  horizSens: number | null;
  cm360: number | null;
  dpi: number | null;
  fov: number | null;
  killRows: KillRow[];
  /** Per-weapon shot totals. Needed to cross-check hits + misses against shots. */
  weapons: WeaponSummary[];
  /** Every key from the tail block, for fields we haven't modelled explicitly. */
  raw: Record<string, string>;
}

export interface ParseSuccess {
  ok: true;
  run: ParsedRun;
}

export interface ParseFailure {
  ok: false;
  reason: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** `VT Frogtagon Intermediate S5 - Challenge - 2026.08.15-21.06.28 Stats.csv` */
const FILENAME_RE =
  /^(.*?) - Challenge - (\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}) Stats\.csv$/;

export interface FilenameInfo {
  scenario: string;
  playedAt: Date;
}

export function parseFilename(filename: string): FilenameInfo | null {
  const m = FILENAME_RE.exec(filename);
  if (!m) return null;

  const [, scenario, y, mo, d, h, mi, s] = m;
  // KovaaK's writes local time with no zone marker, so construct in local time.
  const playedAt = new Date(+y, +mo - 1, +d, +h, +mi, +s);
  if (Number.isNaN(playedAt.getTime())) return null;

  return { scenario, playedAt };
}

function toNumber(value: string | undefined): number | null {
  if (value == null) return null;
  // Strips the trailing "s" on TTK values like "0.723000s".
  const cleaned = value.trim().replace(/s$/, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a CSV line. KovaaK's does not quote or escape fields, and scenario names
 * can legitimately contain commas, so the key/value tail is split on the FIRST
 * comma only. See parseTail.
 */
function splitLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

function parseKillRows(lines: string[]): KillRow[] {
  if (lines.length === 0) return [];

  const header = splitLine(lines[0]);
  if (header[0] !== "Kill #") return [];

  const idx = (name: string) => header.indexOf(name);
  const iTtk = idx("TTK");
  const iShots = idx("Shots");
  const iHits = idx("Hits");
  const iAcc = idx("Accuracy");
  const iDmgDone = idx("Damage Done");
  const iDmgPoss = idx("Damage Possible");
  const iOver = idx("OverShots");

  const rows: KillRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitLine(lines[i]);
    const killNumber = toNumber(c[0]);
    if (killNumber == null) continue; // tolerate a torn final row

    rows.push({
      killNumber,
      timestamp: c[1] ?? "",
      bot: c[2] ?? "",
      weapon: c[3] ?? "",
      ttk: iTtk >= 0 ? toNumber(c[iTtk]) : null,
      shots: (iShots >= 0 ? toNumber(c[iShots]) : null) ?? 0,
      hits: (iHits >= 0 ? toNumber(c[iHits]) : null) ?? 0,
      accuracy: iAcc >= 0 ? toNumber(c[iAcc]) : null,
      damageDone: iDmgDone >= 0 ? toNumber(c[iDmgDone]) : null,
      damagePossible: iDmgPoss >= 0 ? toNumber(c[iDmgPoss]) : null,
      overShots: iOver >= 0 ? toNumber(c[iOver]) : null,
    });
  }
  return rows;
}

/**
 * The weapon block is a header row starting with "Weapon" followed by one row per
 * weapon used. It is the only place total shots are recorded, which anti-cheat needs
 * in order to check that hits + misses actually add up.
 */
function parseWeaponBlock(lines: string[]): WeaponSummary[] {
  if (lines.length === 0) return [];

  const header = splitLine(lines[0]);
  if (header[0] !== "Weapon") return [];

  const idx = (name: string) => header.indexOf(name);
  const iShots = idx("Shots");
  const iHits = idx("Hits");
  const iDone = idx("Damage Done");
  const iPoss = idx("Damage Possible");

  const weapons: WeaponSummary[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitLine(lines[i]);
    if (!c[0]) continue;
    weapons.push({
      weapon: c[0],
      shots: iShots >= 0 ? toNumber(c[iShots]) : null,
      hits: iHits >= 0 ? toNumber(c[iHits]) : null,
      damageDone: iDone >= 0 ? toNumber(c[iDone]) : null,
      damagePossible: iPoss >= 0 ? toNumber(c[iPoss]) : null,
    });
  }
  return weapons;
}

/**
 * The tail is `Key:,value` per line. Scenario names contain commas in the wild, so
 * only the first comma separates key from value.
 */
function parseTail(lines: string[], into: Record<string, string>): void {
  for (const line of lines) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;

    const key = line.slice(0, comma).trim().replace(/:$/, "");
    if (key === "") continue;

    into[key] = line.slice(comma + 1).trim();
  }
}

export function parseStatsFile(filename: string, content: string): ParseResult {
  const nameInfo = parseFilename(filename);

  const lines = content.split(/\r?\n/);

  // Blocks are separated by blank lines. The first block is the kill table; every
  // later block is either the weapon summary or key/value pairs, and both are safe
  // to feed through parseTail, since the weapon header has no trailing-colon keys.
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);

  if (blocks.length === 0) return { ok: false, reason: "empty file" };

  const killRows = parseKillRows(blocks[0]);

  const raw: Record<string, string> = {};
  const weapons: WeaponSummary[] = [];
  for (let i = 1; i < blocks.length; i++) {
    const parsedWeapons = parseWeaponBlock(blocks[i]);
    if (parsedWeapons.length > 0) {
      weapons.push(...parsedWeapons);
      continue; // a weapon block holds no Key:,value pairs
    }
    parseTail(blocks[i], raw);
  }

  const score = toNumber(raw["Score"]);
  if (score == null) {
    // A run that never finished has no Score line. This is the single most common
    // reason to skip a file and is expected, not an error worth surfacing loudly.
    return { ok: false, reason: "no Score field (incomplete run)" };
  }

  const scenario = raw["Scenario"] ?? nameInfo?.scenario ?? "";
  if (scenario === "") return { ok: false, reason: "no scenario name" };

  const hitCount = toNumber(raw["Hit Count"]);
  const missCount = toNumber(raw["Miss Count"]);
  const accuracy =
    hitCount != null && missCount != null && hitCount + missCount > 0
      ? hitCount / (hitCount + missCount)
      : null;

  return {
    ok: true,
    run: {
      scenario,
      score,
      kills: toNumber(raw["Kills"]),
      hitCount,
      missCount,
      accuracy,
      avgTtk: toNumber(raw["Avg TTK"]),
      damageDone: toNumber(raw["Damage Done"]),
      hash: raw["Hash"] || null,
      challengeStart: raw["Challenge Start"] || null,
      playedAt: nameInfo?.playedAt ?? null,
      gameVersion: raw["Game Version"] || null,
      avgFps: toNumber(raw["Avg FPS"]),
      resolution: raw["Resolution"] || null,
      sensScale: raw["Sens Scale"] || null,
      horizSens: toNumber(raw["Horiz Sens"]),
      cm360: toNumber(raw["Horiz Sens"]),
      dpi: toNumber(raw["DPI"]),
      fov: toNumber(raw["FOV"]),
      killRows,
      weapons,
      raw,
    },
  };
}
