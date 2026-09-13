/**
 * Validate the tournament engine, the reading of a settled leg, and the public view.
 *
 *   npx tsx src/core/tournament/validateTournament.ts
 *
 * There is no corpus to measure against - nobody has played a tournament - so, like the
 * duel validator, what this checks is exhaustiveness and invariants: every supported
 * format played to a champion, every leg status crossed with every verdict, and the whole
 * public view walked for anything that looks like a score.
 *
 * Every refusal is checked alongside something that must be allowed. An engine that threw
 * on everything would pass every "is this refused?" line in the file, which is the failure
 * mode `validateDuels.ts` exists to avoid being blind to, and this one inherits the rule.
 */

import {
  addEntrant,
  assignSeeds,
  cancelTournament,
  createTournament,
  getReadyFixtures,
  getStandings,
  recordResult,
  removeEntrant,
  setCheckIn,
  startTournament,
  type Config,
  type Fixture,
  type Receipt,
  type Tournament,
} from "./tournament.ts";
import {
  cleanDisplayName,
  LEFT_UNPLAYED,
  minimumToStart,
  nextFreeSeed,
  readLeg,
  receiptFor,
  type LegFacts,
  type MatchStatus,
} from "./policy.ts";
import { buildSummary, buildView, type LegSummary, type TournamentView } from "./view.ts";
import { seededRandom } from "../match/scenarioSelection.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** Threw, and said something matching. A refusal that fires for the wrong reason is not the refusal under test. */
function refuses(fn: () => unknown, pattern: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return pattern.test(err instanceof Error ? err.message : String(err));
  }
}

function config(
  groupCount: 2 | 4 | 8,
  groupSize: number,
  qualifiers: 1 | 2 = 1,
  seeding: "seeded" | "shuffle" = "seeded",
): Config {
  return { name: `Test ${groupCount}x${groupSize}`, groupCount, groupSize, qualifiers, seeding, randomSeed: "test-seed" };
}

function registered(groupCount: 2 | 4 | 8, groupSize: number, qualifiers: 1 | 2 = 1, count = groupCount * groupSize): Tournament {
  let state = createTournament("cup", config(groupCount, groupSize, qualifiers));
  for (let i = 1; i <= count; i += 1) {
    state = addEntrant(state, { id: `p${i}`, name: `Player ${i}`, seed: i, checkedIn: true });
  }
  return startTournament(state);
}

function resultFor(fixture: Fixture, id: string, kind: "win" | "draw" | "void" | "forfeit" = "win", attempt = fixture.attempt): Receipt {
  const outcome = kind === "win" ? { kind, winnerId: fixture.playerA }
    : kind === "forfeit" ? { kind, winnerId: fixture.playerA, reason: "no show" }
      : { kind };
  return { id, fixtureId: fixture.id, attempt, outcome };
}

function completeAllGroups(state: Tournament): Tournament {
  let current = state;
  let guard = 0;
  while (current.phase === "groups" && guard++ < 1000) {
    for (const fixture of getReadyFixtures(current)) current = recordResult(current, resultFor(fixture, `r-${fixture.id}`));
  }
  return current;
}

function completeEverything(state: Tournament): Tournament {
  let current = state;
  let guard = 0;
  while (current.phase !== "completed" && guard++ < 1000) {
    const ready = getReadyFixtures(current);
    if (ready.length === 0) break;
    for (const fixture of ready) current = recordResult(current, resultFor(fixture, `all-${fixture.id}`));
  }
  return current;
}

