/**
 * The seven new mechanics as pictures: a 24-unit UI icon and an 80-unit emblem for each.
 *
 * Pure strings, no imports, so the same drawing reaches every place a mechanic is shown:
 * the brand kit's SVGs and PNGs (tools/brand/buildMechanics.ts), the share cards
 * (mechanicCards.ts), the video cards, and the renderer, whose copy
 * (src/app/renderer/mechanic-icons.js and assets/icons/) is generated from this file and
 * checked against it by validate:brand.
 *
 * The icons follow the rail's nav icons exactly: a 24-unit box, stroke 1.65, round caps
 * and joins, no fill, `currentColor`, so one sits beside "Ghost" or "Mixtape" without
 * looking borrowed. The only fill is where a shape would not read without it (the
 * eclipse's shadowed body, the race's runners, the daily marks), and it is still
 * `currentColor`, so an icon stays one colour that CSS sets.
 *
 * The emblems follow the rank insignia's construction (badge() in renderer.js): stroke
 * 1.4 for outlines, 1.0 at half opacity for inner hairlines, and faces filled in the same
 * steps of one ink (.1, .17, .28, .48, solid). A rank insignia is a shield because a rank
 * is something you hold; a mechanic is a way to play, so its emblem is an instrument dial:
 * a ring with four registration ticks (the atlas plates' device) and one body at apogee on
 * the ring, the point the whole brand is named for.
 */

export type MechanicId = "shadow" | "flag" | "daily" | "link" | "crown" | "draft" | "race";

export interface Mechanic {
  id: MechanicId;
  /** The working name, fixed by the fleet brief. */
  name: string;
  /** One line, true of the mechanic as built, for cards, empty states and video. */
  line: string;
  /** The 24-unit icon's body: drawn with the attributes in ICON_ATTRS. */
  icon: string;
  /** The 80-unit emblem's body, inside the shared dial. */
  emblem: string;
}

/** The rail's own icon attributes (index.html .nav-icon). */
export const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"';

/** A face of the emblem at one of the insignia's fill steps. */
const face = (d: string, opacity: number, stroke = true) =>
  `<path d="${d}" fill="currentColor" fill-opacity="${opacity}"${stroke ? ' stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"' : ""}/>`;
const line = (d: string, width = 1.4, extra = "") =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
const hair = (d: string, extra = "") => line(d, 1, ` stroke-opacity=".5"${extra}`);
const solid = (d: string) => `<path d="${d}" fill="currentColor"/>`;
/** A diamond pip, the insignia's own small mark, centred at x,y with half-diagonal r. */
const pip = (x: number, y: number, r: number) => solid(`M${x} ${y - r}l${r} ${r}-${r} ${r}-${r}-${r}Z`);

/**
 * The dial every emblem sits in: a faint disc, its rim, an inner hairline ring, four
 * registration ticks crossing the rim, and one body at apogee, up and to the right as on
 * the cards' orbits.
 */
const DIAL =
  `<circle cx="40" cy="40" r="35" fill="currentColor" fill-opacity=".06" stroke="currentColor" stroke-width="1.4"/>` +
  line("M40 2.5v6M40 71.5v6M2.5 40h6M71.5 40h6") +
  pip(67.6, 18.5, 3.2);

