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
  subCategory: string;
  kovaaksSays: string;
  measured: { runs: number; kills: number; shotsPerKill: number; weapon: string; bot?: string };
  why: string;
  note?: string;
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
check(
  "every correction says why at length",
  unreasoned.length === 0,
  unreasoned.map(([n]) => n).join(", "),
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
      // A tenth of a shot per kill: enough that a quoted figure has to be the real one.
      if (Math.abs(got.shotsPerKill - ex.shotsPerKill) > 0.1) {
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

    // The point of the whole file: the scenario must sit OUTSIDE the range of the type
    // KovaaK's gave it, by a margin, not merely near its edge. Ten times the top of the
    // clicking range - the observed gap is over a hundred times, so this has room.
    if (c.kovaaksSays === "Clicking" && clicking && got.shotsPerKill < clicking.hi * 10) {
      notSeparated.push(
        `${name} at ${got.shotsPerKill.toFixed(1)} is not clear of clicking's ${clicking.hi.toFixed(1)}`,
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