function main(): void {
  console.log("\n── every supported format reaches a champion ─────");

  const capacities: Array<[2 | 4 | 8, number, 1 | 2, number]> = [
    [2, 3, 1, 6], [2, 4, 1, 8], [4, 3, 1, 12], [4, 4, 1, 16], [8, 4, 1, 32], [8, 8, 2, 64],
  ];
  let reached = 0;
  for (const [groups, size, qualifiers, count] of capacities) {
    const finished = completeEverything(registered(groups, size, qualifiers, count));
    if (finished.phase === "completed" && finished.championId) reached++;
  }
  check("six representative capacities each crown a champion", reached === capacities.length,
    `${reached}/${capacities.length}`);

  let formats = 0;
  let formatFailures: string[] = [];
  for (const groupCount of [2, 4, 8] as const) {
    for (let groupSize = 3; groupSize <= 8; groupSize++) {
      for (const qualifiers of [1, 2] as const) {
        if (qualifiers >= groupSize) continue;
        formats++;
        const finished = completeEverything(registered(groupCount, groupSize, qualifiers));
        const expected = groupCount * groupSize * (groupSize - 1) / 2 + groupCount * qualifiers - 1;
        const rowsOk = finished.groups.every((g) => {
          const standings = getStandings(finished, g.id);
          return standings.every((s) => s.played === groupSize - 1) && new Set(standings.map((s) => s.rank)).size === groupSize;
        });
        if (finished.phase !== "completed" || finished.fixtures.length !== expected || !rowsOk) {
          formatFailures.push(`${groupCount}x${groupSize}/${qualifiers}: ${finished.fixtures.length} of ${expected}`);
        }
      }
    }
  }
  check(`all ${formats} full-capacity formats play exactly the fixtures they should`,
    formats === 36 && formatFailures.length === 0, formatFailures.join("; ") || `${formats} formats`);

  const standard = registered(4, 4, 2, 16);
  check("the default field is 16 players, 24 group fixtures and 7 in the bracket",
    standard.fixtures.length === 24 && completeEverything(standard).fixtures.length === 31);

  console.log("\n── the draw ─────────────────────────────────────");

  const snake = registered(4, 4, 1, 14);
  check("fourteen into four groups is balanced 3/3/4/4",
    snake.groups.map((g) => g.entrantIds.length).join() === "3,3,4,4");
  check("and the snake runs across and back",
    JSON.stringify(snake.groups.map((g) => g.entrantIds)) ===
      JSON.stringify([["p1", "p8", "p9"], ["p2", "p7", "p10"], ["p3", "p6", "p11", "p14"], ["p4", "p5", "p12", "p13"]]));

  let shuffled = createTournament("cup-shuffled", config(4, 4, 1, "shuffle"));
  for (let i = 1; i <= 14; i += 1) shuffled = addEntrant(shuffled, { id: `p${i}`, name: `P${i}`, seed: i, checkedIn: true });
  shuffled = startTournament(shuffled);
  check("a random draw differs from the seeded one",
    JSON.stringify(shuffled.groups.map((g) => g.entrantIds)) !== JSON.stringify(snake.groups.map((g) => g.entrantIds)));

  const robin = registered(4, 3, 1, 12);
  let robinOk = true;
  for (const group of robin.groups) {
    const fixtures = robin.fixtures.filter((f) => f.groupId === group.id);
    const pairs = new Set(fixtures.map((f) => [f.playerA, f.playerB].sort().join("/")));
    if (fixtures.length !== group.entrantIds.length * (group.entrantIds.length - 1) / 2 || pairs.size !== fixtures.length) robinOk = false;
    for (const round of new Set(fixtures.map((f) => f.round))) {
      const players = fixtures.filter((f) => f.round === round).flatMap((f) => [f.playerA, f.playerB]);
      if (new Set(players).size !== players.length) robinOk = false;
    }
  }
  check("every pair in a group meets once, and nobody plays twice in a round", robinOk);

  console.log("\n── registration ─────────────────────────────────");

  let reg = createTournament("freeze", config(2, 3));
  for (const [id, checkedIn] of [["a", true], ["b", true], ["c", false], ["d", true], ["e", true], ["f", true]] as const) {
    reg = addEntrant(reg, { id, name: id.toUpperCase(), seed: nextFreeSeed(reg), checkedIn });
  }
  check("five checked in of six cannot start a 2x3", refuses(() => startTournament(reg), /at least 6/));
  check("minimumToStart agrees with the engine", minimumToStart(reg.config) === 6);
  reg = setCheckIn(reg, "c", true);
  const regStarted = startTournament(reg);
  check("checking the sixth in lets it start", regStarted.phase === "groups");
  check("nobody can enter once it has started",
    refuses(() => addEntrant(regStarted, { id: "z", name: "Z", seed: 9, checkedIn: true }), /registration/));
  check("nobody can check out once it has started", refuses(() => setCheckIn(regStarted, "a", false), /registration/));
  check("nobody can be removed once it has started", refuses(() => removeEntrant(regStarted, "a"), /registration/));
  check("a full field refuses a seventh",
    refuses(() => addEntrant(reg, { id: "g", name: "G", seed: 7, checkedIn: true }), /capacity/));

  let excluded = createTournament("exclude", config(2, 4));
  for (let i = 1; i <= 8; i += 1) excluded = addEntrant(excluded, { id: `x${i}`, name: `X${i}`, seed: i, checkedIn: i !== 8 });
  const excludedStarted = startTournament(excluded);
  check("an entrant who never checked in is left out of the draw",
    !excludedStarted.groups.some((g) => g.entrantIds.includes("x8")) &&
      excludedStarted.groups.reduce((n, g) => n + g.entrantIds.length, 0) === 7);

  let gaps = createTournament("gaps", config(2, 3));
  gaps = addEntrant(gaps, { id: "a", name: "A", seed: 1, checkedIn: true });
  gaps = addEntrant(gaps, { id: "b", name: "B", seed: 2, checkedIn: true });
  gaps = addEntrant(gaps, { id: "c", name: "C", seed: 3, checkedIn: true });
  gaps = removeEntrant(gaps, "b");
  check("a seed freed by somebody leaving is reused", nextFreeSeed(gaps) === 2);

  const seededAgain = assignSeeds(reg, ["f", "e", "d", "c", "b", "a"]);
  check("seeds can be re-ordered before the draw",
    seededAgain.entrants.map((e) => `${e.id}${e.seed}`).join() === "f1,e2,d3,c4,b5,a6");
  check("and doing so moves the revision once", seededAgain.revision === reg.revision + 1);
  check("a seed order missing somebody is refused", refuses(() => assignSeeds(reg, ["a", "b"]), /every entrant/));
  check("one naming somebody twice is refused",
    refuses(() => assignSeeds(reg, ["a", "a", "b", "c", "d", "e"]), /twice/));
  check("one naming a stranger is refused",
    refuses(() => assignSeeds(reg, ["a", "b", "c", "d", "e", "zz"]), /unknown/));
  check("and none of it is possible after the draw",
    refuses(() => assignSeeds(regStarted, regStarted.entrants.map((e) => e.id)), /registration/));

  console.log("\n── standings ────────────────────────────────────");

  let cycle = registered(2, 3, 1, 6);
  const cycleGroup = cycle.groups[0];
  const beats = new Map<string, string>([
    [[cycleGroup.entrantIds[0], cycleGroup.entrantIds[1]].sort().join("/"), cycleGroup.entrantIds[0]],
    [[cycleGroup.entrantIds[1], cycleGroup.entrantIds[2]].sort().join("/"), cycleGroup.entrantIds[1]],
    [[cycleGroup.entrantIds[0], cycleGroup.entrantIds[2]].sort().join("/"), cycleGroup.entrantIds[2]],
  ]);
  let cycleGuard = 0;
  while (cycle.phase === "groups" && cycleGuard++ < 100) {
    const fixture = getReadyFixtures(cycle).find((f) => f.groupId === cycleGroup.id);
    if (fixture) {
      const key = [fixture.playerA, fixture.playerB].sort().join("/");
      cycle = recordResult(cycle, { id: `cycle-${fixture.id}`, fixtureId: fixture.id, attempt: 1, outcome: { kind: "win", winnerId: beats.get(key)! } });
    } else {
      const other = getReadyFixtures(cycle)[0];
      cycle = recordResult(cycle, resultFor(other, `other-${other.id}`));
    }
  }
  const cycleTable = getStandings(cycle, cycleGroup.id);
  check("a three-way circle of wins is level on points and on the mini-table",
    new Set(cycleTable.map((s) => s.points)).size === 1 && new Set(cycleTable.map((s) => s.miniPoints)).size === 1);
  check("so the frozen seed decides it, and every row says so",
    cycleTable.every((s) => s.seedFallback) &&
      cycleTable.map((s) => s.playerId).join() === [...cycleGroup.entrantIds].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join());

  const voided = registered(2, 3, 1, 6);
  const voidFixture = getReadyFixtures(voided)[0];
  const afterVoid = recordResult(voided, resultFor(voidFixture, "group-void", "void"));
  const reopened = afterVoid.fixtures.find((f) => f.id === voidFixture.id)!;
  check("a group void reopens the same fixture at the next attempt",
    reopened.status === "pending" && reopened.attempt === 2 && reopened.history.length === 1);
  check("and counts for nobody in the table",
    getStandings(afterVoid, voidFixture.groupId!).every((s) => s.played === 0));
  const afterDraw = recordResult(afterVoid, resultFor(reopened, "group-draw", "draw", 2));
  check("a group draw stands", afterDraw.fixtures.find((f) => f.id === voidFixture.id)!.status === "completed");

  console.log("\n── the bracket ──────────────────────────────────");

  const toBracket = completeAllGroups(registered(4, 4, 2, 16));
  const firstRound = toBracket.fixtures.filter((f) => f.stage === "playoff" && f.round === 1).sort((a, b) => a.slot - b.slot);
  const groupByPlayer = new Map(toBracket.groups.flatMap((g) => g.entrantIds.map((p) => [p, g.id] as const)));
  const splitOk = toBracket.groups.every((group) => {
    const slots = firstRound.flatMap((f) => [f.playerA, f.playerB].filter((p) => groupByPlayer.get(p) === group.id).map(() => f.slot));
    return slots.length === 2 && Math.floor(slots[0] / 2) !== Math.floor(slots[1] / 2);
  });
  check("the two qualifiers from one group start in opposite halves", firstRound.length === 4 && splitOk);

  // The view labels the empty bracket before anyone has qualified. Those labels have to
  // describe the ties the engine will actually build, or the bracket preview is a promise
  // the draw breaks.
  const labelView = buildView(viewInput(toBracket, null, []));
  const placeOf = new Map<string, string>();
  toBracket.groups.forEach((g, index) =>
    getStandings(toBracket, g.id).slice(0, 2).forEach((s) => placeOf.set(s.playerId, `${String.fromCharCode(65 + index)}${s.rank}`)));
  const labelsAgree = labelView.bracket[0].slots.every((slot, i) =>
    placeOf.get(firstRound[i].playerA) === slot.aFrom && placeOf.get(firstRound[i].playerB) === slot.bFrom);
  check("the bracket's labels name the places the engine actually draws from", labelsAgree,
    labelView.bracket[0].slots.map((s) => `${s.aFrom}v${s.bFrom}`).join(" "));

  console.log("\n── recording results ────────────────────────────");

  const early = registered(2, 3, 1, 6);
  const later = early.fixtures.find((f) => f.stage === "group" && f.round > 1)!;
  check("a fixture in a later round is not ready yet", refuses(() => recordResult(early, resultFor(later, "premature")), /not ready/));

  const playoffs = completeAllGroups(registered(4, 3, 1, 12));
  const final4 = getReadyFixtures(playoffs)[0];
  const draw = resultFor(final4, "draw-1", "draw");
  const replay = recordResult(playoffs, draw);
  check("a playoff draw replays the fixture", replay.fixtures.find((f) => f.id === final4.id)!.attempt === 2);
  check("the same receipt twice is the same state, not a second result", recordResult(replay, draw) === replay);
  check("a receipt for an attempt that has moved on is refused",
    refuses(() => recordResult(replay, resultFor(final4, "stale", "win", 1)), /stale/));
  const voidAgain = recordResult(replay, resultFor(final4, "void-1", "void", 2));
  check("a playoff void replays it again", voidAgain.fixtures.find((f) => f.id === final4.id)!.attempt === 3);
  check("a receipt id reused with a different verdict is refused",
    refuses(() => recordResult(voidAgain, resultFor(final4, "void-1", "win", 3)), /different payload/));
  const decided = recordResult(voidAgain, resultFor(final4, "resolve", "forfeit", 3));
  check("a forfeit decides it", decided.fixtures.find((f) => f.id === final4.id)!.status === "completed");
  check("and re-delivering the forfeit changes nothing",
    recordResult(decided, resultFor(final4, "resolve", "forfeit", 3)) === decided);
  check("a forfeit with no reason is refused",
    refuses(() => recordResult(voidAgain, { id: "bare", fixtureId: final4.id, attempt: 3, outcome: { kind: "forfeit", winnerId: final4.playerA } }), /reason/));
  check("a winner who is not in the fixture is refused",
    refuses(() => recordResult(playoffs, { id: "who", fixtureId: final4.id, attempt: 1, outcome: { kind: "win", winnerId: "p99" } }), /participant/));
  check("a draw carrying a winner is refused",
    refuses(() => recordResult(playoffs, { id: "odd", fixtureId: final4.id, attempt: 1, outcome: { kind: "draw", winnerId: final4.playerA } }), /winnerId/));

  let immutable = createTournament("immutable", config(2, 3));
  const before = JSON.stringify(immutable);
  const next = addEntrant(immutable, { id: "a", name: "A", seed: 1, checkedIn: true });
  check("reducers leave their input alone", JSON.stringify(immutable) === before && next.config !== immutable.config);
  const cancelled = cancelTournament(next, "host stopped the event");
  check("a cancelled tournament stays cancelled", refuses(() => cancelTournament(cancelled, "again"), /terminal/));
  check("and plays nothing", getReadyFixtures(cancelTournament(registered(2, 3), "stop")).length === 0);

  check("a group size of two is refused", refuses(() => createTournament("bad", { ...config(2, 3), groupSize: 2 }), /groupSize/));
  check("an empty random seed is refused", refuses(() => createTournament("bad", { ...config(2, 3), randomSeed: "" }), /randomSeed/));
  immutable = addEntrant(immutable, { id: "p", name: "P", seed: 1, checkedIn: true });
  check("a seed that is not a number is refused",
    refuses(() => addEntrant(immutable, { id: "q", name: "Q", seed: Number.NaN, checkedIn: true }), /seed/));
  check("a duplicate seed is refused",
    refuses(() => addEntrant(immutable, { id: "q", name: "Q", seed: 1, checkedIn: true }), /seed/));
  check("an id with a control character is refused",
    refuses(() => addEntrant(immutable, { id: "q", name: "Q", seed: 2, checkedIn: true }), /control/));

  console.log("\n── reading a settled leg ────────────────────────");

  const statuses: MatchStatus[] = ["open", "awaiting_runs", "settled", "void"];
  const results = ["win", "loss", "draw", null] as const;
  const scores = [0.03, null];
  let cases = 0;
  const kinds = new Map<string, number>();
  let strangers = 0;
  let bareForfeits = 0;
  let pendingWrong = 0;
  for (const leg of [1, 2] as const) {
    for (const status of statuses) {
      for (const result of results) {
        for (const matchScore of scores) {
          for (const side of [{ matchScore, result }, null]) {
            cases++;
            const facts: LegFacts = { leg, status, playerId: "me", opponentId: "them", side };
            const reading = readLeg(facts);
            const key = reading.kind === "result" ? `${reading.kind}:${reading.outcome.kind}` : reading.kind;
            kinds.set(key, (kinds.get(key) ?? 0) + 1);
            if ((status === "open" || status === "awaiting_runs") !== (reading.kind === "pending")) pendingWrong++;
            if (reading.kind === "result") {
              const winner = reading.outcome.winnerId;
              if (winner !== undefined && winner !== "me" && winner !== "them") strangers++;
              if (reading.outcome.kind === "forfeit" && !reading.outcome.reason) bareForfeits++;
            }
          }
        }
      }
    }
  }
  check(`every leg, status, verdict and score has an answer: ${cases} of them`, cases === 2 * 4 * 4 * 2 * 2);
  check("a leg still being played is pending, and only then", pendingWrong === 0, `${pendingWrong} wrong`);
  check("no reading names a winner outside the fixture", strangers === 0);
  check("every forfeit carries a reason", bareForfeits === 0);
  // Non-vacuity: a readLeg that voided everything would pass the three checks above.
  const needed = ["pending", "first-leg-played", "result:win", "result:draw", "result:void", "result:forfeit"];
  check("every kind of reading actually occurs", needed.every((k) => (kinds.get(k) ?? 0) > 0),
    [...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(", "));

  const settled = (leg: 1 | 2, result: "win" | "loss" | "draw" | null, matchScore: number | null) =>
    readLeg({ leg, status: "settled", playerId: "me", opponentId: "them", side: { matchScore, result } });
  check("a scored first leg waits for the answer", settled(1, null, 0.02).kind === "first-leg-played");
  check("a void first leg replays the fixture",
    (() => { const r = readLeg({ leg: 1, status: "void", playerId: "me", opponentId: "them", side: null }); return r.kind === "result" && r.outcome.kind === "void"; })());
  check("a second-leg win goes to the player who answered",
    (() => { const r = settled(2, "win", 0.04); return r.kind === "result" && r.outcome.kind === "win" && r.outcome.winnerId === "me"; })());
  check("a second-leg loss goes to the player who went first",
    (() => { const r = settled(2, "loss", -0.01); return r.kind === "result" && r.outcome.kind === "win" && r.outcome.winnerId === "them"; })());
  check("a second leg abandoned before a run is a forfeit to the other side",
    (() => { const r = settled(2, "loss", null); return r.kind === "result" && r.outcome.kind === "forfeit" && r.outcome.winnerId === "them" && r.outcome.reason === LEFT_UNPLAYED; })());
  check("a second-leg draw is a draw", (() => { const r = settled(2, "draw", 0); return r.kind === "result" && r.outcome.kind === "draw"; })());
  check("one match can only ever be one receipt", receiptFor("f", 1, "abc", { kind: "void" }).id === "m:abc");

  console.log("\n── the whole pipeline, legs to champion ─────────");

  // Every result below goes through readLeg and receiptFor, the way the server reaches
  // recordResult, and every receipt is delivered twice. Voids, forfeits and draws are
  // mixed in at rates well above anything real, because they are the paths that loop.
  let runs = 0;
  const pipelineProblems: string[] = [];
  for (const groupCount of [2, 4, 8] as const) {
    for (let groupSize = 3; groupSize <= 8; groupSize++) {
      for (const qualifiers of [1, 2] as const) {
        if (qualifiers >= groupSize) continue;
        for (const seed of ["a", "b", "c"]) {
          runs++;
          const problem = playThroughLegs(registered(groupCount, groupSize, qualifiers), seededRandom(`${groupCount}${groupSize}${qualifiers}${seed}`));
          if (problem) pipelineProblems.push(`${groupCount}x${groupSize}/${qualifiers}/${seed}: ${problem}`);
        }
      }
    }
  }
  check(`${runs} tournaments played leg by leg, every receipt delivered twice`,
    runs === 108 && pipelineProblems.length === 0, pipelineProblems.slice(0, 3).join("; ") || "all crowned");

  console.log("\n── what the view says, and what it never says ───");

  let named = createTournament("view", config(2, 3, 1));
  const hostile = "‮evil  <img src=x onerror=alert(1)>";
  const names = [hostile, "x".repeat(80), "   ", "kestrel", "vanta", "Ossia"];
  names.forEach((name, i) => {
    named = addEntrant(named, { id: `v${i + 1}`, name: cleanDisplayName(name), seed: i + 1, checkedIn: true });
  });
  // Markup survives as text on purpose. Escaping is the renderer's job, at the one place
  // text becomes HTML, and the smoke test checks it there.
  check("a name loses its bidi override and control characters",
    named.entrants[0].name.startsWith("evil <img") && !/[ -‪-‮]/.test(named.entrants[0].name),
    JSON.stringify(named.entrants[0].name));
  check("a long name is clipped to 32 characters", [...named.entrants[1].name].length === 32);
  check("a blank name still reads as somebody", named.entrants[2].name === "player");

  const running = startTournament(named);
  const mid = recordResult(running, resultFor(getReadyFixtures(running)[0], "mid-1"));
  // Whoever has a fixture right now. A group of three sits one player out each round, so a
  // fixed id would sometimes be asking about somebody with a bye.
  const nextFixture = getReadyFixtures(mid)[0];
  const viewer = nextFixture.playerA;
  const opponent = nextFixture.playerB;
  const legSets: Array<[string, LegSummary[], string]> = [
    ["nobody has played", [], "play:1"],
    ["you are playing first", [leg(nextFixture, 1, viewer, true)], "resume:1"],
    ["your first three are in", [leg(nextFixture, 1, viewer, false)], "wait:1"],
    ["they are playing first", [leg(nextFixture, 1, opponent, true)], "wait:2"],
    ["their three are in", [leg(nextFixture, 1, opponent, false)], "play:2"],
    ["you are answering", [leg(nextFixture, 1, opponent, false), leg(nextFixture, 2, viewer, true)], "resume:2"],
  ];
  for (const [label, legs, expected] of legSets) {
    const view = buildView(viewInput(mid, viewer, legs));
    const got = view.next ? `${view.next.action}:${view.next.leg}` : "none";
    check(`next step when ${label}`, got === expected, got);
    const summary = buildSummary(viewInput(mid, viewer, legs));
    check(`  and the list agrees about whose turn it is`, summary.yourTurn === (expected.startsWith("play") || expected.startsWith("resume")));
  }
  const bystander = buildView(viewInput(mid, "not-entered", []));
  check("somebody not in the tournament has no next fixture", bystander.next === null && !bystander.you.entered);

  // Walk the whole object. Anything shaped like a score is a leak whatever it holds.
  const full = completeEverything(mid);
  const views: TournamentView[] = [buildView(viewInput(mid, viewer, [])), buildView(viewInput(full, viewer, []))];
  const forbidden = /score|delta|baseline|verif|rating|history|receipt|randomseed|minipoints/i;
  const leaked = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (forbidden.test(key) && key !== "scoreFieldsIncluded") leaked.add(key);
        walk(inner);
      }
    }
  };
  views.forEach(walk);
  check("no key in the view is a score, delta, baseline, rating or receipt", leaked.size === 0, [...leaked].join(", "));
  check("every view says so", views.every((v) => v.scoreFieldsIncluded === false));
  check("the forfeit reason recorded on a receipt never reaches the view",
    !JSON.stringify(buildView(viewInput(decided, null, []))).includes("no show"));
  check("the view's names are the cleaned ones", !JSON.stringify(views[0]).includes("‮"));
  check("a finished tournament names its champion", views[1].champion !== null && views[1].phase === "completed");
  const eliminated = full.entrants.find((e) => e.id !== full.championId)!;
  check("somebody knocked out is told so", buildView(viewInput(full, eliminated.id, [])).you.out);
  check("and the champion is not", !buildView(viewInput(full, full.championId!, [])).you.out);

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: tournament engine, leg reading and view validated");
}

