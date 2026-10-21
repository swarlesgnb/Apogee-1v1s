import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validCloudRuns, type CloudRun } from "../core/history/cloudHistory.ts";

/** Account-scoped reporting cache; never creates or uploads substitute CSV files. */
export class CloudHistoryStore {
  constructor(private directory: string) {}
  private path(playerId: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(playerId)) throw Error("Invalid player identity");
    return join(this.directory, playerId + ".json");
  }
  load(playerId: string): CloudRun[] {
    try {
      const data = JSON.parse(readFileSync(this.path(playerId), "utf8"));
      return data.version === 1 && data.playerId === playerId && validCloudRuns(data.runs) ? data.runs : [];
    } catch { return []; }
  }
  save(playerId: string, runs: CloudRun[]): void {
    if (!validCloudRuns(runs)) throw Error("Invalid saved history");
    const path = this.path(playerId);
    mkdirSync(this.directory, {recursive: true});
    writeFileSync(path + ".tmp", JSON.stringify({version: 1, playerId, savedAt: new Date().toISOString(), runs}));
    renameSync(path + ".tmp", path);
  }
}

export async function downloadCloudHistory(client: SupabaseClient, playerId: string): Promise<CloudRun[]> {
  const out: CloudRun[] = [];
  const cutoff = new Date().toISOString();
  let cursor: string | null = null;
  while (true) {
    let query = client.from("runs").select("id,scenario_name,score,played_at,csv_sha256")
      .eq("player_id", playerId).lte("created_at", cutoff).order("csv_sha256").limit(1000);
    // The existing unique (player_id, csv_sha256) index makes this a bounded seek.
    // Ordering by UUID instead caused the live runs table to time out.
    if (cursor) query = query.gt("csv_sha256", cursor);
    const {data, error} = await query;
    if (error) throw Error(error.message);
    if (!validCloudRuns(data)) throw Error("The server returned unreadable score history.");
    if (!data.length) break;
    const next = data[data.length - 1].csv_sha256;
    if (next === cursor) throw Error("Score history download stopped advancing.");
    out.push(...data);
    cursor = next;
  }
  return out;
}
