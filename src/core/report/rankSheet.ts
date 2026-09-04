/**
 * The rank sheet, rendered from the season.
 *
 * This page used to be written by hand, and it went stale the first time the ladder
 * changed: it was headlined "Four ladders, thirty-two ranks" while the season held
 * forty-four. A sheet whose whole purpose is to be shown to other people for feedback is
 * the worst possible place for numbers that drift, so it is generated now, and both
 * `buildSeason` and the in-app season editor write it as part of saving.
 *
 * What is derived and what is authored is worth being clear about:
 *
 *   DERIVED   every name, colour, threshold, band, the headline counts, how many
 *             scenarios grade each band, which ranks are still placeholders, and the
 *             contrast and duplicate-colour findings. None of it can disagree with the
 *             season, because none of it is typed twice.
 *
 *   AUTHORED  the themes, and the notes that are judgements rather than measurements:
 *             "Tracking's order is not the actual evolutionary sequence" is a real
 *             observation and no amount of colour arithmetic will produce it.
 *
 * It is a specimen sheet rather than a document, and it is built like one. The chrome is
 * achromatic, in the client's own warm near-blacks, so the only colour anywhere on the
 * page is the colours being judged. Regions are separated by drawn rules rather than by
 * cards floating on a ground; nothing is elevated, there is no rounded corner in the file
 * and no shadow anywhere. A page that decorates itself competes with its own subject, and
 * the one thing this page must not do is flatter the colours.
 *
 * Every named rank is shown three ways: a filled chip, the name on the client's own
 * ground, and the name printed on paper. That is the whole argument of the sheet. A
 * swatch on its own will happily hide a near-black or a pure white, and a colour that
 * survives only one of the two grounds is a rank that disappears half the time.
 *
 * The two names are set in the colour *corrected for the ground they sit on*, and the
 * chip is not. That split is the client's, not this page's: a filled shape carries a
 * near-black fine and a word set in one does not, so backgrounds keep the authored value
 * and text gets moved. Setting the names raw here was the earlier behaviour and it made
 * the sheet illegible in exactly the places it was reporting on - fifty-two names printed
 * too pale or too dark to read, above a list explaining that fifty-two names were too
 * pale or too dark to read. The findings measure the raw colour either way, so nothing
 * is hidden by showing the reader what they would actually see.
 */

import type { Season } from "../season/season.ts";
import { ENERGY_PER_RANK } from "../benchmarks/energy.ts";
import {
  contrast,
  DARK_CHROME,
  DARK_GROUND,
  legibleOn,
  LIGHT_GROUND,
  MIN_CONTRAST,
} from "./contrast.ts";

/**
 * What each ladder's names are going for. Authored: a theme is an intention, and the
 * season file records names rather than why they were chosen.
 *
 * A category missing from here simply shows no theme, which is the honest state for one
 * nobody has decided about yet.
 */
const THEMES: Record<string, string> = {
  Tracking: "evolution",
  Switching: "speed",
};

/** The theme of the overall ladder, which is not a category and has no entry above. */
const OVERALL_THEME = "space";

/**
 * Notes that are judgements rather than measurements.
 *
 * Kept short and kept here, so the generated findings below can be trusted to be
 * mechanical. Each is checked against the season before it is shown, so a note about a
 * rank that has since been renamed drops out instead of misleading somebody.
 */
const AUTHORED_NOTES: { requires: string[]; title: string; body: string }[] = [
  {
    requires: ["Homoerectus", "Neanderthal", "Homosapiens", "Caveman", "Neolithic"],
    title: "Tracking's order is not the actual sequence",
    body:
      "Homo erectus, Neanderthal, Homo sapiens, then <em>Caveman</em>, Neolithic, Human. " +
      "Caveman and Human sit after Homo sapiens, and Neolithic is an era rather than a " +
      "species. Anyone who knows the order will notice, and the joke lands better if the " +
      "ladder is right.",
  },
];

/** Placeholder names buildSeason writes for a rank nobody has named. */
const PLACEHOLDER = /^Rank \d+\**$/;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** English for a small number, so the headline reads as prose rather than a stat. */
function words(n: number): string {
  const ones = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen",
  ];
  const tens = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  ];
  if (n < 20) return ones[n];
  if (n < 100) {
    const unit = n % 10;
    return unit === 0 ? tens[Math.floor(n / 10)] : `${tens[Math.floor(n / 10)]}-${ones[unit]}`;
  }
  return String(n);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/** "a", "a and b", "a, b and c". A finding is prose and has to read like it. */
