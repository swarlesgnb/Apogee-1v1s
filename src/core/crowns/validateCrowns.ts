/**
 * Validate the Crown rules: qualifying, taking and defending, ties, expiry, defence
 * counting, the board, and the two numbers the design rests on.
 *
 *   npx tsx src/core/crowns/validateCrowns.ts
 *
 * There is no corpus of Crowns, so like validateDuels and validateTournament this checks
 * exhaustiveness and invariants, and every refusal is checked next to something that must
 * be allowed: a judge that refused everything would pass every "is this refused?" line.
 *
 * It also re-derives, by simulation, the two claims docs/fleet/arena.md makes about the
 * rules: that without a reign cap the board freezes, and that without a cooldown the Crowns
 * go to whoever plays most. The spread of a three-round match score is taken from the one
 * measurement this repository has of it (docs/overnight/mechanics.md: the trailing-median
 * ghost, which is nearly the baseline itself, put the live side's three-round margin at
 * p10 -5.6%, p90 +5.8%, so sigma = 11.4% / 2.563 = 4.45%).
 */

import {
  beats,
  canChallenge,
  CHALLENGE_COOLDOWN_MS,
  CROWN_DRAW_EPSILON,
  crownName,
  defencePhrase,
  duration,
  judge,
  lapseDue,
  lowestTier,
  noticeText,
  qualifies,
  REIGN_CAP_MS,
  vacate,
  type Challenge,
  type CrownState,
  type RunSet,
  type RunTier,
} from "./crowns.ts";
import { buildBoard, crownKey, crownResultNote, type BoardInput } from "./view.ts";
import { settleMatch, type RoundSubmission } from "../match/settle.ts";
import { seededRandom } from "../match/scenarioSelection.ts";

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