export const MECHANICS: readonly Mechanic[] = [
  {
    id: "shadow",
    name: "Shadow",
    line: "A calibrated opponent at your rating, when nobody else is online.",
    // An eclipse: a body and its equal passing behind it. The shadowed crescent is filled
    // because two outlined circles read as "overlap", not "shadow", at 16px.
    icon:
      '<path d="M12 6A6.5 6.5 0 1 1 12 18A6.5 6.5 0 0 0 12 6Z" fill="currentColor" fill-opacity=".45" stroke="none"/>' +
      '<circle cx="9.5" cy="12" r="6.5"/>',
    // The player's body lit, its equal behind it in shade: on a dark ground the shadow is
    // the fainter fill, and the arc it hides behind the lit body is drawn dashed.
    emblem:
      face("M40 24.51A17 17 0 1 1 40 55.49A17 17 0 0 0 40 24.51Z", 0.1, false) +
      line("M40 24.51A17 17 0 1 1 40 55.49") +
      hair("M40 24.51A17 17 0 0 0 40 55.49", ' stroke-dasharray="1.5 3"') +
      face("M33 23a17 17 0 1 0 0 34a17 17 0 1 0 0-34Z", 0.28),
  },
  {
    id: "flag",
    name: "Flag",
    line: "Your set stays planted as an open challenge, and settles when someone answers.",
    icon: '<path d="M7 21V3.5"/><path d="M7 4.5h12l-3 4 3 4H7"/><path d="M4.5 21h5"/>',
    emblem:
      face("M31 21h21l-5 7H31Z", 0.48, false) +
      face("M31 28h16l5 7H31Z", 0.17, false) +
      line("M31 21h21l-5 7 5 7H31") +
      line("M31 60V18") +
      pip(31, 15, 2.6) +
      line("M22 60h18") +
      hair("M26 64h10"),
  },
  {
    id: "daily",
    name: "Daily",
    line: "One draw a day, the same for everyone.",
    icon: '<path d="M3 16.5h18M8 20h8"/><path d="M7 16.5a5 5 0 0 1 10 0"/><path d="M12 9V6M6.7 11.2 4.6 9.1M17.3 11.2l2.1-2.1"/>',
    // The sun on the horizon, and under it the share grid's marks as the Daily's own share
    // text sets them: above, near (a diamond) and below the player's own baseline.
    emblem:
      face("M28 45a12 12 0 0 1 24 0Z", 0.28) +
      face("M33 45a7 7 0 0 1 14 0Z", 0.48, false) +
      line("M14 45h52") +
      line("M40 29v-6M28.7 33.7l-4.2-4.2M51.3 33.7l4.2-4.2") +
      solid("M27 59.5l3.5-6 3.5 6Z") +
      pip(40, 56.5, 3.4) +
      solid("M46 53.5h7l-3.5 6Z"),
  },
  {
    id: "link",
    name: "Challenge link",
    line: "A link that opens a duel or a ghost race against you.",
    icon:
      '<rect x="2.5" y="12" width="12.5" height="6.5" rx="3.25" transform="rotate(-45 8.75 15.25)"/>' +
      '<rect x="9" y="5.5" width="12.5" height="6.5" rx="3.25" transform="rotate(-45 15.25 8.75)"/>',
    emblem:
      `<g transform="rotate(-45 40 40)">` +
      `<rect x="14" y="32.5" width="30" height="15" rx="7.5" fill="currentColor" fill-opacity=".17" stroke="currentColor" stroke-width="1.4"/>` +
      `<rect x="36" y="32.5" width="30" height="15" rx="7.5" fill="currentColor" fill-opacity=".28" stroke="currentColor" stroke-width="1.4"/>` +
      `<rect x="21" y="38" width="14" height="4" rx="2" fill="none" stroke="currentColor" stroke-opacity=".5"/>` +
      `<rect x="45" y="38" width="14" height="4" rx="2" fill="none" stroke="currentColor" stroke-opacity=".5"/>` +
      `</g>`,
  },
  {
    id: "crown",
    name: "Crown",
    line: "Hold a category and band until someone beats your set.",
    icon: '<path d="M4.5 17 3 7.5l5 3.5 4-6 4 6 5-3.5L19.5 17Z"/><path d="M5 20.5h14"/>',
    emblem:
      face("M25 49 22 29l9.5 7L40 23l8.5 13 9.5-7-3 20Z", 0.28) +
      face("M25 49h30v6H25Z", 0.48) +
      pip(22, 26.5, 2.6) +
      pip(40, 19.5, 2.8) +
      pip(58, 26.5, 2.6) +
      hair("M17 63q23-8 46 0"),
  },
  {
    id: "draft",
    name: "Draft",
    line: "Pick and ban scenarios before the match starts.",
    icon: '<rect x="2.5" y="4.5" width="8.5" height="15" rx="1.5"/><rect x="13" y="4.5" width="8.5" height="15" rx="1.5"/><path d="m4.6 12.3 1.9 1.9 3.1-3.9M15.2 16.5l4.1-9"/>',
    // Two cards: the one kept, ticked, and the one struck out.
    emblem:
      `<g transform="rotate(-8 30 40)">` +
      face("M21 25h18a2 2 0 0 1 2 2v26a2 2 0 0 1-2 2H21a2 2 0 0 1-2-2V27a2 2 0 0 1 2-2Z", 0.28) +
      line("m24.5 40.5 4 4 7-8.5", 1.8) +
      `</g><g transform="rotate(8 50 40)">` +
      face("M41 25h18a2 2 0 0 1 2 2v26a2 2 0 0 1-2 2H41a2 2 0 0 1-2-2V27a2 2 0 0 1 2-2Z", 0.1) +
      line("M44.5 50 55.5 30", 1.8) +
      `</g>`,
  },
  {
    id: "race",
    name: "Live race",
    line: "Both players at once, every round revealed as it lands.",
    icon: '<path d="M3 8h8M3 16h11M21.5 3.5v17"/><path d="m13.5 5.8 2.2 2.2-2.2 2.2-2.2-2.2Z" fill="currentColor"/><path d="m16.5 13.8 2.2 2.2-2.2 2.2-2.2-2.2Z" fill="currentColor"/>',
    // Two lanes with a runner on each, and a finish line set as a column of the atlas
    // plates' square stars.
    emblem:
      hair("M17 32h40M17 48h40") +
      line("M19 32h18M19 48h26") +
      pip(42, 32, 4) +
      pip(50, 48, 4) +
      line("M59 21v38") +
      [23, 31, 39, 47, 55].map((y, i) => `<rect x="${i % 2 ? 63 : 60.5}" y="${y - 2}" width="3" height="3" fill="currentColor"${i % 2 ? "" : ' fill-opacity=".48"'}/>`).join(""),
  },
];

