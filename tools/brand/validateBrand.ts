/**
 * validate:brand: the new mechanic glyphs, the four mechanic share cards, the marketing kit
 * and the motion cards, held to what they promise.
 *
 *   npm run validate:brand      (on Linux, under a display: xvfb-run -a npm run validate:brand)
 *
 * Nothing is written to assets/: every render goes to .cache/brand/validate/.
 *
 * 1. Sources. Every icon and emblem is one colour (currentColor, no hex), the copy carries
 *    no superlatives, and the generated copies (the renderer's mechanic-icons.js and icon
 *    files, the kit's icon sources, tools/video/mechanics.json) match what the generators
 *    would write now. The renderer's script is run and every icon it returns is checked.
 * 2. Adapters. Each record type is refused when it should be (a void flag, a daily with
 *    nothing played or a mark it does not know, a defence with no challenger, a placement
 *    over ten matches...), and what a record carries is cleaned, not trusted.
 * 3. Spoilers. No daily card, in any shape or theme, contains the name or label of any
 *    scenario in the season or the snapshot, in its text or anywhere in its markup.
 * 4. Rendering. Every sample and every edge case (32-character names, 43-character
 *    scenario labels, six-scenario dailies, ten-match placements, a vacant crown, an
 *    excluded round...) at 1200x675 and 1080x1920, dark and light, through the real
 *    rasteriser: no text leaves the canvas or its safe margin, no two lines collide, every
 *    line clears its contrast floor against the pixels actually behind it (checks.ts,
 *    src/core/report/contrast.ts), and each card prints the figures its input holds.
 *    The mechanic sheet, the marketing kit and the motion cards are rendered again with
 *    their own safe areas (X's avatar, Discord's round crop and name overlay, YouTube's
 *    duration badge, 5% action-safe on video).
 * 5. Video. card.html draws each mechanic's scene from tools/video/mechanics.json with the
 *    glyph in its top row and the title at full size, in 16:9 and 9:16.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";

import { anyCardSvg } from "../../src/core/brand/mechanicCards.ts";
import { MECHANICS, type MechanicId } from "../../src/core/brand/mechanics.ts";
import { palettes } from "../../src/core/brand/palette.ts";
import { fmtDelta, fmtScore, outcomeLabel, roundDigits, SHARE_CARD_SIZES, type CardLayout } from "../../src/core/brand/shareCard.ts";
import {
  crownCardInput,
  dailyCardInput,
  flagCardInput,
  shadowCardInput,
  type CardContext,
  type MechanicCardInput,
  type ShadowRecord,
} from "../../src/core/brand/shareInput.ts";
import { ordinalSuffix, shadowLabel } from "../../src/core/match/shadow.ts";
import { iconFile, mechanicJobs, rendererScript, RENDERER_ICONS, RENDERER_SCRIPT } from "./buildMechanics.ts";
import { marketingJobs, TAGLINES } from "./buildMarketing.ts";
import { motionJobs, VIDEO_MECHANICS, videoScenes } from "./buildMotion.ts";
import { checkText, textContrast } from "./checks.ts";
import { withFit } from "./draw.ts";
import { emblem, ensureDir, rasterizeReport, root, tokens, withFonts, type RasterJob, type TextMetric } from "./kit.ts";
import { mechanicEdgeCases, mechanicSamples } from "./mechanicSamples.ts";

const P = palettes(tokens);
const OUT = join(root, ".cache", "brand", "validate");
const failures: string[] = [];
let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const pass = (s: string) => console.log(`PASS: ${s}`);

// ------------------------------------------------------------------ 1. sources

const SUPERLATIVES = /\b(best|ultimate|revolutionary|amazing|perfect|unbeatable|insane|epic|world'?s|greatest|fastest|instantly)\b/i;

check("glyph sources", () => {
  for (const m of MECHANICS) {
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(m.icon), `${m.id} icon has a hard-coded colour`);
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(m.emblem), `${m.id} emblem has a hard-coded colour`);
    for (const attr of m.icon.match(/(fill|stroke)="([^"]+)"/g) ?? []) assert.ok(/"(none|currentColor)"/.test(attr), `${m.id} icon sets ${attr}`);
    assert.ok(m.name && m.line.length > 10 && m.line.length < 90, `${m.id} needs a name and a one-line description`);
    assert.ok(!SUPERLATIVES.test(m.line), `${m.id}'s line has a superlative: ${m.line}`);
  }
  for (const v of Object.values(TAGLINES)) assert.ok(!SUPERLATIVES.test(v), `tagline has a superlative: ${v}`);
});
check("generated copies are current", () => {
  const same = (path: string, want: string) => assert.equal(readFileSync(path, "utf8"), want, `${relative(root, path)} is stale: run npm run brand:mechanics (or brand:motion)`);
  for (const m of MECHANICS) {
    same(join(root, "assets", "brand", "mechanics", "icons", `${m.id}.svg`), iconFile(m.id));
    same(join(RENDERER_ICONS, `${m.id}.svg`), iconFile(m.id));
  }
  same(RENDERER_SCRIPT, rendererScript());
  same(VIDEO_MECHANICS, videoScenes());
});
check("renderer script", () => {
  const window: Record<string, unknown> = {};
  runInNewContext(readFileSync(RENDERER_SCRIPT, "utf8"), { window });
  const icon = window.mechanicIcon as (id: string, o?: object) => string;
  const emb = window.mechanicEmblem as (id: string, o?: object) => string;
  const api = window.APOGEE_MECHANICS as { ids: string[]; names: Record<string, string>; lines: Record<string, string> };
  assert.deepEqual([...api.ids], MECHANICS.map((m) => m.id));
  for (const m of MECHANICS) {
    const svg = icon(m.id);
    assert.ok(svg.startsWith("<svg") && svg.includes('stroke="currentColor"') && svg.includes('aria-hidden="true"'), `${m.id} icon`);
    assert.ok(icon(m.id, { label: 'a "b" <c>', className: "nav-icon", size: 20 }).includes('aria-label="a &quot;b&quot; &lt;c&gt;"'), "labels are escaped");
    assert.ok(emb(m.id).includes('viewBox="0 0 80 80"') && emb(m.id).includes("currentColor") && !/#[0-9a-f]{6}/i.test(emb(m.id)), `${m.id} emblem`);
    assert.equal(api.names[m.id], m.name);
    assert.equal(api.lines[m.id], m.line);
  }
  assert.throws(() => icon("nope"));
});

// ------------------------------------------------------------------ 2. adapters

const ctx: CardContext = { playerName: "rylee", season: "Season 1", tier: null };
const round = { scenario: "Scenario One", score: 110, baseline: 100, delta: 0.1, opponentDelta: 0.05, counted: true, excludedReason: null };
check("adapters refuse what they should", () => {
  const refused = (v: unknown) => assert.ok(v && typeof v === "object" && "refused" in v, JSON.stringify(v));
  refused(dailyCardInput({ number: 0, band: "Novice", marks: ["above"], meanDelta: 0.1, streak: 1 }, ctx));
  refused(dailyCardInput({ number: 3, band: "Novice", marks: [], meanDelta: null, streak: 1 }, ctx));
  refused(dailyCardInput({ number: 3, band: "Novice", marks: ["pending", "pending"], meanDelta: null, streak: 1 }, ctx));
  refused(dailyCardInput({ number: 3, band: "Novice", marks: ["near", "near", "near", "near", "near", "near", "near"], meanDelta: 0, streak: 1 }, ctx));
  refused(dailyCardInput({ number: 3, band: "Novice", marks: ["above", "Glide" as never], meanDelta: 0, streak: 1 }, ctx));
  refused(crownCardInput({ event: "defended", category: "Any", band: "Lunar", rival: null, defences: 1, yourMatchScore: 0.1, theirMatchScore: 0, rounds: [round], at: Date.now() }, ctx));
  refused(crownCardInput({ event: "taken", category: "Any", band: "Lunar", rival: null, defences: 0, yourMatchScore: 0.1, theirMatchScore: 0, rounds: [], at: Date.now() }, ctx));
  refused(flagCardInput({ verdict: "void", challenger: { displayName: "x" }, plantedAt: "2026-10-01", answeredAt: "2026-10-02", yourMatchScore: 0, theirMatchScore: 0, rounds: [round] }, ctx));
  refused(flagCardInput({ verdict: "win", challenger: { displayName: "x" }, plantedAt: "never", answeredAt: "2026-10-02", yourMatchScore: 0, theirMatchScore: 0, rounds: [round] }, ctx));
  refused(shadowCardInput({ series: [{ verdict: "void", percentile: 50 }], at: Date.now() }, ctx));
  refused(shadowCardInput({ series: [{ verdict: "win", percentile: 0 }], at: Date.now() }, ctx));
  refused(shadowCardInput({ series: [{ verdict: "win", percentile: 51 }, { verdict: "forfeit", percentile: 65 }], at: Date.now() }, ctx));
  refused(shadowCardInput({ series: [{ verdict: "placed" as never, percentile: 51 }], at: Date.now() }, ctx));
  // The placement is the queue board's read-out or nothing. Under three results the app
  // says "Placement shows after 3"; a read-out sent early is not printed; a record whose
  // board was never read says nothing either way. A Shadow card carries no rating field.
  const shadow = (placement: ShadowRecord["placement"], n = 1) =>
    shadowCardInput({ series: Array.from({ length: n }, (_, i) => ({ verdict: "win" as const, percentile: 50 + i })), placement, at: Date.now() }, ctx);
  const early = shadow({ estimate: 61, decided: 2 }, 2);
  assert.ok(!("refused" in early) && early.placement === null, "a read-out from fewer than three results is not printed");
  const pending = shadow(null, 2);
  assert.ok(!("refused" in pending) && pending.placement?.kind === "pending" && pending.placement.decided === 2 && pending.placement.needed === 3, "under three results the card counts to the read-out");
  const unknown = shadow(undefined, 4);
  assert.ok(!("refused" in unknown) && unknown.placement === null, "a board not read since the match prints no placement");
  const read = shadow({ estimate: 57.4, decided: 6 }, 6);
  assert.ok(!("refused" in read) && read.placement?.kind === "read" && read.placement.estimate === 57, "the read-out prints as the board sends it");
  assert.ok(!("refused" in read) && !Object.keys(read.player).some((k) => /rating|percentile/.test(k)) && !("placed" in read), "no rating, tier or placed field on a Shadow card");
  const many = shadow(null, 11);
  assert.ok(!("refused" in many) && many.series.length === 8 && many.series[7].percentile === 60 && many.placement === null, "eleven results trim to the last eight, and 'not yet' with eight in hand is not repeated");
  // Names that arrive with control characters or at any length are cleaned and capped.
  const crown = crownCardInput({ event: "taken", category: "Speed\u0007 Switching", band: "x".repeat(80), rival: { displayName: "a\nb" }, defences: -3, yourMatchScore: null, theirMatchScore: null, rounds: [round], at: Date.now() }, ctx);
  assert.ok(!("refused" in crown) && crown.category === "Speed Switching" && crown.band.length === 32 && crown.rival?.name === "ab" && crown.defences === 0);
  const daily = dailyCardInput({ number: 7, band: "Advanced\u0000", date: "2026-10-03T23:30:00", marks: ["above", "near", "first", "pending"], meanDelta: Number.NaN, streak: -2, nearBand: 3 }, ctx);
  assert.ok(!("refused" in daily));
  assert.deepEqual(daily.marks, ["above", "near", "first", "pending"]);
  assert.ok(daily.band === "Advanced" && daily.date === "2026-10-03" && daily.meanDelta === null && daily.streak === 1 && daily.nearBand === 0.01, "a daily record is cleaned, not trusted");
});

// ------------------------------------------------------------------ 3 and 4. cards

/** Every scenario name and label the season and the snapshot know, for the spoiler check. */
function scenarioNames(): string[] {
  const names = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim().length >= 4) names.add(v.trim().toLowerCase());
  };
  const snap = JSON.parse(readFileSync(join(root, "data", "snapshot.json"), "utf8")) as { categories: { scenarios: { name: string; label: string }[] }[] };
  for (const c of snap.categories) for (const s of c.scenarios) { add(s.name); add(s.label); }
  const season = JSON.parse(readFileSync(join(root, "data", "seasons", "season-1.json"), "utf8")) as { scenarios: { scenario: string; label: string; family?: string }[] };
  for (const s of season.scenarios) { add(s.scenario); add(s.label); add(s.family); }
  return [...names];
}