function leg(fixture: Fixture, which: 1 | 2, playerId: string, live: boolean): LegSummary {
  return { fixtureId: fixture.id, attempt: fixture.attempt, leg: which, playerId, live };
}

function viewInput(state: Tournament, viewerId: string | null, legs: LegSummary[]) {
  return {
    state,
    hostId: "host",
    hostName: "host",
    viewerId,
    category: "Tracking",
    windowName: "Intermediate",
    createdAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    legs,
  };
}

/**
 * Play a tournament the way the server does: two legs per attempt, each read by
 * `readLeg`, each result delivered twice. Returns a description of the first thing that
 * went wrong, or null.
 */
function playThroughLegs(start: Tournament, random: () => number): string | null {
  let state = start;
  let guard = 0;
  while (state.phase === "groups" || state.phase === "playoffs") {
    if (guard++ > 20000) return "did not finish";
    const ready = getReadyFixtures(state);
    if (ready.length === 0) return `phase ${state.phase} has nothing to play`;
    for (const fixture of ready) {
      const first = random() < 0.5 ? fixture.playerA : fixture.playerB;
      const second = first === fixture.playerA ? fixture.playerB : fixture.playerA;
      const matchBase = `${fixture.id}#${fixture.attempt}`;

      const firstVoid = random() < 0.08;
      const one = readLeg({
        leg: 1, status: firstVoid ? "void" : "settled", playerId: first, opponentId: second,
        side: firstVoid ? null : { matchScore: 0.02, result: null },
      });

      let reading = one;
      let matchId = `${matchBase}:1`;
      if (one.kind === "first-leg-played") {
        const roll = random();
        const status: MatchStatus = roll < 0.07 ? "void" : "settled";
        const result = roll < 0.07 ? null : roll < 0.45 ? "win" : roll < 0.8 ? "loss" : roll < 0.92 ? "draw" : "loss";
        const matchScore = roll >= 0.92 ? null : 0.01;
        reading = readLeg({ leg: 2, status, playerId: second, opponentId: first, side: { matchScore, result } });
        matchId = `${matchBase}:2`;
      }
      if (reading.kind !== "result") return `a finished leg read as ${reading.kind}`;

      const receipt = receiptFor(fixture.id, fixture.attempt, matchId, reading.outcome);
      const applied = recordResult(state, receipt);
      if (applied.revision !== state.revision + 1) return `revision moved ${applied.revision - state.revision}`;
      if (recordResult(applied, receipt) !== applied) return "a redelivered receipt changed the state";
      state = applied;
    }
  }
  if (state.phase !== "completed" || !state.championId) return `ended in ${state.phase}`;
  if (!state.entrants.some((e) => e.id === state.championId)) return "champion is not an entrant";
  if (state.fixtures.some((f) => f.status === "completed" && f.outcome?.kind === "void")) return "a void completed a fixture";
  return null;
}

main();
