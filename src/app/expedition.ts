import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadExpedition, rewardCatalog } from "../core/expedition/definition.ts";
import { abandonTrial, acceptChallenge, challengeOffers, destinationFor, enroll, startTrial, syncExpedition } from "../core/expedition/engine.ts";
import { migrateExpedition } from "../core/expedition/migrate.ts";
import { journeys, journeyView } from "../core/expedition/journey.ts";
import { ExpeditionRunReader } from "../core/expedition/runs.ts";
import { ExpeditionStore } from "../core/expedition/store.ts";
import type { ChallengeKind, ExpeditionRun, ExpeditionState, ExpeditionView } from "../core/expedition/types.ts";
import { buildMatchPlaylist, serializePlaylist } from "../core/match/playlist.ts";
import { playlistsFolderFor } from "../core/season/practice.ts";

export class ExpeditionService {
  readonly definition = loadExpedition();
  readonly rewards = rewardCatalog(this.definition);
  private store: ExpeditionStore;
  private reader = new ExpeditionRunReader();
  private state: ExpeditionState | null = null;
  private error: string | null = null;
  private warning: string | null = null;
  private loaded = false;
  private history: ExpeditionRun[] = [];
  readonly sessionStartedAt = Date.now();
  constructor(private folder: string) { this.store = new ExpeditionStore(join(folder, "expedition-first-light-v3.json"), this.definition); }
  private load() {
    if (this.loaded) return;
    const result = this.store.load();
    this.state = result.state; this.warning = result.warning;
    if (!this.state) {
      const v2 = loadExpedition(2), prior = new ExpeditionStore(join(this.folder, "expedition-first-light-v2.json"), v2).load();
      let old = prior.state;
      if (!old) {
        const legacy = loadExpedition(1), source = new ExpeditionStore(join(this.folder, "expedition-first-light-v1.json"), legacy).load();
        if (source.state) old = migrateExpedition(source.state, legacy, v2, Date.now());
      }
      if (old) {
        this.commit(migrateExpedition(old, v2, this.definition, Date.now()));
        this.warning = "Your rewards, accepted targets, and progress are carried over. An active attempt keeps its original rules. Your previous save is preserved separately.";
      }
    }
    this.loaded = true;
  }
  private commit(next: ExpeditionState) { this.store.save(next); this.state = next; this.error = null; }
  view(dir: string | null, sync = false): ExpeditionView {
    try {
      this.load();
      if (sync && dir && this.state) {
        this.history = this.reader.read(dir);
        const next = syncExpedition(this.state, this.definition, this.history, Date.now());
        if (JSON.stringify(next) !== JSON.stringify(this.state)) this.commit(next);
      }
      this.error = null;
    } catch (e) { this.error = String(e instanceof Error ? e.message : e); }
    const id = this.state?.selected ?? this.definition.destinations[0].id, band = this.state?.band ?? 0;
    const offers = id === 'final' ? [] : challengeOffers(this.definition, id, band, [...(this.state?.runs ?? []), ...this.history]);
    for (const offer of offers) {
      const accepted = this.state?.routes[`${id}:${band}`]?.challenges.find(c => c.kind === offer.kind);
      if (accepted?.steps) offer.steps = accepted.steps;
    }
    return { definition: this.definition, state: this.state, rewards: this.rewards, error: this.error, warning: this.warning, canPlay: !!dir, sessionStartedAt: this.sessionStartedAt, offers, journeys, journey: journeyView(this.state, this.definition) };
  }
  action(raw: unknown, dir: string | null): ExpeditionView {
    this.load();
    if (!raw || typeof raw !== "object") throw new Error("No expedition action was supplied.");
    const a = raw as Record<string, unknown>, now = Date.now();
    if (a.type === "enroll") {
      if (!dir) throw new Error("Choose your KovaaK's stats folder before joining the expedition.");
      if (!this.state) {
        const initial = enroll(this.definition, now);
        if (a.band !== undefined) {
          if (typeof a.band !== 'number') throw new Error("Choose a valid difficulty band.");
          destinationFor(this.definition, initial.selected, a.band); initial.band = a.band;
        }
        if (typeof a.destination === 'string' && a.destination !== 'final') {
          destinationFor(this.definition, a.destination, initial.band); initial.selected = a.destination;
        }
        this.commit(initial);
      }
      return this.view(dir);
    }
    if (!this.state) throw new Error("Join the expedition first.");
    if (dir) {
      this.history = this.reader.read(dir);
      const synced = syncExpedition(this.state, this.definition, this.history, now);
      if (JSON.stringify(synced) !== JSON.stringify(this.state)) this.commit(synced);
    }
    const id = typeof a.destination === "string" ? a.destination : this.state.selected;
    const band = typeof a.band === "number" ? a.band : this.state.band;
    let next = structuredClone(this.state);
    switch (a.type) {
      case "select":
        if (id !== "final") destinationFor(this.definition, id, band);
        else if (!Number.isInteger(band) || !this.definition.bands[band]) throw new Error("Choose a valid band.");
        next.selected = id; next.band = band; break;
      case "accept":
        if (!dir) throw new Error("Choose your stats folder first.");
        next = acceptChallenge(next, this.definition, id, band, [...next.runs, ...this.history], now, typeof a.kind === 'string' ? a.kind as ChallengeKind : undefined); break;
      case "start":
        if (!dir) throw new Error("Choose your stats folder first.");
        if (a.approach !== undefined && a.approach !== 'direct' && a.approach !== 'prepared') throw new Error("Choose a valid trial approach.");
        next = startTrial(next, this.definition, id, band, now, a.approach as 'direct' | 'prepared' | undefined); break;
      case "abandon": next = abandonTrial(next, now); break;
      case "pause-route":
        if (next.routes[`${id}:${band}`]) delete next.routes[`${id}:${band}`].selectedKind;
        break;
      case "equip": {
        const reward = this.rewards.find(r => r.id === a.reward);
        if (!reward || !next.rewards[reward.id] || ["relic", "trophy"].includes(reward.kind)) throw new Error("Choose an earned appearance to equip.");
        next.equipped[reward.kind] = reward.id; break;
      }
      default: throw new Error("Unknown expedition action.");
    }
    this.commit(next); return this.view(dir);
  }
  playlist(dir: string | null): { scenario: string; note: string } {
    this.load();
    if (!dir || !this.state) throw new Error("Join the expedition and choose a stats folder first.");
    const { state, definition: def } = this;
    const active = state.trials.find(t => t.status === "active");
    const route = state.routes[`${state.selected}:${state.band}`];
    const c = route?.challenges.find(c => c.kind === route.selectedKind && !c.completedAt);
    const scenarios = active ? active.steps.slice(active.results.length, active.mode === 'checkpoint' || active.mode === 'prepared' ? active.results.length + 1 : undefined).map(s => s.scenario)
      : c ? c.steps!.filter(s => (c.progress[s.scenario] ?? 0) < s.required).map(s => s.scenario) : [];
    if (!scenarios.length) throw new Error("Accept a route challenge or start a trial first.");
    const playlist = buildMatchPlaylist({ scenarios });
    playlist.playlistName = "Apogee Expedition First Light";
    playlist.description = active ? active.mode === 'checkpoint' ? "Expedition checkpoints. Meet each target in order. Retry a missed target; return to Apogee for the next step."
      : active.mode === 'prepared' ? "Expedition trial with one retry. Return to Apogee after a miss for the remaining playlist."
      : "Expedition trial. Play each scenario once, in order. A miss ends the attempt."
      : "Expedition route. Return to Apogee to see remaining targets; ordinary training also counts.";
    if (!active) playlist.scenarioList.forEach(s => {
      const step = c!.steps!.find(step => step.scenario === s.scenario_name)!;
      s.play_Count = Math.max(1, step.required - (c!.progress[s.scenario_name] ?? 0));
    });
    const folder = playlistsFolderFor(dir); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, playlist.playlistName + ".json"), serializePlaylist(playlist), "utf8");
    return { scenario: scenarios[0], note: `Opening ${scenarios[0]}. Use Play next for each step. Restart KovaaK's if the expedition playlist is missing from its menu.` };
  }
}