const cards: Record<string, MechanicCardInput> = { ...mechanicSamples(), ...mechanicEdgeCases() };
const names = scenarioNames();
check("daily cards name no scenario", () => {
  assert.ok(names.length > 100, `only ${names.length} scenario names found to check against`);
  for (const [key, input] of Object.entries(cards)) {
    if (input.kind !== "daily") continue;
    for (const layout of ["landscape", "portrait"] as const) {
      for (const theme of ["dark", "light"] as const) {
        const svg = anyCardSvg(input, { layout, palette: P[theme], emblem }).toLowerCase();
        const hit = names.find((n) => new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(svg));
        assert.ok(!hit, `${key} ${layout} ${theme} contains the scenario "${hit}"`);
      }
    }
  }
});

/** What a card must print, read back from the rasteriser's text after fitting. */
function expected(input: MechanicCardInput, texts: string[]): string[] {
  const missing: string[] = [];
  const has = (s: string) => texts.some((t) => t.includes(s));
  const want = (s: string) => { if (!has(s)) missing.push(s); };
  if (input.kind === "daily") {
    want(`Daily #${input.number}`);
    const labels = texts.filter((t) => /^(Above|Near|Below|First run|Not played)$/i.test(t)).length;
    if (labels !== input.marks.length) missing.push(`${input.marks.length} marks (found ${labels})`);
  } else if (input.kind === "shadow") {
    // What the queue shows (queue-board.js, core/match/shadow.ts), and nothing it does not.
    const last = input.series[input.series.length - 1];
    // Captions are set in capitals, so these read without regard to case.
    const wantI = (w: string) => { if (!texts.some((t) => t.toLowerCase().includes(w.toLowerCase()))) missing.push(w); };
    want(last.verdict === "win" ? "Shadow beaten" : last.verdict === "loss" ? "Shadow wins" : "Level");
    want(shadowLabel(last.percentile));
    if (texts.filter((t) => /synthetic, unrated/i.test(t)).length < 1) missing.push('"synthetic, unrated" in the kicker');
    const tiles = texts.filter((t) => /^(WON|LOST|LEVEL|FORFEIT)$/.test(t)).length;
    if (tiles !== input.series.length) missing.push(`${input.series.length} result tiles (found ${tiles})`);
    for (const m of input.series) if (!has(ordinalSuffix(m.percentile))) missing.push(`the ${ordinalSuffix(m.percentile)}-percentile tile`);
    if (input.placement?.kind === "read") {
      want(`About the ${ordinalSuffix(input.placement.estimate)} percentile`);
      wantI(`Placement from ${input.placement.decided} Shadow`);
    } else if (input.placement?.kind === "pending") wantI(`Placement shows after ${input.placement.needed}`);
    else if (texts.some((t) => /Placement/i.test(t))) missing.push("no placement line when the board was not read");
    if (input.placement?.kind === "pending" && texts.filter((t) => /^TO PLAY$/.test(t)).length !== input.placement.needed - input.series.length) missing.push("a To play tile per result the read-out still needs");
    const tierWords = ["Stargazer", "Astrologist", "Cosmonaut", "Lunar", "Odyssey", "Arecibo", "Quasar", "Supernova"];
    if (texts.some((t) => tierWords.some((w) => t.includes(w)))) missing.push("no tier: the app shows none for Shadows");
    if (texts.some((t) => /\brating\b/i.test(t) && !/no rating/i.test(t))) missing.push("no rating figure: Shadows move none");
  } else {
    for (const r of input.rounds.slice(0, 3)) {
      want(r.scenario.slice(0, 8));
      if (r.you.score != null) want(fmtScore(r.you.score));
      if (r.you.delta != null && !r.excluded) want(fmtDelta(r.you.delta, roundDigits(r)));
      if (r.them?.delta != null && !r.excluded) want(fmtDelta(r.them.delta, roundDigits(r)));
      want(outcomeLabel(r).toUpperCase());
    }
  }
  return missing;
}

