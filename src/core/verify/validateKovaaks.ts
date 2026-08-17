/**
 * Validate the KovaaK's client and the verification tier logic.
 *
 * Split deliberately in two:
 *
 *   LIVE     hits KovaaK's public API to confirm the endpoints still behave as the
 *            design assumes. Skips rather than fails when unreachable, so a flaky
 *            network never fails the build, but a CHANGED contract does.
 *
 *   OFFLINE  drives the tier logic with fixtures, so the rules that decide whether a
 *            run counts are tested deterministically.
 *
 *   npx tsx src/core/verify/validateKovaaks.ts
 */

import { readFileSync } from "node:fs";

import { parseStatsFile, type ParsedRun } from "../stats/parseStatsFile.ts";
import { findUser, matchServerRecord, recentScores, verifyAccountLink, type KovaaksScore } from "./kovaaksClient.ts";
import { verifyRun, type ServerRecord } from "./verifyRun.ts";

/** A public KovaaK's account with a registered webapp profile, used as a fixture. */
const FIXTURE_USER = "wesforrozeiro";
const FIXTURE_STEAM_ID = "76561199224724634";
const FIXTURE_SCENARIO = "VT Frogtagon Intermediate S5";

let failures = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function skip(label: string, why: string): void {
  skipped++;
  console.log(`  skip ${label}: ${why}`);
}

/** A minimal, internally coherent run to drive the tier logic. */
function fixtureRun(): ParsedRun {
  const csv = [
    "Kill #,Timestamp,Bot,Weapon,TTK,Shots,Hits,Accuracy,Damage Done,Damage Possible,Efficiency,Cheated,OverShots",
    "1,21:05:29.571,Bot,pistol,0.000000s,1,1,1.000000,1.000000,1.000000,1.000000,0,0",
    "2,21:05:30.100,Bot,pistol,0.000000s,1,1,1.000000,1.000000,1.000000,1.000000,0,0",
    "",
    "Weapon,Shots,Hits,Damage Done,Damage Possible",
    "pistol,3,2,2.0,3.0",
    "",
    "Kills:,2",
    "Hit Count:,2",
    "Miss Count:,1",
    "Score:,20.0",
    "Scenario:,VT Frogtagon Intermediate S5",
    "Hash:,ec8acdea37fa767767d705e389db1463",
    "Challenge Start:,21:05:28.997",
    "",
  ].join("\n");

  const result = parseStatsFile(
    "VT Frogtagon Intermediate S5 - Challenge - 2026.08.16-21.05.28 Stats.csv",
    csv,
  );
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.reason}`);
  return result.run;
}

async function live(): Promise<void> {
  console.log("── live KovaaK's API contract ───────────────────");

  const user = await findUser(FIXTURE_USER);
  if (!user) {
    skip("user/search returns an account", "KovaaK's unreachable or account gone");
    skip("last-scores returns run history", "depends on user/search");
    skip("account link verification", "depends on user/search");
    return;
  }

  check("user/search returns an account", true);
  check("the account carries a SteamID", user.steamId === FIXTURE_STEAM_ID,
    `got ${user.steamId}`);

  const link = await verifyAccountLink(FIXTURE_USER, FIXTURE_STEAM_ID);
  check("a correct username/SteamID pair links", link.linked, link.reason ?? "");

  const wrongLink = await verifyAccountLink(FIXTURE_USER, "76561190000000000");
  check("a mismatched SteamID is rejected", !wrongLink.linked);

  const missing = await verifyAccountLink("__definitely_not_a_real_user__", FIXTURE_STEAM_ID);
  check("an unknown username is rejected", !missing.linked);

  const scores = await recentScores(FIXTURE_USER, FIXTURE_SCENARIO);
  if (scores.length === 0) {
    skip("last-scores returns run history", "no scores returned");
    return;
  }

  console.log(`       (${scores.length} recent runs returned)`);
  check("more than one run is returned", scores.length > 1,
    "sub-PB verification depends on history, not just the best");
  check("runs carry a scenario hash", scores.every((s) => s.hash !== null));
  check("runs carry a challenge start", scores.every((s) => s.challengeStart !== null));
  check("runs carry a submission epoch", scores.every((s) => s.epoch !== null));

  // The point of returning history: scores differ, so these are not all the PB.
  const distinct = new Set(scores.map((s) => s.score)).size;
  check("history contains more than one distinct score", distinct > 1,
    `${distinct} distinct across ${scores.length}`);

  const target = scores[0];
  const found = matchServerRecord(scores, {
    hash: target.hash,
    challengeStart: target.challengeStart,
    score: target.score,
  });
  check("a known run is located in the history", found?.challengeStart === target.challengeStart);

  const absent = matchServerRecord(scores, {
    hash: target.hash,
    challengeStart: "00:00:00.001",
    score: -12345,
  });
  check("a run that was never played is not located", absent === null);
}

function offline(): void {
  console.log("\n── tier assignment ──────────────────────────────");

  const run = fixtureRun();
  const serverMatch: ServerRecord = {
    score: run.score,
    hash: run.hash,
    challengeStart: run.challengeStart,
    epoch: Date.now(),
  };

  check(
    "an exact server match is Verified",
    verifyRun({ run, serverRecord: serverMatch }).tier === "verified",
  );

  check(
    "no server record at all is Consistent",
    verifyRun({ run, serverRecord: null }).tier === "consistent",
  );

  check(
    "a sub-PB run with a higher PB on record is Consistent",
    verifyRun({
      run,
      serverRecord: { ...serverMatch, score: 999, challengeStart: "01:00:00.000" },
    }).tier === "consistent",
  );

  const suspect = verifyRun({
    run,
    serverRecord: { ...serverMatch, score: 5, challengeStart: "01:00:00.000" },
  });
  check("a run well above the verified PB is Suspect", suspect.tier === "suspect");
  check("Suspect still counts toward the match", suspect.tier !== "rejected");

  // Incoherent files are the only thing rejected outright.
  const tampered = structuredClone(run) as ParsedRun;
  tampered.playedAt = run.playedAt;
  tampered.hitCount = 99;
  const rejected = verifyRun({ run: tampered, serverRecord: serverMatch });
  check("an incoherent file is Rejected", rejected.tier === "rejected");
  check("rejection explains itself", rejected.reasons.length > 0, rejected.reasons.join("; "));

  // A hash mismatch is advisory: an upstream scenario revision is not the player's fault.
  const revised = verifyRun({
    run,
    serverRecord: { ...serverMatch, hash: "0000000000000000deadbeef00000000" },
  });
  check("a hash mismatch does not reject", revised.tier !== "rejected");
  check("a hash mismatch is recorded as an advisory", revised.advisories.length > 0);
}

async function main(): Promise<void> {
  await live();
  offline();

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(`OK: KovaaK's client and tier logic validated${skipped ? ` (${skipped} skipped)` : ""}`);
}

main();
