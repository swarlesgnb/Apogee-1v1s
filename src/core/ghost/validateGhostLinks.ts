/**
 * Validate ghost links against the real stats folder.
 *
 * A ghost link lets anybody with a card's code race the sender's three live runs, each side
 * measured against its own baseline (core/ghost/links.ts). This checks, through the code
 * the app and the Edge Function run:
 *
 *   - the lookup's shape: exactly the keys a recipient needs, and no player id, Steam id
 *     or run id anywhere in what is sent, from a row carrying all three;
 *   - code refusals: malformed, unknown and the caller's own, each with its status, and
 *     the client's shape check refusing an answer with an extra or broken field;
 *   - own-baseline scoring, replayed over the corpus: every play day's real match is sent
 *     as a link (built the way post-ghost stores a card), and raced by the same library
 *     as of 60 days earlier, a player with a different, shorter history. Every round's gap
 *     must equal the two deltas differenced, computed independently here; and there must
 *     be real rounds where the recipient scored more and lost it, and less and won it,
 *     each settled the way the deltas say, or the check would be unable to tell raw scores
 *     from deltas;
 *   - the no-baseline rule: rounds the recipient has no baseline on are played and never
 *     scored, a match with two measured rounds is decided by those two, and one with fewer
 *     is practice and ends void however it ends;
 *   - rating and quest isolation: ghost-link writes nothing and touches no rating table,
 *     and a friend's win pays beat_ghost and never ranked_play, weekly_wins or the streak.
 *
 * Every count it relies on has to be above zero, so an empty or moved folder fails.
 *
 *   npx tsx src/core/ghost/validateGhostLinks.ts [statsFolder]
 */

import { readFileSync } from "node:fs";

import { baselineFromScores, MIN_RUNS_FOR_BASELINE } from "../history/baseline.ts";
import { scanStatsFolder, type ScenarioHistory } from "../history/history.ts";
import { dayKey } from "../quests/progression.ts";
import { measure, recordGhost, emptyQuestState, type IssuedQuest } from "../quests/board.ts";
import {
  abandonMatch,
  applyRun,
  drawSeed,
  expireIfLate,
  ghostCandidates,
  GHOST_ROUNDS,
  judge,
  MIN_MEASURED_ROUNDS,
  pickRounds,
  startMatch,
  startOfLocalDay,
  viewOf,
  type GhostMatch,
  type GhostResult,
} from "./ghost.ts";
import {
  friendMatch,
  GHOST_LINK_COLUMNS,
  GHOST_LINK_KEYS,
  GHOST_LINK_ROUND_KEYS,
  isGhostLink,
  LINK_REFUSAL,
  linkFromRow,
  linkOf,
  normaliseLinkCode,
  type GhostLink,
  type GhostLinkRow,
} from "./links.ts";

const DEFAULT_STATS_DIR = "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

/** Fewer replayed links than this and the folder is empty, moved or not the corpus. */
const MIN_LINKS = 100;
/** How much earlier the recipient's library is read: long enough to differ, short enough to overlap. */
const RECIPIENT_LAG_DAYS = 60;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
const history = scanStatsFolder(dir);

// ---------------------------------------------------------------------------
console.log("── the corpus ───────────────────────────────────");