const jobs: RasterJob[] = [];
const cardMeta: { key: string; input: MechanicCardInput; layout: CardLayout; index: number }[] = [];
for (const [key, input] of Object.entries(cards)) {
  for (const layout of ["landscape", "portrait"] as const) {
    for (const theme of ["dark", "light"] as const) {
      const { width, height } = SHARE_CARD_SIZES[layout];
      const svg = withFit(withFonts(anyCardSvg(input, { layout, palette: P[theme], emblem })));
      cardMeta.push({ key, input, layout, index: jobs.length });
      jobs.push({ svg, pngOut: ensureDir(join(OUT, "cards", `${key}-${layout}-${theme}.png`)), width, height, checks: { inset: layout === "landscape" ? 32 : 48 } });
    }
  }
}
const cardCount = jobs.length;
jobs.push(...mechanicJobs(join(OUT, "mechanics")).filter((j) => j.checks || /-24\.png$/.test(j.pngOut)));
jobs.push(...marketingJobs(join(OUT, "marketing")));
jobs.push(...motionJobs(join(OUT, "motion")));
for (const j of jobs) {
  delete j.svgOut;
  if (j.checks) j.report = true;
}
console.log(`validate:brand: rendering ${jobs.length} images (${cardCount} mechanic cards)`);
const { ok, reports } = rasterizeReport(jobs, "validate");
if (!ok) failures.push("the rasteriser reported a failure (see FAIL lines above)");

