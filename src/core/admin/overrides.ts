/**
 * What an admin is allowed to change about how this client looks and reads.
 *
 * Two things, and the split matters: the chrome's colours, and the app's own copy.
 * Neither of them can change what a rank means. Ratings, deltas, verification tiers and
 * thresholds are computed server-side and the client has no write grant on any of them,
 * so the worst an override can do is make the app ugly or wrong-sounding on one machine.
 * That is the whole reason this is allowed to be a local file at all.
 *
 * Rank names and colours are editable too, but not from this file. They belong to the
 * season, they are frozen by a database trigger once it is published, and `saveSeason`
 * validates them - so admin mode edits them through that, and a machine's ladder stays
 * the ladder it is graded against. A second write path without those checks would be a
 * quiet way to desync the two.
 *
 * Everything is validated on the way in and on the way out. The file lives in userData
 * where a person can open it in a text editor, so "it came from our own store" is not a
 * reason to trust a value: a copy string ends up in `textContent` and a token value ends
 * up in a CSS custom property, and both are checked before either happens.
 */

/** A design token an admin may repaint, with what it is for. */
export interface TokenSpec {
  name: string;
  label: string;
  group: "Grounds" | "Surfaces" | "Rules" | "Ink" | "Indicators";
  /** What it does, shown beside the swatch so a change is an informed one. */
  note: string;
}

/**
 * The editable chrome, in the order it is drawn.
 *
 * `--accent` is not on this list. The renderer sets it to the player's own rank colour on
 * every snapshot, so an override would be overwritten within a second of being saved and
 * the editor would look broken. The spacing and type scales are not here either: this
 * pass is colour and copy, and a font scale is the fastest way to make a layout that
 * cannot be read back to normal from inside itself.
 */
export const TOKENS: TokenSpec[] = [
  { name: "--ground", label: "Ground", group: "Grounds",
    note: "The window behind everything. Every contrast figure is measured against it." },
  { name: "--panel", label: "Panel", group: "Grounds",
    note: "A region separated from the ground by a rule, not by elevation." },
  { name: "--well", label: "Well", group: "Grounds",
    note: "Recessed: table faces, tracks, and the inside of a note." },

  { name: "--control", label: "Control", group: "Surfaces",
    note: "A painted part sitting on a ground - chips, buttons, tags." },
  { name: "--control-hi", label: "Control, raised", group: "Surfaces",
    note: "The same part under a pointer or holding a state." },

  { name: "--rule", label: "Rule", group: "Rules",
    note: "The hairline between regions. Opaque grey, not white-alpha: alpha over " +
      "near-black reads as a lit edge rather than a drawn one." },
  { name: "--rule-2", label: "Rule, stronger", group: "Rules", note: "Panel heads and borders." },
  { name: "--rule-3", label: "Rule, strongest", group: "Rules", note: "Hover and focus edges." },

  { name: "--ink", label: "Ink", group: "Ink", note: "Body text and figures." },
  { name: "--ink-mid", label: "Ink, secondary", group: "Ink", note: "Supporting prose." },
  { name: "--ink-dim", label: "Ink, dim", group: "Ink", note: "Labels, units, captions." },

  { name: "--up", label: "Up", group: "Indicators",
    note: "Won, gained, ready. An indicator lamp rather than a brand green." },
  { name: "--down", label: "Down", group: "Indicators", note: "Lost, dropped, failed." },
  { name: "--warn", label: "Warn", group: "Indicators", note: "Short, pending, needs attention." },
];

const TOKEN_NAMES = new Set(TOKENS.map((t) => t.name));

/**
 * How long a piece of copy may be.
 *
 * Generous - some of the ledes are three lines - but finite. The cap is here because the
 * file is hand-editable and a megabyte of text in a heading is a hang, not a typo.
 */
export const MAX_COPY = 600;

/** How many strings may be overridden at once, so a malformed file cannot be unbounded. */
export const MAX_KEYS = 500;

export interface Overrides {
  version: 1;
  updatedAt: string | null;
  /** Token name to `#rrggbb`. Only what differs from the stylesheet is stored. */
  tokens: Record<string, string>;
  /** Copy key to replacement text. Only what differs from the markup is stored. */
  copy: Record<string, string>;
}

export function emptyOverrides(): Overrides {
  return { version: 1, updatedAt: null, tokens: {}, copy: {} };
}

/**
 * Six-digit hex only.
 *
 * Not three-digit, not `rgb()`, not a named colour: the contrast maths in the client and
 * the rank sheet both parse `#rrggbb` and nothing else, so a shorthand that renders fine
 * would silently turn every measured contrast figure into a NaN.
 */
export function isHexColour(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

/**
 * A copy key: dotted, lowercase, from the markup.
 *
 * Constrained so a key can never be anything but a lookup - no path separators, no
 * prototype names. `__proto__` as a key on a plain object literal is inert, but this
 * object is merged, cloned and round-tripped through JSON by three different callers,
 * and the cheapest place to stop that is the door.
 */
export function isCopyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) &&
    value.length <= 80 &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