function listOf(items: string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A date a printed copy can be dated by. No time of day: the sheet is read over days. */
function shortDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

interface Rung {
  /** 1-based within its own ladder. A band's ranks are its own, and start at one. */
  index: number;
  name: string;
  color: string;
  placeholder: boolean;
  /** Energy the rank costs, where the ladder has thresholds. */
  energy: number | null;
  /** Set on a rank held by a place on the board rather than by a score. */
  positionalTopN: number | null;
  onDark: number;
  onLight: number;
  /**
   * The colour as each ground actually paints it.
   *
   * The chip stays raw and the name moves, which is the split the client already makes:
   * a filled square shows a near-black perfectly well, and a word set in one does not.
   * Without this the sheet printed forty-two of its own names too pale to read and ten
   * too dark, which is a specimen of the problem rather than a document about it - and
   * the whole page exists to be handed to somebody for an opinion.
   */
  inkDark: string;
  inkLight: string;
}

interface Ladder {
  /** What the column is called on the page: a band name, or the whole ladder's name. */
  title: string;
  /** How a finding refers to it, which needs the category too. */
  fullTitle: string;
  /** The category alone. A rank's identity is this and its name, across every band. */
  category: string;
  rungs: Rung[];
  /** Scenarios grading this band, where the season carries them. */
  scenarios: number | null;
  /** True when every threshold is exactly its scenarios at that rank, so the sheet can say so. */
  energyIsPerScenario: boolean;
  /** Window labels for a flat, pre-band season. Null on every season since. */
  windows: string[] | null;
  windowSize: number;
}

interface Group {
  title: string;
  theme: string | null;
  note: string;
  bands: Ladder[];
}

function rungsOf(
  names: string[],
  colors: Record<string, string>,
  maxes: number[] | null,
  positionalTopN: number | null,
): Rung[] {
  return names.map((name, i) => {
    const color = colors[name] ?? "#8891a3";
    const positional = positionalTopN !== null && i === names.length - 1;
    return {
      index: i + 1,
      name,
      color,
      placeholder: PLACEHOLDER.test(name),
      // A positional rank has no threshold by construction: it is held by standing on
      // the board, so printing a number beside it would be inventing one.
      energy: positional ? null : maxes?.[i] ?? null,
      positionalTopN: positional ? positionalTopN : null,
      onDark: contrast(color, DARK_GROUND),
      onLight: contrast(color, LIGHT_GROUND),
      inkDark: legibleOn(color, DARK_GROUND),
      inkLight: legibleOn(color, LIGHT_GROUND),
    };
  });
}

/**
 * The sheet's shape: one overall ladder, then one plate per category holding its bands.
 *
 * Grouping by category rather than laying thirteen ladders out in one flat grid is most
 * of why the page reads at all. Four bands of Clicking side by side are four cuts of one
 * thing; the same four dropped into a grid beside Tracking and Switching are twelve
 * unrelated cards, and the reader has to rebuild the structure from the titles.
 */
function sheetOf(season: Season): { overall: Ladder; groups: Group[]; all: Ladder[] } {
  const size = season.windowSize ?? 0;
  const unnamed = (names: string[]) => names.filter((n) => PLACEHOLDER.test(n)).length;

  /** How many scenarios grade one band. One per family, which is what a band is. */
  const scenariosIn = (category: string, window: number): number | null => {
    if (!season.scenarios?.length) return null;
    return season.scenarios.filter(
      (s) => s.category === category && (s.window ?? 0) === window,
    ).length;
  };

  const overall: Ladder = {
    title: "Overall",
    fullTitle: "Overall",
    category: "Overall",
    rungs: rungsOf(season.rankNames, season.rankColors, null, null),
    scenarios: null,
    energyIsPerScenario: false,
    windows: null,
    windowSize: 0,
  };

  // Most finished category first, least finished last. Reproduces the order the sheet was
  // hand-written in, and keeps doing the right thing as ranks get named: the one that
  // still needs the most work is the one a reader ends on. Bands stay in their own order
  // inside a category, which is difficulty order and never anything else.
  const ordered = [...season.categories].sort(
    (a, b) =>
      unnamed((a.bands ?? []).flatMap((x) => x.rankNames).concat(a.bands?.length ? [] : a.rankNames)) -
        unnamed((b.bands ?? []).flatMap((x) => x.rankNames).concat(b.bands?.length ? [] : b.rankNames)) ||
      a.name.localeCompare(b.name),
  );

  const groups: Group[] = ordered.map((c) => {
    // One column per band, because a band is a whole benchmark and its ranks are its own.
    // Numbering them 1 to 4 four times is the honest presentation: the sheet used to run
    // one category to rank 16 with a band label every fourth rung, which reads as one
    // climb and is the exact implication the split removed.
    //
    // A season built before the split has no bands, and then the old windowed ladder is
    // rendered as a single column rather than as nothing at all.
    const bands: Ladder[] = c.bands?.length
      ? c.bands.map((b) => {
          const count = scenariosIn(c.name, b.window);
          // Only claimed when it is true of every rung. A hand-edited threshold makes the
          // sentence in the key wrong, and then the sheet simply does not say it.
          const perScenario =
            count !== null &&
            count > 0 &&
            b.rankMaxes.every((m, i) => m === count * ENERGY_PER_RANK * (i + 1));
          return {
            title: season.windows?.[b.window] ?? `Band ${b.window + 1}`,
            fullTitle: `${c.name} · ${season.windows?.[b.window] ?? `band ${b.window + 1}`}`,
            category: c.name,
            rungs: rungsOf(b.rankNames, b.rankColors, b.rankMaxes, b.positional?.topN ?? null),
            scenarios: count,
            energyIsPerScenario: perScenario,
            windows: null,
            windowSize: 0,
          };
        })
      : [
          {
            title: "All ranks",
            fullTitle: c.name,
            category: c.name,
            rungs: rungsOf(c.rankNames, c.rankColors, c.rankMaxes, null),
            scenarios: null,
            energyIsPerScenario: false,
            windows: size > 0 ? season.windows ?? null : null,
            windowSize: size,
          },
        ];

    const ranks = bands.reduce((n, b) => n + b.rungs.length, 0);
    const scenarios = bands.reduce((n, b) => n + (b.scenarios ?? 0), 0);

    return {
      title: c.name,
      theme: THEMES[c.name] ?? null,
      note:
        `${words(ranks)} ranks` +
        (bands.length > 1 ? ` in ${words(bands.length)} bands` : "") +
        (scenarios > 0 ? ` · ${words(scenarios)} scenarios` : ""),
      bands,
    };
  });

  return { overall, groups, all: [overall, ...groups.flatMap((g) => g.bands)] };
}

/**
 * One row of the overall plate.
 *
 * The overall ladder gets the room, because it is the one people screenshot and because
 * eight ranks are few enough to set large. The paper chips form a continuous column down
 * the right of the plate, which is the comparison the sheet exists to make: the same
 * eight names lit, and the same eight printed, level with each other.
 */
function renderOverallRung(r: Rung): string {
  const low = (n: number) => (n < MIN_CONTRAST ? " is-low" : "");
  const paper = r.placeholder
    ? `<span class="o-note">not named</span>`
    : `<span class="o-paper" style="color:${esc(r.inkLight)}">${esc(r.name)}</span>`;

  return (
    `        <li class="o-rung">` +
    `<span class="o-idx">${String(r.index).padStart(2, "0")}</span>` +
    `<span class="o-chip" style="background:${esc(r.color)}"></span>` +
    `<span class="o-name${r.placeholder ? " is-unnamed" : ""}"` +
    (r.placeholder ? "" : ` style="color:${esc(r.inkDark)}"`) +
    `>${esc(r.name)}</span>` +
    paper +
    `<span class="o-read">` +
    `<span class="pair"><span class="fig${low(r.onDark)}">${r.onDark.toFixed(2)}</span>` +
    `<span class="lab">on ground</span></span>` +
    `<span class="pair"><span class="fig${low(r.onLight)}">${r.onLight.toFixed(2)}</span>` +
    `<span class="lab">on paper</span></span>` +
    `</span></li>`
  );
}

function renderOverall(l: Ladder, theme: string | null): string {
  // Top rank first. The markup used to run bottom-up and be flipped with column-reverse,
  // which put the reading order, the selection order and the printed order the opposite
  // way round to the visible one.
  const rungs = [...l.rungs].reverse().map(renderOverallRung).join("\n");

  return (
    `  <section class="plate">\n` +
    `    <div class="plate-head">\n` +
    `      <h2>Overall</h2>\n` +
    `      <p class="plate-note">${
      theme ? `${esc(theme)} · ` : ""
    }derived from the three categories</p>\n` +
    `    </div>\n` +
    `    <ol class="overall">\n${rungs}\n    </ol>\n` +
    `  </section>`
  );
}

/** One rung of a band column: index, chip, name, what it costs, and the name on paper. */
function renderRung(r: Rung): string {
  const cost =
    r.positionalTopN !== null
      ? `<span class="r-cost">top ${r.positionalTopN}</span>`
      : r.energy === null
        ? ""
        : `<span class="r-cost">${fmt(r.energy)}</span>`;

  const second =
    r.positionalTopN !== null
      ? `<span class="r-note">a place on the board, not a score</span>`
      : r.placeholder
        ? `<span class="r-note">not named</span>`
        : `<span class="r-paper" style="color:${esc(r.inkLight)}">${esc(r.name)}</span>`;

  return (
    `          <li class="rung">` +
    `<span class="r-idx">${r.index}</span>` +
    `<span class="r-chip" style="background:${esc(r.color)}"></span>` +
    `<span class="r-name${r.placeholder ? " is-unnamed" : ""}"` +
    (r.placeholder ? "" : ` style="color:${esc(r.inkDark)}"`) +
    `>${esc(r.name)}</span>` +
    cost +
    second +
    `</li>`
  );
}

function renderBand(l: Ladder): string {
  const placeholders = l.rungs.filter((r) => r.placeholder).length;
  const top = l.rungs[l.rungs.length - 1];

  const meta: string[] = [];
  if (l.scenarios !== null && l.scenarios > 0) meta.push(`${words(l.scenarios)} scenarios`);
  if (l.energyIsPerScenario) {
    const scored = l.rungs.map((r) => r.energy).filter((e): e is number => e !== null);
    if (scored.length > 0) meta.push(`${fmt(Math.max(...scored))} at full marks`);
  }

  // The flat pre-band path: window labels drawn as rules inside one long column.
  const rows: string[] = [];
  [...l.rungs].reverse().forEach((r) => {
    if (l.windows && l.windowSize > 0 && r.index % l.windowSize === 0) {
      const w = l.windows[Math.floor((r.index - 1) / l.windowSize)];
      if (w) {
        rows.push(
          `          <li class="band-rule"><span>${esc(w)}</span>` +
            `<span>ranks ${r.index + 1 - l.windowSize} to ${r.index}</span></li>`,
        );
      }
    }
    rows.push(renderRung(r));
  });

  return (
    `        <section class="band">\n` +
    `          <div class="band-head">\n` +
    `            <h3>${esc(l.title)}</h3>\n` +
    (meta.length > 0 ? `            <p class="band-meta">${esc(meta.join(" · "))}</p>\n` : "") +
    (placeholders > 0
      ? `            <p class="band-unnamed">${words(placeholders)} of ${words(
          l.rungs.length,
        )} still unnamed</p>\n`
      : "") +
    `          </div>\n` +
    `          <ol class="rungs">\n${rows.join("\n")}\n          </ol>\n` +
    `        </section>`
  );
}

function renderGroup(g: Group): string {
  return (
    `  <section class="plate">\n` +
    `    <div class="plate-head">\n` +
    `      <h2>${esc(g.title)}</h2>\n` +
    `      <p class="plate-note">${g.theme ? `${esc(g.theme)} · ` : ""}${esc(g.note)}</p>\n` +
    `    </div>\n` +
    `    <div class="bands">\n${g.bands.map(renderBand).join("\n")}\n    </div>\n` +
    `  </section>`
  );
}

interface Finding {
  chips: string[];
  title: string;
  body: string;
}

/** Two channels pinned at 00 or ff, which is a corner or an edge of the RGB cube. */
function onCubeEdge(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return channels.filter((c) => c === 0 || c === 255).length >= 2;
}

/**
 * Everything wrong with the palette that arithmetic can find.
 *
 * Measured rather than listed, which is the point: the hand-written sheet named three
 * colours that vanish on dark and there are six, because judging a near-black by eye on
 * a lit monitor is exactly the thing eyes are bad at.
 */
function derivedFindings(ladders: Ladder[]): Finding[] {
  const findings: Finding[] = [];

  // One entry per *rank*, not per placement. `ladder.overlap` is 2, so six of the sixteen
  // ranks in a category are graded by two adjacent bands and appear in two columns - the
  // same rank, deliberately, carrying the same name and the same colour. Counting columns
  // read that as a defect and reported it as one: 58 names disappearing on paper where 39
  // do, and 37 colours "used on more than one rank" where six actually are, every other
  // one being a rank sitting next to itself. A check that cannot tell the design from a
  // fault is worse than no check, so the key is the category and the name.
  const seen = new Set<string>();
  const all: { ladder: string; color: string; top: boolean; rung: Rung }[] = [];
  for (const l of ladders) {
    // The rank people screenshot is the highest named one in the whole category, which is
    // not the last rung of every column: each band's own top rung is somebody else's
    // second rank through the overlap.
    const topName = [...ladders]
      .filter((x) => x.category === l.category)
      .flatMap((x) => x.rungs)
      .filter((r) => !r.placeholder)
      .at(-1)?.name;
    for (const r of l.rungs) {
      if (r.placeholder) continue;
      const key = `${l.category}|${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        ladder: l.fullTitle,
        color: r.color.toLowerCase(),
        top: r.name === topName,
        rung: r,
      });
    }
  }

  const onDark = all.filter((r) => r.rung.onDark < MIN_CONTRAST);
  const onLight = all.filter((r) => r.rung.onLight < MIN_CONTRAST);

  if (onDark.length > 0) {
    findings.push({
      chips: [...new Set(onDark.map((r) => r.color))],
      title: `${capitalise(words(onDark.length))} name${
        onDark.length === 1 ? "" : "s"
      } disappear${onDark.length === 1 ? "s" : ""} on the client's own ground`,
      body:
        onDark
          .map(
            (r) =>
              `<b>${esc(r.rung.name)}</b> (${esc(r.ladder)}, ${r.rung.onDark.toFixed(2)}:1)`,
          )
          .join(", ") +
        `. The client is dark, so these are the ranks nobody will be able to read on the ` +
        `screen they actually live on.`,
    });
  }

  if (onLight.length > 0) {
    findings.push({
      chips: [...new Set(onLight.map((r) => r.color))],
      title: `${capitalise(words(onLight.length))} name${
        onLight.length === 1 ? "" : "s"
      } disappear${onLight.length === 1 ? "s" : ""} on paper`,
      body:
        onLight
          .map(
            (r) =>
              `<b>${esc(r.rung.name)}</b> (${esc(r.ladder)}, ${r.rung.onLight.toFixed(2)}:1)`,
          )
          .join(", ") +
        `. A rank gets shown outside the client too, on a screenshot, a profile or a web ` +
        `page, and a badge that survives only one background is not finished.`,
    });
  }

  // A colour on two ranks, which matters most at the top: the top rank is the one people
  // screenshot, so it should be the most distinctive colour on the page.
  const byColor = new Map<string, typeof all>();
  for (const r of all) {
    const list = byColor.get(r.color) ?? [];
    list.push(r);
    byColor.set(r.color, list);
  }

  const shared = [...byColor.entries()].filter(([, rs]) => rs.length > 1);
  const sharedTops = shared.filter(([, rs]) => rs.filter((r) => r.top).length > 1);

  if (sharedTops.length > 0) {
    findings.push({
      chips: sharedTops.map(([color]) => color),
      title: "Two ladders top out in the same colour",
      body:
        sharedTops
          .map(
            ([color, rs]) =>
              `${listOf(rs.map((r) => `<b>${esc(r.rung.name)}</b>`))} are both ` +
              `<code>${esc(color)}</code>`,
          )
          .join("; ") +
        `. The top rank is the one people screenshot, so it wants to be the most ` +
        `distinctive colour on the page rather than a shared one.`,
    });
  }

  const sharedRest = shared.filter(([, rs]) => rs.filter((r) => r.top).length <= 1);
  if (sharedRest.length > 0) {
    findings.push({
      chips: sharedRest.map(([color]) => color),
      title: `${capitalise(words(sharedRest.length))} colour${
        sharedRest.length === 1 ? "" : "s"
      } used on more than one rank`,
      body:
        sharedRest
          .map(
            ([color, rs]) =>
              `<code>${esc(color)}</code> on ${listOf(
                rs.map((r) => `<b>${esc(r.rung.name)}</b> (${esc(r.ladder)})`),
              )}`,
          )
          .join("; ") + `. Two ranks the same colour is two ranks that look like one.`,
    });
  }

  // Where a colour sits in the cube. Reported because it is the thing behind most of the
  // contrast failures above rather than as a separate complaint about taste, so it says
  // how much of the overlap is real.
  const edge = all.filter((r) => onCubeEdge(r.color));
  if (edge.length > 0) {
    const alsoFailing = edge.filter(
      (r) => r.rung.onDark < MIN_CONTRAST || r.rung.onLight < MIN_CONTRAST,
    ).length;
    findings.push({
      chips: [...new Set(edge.map((r) => r.color))],
      title: `${capitalise(words(edge.length))} colour${
        edge.length === 1 ? " sits" : "s sit"
      } on an edge of the RGB cube`,
      body:
        `${capitalise(words(edge.length))} of the ${words(all.length)} named colours have ` +
        `two channels pinned at 00 or ff. That is where a colour has no room left to be ` +
        `moved for either ground: as bright as it can get on paper, as dark as it can get ` +
        `on the client, and nowhere to go when one of the two needs it to give. ` +
        (alsoFailing > 0
          ? `${capitalise(words(alsoFailing))} of them already ${
              alsoFailing === 1 ? "fails" : "fail"
            } one of the two contrast checks above, which is what this is really a ` +
            `count of.`
          : `None of them fails a contrast check yet, so this is a note about headroom ` +
            `rather than a fault.`),
    });
  }

  const unnamed = ladders.filter((l) => l.rungs.some((r) => r.placeholder));
  if (unnamed.length > 0) {
    const positional = unnamed.every((l) =>
      l.rungs.every((r) => !r.placeholder || r.positionalTopN !== null),
    );
    findings.push({
      chips: [],
      title: `The top rank of ${words(unnamed.length)} ladder${
        unnamed.length === 1 ? "" : "s"
      } has no name`,
      body:
        (unnamed.every((l) => l.rungs.filter((r) => r.placeholder).length === 1)
          ? `${listOf(unnamed.map((l) => esc(l.fullTitle)))}${
              unnamed.length > 1 ? " each" : ""
            } need${unnamed.length > 1 ? "" : "s"} one`
          : listOf(
              unnamed.map(
                (l) =>
                  `${esc(l.fullTitle)} needs ` +
                  `${words(l.rungs.filter((r) => r.placeholder).length)}`,
              ),
            )) +
        `. ` +
        (positional
          ? `These are the ranks held by a place on the board rather than by a score, so ` +
            `the name has to sound like the end of the climb rather than one more rung.`
          : `A placeholder is the one rank nobody can give an opinion on, so it is also ` +
            `the one this sheet cannot get feedback about.`),
    });
  }

  return findings;
}

