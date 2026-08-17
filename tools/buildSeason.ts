/**
 * Build season 1's definition.
 *
 * A season owns its pool, its thresholds and its rank ladder (PLAN.md §14). Later
 * seasons derive their thresholds from the previous season's population, which is the
 * whole point: a rank means a percentile of what people actually score, and it never
 * needs maintaining. Season 1 cannot do that, because there is no population yet.
 *
 * So it is seeded, from two sources doing different jobs:
 *
 *   VOLTAIC'S NUMBERS  the thresholds themselves. They are real population data, which
 *                      is exactly what we cannot generate yet, and taking them as a
 *                      starting point we own is different from depending on a service
 *                      that can change them underneath us.
 *
 *   THE LOCAL CORPUS   a sanity check, not a source. One player's history describes
 *                      that player, so it cannot set thresholds - but it can say where
 *                      a real person falls against them, and a seed that puts somebody
 *                      off the end of its own scale is a seed that is wrong.
 *
 * Rank names are deliberately not Voltaic's. Borrowing them would re-import the
 * confusion §4 spends its length arguing against, now one level down, and naming is
 * identity work rather than engineering. They ship as placeholders to be renamed.
 *
 *   npx tsx tools/buildSeason.ts [--difficulty Intermediate] [--stats <folder>]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { scanStatsFolder } from "../src/core/history/history.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

/** Placeholder ladder. Renaming these is the first thing the season editor is for. */
const RANK_NAMES = ["Tier I", "Tier II", "Tier III", "Tier IV"];

/** Neutral, and distinct from both Voltaic's palette and Apogee's ladder colours. */
const RANK_COLORS: Record<string, string> = {
  "Tier I": "#7C8AA5",
  "Tier II": "#4FA3C7",
  "Tier III": "#C79A4F",
  "Tier IV": "#C75FA8",
};

interface VoltaicScenario {
  name: string;
  leaderboardId: number;
  rankMaxes: number[];
}

interface VoltaicCategory {
  name: string;
  rankMaxes: number[];
  scenarios: VoltaicScenario[];
}

interface SeasonScenario {
  scenario: string;
  category: string;
  leaderboardId: number | null;
  rankMaxes: number[];
  /** Where this machine's own history sits against the ladder above. */
  corpus?: { runs: number; best: number; median: number; reaches: string | null };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Highest rank a score reaches, or null when it is below the first threshold. */
function rankFor(score: number, maxes: number[]): string | null {
  let reached: string | null = null;
  maxes.forEach((threshold, i) => {
    if (score >= threshold) reached = RANK_NAMES[i] ?? `rank ${i + 1}`;
  });
  return reached;
}

function main(): void {
  const args = process.argv.slice(2);
  const diffAt = args.indexOf("--difficulty");
  const difficulty = diffAt !== -1 ? args[diffAt + 1] : "Intermediate";
  const statsAt = args.indexOf("--stats");
  const statsDir = statsAt !== -1 ? args[statsAt + 1] : DEFAULT_STATS_DIR;

  const voltaic = JSON.parse(readFileSync(dataFile("benchmarks", "voltaic-s5.json"), "utf8"));
  const source = voltaic.difficulties.find(
    (d: { name: string }) => d.name === difficulty,
  );

  if (!source) {
    console.error(
      `no difficulty "${difficulty}"; have ` +
        voltaic.difficulties.map((d: { name: string }) => d.name).join(", "),
    );
    process.exit(1);
  }

  if (source.rankNames.length !== RANK_NAMES.length) {
    console.error(
      `seed has ${source.rankNames.length} ranks but this season defines ` +
        `${RANK_NAMES.length}; thresholds would not line up`,
    );
    process.exit(1);
  }

  const history = scanStatsFolder(statsDir);

  const scenarios: SeasonScenario[] = [];
  for (const cat of source.categories as VoltaicCategory[]) {
    for (const s of cat.scenarios) {
      const entry: SeasonScenario = {
        scenario: s.name,
        category: cat.name,
        leaderboardId: s.leaderboardId ?? null,
        rankMaxes: s.rankMaxes,
      };

      const local = history.get(s.name);
      if (local && local.runs.length > 0) {
        const scores = local.runs.map((r) => r.score);
        entry.corpus = {
          runs: scores.length,
          best: Math.round(local.best),
          median: Math.round(median(scores)),
          reaches: rankFor(local.best, s.rankMaxes),
        };
      }

      scenarios.push(entry);
    }
  }

  const season = {
    name: "Season 1",
    status: "draft",
    rankNames: RANK_NAMES,
    rankColors: RANK_COLORS,
    seededFrom: {
      benchmark: voltaic.benchmarkName,
      difficulty,
      rankNames: source.rankNames,
      note:
        "Thresholds are Voltaic's published numbers, taken as a starting point we own " +
        "rather than a source we track. Rank names are ours and are placeholders. " +
        "Season 2 derives its thresholds from season 1's population instead.",
    },
    builtAt: new Date().toISOString(),
    scenarios,
  };

  const dir = join(dataFile("."), "seasons");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "season-1.json");
  writeFileSync(out, JSON.stringify(season, null, 2) + "\n");

  // ---- report ----
  const byCategory = new Map<string, SeasonScenario[]>();
  for (const s of scenarios) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  console.log(`season 1, seeded from ${voltaic.benchmarkName} ${difficulty}`);
  console.log(`ranks: ${RANK_NAMES.join(" · ")}\n`);

  console.log("  category    scenario                          thresholds");
  for (const [cat, list] of byCategory) {
    for (const s of list) {
      console.log(
        `  ${cat.padEnd(11)}${s.scenario.replace(` ${difficulty} S5`, "").padEnd(34)}` +
          s.rankMaxes.join(" / "),
      );
    }
  }

  // The sanity check: a seed that puts a real player off the end of its own scale is
  // wrong, whatever its provenance.
  const withHistory = scenarios.filter((s) => s.corpus);
  console.log(`\nlocal history covers ${withHistory.length} of ${scenarios.length} scenarios`);

  if (withHistory.length > 0) {
    const reached = new Map<string, number>();
    let belowScale = 0;
    for (const s of withHistory) {
      const r = s.corpus!.reaches;
      if (r === null) belowScale++;
      else reached.set(r, (reached.get(r) ?? 0) + 1);
    }

    console.log("  best run reaches:");
    for (const name of RANK_NAMES) {
      const n = reached.get(name) ?? 0;
      if (n > 0) console.log(`    ${name.padEnd(10)} ${n} scenario(s)`);
    }
    if (belowScale > 0) console.log(`    below scale  ${belowScale} scenario(s)`);

    const topped = reached.get(RANK_NAMES[RANK_NAMES.length - 1]) ?? 0;
    if (topped === withHistory.length) {
      console.log(
        "\n  every scenario is already at the top rank, so this ladder has no room " +
          "left in it and the thresholds need raising before publishing.",
      );
    } else if (belowScale === withHistory.length) {
      console.log(
        "\n  nothing reaches the first threshold, so the ladder starts above the " +
          "player and needs lowering before publishing.",
      );
    }
  }

  console.log(`\nwrote data/seasons/season-1.json`);
  console.log("draft only: edit it, then push it and publish when the numbers are yours.");
}

main();
