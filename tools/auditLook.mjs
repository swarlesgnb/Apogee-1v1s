/**
 * The thirty tells, re-derived against the shipped UI.
 *
 * There is a list going around of the things that make software look like nobody chose
 * anything: harsh gradients, glass panels, glowing drop shadows, stock stroke icons, a
 * rainbow of neon accents, corners rounded to twelve pixels, an em dash in every other
 * sentence. Most of it is fair. The client was audited against that list before this
 * script existed, and the answer was measured rather than argued: some of it was there,
 * some of it never was, and two of the items were already handled better than the list
 * asks for.
 *
 * This keeps that honest. A stylesheet drifts, a radial glow comes back because a panel
 * looked flat one evening, and by the next release nobody remembers the file used to be
 * clean. A handful of counts below are expected to be non-zero and each says why; every
 * other count is zero, and if one is not, something came back.
 *
 *   npm run audit:look
 *
 * Two surfaces are audited. The client is what players use. The rank sheet is what gets
 * sent to people for feedback, so it is the first thing anybody outside this repository
 * ever sees, and it was drifting on its own because it is generated from a different file
 * and nothing was watching it.
 *
 * This is a taste check with a hard edge, not a correctness check. It cannot tell you the
 * app looks good. It can only tell you it has not quietly turned back into every other
 * dark dashboard.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const html = read("src/app/renderer/index.html");
const js = read("src/app/renderer/renderer.js");
const both = html + js;
const css = html.slice(0, html.indexOf("</style>"));

// The colour checks below read the chrome and not `data/`. Rank colours are chosen to
// match rank names - Quasar is cyan because a quasar is, Singularity is black because a
// singularity is - so a rainbow across fifty-six of them is the ladder working, not a
// palette nobody picked. What a check can honestly say is that the *app around them* has
// not gone neon: `--accent` is set from the rank every snapshot, and everything else on
// screen is either a ground, a rule, or one of three semantic colours.
//
// `npm run ranks` is what watches the rank colours, and it reports rather than fails, for
// the same reason.

const count = (pattern, hay = css) => (hay.match(pattern) ?? []).length;

/* ---------------------------------------------------- colour, measured not asserted
 *
 * Two of the tells only ever showed up in the renderer, not the stylesheet, and the
 * audit was blind to both because it read `css` alone: the weakness map's three bars
 * were `linear-gradient(...)` assembled into an inline style string, and every rank
 * name in the scenario tables was painted with its raw season colour, several of which
 * sit near 1:1 on this ground.
 *
 * So the checks below read `js` as well, and the contrast floor the renderer uses is
 * re-derived here from the season itself rather than taken on trust.
 */

const season = JSON.parse(read("data/seasons/season-1.json"));

/** Every named colour the season defines, overall and per band. */
function seasonColours() {
  const out = new Map();
  const add = (o) => { for (const [k, v] of Object.entries(o ?? {})) out.set(k, v); };
  add(season.rankColors);
  for (const c of season.categories ?? []) {
    add(c.rankColors);
    for (const b of c.bands ?? []) add(b.rankColors);
  }
  return out;
}

const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const ground = (/--ground:\s*(#[0-9a-fA-F]{6})/.exec(css) ?? [])[1];
const below = (floor) =>
  [...seasonColours().values()]
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c) && ratio(c, ground) < floor).length;

/**
 * Colour expressions that end up as text.
 *
 * A rank colour reaching `color:` without passing through the lift is the bug this
 * catches: `legibleOnDark` and `rankInk` produce one, `inkOf` is the local name for the
 * same thing, and `var(--...)` is chrome rather than a rank.
 */