let worst: { ratio: number; text: string; job: string } | null = null;
let measured = 0;
jobs.forEach((j, i) => {
  const r = reports[i] as TextMetric[] | null;
  if (!j.checks) return;
  const name = relative(root, j.pngOut);
  if (!r) {
    failures.push(`${name}: no measurements came back`);
    return;
  }
  measured++;
  failures.push(...checkText(name, j.width, j.height, r, j.checks));
});
for (const m of cardMeta) {
  const r = reports[m.index] as TextMetric[] | null;
  if (!r) continue;
  const missing = expected(m.input, r.map((t) => t.s));
  if (missing.length) failures.push(`${relative(root, jobs[m.index].pngOut)}: does not print ${missing.join(", ")}`);
}
{
  // The lowest contrast anywhere, for the summary line.
  jobs.forEach((j, i) => {
    const r = reports[i];
    if (!r || !j.checks || j.checks.contrast === false) return;
    for (const t of r) {
      const c = textContrast(t);
      if (c != null && (!worst || c < worst.ratio)) worst = { ratio: c, text: t.s, job: relative(root, j.pngOut) };
    }
  });
}
if (!failures.length) {
  pass(`${cardCount} mechanic cards (${Object.keys(cards).length} inputs x 2 shapes x 2 themes) print their figures, stay in their margins, never collide`);
  pass(`${measured} images measured for safe areas, overlap and contrast` + (worst ? `; lowest contrast ${(worst as { ratio: number }).ratio.toFixed(2)}:1 ("${(worst as { text: string }).text}" in ${(worst as { job: string }).job})` : ""));
}

