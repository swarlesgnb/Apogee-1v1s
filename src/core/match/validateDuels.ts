/**
 * Validate the duel state machine.
 *
 *   npx tsx src/core/match/validateDuels.ts
 *
 * Every rule in `duels.ts` is a refusal, and a refusal that is wrong in the permissive
 * direction is a rated result somebody did not agree to: a duel answered twice, answered
 * by the wrong account, or accepted after it expired. There is nothing empirical to
 * measure here - no corpus of duels exists, which is the honest state - so what this
 * checks instead is **exhaustiveness**: every status crossed with every answer and every
 * kind of caller, with the table asserted total.
 *
 * It also asserts its own scan is not vacuous. A `answerDuel` that refused everything
 * would satisfy every "is this refused?" case in the file, so the count of things it
 * *allows* is checked too.
 */

import {
  answerDuel,
  canSendDuel,
  duelExpired,
  duelWaiting,
  DUEL_TTL_MS,
  effectiveStatus,
  type Duel,
  type DuelAnswer,
  type DuelStatus,
} from "./duels.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-05T12:00:00Z");
const LATER = new Date(NOW.getTime() + DUEL_TTL_MS + 1000);

const A = "challenger";
const B = "recipient";
const C = "somebody-else";

function duel(over: Partial<Duel> = {}): Duel {
  return {
    id: "d1",
    fromPlayer: A,
    toPlayer: B,
    status: "open",
    expiresAt: new Date(NOW.getTime() + DUEL_TTL_MS),
    challengerMatchScore: 0.04,
    ...over,
  };
}

const STATUSES: DuelStatus[] = ["open", "accepted", "declined", "expired"];
const ANSWERS: DuelAnswer[] = ["accept", "decline"];

function main(): void {
  console.log("\n── the happy path ───────────────────────────────");

  const accepted = answerDuel(duel(), B, "accept", NOW);
  check("the recipient can accept a played duel", accepted.ok && accepted.status === "accepted");

  const declined = answerDuel(duel(), B, "decline", NOW);
  check("the recipient can decline it", declined.ok && declined.status === "declined");

  console.log("\n── who is answering ─────────────────────────────");

  const bySender = answerDuel(duel(), A, "accept", NOW);
  check("the challenger cannot answer their own duel", !bySender.ok);
  check("and is told it is theirs, not that it does not exist",
    !bySender.ok && bySender.reason.includes("you sent this"),
    !bySender.ok ? bySender.reason : "");

  const byStranger = answerDuel(duel(), C, "accept", NOW);
  check("a third party cannot answer it", !byStranger.ok);
  // Identity before state, so poking at somebody else's duel never reports its status.
  const strangerOnDead = answerDuel(duel({ status: "declined" }), C, "accept", NOW);
  check("a third party is not told the status of a duel that is not theirs",
    !strangerOnDead.ok && strangerOnDead.reason.includes("not sent to you"),
    !strangerOnDead.ok ? strangerOnDead.reason : "");

  console.log("\n── answering twice ──────────────────────────────");

  check("an accepted duel cannot be accepted again",
    !answerDuel(duel({ status: "accepted" }), B, "accept", NOW).ok);
  check("an accepted duel cannot then be declined",
    !answerDuel(duel({ status: "accepted" }), B, "decline", NOW).ok);
  check("a declined duel cannot be accepted",
    !answerDuel(duel({ status: "declined" }), B, "accept", NOW).ok);

  console.log("\n── the clock ────────────────────────────────────");

  check("a duel past its deadline is expired", duelExpired(duel(), LATER));
  check("and one inside it is not", !duelExpired(duel(), NOW));
  check("an expired duel cannot be accepted",
    !answerDuel(duel(), B, "accept", LATER).ok);
  check("nor declined",
    !answerDuel(duel(), B, "decline", LATER).ok);
  check("a duel stored as expired is refused whatever the clock says",
    !answerDuel(duel({ status: "expired" }), B, "accept", NOW).ok);
  check("expiry is applied on read without being written",
    effectiveStatus(duel(), LATER) === "expired" && duel().status === "open");
  check("and a settled status is never rewritten by the clock",
    effectiveStatus(duel({ status: "accepted" }), LATER) === "accepted");

  console.log("\n── the challenger has not played yet ────────────");

  const waiting = duel({ challengerMatchScore: null });
  check("a duel whose challenger has not played is waiting", duelWaiting(waiting));
  check("and one whose challenger has is not", !duelWaiting(duel()));
  check("it cannot be accepted yet",
    !answerDuel(waiting, B, "accept", NOW).ok);
  check("and the reason says so rather than blaming the recipient",
    (() => {
      const r = answerDuel(waiting, B, "accept", NOW);
      return !r.ok && r.reason.includes("not finished playing");
    })());
  // Saying no costs nothing and should never wait on somebody else to finish.
  check("but it can be declined straight away",
    answerDuel(waiting, B, "decline", NOW).ok);

  console.log("\n── sending ──────────────────────────────────────");

  check("you cannot duel yourself", !canSendDuel(A, A).ok);
  check("and you can duel anybody else", canSendDuel(A, B).ok);

  console.log("\n── the table is total ───────────────────────────");

  // Every status crossed with every answer and every caller. Nothing throws, everything
  // has an answer, and every refusal carries a reason worth showing somebody.
  let allowed = 0;
  let refused = 0;
  const reasons = new Set<string>();
  for (const status of STATUSES) {
    for (const answer of ANSWERS) {
      for (const by of [A, B, C]) {
        for (const score of [0.04, null]) {
          const d = duel({ status, challengerMatchScore: score });
          const r = answerDuel(d, by, answer, NOW);
          if (r.ok) allowed++;
          else {
            refused++;
            reasons.add(r.reason);
            if (!r.reason) failures++;
          }
        }
      }
    }
  }
  const total = STATUSES.length * ANSWERS.length * 3 * 2;
  check(`every combination has an answer: ${total} of them`, allowed + refused === total,
    `${allowed} allowed, ${refused} refused`);
  check("every refusal says why", reasons.size > 0 && ![...reasons].some((r) => !r.trim()));

  // The non-vacuity guard. A function that refused everything would pass every case
  // above that asserts a refusal, which is the failure mode this whole file exists to
  // avoid being blind to.
  check("some combinations are allowed, so the refusals mean something", allowed > 0,
    `${allowed} allowed`);
  check("and most are refused, so it is not waving everything through",
    refused > allowed, `${refused} refused vs ${allowed} allowed`);
  check("the refusals are distinguishable, not one message for everything",
    reasons.size >= 4, `${reasons.size} distinct reasons`);

  console.log("\n── the deadline is a duel's, not a match's ──────");

  // Eight minutes is how long you get to play three scenarios once a match opens. A duel
  // waits for a person, and the two must not be confused for one another.
  check("a duel waits days rather than minutes", DUEL_TTL_MS >= 24 * 60 * 60 * 1000,
    `${DUEL_TTL_MS / 3600000} hours`);

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: duel answering validated");
}

main();
