/**
 * Validate the live race rules: the sealed reveal of raw scores, the tug-of-war tally, the
 * race result on rounds, and the views.
 *
 *   npx tsx src/core/race/validateRace.ts
 *
 * The property that matters most is a negative one, so it is checked by search rather than
 * by example: across every combination of which rounds each side has landed, no number of
 * the other side's ever reaches a viewer for a round the viewer has not landed. A view that
 * leaked would pass every example that happened not to probe it.
 */

import {
  legFinished,
  raceTally,
  raceVerdict,
  RACE_INVITE_TTL_MS,
  revealed,
  sealView,
  verdictFor,
  type FinalLeg,
  type LiveRound,
  type LiveSide,
} from "./race.ts";
import { buildRaceBoard, effectiveRaceStatus, liveStatus, raceRowFromDb, summarise, type RaceRow } from "./view.ts";
import { roundTally, settleMatch, type RoundSubmission } from "../match/settle.ts";
import { seededRandom } from "../match/scenarioSelection.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const SCEN = ["Smoothbot Intermediate", "waldoTS Intermediate", "Air Voltaic Intermediate"];
function side(name: string, landed: boolean[], scores: number[], terminal = false, counted = [true, true, true]): LiveSide {
  const rounds: LiveRound[] = landed.map((l, i) => ({
    scenarioId: i + 1,
    scenario: SCEN[i],
    landed: l,
    score: l && counted[i] ? scores[i] : null,
    delta: l && counted[i] ? scores[i] / 1000 - 1 : null,
    counted: l && counted[i],
    provisional: false,
    tier: l ? (counted[i] ? "consistent" : "rejected") : null,
  }));
  return { name, rounds, terminal, void: false };
}

