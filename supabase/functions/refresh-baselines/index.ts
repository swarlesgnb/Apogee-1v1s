/**
 * Recompute every baseline for the caller from their stored runs.
 *
 * Baselines are normally refreshed one scenario at a time by `submit-run`. Backfill
 * does not go through that path: it writes thousands of rows straight to the table
 * under RLS, which is the right trade for history that decides nothing on its own, but
 * it leaves `baselines` empty.
 *
 * That gap is not harmless. `settle-match` falls back to deriving a baseline on the fly
 * and marks it provisional, which halves the rating weight. A player who has just
 * uploaded eleven thousand runs has anything but a provisional baseline, so the first
 * real match would be discounted for no reason.
 *
 * Run after a backfill, and safe to run at any time: it only ever recomputes from rows
 * that are already stored.
 */

import { handler, json, requireCaller } from "../_shared/arena.ts";
import { baselineFromScores } from "../../../src/core/history/baseline.ts";

/** Most recent runs considered per scenario. Matches BASELINE_WINDOW plus headroom. */
const HISTORY_LIMIT = 200;

interface RunRow {
  scenario_id: number;
  score: number;
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);

  // Only runs on known scenarios can have a baseline: an unmapped scenario has no
  // benchmark to be measured against.
  const { data: runs, error } = await admin
    .from("runs")
    .select("scenario_id, score, played_at")
    .eq("player_id", caller.playerId)
    .not("scenario_id", "is", null)
    .neq("verification_tier", "rejected")
    .order("played_at", { ascending: true })
    .limit(20000);

  if (error) return json({ error: error.message }, 500);

  const byScenario = new Map<number, number[]>();
  for (const row of (runs ?? []) as RunRow[]) {
    const list = byScenario.get(row.scenario_id) ?? [];
    list.push(Number(row.score));
    byScenario.set(row.scenario_id, list);
  }

  if (byScenario.size === 0) {
    return json({ baselines: 0, scenarios: 0, message: "no runs on known scenarios yet" });
  }

  // KovaaK's-verified personal bests supply the floor that defeats sandbagging.
  const { data: pbs } = await admin
    .from("verified_pbs")
    .select("scenario_id, score")
    .eq("player_id", caller.playerId);

  const pbByScenario = new Map(
    (pbs ?? []).map((p: { scenario_id: number; score: number }) => [
      p.scenario_id,
      Number(p.score),
    ]),
  );

  const { data: names } = await admin
    .from("scenarios")
    .select("id, name")
    .in("id", [...byScenario.keys()]);

  const nameById = new Map(
    (names ?? []).map((s: { id: number; name: string }) => [s.id, s.name]),
  );

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  let provisional = 0;

  for (const [scenarioId, scores] of byScenario) {
    // Oldest first from the query; the baseline uses the tail.
    const recent = scores.slice(-HISTORY_LIMIT);
    const baseline = baselineFromScores(
      nameById.get(scenarioId) ?? String(scenarioId),
      recent,
      pbByScenario.get(scenarioId) ?? null,
    );

    // A baseline of zero or less cannot divide, so it is skipped rather than stored.
    if (!(baseline.value > 0)) continue;
    if (baseline.provisional) provisional++;

    rows.push({
      player_id: caller.playerId,
      scenario_id: scenarioId,
      value: baseline.value,
      run_count: baseline.runCount,
      provisional: baseline.provisional,
      floored_by_pb: baseline.flooredByPb,
      computed_at: now,
    });
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: upsertError } = await admin
      .from("baselines")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "player_id,scenario_id" });
    if (upsertError) return json({ error: upsertError.message }, 500);
  }

  return json({
    baselines: rows.length,
    scenarios: byScenario.size,
    provisional,
    solid: rows.length - provisional,
  });
}));