// ------------------------------------------------------------------ 5. video cards

{
  const scenes = (JSON.parse(readFileSync(VIDEO_MECHANICS, "utf8")) as { mechanics: { id: MechanicId; scene: { card: object } }[] }).mechanics;
  const smoke = scenes.flatMap((s) => ([[1920, 1080], [1080, 1920]] as const).map(([width, height]) => ({ card: s.scene.card, width, height, out: join(OUT, "video", `${s.id}-${width}x${height}.png`) })));
  const file = ensureDir(join(root, ".cache", "brand", "jobs", "card-smoke.json"));
  writeFileSync(file, JSON.stringify(smoke));
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const sandbox = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const resultFile = file.replace(/\.json$/, "") + ".result.json";
  rmSync(resultFile, { force: true });
  const r = spawnSync(electron, [...sandbox, join(root, "tools", "brand", "cardSmoke.cjs"), file], { stdio: "inherit" });
  // Both the exit status and the result file the child writes last: a child that crashed,
  // was killed, or exited 0 with failures must not read as a pass.
  let result: { drawn: number; failures: string[] } | null = null;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    result = null;
  }
  if (r.error || r.status !== 0 || !result || result.failures.length > 0 || result.drawn !== smoke.length) {
    const why = r.error ? r.error.message : !result ? `no result file (exit ${r.status ?? r.signal})` : result.failures.length ? `${result.failures.length} failure(s)` : `exit ${r.status ?? r.signal}`;
    failures.push(`card.html could not draw every mechanic scene: ${why} (see FAIL lines above)`);
  } else pass(`card.html draws all ${scenes.length} mechanic scenes with their glyph, 16:9 and 9:16, titles at full size`);
}

if (passed) pass(`${passed} source and adapter checks: one-colour glyphs, generated copies current, renderer script, refusals, cleaning, spoiler-free dailies`);
if (failures.length) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  console.error(`validate:brand: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("validate:brand: all checks passed");
