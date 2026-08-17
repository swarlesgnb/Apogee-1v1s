/**
 * Diagnostic: which Voltaic S5 scenarios lack per-kill rows?
 *
 * This matters for anti-cheat. The "reconstruct the summary score from the kill rows"
 * consistency check (PLAN.md §5) can only run on files that HAVE kill rows. If tracking
 * scenarios systematically lack them, those runs need a different local check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile } from "./parseStatsFile.ts";

const DIR = "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

interface Bucket {
  runs: number;
  withRows: number;
}

function main(): void {
  const taxonomy = JSON.parse(
    readFileSync(new URL("../../../data/scenario_taxonomy.json", import.meta.url), "utf8"),
  ) as { scenarios: { name: string; aimType: string }[] };

  const aimTypeOf = new Map(taxonomy.scenarios.map((s) => [s.name, s.aimType]));

  const byAimType = new Map<string, Bucket>();

  for (const file of readdirSync(DIR).filter((f) => f.endsWith("Stats.csv"))) {
    const result = parseStatsFile(file, readFileSync(join(DIR, file), "utf8"));
    if (!result.ok) continue;

    const aimType = aimTypeOf.get(result.run.scenario);
    if (!aimType) continue; // not a benchmark scenario

    const bucket = byAimType.get(aimType) ?? { runs: 0, withRows: 0 };
    bucket.runs++;
    if (result.run.killRows.length > 0) bucket.withRows++;
    byAimType.set(aimType, bucket);
  }

  console.log("Voltaic S5 runs, by KovaaK's aim type:\n");
  console.log("aim type          runs   with kill rows");
  for (const [aimType, b] of byAimType) {
    const share = b.runs ? ((b.withRows / b.runs) * 100).toFixed(1) : "0.0";
    console.log(`${aimType.padEnd(17)} ${b.runs.toString().padStart(5)}   ${share.padStart(6)}%`);
  }
}

main();
