/**
 * The Apogee Daily screens and the challenge-link prompt the video films, frozen into
 * tools/video/social.json.
 *
 *   npx tsx tools/video/socialDemo.ts
 *
 * The Daily screens are DailyService.view() itself (src/app/dailyService.ts), bundled with
 * Electron's few calls stubbed out, reading a synthetic stats folder
 * (tools/fixtures/syntheticStats.ts) as the app would at a fixed instant: Daily #4,
 * 2026-10-04 19:40 UTC. The draw, which run counts, every baseline, delta and glyph, the
 * streak and the share text are the service's. What is chosen: the folder (a seeded
 * library, a week of runs on today's three before the day, and the three earlier dailies
 * played, so the streak is 4), and which seed each of today's runs is drawn with, picked so
 * the grid shows all three marks (above, below, near). Signed out, as in socialUi.cjs's
 * unpainted pictures, so the board says what it says to anybody not signed in.
 *
 * The share card's record is built from the finished view as brand.md's shareRecord()
 * builds it, and the card context as main's (the snapshot's season rank, "You" signed
 * out). tools/video/prepare.ts draws the card from it at film time.
 *
 * The challenge-link prompt is the proposal src/app/social.ts publishes once an open
 * challenge's code has been looked up (its lookUpDuel lines, word for word), for a code the
 * real grammar accepts. The lookup itself needs a server, so the challenge's facts
 * (category, band, who sent it, how many answered) are demo values, and the scene says so.
 */

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { appendRun, writeStatsFolder } from "../fixtures/syntheticStats.ts";
import { baselineFromScores } from "../../src/core/history/baseline.ts";
import { loadSeason } from "../../src/core/season/season.ts";
import { parseStatsFile } from "../../src/core/stats/parseStatsFile.ts";
import { dailyFor, dailyWindow, type DailyPoolEntry } from "../../src/core/social/daily.ts";
import { deepLinkUrl, landingUrl, parseDeepLink } from "../../src/core/social/deepLinks.ts";
import { localDay } from "../../src/core/brand/shareInput.ts";

const out = fileURLToPath(new URL("./social.json", import.meta.url));
const work = resolve(".cache/video/social-demo");
const stats = join(work, "stats");
const profile = join(work, "profile");
rmSync(work, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const NOW = Date.UTC(2026, 9, 4, 19, 40, 0);
const BAND = 1;
const MIN = 60_000, H = 60 * MIN;

// ---- the folder -------------------------------------------------------------------------

writeStatsFolder(stats, { runs: 700, seed: 11, end: new Date(NOW - 3.5 * 24 * H), clean: true });
const season = loadSeason();
const pool: DailyPoolEntry[] = season.scenarios.map((s) => ({ name: s.scenario, category: s.category, window: s.window ?? 0 }));
const today = dailyFor(pool, season.name, NOW, BAND);
assert.ok(today, "a draw today");
const { start } = dailyWindow(today.number);

// The three earlier dailies, played inside their own days: the streak.
for (let n = 1; n < today.number; n++) {
  const draw = dailyFor(pool, season.name, dailyWindow(n).start + H, BAND)!;
  draw.scenarios.forEach((scenario, i) => appendRun(stats, { scenario, at: new Date(dailyWindow(n).start + (11 + i * 0.2) * H), seed: 900 + n * 10 + i, skill: 0.32 }));
}

// A week of runs on each of today's three before the day, so every baseline is settled.
today.scenarios.forEach((scenario, k) => {
  for (let i = 0; i < 7; i++) {
    appendRun(stats, { scenario, at: new Date(start - (6.5 - i * 0.9) * 24 * H - k * 7 * MIN), seed: 100 + k * 20 + i, skill: 0.34 });
  }
});
// Every run before the day on each of the three, the library's included, oldest first: the
// scores the baseline is the median of.
const priorScores = (scenario: string) => [...readdirSync(stats)]
  .filter((f) => f.startsWith(scenario + " - "))
  .map((f) => parseStatsFile(f, readFileSync(join(stats, f), "utf8")))
  .flatMap((r) => (r.ok && r.run.playedAt && r.run.playedAt.getTime() < start ? [r.run] : []))
  .sort((a, b) => a.playedAt!.getTime() - b.playedAt!.getTime())
  .map((r) => r.score);
const before = today.scenarios.map(priorScores);

// Today's three, each the seed whose score lands nearest the mark it is chosen to show.
const TARGET = [0.036, -0.019, 0.004];
const staging = join(work, "staging");
const runs = today.scenarios.map((scenario, k) => {
  const baseline = baselineFromScores(scenario, before[k]).value;
  let best: { seed: number; skill: number; gap: number } | null = null;
  // Some scenario kinds draw their score from the skill alone, so both are searched.
  for (let seed = 1; seed < 40; seed++) {
    for (let skill = 0.2; skill <= 0.5; skill += 0.004) {
      const r = appendRun(staging, { scenario, at: new Date(start + 60 * MIN), seed, skill });
      const gap = Math.abs((r.score - baseline) / baseline - TARGET[k]);
      if (!best || gap < best.gap) best = { seed, skill, gap };
    }
  }
  rmSync(staging, { recursive: true, force: true });
  return { scenario, ...best!, at: new Date(start + (10 + k * 0.25) * H + k * 3 * MIN) };
});

// The folder cache skips a file written in the last moments (KovaaK's may still be writing
// it), so everything written here is dated a minute back, as if it had been sitting there.
const settle = () => {
  const past = new Date(Date.now() - 60_000);
  for (const f of readdirSync(stats)) utimesSync(join(stats, f), past, past);
};
settle();

// ---- the service, as main runs it ------------------------------------------------------

const bundled = join(work, "dailyService.mjs");
await build({
  stdin: { contents: `export { DailyService } from "./src/app/dailyService.ts";`, resolveDir: process.cwd(), loader: "ts" },
  outfile: bundled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "error",
  plugins: [{
    name: "electron-stub",
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: `const userData = ${JSON.stringify(profile)};
          export const app = { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" };
          export const clipboard = { writeText() {} };
          export const safeStorage = { isEncryptionAvailable: () => false };
          export const shell = {}; export const dialog = {}; export class BrowserWindow {}`,
      }));
    },
  }],
});
writeFileSync(join(profile, "social.json"), JSON.stringify({ discord: false, dailyBand: BAND, posted: [] }));
const { DailyService } = await import(pathToFileURL(bundled).href);
const service = new DailyService({
  statsDir: () => stats, signedIn: () => false, queueBand: () => BAND,
  broadcast: () => {}, launch: async () => ({ ok: true }), copyText: () => {}, now: () => NOW,
});

