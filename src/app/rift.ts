import { randomInt, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANOMALIES, COMETS, GRADES, HAZARDS, SIGNALS, STAGES, VESSELS, actRift, encounterHull, previews, receiveRift, startRift, terminal, type Receipt, type RiftState } from '../core/rift/engine.ts';
import { RECORD_LIMIT, RiftStore, type RiftRecord, type RiftSave } from '../core/rift/store.ts';
import { loadSeason } from '../core/season/season.ts';
import { readStatsFolder, type StatsFileRun } from '../core/stats/folderCache.ts';
import { runDurationSeconds, isAbandonedRun } from '../core/stats/duration.ts';
import { dataFile } from '../core/dataDir.ts';

/** Local timestamps use the same clock for both ends, including midnight-spanning runs. */
export function riftReceipt(run: StatsFileRun, expected: number | null): Receipt | null {
  const duration = runDurationSeconds(run.challengeStart, run.playedAt);
  if (!run.coherent || !run.playedAt || duration === null || duration <= 0 || expected === null ||
      isAbandonedRun(duration, expected) || !Number.isFinite(run.score) || run.score < 0) return null;
  const at = run.playedAt.getTime();
  return { id: createHash('sha256').update(`${run.scenario}\n${at}\n${run.challengeStart}`).digest('hex'), scenario: run.scenario, score: run.score, at, startedAt: at - duration * 1000 };
}
const armedScenario = (s: RiftState | null) => s?.phase === 'combat' && s.fight?.armed ? s.fight.hand[s.fight.armed.card].scenario : null;
function record(s: RiftState, at: number): RiftRecord {
  return { id: s.id, outcome: s.phase, band: s.bandName, vessel: s.vessel, system: s.system + 1, cleared: s.stats.clears,
    damage: s.stats.damage, bestHit: s.stats.bestHit, anomalies: s.anomalies.map(o => o.id), at };
}
/** The first flight saved to rift-v1.json in a format this version does not read; it is left in place, untouched. */
export const RIFT_SAVE = 'rift-v2.json';
export class RiftService {
  private store: RiftStore;
  private save: RiftSave | null = null;
  private warning: string | null = null;
  private durations: Map<string, number> | null = null;
  constructor(folder: string, private now: () => number = Date.now) { this.store = new RiftStore(join(folder, RIFT_SAVE)); }
  private load() {
    if (!this.save) { const result = this.store.load(); this.save = result.save; this.warning = result.warning; }
  }
  private commit(save: RiftSave) { this.store.save(save); this.save = save; }
  private sync(dir: string | null) {
    this.load();
    const scenario = armedScenario(this.save!.state);
    if (!dir || !scenario) return;
    const expected = this.duration(scenario);
    const receipts = readStatsFolder(dir).filter(({ run }) => run.scenario === scenario)
      .map(({ run }) => riftReceipt(run, expected)).filter((r): r is Receipt => !!r).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    for (const receipt of receipts) {
      const next = receiveRift(this.save!.state!, receipt, this.now());
      if (next !== this.save!.state) { this.commit(this.withRecord({ ...this.save!, state: next })); break; }
    }
  }
  /** A finished voyage keeps one record, refreshed if a won voyage goes on into the deep Rift. */
  private withRecord(save: RiftSave): RiftSave {
    const s = save.state;
    if (!s || !terminal(s)) return save;
    return { ...save, records: [record(s, this.now()), ...save.records.filter(r => r.id !== s.id)].slice(0, RECORD_LIMIT) };
  }
  private duration(scenario: string): number | null {
    this.durations ??= new Map(JSON.parse(readFileSync(dataFile('scenario_durations.json'), 'utf8')).durations
      .filter((d: any) => Number.isFinite(d.seconds) && d.seconds > 0).map((d: any) => [d.scenario, d.seconds]));
    return this.durations.get(scenario) ?? null;
  }
  view(dir: string | null, sync = false) {
    let error: string | null = null;
    try { this.load(); if (sync) this.sync(dir); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const season = loadSeason(), state = this.save?.state ?? null;
    // Derived numbers the renderer shows but must not compute: it is a pure view.
    const derived = state ? {
      previews: previews(state),
      route: STAGES.map((st, i) => ({ stage: i, name: st.name, hull: encounterHull(state, state.system, i), pay: st.pay })),
    } : null;
    return { state, derived, records: this.save?.records ?? [], anomalies: ANOMALIES, comets: COMETS, hazards: HAZARDS, signals: SIGNALS,
      vessels: VESSELS, grades: GRADES, bands: season.windows ?? [], canPlay: !!dir, error, warning: this.warning };
  }
  action(raw: unknown, dir: string | null) {
    this.load(); this.sync(dir);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose a Rift action.');
    const a = raw as Record<string, unknown>, now = this.now();
    if (a.type === 'start') {
      if (!dir) throw new Error("Choose your KovaaK's stats folder before entering the Rift.");
      if (this.save!.state && !terminal(this.save!.state)) throw new Error('Finish or extract from your current voyage first.');
      const season = loadSeason(), band = a.band;
      if (typeof band !== 'number' || !Number.isInteger(band) || !season.windows?.[band] || typeof a.vessel !== 'string') throw new Error('Choose a difficulty and a vessel.');
      // A fixed published reference avoids rewarding sandbagging and never moves after a voyage starts.
      const pool = season.scenarios.filter(s => (s.window ?? 0) === band && this.duration(s.scenario) !== null)
        .map(s => ({ scenario: s.scenario, category: s.category, target: s.rankMaxes[0] }));
      this.commit({ ...this.save!, state: startRift(pool, band, season.windows[band], a.vessel, randomInt(0x100000000), now) });
    } else {
      if (!this.save!.state) throw new Error('Start a voyage first.');
      if (a.type === 'arm' && !dir) throw new Error('Reconnect your stats folder before playing.');
      this.commit(this.withRecord({ ...this.save!, state: actRift(this.save!.state, a, now) }));
    }
    return this.view(dir);
  }
  launchScenario(dir: string | null): string {
    this.load();
    const scenario = armedScenario(this.save!.state);
    if (!dir || !scenario) throw new Error('Prepare a salvo before launching.');
    if (!loadSeason().scenarios.some(e => e.scenario === scenario)) throw new Error('This scenario has left the installed season. Your voyage is saved; restore its scenario before continuing.');
    return scenario;
  }
}