function renderFinding(f: Finding): string {
  return (
    `      <li class="flag">\n` +
    `        <span class="flag-chips">` +
    f.chips
      .slice(0, 25)
      .map((c) => `<span class="flag-chip" style="background:${esc(c)}"></span>`)
      .join("") +
    `</span>\n` +
    `        <span class="flag-text"><b>${f.title}</b><span>${f.body}</span></span>\n` +
    `      </li>`
  );
}

/** The whole page, ready to write to disk. */
export function renderRankSheet(season: Season): string {
  const { overall, groups, all } = sheetOf(season);
  const totalRanks = all.reduce((n, l) => n + l.rungs.length, 0);
  const placeholders = all.reduce(
    (n, l) => n + l.rungs.filter((r) => r.placeholder).length,
    0,
  );
  const bandCount = Math.max(0, ...groups.map((g) => g.bands.length));
  const bandDepth = Math.max(0, ...groups.flatMap((g) => g.bands.map((b) => b.rungs.length)));
  const scenarioCount = season.scenarios?.length ?? 0;
  const built = shortDate(season.builtAt);

  const findings = [
    ...derivedFindings(all),
    ...AUTHORED_NOTES.filter((n) =>
      n.requires.every((name) => all.some((l) => l.rungs.some((r) => r.name === name))),
    ).map((n) => ({ chips: [] as string[], title: n.title, body: n.body })),
  ];

  // The band sentence, or the windowed one for a season built before the split. Neither
  // is written when there is nothing to say: this used to describe a sixteen-rank climb,
  // and once band ladders stopped carrying `windows` it evaluated to the empty string and
  // took the whole explanation off the sheet without saying so.
  const flat = all.find((l) => l.windows && l.windowSize > 0);

  // Counted per category rather than from the deepest band. Multiplying the band count by
  // the deepest band said a category held twenty names when it holds seventeen, because
  // one band of the four carries a fifth rank held by standing rather than by a score.
  const perCategory = [
    ...new Set(groups.map((g) => g.bands.reduce((n, b) => n + b.rungs.length, 0))),
  ];
  const setsQuestion =
    bandCount < 2
      ? ""
      : `<li>Each band names its own ranks, so a category's ${
          perCategory.length === 1 ? `${words(perCategory[0])} ` : ""
        }names are ${words(bandCount)} separate sets rather than one climb. Does that ` +
        `hold, or do the bands want separate themes?</li>`;

  const structure =
    bandCount > 1 && bandDepth > 0
      ? `Each category is cut into ${words(bandCount)} bands: ` +
        `${(season.windows ?? []).join(", ")}. One set of scenarios cannot measure both a ` +
        `first-week player and a good one, so each band is a whole benchmark with its own ` +
        `scenarios, its own ranks and its own top. A player holds a rank in every band they ` +
        `have played, which makes a category ${words(bandCount)} short ladders rather than ` +
        `one long one, and means nothing ever has to ask whether the top of a band sits ` +
        `below the bottom of the next.`
      : flat
        ? `Each category ladder is ${words(flat.rungs.length)} ranks deep, cut into ` +
          `${words((flat.windows ?? []).length)} windows of ${words(flat.windowSize)}: ` +
          `${(flat.windows ?? []).join(", ")}. One set of scenarios cannot measure both a ` +
          `first-week player and a good one, so you are graded against the window you are ` +
          `in, and the scenarios get harder as you climb.`
        : "";

  const colophon: [string, string][] = [
    ["Ladders", String(all.length)],
    ["Ranks", String(totalRanks)],
    ["Named", String(totalRanks - placeholders)],
    ["Categories", String(groups.length)],
    ...(bandCount > 1 ? ([["Bands each", String(bandCount)]] as [string, string][]) : []),
    ...(scenarioCount > 0 ? ([["Scenarios", fmt(scenarioCount)]] as [string, string][]) : []),
    ...(built ? ([["Built", built]] as [string, string][]) : []),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apogee Rank Ladders</title>
<style>
  /* ------------------------------------------------------------------
     A rank sheet, not a document. GENERATED: see core/report/rankSheet.ts,
     and edit the season rather than this file.

     Dark, and in one theme only. These ranks live inside a dark client,
     and a badge that only works on white is a badge that does not work,
     so the product's own ground is the honest place to judge them. The
     chrome takes its greys from the client for the same reason: this has
     to look like the thing it describes.

     Nothing here is decorated. Regions are separated by drawn rules
     rather than by cards floating on a ground, every surface is a
     painted value rather than a wash of white over the ground, there is
     no rounded corner in the file and no shadow anywhere. The only
     colour on the page belongs to the ranks, which is the entire point:
     a page that decorates itself competes with its own subject, and the
     one thing this page must not do is flatter the colours.
     ------------------------------------------------------------------ */
  :root {
    /* The client's own grounds, warm of neutral, read from DARK_CHROME in
       core/report/contrast.ts rather than copied: --ground is the surface
       every measurement on this page was taken against, so a sheet built on
       a different one would be quoting numbers it did not measure. */
    --ground:  ${DARK_CHROME.ground};
    --panel:   ${DARK_CHROME.panel};
    --well:    ${DARK_CHROME.well};

    /* Rules are drawn, not lit. Opaque greys, so an edge on --well and an
       edge on --panel are the same line rather than two different alphas
       of white, which is the whole difference between a panel and a card. */
    --rule:    ${DARK_CHROME.rule};
    --rule-2:  #4a443f;
    --rule-3:  #5f5851;

    --ink:     ${DARK_CHROME.ink};
    --ink-mid: ${DARK_CHROME.inkMid};
    --ink-dim: ${DARK_CHROME.inkDim};
    --warn:    #e8b34a;

    /* The light patch every name is tested against, and LIGHT_GROUND in
       contrast.ts. Not pure white: a real page never is, and pure white
       flatters a pale colour. */
    --paper:   ${LIGHT_GROUND};

    --font: "Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui,
            -apple-system, "Helvetica Neue", sans-serif;
    --display: "Segoe UI Variable Display", "Segoe UI Semibold", "Segoe UI",
               ui-sans-serif, system-ui, sans-serif;
    --mono: "Cascadia Mono", ui-monospace, Consolas, "SF Mono", "Roboto Mono",
            monospace;
  }

  * { box-sizing: border-box; }

  html { color-scheme: dark; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  ::selection { background: var(--rule-2); }

  .sheet { max-width: 1240px; margin: 0 auto; padding: 64px 28px 120px; }

  /* ---------------- masthead ---------------- */

  .eyebrow {
    margin: 0 0 16px;
    font-family: var(--mono);
    font-size: 11px; font-weight: 600;
    letter-spacing: .22em; text-transform: uppercase;
    color: var(--ink-dim);
  }

  h1 {
    font-family: var(--display);
    font-size: clamp(32px, 4.6vw, 50px);
    line-height: 1.05;
    letter-spacing: -.022em;
    font-weight: 700;
    margin: 0 0 20px;
    text-wrap: balance;
  }

  .lede {
    font-size: 16px;
    line-height: 1.66;
    color: var(--ink-mid);
    max-width: 66ch;
    margin: 0 0 12px;
  }
  .lede:last-of-type { margin-bottom: 0; }

  /* The counts, as one ruled run of figures. Not tiles: these are numbers about
     a single thing, and boxing each of them separately would say they were
     alternatives to choose between. */
  .colophon {
    display: flex; flex-wrap: wrap;
    margin: 34px 0 0; padding: 0;
    border-top: 1px solid var(--rule-2);
    border-bottom: 1px solid var(--rule-2);
  }
  .colophon > div {
    padding: 13px 24px 13px 0;
    margin-right: 24px;
    border-right: 1px solid var(--rule);
  }
  .colophon > div:last-child { border-right: 0; margin-right: 0; padding-right: 0; }
  .colophon dt {
    font-family: var(--mono);
    font-size: 10px; font-weight: 600;
    letter-spacing: .18em; text-transform: uppercase;
    color: var(--ink-dim);
  }
  .colophon dd {
    margin: 4px 0 0;
    font-family: var(--mono);
    font-size: 17px; font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  /* Two panels divided by the ground showing through a one-pixel gap, which is
     the same drawn rule the rest of the page uses rather than two borders
     meeting and reading as a double line. */
  .masthead-cols {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
    gap: 1px;
    background: var(--rule);
    margin-top: 40px;
  }
  @media (max-width: 860px) { .masthead-cols { grid-template-columns: minmax(0, 1fr); } }

  .ask, .key { background: var(--panel); padding: 22px 24px 24px; }

  .ask h2, .key h2 {
    margin: 0 0 15px;
    font-family: var(--mono);
    font-size: 11px; font-weight: 600;
    letter-spacing: .18em; text-transform: uppercase;
    color: var(--warn);
  }
  .key h2 { color: var(--ink-mid); }

  .ask ol { margin: 0; padding-left: 20px; }
  .ask li { margin-bottom: 10px; font-size: 14px; color: var(--ink-mid); line-height: 1.55; }
  .ask li:last-child { margin-bottom: 0; }
  .ask li::marker { font-family: var(--mono); font-size: 12px; color: var(--ink-dim); }

  .key dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: 14px; row-gap: 12px;
    margin: 0; align-items: baseline;
  }
  .key dt { justify-self: start; }
  .key dd { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-mid); }

  .key-chip {
    display: block; width: 13px; height: 13px;
    background: var(--rule-3); border: 1px solid var(--rule-3);
  }
  .key-name { font-family: var(--display); font-size: 14px; font-weight: 640; color: var(--ink); }
  .key-paper {
    display: inline-block; background: var(--paper); color: #2c2f36;
    padding: 2px 8px;
    font-family: var(--display); font-size: 12px; font-weight: 640;
  }
  .key-fig {
    font-family: var(--mono); font-size: 11px; color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }
  .key-note {
    font-family: var(--mono); font-size: 10px; color: var(--ink-dim);
    letter-spacing: .12em; text-transform: uppercase; white-space: nowrap;
  }

  /* ---------------- plates ---------------- */

  .plate { margin-top: 60px; }

  /* A plate head is a label on a rule, not a bar of its own colour. */
  .plate-head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 24px; padding-bottom: 11px;
    border-bottom: 1px solid var(--rule-2);
  }
  .plate-head h2 {
    margin: 0;
    font-family: var(--mono);
    font-size: 12px; font-weight: 600;
    letter-spacing: .22em; text-transform: uppercase;
    color: var(--ink);
  }
  .plate-note {
    margin: 0; text-align: right;
    font-family: var(--mono);
    font-size: 10px; font-weight: 600;
    letter-spacing: .14em; text-transform: uppercase;
    color: var(--ink-dim);
  }

  /* ---------------- the overall ladder ---------------- */

  .overall { list-style: none; margin: 0; padding: 0; }

  .o-rung {
    display: grid;
    grid-template-columns: 34px 20px minmax(0, 250px) minmax(0, 1fr) 172px;
    align-items: center;
    column-gap: 22px;
    padding: 0 6px;
    border-bottom: 1px solid var(--rule);
  }
  /* No transition and nothing moves. A wide row is hard to read across, and a
     block of ground under the one being read is the whole fix. */
  .o-rung:hover { background: var(--panel); }

  .o-idx {
    font-family: var(--mono); font-size: 12px;
    color: var(--ink-dim); text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .o-chip { width: 20px; height: 20px; border: 1px solid var(--rule-3); }
  .o-name {
    font-family: var(--display);
    font-size: clamp(20px, 2.2vw, 29px);
    font-weight: 700; letter-spacing: -.022em;
    padding: 17px 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .o-name.is-unnamed { color: var(--ink-dim); font-weight: 500; }

  /* The printed column. It runs the height of the plate so the comparison is
     continuous: eight names lit, and the same eight printed level with them. */
  .o-paper {
    background: var(--paper);
    padding: 11px 16px; margin: 10px 0;
    font-family: var(--display); font-size: 17px; font-weight: 640;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .o-note {
    font-family: var(--mono); font-size: 10px;
    letter-spacing: .14em; text-transform: uppercase; color: var(--ink-dim);
  }

  .o-read { display: flex; justify-content: flex-end; gap: 20px; }
  .o-read .pair { display: grid; justify-items: end; row-gap: 2px; }
  .o-read .fig {
    font-family: var(--mono); font-size: 12px; color: var(--ink-mid);
    font-variant-numeric: tabular-nums;
  }
  .o-read .fig.is-low { color: var(--warn); }
  .o-read .lab {
    font-family: var(--mono); font-size: 9px; font-weight: 600;
    letter-spacing: .14em; text-transform: uppercase; color: var(--ink-dim);
  }

  /* Narrow: the five columns become three lines. Squeezing them instead left the
     name column at about a hundred pixels, which ellipsised half the words the
     page is asking people to have an opinion about. */
  @media (max-width: 760px) {
    .o-rung {
      grid-template-columns: 26px 16px minmax(0, 1fr);
      grid-template-areas:
        "idx chip name"
        ".   .    paper"
        ".   .    read";
      row-gap: 9px;
      padding: 15px 6px;
    }
    .o-idx { grid-area: idx; }
    .o-chip { grid-area: chip; width: 16px; height: 16px; }
    .o-name { grid-area: name; padding: 0; font-size: 23px; }
    .o-paper, .o-note { grid-area: paper; }
    .o-paper { margin: 0; justify-self: start; max-width: 100%; padding: 7px 12px; }
    .o-read { grid-area: read; justify-content: flex-start; gap: 24px; }
    .o-read .pair { justify-items: start; }
  }

  /* ---------------- a category and its bands ---------------- */

  /* Ruled apart by the ground showing through a one-pixel gap. The widths step
     four to two to one and never three: a category has four bands, and three
     across would leave the fourth alone on a second row looking like a footnote. */
  .bands {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    background: var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  @media (max-width: 1080px) { .bands { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 620px)  { .bands { grid-template-columns: minmax(0, 1fr); } }

  .band { background: var(--ground); }

  .band-head {
    padding: 15px 16px 12px;
    border-bottom: 1px solid var(--rule);
    /* Enough for a title, a line of figures and the unnamed count. Without it the one
       band carrying a warning starts its rungs a line below the other three, and four
       columns that do not line up are four columns nobody can read across. */
    min-height: 84px;
  }
  .band-head h3 {
    margin: 0;
    font-family: var(--mono);
    font-size: 11px; font-weight: 600;
    letter-spacing: .18em; text-transform: uppercase;
    color: var(--ink);
  }
  .band-meta, .band-unnamed {
    margin: 5px 0 0;
    font-family: var(--mono); font-size: 10px;
    letter-spacing: .06em; color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }
  .band-unnamed { color: var(--warn); }

  .rungs { list-style: none; margin: 0; padding: 0; }

  /* Two lines: the rank as the client draws it, then the same name printed.
     Stacking them is what lets the test survive in a column this narrow. */
  .rung {
    display: grid;
    grid-template-columns: 15px 11px minmax(0, 1fr) auto;
    grid-template-areas:
      "idx chip name  cost"
      ".   .    paper paper";
    align-items: center;
    column-gap: 9px; row-gap: 6px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rule);
  }
  .rung:last-child { border-bottom: 0; }

  .r-idx {
    grid-area: idx;
    font-family: var(--mono); font-size: 10px; color: var(--ink-dim);
    text-align: right; font-variant-numeric: tabular-nums;
  }
  .r-chip { grid-area: chip; width: 11px; height: 11px; border: 1px solid var(--rule-3); }
  .r-name {
    grid-area: name;
    font-family: var(--display); font-size: 15px; font-weight: 640;
    letter-spacing: -.006em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .r-name.is-unnamed { color: var(--ink-dim); font-weight: 500; }
  .r-cost {
    grid-area: cost;
    font-family: var(--mono); font-size: 10px; color: var(--ink-dim);
    font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .r-paper {
    grid-area: paper; justify-self: start; max-width: 100%;
    background: var(--paper);
    padding: 2px 8px;
    font-family: var(--display); font-size: 12px; font-weight: 640;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .r-note {
    grid-area: paper;
    font-family: var(--mono); font-size: 10px; color: var(--ink-dim);
    line-height: 1.45;
  }

  /* Only a season built before the bands reaches this. */
  .band-rule {
    display: flex; justify-content: space-between; gap: 10px;
    padding: 7px 16px;
    background: var(--well);
    border-bottom: 1px solid var(--rule-2);
    font-family: var(--mono); font-size: 9px; font-weight: 600;
    letter-spacing: .16em; text-transform: uppercase; color: var(--ink-mid);
  }
  .band-rule span:last-child {
    color: var(--ink-dim); letter-spacing: .06em; text-transform: none;
  }

  /* ---------------- findings ---------------- */

  .flags { list-style: none; margin: 0; padding: 0; }
  .flag {
    display: grid;
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 18px; align-items: start;
    padding: 18px 0;
    border-bottom: 1px solid var(--rule);
  }
  .flag:last-child { border-bottom: 0; padding-bottom: 0; }
  @media (max-width: 620px) { .flag { grid-template-columns: minmax(0, 1fr); gap: 10px; } }

  .flag-chips { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 4px; }
  .flag-chip { width: 13px; height: 13px; border: 1px solid var(--rule-3); }
  .flag-text b {
    display: block;
    font-family: var(--display); font-size: 15px; font-weight: 650;
    letter-spacing: -.008em; color: var(--ink); margin-bottom: 5px;
  }
  .flag-text > span { font-size: 13.5px; line-height: 1.62; color: var(--ink-mid); }
  .flag-text > span b { display: inline; font-size: inherit; margin: 0; font-weight: 640; }

  code {
    font-family: var(--mono); font-size: .92em; color: var(--ink-mid);
    font-variant-numeric: tabular-nums;
  }

  /* ---------------- foot ---------------- */

  footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--rule-2); }
  footer p {
    margin: 0; font-size: 13px; line-height: 1.65;
    color: var(--ink-dim); max-width: 72ch;
  }
  /* Policies that can only be found by going to the repository are policies the
     people they are about will never read. */
  .legal { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 20px; }
  .legal a {
    font-family: var(--mono); font-size: 10px; font-weight: 600;
    letter-spacing: .16em; text-transform: uppercase;
    color: var(--ink-dim); text-decoration: none;
  }
  .legal a:hover { color: var(--ink-mid); text-decoration: underline; }

  /* On paper the whole sheet becomes the light test, which is the one thing it
     cannot otherwise show: a rank name as a printer actually lays it down. */
  @media print {
    :root {
      --ground: ${LIGHT_GROUND};
      --panel: #e3e7ee;
      --well: #e3e7ee;
      --rule: #c4c9d3;
      --rule-2: #aeb4c0;
      --rule-3: #8f96a4;
      --ink: #14161a;
      --ink-mid: #4a4f58;
      --ink-dim: #6d727b;
      --warn: #8a5b06;
    }
    html { color-scheme: light; }
    .sheet { padding: 0; max-width: none; }
    .plate { break-inside: avoid; margin-top: 34px; }
    .o-rung:hover { background: none; }
    /* The printed chips are now the same value as the page they sit on, so they
       need an edge or the comparison silently becomes one column. */
    .o-paper, .r-paper, .key-paper { border: 1px solid var(--rule); }

    /* And the lit column has to bring its own ground, or printing this sheet
       collapses the only thing it is for. The name column takes its colour from
       the season and sits on --ground, which the block above has just turned
       light: without this, both columns run the same test, and every name the
       findings above call unreadable on paper gets printed twice, unreadably,
       as evidence that it is fine. */
    .o-name, .r-name { background: ${DARK_GROUND}; }
    .o-name { padding: 17px 14px; }
    .r-name { padding: 2px 8px; justify-self: start; max-width: 100%; }
    .o-name.is-unnamed, .r-name.is-unnamed { color: ${DARK_CHROME.inkDim}; }
  }
</style>
</head>
<body>
<div class="sheet">

  <header>
    <p class="eyebrow">Apogee · ${esc(season.name)} · ${esc(season.status)}</p>
    <h1>${capitalise(words(all.length))} ladders, ${words(totalRanks)} ranks</h1>
    <p class="lede">
      Apogee is ranked 1v1 for KovaaK's. You queue a category, play three scenarios, and
      the ladder moves. ${listOf(groups.map((g) => esc(g.title)))} each rank separately, so
      being near the top of one says nothing about the others, and an overall rank is
      derived from all of them.
    </p>
    ${structure ? `<p class="lede">${structure}</p>` : ""}
    <p class="lede">
      Below are the names and the colours, and nothing else. Nothing is published yet, so
      all of it is still cheap to change.
    </p>

    <dl class="colophon">
${colophon.map(([k, v]) => `      <div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("\n")}
    </dl>

    <div class="masthead-cols">
      <section class="ask">
        <h2>What I am asking</h2>
        <ol>
          <li>Do the names read as a progression? Is it obvious which end is good?</li>
          <li>Does each ladder's theme land, or is it trying too hard?</li>
          <li>Would you be pleased to be told you are any of these?</li>${
            setsQuestion ? `
          ${setsQuestion}` : ""
          }
          <li>Which colour is the first one you would change, and what to?</li>
        </ol>
      </section>

      <section class="key">
        <h2>How to read a rung</h2>
        <dl>
          <dt><span class="key-chip"></span></dt>
          <dd>The colour exactly as the season stores it, filled, so a near-black is
            still visible as a chip. This is the only place on the page it is not
            adjusted.</dd>

          <dt><span class="key-name">Peregrine</span></dt>
          <dd>The name on the client's own ground, which is where it lives.</dd>

          <dt><span class="key-paper">Peregrine</span></dt>
          <dd>The same name printed. A screenshot, a profile or a web page is a light
            ground, and a colour that survives only one of the two is not finished.</dd>

          <dt><span class="key-note">both names</span></dt>
          <dd>Moved towards the opposite ground where the colour alone would be
            unreadable, by exactly as much as it takes and no more &mdash; which is what
            the client does, and what any surface showing a rank ought to. So a name that
            looks fine here can still be one the findings below name: the chip beside it
            is the honest one, and the ratios on the right are measured before the move,
            not after.</dd>

          <dt><span class="key-fig">45,000</span></dt>
          <dd>Energy the rank costs. A band's scenarios are worth ${fmt(
            ENERGY_PER_RANK,
          )} each per rank, so its last scored rank is every one of them at the top.</dd>
        </dl>
      </section>
    </div>
  </header>

${renderOverall(overall, OVERALL_THEME)}

${groups.map(renderGroup).join("\n\n")}

  <section class="plate">
    <div class="plate-head">
      <h2>Already known to be wrong</h2>
      <p class="plate-note">measured, not eyeballed</p>
    </div>
    <ul class="flags">
${findings.map(renderFinding).join("\n")}
    </ul>
  </section>

  <footer>
    <p>
      ${esc(season.name)} is a ${esc(season.status)}. Names, colours, thresholds and even
      the number of ranks are all still free to change. Publishing freezes the season,
      because a rank cannot be re-cut under people who already earned it, so this is the
      moment to be picky. Every figure on this page is derived from the season file at the
      moment the page is written, so nothing here is typed twice and nothing here can go
      stale on its own.
    </p>
    <p class="legal">
      <a href="../TERMS.md">Terms</a>
      <a href="../PRIVACY.md">Privacy</a>
      <a href="../FAIR-PLAY.md">Fair play</a>
    </p>
  </footer>

</div>
</body>
</html>
`;
}
