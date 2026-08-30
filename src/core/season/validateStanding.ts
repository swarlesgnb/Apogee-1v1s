/**
 * The apex board, checked against the real corpus.
 *
 *   npx tsx src/core/season/validateStanding.ts [statsFolder]
 *
 * The claim this file has to hold up is narrow and specific: the apex board separates
 * players the ladder has stopped separating, and it does so without inventing a number.
 * Everything below is either that claim or a way the measure could quietly stop being
 * true - a seam between two data sources that does not join, an interpolation that runs
 * backwards, a missing board read as last place.
 */

import { existsSync, readFileSync } from "node:fs";

import { dataFile } from "../dataDir.ts";
import { scanStatsFolder } from "../history/history.ts";
import { scenarioEnergy } from "../benchmarks/energy.ts";
import { loadSeason } from "./season.ts";
import {
  APEX_RANKS,
  apexPoints,
  apexTopFraction,
  boardRankOfScore,
  type ApexBoard,
} from "./apex.ts";
import { apexSources, apexStanding, topWindowVariants } from "./standing.ts";
import { topFractionOfScore, type Distribution } from "./percentiles.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const args = process.argv.slice(2);
const statsDir = args.find((a) => !a.startsWith("--")) ?? DEFAULT_STATS_DIR;

const season = loadSeason();

const apexFile = JSON.parse(readFileSync(dataFile("leaderboard_apex.json"), "utf8")) as {
  boards: ApexBoard[];
};
const pctFile = JSON.parse(
  readFileSync(dataFile("leaderboard_percentiles.json"), "utf8"),
) as { distributions: Distribution[] };

const sources = apexSources(apexFile, pctFile);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---- coverage ------------------------------------------------------------------------

console.log(`\n${BOLD}apex board${RESET}  ${apexFile.boards.length} boards sampled`);

const variants = [...topWindowVariants(season).values()];

console.log(`\n${BOLD}coverage${RESET}`);
check(
  "every family has a top-window variant",
  variants.length === new Set(season.scenarios.map((s) => s.family ?? s.scenario)).size,
  `${variants.length} families`,
);

const topWindow = Math.max(...season.scenarios.map((s) => s.window ?? 0));
check(
  "every graded variant is from the season's top window",
  variants.every((v) => (v.window ?? 0) === topWindow),
  `window ${topWindow}`,
);

const ungraded = variants.filter((v) => !sources.boards.has(v.scenario));
check(
  "every graded variant has a sampled apex board",
  ungraded.length === 0,
  ungraded.length ? ungraded.map((v) => v.scenario).join(", ") : `${variants.length} boards`,
);

// ---- the measure itself --------------------------------------------------------------

console.log(`\n${BOLD}the measure${RESET}`);

const sample = sources.boards.get(variants[0].scenario)!;

check(
  "a score at the world record reads as rank 1",
  boardRankOfScore(sample, sample.points[0].score) === 1,
);
check(
  "a score above the world record still reads as rank 1",
  boardRankOfScore(sample, sample.points[0].score * 2) === 1,
);
check(
  "every sampled anchor reads back as its own rank",
  sample.points.every((p) => {
    const r = boardRankOfScore(sample, p.score);
    return r !== null && Math.abs(r - p.rank) < 0.5;
  }),
);
check(
  "a score below the last anchor is not placed by the apex board",
  boardRankOfScore(sample, sample.points[sample.points.length - 1].score - 1) === null,
);

// Monotone: a better score is never a worse position, anywhere on the range.
let monotoneBreaks = 0;
for (const board of sources.boards.values()) {
  const best = board.points[0].score;
  const worst = board.points[board.points.length - 1].score;
  let prev = Infinity;
  for (let i = 0; i <= 200; i++) {
    const score = worst + ((best - worst) * i) / 200;
    const rank = boardRankOfScore(board, score);
    if (rank === null) continue;
    if (rank > prev + 1e-9) monotoneBreaks++;
    prev = rank;
  }
}
check("a better score never reads as a worse rank", monotoneBreaks === 0, `${monotoneBreaks} breaks`);

// ---- the seam ------------------------------------------------------------------------
//
// The apex board covers the top 500 and the fractional distribution covers everything
// below. They are two samplings of one board and they do not join cleanly: the fractional
// points are up to a full percentile apart and interpolate linearly across a convex curve,
// so the two can disagree about where the same score sits.
//
// The disagreement itself is tolerable. What is not is its direction: where the
// distribution reads better than the last anchor, a player scoring *less* than rank 500
// would be placed *above* rank 500. `apexTopFraction` floors the handover for exactly that
// reason, so what is checked here is the property that matters - the combined measure
// never rewards a worse score - rather than the size of a gap that is a fact about the
// sampling and will never be zero.

console.log(`\n${BOLD}the seam${RESET}  ${DIM}where apex hands over to the percentiles${RESET}`);

let worstSeam = { scenario: "", gap: 0 };
let seamsChecked = 0;

