/**
 * Write the player-state snapshot to data/snapshot.json.
 *
 * The UI is built against this rather than invented data, so what you see is your
 * actual standing, your actual weakest category, and a match constructed from
 * scenarios and baselines that really exist. A mockup filled with plausible numbers
 * hides exactly the problems worth catching: deltas that read wrong, ranks that never
 * appear, text that overflows.
 *
 *   npx tsx src/core/report/exportSnapshot.ts [statsFolder]
 */

import { writeFileSync } from "node:fs";

import { buildSnapshot } from "./snapshot.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const OUT = new URL("../../../data/snapshot.json", import.meta.url);

function main(): void {
  const statsDir = process.argv[2] ?? DEFAULT_STATS_DIR;
  const snapshot = buildSnapshot({ statsDir });

  if (!snapshot) {
    console.error(`no runs found in ${statsDir}`);
    process.exit(1);
  }

  writeFileSync(OUT, JSON.stringify(snapshot, null, 2), "utf8");

  const match = snapshot.match as { verdict: string; explanation: string };
  console.log("wrote data/snapshot.json");
  console.log(
    `  ${snapshot.benchmark.name} ${snapshot.benchmark.difficulty}: ${snapshot.player.benchmarkRank}`,
  );
  console.log(
    `  arena tier: ${snapshot.player.arena.tier.name} (p${snapshot.player.arena.percentile})`,
  );
  console.log(`  weakest: ${snapshot.weakest}`);
  console.log(`  match: ${match.verdict}, ${match.explanation}`);
  console.log(`  quests: ${snapshot.quests.length}, streak: ${snapshot.player.streak} days`);
}

main();
