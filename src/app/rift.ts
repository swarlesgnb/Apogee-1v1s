import { randomInt, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ABILITIES, BOSSES, STARTERS, actRift, receiveRift, startRift, terminal, type Receipt } from '../core/rift/engine.ts';
import { RiftStore, type RiftSave } from '../core/rift/store.ts';
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
export class RiftService {
  private store: RiftStore;
  private save: RiftSave | null = null;
  private warning: string | null = null;
  private durations: Map<string, number> | null = null;
  constructor(folder: string, private now: () => number = Date.now) { this.store = new RiftStore(join(folder, 'rift-v1.json')); }
  private load() {
    if (!this.save) { const result = this.store.load(); this.save = result.save; this.warning = result.warning; }
  }
  private commit(save: RiftSave) { this.store.save(save); this.save = save; }
  private sync(dir: string | null) {
    this.load();
    if (!dir || this.save!.state?.phase !== 'combat' || !this.save!.state.fight?.armed) return;
    const expected = this.duration(this.save!.state.fight.encounter.scenario);
    const receipts = readStatsFolder(dir).filter(({ run }) => run.scenario === this.save!.state!.fight!.encounter.scenario)
      .map(({ run }) => riftReceipt(run, expected)).filter((r): r is Receipt => !!r).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    for (const receipt of receipts) {
      const next = receiveRift(this.save!.state!, receipt, this.now());
      if (next !== this.save!.state) { this.commit({ ...this.save!, state: next }); break; }
    }
  }
  private duration(scenario: string): number | null {
    this.durations ??= new Map(JSON.parse(readFileSync(dataFile('scenario_durations.json'), 'utf8')).durations
      .filter((d: any) => Number.isFinite(d.seconds) && d.seconds > 0).map((d: any) => [d.scenario, d.seconds]));
    return this.durations.get(scenario) ?? null;
  }
  view(dir: string | null, sync = false) {
    let error: string | null = null;
    try { this.load(); if (sync) this.sync(dir); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const season = loadSeason();
    return { state: this.save?.state ?? null, records: this.save?.records ?? [], abilities: ABILITIES, starters: STARTERS, bosses: BOSSES,
      bands: season.windows ?? [], canPlay: !!dir, error, warning: this.warning };
  }
  action(raw: unknown, dir: string | null) {
    this.load(); this.sync(dir);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose a Rift action.');
    const a = raw as Record<string, unknown>, now = this.now();
    if (a.type === 'start') {
      if (!dir) throw new Error("Choose your KovaaK's stats folder before entering the Rift.");
      if (this.save!.state && !terminal(this.save!.state)) throw new Error('Finish or extract from your current voyage first.');
      const season = loadSeason(), band = a.band;
      if (typeof band !== 'number' || !Number.isInteger(band) || !season.windows?.[band] || typeof a.starter !== 'string') throw new Error('Choose a difficulty and starting ship.');
      // A fixed published reference avoids rewarding sandbagging and never moves after a voyage starts.
      const pool = season.scenarios.filter(s => (s.window ?? 0) === band && this.duration(s.scenario) !== null)
        .map(s => ({ scenario: s.scenario, category: s.category, target: s.rankMaxes[0] }));
      this.commit({ ...this.save!, state: startRift(pool, band, season.windows[band], a.starter, randomInt(0x100000000), now) });
    } else {
      if (!this.save!.state) throw new Error('Start a voyage first.');
      if (a.type === 'arm' && !dir) throw new Error('Reconnect your stats folder before playing.');
      const state = actRift(this.save!.state, a, now);
      const records = [...this.save!.records];
      if (terminal(state) && !records.some(r => r.id === state.id)) records.unshift({ id: state.id, outcome: state.phase, band: state.bandName,
        starter: state.starter, depth: state.depth + 1, cleared: state.log.filter(r => r.verdict === 'clear').length,
        damage: state.log.reduce((n, r) => n + r.damage, 0), abilities: [...state.abilities], at: now });
      this.commit({ ...this.save!, state, records: records.slice(0, 12) });
    }
    return this.view(dir);
  }
  launchScenario(dir: string | null): string {
    this.load();
    const s = this.save!.state;
    if (!dir || s?.phase !== 'combat' || !s.fight?.armed) throw new Error('Prepare a round before launching.');
    if (!loadSeason().scenarios.some(e => e.scenario === s.fight!.encounter.scenario)) throw new Error('This scenario has left the installed season. Your voyage is saved; restore its scenario before continuing.');
    return s.fight.encounter.scenario;
  }
}