let runs = 0;
const dayFirst = new Map<string, { start: Date; first: Map<string, number> }>();
for (const [name, h] of history) {
  runs += h.runs.length;
  for (const r of h.runs) {
    if (!r.playedAt) continue;
    const k = dayKey(r.playedAt);
    let e = dayFirst.get(k);
    if (!e) dayFirst.set(k, (e = { start: startOfLocalDay(r.playedAt), first: new Map() }));
    if (!e.first.has(name)) e.first.set(name, r.score);
  }
}
const days = [...dayFirst.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
console.log(`       read ${dir}`);
console.log(`       ${runs} runs on ${history.size} scenarios over ${days.length} play days`);
check("the stats folder has runs in it", runs > 0, `${runs}`);
check("and play days to replay", days.length > 0, `${days.length}`);

// ---------------------------------------------------------------------------
console.log("\n── the lookup sends what a race needs, and nothing else ──");

const SENDER_ID = "7d8a1f2e-4b3c-4d5e-8f90-a1b2c3d4e5f6";
const SENDER_STEAM = "76561199000000042";
const RUN_IDS = ["0b6c1a52-7f1d-4a3c-9d8e-1f2a3b4c5d6e", "1c7d2b63-8a2e-4b4d-8e9f-2a3b4c5d6e7f", "2d8e3c74-9b3f-4c5e-9fa0-3b4c5d6e7f80"];
const CALLER_ID = "9e0f1a2b-3c4d-4e5f-a6b7-c8d9e0f1a2b3";

/** A ghost_results row with every identifying column filled, the way a careless select would return it. */
function fullRow(over: Partial<GhostLinkRow> = {}): GhostLinkRow & Record<string, unknown> {
  return {
    id: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c",
    code: "ABCD2345",
    player_id: SENDER_ID,
    steam_id: SENDER_STEAM,
    live_run_ids: RUN_IDS,
    kind: "last_week",
    scenario_names: ["1wall6targets TE", "Pasu Voltaic Easy", "Air Angelic 4 Voltaic"],
    live_scores: ["1034", 812.5, "2201.25"],
    ghost_scores: [1000, 800, 2100],
    baselines: ["990.5", 790, 2150],
    pbs: [1200, 900, 2500],
    verdict: "win",
    margin: 0.021,
    tz_offset_minutes: 360,
    time_zone: "America/Chicago",
    ...over,
  };
}

const answer = linkFromRow(fullRow(), CALLER_ID, "  Sam  ");
check("a stranger's code is answered", answer.ok);
if (answer.ok) {
  const sent = JSON.stringify(answer.link);
  check("with exactly the link's keys", Object.keys(answer.link).sort().join() === GHOST_LINK_KEYS.join(), Object.keys(answer.link).sort().join());
  check("and each round with exactly scenario, score, baseline",
    answer.link.rounds.every((r) => Object.keys(r).sort().join() === GHOST_LINK_ROUND_KEYS.join()));
  check("no player id in what is sent", !sent.includes(SENDER_ID));
  check("no Steam id", !sent.includes(SENDER_STEAM));
  check("no run id", RUN_IDS.every((id) => !sent.includes(id)));
  check("no time zone, verdict, margin, PB or ghost score", !/America|Chicago|"win"|0\.021|1200|2100/.test(sent), sent);
  check("scores and baselines arrive as numbers, whatever Postgres sent",
    answer.link.rounds.every((r) => typeof r.score === "number" && typeof r.baseline === "number") &&
      answer.link.rounds[0].score === 1034 && answer.link.rounds[0].baseline === 990.5);
  check("the sender's name is trimmed", answer.link.sender === "Sam", JSON.stringify(answer.link.sender));
  check("and the client accepts it", isGhostLink(answer.link));
}
const longName = linkFromRow(fullRow(), CALLER_ID, "x".repeat(200));
check("a long display name is cut", longName.ok && longName.link.sender.length === 32);
const noName = linkFromRow(fullRow(), CALLER_ID, null);
check("a missing one reads 'A player'", noName.ok && noName.link.sender === "A player");

// The select the function runs names no identifying column but player_id, which it needs
// for the own-code refusal and never sends.
const selected = GHOST_LINK_COLUMNS.split(",").map((c) => c.trim());
check("the function selects only what the link and the own-code check need",
  selected.sort().join() === ["baselines", "code", "live_scores", "player_id", "scenario_names"].join(), selected.join(", "));

// ---------------------------------------------------------------------------
console.log("\n── codes that must be refused ───────────────────");

for (const [raw, why] of [
  ["", "empty"],
  ["ABC2345", "seven characters"],
  ["ABCD23456", "nine"],
  ["ABCD234O", "an O"],
  ["ABCD2340", "a zero"],
  ["ABCD234I", "an I"],
  ["ABCD234L", "an L"],
  ["ABCD2341", "a one"],
  ["ABCD 23!5", "punctuation"],
  [12345678, "a number, not a string"],
  [null, "nothing"],
] as [unknown, string][]) {
  check(`malformed: ${why}`, normaliseLinkCode(raw) === null, JSON.stringify(raw));
}
check("a code typed in lower case, with a dash and spaces, is the same code",
  normaliseLinkCode(" abcd-2345 ") === "ABCD2345" && normaliseLinkCode("abcd 2345") === "ABCD2345");
check("malformed is a 400", LINK_REFUSAL.malformed.status === 400);

const unknown = linkFromRow(null, CALLER_ID, null);
check("an unknown code is refused as unknown, 404", !unknown.ok && unknown.refusal === "unknown" && unknown.status === 404);
// isNotDeployed in src/app/api.ts tells this 404 from the gateway's by the phrase.
check("in words the client can tell from a function that is not deployed", !unknown.ok && /no ghost card/i.test(unknown.message), !unknown.ok ? unknown.message : "");

const own = linkFromRow(fullRow(), SENDER_ID, "Sam");
check("the caller's own code is refused, 409", !own.ok && own.refusal === "own" && own.status === 409);
check("and the refusal names nobody", !own.ok && !own.message.includes("Sam") && !own.message.includes(SENDER_ID));

check("a row with two rounds is unusable", !linkFromRow(fullRow({ scenario_names: ["a", "b"] }), CALLER_ID, "Sam").ok);
check("so is one with a zero baseline", !linkFromRow(fullRow({ baselines: [0, 790, 2150] }), CALLER_ID, "Sam").ok);
check("or a score that is not a number", !linkFromRow(fullRow({ live_scores: ["x", 1, 2] }), CALLER_ID, "Sam").ok);

if (answer.ok) {
  const good = answer.link;
  check("the client refuses an answer carrying a player id", !isGhostLink({ ...good, playerId: SENDER_ID }));
  check("or a round carrying one", !isGhostLink({ ...good, rounds: good.rounds.map((r, i) => (i ? r : { ...r, runId: RUN_IDS[0] })) }));
  check("or two rounds", !isGhostLink({ ...good, rounds: good.rounds.slice(0, 2) }));
  check("or the same scenario twice", !isGhostLink({ ...good, rounds: [good.rounds[0], good.rounds[0], good.rounds[1]] }));
  check("or a baseline of zero", !isGhostLink({ ...good, rounds: good.rounds.map((r, i) => (i ? r : { ...r, baseline: 0 })) }));
  check("or a malformed code", !isGhostLink({ ...good, code: "abcd2345" }));
  check("or nothing at all", !isGhostLink(null) && !isGhostLink({}) && !isGhostLink([]));
}

// ---------------------------------------------------------------------------
console.log("\n── each side against its own baseline, replayed ─");

const DAY_MS = 86_400_000;
const recipientScore = (scenario: string, from: number): number | null => {
  // The recipient's first run on the scenario from their race day on, if they ever played it.
  const h = history.get(scenario);
  const r = h?.runs.find((x) => x.playedAt && x.playedAt.getTime() >= from);
  return r ? r.score : null;
};

/** Race a link as the library stood `lagDays` before, landing the given scores. */
function race(link: GhostLink, at: Date, scores: (number | null)[]): { match: GhostMatch; result: GhostResult } {
  let m = friendMatch(history, at, link);
  const t0 = at.getTime();
  m = startMatch(m, t0);
  m.rounds.forEach((r, i) => {
    const out = applyRun(m, { scenario: r.scenario, score: scores[i] ?? r.ghost, at: t0 + (i + 1) * 90_000, durationSeconds: 60, abandoned: false });
    if (!out.accepted) throw new Error(`run refused: ${out.reason}`);
    m = out.match;
  });
  return { match: m, result: m.result! };
}

let links = 0;
let rounds = 0;
let measuredRounds = 0;
let unmeasured = 0;
let gapMismatch = 0;
let unmeasuredScored = 0;
let raisedBaseline = 0;
let higherButLost = 0;
let lowerButWon = 0;
let deltaVerdictMismatch = 0;
let practice = 0;
let practiceNotVoid = 0;
let twoMeasured = 0;
let twoMeasuredWrong = 0;
let frozenMoved = 0;
let baselineMismatch = 0;
let differentBaselines = 0;
const EPS = 1e-12;

for (const d of days) {
  // The sender: that day's real match, drawn by the app's own seeded pick from the
  // scenarios touched that day, live side the first run on each.
  const touched = new Map<string, ScenarioHistory>();
  for (const name of d.first.keys()) touched.set(name, history.get(name)!);
  const picked = pickRounds(ghostCandidates(touched, d.start, "last_week"), d.start, drawSeed(dayKey(d.start), "links", 0));
  if (picked.length < GHOST_ROUNDS) continue;
  const senderMatch: GhostMatch = {
    id: "sender", kind: "last_week", day: dayKey(d.start), ordinal: 0, drawnAt: d.start.getTime(), startedAt: d.start.getTime(), deadline: null,
    rounds: picked.map(({ lastPlayed: _l, ...r }) => ({ ...r, live: { score: d.first.get(r.scenario)!, at: 0, abandoned: false } })),
    result: null,
  };
  const sent = judge(senderMatch, "complete", d.start.getTime());
  if (sent.verdict === "void") continue;

  // Stored the way post-ghost stores a card, looked up the way ghost-link answers.
  const row: GhostLinkRow = {
    code: "ABCD2345",
    player_id: SENDER_ID,
    scenario_names: sent.rounds.map((r) => r.scenario),
    live_scores: sent.rounds.map((r) => String(r.live)),
    baselines: sent.rounds.map((r) => String(r.baseline)),
  };
  const looked = linkFromRow(row, CALLER_ID, "Sender");
  if (!looked.ok || !isGhostLink(looked.link)) {
    check(`the link for ${dayKey(d.start)} is answered and accepted`, false);
    continue;
  }
  const link = looked.link;

  // The recipient: this library 60 days earlier, a player with a different history.
  const raceDay = new Date(d.start.getTime() - RECIPIENT_LAG_DAYS * DAY_MS);
  raceDay.setHours(20, 0, 0, 0);
  const frozen = startOfLocalDay(raceDay).getTime();
  const scores = link.rounds.map((r) => recipientScore(r.scenario, frozen));
  const { match, result } = race(link, raceDay, scores);
  links++;

  // Frozen at midnight: the same link raced at 00:01 and at 23:00 of that day has the same bar.
  const early = friendMatch(history, new Date(frozen + 60_000), link);
  if (early.rounds.some((r, i) => r.baseline !== match.rounds[i].baseline)) frozenMoved++;

  match.rounds.forEach((r, i) => {
    rounds++;
    const before = (history.get(r.scenario)?.runs ?? []).filter((x) => x.playedAt && x.playedAt.getTime() < frozen).map((x) => x.score);
    const expected = before.length >= MIN_RUNS_FOR_BASELINE ? baselineFromScores(r.scenario, before).value : 0;
    if (Math.abs(expected - r.baseline) > EPS) baselineMismatch++;
    const out = result.rounds[i];
    if (r.measured === false) {
      unmeasured++;
      if (out.gap !== null || out.delta !== null || out.measured) unmeasuredScored++;
      return;
    }
    measuredRounds++;
    if (Math.abs(r.baseline - link.rounds[i].baseline) > EPS) differentBaselines++;
    // The round's verdict, computed here from nothing but the four numbers.
    const mine = (out.live! - r.baseline) / r.baseline;
    const theirs = (link.rounds[i].score - link.rounds[i].baseline) / link.rounds[i].baseline;
    if (out.gap === null || Math.abs(out.gap - (mine - theirs)) > 1e-9) gapMismatch++;
    if (r.baseline > link.rounds[i].baseline) raisedBaseline++;
    if (out.live! > link.rounds[i].score && mine < theirs) higherButLost++;
    if (out.live! < link.rounds[i].score && mine > theirs) lowerButWon++;
  });

  const measured = match.rounds.filter((r) => r.measured !== false).length;
  if (measured < MIN_MEASURED_ROUNDS) {
    practice++;
    if (result.verdict !== "void" || result.margin !== null || !/^Practice/.test(result.explanation)) practiceNotVoid++;
  } else {
    const gaps = result.rounds.filter((r) => r.measured).map((r) => r.gap!);
    const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
    const expectVerdict = Math.abs(mean) < 0.0005 ? "draw" : mean > 0 ? "win" : "loss";
    if (result.verdict !== expectVerdict || Math.abs((result.margin ?? NaN) - mean) > 1e-9) deltaVerdictMismatch++;
    if (measured === 2) {
      twoMeasured++;
      if (gaps.length !== 2 || result.verdict === "void") twoMeasuredWrong++;
    }
  }
}

console.log(`       ${links} links raced by the library as of ${RECIPIENT_LAG_DAYS} days earlier: ${rounds} rounds, ` +
  `${measuredRounds} measured, ${unmeasured} with no recipient baseline`);
console.log(`       measured rounds where the recipient's baseline was the higher: ${raisedBaseline}; ` +
  `where the two baselines differ at all: ${differentBaselines}`);
console.log(`       scored more and lost the round: ${higherButLost}; scored less and won it: ${lowerButWon}`);
console.log(`       practice races (fewer than ${MIN_MEASURED_ROUNDS} measured): ${practice}; decided on exactly two: ${twoMeasured}`);

check(`${MIN_LINKS}+ real links replayed`, links >= MIN_LINKS, `${links}`);
check("the recipient's baseline is rebuilt from their own runs before midnight, every round", rounds > 0 && baselineMismatch === 0, `${baselineMismatch} of ${rounds} differ`);
check("and it is not the sender's", differentBaselines > 0, `${differentBaselines} of ${measuredRounds} measured rounds`);
check("frozen at midnight: racing later that day does not move it", links > 0 && frozenMoved === 0, `${frozenMoved} moved`);
check("every measured round is the recipient's delta minus the sender's", measuredRounds > 0 && gapMismatch === 0, `${gapMismatch} of ${measuredRounds} differ`);
check("the match is the mean of the measured rounds, settled like ranked", deltaVerdictMismatch === 0, `${deltaVerdictMismatch} mismatches`);
check("real rounds exist where more raw score lost, so raw scores are provably not what decides",
  higherButLost > 0 && lowerButWon > 0, `${higherButLost} / ${lowerButWon}`);

// ---------------------------------------------------------------------------
console.log("\n── no baseline yet ──────────────────────────────");

check("the replay met rounds with no recipient baseline", unmeasured > 0, `${unmeasured}`);
check("none of them was scored", unmeasuredScored === 0, `${unmeasuredScored} scored`);
check("the replay met practice races", practice > 0, `${practice}`);
check("every practice race ended void, with no margin, and said why", practiceNotVoid === 0, `${practiceNotVoid} did not`);
check("the replay met races decided on exactly two rounds", twoMeasured > 0, `${twoMeasured}`);
check("and each was decided on those two", twoMeasuredWrong === 0, `${twoMeasuredWrong} were not`);

// A recipient with no history at all: all three unmeasured, whatever they score.
const sample = days.length ? linkFromRow({
  code: "ABCD2345", player_id: SENDER_ID,
  scenario_names: [...history.keys()].slice(0, 3),
  live_scores: [100, 200, 300], baselines: [100, 200, 300],
}, CALLER_ID, "Sam") : null;
if (sample?.ok) {
  const nobody = friendMatch(new Map(), new Date(), sample.link);
  check("a recipient with no history has no measured round", nobody.rounds.every((r) => r.measured === false));
  const view = viewOf(nobody);
  check("and the screen is told it is practice, with no baseline to draw", view.link?.practice === true && view.rounds.every((r) => r.baseline === null));
  const t0 = Date.now();
  let m = startMatch(nobody, t0);
  // Ten times the sender's score on every round: a raw comparison would call this a rout.
  for (const [i, r] of m.rounds.entries()) m = applyRun(m, { scenario: r.scenario, score: r.ghost * 10, at: t0 + (i + 1) * 60_000, durationSeconds: 50, abandoned: false }).match;
  check("ten times the sender's raw score is still no result", m.result?.verdict === "void" && m.result.margin === null, m.result?.verdict);
  const left = abandonMatch(startMatch(nobody, t0), t0 + 60_000);
  check("abandoning a practice race is void, not a loss", left?.result?.verdict === "void", left?.result?.verdict);
  const late = expireIfLate(startMatch(nobody, t0), t0 + 60 * 60_000);
  check("and so is running out of time on one", late.result?.verdict === "void", late.result?.verdict);
  // A measured friend race abandoned is a loss, as a past-self one is: the door abandoning must not open.
  const measuredMatch = friendMatch(history, new Date(), sample.link);
  if (measuredMatch.rounds.filter((r) => r.measured !== false).length >= MIN_MEASURED_ROUNDS) {
    const quit = abandonMatch(startMatch(measuredMatch, t0), t0 + 60_000);
    check("abandoning a race that could have a result is a loss", quit?.result?.verdict === "loss", quit?.result?.verdict);
  }
  const back = linkOf(nobody);
  check("a friend match gives back the link it was built from, for a rematch",
    !!back && JSON.stringify(back) === JSON.stringify(sample.link));
  check("and a rematch is a new id, so its result is booked", friendMatch(new Map(), new Date(Date.now() + 1), sample.link).id !== nobody.id);
} else check("a sample link could be built from this library", false);

// ---------------------------------------------------------------------------
console.log("\n── nothing rated, nothing ranked ────────────────");

const fnSource = readFileSync(new URL("../../../supabase/functions/ghost-link/index.ts", import.meta.url), "utf8");
const code = fnSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check("ghost-link writes nothing", !/\.(insert|update|upsert|delete|rpc)\(/.test(code.replace(/enforceRateLimit\([^)]*\)/, "")),
  (code.match(/\.(insert|update|upsert|delete|rpc)\(/g) ?? []).join(", ") || "no writes");
const tables = [...code.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
check("and reads only ghost_results and players", tables.length > 0 && tables.every((t) => t === "ghost_results" || t === "players"), tables.join(", "));
check("no rating table is named in it", !/ratings|match_sides|verified_pbs|"matches"|"baselines"/.test(code));
const answers = [...code.matchAll(/json\(([^)]*)\)/g)].map((m) => m[1].trim());
check("it answers with the core's link and nothing built there", answers.length === 1 && answers[0] === "answer.link", answers.join(" | "));
check("it is rate limited under its own name", /enforceRateLimit\(admin, caller\.playerId, "ghost-link"\)/.test(code));
check("and refuses a malformed code before it queries", code.indexOf("normaliseLinkCode") < code.indexOf(".from("));

// The quest board: a friend's win is a ghost, never a match.
const now = new Date();
const since = startOfLocalDay(now);
const quest = (kind: IssuedQuest["kind"], unit: IssuedQuest["unit"]): IssuedQuest => ({
  id: kind, slot: "variety", kind, title: kind, detail: kind, xp: 1, target: 1, unit, params: {},
  since: since.toISOString(), until: new Date(since.getTime() + 7 * DAY_MS).toISOString(), progress: 0, completedAt: null,
});
const ctx = { history, now } as unknown as Parameters<typeof measure>[1];
const at = new Date(since.getTime() + 60_000).toISOString();
const won = recordGhost(emptyQuestState(), { id: "friend-1", at, kind: "friend", verdict: "win" });
check("a friend's win lands in ghosts, not matches", won.ghosts.length === 1 && won.matches.length === 0);
check("it pays beat_ghost", measure(quest("beat_ghost", "ghosts"), ctx, won.matches, won.ghosts) === 1);
check("and not ranked_play", measure(quest("ranked_play", "matches"), ctx, won.matches, won.ghosts) === 0);
check("and not weekly_wins", measure(quest("weekly_wins", "wins"), ctx, won.matches, won.ghosts) === 0);

// The streak: ghostService books a win day only for a past self. It needs Electron to run,
// so its source is held to the guard instead.
const service = readFileSync(new URL("../../app/ghostService.ts", import.meta.url), "utf8");
check("the ghost streak's win days are booked only for a past self",
  /if \(match\.kind !== "friend"\) \{\s*if \(match\.result\.verdict === "win"\) s\.winDays/.test(service));
check("and a friend race is never posted for a card", /s\.active\.kind === "friend"\) shareReason/.test(service));

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: ghost links validated against the real stats folder");
