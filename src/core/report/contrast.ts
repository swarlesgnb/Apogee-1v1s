/**
 * Whether a rank colour can actually be read.
 *
 * A rank is a name in a colour, shown on the client's near-black panels and again on
 * anything lighter - a screenshot, a profile, a web page. A colour that only survives one
 * of those is a rank that disappears half the time, and the failure is invisible to the
 * person choosing it: on a lit monitor, against the editor's own background, a near-black
 * looks like a colour rather than like nothing.
 *
 * So it is measured. Shared between the rank sheet and the season editor, because the
 * whole point is that the warning appears while the colour is being chosen rather than
 * after it has shipped.
 */

/** The two grounds every rank name has to survive. Must match the client and the sheet. */
export const DARK_GROUND = "#1e1b18";
export const LIGHT_GROUND = "#eef1f6";

/**
 * The dark chrome, in one place.
 *
 * The same nine values were written out by hand in the client, the rank sheet, the theme
 * editor and the Electron window options, which is four chances for a palette change to
 * land in three of them. The client's `:root` is still where a human edits them - a
 * stylesheet is the right home for a stylesheet - but everything that generates a document
 * reads them from here, so a sheet cannot be built on a ground the app stopped using.
 */
export const DARK_CHROME = {
  ground: DARK_GROUND,
  panel: "#272320",
  well: "#171513",
  rule: "#38332f",
  ink: "#f6f3ee",
  inkMid: "#bbb4aa",
  inkDim: "#8e867c",
} as const;

/**
 * Contrast ratios below this are treated as "this colour disappears".
 *
 * Well under WCAG's 4.5:1 for body text, deliberately. A rank name is large, bold, and
 * carries a filled chip beside it, so the bar for legibility is lower than for prose - and
 * a threshold that flags half the palette gets ignored, which helps nobody.
 */
export const MIN_CONTRAST = 2;

/**
 * The floor for a rank name set as body text, which is a different thing again.
 *
 * MIN_CONTRAST is for a name set large beside a specimen of its own colour. In the client
 * the same names are 12px in a column forty rows deep, and at that size the seventeen
 * placements under 2:1 still came out as smudges. 3.5 is WCAG's large-text floor of 3 with
 * a little over, which is the honest description of this text: small, but bold and in a
 * column of its own.
 *
 * The renderer holds its own copy - it runs as plain script in two hosts and cannot import
 * this - so anything that *generates* a colour has to read the number from here, or a ramp
 * gets built against one floor and painted against another. That is not hypothetical: the
 * first generated palette was solved to 2:1, the client lifted its bottom seven rungs to
 * 3.5, and the lift's five percent steps reordered them.
 */
export const RANK_TEXT_CONTRAST = 3.5;

/** sRGB relative luminance, per WCAG. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Readability {
  onDark: number;
  onLight: number;
  /** True when the colour survives both grounds. */
  ok: boolean;
  /** Which ground it fails against, for a message that says what to do. */
  fails: "dark" | "light" | "both" | null;
}

export function readability(color: string): Readability {
  const onDark = contrast(color, DARK_GROUND);
  const onLight = contrast(color, LIGHT_GROUND);
  const darkBad = onDark < MIN_CONTRAST;
  const lightBad = onLight < MIN_CONTRAST;

  return {
    onDark,
    onLight,
    ok: !darkBad && !lightBad,
    fails: darkBad && lightBad ? "both" : darkBad ? "dark" : lightBad ? "light" : null,
  };
}

/** A sentence saying what is wrong, or null when nothing is. */
export function readabilityNote(color: string): string | null {
  const r = readability(color);
  if (r.ok) return null;

  if (r.fails === "both") {
    return `unreadable on both grounds (${r.onDark.toFixed(2)}:1 dark, ${r.onLight.toFixed(2)}:1 light)`;
  }
  return r.fails === "dark"
    ? `disappears on dark (${r.onDark.toFixed(2)}:1) - the client's own background`
    : `disappears on light (${r.onLight.toFixed(2)}:1) - screenshots and the web`;
}

/** Blend two hex colours, `pct` percent of the way from `a` to `b`. */
export function mix(a: string, b: string, pct: number): string {
  const value = (c: string) => parseInt(/^#?([0-9a-f]{6})$/i.exec(c.trim())?.[1] ?? "000000", 16);
  const x = value(a);
  const y = value(b);
  const t = pct / 100;
  const channel = (shift: number) =>
    Math.round((((x >> shift) & 255) * (1 - t) + ((y >> shift) & 255) * t));
  return "#" + [16, 8, 0].map((s) => channel(s).toString(16).padStart(2, "0")).join("");
}

/**
 * A rank colour moved just far enough to be read on the ground it is being set on.
 *
 * The client has had this in one direction since the grounds were lifted out of near-black,
 * and the reasoning there is the whole argument: the authored colour is the identity and
 * stays the identity, so the correction belongs where the colour is painted rather than in
 * the season file. Singularity is #000000 because that is what a singularity is; writing
 * #2f2f2f into the data would lose the joke *and* hide the fact that it had to be lost.
 *
 * What was missing is the other direction. Every rank gets shown outside the client too,
 * and forty-two of season 1's names sit under 2:1 on paper against ten on dark, because
 * three of the six ladders ascend by getting lighter and their top halves land in the
 * near-whites. Lifting only towards white fixes the ten and does nothing for the
 * forty-two, so the ground is a parameter now and the colour moves away from it either way.
 *
 * Five percent at a time towards the other ground, which is what the two grounds are for:
 * they are the poles of everything this palette is ever painted on, so a colour pushed
 * towards one is a colour the app already knows how to show. Stepping finely enough to land
 * on the floor exactly would be truer to the colour and much worse to look at, because
 * neighbouring rungs that each needed a slightly different lift stop being evenly spaced -
 * the ladder reads as a climb, and preserving that matters more here than the last two
 * percent of a colour nobody can see anyway. Anything already clear of the line is returned
 * untouched, so this is invisible on a palette that does not need it.
 */
export function legibleOn(color: string, ground: string, min: number = MIN_CONTRAST): string {
  if (!/^#[0-9a-f]{6}$/i.test(color.trim())) return color;
  const away = luminance(ground) > 0.4 ? DARK_GROUND : LIGHT_GROUND;
  let out = color;
  for (let pct = 5; pct <= 100 && contrast(out, ground) < min; pct += 5) {
    out = mix(color, away, pct);
  }
  return out;
}
