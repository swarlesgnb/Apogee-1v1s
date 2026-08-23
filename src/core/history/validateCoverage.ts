/**
 * Coverage, against this machine's real history, with self-tests.
 *
 *   npx tsx src/core/history/validateCoverage.ts [--stats <folder>]
 */

import { loadSeason } from "../season/season.ts";
import { scanStatsFolder } from "./history.ts";
import { MIN_RUNS_FOR_BASELINE } from "./baseline.ts";
import {
  matchableWindows,
  sharedWindows,
  windowCoverage,
  SCENARIOS_PER_MATCH,
  type WindowCoverage,
} from "./coverage.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const at = process.argv.indexOf("--stats");
const statsDir = at !== -1 ? process.argv[at + 1] : DEFAULT_STATS_DIR;

const season = loadSeason();
const history = scanStatsFolder(statsDir);
const coverage = windowCoverage(season, history);

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

console.log(
  `\n${BOLD}${season.name}${RESET}  ${DIM}baseline needs ${MIN_RUNS_FOR_BASELINE} runs; ` +
    `a window is contestable at ${SCENARIOS_PER_MATCH} measured${RESET}\n`,
);

console.log(
  `  ${"category".padEnd(11)}${"window".padEnd(14)}${"measured".padStart(9)}` +
    `${"runs".padStart(8)}   state`,
);

for (const c of coverage) {
  const state = c.complete
    ? "complete"
    : c.matchable
      ? "contestable"
      : `needs ${SCENARIOS_PER_MATCH - c.measured} more scenario(s)`;
  console.log(
    `  ${c.category.padEnd(11)}${c.windowName.padEnd(14)}` +
      `${`${c.measured}/${c.total}`.padStart(9)}${String(c.runs).padStart(8)}   ` +
      `${c.matchable ? "" : DIM}${state}${RESET}`,
  );
}

const ballot = matchableWindows(coverage);
console.log(`\n${BOLD}What this account could be offered${RESET}`);
for (const category of new Set(coverage.map((c) => c.category))) {
  const windows = ballot.get(category) ?? [];
  console.log(
    `  ${category.padEnd(11)}` +
      (windows.length > 0
        ? windows.map((w) => coverage.find((c) => c.window === w)!.windowName).join(", ")
        : `${DIM}nothing - would fall back to the season's match pool${RESET}`),
  );
}

// The nearest thing to a second difficulty, which is the useful thing to be told: what
// would it actually take to unlock one.
console.log(`\n${BOLD}Cheapest window to unlock${RESET}`);
const locked = coverage.filter((c) => !c.matchable);
const cost = (c: WindowCoverage) =>
  c.scenarios
    .filter((s) => !s.measured)
    .sort((a, b) => a.needs - b.needs)
    .slice(0, Math.max(0, SCENARIOS_PER_MATCH - c.measured))
    .reduce((n, s) => n + s.needs, 0);

for (const c of [...locked].sort((a, b) => cost(a) - cost(b)).slice(0, 3)) {
  const need = c.scenarios
    .filter((s) => !s.measured)
    .sort((a, b) => a.needs - b.needs)
    .slice(0, Math.max(0, SCENARIOS_PER_MATCH - c.measured));
  console.log(
    `  ${c.category} ${c.windowName}: ${cost(c)} runs` +
      ` ${DIM}(${need.map((s) => `${s.label} +${s.needs}`).join(", ")})${RESET}`,
  );
}

// ---- self-tests -------------------------------------------------------------------
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log(`\n${BOLD}checks${RESET}`);

check(
  "every category and window in the season is reported",
  coverage.length ===
    new Set(season.scenarios.map((s) => `${s.category}/${s.window ?? 0}`)).size,
  `${coverage.length} buckets`,
);

check(
  "every scenario is counted exactly once",
  coverage.reduce((n, c) => n + c.total, 0) === season.scenarios.length,
  `${coverage.reduce((n, c) => n + c.total, 0)} of ${season.scenarios.length}`,
);

check(
  "measured never exceeds total",
  coverage.every((c) => c.measured <= c.total),
);

check(
  "a scenario is measured exactly when it has enough runs",
  coverage.every((c) =>
    c.scenarios.every(
      (s) => s.measured === (history.get(s.scenario)?.runs.length ?? 0) >= MIN_RUNS_FOR_BASELINE,
    ),
  ),
);

check(
  "needs is zero for a measured scenario and positive otherwise",
  coverage.every((c) =>
    c.scenarios.every((s) => (s.measured ? s.needs === 0 : s.needs > 0)),
  ),
);

// An empty history must produce a coherent answer rather than an empty one: a new player
// is the case this has to be right about.
const empty = windowCoverage(season, new Map());
check(
  "a player with no history is covered nowhere",
  empty.length === coverage.length && empty.every((c) => c.measured === 0 && !c.matchable),
);
check("a player with no history has an empty ballot", matchableWindows(empty).size === 0);

// The intersection is what a vote would actually be drawn from.
check(
  "sharing with yourself gives your own ballot",
  JSON.stringify([...sharedWindows(coverage, coverage)]) ===
    JSON.stringify([...matchableWindows(coverage)]),
);
check(
  "sharing with a new player gives nothing",
  sharedWindows(coverage, empty).size === 0,
);

console.log(
  failures === 0
    ? "\nOK: coverage validated against real history"
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
