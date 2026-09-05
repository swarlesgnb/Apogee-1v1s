/**
 * Hold data/aim_type_corrections.json to its measurement.
 *
 *   npx tsx src/core/season/validateAimTypes.ts [statsFolder]
 *
 * A correction here overrides a first-party source on the column `find-match` partitions
 * the queue on, so it is the last place in this repo where an assertion should be taken on
 * trust. Every figure in the file is re-derived from the stats folder and compared:
 *
 *   the reference ranges   clicking and switching scenarios nobody disputes, so the
 *                          discriminator is shown separating them rather than claimed to
 *   the corrected scenario its own shots per kill, which must sit outside the range of the
 *                          type KovaaK's assigned rather than merely near its edge
 *
 * The file also has to stay non-vacuous: a correction that agrees with KovaaK's has stopped
 * doing anything, and one naming a scenario the taxonomy has never heard of is a typo that
 * would silently never apply.
 *
 * Without a stats folder the measurements cannot be re-derived and are reported as
 * unchecked rather than passed. That is the honest state on a machine with no corpus, and
 * it is why this is a separate script rather than a block inside validate:pool.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../dataDir.ts";
import { parseStatsFile } from "../stats/parseStatsFile.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const args = process.argv.slice(2);
const statsDir = args.find((a) => !a.startsWith("--")) ?? DEFAULT_STATS_DIR;

interface Example {
  scenario: string;
  kills: number;
  shotsPerKill: number;
  weapon: string;
}

interface Correction {
  aimType: string;
  kovaaksSays: string;
  measured: { runs: number; kills: number; shotsPerKill: number; weapon: string; bot?: string };
  namedBy: { benchmark: string; label: string }[];
  why: string;
}

interface CorrectionsFile {
  measurement: {
    reference: Record<string, { range: string; examples: Example[] }>;
  };
  corrections: Record<string, Correction>;
}

const file = JSON.parse(
  readFileSync(dataFile("aim_type_corrections.json"), "utf8"),
) as CorrectionsFile;

const taxonomy = JSON.parse(
  readFileSync(dataFile("scenario_taxonomy.json"), "utf8"),
) as { scenarios: { name: string; aimType: string | null }[] };

const tax = new Map(taxonomy.scenarios.map((s) => [s.name, s]));

/**
 * Every (benchmark, label) pair naming each scenario.
 *
 * The pair, not just the benchmark name: a correction records the label verbatim so a
 * reader can see how strong its support really is - "Dynamic Clicking" settles a category
 * and "Precision" does not - and a label written from memory rather than read from the
 * definitions would otherwise pass unnoticed. It did not: this check caught two.
 */