/* ------------------------------------------------------------------------------- */
console.log("\n── sealed rounds ────────────────────────────────");
{
  const them = side("Kestrel", [true, true, true], [1031, 988, 1044], true);
  const fresh = sealView(side("me", [false, false, false], [0, 0, 0]), them);
  check("before your first run lands, nothing of theirs is shown", fresh.rounds.every((r) => r.them.score === null && r.them.sealed));
  check("you can see that they have landed, never what they scored", fresh.them.landed === 3);
  check("no round decided yet", fresh.tally.won + fresh.tally.lost + fresh.tally.tied === 0);

  const one = sealView(side("me", [true, false, false], [1020, 0, 0]), them);
  check("your round 1 lands: their round 1 raw score opens", one.rounds[0].them.score === 1031 && !one.rounds[0].them.sealed);
  check("rounds 2 and 3 stay sealed", one.rounds[1].them.sealed && one.rounds[2].them.sealed && one.rounds[1].them.score === null);
  check("round 1 is decided on raw score, and is the whole tally", one.rounds[0].result === "lost" && one.tally.lost === 1 && one.tally.won === 0);
  check("your own delta still shows, as information", Math.abs((one.rounds[0].you.delta ?? 0) - 0.02) < 1e-12 && one.rounds[0].you.score === 1020);

  const outOfOrder = sealView(side("me", [false, false, true], [0, 0, 1050]), them);
  check("rounds open in whatever order you play them", outOfOrder.rounds[2].them.score === 1044 && outOfOrder.rounds[0].them.sealed && outOfOrder.rounds[2].result === "won");

  const tie = sealView(side("me", [true, false, false], [1031, 0, 0]), them);
  check("an equal raw score is a tied round", tie.rounds[0].result === "tied" && tie.tally.tied === 1);

  const done = sealView(side("me", [true, true, true], [1020, 1010, 1000], true), them);
  check("once your match ends you see all of theirs", done.rounds.every((r) => !r.them.sealed && r.them.score != null));
  check("and the tally is every round", done.tally.won === 1 && done.tally.lost === 2 && done.tally.tied === 0);

  const rejected = sealView(side("me", [true, false, false], [1020, 0, 0], false, [false, true, true]), them);
  check("your rejected run still opens their round (it landed and cannot be replayed)", rejected.rounds[0].them.score === 1031);
  check("but a round you did not count is not decided", rejected.rounds[0].result === null && rejected.tally.lost === 0);

  const theirRejected = sealView(side("me", [true, false, false], [1020, 0, 0]), side("K", [true, false, false], [5000, 0, 0], false, [false, true, true]));
  check("their rejected run shows as not counted, with no number", theirRejected.rounds[0].them.counted === false && theirRejected.rounds[0].them.score === null);

  // The search: every landed/terminal combination on both sides.
  let leaks = 0;
  let cases = 0;
  const secret = [1111.5, 2222.5, 3333.5];
  for (let mine = 0; mine < 8; mine++) for (let theirs = 0; theirs < 8; theirs++) for (const myDone of [false, true]) for (const theirDone of [false, true]) {
    const mask = (m: number) => [0, 1, 2].map((i) => !!(m & (1 << i)));
    if (myDone && mine !== 7) continue;
    const viewer = side("me", mask(mine), [1010, 1020, 1030], myDone);
    const opp = side("them", mask(theirs), secret, theirDone && theirs === 7);
    const view = sealView(viewer, opp);
    cases++;
    const text = JSON.stringify(view);
    for (let i = 0; i < 3; i++) {
      if (!revealed(viewer, i) && (view.rounds[i].them.score !== null || view.rounds[i].result !== null || text.includes(String(secret[i])))) leaks++;
    }
  }
  check(`no sealed number reaches the viewer in any of ${cases} landing combinations`, leaks === 0, `${leaks} leaks`);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the race result ──────────────────────────────");
{
  const leg = (scores: number[] | null, tiers = ["consistent", "verified", "consistent"] as FinalLeg["tiers"], status: FinalLeg["status"] = "settled"): FinalLeg =>
    ({ status, scores, tiers, scenarios: 3 });
  check("more rounds won wins", raceVerdict(leg([2, 2, 1]), leg([1, 1, 2])).result === "inviter" && raceVerdict(leg([1, 1, 2]), leg([2, 2, 1])).result === "invitee");
  check("the margin does not matter, only the count", raceVerdict(leg([9000, 1, 1]), leg([2, 2, 2])).result === "invitee");
  const level = raceVerdict(leg([2, 1, 5]), leg([1, 2, 5]));
  check("equal rounds is a draw (1-1 with one level)", level.result === "draw" && level.tally?.tied === 1);
  check("three level rounds is a draw", raceVerdict(leg([5, 5, 5]), leg([5, 5, 5])).result === "draw");
  check("the tally is kept from the inviter's side", raceVerdict(leg([2, 2, 1]), leg([1, 1, 2])).tally?.won === 2);
  check("a leg with a rejected run did not finish", !legFinished(leg([1, 1, 1], ["consistent", "rejected", "consistent"])));
  check("a leg missing a run did not finish", !legFinished(leg([1, 1, 1], ["consistent", "consistent"])));
  check("a leg missing a score did not finish", !legFinished(leg([1, 1])));
  check("a void leg did not finish", !legFinished(leg(null, [], "void")));
  check("a suspect run still finishes a race leg (it counts in ranked)", legFinished(leg([1, 1, 1], ["suspect", "consistent", "verified"])));
  const quit = raceVerdict(leg([1, 1, 1]), leg(null, [], "void"));
  check("the side that finished beats the side that did not, whatever the score", quit.result === "inviter" && quit.byForfeit);
  check("neither finishing is void", raceVerdict(leg(null, [], "void"), leg([9, 9, 9], ["rejected", "verified", "verified"])).result === "void");
  check("each player reads it from their own side", verdictFor("inviter", true) === "win" && verdictFor("inviter", false) === "loss" && verdictFor("draw", false) === "draw");

  // The same rule settleMatch uses for a ranked match in rounds format.
  const sub = (scores: number[]): RoundSubmission[] => scores.map((score, i) => ({ scenarioId: i, scenarioName: `s${i}`, score, baseline: 1000, provisional: false, verificationTier: "consistent" }));
  const rand = seededRandom("race-comparator");
  let agree = 0;
  let tallies = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const draw = () => (i % 2 ? 995 + Math.floor(rand() * 5) : 900 + rand() * 200);
    const a = [0, 1, 2].map(draw);
    const b = [0, 1, 2].map(draw);
    const settled = settleMatch({ playerRounds: sub(a), opponentRounds: sub(b), format: "rounds" });
    const r = raceVerdict(leg(a), leg(b));
    if ((settled.verdict === "win" && r.result === "inviter") || (settled.verdict === "loss" && r.result === "invitee") || (settled.verdict === "draw" && r.result === "draw")) agree++;
    const t = raceTally(a, b);
    const st = roundTally(settled);
    if (t.won === st.won && t.lost === st.lost && t.tied === st.tied) tallies++;
  }
  check("the race result agrees with settleMatch's rounds verdict", agree === N, `${agree} of ${N}`);
  check("and so does the tally", tallies === N, `${tallies} of ${N}`);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── views ────────────────────────────────────────");
{
  const T0 = Date.UTC(2026, 9, 3, 20, 0, 0);
  const row = (over: Partial<RaceRow>): RaceRow => ({
    id: "r1", inviterId: "ana", inviteeId: "me", category: "Precise Tracking", window: 1, band: "Intermediate",
    scenarioIds: [1, 2, 3], status: "invited", createdAt: T0, expiresAt: T0 + RACE_INVITE_TTL_MS, startedAt: null,
    finishedAt: null, inviterMatchId: null, inviteeMatchId: null, result: null, byForfeit: false, ...over,
  });
  const names = new Map([["ana", "Ana"], ["me", "Me"], ["ben", "Ben"]]);
  const scen = new Map([[1, SCEN[0]], [2, SCEN[1]], [3, SCEN[2]]]);
  check("an invitation waits three minutes", RACE_INVITE_TTL_MS === 180_000);
  check("past its time it reads expired, whatever is stored", effectiveRaceStatus(row({}), T0 + RACE_INVITE_TTL_MS) === "expired" && effectiveRaceStatus(row({}), T0 + 1) === "invited");
  const board = buildRaceBoard([
    row({}),
    row({ id: "r2", inviterId: "me", inviteeId: "ben", createdAt: T0 - 1000, expiresAt: T0 + 100_000 }),
    row({ id: "r3", status: "live", inviterMatchId: "ma", inviteeMatchId: "mb", startedAt: T0 - 60_000, createdAt: T0 - 120_000 }),
    row({ id: "r4", status: "finished", result: "invitee", createdAt: T0 - 9e6, inviterMatchId: "mc", inviteeMatchId: "md" }),
    row({ id: "r5", status: "invited", expiresAt: T0 - 1, createdAt: T0 - 3e5 }),
  ], "me", names, scen, T0 + 1, 180);
  check("incoming invitations are the open ones addressed to you", board.incoming.length === 1 && board.incoming[0].id === "r1" && board.incoming[0].opponent.name === "Ana");
  check("an expired one is not offered", !board.incoming.some((r) => r.id === "r5"));
  check("your own open invitation is the outgoing one", board.outgoing?.id === "r2" && board.outgoing.opponent.name === "Ben");
  check("the live race carries your own match id", board.live?.id === "r3" && board.live.yourMatchId === "mb");
  check("a finished race reads from your side", board.recent[0]?.verdict === "win");
  check("the scenarios are named before anybody agrees", board.incoming[0].scenarios.join("|") === SCEN.join("|"));
  const found: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (/score|delta|baseline|margin/i.test(k)) found.push(`${p}.${k}`); walk(x, `${p}.${k}`); }
  };
  walk(board, "board");
  check("the race list carries no scores at all", found.length === 0, found.join(", "));
  const fromDb = raceRowFromDb({ id: "x", inviter_id: "a", invitee_id: "b", category: "C", window_index: "2", difficulty: "Advanced", scenario_ids: ["4", "5", "6"],
    status: "live", created_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 1).toISOString(), started_at: null, finished_at: null,
    inviter_match_id: "m1", invitee_match_id: "m2", result: null, by_forfeit: false });
  check("a database row maps onto the view's shape", fromDb.window === 2 && fromDb.scenarioIds[2] === 6 && fromDb.band === "Advanced" && fromDb.startedAt === null);
  check("summaries say who you are in the race", summarise(fromDb, "b", names, scen, T0).role === "invitee" && summarise(fromDb, "b", names, scen, T0).yourMatchId === "m2");

  const them = side("Kestrel", [true, true, false], [1031, 988, 0], false);
  const lead = sealView(side("me", [true, false, false], [1050, 0, 0]), them);
  check("the status line gives the rounds and names a sealed round", liveStatus(lead, null, "race") === "You lead 1\u20130 on rounds. Kestrel has landed 1 round you have not played yet; each opens when yours lands.", liveStatus(lead, null, "race"));
  const behind = sealView(side("me", [true, true, true], [1000, 900, 1000], true), side("Kestrel", [true, true, true], [1031, 988, 1000], true));
  check("and the result once there is one, read from the winner's side", liveStatus(behind, "loss", "race") === "Kestrel won the race, 2\u20130, 1 level on rounds." &&
    liveStatus(lead, "win", "crown") === "You took 1\u20130 on rounds against the holder's scores.",
    `${liveStatus(behind, "loss", "race")} | ${liveStatus(lead, "win", "crown")}`);
  const levelView = sealView(side("me", [true, true, false], [1031, 900, 0]), them);
  check("a level tally under a Crown says the tie keeps it", liveStatus(levelView, "draw", "crown").includes("A tie keeps the Crown with the holder"), liveStatus(levelView, "draw", "crown"));
}

console.log(failures === 0 ? "\nOK: race rules hold" : `\n${failures} check(s) failed`);
if (failures > 0) process.exit(1);
