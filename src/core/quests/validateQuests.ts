/**
 * Validate evxl link resolution and quest generation.
 *
 * Link parsing is tested against the shapes players actually paste, including the ones
 * that must FAIL: an ambiguous name silently resolving to the wrong benchmark would
 * have someone grinding quests for a season they are not playing.
 *
 *   npx tsx src/core/quests/validateQuests.ts
 */

import { readFileSync } from "node:fs";

import type { BenchmarkDef } from "../benchmarks/types.ts";
import { scanStatsFolder } from "../history/history.ts";
import {
  parseEvxlLink,
  resolveBenchmark,
  toTrackRequest,
  type BenchmarkRegistryEntry,
} from "./evxlLink.ts";
import { generateQuests, isComplete, playStreak, questProgress } from "./generate.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const registry = (
  JSON.parse(
    readFileSync(new URL("../../../data/evxl_registry.json", import.meta.url), "utf8"),
  ) as { benchmarks: BenchmarkRegistryEntry[] }
).benchmarks;

console.log(`registry: ${registry.length} benchmarks\n`);

console.log("── link parsing ─────────────────────────────────");

const canonical = parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5");
check("a canonical benchmark URL parses", canonical?.benchmarkName === "Voltaic S5",
  JSON.stringify(canonical));

check("a URL with a difficulty keeps it",
  parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5/Intermediate")?.difficulty ===
    "Intermediate");

check("a bare name is accepted",
  parseEvxlLink("Voltaic S5")?.benchmarkName === "Voltaic S5");

check("a scheme-less URL is accepted",
  parseEvxlLink("evxl.app/benchmarks/Revosect%20S5")?.benchmarkName === "Revosect S5");

check("whitespace is tolerated",
  parseEvxlLink("  https://evxl.app/benchmarks/Voltaic%20S5  ")?.benchmarkName === "Voltaic S5");

check("a leaderboard URL parses",
  parseEvxlLink("https://evxl.app/leaderboards/460")?.source === "leaderboards");

check("a non-evxl host is rejected",
  parseEvxlLink("https://example.com/benchmarks/Voltaic%20S5") === null);
check("an empty string is rejected", parseEvxlLink("") === null);
check("nonsense is rejected", parseEvxlLink("https://evxl.app/") === null);

console.log("\n── benchmark resolution ─────────────────────────");

