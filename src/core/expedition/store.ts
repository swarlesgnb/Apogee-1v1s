import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExpeditionDefinition, ExpeditionState } from "./types.ts";

function object(v: unknown): v is Record<string, any> { return !!v && typeof v === "object" && !Array.isArray(v); }
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const run = (r: any) => object(r) && typeof r.id === "string" && typeof r.scenario === "string" && finite(r.score) && finite(r.at);
export function validState(v: unknown, def: ExpeditionDefinition): v is ExpeditionState {
  if (!object(v) || v.version !== def.version || v.definitionId !== def.id || !finite(v.enrolledAt) ||
      !Number.isInteger(v.band) || !def.bands[v.band] || !["final", ...def.destinations.map(d => d.id)].includes(v.selected) ||
      !object(v.routes) || !object(v.rewards) || !object(v.equipped) || !Array.isArray(v.runs) || !v.runs.every(run) || !Array.isArray(v.trials)) return false;
  if (!Object.values(v.rewards).every(finite) || !Object.values(v.equipped).every(id => typeof id === "string")) return false;
  const keys = new Set(def.destinations.flatMap(d => def.bands.map((_, b) => `${d.id}:${b}`)));
  for (const [key, r] of Object.entries(v.routes)) {
    if (!keys.has(key) || !object(r) || !Array.isArray(r.challenges) || r.challenges.length > (def.version === 1 ? 3 : 4)) return false;
    if (new Set(r.challenges.map((c: any) => c?.kind)).size !== r.challenges.length) return false;
    for (const [i, c] of r.challenges.entries()) {
      if (!object(c) || !finite(c.acceptedAt) || !(c.completedAt === null || finite(c.completedAt)) ||
        ![c.targets, c.progress, c.calibration].every(m => object(m) && Object.values(m).every(finite)) ||
        !Array.isArray(c.evidence) || !c.evidence.every((id: unknown) => typeof id === "string")) return false;
      if (def.version === 1) { if (c.kind !== ["explore", "consistency", "breakthrough"][i]) return false; }
      else {
        if (!['discovery', 'steady', 'score_attack', 'circuit'].includes(c.kind) || (def.version === 2 && i === 0 && c.kind !== 'discovery')) return false;
        const [id, b] = key.split(':');
        const names = new Set(def.destinations.find(d => d.id === id)!.pool![Number(b)].map(s => s.name));
        if (!Array.isArray(c.steps) || c.steps.length !== (['discovery', 'circuit'].includes(c.kind) ? 3 : 1) ||
          new Set(c.steps.map((s: any) => s?.scenario)).size !== c.steps.length || !c.steps.every((s: any) => object(s) && names.has(s.scenario) &&
          typeof s.focus === 'string' && s.required === (c.kind === 'steady' ? 3 : 1) &&
          (c.kind === 'discovery' ? s.target === null : finite(s.target) && s.target > 0) &&
          ['discovery', 'personal', 'published', 'preserved'].includes(s.source))) return false;
      }
    }
    if (def.version >= 2 && r.selectedKind !== undefined && !r.challenges.some((c: any) => c.kind === r.selectedKind)) return false;
  }
  return v.trials.filter((t: any) => object(t) && t.status === "active").length <= 1 && v.trials.every((t: any) =>
    object(t) && typeof t.id === "string" && ["final", ...def.destinations.map(d => d.id)].includes(t.destination) &&
    Number.isInteger(t.band) && !!def.bands[t.band] && finite(t.startedAt) && (t.endedAt === null || finite(t.endedAt)) &&
    ["active", "failed", "cleared", "abandoned"].includes(t.status) && Array.isArray(t.steps) && [3, 6].includes(t.steps.length) &&
    t.steps.every((s: any) => object(s) && typeof s.scenario === "string" && finite(s.target) && s.target > 0) &&
    Array.isArray(t.results) && t.results.every(run) && t.results.length <= t.steps.length &&
    (t.mode === undefined || def.version === 3 && ['checkpoint', 'prepared', 'strict'].includes(t.mode) &&
      (t.mode !== 'checkpoint' || t.band === 0) && (t.mode !== 'prepared' || t.band === 2) &&
      Array.isArray(t.misses) && t.misses.every(run) && Array.isArray(t.carried) && t.carried.every(run) &&
      (t.mode === 'checkpoint' || t.carried.length === 0) && t.carried.length <= t.results.length &&
      t.carried.every((r: any, i: number) => r.id === t.results[i].id && r.scenario === t.steps[i].scenario && r.score >= t.steps[i].target)));
}

/** Never replace an unreadable save with an empty campaign. */
export class ExpeditionStore {
  constructor(readonly path: string, readonly definition: ExpeditionDefinition) {}
  load(): { state: ExpeditionState | null; warning: string | null } {
    if (!existsSync(this.path) && !existsSync(this.path + ".bak")) return { state: null, warning: null };
    for (const path of [this.path, this.path + ".bak"]) {
      try {
        const state = JSON.parse(readFileSync(path, "utf8"));
        if (validState(state, this.definition)) return { state, warning: path === this.path ? null : "Your previous expedition save was recovered. The unreadable save is preserved." };
      } catch { /* Attempt the previous atomic save next. */ }
    }
    throw new Error("The expedition save and its backup could not be read. Your files have been preserved; restore a valid backup before continuing.");
  }
  save(state: ExpeditionState): void {
    if (!validState(state, this.definition)) throw new Error("The expedition state failed validation; your previous save is unchanged.");
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      const original = readFileSync(this.path, "utf8");
      let valid = false;
      try { valid = validState(JSON.parse(original), this.definition); } catch { /* Preserve below. */ }
      if (valid) {
        writeFileSync(this.path + ".bak.tmp", original, "utf8");
        renameSync(this.path + ".bak.tmp", this.path + ".bak");
      } else {
        writeFileSync(this.path + `.unreadable-${Date.now()}`, original, "utf8");
      }
    }
    writeFileSync(this.path + ".tmp", JSON.stringify(state), "utf8");
    renameSync(this.path + ".tmp", this.path);
  }
}
