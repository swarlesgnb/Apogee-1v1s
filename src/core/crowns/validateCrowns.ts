/**
 * Validate the Crown rules: qualifying, taking and defending on rounds, ties, expiry,
 * defence counting, the board, and the two numbers the design rests on.
 *
 *   npx tsx src/core/crowns/validateCrowns.ts
 *
 * There is no corpus of Crowns, so like validateDuels and validateTournament this checks
 * exhaustiveness and invariants, and every refusal is checked next to something that must
 * be allowed: a judge that refused everything would pass every "is this refused?" line.
 *
 * It also re-derives, by simulation, the two claims docs/fleet/arena.md makes about the
 * rules: that without a reign cap the board freezes, and that without a cooldown the Crowns
 * go to whoever plays most. The model is compareLadders' (src/core/rating/compareLadders.ts,
 * the simulation ranked v2 was chosen on): one run's performance is the player's skill plus
 * noise with a robust spread of 5.5%, a twentieth of runs a bad one, and a round goes to the
 * higher raw score. What it cannot know is how far apart players in one band are; it is run
 * with nobody apart (the pure rule) and with an assumed in-band skill spread, and says which.
 */

import {
  beats,
  canChallenge,
  CHALLENGE_COOLDOWN_MS,
  crownName,
  defencePhrase,
  duration,
  judge,
  lapseDue,
  lowestTier,
  noticeText,
  qualifies,
  REIGN_CAP_MS,
  tally,
  tallyText,
  vacate,
  type Challenge,
  type CrownState,
  type RunSet,
  type RunTier,
} from "./crowns.ts";
import { buildBoard, crownKey, crownResultNote, type BoardInput } from "./view.ts";
import { roundTally, settleMatch, type RoundSubmission } from "../match/settle.ts";
import { seededRandom } from "../match/scenarioSelection.ts";
import { matchCardInput } from "../brand/shareInput.ts";
import { roundOutcome } from "../brand/shareCard.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 3, 18, 0, 0);

const CC: RunTier[] = ["consistent", "consistent", "consistent"];
const set = (scores: number[] | null, tiers: RunTier[] = CC, extra: Partial<RunSet> = {}): RunSet => ({
  status: "settled",
  scores,
  tiers,
  scenarios: 3,
  ...extra,
});
const empty = (cycle = 0): CrownState => ({ category: "Precise Tracking", window: 1, cycle, scenarioIds: [11, 12, 13], reign: null });
let serial = 0;
const challenge = (state: CrownState, challengerId: string, openedAt = T0): Challenge => ({
  matchId: `m${++serial}`,
  challengerId,
  cycle: state.cycle,
  reignId: state.reign?.id ?? null,
  openedAt,
});