const s5 = resolveBenchmark(parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5")!, registry);
check("Voltaic S5 resolves exactly",
  s5?.entry.benchmarkName === "Voltaic S5" && s5.exact === true);

const s55 = resolveBenchmark(parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5.5")!, registry);
check("Voltaic S5.5 resolves to itself, not S5",
  s55?.entry.benchmarkName === "Voltaic S5.5", s55?.entry.benchmarkName);

const cased = resolveBenchmark(parseEvxlLink("voltaic s5")!, registry);
check("casing and punctuation are tolerated",
  cased?.entry.benchmarkName === "Voltaic S5");

// The important negative: a name matching several benchmarks must NOT pick one.
const ambiguous = resolveBenchmark(parseEvxlLink("Voltaic")!, registry);
check("an ambiguous name resolves to nothing", ambiguous === null,
  ambiguous?.entry.benchmarkName);

const unknown = resolveBenchmark(parseEvxlLink("Definitely Not A Benchmark")!, registry);
check("an unknown name resolves to nothing", unknown === null,
  unknown ? `resolved to ${unknown.entry.benchmarkName}` : "");

check("a short nonsense string resolves to nothing",
  resolveBenchmark(parseEvxlLink("zzzzz")!, registry) === null);

// The registry contains non-Latin names; they must still be reachable, and must not
// act as a catch-all for everything else.
const cjk = registry.find((e) => /[一-鿿]/.test(e.benchmarkName));
if (cjk) {
  const byCjk = resolveBenchmark(parseEvxlLink(cjk.benchmarkName)!, registry);
  check("a non-Latin benchmark name still resolves to itself",
    byCjk?.entry.benchmarkName === cjk.benchmarkName, byCjk?.entry.benchmarkName);
} else {
  check("registry contains a non-Latin name to test", false);
}

// A numeric leaderboard id should find the right benchmark AND difficulty.
const byId = resolveBenchmark(parseEvxlLink("https://evxl.app/leaderboards/460")!, registry);
check("a leaderboard id resolves to a benchmark",
  byId?.entry.benchmarkName === "Voltaic S5", byId?.entry.benchmarkName);
check("a leaderboard id resolves to a difficulty",
  byId?.difficulty === "Advanced", byId?.difficulty ?? "none");

console.log("\n── track request ────────────────────────────────");

const track = toTrackRequest(s5!);
check("a track request is produced", track !== null);
check("it carries a KovaaK's benchmark id",
  typeof track?.kovaaksBenchmarkId === "number" && track.kovaaksBenchmarkId > 0,
  String(track?.kovaaksBenchmarkId));
check("it defaults to an official difficulty",
  !/unofficial/i.test(track?.difficulty ?? ""), track?.difficulty);

const preferred = toTrackRequest(s5!, "Advanced");
check("a preferred difficulty is honoured", preferred?.difficulty === "Advanced",
  preferred?.difficulty);

const explicit = toTrackRequest(
  resolveBenchmark(parseEvxlLink("https://evxl.app/benchmarks/Voltaic%20S5/Novice")!, registry)!,
);
check("a difficulty in the URL wins", explicit?.difficulty === "Novice", explicit?.difficulty);

// Every registry entry with a usable difficulty should produce a track request, so a
// player can track any benchmark evxl knows about.
let trackable = 0;
const untrackable: string[] = [];
for (const entry of registry) {
  const request = toTrackRequest({ entry, difficulty: null, exact: true });
  if (request) trackable++;
  else untrackable.push(entry.benchmarkName);
}
console.log(`       ${trackable} of ${registry.length} benchmarks are trackable`);
check("most of the registry is trackable", trackable > registry.length * 0.8,
  `${trackable}/${registry.length}`);

// The only honest reason to refuse is a benchmark hosted somewhere other than KovaaK's,
// which carries no id to track by. Counting refusals instead used to assert there was at
// least one, and that broke the day evxl dropped its last Aimbeast entry: the data
// changed, the code was fine, and the suite failed. Assert the rule, not the census.
const linked = registry.filter((entry) =>
  (entry.difficulties ?? []).some(
    (d) => typeof d.kovaaksBenchmarkId === "number" && d.kovaaksBenchmarkId > 0,
  ),
);
check("every benchmark with a KovaaK's id is trackable", trackable === linked.length,
  `${trackable}/${linked.length}, refused: ${untrackable.join(", ") || "none"}`);

console.log("\n── quest generation from real history ───────────");

const benchmark = JSON.parse(
  readFileSync(new URL("../../../data/benchmarks/voltaic-s5.json", import.meta.url), "utf8"),
) as BenchmarkDef;
const difficulty = benchmark.difficulties.find((d) => d.name === "Intermediate")!;

const history = scanStatsFolder(process.argv[2] ?? DEFAULT_STATS_DIR);
const now = new Date();

if (history.size === 0) {
  check("real history was readable", false);
} else {
  const quests = generateQuests({ difficulty, history, now, count: 5 });

  console.log();
  for (const q of quests) {
    const pct = (questProgress(q) * 100).toFixed(0);
    console.log(`  [${q.xp.toString().padStart(3)} xp] ${q.title}`);
    console.log(`             ${q.detail}`);
    console.log(`             progress ${pct}%${isComplete(q) ? "  COMPLETE" : ""}`);
  }
  console.log();

  check("quests are generated", quests.length > 0);
  check("every quest has player-facing text",
    quests.every((q) => q.title.length > 0 && q.detail.length > 0));
  check("every quest has a positive target", quests.every((q) => q.target > 0));
  check("every quest awards xp", quests.every((q) => q.xp > 0));
  check("quest ids are unique", new Set(quests.map((q) => q.id)).size === quests.length);
  check("all quests expire today",
    quests.every((q) => q.expiresAt.toDateString() === now.toDateString()));

  const gap = quests.find((q) => q.kind === "close_the_gap");
  check("a close-the-gap quest names a real number",
    gap !== undefined && /\d/.test(gap.detail), gap?.detail);
  check("close-the-gap targets a real scenario",
    gap?.subject !== undefined && difficulty.categories
      .flatMap((c) => c.scenarios)
      .some((s) => s.name === gap.subject),
    gap?.subject);

  check("progress is always within 0..1",
    quests.every((q) => questProgress(q) >= 0 && questProgress(q) <= 1));

  // Regenerating the same day must not reroll the quests.
  const again = generateQuests({ difficulty, history, now, count: 5 });
  check("generation is stable within a day",
    JSON.stringify(quests.map((q) => q.id)) === JSON.stringify(again.map((q) => q.id)));

  // ---- floor quests ------------------------------------------------------------
  // These are the reason consistency mode exists, so they must actually appear in the
  // daily list rather than being crowded out by ceiling quests.
  const floorKinds = new Set(["floor_rank_up", "close_the_spread", "no_disasters"]);
  const floorQuests = quests.filter((q) => floorKinds.has(q.kind));

  check("floor quests appear in the daily list", floorQuests.length > 0,
    `${floorQuests.length} of ${quests.length}`);

  check("a floor quest leads the list", floorKinds.has(quests[0]?.kind ?? ""),
    quests[0]?.kind);

  const rankUp = quests.find((q) => q.kind === "floor_rank_up");
  if (rankUp) {
    check("a floor quest names both the current floor and the target",
      /worst of the last \d+ is [\d.]+/.test(rankUp.detail) && /clear [\d.]+/.test(rankUp.detail),
      rankUp.detail);

    check("floor progress counts runs already clearing, not a guess",
      rankUp.progress >= 0 && rankUp.progress <= rankUp.target,
      `${rankUp.progress}/${rankUp.target}`);

    check("a floor quest targets a real scenario",
      rankUp.subject !== undefined &&
        difficulty.categories.flatMap((c) => c.scenarios).some((s) => s.name === rankUp.subject),
      rankUp.subject);
  } else {
    check("a floor rank-up quest was generated", false);
  }

  // A floor quest asks for a whole window of clean runs, never a single one, which is
  // the difference between it and every ceiling quest.
  check("floor quests ask for a window of runs, not one",
    floorQuests.every((q) => q.target >= 5), floorQuests.map((q) => q.target).join(","));

  const streak = playStreak(history, now);
  console.log(`       current play streak: ${streak} days`);
  check("streak is a sane number", streak >= 0 && streak < 10000, String(streak));
}

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: quests and evxl link resolution validated");
