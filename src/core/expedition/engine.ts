import type { Challenge, ChallengeKind, ChallengeOffer, ExpeditionDefinition, ExpeditionRun, ExpeditionState, Trial } from "./types.ts";

export const routeKey = (destination: string, band: number): string => `${destination}:${band}`;
const ordered = (runs: ExpeditionRun[]) => [...new Map(runs.map(r => [r.id, r])).values()]
  .filter(r => Number.isFinite(r.score) && Number.isFinite(r.at))
  .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
const median = (scores: number[]) => {
  const sorted = [...scores].sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const roundUp = (n: number, precision: number) => Math.max(1, Math.ceil((n - 1e-9) * 10 ** precision)) / 10 ** precision;
const meets = (score: number, target: number) => score + Number.EPSILON * Math.max(1, Math.abs(target)) * 8 >= target;
export function enroll(def: ExpeditionDefinition, now: number): ExpeditionState {
  return { version: def.version, definitionId: def.id, enrolledAt: now, band: 0, selected: def.destinations[0].id,
    routes: {}, runs: [], trials: [], rewards: {}, equipped: {} };
}
export function destinationFor(def: ExpeditionDefinition, id: string, band: number) {
  if (!Number.isInteger(band) || !def.bands[band]) throw new Error("Choose a valid difficulty band.");
  const d = def.destinations.find(d => d.id === id);
  if (!d) throw new Error("Choose an expedition destination.");
  return d;
}
export const challengeReward = (id: string, kind: ChallengeKind): string => `${id}:relic:${({ discovery: 0, steady: 1, score_attack: 2, circuit: 3 })[kind]}`;
export function challengeOffers(def: ExpeditionDefinition, id: string, band: number, history: ExpeditionRun[], now = Date.now()): ChallengeOffer[] {
  const d = destinationFor(def, id, band), pool = d.pool![band];
  const past = ordered(history).filter(r => r.at < now);
  const scores = (name: string) => past.filter(r => r.scenario === name).slice(-10);
  // Prefer a familiar scenario outside Discovery. With no history, offer a published
  // target on a different family; exploring never incurs a calibration chore.
  const candidates = pool.filter(s => !d.discovery![band].some(row => row.family === s.family));
  const known = candidates.filter(s => scores(s.name).length >= 5)
    .sort((a, b) => scores(b.name).at(-1)!.at - scores(a.name).at(-1)!.at || a.name.localeCompare(b.name));
  const fresh = pool.filter(s => ![...d.discovery![band], ...d.circuits![band], ...d.bands[band]].some(row => row.family === s.family));
  const subject = known[0] ?? fresh[0] ?? candidates.at(-1)!;
  const prior = scores(subject.name), personal = prior.length >= 5;
  const one = (kind: "steady" | "score_attack") => ({ scenario: subject.name, focus: subject.focus,
    required: kind === "steady" ? 3 : 1,
    target: personal ? roundUp(median(prior.map(r => r.score)) * (kind === "steady" ? .95 : 1.03), subject.precision)
      : kind === "steady" ? subject.routeTarget! : subject.target,
    source: personal ? "personal" as const : "published" as const });
  const offers: ChallengeOffer[] = [
    { kind: "discovery", name: "Discovery", purpose: "Try three different scenario families. One complete run on each reveals your route choices.", reward: challengeReward(id, "discovery"),
      steps: d.discovery![band].map(s => ({ scenario: s.name, focus: s.focus, required: 1, target: null, source: "discovery" })) },
    { kind: "score_attack", name: "Score attack", purpose: "Make one strong run count. Beat one target to earn the Core relic and open the finale.", reward: challengeReward(id, "score_attack"), steps: [one("score_attack")] },
    { kind: "steady", name: "Steady set", purpose: "Hold your standard for three consecutive runs on one scenario. Earn the Signal prism and open the finale.", reward: challengeReward(id, "steady"), steps: [one("steady")] },
    { kind: "circuit", name: "Mixed circuit", purpose: "Meet a target on each of three more scenario families. Earn the Circuit seal and open the finale.", reward: challengeReward(id, "circuit"),
      steps: d.circuits![band].map(s => ({ scenario: s.name, focus: s.focus, required: 1, target: s.routeTarget!, source: "published" })) },
  ];
  if (def.version >= 3) for (const offer of offers) {
    if (offer.kind === "discovery") offer.purpose = "Optional exploration: try three families and collect the Survey fragment. No score targets.";
    else {
      const task = { score_attack: "Beat one target.", steady: "Meet one target three times in a row. A miss resets this streak.", circuit: "Meet one target on each of three families. Each success stays earned." }[offer.kind];
      offer.purpose = `${task} ${band === 1 ? "Complete any one route to open the finale." : band === 2 ? "Complete any one route to unlock one retry on every attempt here." : "An optional relic for your collection; your trial is already open."}`;
    }
  }
  return offers;
}
export function acceptChallenge(state: ExpeditionState, def: ExpeditionDefinition, id: string, band: number,
  history: ExpeditionRun[], now: number, requested?: ChallengeKind): ExpeditionState {
  destinationFor(def, id, band);
  const next = structuredClone(state), key = routeKey(id, band), route = next.routes[key] ??= { challenges: [] };
  const discovery = route.challenges.find(c => c.kind === "discovery");
  const kind = requested ?? (!discovery ? "discovery" : undefined);
  if (!kind) throw new Error("Choose Score attack, Steady set, or Mixed circuit. Only one is needed for the finale.");
  if (def.version < 3 && kind !== "discovery" && !discovery?.completedAt) throw new Error("Finish Discovery to reveal your route choices.");
  const offer = challengeOffers(def, id, band, history, now).find(o => o.kind === kind);
  if (!offer) throw new Error("Choose a valid expedition route.");
  // Returning to a route resumes its original contract, never rerolls its target.
  if (!route.challenges.some(c => c.kind === kind)) {
    const challenge: Challenge = { kind, acceptedAt: now, steps: offer.steps, targets: {}, calibration: {}, progress: {}, evidence: [], completedAt: null };
    for (const s of offer.steps) if (s.target !== null) challenge.targets[s.scenario] = s.target;
    route.challenges.push(challenge);
  }
  route.selectedKind = kind; next.selected = id; next.band = band;
  return next;
}
export function trialSteps(def: ExpeditionDefinition, id: string, band: number) {
  if (!Number.isInteger(band) || !def.bands[band]) throw new Error("Choose a valid difficulty band.");
  return id === "final" ? def.destinations.map(d => ({ scenario: d.bands[band][0].name, target: d.bands[band][0].finalTarget }))
    : destinationFor(def, id, band).bands[band].map(s => ({ scenario: s.name, target: s.target }));
}
export function canStartTrial(state: ExpeditionState, def: ExpeditionDefinition, id: string, band: number): boolean {
  if (def.version >= 3 && id !== "final") {
    destinationFor(def, id, band);
    return band !== 1 || !!state.rewards[`${id}:${band}:clear`] || preparationReady(state, def, id, band);
  }
  return id === "final" ? def.destinations.every(d => !!state.rewards[`${d.id}:${band}:clear`])
    : !!state.routes[routeKey(id, band)]?.challenges.some(c => c.kind === "discovery" && c.completedAt) &&
      !!state.routes[routeKey(id, band)]?.challenges.some(c => c.kind !== "discovery" && c.completedAt);
}
export function preparationReady(state: ExpeditionState, def: ExpeditionDefinition, id: string, band: number): boolean {
  return id === "final" ? def.destinations.every(d => preparationReady(state, def, d.id, band))
    : !!state.routes[routeKey(id, band)]?.challenges.some(c => c.kind !== "discovery" && c.completedAt);
}
export function savedCheckpoints(state: ExpeditionState, id: string, band: number): ExpeditionRun[] {
  if (state.rewards[`${id}:${band}:clear`]) return [];
  const attempts = state.trials.filter(t => t.destination === id && t.band === band && t.mode === "checkpoint");
  return [...(attempts.sort((a, b) => b.results.length - a.results.length)[0]?.results ?? [])];
}
export function startTrial(state: ExpeditionState, def: ExpeditionDefinition, id: string, band: number, now: number, approach?: "direct" | "prepared"): ExpeditionState {
  const steps = trialSteps(def, id, band);
  if (state.trials.some(t => t.status === "active")) throw new Error("Finish or abandon your active trial first.");
  if (!canStartTrial(state, def, id, band)) throw new Error("Complete this route before starting its finale.");
  const next = structuredClone(state);
  const mode = def.version < 3 ? undefined : band === 0 && !state.rewards[`${id}:${band}:clear`] ? "checkpoint" : band === 2 && approach === "prepared" ? "prepared" : "strict";
  if (approach === "prepared" && (band !== 2 || !preparationReady(state, def, id, band))) throw new Error("Complete a preparation route first. The final passage needs preparation at all six destinations.");
  const carried = mode === "checkpoint" ? savedCheckpoints(state, id, band) : [];
  next.trials.push({ id: `${now}-${next.trials.length}`, destination: id, band, startedAt: now, endedAt: null, status: "active", steps, results: [...carried],
    ...(mode ? { mode, misses: [], carried } : {}) });
  next.selected = id; next.band = band;
  return next;
}
export function abandonTrial(state: ExpeditionState, now: number): ExpeditionState {
  const next = structuredClone(state), trial = next.trials.find(t => t.status === "active");
  if (!trial) throw new Error("There is no active trial.");
  trial.status = "abandoned"; trial.endedAt = now;
  return next;
}
export function syncExpedition(state: ExpeditionState, def: ExpeditionDefinition, incoming: ExpeditionRun[], now: number): ExpeditionState {
  const next = structuredClone(state);
  next.runs = ordered([...state.runs, ...incoming.filter(r => r.at > state.enrolledAt && r.at <= now)]);
  const award = (id: string, at: number) => { next.rewards[id] ??= at; };
  for (const d of def.destinations) for (let band = 0; band < def.bands.length; band++) {
    const route = next.routes[routeKey(d.id, band)];
    if (!route) continue;
    for (const c of route.challenges) {
      if (c.completedAt) continue;
      let done = true; const evidence: ExpeditionRun[] = [];
      for (const s of c.steps!) {
        const runs = next.runs.filter(r => r.scenario === s.scenario && r.at > c.acceptedAt);
        let count = 0; const selected: ExpeditionRun[] = [];
        const required = s.required;
        for (const r of runs) {
          if (s.target === null || meets(r.score, s.target)) { count++; selected.push(r); }
          else if (c.kind === "steady") { count = 0; selected.length = 0; }
          if (count >= required) break;
        }
        c.progress[s.scenario] = Math.min(required, count);
        if (count < required) done = false;
        evidence.push(...selected);
      }
      c.evidence = evidence.map(r => r.id);
      if (done) { c.completedAt = Math.max(...evidence.map(r => r.at)); award(challengeReward(d.id, c.kind as ChallengeKind), c.completedAt); }
    }
  }
  for (const t of next.trials) {
    if (t.status !== "active") continue;
    t.results = [...(t.carried ?? [])];
    if (t.mode) t.misses = [];
    const subjects = new Set(t.steps.map(s => s.scenario));
    for (const r of next.runs.filter(r => r.at > t.startedAt && subjects.has(r.scenario))) {
      const step = t.steps[t.results.length];
      const passed = r.scenario === step.scenario && meets(r.score, step.target);
      if (t.mode && !passed) {
        // Checkpoint journeys allow practice in any order; only the next target banks.
        if (t.mode === "checkpoint" && r.scenario !== step.scenario) continue;
        t.misses!.push(r);
        if (t.mode === "checkpoint" || t.mode === "prepared" && t.misses!.length === 1) continue;
        t.status = "failed"; t.endedAt = r.at; break;
      }
      t.results.push(r);
      if (!passed) { t.status = "failed"; t.endedAt = r.at; break; }
      if (t.results.length === t.steps.length) {
        t.status = "cleared"; t.endedAt = r.at;
        award(`${t.destination}:${t.band}:clear`, r.at);
        for (const kind of ["ship", "frame", "banner", "title"]) award(`${t.destination}:${kind}`, r.at);
        const clean = !t.misses?.length && !t.carried?.length;
        if (clean && t.results.every((r, i) => meets(r.score, t.steps[i].target * 1.1))) award(`${t.destination}:${t.band}:mastery`, r.at);
        if (t.mode === "strict" && t.band === 2) award(`${t.destination}:2:direct`, r.at);
        break;
      }
    }
  }
  for (const n of [25, 100, 250, 500]) if (next.runs.length >= n) award(`runs:${n}`, next.runs[n - 1].at);
  const distinct = new Set<string>();
  for (const r of next.runs) {
    if (distinct.has(r.scenario)) continue;
    distinct.add(r.scenario);
    if ([10, 25, 50].includes(distinct.size)) award(`variety:${distinct.size}`, r.at);
  }
  return next;
}
export function trialRecord(trials: Trial[], destination: string, band: number): number | null {
  const clears = trials.filter(t => t.destination === destination && t.band === band && t.status === "cleared");
  return clears.length ? Math.max(...clears.map(t => Math.min(...t.results.map((r, i) => r.score / t.steps[i].target)))) : null;
}
