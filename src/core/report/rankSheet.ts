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
 *   DERIVED   every name, colour, threshold, window band, the headline counts, which
 *             ranks are still placeholders, and the contrast and duplicate-colour
 *             findings. None of it can disagree with the season, because none of it is
 *             typed twice.
 *
 *   AUTHORED  the themes, and the notes that are judgements rather than measurements -
 *             "Tracking's order is not the actual evolutionary sequence" is a real
 *             observation and no amount of colour arithmetic will produce it.
 *
 * The page is dark and in one theme on purpose: these ranks live inside a dark client,
 * and a badge that only works on white is a badge that does not work.
 */

import type { Season } from "../season/season.ts";
import {
  contrast,
  DARK_GROUND,
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

interface Ladder {
  title: string;
  theme: string | null;
  rankNames: string[];
  rankColors: Record<string, string>;
  /** Category energy per rank, when this ladder has any. Null for the overall. */
  rankMaxes: number[] | null;
  /** Window each rank belongs to, or null when the ladder is not windowed. */
  windows: string[] | null;
  windowSize: number;
}

function laddersOf(season: Season): Ladder[] {
  const size = season.windowSize ?? 0;

  const categories: Ladder[] = season.categories.map((c) => ({
    title: c.name,
    theme: THEMES[c.name] ?? null,
    rankNames: c.rankNames,
    rankColors: c.rankColors,
    rankMaxes: c.rankMaxes,
    windows: size > 0 ? (season.windows ?? null) : null,
    windowSize: size,
  }));

  // Most finished ladder first, least finished last. Reproduces the order the sheet was
  // hand-written in, and keeps doing the right thing as ranks get named: the one that
  // still needs the most work is the one a reader ends on.
  const unnamed = (l: Ladder) => l.rankNames.filter((n) => PLACEHOLDER.test(n)).length;
  categories.sort((a, b) => unnamed(a) - unnamed(b) || a.title.localeCompare(b.title));

  return [
    {
      title: "Overall",
      theme: OVERALL_THEME,
      rankNames: season.rankNames,
      rankColors: season.rankColors,
      rankMaxes: null,
      windows: null,
      windowSize: 0,
    },
    ...categories,
  ];
}

function renderLadder(ladder: Ladder): string {
  const placeholders = ladder.rankNames.filter((n) => PLACEHOLDER.test(n)).length;

  const rungs: string[] = [];

  ladder.rankNames.forEach((name, i) => {
    const color = ladder.rankColors[name] ?? "#8891a3";
    const isPlaceholder = PLACEHOLDER.test(name);

    // A named rank is shown on light as well as on dark, because that is the column that
    // catches a colour working on only one ground. A placeholder has no name worth
    // judging, so the energy it costs is the more useful thing in that space.
    const right = isPlaceholder
      ? `<span class="energy">${
          ladder.rankMaxes ? ladder.rankMaxes[i].toLocaleString("en-US") : ""
        }</span>`
      : `<span class="onlight" style="color:${esc(color)}">${esc(name)}</span>`;

    rungs.push(
      `        <div class="rung"><span class="tier">${i + 1}</span>` +
        `<span class="name-cell"><span class="swatch" style="background:${esc(color)}"></span>` +
        `<span class="name" style="color:${esc(color)}">${esc(name)}</span></span>` +
        right +
        `</div>`,
    );

    // A band label after the last rank of each window. The rungs render bottom-up
    // (`column-reverse`), so "after" in the markup puts the label directly above its own
    // band on screen, which is where a band label belongs.
    if (ladder.windows && ladder.windowSize > 0 && (i + 1) % ladder.windowSize === 0) {
      const w = ladder.windows[Math.floor(i / ladder.windowSize)];
      if (w) {
        rungs.push(
          `        <div class="band"><span>${esc(w)}</span>` +
            `<span class="band-range">ranks ${i + 2 - ladder.windowSize}–${i + 1}</span></div>`,
        );
      }
    }
  });

  const banner =
    placeholders > 0
      ? `      <div class="unnamed">${placeholders} of ${ladder.rankNames.length} ranks are ` +
        `still placeholders.</div>\n`
      : "";

  return (
    `    <section class="ladder">\n` +
    `      <div class="ladder-head">\n` +
    `        <h3>${esc(ladder.title)}</h3>\n` +
    (ladder.theme
      ? `        <span class="theme">${esc(ladder.theme)}</span>\n`
      : `        <span class="theme">not named yet</span>\n`) +
    `      </div>\n` +
    banner +
    `      <div class="rungs">\n${rungs.join("\n")}\n      </div>\n` +
    `    </section>`
  );
}

interface Finding {
  chips: string[];
  title: string;
  body: string;
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

  const all: { ladder: string; name: string; color: string; top: boolean }[] = [];
  for (const l of ladders) {
    l.rankNames.forEach((name, i) => {
      if (PLACEHOLDER.test(name)) return;
      all.push({
        ladder: l.title,
        name,
        color: (l.rankColors[name] ?? "#8891a3").toLowerCase(),
        top: i === l.rankNames.length - 1,
      });
    });
  }

  const onDark = all.filter((r) => contrast(r.color, DARK_GROUND) < MIN_CONTRAST);
  const onLight = all.filter((r) => contrast(r.color, LIGHT_GROUND) < MIN_CONTRAST);

  if (onDark.length > 0) {
    findings.push({
      chips: [...new Set(onDark.map((r) => r.color))],
      title: `${words(onDark.length)} name${onDark.length === 1 ? "" : "s"} disappear${
        onDark.length === 1 ? "s" : ""
      } on a dark ground`,
      body:
        onDark
          .map(
            (r) =>
              `<b>${esc(r.name)}</b> (${esc(r.ladder)}, ${contrast(r.color, DARK_GROUND).toFixed(
                2,
              )}:1)`,
          )
          .join(", ") +
        `. The client is dark, so these are the ranks nobody will be able to read on the ` +
        `screen they actually live on.`,
    });
  }

  if (onLight.length > 0) {
    findings.push({
      chips: [...new Set(onLight.map((r) => r.color))],
      title: `${words(onLight.length)} name${onLight.length === 1 ? "" : "s"} disappear${
        onLight.length === 1 ? "s" : ""
      } on a light ground`,
      body:
        onLight
          .map(
            (r) =>
              `<b>${esc(r.name)}</b> (${esc(r.ladder)}, ${contrast(r.color, LIGHT_GROUND).toFixed(
                2,
              )}:1)`,
          )
          .join(", ") +
        `. A rank gets shown outside the client too - a screenshot, a profile, a web page - ` +
        `and a badge that only survives one background is not finished.`,
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
              `${rs.map((r) => `<b>${esc(r.name)}</b>`).join(" and ")} are both ` +
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
              `<code>${esc(color)}</code> on ${rs
                .map((r) => `<b>${esc(r.name)}</b> (${esc(r.ladder)})`)
                .join(" and ")}`,
          )
          .join("; ") + `. Two ranks the same colour is two ranks that look like one.`,
    });
  }

  const unnamed = ladders.filter((l) => l.rankNames.some((n) => PLACEHOLDER.test(n)));
  if (unnamed.length > 0) {
    findings.push({
      chips: ["#3f4652", "#59606d", "#737b89", "#8d95a4"],
      title: "The bottom of every category ladder is unnamed",
      body:
        `The ladder grew downwards - it used to start at what is now rank 5 - so ` +
        unnamed
          .map(
            (l) =>
              `${esc(l.title)} needs ` +
              `${words(l.rankNames.filter((n) => PLACEHOLDER.test(n)).length)}`,
          )
          .join(", ") +
        `. These are the ranks a new player spends their first weeks in, so they are the ` +
        `ones where a name has to be welcoming rather than merely low.`,
    });
  }

  return findings;
}