const set = (matchScore: number | null, tiers: RunTier[] = ["consistent", "consistent", "consistent"], extra: Partial<RunSet> = {}): RunSet => ({
  status: "settled",
  matchScore,
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
  // Ask settleMatch, the code that decides every ranked round, for its verdict on the same
  // pairs, the way settle-match builds a frozen opponent: synthetic score/baseline pairs.
  const frozen = (deltas: number[]): RoundSubmission[] =>
    deltas.map((d, i) => ({ scenarioId: i, scenarioName: `s${i}`, score: 1 + d, baseline: 1, provisional: false, verificationTier: "consistent" }));
  const rand = seededRandom("comparator");
  let agree = 0;
  let total = 0;
  let disagreements = "";
  for (let i = 0; i < 4000; i++) {
    const a = [0, 1, 2].map(() => (rand() - 0.5) * 0.3);
    // Half the pairs land within a few draw margins of each other, where the rule bites.
    const b = i % 2 ? [0, 1, 2].map(() => (rand() - 0.5) * 0.3) : a.map((x) => x + (rand() - 0.5) * 0.004);
    const ma = a.reduce((s, x) => s + x, 0) / 3;
    const mb = b.reduce((s, x) => s + x, 0) / 3;
    // Skip the measure-zero band where floating point decides which side of the margin a
    // pair falls on: settleMatch rebuilds each delta as (1 + d) - 1, which is not d exactly.
    if (Math.abs(Math.abs(ma - mb) - CROWN_DRAW_EPSILON) < 1e-9) continue;
    const verdict = settleMatch({ playerRounds: frozen(a), opponentRounds: frozen(b) }).verdict;
    total++;
    if ((verdict === "win") === beats(ma, mb)) agree++;
    else if (disagreements.length < 200) disagreements += ` ${ma}/${mb}`;
  }
  check("beats() agrees with settleMatch on every pair", agree === total, `${agree} of ${total}${disagreements}`);
  check("a draw does not take the Crown", !beats(0.031, 0.031) && !beats(0.0314, 0.031));
  check("a challenger needs the full draw margin", beats(0.031 + CROWN_DRAW_EPSILON + 1e-9, 0.031));
  check("a lower score never takes it", !beats(-0.2, 0.01));
}

/* ------------------------------------------------------------------------------- */
console.log("\n── what may take a Crown ────────────────────────");
{
  const ok = (s: RunSet) => qualifies(s).ok;
  const why = (s: RunSet) => { const q = qualifies(s); return q.ok ? "ok" : q.outcome; };
  check("three Consistent runs qualify", ok(set(0.02)));
  check("three Verified runs qualify", ok(set(0.02, ["verified", "verified", "verified"])));
  check("Verified and Consistent mixed qualify", ok(set(0.02, ["verified", "consistent", "verified"])));
  check("a Rejected run never qualifies", why(set(0.5, ["verified", "rejected", "verified"])) === "void");
  check("a Suspect run does not wear a Crown", why(set(0.02, ["consistent", "suspect", "consistent"])) === "void");
  check("an unverified run does not either", why(set(0.02, ["consistent", "unverified", "consistent"])) === "void");
  check("a missing round does not qualify", why(set(0.02, ["consistent", "consistent"])) === "void");
  check("a void match does not qualify", why(set(null, [], { status: "void" })) === "void");
  check("a forfeit is a forfeit, not a void", why(set(null, [], { forfeit: true })) === "forfeit");
  check("a non-finite score does not qualify", why(set(Number.NaN)) === "void");
  check("the weakest tier is what a reign claims", lowestTier(["verified", "consistent", "verified"]) === "consistent" && lowestTier(["verified", "verified", "verified"]) === "verified");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── seeding, taking, defending ───────────────────");
{
  // Seeding: the first qualifying run set on a vacant Crown takes it.
  let s = empty();
  const seed = judge(s, challenge(s, "ana"), set(-0.01), T0, "r1");
  check("a vacant Crown goes to the first qualifying run set", seed.outcome === "took" && seed.state.reign?.holderId === "ana");
  check("a seed dethrones nobody", seed.ended === null && seed.notice === null);
  check("a new reign starts at zero defences", seed.state.reign?.defences === 0 && seed.state.reign?.challenges === 0);
  const rejectedSeed = judge(s, challenge(s, "ana"), set(0.4, ["rejected", "verified", "verified"]), T0, "rx");
  check("a Rejected run set cannot seed a vacant Crown", rejectedSeed.outcome === "void" && rejectedSeed.state.reign === null);
  s = seed.state;

  // A defence, a repeat challenger, a draw.
  const d1 = judge(s, challenge(s, "ben"), set(-0.02), T0 + HOUR, "rx");
  check("a lower score is a defence", d1.outcome === "defended" && d1.state.reign?.holderId === "ana" && d1.state.reign?.defences === 1);
  check("the holder is told about the defence", d1.notice?.kind === "defended" && d1.notice.playerId === "ana" && d1.notice.otherId === "ben");
  const d2 = judge(d1.state, challenge(d1.state, "ben"), set(-0.03), T0 + DAY, "rx");
  check("the same challenger losing again is one defence, two challenges",
    d2.state.reign?.defences === 1 && d2.state.reign?.challenges === 2);
  const tie = judge(d2.state, challenge(d2.state, "cat"), set(-0.01 + CROWN_DRAW_EPSILON / 2), T0 + DAY, "rx");
  check("a draw is a defence", tie.outcome === "defended" && tie.state.reign?.holderId === "ana" && tie.state.reign?.defences === 2);
  check("the result note says a draw is a defence", crownResultNote({
    outcome: "defended", category: "Precise Tracking", window: 1, band: "Intermediate", claim: false, holderName: "ana",
    judgedAgainstNewHolder: false, challengerScore: -0.01 + CROWN_DRAW_EPSILON / 2, holderScore: -0.01, defences: 2,
  }).explanation.includes("a draw is a defence"));

  // A Rejected run with a huge score: still nothing.
  const forged = judge(tie.state, challenge(tie.state, "dan"), set(0.9, ["verified", "verified", "rejected"]), T0 + DAY, "rx");
  check("a Rejected run never takes a Crown, whatever it scored", forged.outcome === "void" && forged.state.reign?.holderId === "ana");
  check("and it is not counted as a defence", forged.state.reign?.defences === 2 && forged.state.reign?.challenges === 3);
  const forfeit = judge(tie.state, challenge(tie.state, "dan"), set(null, [], { forfeit: true }), T0 + DAY, "rx");
  check("a forfeit neither takes nor counts as a defence", forfeit.outcome === "forfeit" && forfeit.state === tie.state);

  // The take.
  const take = judge(tie.state, challenge(tie.state, "eve"), set(0.012), T0 + 2 * DAY + 3 * HOUR, "r2");
  check("a higher score takes the Crown", take.outcome === "took" && take.state.reign?.holderId === "eve" && take.state.reign?.id === "r2");
  check("the old reign ends dethroned, by the taker", take.ended?.endReason === "dethroned" && take.ended.endedBy === "eve" && take.ended.defences === 2);
  check("the dethroned holder gets a notice with the defences and reign length",
    take.notice?.kind === "dethroned" && take.notice.playerId === "ana" && take.notice.defences === 2 && take.notice.reignMs === 2 * DAY + 3 * HOUR);
  const text = noticeText(take.notice!, "Intermediate", "Eve");
  check("the notice reads the way the brief asks",
    text === "You lost the Precise Tracking Crown (Intermediate) to Eve after 2 defences. You held it for 2 days 3 hours.", text);
  check("the taker's reign starts clean", take.state.reign?.defences === 0 && take.state.reign?.defeated.length === 0);
  check("a defeated challenger can come back and take it", judge(take.state, challenge(take.state, "ben"), set(0.05), T0 + 3 * DAY, "r3").outcome === "took");

  // Own Crown, stale cycle.
  check("a holder cannot defend against themselves", judge(take.state, challenge(take.state, "eve"), set(0.5), T0, "rx").outcome === "stale");
  const old = challenge(take.state, "fay");
  const reset = vacate(take.state, T0 + 3 * DAY, "reset").state;
  check("a challenge played on an old cycle is stale", judge(reset, old, set(0.5), T0 + 3 * DAY, "rx").outcome === "stale");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── simultaneous challenges ──────────────────────");
{
  // Two challengers open against the same reign; both settle. Whatever the order, the
  // holder at the end is the best qualifying run set, the first reign ends once, and there
  // is exactly one live reign.
  const base = judge(empty(), challenge(empty(), "hold"), set(0.0), T0, "r0").state;
  const a = challenge(base, "a");
  const b = challenge(base, "b");
  const run = (first: [Challenge, number], second: [Challenge, number]) => {
    const j1 = judge(base, first[0], set(first[1]), T0 + 1, "x1");
    const j2 = judge(j1.state, second[0], set(second[1]), T0 + 2, "x2");
    return { j1, j2 };
  };
  const equal = run([a, 0.02], [b, 0.02]);
  check("two equal winning scores: exactly one take", [equal.j1.outcome, equal.j2.outcome].filter((o) => o === "took").length === 1);
  check("the second is judged against the new holder and defends", equal.j2.outcome === "defended" && equal.j2.judgedReignId === "x1");
  for (const [label, sa, sb, want] of [
    ["b better, a first", 0.02, 0.03, "b"],
    ["b better, b first", 0.02, 0.03, "b"],
    ["a better, a first", 0.04, 0.03, "a"],
    ["only a beats the holder", 0.01, -0.01, "a"],
  ] as const) {
    const order = label.endsWith("b first") ? run([b, sb], [a, sa]) : run([a, sa], [b, sb]);
    check(`final holder is the best score (${label})`, order.j2.state.reign?.holderId === want, order.j2.state.reign?.holderId);
  }

  // Random batches: N challengers against one reign, settled in a random order.
  const rand = seededRandom("simultaneous");
  let bad = 0;
  for (let trial = 0; trial < 3000; trial++) {
    const n = 2 + Math.floor(rand() * 5);
    let state = base;
    const opened = Array.from({ length: n }, (_, i) => ({ c: challenge(base, `p${i}`), score: (rand() - 0.5) * 0.1, tiers: (rand() < 0.15 ? ["consistent", "rejected", "verified"] : ["consistent", "verified", "consistent"]) as RunTier[] }));
    for (let i = opened.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [opened[i], opened[j]] = [opened[j], opened[i]]; }
    const ended = new Map<string, number>();
    let takes = 0;
    for (const [i, o] of opened.entries()) {
      const j = judge(state, o.c, set(o.score, o.tiers), T0 + i, `t${trial}-${i}`);
      if (j.ended) ended.set(j.ended.id, (ended.get(j.ended.id) ?? 0) + 1);
      if (j.outcome === "took") takes++;
      state = j.state;
    }
    const best = Math.max(0, ...opened.filter((o) => !o.tiers.includes("rejected")).map((o) => o.score));
    const holderScore = state.reign!.matchScore;
    if (Math.abs(holderScore - best) > CROWN_DRAW_EPSILON || [...ended.values()].some((v) => v > 1) || takes !== ended.size) bad++;
  }
  check("3000 random batches: best qualifying score holds, no reign ends twice, one take per ended reign", bad === 0, `${bad} bad`);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── lapse and expiry ─────────────────────────────");
{
  let s = judge(empty(), challenge(empty(), "ana"), set(0.01), T0, "r1").state;
  s = judge(s, challenge(s, "ben"), set(-0.01), T0 + DAY, "rx").state;
  check("a reign is not due before the cap", !lapseDue(s, T0 + REIGN_CAP_MS - 1, false));
  check("a reign is due at the cap", lapseDue(s, T0 + REIGN_CAP_MS, false));
  check("a challenge being played holds the lapse", !lapseDue(s, T0 + REIGN_CAP_MS + HOUR, true));
  check("a vacant Crown never lapses", !lapseDue(empty(), T0 + 10 * REIGN_CAP_MS, false));
  const v = vacate(s, T0 + REIGN_CAP_MS, "lapsed");
  check("a lapse empties the Crown onto a new cycle with no scenarios", v.state.reign === null && v.state.cycle === s.cycle + 1 && v.state.scenarioIds === null);
  check("the holder is told, with their defences", v.notice?.kind === "lapsed" && v.notice.playerId === "ana" && v.notice.defences === 1 && v.notice.reignMs === REIGN_CAP_MS);
  check("the lapse notice says the Crown is vacant again", noticeText(v.notice!, "Intermediate", null).includes("vacant again, on three new scenarios"));
  const reclaim = judge(v.state, challenge(v.state, "ana"), set(-0.2), T0 + REIGN_CAP_MS + 1, "r9");
  check("the old holder may claim the new cycle", reclaim.outcome === "took" && reclaim.state.reign?.holderId === "ana");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── who may challenge ────────────────────────────");
{
  const s = judge(empty(), challenge(empty(), "ana"), set(0.01), T0, "r1").state;
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
        reign: { id: "r1", holderId: "ana", matchScore: 0.031, startedAt: T0 - 2 * DAY, defences: 3, challenges: 4, lowestTier: "verified", provisional: false } },
      { category: "Speed Switching", window: 0, cycle: 0, scenarioIds: [4, 5, 6], live: 0,
        reign: { id: "r2", holderId: "me", matchScore: -0.004, startedAt: T0 - HOUR, defences: 0, challenges: 0, lowestTier: "consistent", provisional: true } },
      { category: "Speed Switching", window: 2, cycle: 1, scenarioIds: [7, 8, 9], live: 0, reign: null },
    ],
    history: Array.from({ length: 8 }, (_, i) => ({
      category: "Precise Tracking", window: 1, holderId: i % 2 ? "ben" : "cat", startedAt: T0 - (20 - i) * DAY, endedAt: T0 - (19 - i) * DAY,
      defences: i, endReason: "dethroned" as const, endedBy: "ana", matchScore: 0.01 * i,
    })),
    names: new Map([["ana", "Ana"], ["ben", "Ben"], ["cat", "<b>Cat</b>"], ["me", "Me"]]),
    scenarioNames: new Map([[1, "Smoothbot Intermediate"], [2, "waldoTS Intermediate"], [3, "Smoothbot Novice"]]),
    viewerId: "me",
    now: T0,
    lastChallenge: new Map([[crownKey("Precise Tracking", 2), T0 - HOUR]]),
    openChallenge: null,
    viewerBusy: false,
    notices: [
      { id: "n1", kind: "dethroned", category: "Precise Tracking", window: 1, defences: 3, reignMs: 3 * DAY, otherName: "Ana", createdAt: T0 - HOUR },
      { id: "n2", kind: "defended", category: "Speed Switching", window: 0, defences: 1, reignMs: HOUR, otherName: "Ben", createdAt: T0 },
    ],
  };
  const board = buildBoard(input);
  const card = (c: string, w: number) => board.crowns.find((x) => x.key === crownKey(c, w))!;
  check("every cell of the season is on the board", board.crowns.length === 8 && board.bands.length === 4 && board.categories.length === 2);
  check("a held Crown shows holder, bar, defences and the reign's end", card("Precise Tracking", 1).holder?.name === "Ana" &&
    card("Precise Tracking", 1).bar === 0.031 && card("Precise Tracking", 1).defences === 3 &&
    card("Precise Tracking", 1).reignEndsAt === new Date(T0 - 2 * DAY + REIGN_CAP_MS).toISOString());
  check("a held Crown offers Challenge", card("Precise Tracking", 1).action.kind === "challenge");
  check("a vacant Crown offers Claim", card("Speed Switching", 2).action.kind === "claim" && card("Speed Switching", 2).status === "vacant");
  check("a Crown you hold says so", card("Speed Switching", 0).action.kind === "yours" && board.holding === 1);
  check("a Crown you challenged today shows when it opens again", card("Precise Tracking", 2).action.kind === "cooldown" &&
    (card("Precise Tracking", 2).action as { availableAt: string }).availableAt === new Date(T0 - HOUR + CHALLENGE_COOLDOWN_MS).toISOString());
  check("history is newest first, five at most", card("Precise Tracking", 1).history.length === 5 &&
    Date.parse(card("Precise Tracking", 1).history[0].endedAt) > Date.parse(card("Precise Tracking", 1).history[1].endedAt));
  check("names are passed through as text, for the renderer to escape", card("Precise Tracking", 1).history.some((h) => h.holder === "<b>Cat</b>"));
  check("notices come newest first, as sentences", board.notices[0].id === "n2" && board.notices[1].text.startsWith("You lost the Precise Tracking Crown (Intermediate) to Ana after 3 defences"));
  const busyBoard = buildBoard({ ...input, viewerBusy: true });
  check("a player in another match is told to finish it", busyBoard.crowns.find((c) => c.key === crownKey("Precise Tracking", 1))!.action.kind === "busy");
  const playing = buildBoard({ ...input, openChallenge: { key: crownKey("Precise Tracking", 1), matchId: "m" } });
  check("the Crown you are challenging shows your open match", playing.crowns.find((c) => c.key === crownKey("Precise Tracking", 1))!.action.kind === "playing");
  // The board carries a holder's bar and nothing else of their result.
  const forbidden = ["score", "baseline", "deltas", "rounds", "runIds", "rating"];
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (forbidden.includes(k)) found.push(`${path}.${k}`); walk(x, `${path}.${k}`); }
  };
  walk(board, "board");
  check("the board carries no raw scores, baselines, rounds or ratings", found.length === 0, found.join(", "));
}

