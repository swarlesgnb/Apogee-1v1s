/**
 * Validate live matchmaking.
 *
 * The property that matters most is **starvation-freedom**: a player at the extreme
 * top or bottom of the ladder must eventually be matched, or the queue quietly
 * abandons exactly the players most likely to complain. So the tests below simulate
 * populations, including deliberately hostile ones (a single outlier, an empty
 * category), and assert that everybody leaves the queue.
 *
 *   npx tsx src/core/match/validateLiveQueue.ts
 */

import { defaultRating, type Rating } from "../rating/glicko2.ts";
import {
  attemptPairings,
  DEFAULT_QUEUE_CONFIG,
  LiveQueue,
  toleranceAt,
  type QueueEntry,
} from "./liveQueue.ts";
import { seededRandom } from "./scenarioSelection.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const rating = (r: number, rd = 60): Rating => ({ rating: r, rd, volatility: 0.06 });

function entry(id: string, r: number, joinedAt = 0, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    playerId: id,
    displayName: id,
    rating: rating(r),
    category: "Clicking",
    difficulty: "Intermediate",
    joinedAt,
    ...over,
  };
}

console.log("── tolerance ────────────────────────────────────");

const cfg = DEFAULT_QUEUE_CONFIG;
check("tolerance starts tight", toleranceAt(cfg, 0) === cfg.initialTolerance);
check("tolerance widens with waiting",
  toleranceAt(cfg, 45_000) > toleranceAt(cfg, 0));
check("tolerance caps at the maximum",
  toleranceAt(cfg, 10_000_000) === cfg.maxTolerance);
check("tolerance never exceeds the maximum",
  [0, 1e3, 1e4, 1e5, 1e6].every((t) => toleranceAt(cfg, t) <= cfg.maxTolerance));

console.log("\n── pairing ──────────────────────────────────────");

const evenPair = attemptPairings([entry("a", 1500), entry("b", 1510)], 0);
check("two close players pair immediately", evenPair.pairings.length === 1);
check("nobody is left waiting", evenPair.waiting.length === 0);
check("the pairing is near even",
  Math.abs(evenPair.pairings[0].winProbability - 0.5) < 0.08,
  evenPair.pairings[0]?.winProbability.toFixed(3));
check("a fresh close pairing is not marked stretched",
  evenPair.pairings[0].stretched === false);

// A moderate gap: outside the initial tolerance, inside the maximum.
const moderate = [entry("a", 1500), entry("b", 1700)];
const nowPair = attemptPairings(moderate, 0);
check("a moderately mismatched pair does not pair immediately",
  nowPair.pairings.length === 0, `${nowPair.pairings.length}`);
check("they stay in the queue", nowPair.waiting.length === 2);

const later = attemptPairings(
  [entry("a", 1500), entry("b", 1700)],
  DEFAULT_QUEUE_CONFIG.widenOverMs,
);
check("after tolerance widens they do pair", later.pairings.length === 1);
check("the stretched pairing is flagged as such",
  later.pairings[0]?.stretched === true);

// A gap beyond the maximum tolerance must NEVER pair, however long the wait: pairing
// a 1200 against a 2400 is not a match, it is a waste of both players' time. Those
// players are released to an async match instead.
const hopeless = [entry("a", 1200), entry("b", 2400)];
check("a hopeless gap never pairs, even after a long wait",
  attemptPairings(hopeless, DEFAULT_QUEUE_CONFIG.widenOverMs * 10).pairings.length === 0);
const releasedInstead = attemptPairings(
  hopeless,
  DEFAULT_QUEUE_CONFIG.giveUpAfterMs + 1,
);
check("they are released to async rather than force-paired",
  releasedInstead.giveUp.length === 2 && releasedInstead.pairings.length === 0,
  `${releasedInstead.giveUp.length} released`);

const crossCategory = attemptPairings(
  [entry("a", 1500), entry("b", 1500, 0, { category: "Tracking" })],
  0,
);
check("different categories never pair", crossCategory.pairings.length === 0);

const crossDifficulty = attemptPairings(
  [entry("a", 1500), entry("b", 1500, 0, { difficulty: "Advanced" })],
  0,
);
check("different difficulties never pair", crossDifficulty.pairings.length === 0);

const rematch = attemptPairings(
  [entry("a", 1500, 0, { recentOpponentIds: new Set(["b"]) }), entry("b", 1500)],
  0,
);
check("an immediate rematch is avoided", rematch.pairings.length === 0);

const alone = attemptPairings([entry("a", 1500)], 0);
check("a lone player cannot pair", alone.pairings.length === 0);
check("an empty queue is handled", attemptPairings([], 0).pairings.length === 0);

// A long-waiting player must not drag a freshly-queued one into a lopsided match.
const dragged = attemptPairings(
  [entry("veteran", 2400, 0), entry("newcomer", 1200, DEFAULT_QUEUE_CONFIG.widenOverMs)],
  DEFAULT_QUEUE_CONFIG.widenOverMs,
);
check("a fresh player is not dragged into a stretched match",
  dragged.pairings.length === 0, `${dragged.pairings.length} paired`);

