/**
 * The Ghost Mode screens the video films, drawn by the real core over a real library and
 * frozen into tools/video/ghost.json.
 *
 *   npx tsx tools/video/ghostDemo.ts [--at 2026-09-30T19:00] [--stats <folder>]
 *
 * Frozen and committed, unlike tools/ghostUiFixture.ts's output, for the reason the
 * trailer uses the committed snapshot: `npm run video` has to film the same thing on any
 * machine and on any day, and a draw is a function of the day it is made on. Re-run this
 * only to change what the ghost scene shows.
 *
 * Every number on the screens comes from `drawGhostMatch`, `applyRun`, `viewOf` and
 * `judge`. Only the three live scores are chosen, as offsets from each ghost in units of
 * its baseline, so the race is the one the mechanics doc's video beats describe: ahead,
 * then behind going into the last lane, then the last lane flips it. A draw on the day
 * would show whatever the day held, which is honest in the fixture and a flat trailer.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyRun,
  availableKinds,
  drawGhostMatch,
  GHOST_KINDS,
  inTen,
  KIND_NAME,
  MEASURED_WIN_RATE,
  startMatch,
  viewOf,
  type GhostMatch,
} from "../../src/core/ghost/ghost.ts";
import { scanStatsFolder } from "../../src/core/history/history.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = arg("stats") ?? "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";
const now = new Date(arg("at") ?? "2026-09-30T19:00:00");
const KIND = "month_ago" as const;
/**
 * Live minus ghost, as a share of the baseline, per round in play order. Round two is
 * lost by more than round one is won, so the running margin goes into the last lane
 * negative and inside a percent; round three turns it.
 */
const GAPS = [0.026, -0.038, 0.03];

const history = scanStatsFolder(dir);
if (history.size === 0) {
  console.error(`no runs in ${dir}: the ghost has to be drawn from a real library`);
  process.exit(1);
}

const kinds = availableKinds(history, now);
// The chooser's questions, as the app's GhostService words them.
const QUESTION = { month_ago: "Have I improved?", last_week: "Am I still improving?", last_week_best: "Can I beat my good day?" };
const kindViews = GHOST_KINDS.map((k) => ({ ...kinds[k], name: KIND_NAME[k], question: QUESTION[k], inTen: inTen(MEASURED_WIN_RATE[k]) }));

const drawn = drawGhostMatch(history, now, KIND, 0);
if (!drawn) {
  console.error(`no ${KIND} ghost on this folder as of ${now.toISOString()}`);
  process.exit(1);
}

// Four minutes in when the first run lands: long enough that the ranked clock is visibly
// running, short enough that it is nowhere near out.
const t0 = now.getTime() - 4 * 60_000;
let match: GhostMatch = startMatch(drawn, t0);
const landed: GhostMatch[] = [];
GAPS.forEach((gap, i) => {
  const r = match.rounds[i];
  const out = applyRun(match, { scenario: r.scenario, score: Math.round(r.ghost + gap * r.baseline), at: t0 + (i + 1) * 75_000, durationSeconds: 60, abandoned: false });
  if (!out.accepted) throw new Error(`round ${i + 1} was refused: ${JSON.stringify(out)}`);
  match = out.match;
  landed.push(match);
});
const done = landed[2];
if (!done.result || done.result.verdict !== "win") throw new Error(`the demo race has to end in a win, got ${done.result?.verdict}`);

// A player a week into the habit: the streak and record are what the chooser and the
// result screen show beside the race, and a zero on both reads as a broken counter.
const base = (active: GhostMatch | null, clock: number, extra: Record<string, unknown> = {}) => ({
  signedIn: false,
  hasFolder: true,
  kinds: kindViews,
  defaultKind: "last_week",
  active: active ? viewOf(active) : null,
  last: null,
  streak: 3,
  record: { wins: 5, losses: 2, played: 7 },
  notice: null,
  share: { enabled: false, reason: "", card: null, busy: false },
  now: clock,
  ...extra,
});

const screens = {
  about: `Drawn by tools/video/ghostDemo.ts on a real stats folder as of ${now.toISOString()}; live scores chosen as gaps ${GAPS.join(", ")} of baseline.`,
  choose: base(null, t0),
  ready: base(drawn, t0),
  started: base(startMatch(drawn, t0), t0 + 30_000),
  one: base(landed[0], t0 + 80_000),
  two: base(landed[1], t0 + 155_000),
  result: base(done, t0 + 230_000, { streak: 4, record: { wins: 6, losses: 2, played: 8 }, last: { ...done.result, id: done.id, kind: done.kind, streak: 4 } }),
};

const out = new URL("./ghost.json", import.meta.url);
writeFileSync(out, JSON.stringify(screens, null, 2) + "\n");
const margins = landed.map((m) => viewOf(m).runningMargin ?? 0).map((v) => (v * 100).toFixed(2) + "%");
console.log(`wrote ${fileURLToPath(out)}: ${drawn.rounds.map((r) => r.scenario).join(" / ")}; running margin ${margins.join(" → ")}; ${done.result.verdict}`);
