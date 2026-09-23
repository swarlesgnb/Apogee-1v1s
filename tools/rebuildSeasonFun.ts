/** Verify and sample the fun rebuild's selections, then apply it to the pool locally.
 *
 *   npx tsx tools/rebuildSeasonFun.ts --sample     identities, distributions, record boards
 *   npx tsx tools/rebuildSeasonFun.ts --apply      write pool, curation, rationale; regenerate identity and seed
 *
 * data/season_fun_rebuild.json says what changes and why; data/fun_audit.json (from
 * tools/funAudit.ts) holds the numbers each choice is argued from. This tool changes
 * nothing it was not told to: families the spec does not name keep their scenarios AND
 * their thresholds, which for most of them are hand-authored and are not ours to re-cut.
 *
 * THE THRESHOLDS OF A NEW RUNG
 *
 * Cut from the rung's own dated leaderboard exactly as the evasive rework cut its new
 * rungs, so the whole pool rests on one method: the season curve for the ranks a window
 * grades, the two crossover ranks of every window below Expert cut stricter (0.5 and 0.4
 * of their fractions) because the harder window above also awards them, and a tail that
 * a sparse board would put above the demonstrated record capped backward from it.
 *
 * WHAT IS KEPT FOR THE AUDITS
 *
 * Every replaced family, rung and season row is frozen into
 * data/season_fun_rebuild_calibration.json with its position, and funRebuildHistory.ts
 * puts them back, so the validators of the expansion, the theory migration and the
 * evasive rework keep auditing the pool they were written for instead of being rewritten
 * to pass. No backend writes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import { sampleDistribution } from "../src/core/season/sampleLeaderboard.ts";
import { thresholdsFrom } from "../src/core/season/percentiles.ts";
import { windowRankCount, windowRankIndices } from "../src/core/season/windows.ts";
import { apexRanksFor } from "../src/core/season/apex.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const write = (name: string, value: unknown) => writeFileSync(dataFile(name), JSON.stringify(value, null, 2) + "\n");
const spec = read("season_fun_rebuild.json");
const pool = read("pool.json");
const taxonomy = read("scenario_taxonomy.json");
const distributions = read("leaderboard_percentiles.json");
const apex = read("leaderboard_apex.json");
const tax = new Map<string, any>(taxonomy.scenarios.map((s: any) => [s.name, s]));
const dist = new Map<string, any>(distributions.distributions.map((s: any) => [s.scenario, s]));
const boards = new Map<string, any>(apex.boards.map((s: any) => [s.scenario, s]));
const names: string[] = [...spec.families.flatMap((f: any) => f.rungs), ...spec.rungs.map((r: any) => r.scenario)];
assert.equal(new Set(names).size, names.length, "A scenario is selected twice");
const evidenceFile = "season_fun_rebuild_evidence.json";
const evidence = existsSync(dataFile(evidenceFile)) ? read(evidenceFile) : { identities: {} };
const CALIBRATION = "season_fun_rebuild_calibration.json";

async function get(url: string): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (response.ok && !text.includes("rate_limited")) {
      await new Promise(resolve => setTimeout(resolve, 400));
      return JSON.parse(text);
    }
    assert(response.status === 429 || response.status >= 500 || text.includes("rate_limited"), `HTTP ${response.status}: ${url}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(90_000, 5000 * 2 ** attempt)));
  }
  throw new Error(`Could not read ${url}`);
}

/** The floor validatePool holds a board to: 5 players between the tightest pair of ranks, never under 1,000. */
function minEntriesFor(window: number): number {
  const first = window * pool.windowSize;
  const width = windowRankCount(window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap);
  const slice = pool.ladder.ranks.slice(first, first + width);
  let tightest = Infinity;
  for (let i = 1; i < slice.length; i++) tightest = Math.min(tightest, slice[i - 1] - slice[i]);
  return Math.max(1000, Math.ceil(5 / tightest));
}