console.log("\n── give-up path ─────────────────────────────────");

const abandoned = attemptPairings(
  [entry("lonely", 3000)],
  DEFAULT_QUEUE_CONFIG.giveUpAfterMs + 1,
);
check("a player waiting too long is released to async",
  abandoned.giveUp.length === 1 && abandoned.giveUp[0].playerId === "lonely");
check("a released player is no longer waiting", abandoned.waiting.length === 0);

console.log("\n── starvation ───────────────────────────────────");

/**
 * Simulate a realistic population arriving over time and confirm that nobody is
 * abandoned in the queue: everyone either pairs or is explicitly released.
 */
function simulate(label: string, ratings: number[], seedName: string): void {
  const rng = seededRandom(seedName);
  const queue = new LiveQueue();
  const outcome = new Map<string, "paired" | "released">();

  const players = ratings.map((r, i) => ({
    id: `p${i}`,
    rating: r,
    joinsAt: Math.floor(rng() * 60_000),
  }));

  let paired = 0;
  let released = 0;
  let stretched = 0;
  let totalWait = 0;

  const TICK = 1000;
  for (let now = 0; now <= 400_000; now += TICK) {
    for (const p of players) {
      if (p.joinsAt === now || (p.joinsAt > now - TICK && p.joinsAt <= now)) {
        if (!outcome.has(p.id)) {
          queue.join(
            {
              playerId: p.id,
              displayName: p.id,
              rating: rating(p.rating),
              category: "Clicking",
              difficulty: "Intermediate",
            },
            now,
          );
        }
      }
    }

    const result = queue.tick(now);
    for (const pairing of result.pairings) {
      outcome.set(pairing.a.playerId, "paired");
      outcome.set(pairing.b.playerId, "paired");
      paired += 2;
      totalWait += pairing.waitedMs;
      if (pairing.stretched) stretched++;
    }
    for (const e of result.giveUp) {
      outcome.set(e.playerId, "released");
      released++;
    }
  }

  const stranded = players.filter((p) => !outcome.has(p.id)).length;
  const avgWait = paired > 0 ? totalWait / (paired / 2) / 1000 : 0;

  console.log(
    `  ${label.padEnd(28)} paired ${String(paired).padStart(3)}  ` +
      `released ${String(released).padStart(2)}  stranded ${stranded}  ` +
      `avg wait ${avgWait.toFixed(1)}s  stretched ${stretched}`,
  );

  check(`${label}: nobody is stranded in the queue`, stranded === 0, `${stranded} stranded`);
}

// A healthy ladder: ratings clustered around the middle.
simulate(
  "100 players, normal spread",
  Array.from({ length: 100 }, (_, i) => 1500 + (i - 50) * 8),
  "normal",
);

// Launch-day reality: a handful of players, widely spread.
simulate("8 players, wide spread", [1000, 1200, 1400, 1500, 1600, 1800, 2100, 2600], "sparse");

// The hostile case: one player far above everyone else.
simulate("1 outlier + 20 clustered",
  [3200].concat(Array.from({ length: 20 }, (_, i) => 1480 + i * 2)), "outlier");

// Odd population: someone must be left over each round.
simulate("odd population of 7", [1450, 1470, 1490, 1500, 1510, 1530, 1550], "odd");

console.log("\n── queue state ──────────────────────────────────");

const q = new LiveQueue();
q.join({ playerId: "x", displayName: "x", rating: defaultRating(),
  category: "Clicking", difficulty: "Intermediate" }, 0);
check("joining adds to the queue", q.size === 1);

q.join({ playerId: "x", displayName: "x", rating: defaultRating(),
  category: "Clicking", difficulty: "Intermediate" }, 500);
check("re-joining does not duplicate", q.size === 1);

q.leave("x");
check("leaving removes from the queue", q.size === 0);

const q2 = new LiveQueue();
q2.join({ playerId: "a", displayName: "a", rating: rating(1500),
  category: "Clicking", difficulty: "Intermediate" }, 0);
check("wait estimate is zero when a close peer is queued",
  q2.estimatedWaitMs("Clicking", "Intermediate", rating(1505)) === 0);
check("wait estimate is null when the category is empty",
  q2.estimatedWaitMs("Tracking", "Intermediate", rating(1500)) === null);
check("wait estimate is positive when the nearest peer is moderately far",
  (q2.estimatedWaitMs("Clicking", "Intermediate", rating(1700)) ?? 0) > 0,
  String(q2.estimatedWaitMs("Clicking", "Intermediate", rating(1700))));
check("wait estimate is null when no peer is reachable at all",
  q2.estimatedWaitMs("Clicking", "Intermediate", rating(2800)) === null);

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: live queue validated");
