/**
 * Every scenario in the corpus whose name matches, with what is known about it.
 *
 *   npx tsx tools/findScenarios.ts "pipeclick" "controlsphere click"
 *
 * The lineage grouping in `proposeFamilies` is a heuristic, and where it splits a lineage
 * or drops a variant with no classified sibling, this is how the missing rung gets found.
 * It asks the taxonomy directly - every scenario KovaaK's publishes, not only the ones some
 * benchmark sheet has graded - and prints the board size, whether it has been sampled, and
 * the sub-skill any sheet gives it.
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../src/core/dataDir.ts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  console.error('usage: findScenarios.ts "<pattern>" ["<pattern>" ...]');
  process.exit(1);
}

const taxonomy = JSON.parse(readFileSync(dataFile("scenario_taxonomy.json"), "utf8")) as {
  scenarios: { name: string; leaderboardId: number | null; aimType: string | null; entries: number }[];
};
const subskills = new Map(
  (
    JSON.parse(readFileSync(dataFile("subskills.json"), "utf8")) as {
      scenarios: { scenario: string; subSkill: string | null }[];
    }
  ).scenarios.map((s) => [s.scenario, s.subSkill]),
);
const sampled = new Map(
  (
    JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8")) as {
      distributions: { scenario: string; total: number }[];
    }
  ).distributions.map((d) => [d.scenario, d.total]),
);

for (const pattern of patterns) {
  const re = new RegExp(pattern, "i");
  const hits = taxonomy.scenarios
    .filter((s) => re.test(s.name))
    .sort((a, b) => (b.entries ?? 0) - (a.entries ?? 0));

  console.log(`\n${pattern}  ${DIM}${hits.length} scenario(s)${RESET}`);
  for (const s of hits) {
    const board = sampled.has(s.name)
      ? `sampled ${sampled.get(s.name)!.toLocaleString()}`
      : `${DIM}unsampled${RESET}`;
    console.log(
      `  ${String(s.entries ?? 0).toLocaleString().padStart(9)}  ${board.padEnd(24)}` +
        `${(subskills.get(s.name) ?? "-").padEnd(20)}${s.name}` +
        `${DIM}  ${s.aimType ?? "no aim type"} #${s.leaderboardId}${RESET}`,
    );
  }
}