function unliftedRankText() {
  const sites = [
    ...js.matchAll(/\.style\.color\s*=\s*([^;]+);/g),
    ...js.matchAll(/style="color:'\s*\+\s*esc\(([^)]*\)?[^)]*)\)/g),
  ];
  return sites
    .map((m) => m[1])
    .filter((e) => !/legibleOnDark|rankInk|ink|Ink|var\(--/.test(e));
}

/**
 * Every `transition:` and `animation:` value in the stylesheet, without its selector.
 *
 * The motion checks read these rather than the whole file so that prose about motion -
 * the comment above the easing tokens says "never ease-in on a control" - is not itself
 * counted as motion. A check that fires on its own documentation is a check nobody keeps.
 */
const motionDecls = (css.match(/(?:transition|animation)\s*:[^;}]+/g) ?? []);
const motionText = motionDecls.join("\n");

/** Milliseconds in a motion declaration, whichever unit it was written in. */
function longMotion() {
  const over = [];
  for (const d of motionDecls) {
    for (const m of d.matchAll(/(?:^|[\s,(])(\d*\.?\d+)(ms|s)(?![a-z-])/g)) {
      const ms = m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
      if (ms > 300) over.push(d.replace(/\s+/g, " ").trim());
    }
  }
  return over;
}

/**
 * The motion that is deliberately longer than the 300ms a UI animation gets.
 *
 * Each is here for a reason and the reason is at its rule. The press release overshoots,
 * and cutting it to 300ms cuts the overshoot; the ring is the mark a press leaves and
 * outlives the press on purpose; the sweep is indeterminate progress, which has no
 * duration to be right about; the celebration is the once-a-rank moment this file
 * otherwise spends nothing on; the two fills are determinate progress moving at the
 * speed of the thing they measure.
 *
 * Anything not on this list is new, and new long motion on a client somebody has open
 * all evening is the thing this check exists to notice.
 */
const LONG_ON_PURPOSE = [
  "animation: commit-sweep 1150ms linear infinite",
  "animation: press-up .34s cubic-bezier(.2, .9, .3, 1)",
  "animation: fx-ring .42s cubic-bezier(.2, .7, .3, 1) forwards",
  "animation: pop .32s cubic-bezier(.2, .9, .3, 1) both",
  "transition: transform .6s var(--ease-out)",
  "transition: transform .4s var(--ease-out)",
];

let regressions = 0;

/**
 * Each check is [label, count, why]. `why` is set only where a non-zero count is the
 * right answer; anything else with a count is a regression.
 */
function report(title, checks) {
  console.log(`\n  ${title}\n  ${"-".repeat(title.length)}`);
  for (const [label, n, why] of checks) {
    if (n === 0) {
      console.log(`  ok    ${label}`);
    } else if (why) {
      console.log(`  kept  ${label}: ${n}`);
      console.log(`        ${why}`);
    } else {
      regressions++;
      console.log(`  BACK  ${label}: ${n}`);
    }
  }
}

report("the client", [
  ["harsh gradients", count(/linear-gradient|radial-gradient|conic-gradient/g),
    "the pool row's progress rail: two flat colours meeting at a hard stop, which is a " +
    "measurement drawn as a bar rather than a blend"],
  ["stock stroke icons", count(/viewBox="0 0 24 24"/g, html) +
    count(/lucide|feather|heroicon/gi, both),
    "the sound toggle, whose two paths are switched by CSS for the muted state. It is a " +
    "control, not decoration; the eight nav pictograms that were decoration are gone"],
  ["pure white ground", count(/background:\s*(#fff\b|#ffffff|white)\b/g)],
  ["pure RGB/CMY in the chrome",
    count(/#(?:00ff00|ff00ff|0000ff|00ffff|ffff00|ff0000)\b/gi, css)],
  ["drop shadows and glows", count(/box-shadow|drop-shadow/g)],
  ["three equal cards in a row", count(/grid-template-columns:\s*repeat\(3,/g),
    "the hero's three stats below 1180px, where a column of three becomes a row of " +
    "three. There are exactly three of them and they are not alternatives to choose between"],
  ["emoji", [...both].filter((c) => c.codePointAt(0) > 0x1f000).length],
  ["backdrop blur", count(/backdrop-filter/g)],
  ["em dashes in prose", count(/—/g, html) +
    (js.match(/.{0,12}—.{0,12}/g) ?? []).filter((m) => !m.includes('"—"') && !m.includes(">—<")).length],
  ["Inter, Geist, Grotesk, SF Pro",
    (css.match(/--(?:font|mono):([^;]+);/g) ?? [])
      .filter((f) => /Inter|Geist|Grotesk|SF Pro/.test(f)).length],
  ["coloured left stripes",
    count(/border-left:\s*[23]px solid var\(--(?:rank|tier|accent|up|down|warn)\)/g) +
    count(/inset 3px 0 0/g)],
  ["fake testimonials", count(/testimonial/gi, both)],
  ["bento grid", count(/bento/gi, both)],
  ["fake terminal window", count(/traffic-light|terminal-window|window-dots/g)],
  ["\"it's not x, it's y\"", count(/[Ii]t.s not .{1,40}, it.s/g, js)],
  ["checkmarks", (both.match(/✓|✔/g) ?? []).length,
    "one, replacing the round number in the match to-do list when that run lands. A " +
    "state, not a bullet"],
  ["pricing tiers", count(/pricing/gi, both)],
  ["radii off the scale",
    (css.match(/border-radius:\s*([^;}]+)/g) ?? [])
      .map((v) => v.replace(/border-radius:\s*/, "").trim())
      .filter((v) => !["0", "50%", "var(--r)", "inherit"].includes(v)).length],
  ["purple chrome", count(/#(?:a855f7|8000ff|7c3aed|9b5de5)/gi, css)],
  ["no loading geometry", css.includes(".pending td") ? 0 : 1],
  ["radial orbs", count(/radial-gradient/g)],
  ["dot grids", count(/repeating-linear-gradient|repeating-radial-gradient/g)],
  ["sparkles", (both.match(/✨/g) ?? []).length + count(/sparkle/gi, both)],
  ["animated arrows", count(/translateX.*arrow|arrow.*animation/gi, both)],
  ["no terms of use", existsSync(join(root, "TERMS.md")) ? 0 : 1],
  ["no privacy policy", existsSync(join(root, "PRIVACY.md")) ? 0 : 1],
  ["hover that moves things", count(/:hover\s*\{[^}]*transform/g)],
  ["neon chrome", count(/#(?:0f0|f0f|00ff\w\w|ff00\w\w)\b/gi, css)],
  ["pastel chrome", count(/#(?:ffd1ea|e6baf3|a9dcec|c4b5fd|bfdbfe|fbcfe8)/gi, css)],

  // Motion. The four below are the ones that separate motion somebody chose from motion
  // that arrived with a snippet, and each was measured against the stylesheet before it
  // was allowed to reject anything.
  //
  // ease-in withholds movement for the first frames, which are the ones being watched,
  // so the same duration reads as slower than an ease-out of the same length. `all`
  // animates properties nobody named, including the layout ones. And nothing in the
  // world appears from nothing, which is what scale(0) asks the eye to accept.
  ["ease-in on a control", count(/\bease-in\b(?!-out)/g, motionText)],
  ["transition: all", count(/transition:\s*all\b/g)],
  ["entrances from scale(0)", count(/scale\(0\)/g)],
  ["motion over 300ms that is not on the list",
    longMotion().filter((d) => !LONG_ON_PURPOSE.includes(d)).length],

  // Reduced motion means gentler, not gone. Blanking every transition takes the colour
  // and opacity changes with it, so a player who asked for less motion got a client
  // where every state snapped - which is harder to follow, not calmer.
  ["reduced motion blanks every transition",
    count(/\*\s*\{[^}]*transition:\s*none\s*!important/g)],

  // Built in the renderer as inline style strings, which is how three of them lived
  // here unnoticed while the stylesheet was clean.
  ["gradients built in the renderer",
    count(/linear-gradient|radial-gradient|conic-gradient/g, js)],
  ["rank colours painted as text without the contrast lift", unliftedRankText().length],
]);

// The floor `RANK_TEXT_CONTRAST` uses, re-derived from the season it was chosen against.
// The comment at that constant names these three counts; this is what makes them a
// claim rather than a recollection.
const declaredFloor = Number((/RANK_TEXT_CONTRAST = ([\d.]+)/.exec(js) ?? [])[1]);
const dark2 = below(2);
const darkFloor = below(declaredFloor);
console.log(
  `
  rank colours: ${seasonColours().size} named, ${dark2} below 2:1 on ${ground}, ` +
    `${darkFloor} below the client's ${declaredFloor}:1 floor`,
);
if (!Number.isFinite(declaredFloor) || declaredFloor < 3) {
  regressions++;
  console.log("  BACK  rank names are set below the large-text contrast floor");
}

// ---------------------------------------------------------------- the rank sheet
//
// The sheet is generated, so a tell that comes back here came back in
// core/report/rankSheet.ts and the file on disk is only where it shows up.
//
// The stylesheet is audited and the body is not. Every colour in the body arrives as an
// inline style attribute and every one of them is a rank colour: they belong to the
// season, not to the sheet, and the whole purpose of the page is to show them honestly,
// including the ones it is itself complaining about. Auditing the body would be auditing
// the subject rather than the presentation.

const sheetPath = "docs/season-1-ranks.html";
const sheet = existsSync(join(root, sheetPath)) ? read(sheetPath) : "";
const sheetCss = sheet.slice(sheet.indexOf("<style>"), sheet.indexOf("</style>"));
const sheetProse = sheet.slice(sheet.indexOf("</style>")).replace(/ style="[^"]*"/g, "");

const contrastTs = read("src/core/report/contrast.ts");
const constantOf = (name) =>
  (new RegExp(`${name}\\s*=\\s*"(#[0-9a-fA-F]{6})"`).exec(contrastTs) ?? [])[1] ?? null;
const declaredIn = (name) =>
  (new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(sheetCss) ?? [])[1] ?? null;

report("the rank sheet", [
  ["missing entirely", sheet ? 0 : 1],
  ["harsh gradients", count(/linear-gradient|radial-gradient|conic-gradient/g, sheetCss)],
  ["stock stroke icons", count(/<svg|viewBox|lucide|feather|heroicon/gi, sheet)],
  ["pure white ground", count(/background:\s*(#fff\b|#ffffff|white)\b/g, sheetCss)],
  ["drop shadows and glows", count(/box-shadow|drop-shadow/g, sheetCss)],
  ["three equal cards in a row", count(/grid-template-columns:\s*repeat\(3,/g, sheetCss)],
  ["emoji", [...sheet].filter((c) => c.codePointAt(0) > 0x1f000).length],
  ["backdrop blur", count(/backdrop-filter/g, sheetCss)],
  // The ten that stand in for an empty cell in the client are not here at all: the sheet
  // has no empty cells, so any em dash on it is prose.
  ["em dashes in prose", count(/—/g, sheet)],
  ["Inter, Geist, Grotesk, SF Pro",
    (sheetCss.match(/--(?:font|display|mono):([^;]+);/g) ?? [])
      .filter((f) => /Inter|Geist|Grotesk|SF Pro/.test(f)).length],
  ["coloured left stripes",
    count(/border-left:\s*[1-9]px solid var\(--(?:rank|tier|accent|up|down|warn)\)/g, sheetCss)],
  ["bento grid", count(/bento/gi, sheet)],
  ["fake terminal window", count(/traffic-light|terminal-window|window-dots/g, sheetCss)],
  ["\"it's not x, it's y\"", count(/[Ii]t.s not .{1,40}, it.s/g, sheetProse)],
  ["checkmarks", (sheet.match(/✓|✔/g) ?? []).length],
  ["rounded corners", count(/border-radius/g, sheetCss)],
  ["purple chrome", count(/#(?:a855f7|8000ff|7c3aed|9b5de5)/gi, sheetCss)],
  ["neon chrome", count(/#(?:0f0|f0f|00ff\w\w|ff00\w\w)\b/gi, sheetCss)],
  ["radial orbs", count(/radial-gradient/g, sheetCss)],
  ["dot grids", count(/repeating-linear-gradient|repeating-radial-gradient/g, sheetCss)],
  ["sparkles", (sheet.match(/✨/g) ?? []).length + count(/sparkle/gi, sheet)],
  ["motion of any kind", count(/transition:|animation:|@keyframes/g, sheetCss)],
  ["hover that moves things", count(/:hover\s*\{[^}]*transform/g, sheetCss)],
  ["no link to the terms", count(/TERMS\.md/g, sheet) > 0 ? 0 : 1],
  ["no link to the privacy policy", count(/PRIVACY\.md/g, sheet) > 0 ? 0 : 1],
  ["no character encoding declared", /<meta charset=/i.test(sheet) ? 0 : 1],
  // Every contrast figure printed on the sheet was measured against these two values. A
  // sheet that paints a different ground than it measured against is a sheet quietly
  // lying about the one thing it exists to report.
  ["ground does not match contrast.ts",
    declaredIn("ground") === constantOf("DARK_GROUND") ? 0 : 1],
  ["paper does not match contrast.ts",
    declaredIn("paper") === constantOf("LIGHT_GROUND") ? 0 : 1],
]);

/* ------------------------------------------------- copy keys and live readouts
 *
 * `data-copy` marks a string an admin may rewrite. The override is applied by setting
 * `textContent`, which is also how the renderer writes a computed figure, so a key on an
 * element the renderer writes puts the two in a fight: the override wins until the next
 * render and the figure wins after it, and the app looks like it forgets a number.
 *
 * Eight readouts carried keys when the copy editor was built - the queue verb, the draw
 * count, four panel notes and the two apex notes - and the one that failed loudly was the
 * apex board losing the date its boards were sampled on. The rest would have failed
 * quietly.
 *
 * Static, and deliberately so. The runtime version of this raced the render: whichever of
 * the two wrote last looked correct, so the same collision passed or failed depending on
 * timing. An element either carries a key or is written by the renderer.
 */
const copyKeyed = [...html.matchAll(/data-copy="([a-z0-9.-]+)"/g)].map((m) => m[1]);
const copyIds = [...html.matchAll(/<[^>]*data-copy="([a-z0-9.-]+)"[^>]*>/g)]
  .map((m) => ({ key: m[1], id: (/ id="([A-Za-z0-9_]+)"/.exec(m[0]) ?? [])[1] }))
  .filter((el) => el.id);

// Matched as a string rather than a pattern, against the one idiom this file writes text
// with. It does not catch a lookup stashed in a local first - the report link does that,
// and it restores whatever the label currently says rather than a literal, which is what
// makes it safe to keep a key on.
const written = copyIds.filter(
  (el) =>
    js.includes('$("' + el.id + '").textContent') ||
    js.includes('$("' + el.id + '").innerHTML'),
);

report("copy the admin editor can rewrite", [
  ["keys on readouts the renderer writes", written.length],
]);
for (const el of written) {
  console.log(`        ${el.key} is on #${el.id}, which the renderer writes`);
}

// The things that should be there. A file with no mono figures and no reduced-motion
// guard has not drifted back to a dashboard, it has been rewritten.
const mono = count(/var\(--mono\)/g);
const motion = count(/prefers-reduced-motion/g);
const sheetMono = count(/var\(--mono\)/g, sheetCss);
console.log(
  `\n  client: ${mono} mono declarations, ${motion} reduced-motion guards` +
    `\n  sheet:  ${sheetMono} mono declarations, no motion to guard`,
);
if (mono < 40) {
  regressions++;
  console.log("  BACK  the client's figures have come out of the mono face");
}
if (motion === 0) {
  regressions++;
  console.log("  BACK  motion is no longer gated");
}
if (sheetMono < 12) {
  regressions++;
  console.log("  BACK  the sheet's figures have come out of the mono face");
}

if (regressions > 0) {
  console.error(`\n${regressions} tell(s) came back.`);
  process.exit(1);
}
console.log("\nOK: both surfaces still look like somebody chose them");
