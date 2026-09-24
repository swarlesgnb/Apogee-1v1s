/**
 * Read and write KovaaK's scenario files (.sce).
 *
 * A scenario file is self-contained: a block of `key=value` lines for the scenario itself,
 * then one `[Section]` per profile it uses (character, bot, dodge, weapon, aim, ability),
 * then a `[Map Data]` section holding the whole Reflex-format map. Profiles refer to each
 * other by `Name`, so a bot profile names a character profile which names a weapon profile.
 *
 * Nothing here interprets a value. Parsing keeps every line in order, duplicate keys and
 * all, so `serialize(parse(text))` gives back the input byte for byte; that property is
 * what lets the season's authored scenarios be built by editing a real file KovaaK's has
 * already loaded, instead of writing one from memory and hoping every one of the ~600
 * keys a current build expects is present and spelt the way it reads them.
 *
 * Measured against the 1,161 .sce files in the local workshop folder and scenario folder:
 * `npm run validate:sce` round-trips every one.
 */

export interface SceLine {
  key: string;
  value: string;
}

export interface SceSection {
  /** "Character Profile", "Bot Profile", ... - the text between the brackets. */
  type: string;
  lines: SceLine[];
  /** Everything after `[Map Data]`, verbatim; the map is not key=value. */
  raw?: string;
}

export interface Sce {
  /** The scenario's own settings, before the first section. */
  head: SceLine[];
  sections: SceSection[];
  /** Line terminator the file used, so a rewrite does not change every line of it. */
  eol: "\r\n" | "\n";
  /** Whether the text ended with a terminator. */
  trailingEol: boolean;
}

const SECTION = /^\[(.+)\]$/;

export function parseSce(text: string): Sce {
  const eol: "\r\n" | "\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingEol = text.endsWith(eol);
  const body = trailingEol ? text.slice(0, -eol.length) : text;
  const rows = body.split(eol);

  const sce: Sce = { head: [], sections: [], eol, trailingEol };
  let target = sce.head;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const m = SECTION.exec(row);
    if (m) {
      const section: SceSection = { type: m[1], lines: [] };
      sce.sections.push(section);
      if (m[1] === "Map Data") {
        // The map runs to the end of the file in every file measured. Kept as one string
        // so nothing about its whitespace or tabs is touched.
        section.raw = rows.slice(i + 1).join(eol);
        break;
      }
      target = section.lines;
      continue;
    }
    // A blank line separates sections. It is kept as an empty key so it round-trips.
    const at = row.indexOf("=");
    if (at < 0) target.push({ key: row, value: "\u0000" });
    else target.push({ key: row.slice(0, at), value: row.slice(at + 1) });
  }
  return sce;
}

export function serializeSce(sce: Sce): string {
  const out: string[] = [];
  const emit = (lines: SceLine[]) => {
    for (const l of lines) out.push(l.value === "\u0000" ? l.key : `${l.key}=${l.value}`);
  };
  emit(sce.head);
  for (const s of sce.sections) {
    out.push(`[${s.type}]`);
    if (s.raw !== undefined) out.push(s.raw);
    else emit(s.lines);
  }
  return out.join(sce.eol) + (sce.trailingEol ? sce.eol : "");
}

/** First value of a key, or undefined. */
export function get(lines: SceLine[], key: string): string | undefined {
  return lines.find((l) => l.key === key)?.value;
}

export function num(lines: SceLine[], key: string, fallback = NaN): number {
  const v = get(lines, key);
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(lines: SceLine[], key: string): boolean {
  return get(lines, key)?.toLowerCase() === "true";
}

/**
 * Set a key that must already exist.
 *
 * Refusing to add a key is deliberate. A key KovaaK's does not read is silently ignored,
 * so a typo would build a scenario that looks right in this file and plays as the
 * template. Every key the season sets is one its template already carries.
 */
export function set(lines: SceLine[], key: string, value: string | number | boolean): void {
  const line = lines.find((l) => l.key === key);
  if (!line) throw new Error(`no ${key} to set`);
  line.value = formatValue(value);
}

/** KovaaK's writes floats with at least one decimal place, and booleans lowercase. */
export function formatValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`not a number: ${value}`);
    const s = String(Math.round(value * 1e6) / 1e6);
    return s.includes(".") || s.includes("e") ? s : `${s}.0`;
  }
  return value;
}

export function sections(sce: Sce, type: string): SceSection[] {
  return sce.sections.filter((s) => s.type === type);
}

/**
 * A profile section by its `Name`. Names are how profiles refer to each other.
 *
 * An exact match wins; failing that, one that differs only in case, because the game
 * resolves them that way - Voltaic's Popcorn names its player character `player` and
 * refers to it as `Player`, and KovaaK's plays it.
 */
export function profile(sce: Sce, type: string, name: string): SceSection | undefined {
  const exact = sce.sections.find((s) => s.type === type && get(s.lines, "Name") === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return sce.sections.find((s) => s.type === type && get(s.lines, "Name")?.toLowerCase() === lower);
}

/** `a;b;;c` lists, with KovaaK's empty trailing slots dropped. */
export function list(value: string | undefined): string[] {
  return (value ?? "").split(";").filter((v) => v.length > 0);
}

/** `X=1.000 Y=2.000 Z=3.000` */
export function vector(value: string | undefined): { x: number; y: number; z: number } | null {
  if (!value) return null;
  const m = /X=(-?[\d.]+)\s+Y=(-?[\d.]+)\s+Z=(-?[\d.]+)/.exec(value);
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
}
