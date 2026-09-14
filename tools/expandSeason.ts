/** Freeze evidence for the season expansion, then apply its reviewed manifest locally.
 * npx tsx tools/expandSeason.ts --sample | --apply
 * Existing caches and original scenario choices are preserved. No backend writes.
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
const canonical = (v: any): any => v && typeof v === "object"
  ? Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = (v: any) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const spec = read("season_expansion.json");
const pool = read("pool.json");
const taxonomy = read("scenario_taxonomy.json");
const distributions = read("leaderboard_percentiles.json");
const apex = read("leaderboard_apex.json");
const tax = new Map<string, any>(taxonomy.scenarios.map((s: any) => [s.name, s]));
const dist = new Map<string, any>(distributions.distributions.map((s: any) => [s.scenario, s]));
const boards = new Map<string, any>(apex.boards.map((s: any) => [s.scenario, s]));
const names: string[] = spec.families.flatMap((f: any) => f.rungs);
assert.equal(new Set(names).size, 96, "Exactly 96 distinct additions");
for (const category of pool.categories) assert.equal(spec.families.filter((f: any) => f.category === category).length, 4);
for (const name of names) assert(tax.get(name)?.leaderboardId, `${name}: missing catalogue identity`);
const pause = () => new Promise(resolve => setTimeout(resolve, 400));
function applyArmTags(families: any[]): void {
  const published = new Map<string, string>(read("subskills.json").scenarios
    .filter((s: any) => s.mechanic).map((s: any) => [s.scenario, s.mechanic]));
  // These fallback tile cues are season judgements, not measured biomechanics.
  // Sensitivity and technique affect the actual division of movement.
  const cues: Record<string, string> = {
    "Micro Chain": "Fingertip", "Sky Gallery": "Fingertip", "Reload Rush": "Wrist",
    "Floating Gallery": "Wrist", "Wave Click": "Wrist", "Snake Sweep": "Arm",
    "Sphere Cruise": "Arm", "Close Strafe Chase": "Arm", "Dev Blitz": "Wrist",
    "Chamber Relay": "Wrist", "Smooth Relay": "Arm",
  };
  for (const f of families) for (const v of f.variants) {
    v.arm = published.get(v.scenario) ?? cues[f.family] ?? "Blending";
    v.armFrom = published.has(v.scenario) ? "Viscose" : "Apogee";
  }
}
async function get(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) { const result = await response.json(); await pause(); return result; }
    if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}: ${url}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(45_000, 5000 * 2 ** attempt)));
  }
  throw new Error(`Could not sample ${url}`);
}

if (process.argv.includes("--sample")) {
  const refresh = process.argv.filter((_, i, args) => args[i - 1] === "--refresh");
  for (const name of refresh) assert(names.includes(name), `Not an expansion scenario: ${name}`);
  const selected = refresh.length ? refresh : names;
  for (const [index, name] of selected.entries()) {
    const t = tax.get(name)!;
    if (!t.expansionVerifiedAt) {
      const result = await get(`https://kovaaks.com/webapp-backend/scenario/popular?page=0&max=20&scenarioNameSearch=${encodeURIComponent(name)}`);
      const row = result.data?.find((s: any) => s.scenarioName === name);
      assert.equal(row?.leaderboardId, t.leaderboardId, `${name}: exact live identity mismatch`);
      t.description = row.scenario?.description ?? t.description;
      t.expansionVerifiedAt = new Date().toISOString();
      write("scenario_taxonomy.json", taxonomy);
    }
    if (!dist.has(name) || refresh.includes(name)) {
      const sampled = await sampleDistribution(name, t.leaderboardId);
      assert(sampled, `${name}: missing distribution`);
      dist.set(name, sampled);
      distributions.distributions = [...distributions.distributions.filter((d: any) => d.scenario !== name), sampled];
      write("leaderboard_percentiles.json", distributions);
    }
    if (!boards.has(name)) {
      const url = `https://kovaaks.com/webapp-backend/leaderboard/scores/global?leaderboardId=${t.leaderboardId}`;
      const first = await get(`${url}&page=0&max=100`);
      assert(first.data?.length && first.total, `${name}: empty board`);
      const points = [];
      for (const rank of APEX_RANKS.filter(r => r <= first.total)) {
        const score = rank <= first.data.length ? first.data[rank - 1].score
          : (await get(`${url}&page=${rank - 1}&max=1`)).data?.[0]?.score;
        assert(Number.isFinite(Number(score)), `${name}: missing rank ${rank}`);
        points.push({ rank, score: Number(score) });
      }
      for (let i = 1; i < points.length; i++) points[i].score = Math.min(points[i].score, points[i - 1].score);
      const sampled = { scenario: name, leaderboardId: t.leaderboardId, total: first.total, points, sampledAt: new Date().toISOString() };
      boards.set(name, sampled);
      apex.boards.push(sampled);
      write("leaderboard_apex.json", apex);
    }
    console.log(`${index + 1}/${selected.length} verified and sampled: ${name}`);
  }
} else if (process.argv.includes("--metadata")) {
  const additions = pool.families.filter((f: any) => spec.families.some((s: any) => s.family === f.family));
  assert.equal(additions.length, 24, "Apply the expansion before refreshing its tile metadata");
  applyArmTags(additions);
  write("pool.json", pool);
  console.log("Updated arm tile cues for the 96 additions, preserving published attribution.");
} else if (process.argv.includes("--apply")) {
  assert(!existsSync(dataFile("season_expansion_calibration.json")), "Expansion already applied; edit the frozen data deliberately instead of applying twice");
  assert(!pool.families.some((f: any) => spec.families.some((s: any) => s.family === f.family)), "Addition collides with an existing family");
  assert(!pool.families.some((f: any) => f.variants.some((v: any) => names.includes(v.scenario))), "Addition duplicates an existing scenario");
  for (const name of names) assert(tax.get(name).expansionVerifiedAt && dist.has(name) && boards.has(name), `${name}: run --sample first`);
  const baseline = structuredClone(pool.families);
  const curation = read("pool_curation.json");
  const rationale = read("scenario_rationale.json");
  const subskills = new Map<string, any>(read("subskills.json").scenarios.map((s: any) => [s.scenario, s]));
  const ranksFor = (window: number) => windowRankIndices(window, pool.windowSize, pool.windowSize * pool.windows.length, spec.overlap);
  pool.ladder.overlap = spec.overlap;
  const ceilingAdjustments: any[] = [];
  const additions = spec.families.map((f: any) => ({
    family: f.family, category: f.category, subCategory: f.category, focus: f.focus, $why: f.why,
    $order: { why: f.why + " Difficulty order is a curation judgement; board populations cannot prove equivalence between edits." },
    variants: f.rungs.map((name: string, window: number) => {
      const d = dist.get(name);
      const ranks = ranksFor(window);
      const topFractions = ranks.map((r: number) => pool.ladder.ranks[r]);
      const rankMaxes = thresholdsFrom(d, topFractions)!;
      const record = Math.floor(boards.get(name).points[0].score);
      const source: any = { kind: "percentile", cut: { ranks, topFractions, leaderboardId: d.leaderboardId, total: d.total, sampledAt: d.sampledAt },
        why: "Frozen from this scenario's own board for the season variety expansion. This is a season target, not a copied benchmark tier." };
      if (rankMaxes.at(-1)! > record) {
        const before = { rankMaxes: [...rankMaxes], source: structuredClone(source) };
        rankMaxes[rankMaxes.length - 1] = record;
        for (let i = rankMaxes.length - 2; i >= 0; i--) rankMaxes[i] = Math.min(rankMaxes[i], rankMaxes[i + 1] - 1);
        assert(rankMaxes[0] > 0, `${name}: no usable rank ladder below record`);
        ceilingAdjustments.push({ scenario: name, before, record, recordSampledAt: boards.get(name).sampledAt, rankMaxes });
        source.kind = "authored";
        source.why = "Frozen percentile targets capped backward from the floored demonstrated record, preserving at least one point between ranks. This sparse board has tied top percentiles; exact original cuts and the repair are recorded in data/season_expansion_calibration.json.";
        delete source.cut;
      }
      return { window, scenario: name, label: name, leaderboardId: tax.get(name).leaderboardId,
        admitted: { why: f.why }, rankMaxes,
        ...(d.total < 10000 ? { thinBoard: { why: `Retained for this variety circuit with ${d.total} sampled leaderboard entries. These frozen draft targets are based on a small population, especially at Expert; difficulty equivalence requires playtesting. ${f.why}` } } : {}),
        source };
    }),
  }));
  applyArmTags(additions);
  pool.families = pool.categories.flatMap((category: string) => [
    ...pool.families.filter((f: any) => f.category === category), ...additions.filter((f: any) => f.category === category),
  ]);
  for (const f of spec.families) {
    if (!curation.categories[f.category]) {
      const guide = pool.categoryGuides[f.category];
      curation.categories[f.category] = { title: guide.headline, description: guide.description,
        families: baseline.filter((b: any) => b.category === f.category).map((b: any) => ({
          family: b.family, focus: b.focus, why: b.$why ?? "Original authored static circuit.", rungs: b.variants.map((v: any) => v.scenario),
        })) };
    }
    curation.categories[f.category].families.push(f);
    const audience = f.rungs.map((n: string) => tax.get(n)).sort((a: any, b: any) => b.entries - a.entries)[0];
    rationale.families.push({ family: f.family, subCategory: f.category, isolates: f.focus, why: f.why,
      evidence: f.rungs.map((name: string) => ({ source: "expansion-catalogue", scenario: name,
        says: `Exact scenario and leaderboard identity verified on ${tax.get(name).expansionVerifiedAt}. Author description: ${tax.get(name).description}` })),
      audience: { scenario: audience.name, plays: audience.plays, entries: audience.entries },
      thin: "Selection is based on catalogue mechanics and published variants. No measured enjoyment or cross-band difficulty equivalence is claimed." });
    for (const name of f.rungs) {
      if (subskills.get(name)?.subSkill !== f.category) pool.subCategoryOverrides[name] = {
        subCategory: f.category, why: f.why + " This season classifies the complete circuit by its dominant firing and movement task." };
    }
  }
  rationale.sources["expansion-catalogue"] = { title: "KovaaK's scenario catalogue: season expansion identity checks",
    url: "https://kovaaks.com/kovaaks/scenarios", kind: "first-party" };
  curation.$comment = "Six category circuits: the original core followed by four variety families per band. Exact scenario identities and score targets are frozen in pool.json; enjoyment and mixed-author handovers require playtesting.";
  const adjustments: any[] = [];
  for (const f of pool.families) for (const v of f.variants) {
    if (v.window === pool.windows.length - 1) continue;
    const before = { rankMaxes: [...v.rankMaxes], source: structuredClone(v.source) };
    const d = dist.get(v.scenario);
    const board = boards.get(v.scenario);
    assert(d && board?.points.length, `${v.scenario}: missing overlap evidence`);
    const ranks = ranksFor(v.window);
    const fractions = ranks.slice(-2).map((r: number, i: number) => pool.ladder.ranks[r] * spec.overlapTopFractionFactors[i]);
    const cut = thresholdsFrom(d, fractions)!;
    const cap = Math.floor(board.points[0].score);
    const repairUnreachable = before.rankMaxes[5] >= cap;
    const first = Math.min(cap - 1, Math.max(before.rankMaxes[4] + 1, cut[0]));
    const second = Math.min(cap, Math.max(before.rankMaxes[5] + 1, cut[1], first + 1));
    assert(first > before.rankMaxes[3] && second > first, `${v.scenario}: no room for two reachable crossover ranks`);
    assert(repairUnreachable || (first > before.rankMaxes[4] && second > before.rankMaxes[5]), `${v.scenario}: crossover did not get harder`);
    v.rankMaxes = [...before.rankMaxes.slice(0, 4), first, second];
    v.source = { kind: "authored", why: "First four frozen targets preserved; two crossover ranks require stricter performance on this easier scenario. Each is the greater of its prior target plus one point and its frozen stricter percentile cut, capped at record minus one and record. Previously unreachable tails are explicitly recorded as repairs. Reproducible before/after evidence and board dates: data/season_expansion_calibration.json." };
    adjustments.push({ scenario: v.scenario, category: f.category, family: f.family, window: v.window,
      before, topFractions: fractions, sampledAt: d.sampledAt, total: d.total,
      record: cap, recordSampledAt: board.sampledAt, repairUnreachable, rankMaxes: v.rankMaxes });
  }
  const calibration = { version: 1, appliedAt: new Date().toISOString(), rule: spec.overlapRule,
    originalFamilies: baseline.map((f: any) => ({ family: f.family, category: f.category, sha256: hash(f) })),
    adjustments, ceilingAdjustments };
  write("season_expansion_calibration.json", calibration);
  write("pool.json", pool);
  write("pool_curation.json", curation);
  write("scenario_rationale.json", rationale);
  console.log(`Added ${additions.length} families / ${names.length} scenarios; tightened ${adjustments.length} two-rank overlap tails. Run build:season and the validators.`);
} else throw new Error("Choose --sample, --apply, or --metadata");
