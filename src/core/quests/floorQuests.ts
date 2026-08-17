/**
 * Quests that target the floor rather than the ceiling.
 *
 * An ordinary benchmark quest asks for one good run. A floor quest asks for five runs
 * with no bad one, which is a different skill and the one that actually transfers: in a
 * game there is no retry, so the run that decides a fight is closer to your worst than
 * your best.
 *
 * They are also more honest about progress. "Get a personal best" is a coin flip you
 * can reroll indefinitely; "three of your last five clear 2550" is a state you can see,
 * and the only way to finish it is to stop having bad runs.
 */

import { computeFloor, FLOOR_WINDOW } from "../consistency/floor.ts";
import type { DifficultyDef, ScenarioDef } from "../benchmarks/types.ts";
import type { ScenarioHistory } from "../history/history.ts";
import type { Quest } from "./generate.ts";

/** Rank index a score earns on one scenario, or −1 for none. */
function rankIndexOf(rankMaxes: number[], score: number): number {
  let idx = -1;
  for (let i = 0; i < rankMaxes.length; i++) {
    if (score >= rankMaxes[i]) idx = i;
    else break;
  }
  return idx;
}

function shortName(scenario: string, difficulty: string): string {
  return scenario
    .replace(/^VT /, "")
    .replace(new RegExp(`\\s*${difficulty.split(" ")[0]}\\s*`, "i"), " ")
    .replace(/\s*S\d(\.\d)?\s*$/i, "")
    .trim();
}

interface Candidate {
  scenario: ScenarioDef;
  label: string;
  floor: number;
  ceiling: number;
  gap: number;
  /** Score needed to lift the floor a rank. */
  target: number;
  targetRank: string;
  /** How many of the last `FLOOR_WINDOW` runs already clear the target. */
  clearing: number;
  recent: number[];
}

/**
 * Scenarios where a floor rank-up is within reach.
 *
 * Ordered by how close the player already is, because a quest naming a number they can
 * nearly hit is worth more than one naming the biggest theoretical gain.
 */
function floorCandidates(
  difficulty: DifficultyDef,
  history: Map<string, ScenarioHistory>,
): Candidate[] {
  const out: Candidate[] = [];

  for (const category of difficulty.categories) {
    for (const scenario of category.scenarios) {
      const h = history.get(scenario.name);
      if (!h || h.runs.length < FLOOR_WINDOW) continue;

      const scores = h.runs.map((r) => r.score);
      const result = computeFloor(scores);
      if (!result || result.provisional) continue;

      const floorRank = rankIndexOf(scenario.rankMaxes, result.floor);
      const nextRank = floorRank + 1;
      if (nextRank >= scenario.rankMaxes.length) continue; // floor already at max

      const target = scenario.rankMaxes[nextRank];
      const recent = scores.slice(-FLOOR_WINDOW);

      out.push({
        scenario,
        label: shortName(scenario.name, difficulty.name),
        floor: result.floor,
        ceiling: result.ceiling,
        gap: result.gap,
        target,
        targetRank: difficulty.rankNames[nextRank] ?? "next rank",
        clearing: recent.filter((s) => s >= target).length,
        recent,
      });
    }
  }

  // Most nearly-there first: how many of the window already clear, then how small the
  // shortfall is relative to the score.
  return out.sort((a, b) => {
    if (b.clearing !== a.clearing) return b.clearing - a.clearing;
    return (a.target - a.floor) / a.target - (b.target - b.floor) / b.target;
  });
}

export interface FloorQuestOptions {
  difficulty: DifficultyDef;
  history: Map<string, ScenarioHistory>;
  now: Date;
  count?: number;
}

function endOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function generateFloorQuests(options: FloorQuestOptions): Quest[] {
  const { difficulty, history, now } = options;
  const count = options.count ?? 3;
  const expiresAt = endOfDay(now);

  const candidates = floorCandidates(difficulty, history);
  if (candidates.length === 0) return [];

  const quests: Quest[] = [];

  // --- lift a floor a whole rank ---------------------------------------------------
  for (const c of candidates.slice(0, 2)) {
    quests.push({
      id: `floor_rank:${c.scenario.name}`,
      kind: "floor_rank_up",
      title: `Lift your ${c.label} floor to ${c.targetRank}`,
      detail:
        `Your worst of the last ${FLOOR_WINDOW} is ${c.floor.toFixed(0)}. ` +
        `All ${FLOOR_WINDOW} need to clear ${c.target.toFixed(0)}; ` +
        `${c.clearing} of them do right now.`,
      target: FLOOR_WINDOW,
      progress: c.clearing,
      xp: 500,
      subject: c.scenario.name,
      expiresAt,
    });
  }

  // --- the widest spread, where practice pays most ---------------------------------
  const widest = [...candidates].sort((a, b) => b.gap - a.gap)[0];
  if (widest) {
    // A tenth off the current spread: enough to be felt, small enough to be plausible
    // in one session.
    const targetGap = Math.max(0.05, widest.gap - 0.1);
    const neededFloor = widest.ceiling * (1 - targetGap);

    quests.push({
      id: `floor_spread:${widest.scenario.name}`,
      kind: "close_the_spread",
      title: `Close the ${widest.label} spread to ${(targetGap * 100).toFixed(0)}%`,
      detail:
        `Ceiling ${widest.ceiling.toFixed(0)}, floor ${widest.floor.toFixed(0)}, ` +
        `a ${(widest.gap * 100).toFixed(0)}% spread. ` +
        `Keep every run above ${neededFloor.toFixed(0)} to close it.`,
      target: FLOOR_WINDOW,
      progress: widest.recent.filter((s) => s >= neededFloor).length,
      xp: 400,
      subject: widest.scenario.name,
      expiresAt,
    });
  }

  // --- no disasters -----------------------------------------------------------------
  // Deliberately not tied to one scenario: the habit being trained is refusing to bank
  // a bad run anywhere, not grinding a single map.
  const steadiest = [...candidates].sort((a, b) => a.gap - b.gap)[0];
  if (steadiest) {
    quests.push({
      id: "no_disasters",
      kind: "no_disasters",
      title: "No disasters today",
      detail:
        `Play ${FLOOR_WINDOW} runs of anything without one landing below your ` +
        `baseline. Your steadiest right now is ${steadiest.label} at ` +
        `${(steadiest.gap * 100).toFixed(0)}% spread.`,
      target: FLOOR_WINDOW,
      progress: 0,
      xp: 350,
      expiresAt,
    });
  }

  return quests.slice(0, count);
}