function renderFinding(f: Finding): string {
  return (
    `      <div class="flag">\n` +
    `        <span class="chips">` +
    f.chips
      .slice(0, 6)
      .map((c) => `<span class="chip" style="background:${esc(c)}"></span>`)
      .join("") +
    `</span>\n` +
    `        <span><b>${f.title}</b>${f.body}</span>\n` +
    `      </div>`
  );
}

/** The whole page, ready to write to disk. */
export function renderRankSheet(season: Season): string {
  const ladders = laddersOf(season);
  const totalRanks = ladders.reduce((n, l) => n + l.rankNames.length, 0);
  const windowCount = season.windows?.length ?? 0;

  const findings = [
    ...derivedFindings(ladders),
    ...AUTHORED_NOTES.filter((n) =>
      n.requires.every((name) => ladders.some((l) => l.rankNames.includes(name))),
    ).map((n) => ({ chips: [] as string[], title: n.title, body: n.body })),
  ];

  const deepest = Math.max(0, ...ladders.filter((l) => l.windows).map((l) => l.rankNames.length));

  const windowSentence =
    windowCount > 1 && season.windowSize && deepest > 0
      ? `Each category ladder is ${words(deepest)} ranks deep, cut into ` +
        `${words(windowCount)} windows of ${words(season.windowSize)} — ` +
        `${(season.windows ?? []).join(", ")} — because one set of scenarios cannot measure ` +
        `both a first-week player and a good one. You are graded against the window you are ` +
        `in, and the scenarios get harder as you climb.`
      : "";

  return `<title>Apogee Rank Ladders</title>
<style>
  /* ------------------------------------------------------------------
     A rank sheet, not a document. GENERATED - see core/report/rankSheet.ts;
     edit the season, not this file.

     The page is dark on purpose and in one theme only: these ranks live
     inside a dark client, and a badge that only works on white is a badge
     that does not work. Committing to the product's own ground is the
     honest place to judge them.

     The one thing the page must not do is flatter the colours. Every named
     rank is shown three ways - a filled chip, its name on dark, its name on
     light - because "does this read" is the actual question being asked,
     and a swatch alone will happily hide a near-black or a pure white.
     ------------------------------------------------------------------ */
  :root {
    --void:      ${DARK_GROUND};
    --panel:     #0d1117;
    --sunken:    #090c11;
    --raised:    #131923;
    --line:      #1b2230;
    --line-lit:  #2a3444;
    --ink:       #e9edf5;
    --ink-mid:   #9aa5b8;
    --ink-dim:   #5e6a7c;
    --warn:      #e0a63f;

    /* The light patch each name is tested against. Not pure white: a real
       page never is, and pure white flatters a pale colour. */
    --paper:     ${LIGHT_GROUND};

    --font: ui-sans-serif, "Segoe UI Variable Text", "Segoe UI", system-ui,
            -apple-system, "Helvetica Neue", sans-serif;
    --display: "Segoe UI Variable Display", "Segoe UI Semibold", ui-sans-serif,
               system-ui, sans-serif;
    --mono: ui-monospace, "Cascadia Mono", "Cascadia Code", Consolas,
            "SF Mono", "Roboto Mono", monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--void);
    color: var(--ink);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  .page {
    max-width: 1180px;
    margin: 0 auto;
    padding: 56px 24px 96px;
  }

  /* ---------------- masthead ---------------- */
  .masthead { margin-bottom: 44px; }

  .eyebrow {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: .18em;
    text-transform: uppercase;
    color: var(--ink-dim);
    margin-bottom: 14px;
  }

  h1 {
    font-family: var(--display);
    font-size: clamp(34px, 5.5vw, 52px);
    line-height: 1.04;
    letter-spacing: -.02em;
    font-weight: 700;
    margin: 0 0 18px;
    text-wrap: balance;
  }

  .standfirst {
    font-size: 17px;
    line-height: 1.62;
    color: var(--ink-mid);
    max-width: 62ch;
    margin: 0 0 10px;
  }

  .ask {
    margin-top: 26px;
    padding: 16px 18px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 3px solid var(--warn);
    border-radius: 4px;
    max-width: 66ch;
  }
  .ask h2 {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--warn);
    margin: 0 0 8px;
  }
  .ask p { margin: 0 0 8px; font-size: 14.5px; color: var(--ink-mid); }
  .ask p:last-child { margin-bottom: 0; }
  .ask ol { margin: 8px 0 0; padding-left: 20px; font-size: 14.5px; color: var(--ink-mid); }
  .ask li { margin-bottom: 5px; }

  /* ---------------- ladders ---------------- */
  .ladders {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 22px;
    margin-top: 44px;
  }

  .ladder {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
  }

  .ladder-head {
    padding: 15px 18px 13px;
    border-bottom: 1px solid var(--line);
    background: var(--sunken);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .ladder-head h3 {
    font-family: var(--display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -.01em;
    margin: 0;
  }
  .ladder-head .theme {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--ink-dim);
  }

  .unnamed {
    padding: 11px 18px;
    background: #1d1608;
    border-bottom: 1px solid #3a2e12;
    font-size: 13px;
    color: var(--warn);
  }

  .rungs { display: flex; flex-direction: column-reverse; }

  .rung {
    display: grid;
    grid-template-columns: 26px 1fr auto;
    align-items: center;
    gap: 13px;
    padding: 11px 18px;
    border-top: 1px solid var(--line);
  }
  .rung:last-child { border-top: none; }

  /* Which scenarios grade this stretch of the ladder. Sits above its own band. */
  .band {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 18px 6px;
    background: var(--sunken);
    border-top: 1px solid var(--line-lit);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--ink-mid);
  }
  .band-range { letter-spacing: .06em; color: var(--ink-dim); text-transform: none; }

  .tier {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .swatch {
    width: 13px; height: 13px;
    border-radius: 3px;
    flex: none;
    /* A ring, so a near-black chip is still a chip on a near-black page. */
    box-shadow: 0 0 0 1px rgba(255,255,255,.22);
  }

  .name-cell { display: flex; align-items: center; gap: 11px; min-width: 0; }

  .name {
    font-family: var(--display);
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -.005em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The same name on a light ground. This is the column that catches a
     colour which only works on one background. */
  .onlight {
    background: var(--paper);
    border-radius: 3px;
    padding: 2px 9px;
    font-family: var(--display);
    font-size: 13px;
    font-weight: 650;
    white-space: nowrap;
    justify-self: end;
  }

  .energy {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-dim);
    font-variant-numeric: tabular-nums;
  }

  /* ---------------- contrast notes ---------------- */
  .findings {
    margin-top: 52px;
    padding: 22px 24px;
    background: var(--raised);
    border: 1px solid var(--line-lit);
    border-radius: 6px;
  }
  .findings h2 {
    font-family: var(--display);
    font-size: 19px;
    font-weight: 700;
    margin: 0 0 6px;
  }
  .findings > p {
    color: var(--ink-mid);
    font-size: 14.5px;
    margin: 0 0 18px;
    max-width: 68ch;
  }

  .flags { display: grid; gap: 10px; }
  .flag {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 13px;
    align-items: start;
    padding: 12px 14px;
    background: var(--sunken);
    border: 1px solid var(--line);
    border-radius: 4px;
  }
  .flag .chips { display: flex; gap: 5px; padding-top: 3px; }
  .flag .chip {
    width: 15px; height: 15px; border-radius: 3px;
    box-shadow: 0 0 0 1px rgba(255,255,255,.22);
  }
  .flag b {
    display: block;
    font-size: 14px;
    font-weight: 650;
    margin-bottom: 2px;
  }
  .flag span { font-size: 13.5px; color: var(--ink-mid); }

  footer {
    margin-top: 56px;
    padding-top: 22px;
    border-top: 1px solid var(--line);
    font-size: 13px;
    color: var(--ink-dim);
    max-width: 70ch;
  }
  code {
    font-family: var(--mono);
    font-size: .92em;
    color: var(--ink-mid);
  }
</style>

<div class="page">
  <header class="masthead">
    <div class="eyebrow">Apogee · ${esc(season.name)} · ${esc(season.status)}</div>
    <h1>${capitalise(words(ladders.length))} ladders, ${words(totalRanks)} ranks</h1>
    <p class="standfirst">
      Apogee is ranked 1v1 for KovaaK's. You queue a category, play three scenarios,
      and the ladder moves. Clicking, Tracking and Switching each rank separately —
      being near the top of one says nothing about the others — and an overall rank is
      derived from all three.
    </p>
    ${windowSentence ? `<p class="standfirst">${windowSentence}</p>` : ""}
    <p class="standfirst">
      These are the names and colours. Nothing is published yet, so all of it is still
      cheap to change.
    </p>

    <div class="ask">
      <h2>What I'm asking</h2>
      <ol>
        <li>Do the names read as a <em>progression</em> — is it obvious which end is good?</li>
        <li>Does each ladder's theme land, or is it trying too hard?</li>
        <li>Would you be pleased to be told you're any of these?</li>
        <li>The bottom four of every ladder are unnamed. What goes there?</li>
      </ol>
      <p>Each named rank is shown three ways: a colour chip, the name on dark, and the name
        on light. If it disappears in one of those, that's worth knowing.</p>
    </div>
  </header>

  <div class="ladders">

${ladders.map(renderLadder).join("\n\n")}

  </div>

  <section class="findings">
    <h2>Things I already know are wrong</h2>
    <p>
      Better to name them than have three people each spend their first message on the
      same ones. The contrast numbers below are measured, not eyeballed.
    </p>

    <div class="flags">
${findings.map(renderFinding).join("\n")}
    </div>
  </section>

  <footer>
    ${esc(season.name)} is a ${esc(season.status)}: nothing is published, so names, colours,
    thresholds and even the number of ranks are all still free to change. Once a season is
    published it is frozen — a rank cannot be re-cut under people who already earned it —
    so this is the moment to be picky.
  </footer>
</div>
`;
}
