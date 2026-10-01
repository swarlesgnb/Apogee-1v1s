/**
 * The screens Ghost Mode draws, built by the real core over the real stats folder, for
 * tools/ghostUi.cjs to render and photograph.
 *
 * Built here rather than by GhostService because the service persists through Electron's
 * `app`, and the screens are what is being looked at, not the store. Every number on them
 * comes from `drawGhostMatch`, `applyRun` and `viewOf` on a real draw; only the live
 * scores are chosen, so the pictures show a close race rather than whatever the day held.
 *
 *   npx tsx tools/ghostUiFixture.ts [statsFolder]
 */

import { mkdirSync, writeFileSync } from "node:fs";

import {
  applyRun,
  availableKinds,
  defaultKind,
  drawGhostMatch,
  GHOST_KINDS,
  inTen,
  KIND_NAME,
  MEASURED_WIN_RATE,
  startMatch,
  viewOf,
  type GhostMatch,
} from "../src/core/ghost/ghost.ts";
import { scanStatsFolder } from "../src/core/history/history.ts";
import { friendMatch } from "../src/core/ghost/links.ts";

const dir = process.argv[2] ?? "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";
const history = scanStatsFolder(dir);
if (history.size === 0) {
  console.error(`no runs in ${dir}: the fixture has to be drawn from a real library`);
  process.exit(1);
}

const now = new Date();
const kinds = availableKinds(history, now);
const QUESTION = { month_ago: "Have I improved?", last_week: "Am I still improving?", last_week_best: "Can I beat my good day?" };
const kindViews = GHOST_KINDS.map((k) => ({ ...kinds[k], name: KIND_NAME[k], question: QUESTION[k], inTen: inTen(MEASURED_WIN_RATE[k]) }));

const drawn = drawGhostMatch(history, now, "last_week", 0);
if (!drawn) {
  console.error("no last_week ghost on this folder today");
  process.exit(1);
}

const t0 = now.getTime() - 4 * 60_000;
const land = (m: GhostMatch, i: number, factor: number, offset: number) =>
  applyRun(m, { scenario: m.rounds[i].scenario, score: Math.round(m.rounds[i].ghost + factor * m.rounds[i].baseline), at: t0 + offset, durationSeconds: 60, abandoned: false }).match;

const started = startMatch(drawn, t0);
const one = land(started, 0, 0.038, 75_000);
const two = land(one, 2, -0.012, 150_000);
const done = land(two, 1, 0.021, 225_000);

const base = (active: GhostMatch | null, extra: Record<string, unknown> = {}) => ({
  signedIn: false,
  hasFolder: true,
  kinds: kindViews,
  defaultKind: defaultKind(kinds, true),
  active: active ? viewOf(active) : null,
  last: null,
  streak: 3,
  record: { wins: 5, losses: 2, played: 7 },
  notice: null,
  share: { enabled: false, reason: "Sign in with Steam to share: the server checks the runs before it makes a card.", card: null, busy: false },
  links: { enabled: false, reason: "Sign in with Steam to race a friend's ghost.", busy: false },
  now: now.getTime() - 90_000,
  ...extra,
});

const link = { code: "ABCD2345", sender: "A friend", rounds: drawn.rounds.map(r => ({ scenario: r.scenario, score: r.ghost, baseline: r.baseline * 0.9 })) };
const friend = friendMatch(history, now, link);
const practiceFriend = startMatch(friendMatch(new Map(), now, link), t0);
const screens = {
  choose: base(null),
  firstChoose: base(null, { defaultKind: defaultKind(kinds, false), streak: 0, record: { wins: 0, losses: 0, played: 0 } }),
  ready: base(drawn),
  linkChoose: base(null, { signedIn: true, links: { enabled: true, reason: null, busy: false } }),
  friendReady: base(friend),
  friendPractice: base(practiceFriend),
  live: base(one),
  liveTwo: base(two, { notice: `${two.rounds[0].scenario} already counted. First run per scenario only; this one was practice.` }),
  result: base(done, { streak: 4, record: { wins: 6, losses: 2, played: 8 }, last: { ...done.result, id: done.id, kind: done.kind, streak: 4 } }),
};

mkdirSync(".cache/ghost", { recursive: true });
writeFileSync(".cache/ghost/screens.json", JSON.stringify(screens, null, 2));
console.log(`wrote .cache/ghost/screens.json: ${drawn.rounds.map((r) => r.scenario).join(" / ")}; result ${done.result?.verdict} ${((done.result?.margin ?? 0) * 100).toFixed(1)}%`);