/* ------------------------------------------------------------------------------- */
console.log("\n── why a cap and a cooldown: replayed ───────────");
{
  // Box-Muller over the repository's own seeded PRNG.
  const SIGMA = 0.0445;
  const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()) * SIGMA;

  // 1. Records: with exchangeable players the next challenger takes it 1 time in m+1.
  {
    const r = seededRandom("records");
    const hits = new Map<number, [number, number]>();
    for (let t = 0; t < 20000; t++) {
      let best = gauss(r);
      for (let m = 1; m <= 10; m++) {
        const x = gauss(r);
        const [h, n] = hits.get(m) ?? [0, 0];
        hits.set(m, [h + (beats(x, best) ? 1 : 0), n + 1]);
        if (beats(x, best)) best = x;
      }
    }
    const rows = [1, 3, 5, 10].map((m) => { const [h, n] = hits.get(m)!; return { m, rate: h / n, theory: 1 / (m + 1) }; });
    console.log("       qualifying sets so far   next challenger takes it   1/(m+1)");
    for (const x of rows) console.log(`       ${String(x.m).padStart(10)}               ${(100 * x.rate).toFixed(1).padStart(5)}%               ${(100 * x.theory).toFixed(1)}%`);
    check("the chance of a take falls as 1/(m+1)", rows.every((x) => Math.abs(x.rate - x.theory) < 0.015));
  }

  // 2. The cap: five players, each challenging a given Crown on about half their days, one
  //    challenge a day each (the cooldown), eight weeks. How often does the Crown change
  //    hands in week 8, with and without a 7-day reign cap?
  const simulate = (players: number, capped: boolean, seed: string) => {
    const r = seededRandom(seed);
    let holder: number | null = null;
    let bar = 0;
    let started = 0;
    const takesByWeek = Array(8).fill(0);
    for (let day = 0; day < 56; day++) {
      if (capped && holder !== null && day - started >= 7) holder = null;
      const today = Array.from({ length: players }, (_, p) => p).filter((p) => p !== holder && r() < 0.5);
      for (let i = today.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [today[i], today[j]] = [today[j], today[i]]; }
      for (const p of today) {
        const x = gauss(r);
        if (holder === null || beats(x, bar)) { if (holder !== null) takesByWeek[Math.floor(day / 7)]++; holder = p; bar = x; started = day; }
      }
    }
    return takesByWeek;
  };
  const trials = 400;
  for (const players of [2, 5, 15]) {
    let capped8 = 0, open8 = 0, capped1 = 0;
    for (let t = 0; t < trials; t++) {
      const c = simulate(players, true, `cap-${players}-${t}`);
      const o = simulate(players, false, `cap-${players}-${t}`);
      capped8 += c[7]; open8 += o[7]; capped1 += c[0];
    }
    console.log(`       ${String(players).padStart(2)} players: changes of hand in week 8, capped ${(capped8 / trials).toFixed(2)}, uncapped ${(open8 / trials).toFixed(2)}  (week 1: ${(capped1 / trials).toFixed(2)})`);
    if (players === 5) {
      check("with a cap, week 8 is as alive as week 1", capped8 / trials > 0.7 * (capped1 / trials));
      check("without one, week 8 changes hands well under half as often", open8 < 0.5 * capped8, `${(open8 / trials).toFixed(2)} vs ${(capped8 / trials).toFixed(2)}`);
    }
  }

  // 3. The cooldown: one player who would challenge five times a day against four who play
  //    once. Share of Crown-days the grinder holds, with and without a cooldown.
  const share = (grinderAttempts: number, seed: string) => {
    const r = seededRandom(seed);
    let holder: number | null = null, bar = 0, started = 0, held = 0, days = 0;
    for (let day = 0; day < 56; day++) {
      if (holder !== null && day - started >= 7) holder = null;
      const attempts: number[] = [];
      for (let p = 0; p < 5; p++) { if (p === holder) continue; for (let k = 0; k < (p === 0 ? grinderAttempts : 1); k++) attempts.push(p); }
      for (let i = attempts.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [attempts[i], attempts[j]] = [attempts[j], attempts[i]]; }
      for (const p of attempts) { const x = gauss(r); if (holder === null || beats(x, bar)) { holder = p; bar = x; started = day; } }
      days++; if (holder === 0) held++;
    }
    return held / days;
  };
  let free = 0, limited = 0;
  for (let t = 0; t < trials; t++) { free += share(5, `grind-${t}`); limited += share(1, `grind-${t}`); }
  console.log(`       a 5-a-day grinder among 5 players holds the Crown ${(100 * free / trials).toFixed(0)}% of days without a cooldown, ${(100 * limited / trials).toFixed(0)}% with one (fair share 20%)`);
  check("without a cooldown the grinder takes well over a fair share", free / trials > 0.4);
  check("with one, the grinder is back near a fair share", Math.abs(limited / trials - 0.2) < 0.06);
}

console.log(failures === 0 ? "\nOK: Crown rules hold" : `\n${failures} check(s) failed`);
if (failures > 0) process.exit(1);
