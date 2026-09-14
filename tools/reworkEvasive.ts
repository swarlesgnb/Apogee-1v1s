/** Verify and sample new selections, then apply the evasive circuit locally.
 * npx tsx tools/reworkEvasive.ts --sample | --apply
 * Existing evidence is immutable; the before-state remains available to historical audits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import { sampleDistribution } from "../src/core/season/sampleLeaderboard.ts";
import { thresholdsFrom } from "../src/core/season/percentiles.ts";
import { windowRankIndices } from "../src/core/season/windows.ts";
import { APEX_RANKS } from "../src/core/season/apex.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const write = (name: string, value: unknown) => writeFileSync(dataFile(name), JSON.stringify(value, null, 2) + "\n");
const spec = read("evasive_rework.json");
const pool = read("pool.json");
const taxonomy = read("scenario_taxonomy.json");
const distributions = read("leaderboard_percentiles.json");
const apex = read("leaderboard_apex.json");
const tax = new Map<string, any>(taxonomy.scenarios.map((s: any) => [s.name, s]));
const dist = new Map<string, any>(distributions.distributions.map((s: any) => [s.scenario, s]));
const boards = new Map<string, any>(apex.boards.map((s: any) => [s.scenario, s]));
const names: string[] = spec.families.filter((f: any) => f.changed).flatMap((f: any) => f.rungs);
assert.equal(new Set(names).size, names.length);
const evidenceFile = "evasive_rework_evidence.json";
const evidence = existsSync(dataFile(evidenceFile)) ? read(evidenceFile) : { identities: {} };
async function get(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const body = await response.json();
      await new Promise(resolve => setTimeout(resolve, 400));
      return body;
    }
    assert(response.status === 429 || response.status >= 500, `HTTP ${response.status}: ${url}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 5000 * 2 ** attempt)));
  }
  throw new Error(`Could not read ${url}`);
}

if (process.argv.includes("--sample")) {
  for (const [index, name] of names.entries()) {
    if (!evidence.identities[name]) {
      const url = `https://kovaaks.com/webapp-backend/scenario/popular?page=0&max=50&scenarioNameSearch=${encodeURIComponent(name)}`;
      const result = await get(url);
      const row = result.data?.find((s: any) => s.scenarioName === name);
      assert(row?.leaderboardId, `${name}: no exact live identity`);
      if (tax.has(name)) assert.equal(tax.get(name).leaderboardId, row.leaderboardId);
      const entry = { name, leaderboardId: row.leaderboardId, aimType: row.scenario.aimType,
        description: row.scenario.description, plays: row.counts.plays, entries: row.counts.entries,
        topScore: row.topScore.score, verifiedAt: new Date().toISOString(), url };
      evidence.identities[name] = entry;
      if (!tax.has(name)) { tax.set(name, entry); taxonomy.scenarios.push(entry); write("scenario_taxonomy.json", taxonomy); }
      write(evidenceFile, evidence);
    }
    const id = evidence.identities[name].leaderboardId;
    if (!dist.has(name)) {
      const sampled = await sampleDistribution(name, id);
      assert(sampled, `${name}: no complete distribution`);
      dist.set(name, sampled);
      distributions.distributions.push(sampled);
      write("leaderboard_percentiles.json", distributions);
    }
    if (!boards.has(name)) {
      const url = `https://kovaaks.com/webapp-backend/leaderboard/scores/global?leaderboardId=${id}`;
      const first = await get(`${url}&page=0&max=100`);
      assert(first.total && first.data?.length, `${name}: empty board`);
      const points = [];
      for (const rank of APEX_RANKS.filter(r => r <= first.total)) {
        const score = rank <= first.data.length ? first.data[rank - 1].score
          : (await get(`${url}&page=${rank - 1}&max=1`)).data?.[0]?.score;
        assert(Number.isFinite(Number(score)));
        points.push({ rank, score: Number(score) });
      }
      for (let i = 1; i < points.length; i++) points[i].score = Math.min(points[i].score, points[i - 1].score);
      const sampled = { scenario: name, leaderboardId: id, total: first.total, points, sampledAt: new Date().toISOString() };
      boards.set(name, sampled); apex.boards.push(sampled); write("leaderboard_apex.json", apex);
    }
    console.log(`${index + 1}/${names.length}: ${name}`);
  }
} else if (process.argv.includes("--apply")) {
  assert(!existsSync(dataFile("evasive_rework_calibration.json")), "Already applied; edit the frozen rework deliberately");
  for (const name of names) assert(evidence.identities[name] && dist.has(name) && boards.has(name), `${name}: sample first`);
  const beforeFamilies = structuredClone(pool.families.filter((f: any) => f.category === spec.category));
  const otherFamilies = pool.families.filter((f: any) => f.category !== spec.category);
  const beforeOtherFocus = Object.fromEntries(otherFamilies.filter((f: any) => f.focus).map((f: any) => [f.family, f.focus]));
  const otherFamiliesSha256 = createHash("sha256").update(JSON.stringify(otherFamilies.map(({ focus, ...f }: any) => f))).digest("hex");
  const priorSeason = read("seasons/season-1.json");
  const beforeScenarios = priorSeason.scenarios.filter((s: any) => s.category === spec.category);
  const beforeCategory = priorSeason.categories.find((c: any) => c.name === spec.category);
  const curation = read("pool_curation.json");
  const rationale = read("scenario_rationale.json");
  const identity = read("scenario_identity.json");
  const corrections = read("aim_type_corrections.json");
  const subskills = new Map<string, any>(read("subskills.json").scenarios.map((s: any) => [s.scenario, s]));
  const adjustments: any[] = [];
  const families = spec.families.map((f: any) => {
    if (!f.changed) {
      const { focus, ...existing } = beforeFamilies.find((old: any) => old.family === f.family);
      return existing;
    }
    const variants = f.rungs.map((name: string, window: number) => {
      const d = dist.get(name); const board = boards.get(name);
      const ranks = windowRankIndices(window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap);
      const topFractions = ranks.map((r: number, i: number) => pool.ladder.ranks[r]
        * (window < 3 && i >= 4 ? [0.5, 0.4][i - 4] : 1));
      const raw = thresholdsFrom(d, topFractions)!;
      const record = Math.floor(board.points[0].score);
      let rankMaxes = [...raw];
      // Tied sparse-board cuts must not produce targets above the demonstrated record.
      rankMaxes[rankMaxes.length - 1] = Math.min(record, rankMaxes.at(-1)!);
      for (let i = rankMaxes.length - 2; i >= 0; i--) rankMaxes[i] = Math.min(rankMaxes[i], rankMaxes[i + 1] - 1);
      const previous = beforeFamilies.flatMap((old: any) => old.variants)
        .find((v: any) => v.scenario === name && v.window === window);
      // A retained scenario in the same band keeps its established challenge.
      // Replacing the novice entry must not quietly cheapen the Expert score cap.
      if (previous) rankMaxes = [...previous.rankMaxes];
      assert(rankMaxes[0] > 0 && rankMaxes.every((x, i) => i === 0 || x > rankMaxes[i - 1]));
      adjustments.push({ scenario: name, window, family: f.family, mode: previous ? "preserved" : "recut", ranks, topFractions, raw,
        rankMaxes, record, sampledAt: d.sampledAt, recordSampledAt: board.sampledAt });
      return { window, scenario: name, label: name, leaderboardId: d.leaderboardId,
        admitted: { why: f.why }, rankMaxes,
        source: previous?.source ?? { kind: "authored", why: "Frozen from this scenario's own dated leaderboard. The first four ranks use the season curve; lower bands keep stricter two-rank crossover cuts (0.5 and 0.4 factors). Ties are capped backward from the demonstrated record. Reproduce using data/evasive_rework_calibration.json. Physical difficulty and equal effort between scenarios require playtesting." },
        ...(d.total < 8750 ? { thinBoard: { why: `Draft selection with ${d.total} sampled players. The named variant and movement task justify inclusion, not leaderboard population. Sparse high-rank cuts need human calibration; no difficulty equivalence is claimed.` } } : {}),
        arm: subskills.get(name)?.mechanic ?? "Blending", armFrom: subskills.get(name)?.mechanic ? "Viscose" : "Apogee" };
    });
    return { family: f.family, category: spec.category, subCategory: spec.category,
      why: f.why, $order: { why: f.why + " The ordering follows the named edit lineage; cross-band physical difficulty is provisional until playtested." }, variants };
  });
  pool.families = pool.families.filter((f: any) => f.category !== spec.category).concat(families);
  pool.categoryGuides[spec.category] = { description: spec.description };
  curation.categories[spec.category] = { description: spec.description,
    families: spec.families.map(({ changed, focus, ...f }: any) => f) };
  curation.$comment = "Six category circuits, including the revised evasive progression in data/evasive_rework.json. Catalogue evidence is not a substitute for human difficulty and enjoyment playtesting.";
  rationale.sources["evasive-rework-catalogue"] = { title: "KovaaK's exact scenario catalogue checks for the evasive rework",
    url: "https://kovaaks.com/kovaaks/scenarios", kind: "first-party" };
  rationale.families = rationale.families.filter((f: any) => f.subCategory !== spec.category || spec.families.some((s: any) => s.family === f.family));
  for (const f of spec.families.filter((f: any) => f.changed)) {
    rationale.families = rationale.families.filter((old: any) => old.family !== f.family);
    const audience = f.rungs.map((n: string) => tax.get(n)).sort((a: any, b: any) => b.entries - a.entries)[0];
    rationale.families.push({ family: f.family, subCategory: spec.category, isolates: f.focus, why: f.why,
      evidence: f.rungs.map((name: string) => ({ source: "evasive-rework-catalogue", scenario: name,
        says: `Exact identity checked ${evidence.identities[name].verifiedAt}. ${evidence.identities[name].description}` })),
      audience: { scenario: audience.name, plays: audience.plays, entries: audience.entries }, thin: spec.status });
    for (const name of f.rungs) {
      identity.scenarios[name] = { leaderboardId: tax.get(name).leaderboardId, aimType: "Switching", subCategory: spec.category };
      if (evidence.identities[name].aimType === "Clicking" && !corrections.corrections[name]) {
        corrections.corrections[name] = { aimType: "Switching", kovaaksSays: "Clicking",
          catalogue: { file: evidenceFile, scenario: name, ...(name === "domiSwitch Hard" ? { sibling: "domiSwitch" } : {}) },
          namedBy: [], why: "The exact catalogue identity describes a sustained-fire target-switching task. PasuTS and Floatswitch explicitly require 20 hits per clear; domiSwitch Hard describes the same 55-health regeneration task as the measured domiSwitch sibling. This is authored task evidence, not a claimed local shots-per-kill measurement." };
      }
      if (subskills.get(name)?.subSkill !== spec.category) pool.subCategoryOverrides[name] = { subCategory: spec.category,
        why: f.why + " The season groups this sustained-fire moving-target clear with evasive switching." };
    }
  }
  const liveNames = new Set(pool.families.flatMap((f: any) => f.variants.map((v: any) => v.scenario)));
  const citedSources = new Set(rationale.families.flatMap((f: any) => f.evidence.map((e: any) => e.source)));
  for (const source of Object.keys(rationale.sources)) if (!citedSources.has(source)) delete rationale.sources[source];
  for (const name of Object.keys(pool.subCategoryOverrides)) if (!liveNames.has(name)) delete pool.subCategoryOverrides[name];
  write("evasive_rework_calibration.json", { version: 1, appliedAt: new Date().toISOString(), otherFamiliesSha256, beforeOtherFocus, beforeFamilies, beforeCategory, beforeScenarios, adjustments });
  write("pool.json", pool); write("pool_curation.json", curation); write("scenario_rationale.json", rationale);
  write("scenario_identity.json", identity);
  write("aim_type_corrections.json", corrections);
  console.log(`Applied ${families.length} evasive families; ${adjustments.length} targets recorded. Run build:season and validators.`);
} else throw new Error("Choose --sample or --apply");