if (process.argv.includes("--sample")) {
  for (const [index, name] of names.entries()) {
    if (!evidence.identities[name]) {
      const url = `https://kovaaks.com/webapp-backend/scenario/popular?page=0&max=50&scenarioNameSearch=${encodeURIComponent(name)}`;
      const row = (await get(url)).data?.find((s: any) => s.scenarioName === name);
      assert(row?.leaderboardId, `${name}: no exact live identity`);
      if (tax.has(name)) assert.equal(tax.get(name).leaderboardId, row.leaderboardId, `${name}: taxonomy id disagrees`);
      const entry = { name, leaderboardId: row.leaderboardId, aimType: row.scenario?.aimType ?? null,
        description: row.scenario?.description ?? "", plays: row.counts.plays, entries: row.counts.entries,
        topScore: row.topScore?.score ?? null, verifiedAt: new Date().toISOString(), url };
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
      for (const rank of apexRanksFor(first.total)) {
        const score = rank <= first.data.length ? first.data[rank - 1].score
          : (await get(`${url}&page=${rank - 1}&max=1`)).data?.[0]?.score;
        assert(Number.isFinite(Number(score)), `${name}: missing rank ${rank}`);
        points.push({ rank, score: Number(score) });
      }
      for (let i = 1; i < points.length; i++) points[i].score = Math.min(points[i].score, points[i - 1].score);
      const sampled = { scenario: name, leaderboardId: id, total: first.total, points, sampledAt: new Date().toISOString() };
      boards.set(name, sampled); apex.boards.push(sampled); write("leaderboard_apex.json", apex);
    }
    // A board sampled before apexRanksFor existed can stop short of the distribution's
    // finest point; top it up with the one anchor it lacks rather than resampling it.
    const board = boards.get(name);
    const have = new Set(board.points.map((p: any) => p.rank));
    const missing = apexRanksFor(board.total).filter(r => !have.has(r));
    if (missing.length) {
      const url = `https://kovaaks.com/webapp-backend/leaderboard/scores/global?leaderboardId=${id}`;
      for (const rank of missing) {
        const score = Number((await get(`${url}&page=${rank - 1}&max=1`)).data?.[0]?.score);
        assert(Number.isFinite(score), `${name}: missing rank ${rank}`);
        board.points.push({ rank, score });
      }
      board.points.sort((a: any, b: any) => a.rank - b.rank);
      for (let i = 1; i < board.points.length; i++) board.points[i].score = Math.min(board.points[i].score, board.points[i - 1].score);
      write("leaderboard_apex.json", apex);
    }
    const window = spec.families.find((f: any) => f.rungs.includes(name))?.rungs.indexOf(name)
      ?? spec.rungs.find((r: any) => r.scenario === name).window;
    const floor = minEntriesFor(window);
    const total = dist.get(name).total;
    console.log(`${index + 1}/${names.length}: ${name}  ${total.toLocaleString()} entries${total < floor ? `  UNDER the ${floor.toLocaleString()} floor` : ""}`);
  }
} else if (process.argv.includes("--apply")) {
  assert(!existsSync(dataFile(CALIBRATION)), "Already applied; edit the frozen rebuild deliberately");
  for (const name of names) assert(evidence.identities[name] && dist.has(name) && boards.has(name), `${name}: run --sample first`);
  const audit = read("fun_audit.json");
  const curation = read("pool_curation.json");
  const rationale = read("scenario_rationale.json");
  const identity = read("scenario_identity.json");
  const subskills = new Map<string, any>(read("subskills.json").scenarios.map((s: any) => [s.scenario, s]));
  const durations = new Map<string, number | null>(read("scenario_durations.json").durations.map((d: any) => [d.scenario, d.seconds]));
  const priorSeason = read("seasons/season-1.json");

  // Hard rules first, so nothing is written for a selection that breaks one.
  for (const name of names) {
    const seconds = durations.get(name);
    assert(!(seconds && seconds > spec.rules.maxSeconds), `${name}: runs ${seconds}s, over ${spec.rules.maxSeconds}s`);
    assert(!/\b\d+\s*(?:-\s*\d+\s*)?min(?:ute)?s?\b/i.test(evidence.identities[name].description ?? ""), `${name}: its description announces a multi-minute run`);
  }
  for (const f of spec.families) {
    if (spec.rules.noVoltaicAddedTo.includes(f.category)) {
      for (const r of f.rungs) assert(!/\bVT\b|voltaic/i.test(r), `${f.family}: Voltaic rung added to ${f.category}`);
    }
  }

  const armCues: Record<string, string> = {
    "Six Targets": "Wrist", "Hipfire": "Fingertip", "Tile Frenzy": "Wrist", "Four Targets": "Wrist",
    "Raw Mouse": "Fingertip", "Pasu Wall": "Wrist", "Tamspeed": "Fingertip", "Timing": "Wrist",
    "Bounceshot": "Arm", "Clover Control": "Wrist", "SYW": "Arm", "PGTI": "Arm", "Long Strafes": "Arm",
    "Air Angelic": "Fingertip", "beanTS": "Fingertip", "patCircleSwitch": "Wrist", "patTargetSwitch": "Wrist",
    "FloatTS Angelic": "Blending", "Skeet": "Arm",
  };
  const adjustments: any[] = [];

  function cut(name: string, window: number, family: string, why: string, arm: string): any {
    const d = dist.get(name); const board = boards.get(name);
    const ranks = windowRankIndices(window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap);
    const topFractions = ranks.map((r: number, i: number) => pool.ladder.ranks[r]
      * (window < pool.windows.length - 1 && i >= 4 ? [0.5, 0.4][i - 4] : 1));
    const raw = thresholdsFrom(d, topFractions)!;
    assert(raw, `${name}: the distribution cannot answer the window's percentiles`);
    const record = Math.floor(board.points[0].score);
    const rankMaxes = [...raw];
    // Tied sparse-board cuts must not produce targets above the demonstrated record.
    rankMaxes[rankMaxes.length - 1] = Math.min(record, rankMaxes.at(-1)!);
    for (let i = rankMaxes.length - 2; i >= 0; i--) rankMaxes[i] = Math.min(rankMaxes[i], rankMaxes[i + 1] - 1);
    assert(rankMaxes[0] > 0 && rankMaxes.every((x, i) => i === 0 || x > rankMaxes[i - 1]), `${name}: no ascending ladder below the record`);
    adjustments.push({ scenario: name, window, family, ranks, topFractions, raw, rankMaxes, record,
      total: d.total, sampledAt: d.sampledAt, recordSampledAt: board.sampledAt });
    const floor = minEntriesFor(window);
    const published = subskills.get(name)?.mechanic;
    return { window, scenario: name, label: name, leaderboardId: d.leaderboardId,
      admitted: { why }, rankMaxes,
      source: { kind: "authored", why: "Frozen from this scenario's own dated leaderboard for the fun rebuild. The season curve sets the ranks the window grades; below Expert the two crossover ranks are cut stricter (0.5 and 0.4 of their fractions); a tail above the demonstrated record is capped backward from it. Reproduce from data/season_fun_rebuild_calibration.json. Equal effort between scenarios requires playtesting." },
      ...(d.total < floor ? { thinBoard: { why: `Kept with ${d.total.toLocaleString()} sampled entries, under the ${floor.toLocaleString()} this window asks of a board its ranks are cut from. The lineage earns the place (data/fun_audit.json); this rung's upper ranks rest on few players and need human calibration.` } } : {}),
      arm: published ?? arm, armFrom: published ? "Viscose" : "Apogee" };
  }

  const beforeFamilies: any[] = [];
  const beforeRungs: any[] = [];
  for (const f of spec.families) {
    const index = pool.families.findIndex((p: any) => p.category === f.category && p.family === f.replaces);
    assert(index >= 0, `${f.category}/${f.replaces}: not in the pool`);
    const old = pool.families[index];
    beforeFamilies.push({ index, family: structuredClone(old) });
    pool.families[index] = {
      family: f.family, category: f.category, subCategory: f.category, why: f.why,
      $order: { why: f.why + " The ordering follows the named edit lineage; cross-band physical difficulty is provisional until playtested." },
      variants: f.rungs.map((name: string, window: number) => cut(name, window, f.family, f.why, armCues[f.family] ?? "Blending")),
    };
  }
  for (const r of spec.rungs) {
    const family = pool.families.find((p: any) => p.category === r.category && p.family === r.family);
    const index = family.variants.findIndex((v: any) => v.window === r.window);
    const old = family.variants[index];
    assert.equal(old.scenario, r.replaces, `${r.family}: window ${r.window} is not ${r.replaces}`);
    beforeRungs.push({ category: r.category, family: r.family, index, variant: structuredClone(old) });
    family.variants[index] = cut(r.scenario, r.window, r.family, r.why, old.arm ?? "Blending");
  }

  const circuitSizes = Object.fromEntries(pool.categories.map((c: string) => [c, pool.families.filter((f: any) => f.category === c).length]));
  assert.deepEqual(circuitSizes, spec.rules.sizes, "Circuit sizes changed");
  const pasuStyle = pool.families.filter((f: any) => f.category === "Dynamic Clicking" && /pasu|angelic|popcorn/i.test(f.family));
  assert(pasuStyle.length <= spec.rules.maxPasuStyleDynamic, `Dynamic Clicking has ${pasuStyle.length} Pasu-style families`);

  // Curation follows the pool, family for family, in the same positions.
  for (const f of spec.families) {
    const list = curation.categories[f.category].families;
    const at = list.findIndex((c: any) => c.family === f.replaces);
    assert(at >= 0, `${f.replaces}: not in pool_curation.json`);
    list[at] = { family: f.family, why: f.why, rungs: f.rungs };
  }
  for (const r of spec.rungs) {
    const c = curation.categories[r.category].families.find((c: any) => c.family === r.family);
    c.rungs[r.window] = r.scenario;
  }
  curation.$comment = "Six category circuits, rebuilt for replay and reach in data/season_fun_rebuild.json with the measurements in data/fun_audit.json. Catalogue evidence is not a substitute for human difficulty and enjoyment playtesting.";

  // Rationale: out with the replaced families, in with the new, each citing its measurements.
  rationale.sources["fun-rebuild-catalogue"] = { title: "KovaaK's exact scenario catalogue checks for the fun rebuild",
    url: "https://kovaaks.com/kovaaks/scenarios", kind: "first-party" };
  rationale.sources["fun-audit"] = { title: "Apogee fun audit: replay, reach and benchmark consensus per family",
    url: "data/fun_audit.json", kind: "measurement" };
  const measured = new Map<string, any>(audit.families.filter((a: any) => a.status === "added").map((a: any) => [`${a.category}/${a.family}`, a]));
  for (const f of spec.families) {
    rationale.families = rationale.families.filter((old: any) => !(old.family === f.replaces && old.subCategory === f.category));
    const m = measured.get(`${f.category}/${f.family}`);
    assert(m, `${f.family}: not in fun_audit.json; run tools/funAudit.ts`);
    const audience = f.rungs.map((n: string) => tax.get(n)).sort((a: any, b: any) => (b.entries ?? 0) - (a.entries ?? 0))[0];
    rationale.families.push({ family: f.family, subCategory: f.category, isolates: f.isolates, why: f.why,
      evidence: [
        ...f.rungs.map((name: string) => ({ source: "fun-rebuild-catalogue", scenario: name,
          says: `Exact identity checked ${evidence.identities[name].verifiedAt}. ${evidence.identities[name].description}`.trim() })),
        { source: "fun-audit", says: `Replay ${m.replay} plays per player (rung-weighted), ${m.reach} players on the Novice and Intermediate rungs, named by ${m.consensus} of the benchmarks evxl lists; composite ${m.composite} against every family measured.` },
      ],
      audience: { scenario: audience.name, plays: audience.plays, entries: audience.entries },
      thin: "Chosen on measured replay, reach and benchmark consensus. No measured enjoyment or cross-band difficulty equivalence is claimed; playtesting decides both." });
  }
  // A swapped rung takes over its predecessor's citation in the kept family's rationale.
  for (const r of spec.rungs) {
    const family = rationale.families.find((f: any) => f.family === r.family && f.subCategory === r.category);
    assert(family, `${r.family}: no rationale`);
    family.evidence = family.evidence.filter((e: any) => e.scenario !== r.replaces);
    family.evidence.push({ source: "fun-rebuild-catalogue", scenario: r.scenario,
      says: `Exact identity checked ${evidence.identities[r.scenario].verifiedAt}. ${evidence.identities[r.scenario].description}`.trim() });
    if (family.audience.scenario === r.replaces) {
      const t = tax.get(r.scenario);
      family.audience = { scenario: r.scenario, plays: t.plays, entries: t.entries };
    }
  }
  const liveNames = new Set(pool.families.flatMap((f: any) => f.variants.map((v: any) => v.scenario)));
  for (const f of pool.families) for (const v of f.variants) {
    if (!names.includes(v.scenario)) continue;
    if (subskills.get(v.scenario)?.subSkill !== f.category) pool.subCategoryOverrides[v.scenario] = { subCategory: f.category,
      why: (spec.families.find((s: any) => s.family === f.family)?.why ?? spec.rungs.find((r: any) => r.scenario === v.scenario).why)
        + " The season classifies the complete circuit by its dominant firing and movement task." };
  }
  const citedSources = new Set(rationale.families.flatMap((f: any) => f.evidence.map((e: any) => e.source)));
  for (const source of Object.keys(rationale.sources)) if (!citedSources.has(source)) delete rationale.sources[source];
  const beforeOverrides = structuredClone(pool.subCategoryOverrides);
  for (const name of Object.keys(pool.subCategoryOverrides)) if (!liveNames.has(name)) delete pool.subCategoryOverrides[name];
  const droppedOverrides = Object.fromEntries(Object.entries(beforeOverrides).filter(([n]) => !liveNames.has(n)));

  const replacedNames = new Set([...beforeFamilies.flatMap(b => b.family.variants.map((v: any) => v.scenario)), ...beforeRungs.map(b => b.variant.scenario)]);
  write("pool.json", pool); write("pool_curation.json", curation); write("scenario_rationale.json", rationale);

  // scenario_identity.json and supabase/seed.sql are generated from the pool, never
  // hand-edited, so the new rungs reach them the documented way. Regenerating also re-files
  // scenarios that earlier migrations wrote into the identity by hand and later dropped
  // from the pool, and the audits of those migrations still read them - so every entry
  // regeneration changes or removes is frozen here with everything else it replaced.
  execFileSync("python", ["tools/generate_seed.py"], { cwd: dataFile(".."), stdio: "inherit" });
  const regenerated = read("scenario_identity.json").scenarios;
  const beforeIdentity = Object.fromEntries(Object.entries(identity.scenarios)
    .filter(([n, v]) => JSON.stringify(regenerated[n]) !== JSON.stringify(v)));
  for (const name of names) assert.equal(regenerated[name]?.leaderboardId, evidence.identities[name].leaderboardId, `${name}: regenerated identity disagrees`);
  write(CALIBRATION, { version: 1, appliedAt: new Date().toISOString(),
    method: "Season curve per window; crossover ranks below Expert at 0.5 and 0.4 of their fractions; tails capped backward from the floored rank-1 score.",
    beforeFamilies, beforeRungs, droppedOverrides, beforeIdentity,
    beforeScenarios: priorSeason.scenarios.filter((s: any) => replacedNames.has(s.scenario)),
    adjustments });
  const thin = pool.families.flatMap((f: any) => f.variants).filter((v: any) => names.includes(v.scenario) && v.thinBoard);
  console.log(`Applied ${spec.families.length} families and ${spec.rungs.length} rung swaps; ${adjustments.length} targets recorded, ${thin.length} on thin boards: ${thin.map((v: any) => v.scenario).join(", ") || "none"}.`);
  console.log("Next: npm run build:season, then the validators.");
} else throw new Error("Choose --sample or --apply");