export const MECHANIC_IDS = MECHANICS.map((m) => m.id) as readonly MechanicId[];

export function mechanic(id: MechanicId): Mechanic {
  const m = MECHANICS.find((x) => x.id === id);
  if (!m) throw new Error(`no mechanic ${id}`);
  return m;
}

const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * The icon as a complete <svg>. Decorative by default (aria-hidden), the way the rail's
 * icons sit beside their label; pass `title` when the icon stands alone.
 */
export function mechanicIconSvg(id: MechanicId, o: { size?: number; title?: string; className?: string; xmlns?: boolean } = {}): string {
  const m = mechanic(id);
  const a11y = o.title ? ` role="img" aria-label="${escAttr(o.title)}"` : ' aria-hidden="true"';
  const size = o.size ? ` width="${o.size}" height="${o.size}"` : "";
  const cls = o.className ? ` class="${escAttr(o.className)}"` : "";
  const ns = o.xmlns === false ? "" : ' xmlns="http://www.w3.org/2000/svg"';
  return `<svg${ns}${cls} ${ICON_ATTRS}${size}${a11y}>${o.title ? `<title>${escAttr(o.title)}</title>` : ""}${m.icon}</svg>`;
}

/** The emblem as a complete <svg> in one ink, 80x80 units. */
export function mechanicEmblemSvg(id: MechanicId, ink: string, o: { title?: string } = {}): string {
  const m = mechanic(id);
  const title = o.title ?? m.name;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" role="img" aria-label="${escAttr(title)}" style="color:${escAttr(ink)}"><title>${escAttr(title)}</title>${DIAL}${m.emblem}</svg>`;
}
