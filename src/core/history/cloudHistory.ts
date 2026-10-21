import type { StatsFileRun } from "../stats/folderCache.ts";

export interface CloudRun {
  id: string;
  scenario_name: string;
  score: number;
  played_at: string;
  csv_sha256: string;
}

let saved: CloudRun[] = [];
/** Scoped to the signed-in player by the desktop; cleared before switching accounts. */
export function setCloudHistory(runs: CloudRun[]): void { saved = runs; }
export function cloudHistoryCount(): number { return saved.length; }

/** Only reporting history is merged. Cloud rows never become files or playable runs. */
export function historyWithCloud(local: {file: string; run: StatsFileRun}[]): StatsFileRun[] {
  const hashes = new Set(local.flatMap(({run}) => run.csvSha256 ? [run.csvSha256] : []));
  const out = local.map(({run}) => run);
  const seen = new Set<string>();
  for (const row of saved) {
    if (hashes.has(row.csv_sha256) || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({scenario: row.scenario_name, score: row.score, playedAt: new Date(row.played_at),
      challengeStart: null, coherent: false, csvSha256: row.csv_sha256});
  }
  return out;
}

export function validCloudRuns(value: unknown): value is CloudRun[] {
  return Array.isArray(value) && value.every(row => row && typeof row.id === "string" &&
    typeof row.scenario_name === "string" && row.scenario_name.length > 0 &&
    typeof row.score === "number" && Number.isFinite(row.score) &&
    typeof row.played_at === "string" && Number.isFinite(Date.parse(row.played_at)) &&
    typeof row.csv_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.csv_sha256));
}