for (const variant of variants) {
  const board = sources.boards.get(variant.scenario);
  const dist = sources.distributions.get(variant.scenario);
  if (!board || !dist) continue;

  const last = board.points[board.points.length - 1];
  const raw = topFractionOfScore(dist, last.score);
  if (raw === null) continue;

  seamsChecked++;
  const gap = Math.abs(raw - last.rank / board.total);
  if (gap > worstSeam.gap) worstSeam = { scenario: variant.scenario, gap };
}

console.log(
  `  ${DIM}the two samplings differ by at most ${(worstSeam.gap * 100).toFixed(3)}% ` +
    `(${worstSeam.scenario || "-"}), across ${seamsChecked} seams${RESET}`,
);

// The property the floor exists to guarantee, swept across every graded board rather than
// tested at the seam alone: score up, position never worse. A step anywhere - at the
// handover or inside either source - shows up here.
let inversions = 0;
let worstInversion = { scenario: "", at: 0 };

for (const variant of variants) {
  const board = sources.boards.get(variant.scenario);
  const dist = sources.distributions.get(variant.scenario);
  if (!board) continue;

  const top = board.points[0].score;
  let prev = Infinity;
  for (let i = 0; i <= 400; i++) {
    const score = (top * i) / 400;
    const fraction = apexTopFraction(board, dist ?? null, score);
    if (fraction === null) continue;
    // Fraction is distance from the top, so it must never grow as score grows.
    if (fraction > prev + 1e-12) {
      inversions++;
      if (!worstInversion.scenario) worstInversion = { scenario: variant.scenario, at: score };
    }
    prev = fraction;
  }
}

check(
  "a better score is never a worse position, anywhere on the board",
  inversions === 0,
  inversions
    ? `${inversions} inversion(s), first on ${worstInversion.scenario} at ${worstInversion.at.toFixed(2)}`
    : `${variants.length} boards swept`,
);

// ---- what it adds over the ladder ----------------------------------------------------
//
// The reason this exists. Two players who both clear the hardest threshold hold identical
// energy - that is the ladder working as designed - and the apex board has to tell them
// apart or it is not worth having.

console.log(`\n${BOLD}past the top of the ladder${RESET}`);

const graded = variants
  .map((v) => ({ v, board: sources.boards.get(v.scenario) }))
  .filter((x) => x.board) as { v: (typeof variants)[number]; board: ApexBoard }[];

let tiedByLadder = 0;
let separatedByApex = 0;

for (const { v, board } of graded) {
  const top = v.rankMaxes[v.rankMaxes.length - 1];
  // Somebody exactly at the last threshold, and somebody far past it.
  const atTop = top;
  const wayPast = board.points[0].score;
  if (!(wayPast > atTop)) continue;

  const eA = scenarioEnergy(atTop, v.rankMaxes);
  const eB = scenarioEnergy(wayPast, v.rankMaxes);
  if (eA === eB) tiedByLadder++;

  const pA = apexPoints(apexTopFraction(board, sources.distributions.get(v.scenario) ?? null, atTop));
  const pB = apexPoints(apexTopFraction(board, sources.distributions.get(v.scenario) ?? null, wayPast));
  if (pB > pA) separatedByApex++;
}

check(
  "the ladder ties a maxed score with a world record",
  tiedByLadder === graded.length,
  `${tiedByLadder}/${graded.length} families`,
);
check(
  "the apex board separates them",
  separatedByApex === graded.length,
  `${separatedByApex}/${graded.length} families`,
);
check(
  "points never cap: ten times fewer players above is always one more point",
  Math.abs(apexPoints(0.001) - apexPoints(0.01) - 1) < 1e-9 &&
    Math.abs(apexPoints(0.0001) - apexPoints(0.001) - 1) < 1e-9,
);
check("the bottom of a board is zero rather than negative", apexPoints(1) === 0 && apexPoints(2) === 0);
check("no score is no points, not last place", apexPoints(null) === 0);

// ---- the sandbagging shape -----------------------------------------------------------
//
// Grading a family on the *best* of its variants - the rule the ladder uses, and the right
// rule there - would mean something different up here, because a percentile is a
// percentile of whoever played that scenario. An easy board is enormous and mostly people
// who opened it once; a hard board is small and entirely people who sought it out. If the
// same player reads better on the easy one, "best of variants" pays for playing down.
//
// The honest test is one player's real scores on both ends of a family, which is what the
// corpus supplies. A maxed-threshold comparison would prove nothing: a Novice scenario's
// top threshold is the top 42% of its board and an Expert one's is the top 0.8%, so the
// hard board wins that by construction and the check would pass without testing anything.

console.log(`\n${BOLD}no easier road onto the board${RESET}`);

const corpusScores = new Map<string, number>();
if (existsSync(statsDir)) {
  for (const [scenario, h] of scanStatsFolder(statsDir)) {
    const best = Math.max(...h.runs.map((r) => r.score));
    if (Number.isFinite(best)) corpusScores.set(scenario, best);
  }
}

let easierWouldWin = 0;
let comparable = 0;
const examples: string[] = [];