const states = [service.view()];
for (const r of runs) {
  appendRun(stats, { scenario: r.scenario, at: r.at, seed: r.seed, skill: r.skill });
  settle();
  states.push(service.view());
}
const done = states.at(-1);
for (const [k, r] of done.rounds.entries()) console.log(`  round ${k + 1}: ${r.score} vs ${r.baseline} (${r.priorRuns} prior) -> ${r.delta}; chosen gap ${runs[k].gap}, seed ${runs[k].seed}, prior here ${before[k].length}`);
assert.equal(done.complete, true, "the day completes");
assert.deepEqual(done.rounds.map((r: any) => r.glyph), ["above", "below", "near"], "the grid shows all three marks");
assert.equal(done.streak, today.number, "a streak of every daily so far");
assert.ok(done.shareText && today.scenarios.every((s) => !done.shareText.includes(s)), "the share text names no scenario");

// ---- the card's record and context, as main builds them ----------------------------------

const snapshot = JSON.parse(readFileSync("data/snapshot.json", "utf8"));
const rank = snapshot.theme.find((t: any) => t.name === snapshot.player.benchmarkRank);
const dailyRecord = {
  number: done.number, band: done.band.name, marks: done.rounds.map((r: any) => r.glyph),
  meanDelta: done.meanDelta, streak: done.streak, provisional: done.provisional, date: localDay(NOW),
};
const cardContext = { playerName: "You", season: snapshot.benchmark.name, tier: rank ? { id: rank.id, name: rank.name, color: rank.color } : null };

// ---- a challenge link ------------------------------------------------------------------

const CODE = "Q7MX4KPA";
const parsed = parseDeepLink(`apogee://duel/${CODE}`);
assert.ok(parsed.ok && parsed.link.kind === "duel", "the grammar accepts the code");
const demoDuel = { category: "Precise Tracking", band: "Intermediate", from: "Wren", answers: 3 };
const lines = [
  `${demoDuel.category} · ${demoDuel.band}`,
  "Unrated: an open challenge never moves anybody's rating.",
  "You play the same three scenarios. Their score stays hidden until yours is in.",
  `${demoDuel.answers} players have answered it.`,
];
const link = {
  url: landingUrl(parsed.link),
  deepLink: deepLinkUrl(parsed.link),
  proposal: { id: 1, kind: "duel", code: CODE, state: "ready", title: `Open challenge from ${demoDuel.from}`, lines, confirm: "Accept and play", error: null, duel: null, navigate: "queue" },
};

writeFileSync(out, JSON.stringify({
  about: "Written by tools/video/socialDemo.ts: DailyService.view() over a synthetic stats folder at a fixed instant, and the open-challenge proposal social.ts publishes. Do not edit by hand; re-run the generator.",
  generatedAt: new Date(NOW).toISOString(),
  daily: states,
  dailyRecord,
  cardContext,
  link,
}, null, 1) + "\n");
console.log(`wrote ${out}`);
console.log(`  Daily #${done.number} ${done.band.name}: ${today.scenarios.join(" | ")}`);
for (const r of done.rounds) console.log(`  ${r.char} ${r.word.padEnd(8)} ${String(r.score).padStart(6)} vs ${r.baseline?.toFixed(0)}  ${(r.delta * 100).toFixed(2)}%`);
console.log(done.shareText.split("\n").map((l: string) => "  | " + l).join("\n"));
console.log(`  link ${link.url}`);