const namesFor = new Map<string, Set<string>>();
for (const f of readdirSync(dataFile("benchmarks")).filter((n) => n.endsWith(".json"))) {
  const def = JSON.parse(readFileSync(join(dataFile("benchmarks"), f), "utf8")) as {
    benchmarkName: string;
    difficulties?: { categories?: { name?: string; scenarios?: { name: string }[] }[] }[];
  };
  for (const diff of def.difficulties ?? []) {
    for (const cat of diff.categories ?? []) {
      for (const sc of cat.scenarios ?? []) {
        const set = namesFor.get(sc.name) ?? new Set<string>();
        set.add(`${def.benchmarkName} :: ${cat.name ?? ""}`);
        namesFor.set(sc.name, set);
      }
    }
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

const corrections = Object.entries(file.corrections);

console.log(`\n${BOLD}aim type corrections${RESET}  ${corrections.length} scenario(s)`);

// ---- the file is not vacuous -----------------------------------------------------------

console.log(`\n${BOLD}shape${RESET}`);

const unknown = corrections.filter(([name]) => !tax.has(name));
check(
  "every corrected scenario is one KovaaK's publishes",
  unknown.length === 0,
  unknown.map(([n]) => n).join(", "),
);

const vacuous = corrections.filter(([name, c]) => {
  const known = tax.get(name)?.aimType;
  // "Target Switching" and "Switching" are the same answer in two wordings.
  const normalise = (v: string | null | undefined) =>
    (v ?? "").toLowerCase().replace("target ", "");
  return known != null && normalise(known) === normalise(c.aimType);
});
check(
  "every correction still disagrees with KovaaK's",
  vacuous.length === 0,
  vacuous.map(([n]) => n).join(", "),
);

const misquoted = corrections.filter(([name, c]) => {
  const known = tax.get(name)?.aimType;
  return known != null && known !== c.kovaaksSays;
});
check(
  "every correction quotes what KovaaK's actually says",
  misquoted.length === 0,
  misquoted
    .map(([n, c]) => `${n} quotes ${c.kovaaksSays}, taxonomy says ${tax.get(n)?.aimType}`)
    .join("; "),
);

const unreasoned = corrections.filter(([, c]) => !c.why || c.why.trim().length < 80);

// Every correction overrules KovaaK's alone, never KovaaK's plus its own benchmarks. The
// named benchmarks must therefore actually name the scenario - a correction claiming
// support it does not have is the one failure mode this file cannot afford.
const unsupported: string[] = [];
for (const [name, c] of corrections) {
  const naming = namesFor.get(name) ?? new Set<string>();
  if (!c.namedBy || c.namedBy.length === 0) {
    unsupported.push(`${name} names no benchmark`);
    continue;
  }
  for (const b of c.namedBy) {
    if (!naming.has(`${b.benchmark} :: ${b.label}`)) {
      unsupported.push(`${name} claims ${b.benchmark} / ${b.label}, which is not in the definitions`);
    }
  }
}
check(
  "every correction says why at length",
  unreasoned.length === 0,
  unreasoned.map(([n]) => n).join(", "),
);
check(
  "every benchmark and label a correction cites is in the committed definitions",
  unsupported.length === 0,
  unsupported.join("; "),
);

// ---- the measurement -------------------------------------------------------------------

console.log(`\n${BOLD}the measurement${RESET}  ${DIM}re-derived from the stats folder${RESET}`);

if (!existsSync(statsDir)) {
  console.log(
    `  ${DIM}no stats folder at ${statsDir}${RESET}\n` +
      `  ${DIM}the figures in the file are UNCHECKED on this machine${RESET}`,
  );
} else {
  /** Shots per kill across every local run of a scenario. */
  const measure = (
    scenario: string,
  ): { runs: number; kills: number; shotsPerKill: number; weapon: string } | null => {
    const prefix = `${scenario} - `;
    let runs = 0;
    let kills = 0;
    let shots = 0;
    const weapons = new Map<string, number>();

    for (const entry of readdirSync(statsDir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".csv")) continue;
      const parsed = parseStatsFile(entry, readFileSync(join(statsDir, entry), "utf8"));
      if (!parsed.ok) continue;

      runs++;
      for (const row of parsed.run.killRows) {
        kills++;
        shots += row.shots;
        weapons.set(row.weapon, (weapons.get(row.weapon) ?? 0) + 1);
      }
    }

    if (kills === 0) return null;
    const weapon = [...weapons.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { runs, kills, shotsPerKill: shots / kills, weapon };
  };

  // The reference ranges first: the discriminator has to be shown working before it is
  // used to overrule anybody.
  let refMeasured = 0;
  let refWrong: string[] = [];
  const bounds = new Map<string, { lo: number; hi: number }>();

  for (const [type, band] of Object.entries(file.measurement.reference)) {
    // The reference block carries a $comment alongside the bands.
    if (type.startsWith("$") || !Array.isArray(band?.examples)) continue;
    for (const ex of band.examples) {
      const got = measure(ex.scenario);
      if (!got) continue;
      refMeasured++;
      const b = bounds.get(type) ?? { lo: Infinity, hi: -Infinity };
      bounds.set(type, {
        lo: Math.min(b.lo, got.shotsPerKill),
        hi: Math.max(b.hi, got.shotsPerKill),
      });
      // Five percent, not a tenth of a shot per kill.
      //
      // A tenth was the first rule and it fails on ordinary play: these figures are
      // averages over a growing corpus, so every session on a reference scenario moves the
      // last digit and breaks the build. It did, three times, and each time the fix was to
      // retype a number nobody had reason to doubt - which is how a check stops being read.
      //
      // Five percent is chosen against what the figure is *for*. A correction has to refute
      // its KovaaK's label by a factor of ten, and the bands it separates are 1.0-1.3
      // against about 40, so a figure would have to be wrong by more than an order of
      // magnitude to threaten the claim. Anything inside five percent cannot; anything
      // outside it is a scenario that has genuinely changed and wants looking at rather
      // than rounding.
      if (Math.abs(got.shotsPerKill - ex.shotsPerKill) > ex.shotsPerKill * 0.05) {
        refWrong.push(
          `${ex.scenario} quoted ${ex.shotsPerKill}, measured ${got.shotsPerKill.toFixed(1)}`,
        );
      }
      console.log(
        `  ${DIM}${type.padEnd(10)} ${ex.scenario.padEnd(26)} ` +
          `${got.shotsPerKill.toFixed(1).padStart(7)} shots/kill over ${got.kills.toLocaleString()} kills${RESET}`,
      );
    }
  }

  if (refMeasured === 0) {
    console.log(`  ${DIM}no reference scenario has local runs; ranges UNCHECKED${RESET}`);
  } else {
    check("every quoted reference figure matches the corpus", refWrong.length === 0, refWrong.join("; "));
  }

  // Then the corrections themselves.
  const clicking = bounds.get("Clicking");
  let unmeasured: string[] = [];
  let wrongFigure: string[] = [];
  let notSeparated: string[] = [];

  for (const [name, c] of corrections) {
    const got = measure(name);
    if (!got) {
      unmeasured.push(name);
      continue;
    }
    console.log(
      `  ${DIM}${"corrected".padEnd(10)} ${name.padEnd(26)} ` +
        `${got.shotsPerKill.toFixed(1).padStart(7)} shots/kill over ${got.kills.toLocaleString()} kills${RESET}`,
    );

    if (Math.abs(got.shotsPerKill - c.measured.shotsPerKill) > 0.1) {
      wrongFigure.push(
        `${name} quotes ${c.measured.shotsPerKill}, measured ${got.shotsPerKill.toFixed(1)}`,
      );
    }
    if (got.weapon !== c.measured.weapon) {
      wrongFigure.push(`${name} quotes weapon ${c.measured.weapon}, measured ${got.weapon}`);
    }

    // The point of the whole file: the measurement must REFUTE the label KovaaK's gave,
    // by a factor of ten, not merely sit near its edge. The statistic settles exactly one
    // question - one shot per kill, or sustained fire - so it refutes in both directions:
    //
    //   labelled Clicking  must measure far ABOVE the clicking band; clicking kills in one
    //                      shot, so hundreds of shots per kill cannot be clicking
    //   labelled Tracking  must measure far BELOW the tracking band; tracking a target to
    //                      death takes sustained fire, so ~1 shot per kill cannot be it
    //
    // Nothing refutes a Switching label this way, because switching spans both: one-shot
    // switching sits at 1.5 and multi-shot at 40. A correction away from Switching would
    // need a different measurement, and there is none here, so it is refused.
    const band = bounds.get(c.kovaaksSays === "Target Switching" ? "Switching" : c.kovaaksSays);

    if (c.kovaaksSays === "Clicking") {
      if (!band) notSeparated.push(`${name}: no clicking band measured to refute`);
      else if (got.shotsPerKill < band.hi * 10) {
        notSeparated.push(
          `${name} at ${got.shotsPerKill.toFixed(1)} is not clear of clicking's ${band.hi.toFixed(1)}`,
        );
      }
    } else if (c.kovaaksSays === "Tracking") {
      if (!band) notSeparated.push(`${name}: no tracking band measured to refute`);
      else if (got.shotsPerKill * 10 > band.lo) {
        notSeparated.push(
          `${name} at ${got.shotsPerKill.toFixed(1)} is not clear of tracking's ${band.lo.toFixed(1)}`,
        );
      }
    } else {
      notSeparated.push(
        `${name} corrects away from ${c.kovaaksSays}, which shots per kill cannot refute`,
      );
    }
  }

  if (unmeasured.length > 0) {
    console.log(
      `  ${DIM}${unmeasured.length} correction(s) have no local runs and are UNCHECKED: ` +
        `${unmeasured.join(", ")}${RESET}`,
    );
  }
  if (unmeasured.length < corrections.length) {
    check("every quoted correction figure matches the corpus", wrongFigure.length === 0, wrongFigure.join("; "));
    check(
      "every correction is clear of the range KovaaK's put it in",
      notSeparated.length === 0,
      notSeparated.join("; "),
    );
  }
}

console.log(
  failures === 0 ? `\nOK: aim type corrections validated\n` : `\nFAILED: ${failures} check(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