/* ------------------------------------------------------------------------------- */
console.log("\n── the comparator is settleMatch's ──────────────");
{
  // Ask settleMatch, the code that decides every ranked match, for its rounds verdict on
  // the same pairs, the way settleForPlayer builds a frozen opponent: raw scores, with a
  // baseline that does not matter (in rounds it decides nothing).
  const side = (scores: number[]): RoundSubmission[] =>
    scores.map((score, i) => ({ scenarioId: i, scenarioName: `s${i}`, score, baseline: 900, provisional: false, verificationTier: "consistent" }));
  const rand = seededRandom("comparator");
  let agree = 0;
  let tallies = 0;
  let total = 0;
  let ties = 0;
  let disagreements = "";
  for (let i = 0; i < 6000; i++) {
    // Integer scores from a narrow range half the time, so exact ties on a round are common.
    const draw = () => (i % 2 ? 950 + Math.floor(rand() * 4) : 800 + rand() * 400);
    const a = [0, 1, 2].map(draw);
    const b = [0, 1, 2].map(draw);
    const settled = settleMatch({ playerRounds: side(a), opponentRounds: side(b), format: "rounds" });
    const t = tally(a, b);
    const st = roundTally(settled);
    total++;
    if (t.won === t.lost) ties++;
    if ((settled.verdict === "win") === beats(a, b)) agree++;
    else if (disagreements.length < 200) disagreements += ` [${a}]/[${b}]`;
    if (st.won === t.won && st.lost === t.lost && st.tied === t.tied) tallies++;
  }
  check("a take is exactly a settleMatch win in rounds format", agree === total, `${agree} of ${total}${disagreements}`);
  check("the tally is settleMatch's, round for round", tallies === total, `${tallies} of ${total}`);
  check("level tallies are common enough to have been tested", ties > 500, `${ties} level`);
  check("2-1 takes it", beats([1001, 1001, 900], [1000, 1000, 1000]));
  check("1-1 with one level does not", !beats([1001, 999, 1000], [1000, 1000, 1000]));
  check("0-0 with three level does not", !beats([1000, 1000, 1000], [1000, 1000, 1000]));
  check("1-0 with two level takes it", beats([1000.1, 1000, 1000], [1000, 1000, 1000]));
  check("a margin does not matter, only the count", !beats([5000, 999, 999], [1000, 1000, 1000]));
  check("the tally reads as a score", tallyText({ won: 2, lost: 1, tied: 0 }) === "2–1" && tallyText({ won: 1, lost: 1, tied: 1 }) === "1–1 with one level");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── what may take a Crown ────────────────────────");
{
  const ok = (s: RunSet) => qualifies(s).ok;
  const why = (s: RunSet) => { const q = qualifies(s); return q.ok ? "ok" : q.outcome; };
  const S = [1000, 1000, 1000];
  check("three Consistent runs qualify", ok(set(S)));
  check("three Verified runs qualify", ok(set(S, ["verified", "verified", "verified"])));
  check("Verified and Consistent mixed qualify", ok(set(S, ["verified", "consistent", "verified"])));
  check("a Rejected run never qualifies", why(set([9999, 9999, 9999], ["verified", "rejected", "verified"])) === "void");
  check("a Suspect run does not wear a Crown", why(set(S, ["consistent", "suspect", "consistent"])) === "void");
  check("an unverified run does not either", why(set(S, ["consistent", "unverified", "consistent"])) === "void");
  check("a missing round does not qualify", why(set(S, ["consistent", "consistent"])) === "void");
  check("a missing score does not qualify", why(set([1000, 1000])) === "void");
  check("a void match does not qualify", why(set(null, [], { status: "void" })) === "void");
  check("a forfeit is a forfeit, not a void", why(set(null, [], { forfeit: true })) === "forfeit");
  check("a non-finite score does not qualify", why(set([1000, Number.NaN, 1000])) === "void");
  check("the weakest tier is what a reign claims", lowestTier(["verified", "consistent", "verified"]) === "consistent" && lowestTier(["verified", "verified", "verified"]) === "verified");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── seeding, taking, defending ───────────────────");
{
  // Seeding: the first qualifying run set on a vacant Crown takes it.
  let s = empty();
  const ANA = [1000, 2000, 3000];
  const seed = judge(s, challenge(s, "ana"), set(ANA), T0, "r1");
  check("a vacant Crown goes to the first qualifying run set", seed.outcome === "took" && seed.state.reign?.holderId === "ana");
  check("its three raw scores are the ones to beat", seed.state.reign?.scores.join() === ANA.join());
  check("a seed dethrones nobody and has no tally", seed.ended === null && seed.notice === null && seed.tally === null);
  check("a new reign starts at zero defences", seed.state.reign?.defences === 0 && seed.state.reign?.challenges === 0);
  const rejectedSeed = judge(s, challenge(s, "ana"), set(ANA, ["rejected", "verified", "verified"]), T0, "rx");
  check("a Rejected run set cannot seed a vacant Crown", rejectedSeed.outcome === "void" && rejectedSeed.state.reign === null);
  s = seed.state;

  // A defence, a repeat challenger, a tie.
  const d1 = judge(s, challenge(s, "ben"), set([1001, 1999, 2999]), T0 + HOUR, "rx");
  check("one round of three is a defence", d1.outcome === "defended" && d1.state.reign?.holderId === "ana" && d1.state.reign?.defences === 1);
  check("the tally is kept from the challenger's side", d1.tally?.won === 1 && d1.tally?.lost === 2 && d1.tally?.tied === 0);
  check("the holder is told about the defence, with the rounds", d1.notice?.kind === "defended" && d1.notice.playerId === "ana" &&
    d1.notice.otherId === "ben" && d1.notice.challengerRounds === 1 && d1.notice.holderRounds === 2);
  check("the defence notice reads as rounds", noticeText(d1.notice!, "Intermediate", "Ben") ===
    "Ben challenged your Precise Tracking Crown (Intermediate) and did not take it (1–2 on rounds). Defences this reign: 1.", noticeText(d1.notice!, "Intermediate", "Ben"));
  const d2 = judge(d1.state, challenge(d1.state, "ben"), set([1, 1, 1]), T0 + DAY, "rx");
  check("the same challenger losing again is one defence, two challenges",
    d2.state.reign?.defences === 1 && d2.state.reign?.challenges === 2);
  const tie = judge(d2.state, challenge(d2.state, "cat"), set([1001, 1999, 3000]), T0 + DAY, "rx");
  check("a tie on rounds is a defence", tie.outcome === "defended" && tie.state.reign?.holderId === "ana" && tie.state.reign?.defences === 2);
  check("and says why", tie.reason.includes("tie is a defence"), tie.reason);
  const levelNote = crownResultNote({
    outcome: "defended", category: "Precise Tracking", window: 1, band: "Intermediate", claim: false, holderName: "Ana",
    judgedAgainstNewHolder: false, scenarios: ["A", "B", "C"], challengerScores: [1001, 1999, 3000], holderScores: ANA, defences: 2,
  });
  check("the result note says a tie on rounds is a defence", levelNote.explanation.includes("1–1 with one level on rounds against Ana, and a tie on rounds is a defence"), levelNote.explanation);
  check("the result note shows each round's two raw scores", levelNote.rounds?.map((r) => `${r.you}/${r.holder}/${r.result}`).join() === "1001/1000/won,1999/2000/lost,3000/3000/tied");

  // A Rejected run with a huge score: still nothing.
  const forged = judge(tie.state, challenge(tie.state, "dan"), set([9e9, 9e9, 9e9], ["verified", "verified", "rejected"]), T0 + DAY, "rx");
  check("a Rejected run never takes a Crown, whatever it scored", forged.outcome === "void" && forged.state.reign?.holderId === "ana");
  check("and it is not counted as a defence", forged.state.reign?.defences === 2 && forged.state.reign?.challenges === 3);
  const forfeit = judge(tie.state, challenge(tie.state, "dan"), set(null, [], { forfeit: true }), T0 + DAY, "rx");
  check("a forfeit neither takes nor counts as a defence", forfeit.outcome === "forfeit" && forfeit.state === tie.state);

  // The take.
  const EVE = [1001, 2001, 2000];
  const take = judge(tie.state, challenge(tie.state, "eve"), set(EVE), T0 + 2 * DAY + 3 * HOUR, "r2");
  check("two rounds of three take the Crown", take.outcome === "took" && take.state.reign?.holderId === "eve" && take.state.reign?.id === "r2");
  check("the taker's scores become the bar", take.state.reign?.scores.join() === EVE.join());
  check("the old reign ends dethroned, by the taker", take.ended?.endReason === "dethroned" && take.ended.endedBy === "eve" && take.ended.defences === 2);
  check("the dethroned holder gets a notice with the defences, reign length and rounds",
    take.notice?.kind === "dethroned" && take.notice.playerId === "ana" && take.notice.defences === 2 &&
    take.notice.reignMs === 2 * DAY + 3 * HOUR && take.notice.challengerRounds === 2 && take.notice.holderRounds === 1);
  const text = noticeText(take.notice!, "Intermediate", "Eve");
  check("the notice reads the way the brief asks, with the rounds",
    text === "You lost the Precise Tracking Crown (Intermediate) to Eve after 2 defences, 2–1 on rounds. You held it for 2 days 3 hours.", text);
  const takeNote = crownResultNote({
    outcome: "took", category: "Precise Tracking", window: 1, band: "Intermediate", claim: false, holderName: "Ana",
    judgedAgainstNewHolder: false, scenarios: ["A", "B", "C"], challengerScores: EVE, holderScores: ANA, defences: 2,
  });
  check("the take note gives the tally and no delta", takeNote.explanation.startsWith("You won 2–1 on rounds against Ana.") && !/%/.test(takeNote.explanation), takeNote.explanation);
  check("the taker's reign starts clean", take.state.reign?.defences === 0 && take.state.reign?.defeated.length === 0);
  check("a defeated challenger can come back and take it", judge(take.state, challenge(take.state, "ben"), set([5000, 5000, 1]), T0 + 3 * DAY, "r3").outcome === "took");

  // Own Crown, stale cycle.
  check("a holder cannot defend against themselves", judge(take.state, challenge(take.state, "eve"), set([9e9, 9e9, 9e9]), T0, "rx").outcome === "stale");
  const old = challenge(take.state, "fay");
  const reset = vacate(take.state, T0 + 3 * DAY, "reset").state;
  check("a challenge played on an old cycle is stale", judge(reset, old, set([9e9, 9e9, 9e9]), T0 + 3 * DAY, "rx").outcome === "stale");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── simultaneous challenges ──────────────────────");
{
  const H = [1000, 1000, 1000];
  const base = judge(empty(), challenge(empty(), "hold"), set(H), T0, "r0").state;
  const a = challenge(base, "a");
  const b = challenge(base, "b");
  const run = (first: [Challenge, number[]], second: [Challenge, number[]]) => {
    const j1 = judge(base, first[0], set(first[1]), T0 + 1, "x1");
    const j2 = judge(j1.state, second[0], set(second[1]), T0 + 2, "x2");
    return { j1, j2 };
  };
  const same = [1001, 1001, 999];
  const equal = run([a, same], [b, same]);
  check("two identical winning sets: exactly one take", [equal.j1.outcome, equal.j2.outcome].filter((o) => o === "took").length === 1);
  check("the second is judged against the new holder and defends on a level tally", equal.j2.outcome === "defended" && equal.j2.judgedReignId === "x1" &&
    equal.j2.tally?.tied === 3);

  // Rounds are not transitive. Each of these beats the holder 2-1, and they beat each other
  // in a circle, like non-transitive dice: the final holder depends on settle order.
  const A = [1003, 1002, 999];
  const B = [1002, 999, 1003];
  const C = [999, 1003, 1002];
  check("the example is a cycle: A beats B, B beats C, C beats A", beats(A, H) && beats(B, H) && beats(C, H) && beats(A, B) && beats(B, C) && beats(C, A));
  const order = (xs: [string, number[]][]) => {
    let st = base;
    for (const [i, [id, sc]] of xs.entries()) st = judge(st, challenge(base, id), set(sc), T0 + i, `o${i}`).state;
    return st.reign?.holderId;
  };
  const abc = order([["a", A], ["b", B], ["c", C]]);
  const cba = order([["c", C], ["b", B], ["a", A]]);
  check("so the final holder can depend on the order challenges settle in", abc !== cba, `${abc} vs ${cba}`);

  // Random batches: N challengers against one reign, settled in a random order. What must
  // hold whatever the order: each challenge is judged against exactly one holder, every
  // take beat the holder it took from, every defence did not, no reign ends twice, and
  // there is one take per ended reign.
  const rand = seededRandom("simultaneous");
  let bad = 0;
  let orderMattered = 0;
  for (let trial = 0; trial < 3000; trial++) {
    const n = 2 + Math.floor(rand() * 5);
    const opened = Array.from({ length: n }, (_, i) => ({
      c: challenge(base, `p${i}`),
      scores: [0, 1, 2].map(() => 996 + Math.floor(rand() * 9)),
      tiers: (rand() < 0.15 ? ["consistent", "rejected", "verified"] : ["consistent", "verified", "consistent"]) as RunTier[],
    }));
    const settle = (list: typeof opened) => {
      let state = base;
      const ended = new Map<string, number>();
      let takes = 0;
      let wrong = 0;
      for (const [i, o] of list.entries()) {
        const before = state.reign!;
        const j = judge(state, o.c, set(o.scores, o.tiers), T0 + i, `t${trial}-${i}-${o.c.challengerId}`);
        if (j.ended) ended.set(j.ended.id, (ended.get(j.ended.id) ?? 0) + 1);
        if (j.outcome === "took") {
          takes++;
          if (j.judgedReignId !== before.id || !beats(o.scores, before.scores)) wrong++;
        } else if (j.outcome === "defended") {
          if (j.judgedReignId !== before.id || beats(o.scores, before.scores)) wrong++;
        } else if (!o.tiers.includes("rejected")) wrong++;
        state = j.state;
      }
      return { holder: state.reign!.holderId, ok: wrong === 0 && [...ended.values()].every((v) => v === 1) && takes === ended.size };
    };
    const shuffled = [...opened];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const x = settle(opened);
    const y = settle(shuffled);
    if (!x.ok || !y.ok) bad++;
    if (x.holder !== y.holder) orderMattered++;
  }
  check("3000 random batches: every take beat its holder, every defence did not, no reign ends twice, one take per ended reign", bad === 0, `${bad} bad`);
  console.log(`       settle order changed the final holder in ${orderMattered} of 3000 batches (rounds are not transitive)`);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── lapse and expiry ─────────────────────────────");
{
  let s = judge(empty(), challenge(empty(), "ana"), set([1000, 1000, 1000]), T0, "r1").state;
  s = judge(s, challenge(s, "ben"), set([900, 900, 900]), T0 + DAY, "rx").state;
  check("a reign is not due before the cap", !lapseDue(s, T0 + REIGN_CAP_MS - 1, false));
  check("a reign is due at the cap", lapseDue(s, T0 + REIGN_CAP_MS, false));
  check("a challenge being played holds the lapse", !lapseDue(s, T0 + REIGN_CAP_MS + HOUR, true));
  check("a vacant Crown never lapses", !lapseDue(empty(), T0 + 10 * REIGN_CAP_MS, false));
  const v = vacate(s, T0 + REIGN_CAP_MS, "lapsed");
  check("a lapse empties the Crown onto a new cycle with no scenarios", v.state.reign === null && v.state.cycle === s.cycle + 1 && v.state.scenarioIds === null);
  check("the holder is told, with their defences", v.notice?.kind === "lapsed" && v.notice.playerId === "ana" && v.notice.defences === 1 && v.notice.reignMs === REIGN_CAP_MS);
  check("the lapse notice says the Crown is vacant again", noticeText(v.notice!, "Intermediate", null).includes("vacant again, on three new scenarios"));
  const reclaim = judge(v.state, challenge(v.state, "ana"), set([1, 1, 1]), T0 + REIGN_CAP_MS + 1, "r9");
  check("the old holder may claim the new cycle", reclaim.outcome === "took" && reclaim.state.reign?.holderId === "ana");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── who may challenge ────────────────────────────");
{
  const s = judge(empty(), challenge(empty(), "ana"), set([1000, 1000, 1000]), T0, "r1").state;
  check("anybody else may challenge", canChallenge(s, "ben", null, T0, false).ok);
  const own = canChallenge(s, "ana", null, T0, false);
  check("the holder may not", !own.ok && own.code === "holder");
  const soon = canChallenge(s, "ben", T0, T0 + CHALLENGE_COOLDOWN_MS - 60_000, false);
  check("one challenge per Crown per cooldown", !soon.ok && soon.code === "cooldown" && soon.availableAt === T0 + CHALLENGE_COOLDOWN_MS);
  check("the refusal says when, in words", !soon.ok && soon.reason.includes("in 1 minute"), !soon.ok ? soon.reason : "");
  check("and opens again when it ends", canChallenge(s, "ben", T0, T0 + CHALLENGE_COOLDOWN_MS, false).ok);
  const busy = canChallenge(s, "ben", null, T0, true);
  check("a player in another match is refused", !busy.ok && busy.code === "busy");
  check("a vacant Crown can be claimed by anyone", canChallenge(empty(), "ana", null, T0, false).ok);
  check("durations read as words", duration(90_000) === "2 minutes" && duration(3 * HOUR) === "3 hours" && duration(DAY + 2 * HOUR) === "1 day 2 hours");
  check("zero defences reads naturally", defencePhrase(0) === "before your first defence" && defencePhrase(1) === "after 1 defence");
  check("a Crown is named by category and band", crownName("Speed Switching", "Expert") === "Speed Switching Crown (Expert)");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the board ────────────────────────────────────");
{
  const input: BoardInput = {
    season: "Season 1",
    bands: ["Novice", "Intermediate", "Advanced", "Expert"],
    cells: ["Precise Tracking", "Speed Switching"].flatMap((category) => [0, 1, 2, 3].map((window) => ({ category, window }))),
    rows: [
      { category: "Precise Tracking", window: 1, cycle: 2, scenarioIds: [1, 2, 3], live: 1,
        reign: { id: "r1", holderId: "ana", startedAt: T0 - 2 * DAY, defences: 3, challenges: 4, lowestTier: "verified", provisional: false } },
      { category: "Speed Switching", window: 0, cycle: 0, scenarioIds: [4, 5, 6], live: 0,
        reign: { id: "r2", holderId: "me", startedAt: T0 - HOUR, defences: 0, challenges: 0, lowestTier: "consistent", provisional: true } },
      { category: "Speed Switching", window: 2, cycle: 1, scenarioIds: [7, 8, 9], live: 0, reign: null },
    ],
    history: Array.from({ length: 8 }, (_, i) => ({
      category: "Precise Tracking", window: 1, holderId: i % 2 ? "ben" : "cat", startedAt: T0 - (20 - i) * DAY, endedAt: T0 - (19 - i) * DAY,
      defences: i, endReason: "dethroned" as const, endedBy: "ana", endedWon: 2, endedLost: i % 2,
    })),
    names: new Map([["ana", "Ana"], ["ben", "Ben"], ["cat", "<b>Cat</b>"], ["me", "Me"]]),
    scenarioNames: new Map([[1, "Smoothbot Intermediate"], [2, "waldoTS Intermediate"], [3, "Smoothbot Novice"]]),
    viewerId: "me",
    now: T0,
    lastChallenge: new Map([[crownKey("Precise Tracking", 2), T0 - HOUR]]),
    openChallenge: null,
    viewerBusy: false,
    notices: [
      { id: "n1", kind: "dethroned", category: "Precise Tracking", window: 1, defences: 3, reignMs: 3 * DAY, otherName: "Ana", createdAt: T0 - HOUR, challengerRounds: 2, holderRounds: 0 },
      { id: "n2", kind: "defended", category: "Speed Switching", window: 0, defences: 1, reignMs: HOUR, otherName: "Ben", createdAt: T0, challengerRounds: 1, holderRounds: 1 },
    ],
  };
  const board = buildBoard(input);
  const card = (c: string, w: number) => board.crowns.find((x) => x.key === crownKey(c, w))!;
  const held = card("Precise Tracking", 1);
  check("every cell of the season is on the board", board.crowns.length === 8 && board.bands.length === 4 && board.categories.length === 2);
  check("a held Crown shows holder, defences and the reign's end", held.holder?.name === "Ana" && held.defences === 3 &&
    held.reignEndsAt === new Date(T0 - 2 * DAY + REIGN_CAP_MS).toISOString());
  check("what taking it needs is said as a rounds rule", held.rounds === 3 && !!held.toTake && /more of the three rounds/.test(held.toTake) && /tie on rounds keeps/i.test(held.toTake), held.toTake ?? "");
  check("a vacant Crown has no bar to state", card("Speed Switching", 2).toTake === null);
  check("a held Crown offers Challenge", held.action.kind === "challenge");
  check("a vacant Crown offers Claim", card("Speed Switching", 2).action.kind === "claim" && card("Speed Switching", 2).status === "vacant");
  check("a Crown you hold says so", card("Speed Switching", 0).action.kind === "yours" && board.holding === 1);
  check("a Crown you challenged today shows when it opens again", card("Precise Tracking", 2).action.kind === "cooldown" &&
    (card("Precise Tracking", 2).action as { availableAt: string }).availableAt === new Date(T0 - HOUR + CHALLENGE_COOLDOWN_MS).toISOString());
  check("history is newest first, five at most", held.history.length === 5 &&
    Date.parse(held.history[0].endedAt) > Date.parse(held.history[1].endedAt));
  check("history shows the round tally that ended each reign", held.history[0].takenOn === "2–1" && held.history[1].takenOn === "2–0", held.history.map((h) => h.takenOn).join());
  check("names are passed through as text, for the renderer to escape", held.history.some((h) => h.holder === "<b>Cat</b>"));
  check("notices come newest first, as sentences with the rounds", board.notices[0].id === "n2" &&
    board.notices[1].text.startsWith("You lost the Precise Tracking Crown (Intermediate) to Ana after 3 defences, 2–0 on rounds"), board.notices[1].text);
  const busyBoard = buildBoard({ ...input, viewerBusy: true });
  check("a player in another match is told to finish it", busyBoard.crowns.find((c) => c.key === crownKey("Precise Tracking", 1))!.action.kind === "busy");
  const playing = buildBoard({ ...input, openChallenge: { key: crownKey("Precise Tracking", 1), matchId: "m" } });
  check("the Crown you are challenging shows your open match", playing.crowns.find((c) => c.key === crownKey("Precise Tracking", 1))!.action.kind === "playing");
  // The holder's scores are sealed: the board carries none of their numbers.
  const forbidden = ["score", "scores", "baseline", "deltas", "delta", "matchScore", "bar", "runIds", "rating"];
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (forbidden.includes(k)) found.push(`${path}.${k}`); walk(x, `${path}.${k}`); }
  };
  walk(board, "board");
  check("the board carries no raw scores, deltas, baselines or ratings", found.length === 0, found.join(", "));
}

/* ------------------------------------------------------------------------------- */
console.log("\n── why a cap and a cooldown: replayed ───────────");
{
  // One run's performance as compareLadders draws it: 95% of runs N(0, 5.5%), the rest a
  // bad run centred 10% down. A round is won by the higher raw score on the same scenario,
  // which on a log scale is the higher skill + noise.
  const gaussian = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const noise = (r: () => number) => (r() < 0.95 ? gaussian(r) * 0.055 : -0.1 + gaussian(r) * 0.2);
  const play = (r: () => number, skill: number) => [0, 1, 2].map(() => skill + noise(r));

  // 1. The survivor effect: with exchangeable players, how often does the next challenger
  //    take a run set that has already survived m challenges since it took the Crown?
  const survivor = (() => {
    const r = seededRandom("records");
    const hits = new Map<number, [number, number]>();
    for (let t = 0; t < 20000; t++) {
      let bar = play(r, 0);
      let m = 0;
      for (let k = 0; k < 12; k++) {
        const x = play(r, 0);
        const [h, n] = hits.get(m) ?? [0, 0];
        const took = beats(x, bar);
        hits.set(m, [h + (took ? 1 : 0), n + 1]);
        if (took) { bar = x; m = 0; } else m++;
      }
    }
    return [0, 1, 3, 5, 10].filter((m) => hits.has(m)).map((m) => { const [h, n] = hits.get(m)!; return { m, rate: h / n, n }; });
  })();
  console.log("       challenges survived   next challenger takes it");
  for (const x of survivor) console.log(`       ${String(x.m).padStart(10)}            ${(100 * x.rate).toFixed(1).padStart(5)}%`);
  const first = survivor[0].rate;
  const last = survivor[survivor.length - 1].rate;
  check("a set that has survived longer is harder to take", survivor.every((x, i) => i === 0 || x.rate < survivor[i - 1].rate + 0.01) && last < 0.75 * first,
    `${(100 * first).toFixed(1)}% fresh, ${(100 * last).toFixed(1)}% after ${survivor[survivor.length - 1].m}`);

  // 2. The cap: N players, each challenging a given Crown on about half their days, one a
  //    day each (the cooldown), eight weeks. How often does the Crown change hands in week
  //    8, with and without a 7-day reign cap? Skill: nobody apart, and an assumed in-band
  //    spread of 4% (compareLadders' whole-ladder spread is 15% across four bands).
  const simulate = (players: number, capped: boolean, spread: number, seed: string) => {
    const r = seededRandom(seed);
    const skill = Array.from({ length: players }, () => gaussian(r) * spread);
    let holder: number | null = null;
    let bar: number[] = [];
    let started = 0;
    const takesByWeek = Array(8).fill(0);
    for (let day = 0; day < 56; day++) {
      if (capped && holder !== null && day - started >= 7) holder = null;
      const today = Array.from({ length: players }, (_, p) => p).filter((p) => p !== holder && r() < 0.5);
      for (let i = today.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [today[i], today[j]] = [today[j], today[i]]; }
      for (const p of today) {
        const x = play(r, skill[p]);
        if (holder === null || beats(x, bar)) { if (holder !== null) takesByWeek[Math.floor(day / 7)]++; holder = p; bar = x; started = day; }
      }
    }
    return takesByWeek;
  };
  const trials = 400;
  for (const spread of [0, 0.04]) {
    for (const players of [2, 5, 15]) {
      let capped8 = 0, open8 = 0, capped1 = 0;
      for (let t = 0; t < trials; t++) {
        const c = simulate(players, true, spread, `cap-${players}-${t}`);
        const o = simulate(players, false, spread, `cap-${players}-${t}`);
        capped8 += c[7]; open8 += o[7]; capped1 += c[0];
      }
      console.log(`       spread ${(100 * spread).toFixed(0)}%, ${String(players).padStart(2)} players: changes of hand in week 8, capped ${(capped8 / trials).toFixed(2)}, uncapped ${(open8 / trials).toFixed(2)}  (week 1: ${(capped1 / trials).toFixed(2)})`);
      if (players === 5) {
        check(`spread ${(100 * spread).toFixed(0)}%: with a cap, week 8 is as alive as week 1`, capped8 / trials > 0.7 * (capped1 / trials));
        check(`spread ${(100 * spread).toFixed(0)}%: without one, week 8 changes hands well under the capped rate`, open8 < 0.6 * capped8, `${(open8 / trials).toFixed(2)} vs ${(capped8 / trials).toFixed(2)}`);
      }
    }
  }

  // 3. The cooldown: one player who would challenge five times a day against four who play
  //    once, all of equal skill. Share of Crown-days the grinder holds, with and without.
  const share = (grinderAttempts: number, seed: string) => {
    const r = seededRandom(seed);
    let holder: number | null = null, bar: number[] = [], started = 0, held = 0, days = 0;
    for (let day = 0; day < 56; day++) {
      if (holder !== null && day - started >= 7) holder = null;
      const attempts: number[] = [];
      for (let p = 0; p < 5; p++) { if (p === holder) continue; for (let k = 0; k < (p === 0 ? grinderAttempts : 1); k++) attempts.push(p); }
      for (let i = attempts.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [attempts[i], attempts[j]] = [attempts[j], attempts[i]]; }
      for (const p of attempts) { const x = play(r, 0); if (holder === null || beats(x, bar)) { holder = p; bar = x; started = day; } }
      days++; if (holder === 0) held++;
    }
    return held / days;
  };
  let free = 0, limited = 0;
  for (let t = 0; t < trials; t++) { free += share(5, `grind-${t}`); limited += share(1, `grind-${t}`); }
  console.log(`       a 5-a-day grinder among 5 equal players holds the Crown ${(100 * free / trials).toFixed(0)}% of days without a cooldown, ${(100 * limited / trials).toFixed(0)}% with one (fair share 20%)`);
  check("without a cooldown the grinder takes well over a fair share", free / trials > 0.4);
  check("with one, the grinder is back near a fair share", Math.abs(limited / trials - 0.2) < 0.06);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the share card: unrated, raw scores, rounds ──");
{
  // A Crown challenge settles as a contested unrated match, and main hands its result to
  // the share card like any other. The card must not print a rating, call it ranked, or
  // print a match score; each round shows both raw scores and the server's result.
  const settled = {
    matchId: "m", verdict: "win" as const, rated: false, tournament: null, arena: { kind: "crown" as const },
    opponent: { displayName: "Kestrel" }, category: "Precise Tracking", yourMatchScore: 0.041, theirMatchScore: 0,
    ratingAfter: 1500, ratingChange: 0,
    rounds: [[1040, 1030, "won"], [990, 1000, "lost"], [1200, 1100, "won"]].map(([you, them, result], i) => ({
      scenario: `s${i}`, score: you as number, baseline: 1000, delta: (you as number) / 1000 - 1, opponentDelta: null,
      opponentScore: them as number, result: result as "won" | "lost", counted: true, excludedReason: null,
    })),
  };
  const card = matchCardInput({ settled, at: T0, sentDuel: false }, { playerName: "Me", season: "Season 1", tier: null });
  check("a Crown challenge card is labelled unrated and prints no rating",
    !("refused" in card) && card.kind === "match" && card.mode === "Crown challenge · unrated" && card.player.rating === null && card.player.ratingChange === null);
  check("and no match score", !("refused" in card) && card.matchScore === null);
  check("each round carries the holder's raw score and is called on it",
    !("refused" in card) && card.rounds.map((r) => `${r.them?.score}:${roundOutcome(r)}`).join() === "1030:won,1000:lost,1100:won",
    !("refused" in card) ? card.rounds.map((r) => `${r.them?.score}:${roundOutcome(r)}`).join() : "");
  const race = matchCardInput({ settled: { ...settled, verdict: null, seeding: true, theirMatchScore: null, arena: { kind: "race" as const, race: { opponentName: "Wren" } } }, at: T0, sentDuel: false },
    { playerName: "Me", season: "Season 1", tier: null });
  check("a race leg card names the race", !("refused" in race) && race.kind === "match" && race.mode === "Race against Wren · unrated");
}

console.log(failures === 0 ? "\nOK: Crown rules hold" : `\n${failures} check(s) failed`);
if (failures > 0) process.exit(1);