/**
 * Copy is text, and only text.
 *
 * It is assigned with `textContent`, so markup in it cannot execute - but it would still
 * be shown literally as `<b>`, which is a confusing thing to hand somebody who typed it
 * expecting bold. Refusing angle brackets says so at the point of entry instead. Control
 * characters go for the same reason a newline in a heading does: the layout cannot
 * survive them and nobody typed one on purpose.
 */
export function isCopyValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_COPY &&
    !/[<>]/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export interface Rejection {
  kind: "token" | "copy" | "shape";
  key: string;
  why: string;
}

export interface Cleaned {
  overrides: Overrides;
  rejected: Rejection[];
}

/**
 * Take whatever was on disk or came over IPC and return something safe to apply.
 *
 * Rejections are returned rather than thrown. A single bad token in a file somebody
 * hand-edited should cost that token, not the other thirteen and every string - and the
 * caller can then say which one and why, which is the difference between a store that
 * heals and one that silently empties itself.
 */
export function clean(input: unknown): Cleaned {
  const rejected: Rejection[] = [];
  const out = emptyOverrides();

  if (!input || typeof input !== "object") {
    if (input !== undefined && input !== null) {
      rejected.push({ kind: "shape", key: "", why: "not an object" });
    }
    return { overrides: out, rejected };
  }

  const raw = input as Partial<Overrides>;

  if (typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt))) {
    out.updatedAt = raw.updatedAt;
  }

  const tokens = raw.tokens;
  if (tokens && typeof tokens === "object") {
    for (const [name, value] of Object.entries(tokens)) {
      if (!TOKEN_NAMES.has(name)) {
        rejected.push({ kind: "token", key: name, why: "not an editable token" });
        continue;
      }
      if (!isHexColour(value)) {
        rejected.push({ kind: "token", key: name, why: "not a #rrggbb colour" });
        continue;
      }
      out.tokens[name] = value.trim().toLowerCase();
    }
  }

  const copy = raw.copy;
  if (copy && typeof copy === "object") {
    let kept = 0;
    for (const [key, value] of Object.entries(copy)) {
      if (kept >= MAX_KEYS) {
        rejected.push({ kind: "copy", key, why: `over the ${MAX_KEYS}-string limit` });
        continue;
      }
      if (!isCopyKey(key)) {
        rejected.push({ kind: "copy", key, why: "not a copy key" });
        continue;
      }
      if (!isCopyValue(value)) {
        // `value` narrows to `never` here: isCopyValue is a type guard, and every string
        // shape it accepts has just been excluded. The reason is worked out from the
        // unnarrowed value rather than from one TypeScript believes cannot exist.
        const raw: unknown = value;
        rejected.push({
          kind: "copy",
          key,
          why: typeof raw !== "string"
            ? "not text"
            : raw.length > MAX_COPY
              ? `longer than ${MAX_COPY} characters`
              : "contains angle brackets or control characters",
        });
        continue;
      }
      out.copy[key] = value;
      kept++;
    }
  }

  return { overrides: out, rejected };
}

/** Relative luminance, sRGB. The same maths the rank sheet measures with. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ContrastWarning {
  token: string;
  against: string;
  ratio: number;
  need: number;
}

/**
 * Pairs that have to stay readable, whatever an admin picks.
 *
 * Reported, not enforced. Refusing the save would mean an admin part-way through a
 * repaint cannot save at all, and the intermediate state of a theme is nearly always
 * worse than either end of it. Saying "ink on ground is 2.1:1" while they work is the
 * useful half; deciding for them is not.
 *
 * The floors are the ones the client already lives by: body text at 4.5, supporting text
 * at 4.5, and dim labels at 3 because they are small print that is meant to recede.
 */
export const PAIRS: { token: string; against: string; need: number }[] = [
  { token: "--ink", against: "--ground", need: 4.5 },
  { token: "--ink", against: "--panel", need: 4.5 },
  { token: "--ink-mid", against: "--ground", need: 4.5 },
  { token: "--ink-mid", against: "--panel", need: 4.5 },
  { token: "--ink-dim", against: "--ground", need: 3 },
  { token: "--ink-dim", against: "--well", need: 3 },
  { token: "--up", against: "--panel", need: 3 },
  { token: "--down", against: "--panel", need: 3 },
  { token: "--warn", against: "--panel", need: 3 },
];

/**
 * Which of those pairs the given palette fails.
 *
 * `resolved` must hold every token, defaults included - a palette is only meaningful as a
 * whole, and measuring an overridden ink against a default ground it will never be seen
 * on is how a check ends up reporting a problem nobody has.
 */
export function contrastWarnings(resolved: Record<string, string>): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  for (const pair of PAIRS) {
    const a = resolved[pair.token];
    const b = resolved[pair.against];
    if (!isHexColour(a) || !isHexColour(b)) continue;
    const ratio = contrastRatio(a, b);
    if (ratio < pair.need) {
      out.push({ token: pair.token, against: pair.against, ratio, need: pair.need });
    }
  }
  return out;
}
