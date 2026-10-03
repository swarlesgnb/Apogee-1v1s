/**
 * Validate the live race rules: the sealed reveal, the tug-of-war margin, the race result,
 * and the views.
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
  raceVerdict,
  RACE_DRAW_EPSILON,
  RACE_INVITE_TTL_MS,
  revealed,
  sealView,
  verdictFor,
  type FinalLeg,
  type LiveRound,
  type LiveSide,
} from "./race.ts";
import { buildRaceBoard, effectiveRaceStatus, liveStatus, raceRowFromDb, summarise, type RaceRow } from "./view.ts";
import { settleMatch, type RoundSubmission } from "../match/settle.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const SCEN = ["Smoothbot Intermediate", "waldoTS Intermediate", "Air Voltaic Intermediate"];
function side(name: string, landed: boolean[], deltas: number[], terminal = false, counted = [true, true, true]): LiveSide {
  const rounds: LiveRound[] = landed.map((l, i) => ({
    scenarioId: i + 1,
    scenario: SCEN[i],
    landed: l,
    delta: l && counted[i] ? deltas[i] : null,
    counted: l && counted[i],
    provisional: false,
    tier: l ? (counted[i] ? "consistent" : "rejected") : null,
  }));
  const done = rounds.filter((r) => r.counted);
  return {
    name,
    rounds,
    terminal,
    void: false,
    matchScore: terminal && done.length ? done.reduce((s, r) => s + (r.delta ?? 0), 0) / done.length : null,
  };
}

/* ------------------------------------------------------------------------------- */
console.log("\n── sealed rounds ────────────────────────────────");
{
  const them = side("Kestrel", [true, true, true], [0.031, -0.012, 0.044], true);
  const fresh = sealView(side("me", [false, false, false], [0, 0, 0]), them);
  check("before your first run lands, nothing of theirs is shown", fresh.rounds.every((r) => r.them.delta === null && r.them.sealed));
  check("you can see that they have landed, never how well", fresh.them.landed === 3 && fresh.them.matchScore === null);
  check("no margin yet", fresh.margin === null && fresh.marginRounds === 0);

  const one = sealView(side("me", [true, false, false], [0.02, 0, 0]), them);
  check("your round 1 lands: their round 1 opens", one.rounds[0].them.delta === 0.031 && !one.rounds[0].them.sealed);
  check("rounds 2 and 3 stay sealed", one.rounds[1].them.sealed && one.rounds[2].them.sealed && one.rounds[1].them.delta === null);
  check("the margin is round 1 alone", Math.abs((one.margin ?? 0) - (0.02 - 0.031)) < 1e-12 && one.marginRounds === 1);

  const outOfOrder = sealView(side("me", [false, false, true], [0, 0, 0.05]), them);
  check("rounds open in whatever order you play them", outOfOrder.rounds[2].them.delta === 0.044 && outOfOrder.rounds[0].them.sealed);

  const done = sealView(side("me", [true, true, true], [0.02, 0.01, 0.0], true), them);
  check("once your match ends you see all of theirs, and their match score",
    done.rounds.every((r) => !r.them.sealed) && Math.abs((done.them.matchScore ?? 0) - them.matchScore!) < 1e-12);

  const rejected = sealView(side("me", [true, false, false], [0.02, 0, 0], false, [false, true, true]), them);
  check("your rejected run still opens their round (it landed and cannot be replayed)", rejected.rounds[0].them.delta === 0.031);
  check("but a round you did not count is not in the margin", rejected.margin === null);

  const theirRejected = sealView(side("me", [true, false, false], [0.02, 0, 0]), side("K", [true, false, false], [0.5, 0, 0], false, [false, true, true]));
  check("their rejected run shows as not counted, with no number", theirRejected.rounds[0].them.counted === false && theirRejected.rounds[0].them.delta === null);

  // The search: every landed/terminal combination on both sides.
  let leaks = 0;
  let cases = 0;
  for (let mine = 0; mine < 8; mine++) for (let theirs = 0; theirs < 8; theirs++) for (const myDone of [false, true]) for (const theirDone of [false, true]) {
    const mask = (m: number) => [0, 1, 2].map((i) => !!(m & (1 << i)));
    if (myDone && mine !== 7) continue;
    const viewer = side("me", mask(mine), [0.01, 0.02, 0.03], myDone);
    const opp = side("them", mask(theirs), [0.111, 0.222, 0.333], theirDone && theirs === 7);
    const view = sealView(viewer, opp);
    cases++;
    const text = JSON.stringify(view);
    for (let i = 0; i < 3; i++) {
      if (!revealed(viewer, i) && (view.rounds[i].them.delta !== null || text.includes(String([0.111, 0.222, 0.333][i])))) leaks++;
    }
    if (!myDone && view.them.matchScore !== null) leaks++;
  }
  check(`no sealed number reaches the viewer in any of ${cases} landing combinations`, leaks === 0, `${leaks} leaks`);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the race result ──────────────────────────────");
{
  const leg = (score: number | null, tiers = ["consistent", "verified", "consistent"] as FinalLeg["tiers"], status: FinalLeg["status"] = "settled"): FinalLeg =>
    ({ status, matchScore: score, tiers, scenarios: 3 });
  check("higher match score wins", raceVerdict(leg(0.03), leg(0.01)).result === "inviter" && raceVerdict(leg(-0.02), leg(0.01)).result === "invitee");
  check("level within the draw margin is a draw", raceVerdict(leg(0.03), leg(0.03 + RACE_DRAW_EPSILON / 2)).result === "draw");
  check("a leg with a rejected run did not finish", !legFinished(leg(0.2, ["consistent", "rejected", "consistent"])));
  check("a leg missing a run did not finish", !legFinished(leg(0.2, ["consistent", "consistent"])));
  check("a void leg did not finish", !legFinished(leg(null, [], "void")));
  check("a suspect run still finishes a race leg (it counts in ranked)", legFinished(leg(0.01, ["suspect", "consistent", "verified"])));
  const quit = raceVerdict(leg(-0.08), leg(null, [], "void"));
  check("the side that finished beats the side that did not, whatever the score", quit.result === "inviter" && quit.byForfeit);
  check("neither finishing is void", raceVerdict(leg(null, [], "void"), leg(0.5, ["rejected", "verified", "verified"])).result === "void");
  check("each player reads it from their own side", verdictFor("inviter", true) === "win" && verdictFor("inviter", false) === "loss" && verdictFor("draw", false) === "draw");

  // The same comparator settleMatch uses for a round.
  const frozen = (d: number): RoundSubmission[] => [0, 1, 2].map((i) => ({ scenarioId: i, scenarioName: `s${i}`, score: 1 + d, baseline: 1, provisional: false, verificationTier: "consistent" }));
  let agree = 0;
  const pairs: [number, number][] = [[0.03, 0.01], [0.01, 0.03], [0.02, 0.0202], [0.02, 0.0206], [-0.05, -0.0503], [0, 0.001]];
  for (const [a, b] of pairs) {
    const s = settleMatch({ playerRounds: frozen(a), opponentRounds: frozen(b) }).verdict;
    const r = raceVerdict(leg(a), leg(b)).result;
    if ((s === "win" && r === "inviter") || (s === "loss" && r === "invitee") || (s === "draw" && r === "draw")) agree++;
  }
  check("the race result agrees with settleMatch's verdict", agree === pairs.length, `${agree} of ${pairs.length}`);
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

  const them = side("Kestrel", [true, true, false], [0.031, -0.012, 0], false);
  const lead = sealView(side("me", [true, false, false], [0.05, 0, 0]), them);
  check("the status line names a sealed round", liveStatus(lead, null, "race") === "You lead by 1.9% over 1 round. Kestrel has landed 1 round you have not played yet; each opens when yours lands.", liveStatus(lead, null, "race"));
  check("and the result once there is one", liveStatus(lead, "loss", "race") === "Kestrel won the race." && liveStatus(lead, "win", "crown") === "You beat the holder's run set.");
}

console.log(failures === 0 ? "\nOK: race rules hold" : `\n${failures} check(s) failed`);
if (failures > 0) process.exit(1);
