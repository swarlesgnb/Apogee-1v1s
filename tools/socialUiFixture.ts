/**
 * The stats folder and profile tools/socialUi.cjs photographs the social screens with.
 *
 *   npx tsx tools/socialUiFixture.ts [--out .cache/social-ui]
 *
 * Writes, under the output folder:
 *   stats/      a synthetic library (tools/fixtures/syntheticStats.ts), plus history before
 *               today on two of today's Daily scenarios and one run inside today's Daily;
 *   pending/    the other two of today's runs, which the UI run copies into stats/ as if
 *               KovaaK's had just written them, so the watcher and the Daily see them land;
 *   profile/    settings.json pointing at stats/, and social.json choosing the band;
 *   draw.json   today's number, band and three, for the UI run to assert against.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { appendRun, writeStatsFolder } from "./fixtures/syntheticStats.ts";
import { loadSeason } from "../src/core/season/season.ts";
import { dailyFor, dailyNumberAt, dailyWindow, type DailyPoolEntry } from "../src/core/social/daily.ts";

const outArg = process.argv.indexOf("--out");
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : ".cache/social-ui");
const stats = join(out, "stats");
const pending = join(out, "pending");
const profile = join(out, "profile");
rmSync(out, { recursive: true, force: true });
mkdirSync(pending, { recursive: true });
mkdirSync(profile, { recursive: true });

const now = Date.now();
const summary = writeStatsFolder(stats, { runs: 900, seed: 7, end: new Date(now - 26 * 3_600_000), clean: true });

const season = loadSeason();
const pool: DailyPoolEntry[] = season.scenarios.map((s) => ({ name: s.scenario, category: s.category, window: s.window ?? 0 }));
const band = 1;
const draw = dailyFor(pool, season.name, now, band);
if (!draw) throw new Error("no draw today");
const { start } = dailyWindow(draw.number);
const [a, b, c] = draw.scenarios;

// History before the day: six runs on the first (a real baseline), three on the second
// (provisional), none on the third (its first run sets the baseline).
for (let i = 0; i < 6; i++) appendRun(stats, { scenario: a, at: new Date(start - 30 * 3_600_000 + i * 120_000), seed: 100 + i, skill: 0.3 });
for (let i = 0; i < 3; i++) appendRun(stats, { scenario: b, at: new Date(start - 29 * 3_600_000 + i * 120_000), seed: 200 + i, skill: 0.35 });

// Today: the first is already played; the other two wait in pending/.
const inDay = (min: number) => new Date(Math.min(now - 60_000, start + min * 60_000));
appendRun(stats, { scenario: a, at: inDay(5), seed: 301, skill: 0.4 });
const staging = join(out, "staging");
const r2 = appendRun(staging, { scenario: b, at: inDay(9), seed: 302, skill: 0.28 });
const r3 = appendRun(staging, { scenario: c, at: inDay(13), seed: 303, skill: 0.33 });
cpSync(join(staging, r2.file), join(pending, r2.file));
cpSync(join(staging, r3.file), join(pending, r3.file));
rmSync(staging, { recursive: true, force: true });

writeFileSync(join(profile, "settings.json"), JSON.stringify({ statsDir: stats, window: { x: null, y: null, width: 1280, height: 860, maximized: false } }, null, 2));
writeFileSync(join(profile, "social.json"), JSON.stringify({ discord: false, dailyBand: band, posted: [] }, null, 2));
writeFileSync(join(out, "draw.json"), JSON.stringify({ number: draw.number, today: dailyNumberAt(now), band, scenarios: draw.scenarios, pending: [r2.file, r3.file] }, null, 2));
console.log(`stats   ${stats} (${summary.files} runs)`);
console.log(`daily   #${draw.number} band ${band}: ${draw.scenarios.join(" | ")}`);