for (const [family, top] of topWindowVariants(season)) {
  const others = season.scenarios
    .filter((s) => (s.family ?? s.scenario) === family && s.scenario !== top.scenario)
    .sort((a, b) => (a.window ?? 0) - (b.window ?? 0));

  const topScore = corpusScores.get(top.scenario);
  if (topScore === undefined) continue;

  const topPts = apexPoints(
    apexTopFraction(
      sources.boards.get(top.scenario) ?? null,
      sources.distributions.get(top.scenario) ?? null,
      topScore,
    ),
  );

  for (const other of others) {
    const score = corpusScores.get(other.scenario);
    if (score === undefined) continue;

    comparable++;
    const pts = apexPoints(
      apexTopFraction(
        sources.boards.get(other.scenario) ?? null,
        sources.distributions.get(other.scenario) ?? null,
        score,
      ),
    );
    if (pts > topPts) {
      easierWouldWin++;
      if (examples.length < 4) {
        examples.push(
          `${family}: ${other.label ?? other.scenario} w${other.window} pays ${pts.toFixed(2)} ` +
            `against ${topPts.toFixed(2)} on the graded variant`,
        );
      }
    }
  }
}

if (comparable === 0) {
  console.log(`  ${DIM}no family has a corpus score on both an easier variant and the graded one${RESET}`);
} else {
  console.log(
    `  ${DIM}on ${easierWouldWin} of ${comparable} variant pairs the same player reads better ` +
      `on the easier scenario${RESET}`,
  );
  for (const e of examples) console.log(`  ${DIM}  ${e}${RESET}`);
}

// The measurement above is the argument for the rule, not a pass condition - it would be
// perfectly possible for a corpus to contain no such pair. What must hold is the rule
// itself: whatever the easier variants would have paid, none of them is what got graded.
const gradedScenarios = new Set([...topWindowVariants(season).values()].map((v) => v.scenario));
const standingScenarios = apexStanding(season, corpusScores, sources).categories.flatMap((c) =>
  c.families.map((f) => f.scenario),
);
check(
  "the standing is graded on the top-window variant and no other",
  standingScenarios.length > 0 && standingScenarios.every((s) => gradedScenarios.has(s)),
  `${standingScenarios.length} families`,
);

// ---- the real corpus -----------------------------------------------------------------

console.log(`\n${BOLD}the corpus${RESET}`);

if (!existsSync(statsDir)) {
  console.log(`  ${DIM}no stats folder at ${statsDir}; skipping the corpus sweep${RESET}`);
} else {
  const history = scanStatsFolder(statsDir);
  const scores = new Map<string, number>();
  for (const [scenario, h] of history) {
    const best = Math.max(...h.runs.map((r) => r.score));
    if (Number.isFinite(best)) scores.set(scenario, best);
  }

  const standing = apexStanding(season, scores, sources);

  console.log(
    `  ${DIM}${history.size} scenarios in the stats folder, ` +
      `${standing.graded}/${standing.total} apex families scored${RESET}\n`,
  );

  for (const cat of standing.categories) {
    console.log(
      `  ${BOLD}${cat.name.padEnd(10)}${RESET} ${cat.points.toFixed(2).padStart(6)} points  ` +
        `${DIM}${cat.graded}/${cat.total} families${RESET}`,
    );
    for (const f of cat.families) {
      const where =
        f.boardRank !== null && f.boardTotal !== null
          ? `#${Math.round(f.boardRank).toLocaleString()} of ${f.boardTotal.toLocaleString()}`
          : "no score";
      console.log(
        `     ${f.label.padEnd(34)} ${f.points.toFixed(2).padStart(5)}  ${DIM}${where}${RESET}`,
      );
    }
  }
  console.log(`\n  ${BOLD}total${RESET} ${standing.points.toFixed(2)} points`);

  check(
    "a scored family earns points",
    standing.graded === 0 || standing.points > 0,
    `${standing.points.toFixed(2)}`,
  );
  check(
    "every scored family placed on a board",
    standing.categories.every((c) =>
      c.families.every((f) => f.score === null || f.topFraction !== null),
    ),
  );
  check(
    "an empty score map scores nothing rather than failing",
    apexStanding(season, new Map(), sources).points === 0,
  );
}

// ---- shape ---------------------------------------------------------------------------

console.log(`\n${BOLD}shape${RESET}`);
check("the anchors are ascending and start at the world record", APEX_RANKS[0] === 1 &&
  APEX_RANKS.every((r, i) => i === 0 || r > APEX_RANKS[i - 1]));
check(
  "every sampled board's anchors descend in score",
  [...sources.boards.values()].every((b) =>
    b.points.every((p, i) => i === 0 || p.score <= b.points[i - 1].score),
  ),
);
check(
  "the last anchor sits below the finest sampled percentile on every board",
  [...sources.boards.values()].every((b) => {
    const dist = sources.distributions.get(b.scenario);
    if (!dist) return true;
    const finest = dist.points[0].topFraction;
    return b.points[b.points.length - 1].rank / b.total >= finest;
  }),
);

console.log(
  failures === 0
    ? `\nOK: apex board validated\n`
    : `\nFAILED: ${failures} check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
