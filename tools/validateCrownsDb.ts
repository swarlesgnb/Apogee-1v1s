/**
 * Crowns against a real schema: the shipped list-crowns, challenge-crown, settle-match,
 * abandon-match and race-status handlers on Postgres-in-WASM, with every migration applied.
 *
 *   npx tsx tools/validateCrownsDb.ts
 *
 * What it proves, and how:
 *
 *   claims and takes     a vacant Crown is claimed by the first qualifying run set to settle;
 *                        a second claimant plays the same three and is judged against it
 *   one take             two challengers settling together against one holder: exactly one
 *                        takes, the holder's reign ends once, the other is judged against
 *                        the new holder
 *   what cannot take     a Rejected run, a Suspect run (even when settle-match calls it a
 *                        win), an abandoned scenario and a forfeit all leave the holder
 *   notices              readable by their owner and nobody else, through RLS and through
 *                        the function, and markable as read only by their owner
 *   lapse and reset      a reign past seven days lapses, unless a challenge is being played;
 *                        a Crown whose scenarios left the season resets
 *   unrated              no rating, no rating history, every Crown match rated = false
 *   the SQL is the spec  random sequences of challenges are decided by crown_resolve and by
 *                        the reducer in src/core/crowns/crowns.ts, and must agree step by step
 *
 * See tools/arenaHarness.ts for what is real and what is replaced, and for the limit of a
 * single-connection database.
 */

import {
  check,
  failed,
  fixtureSeason,
  freshDatabase,
  history,
  land,
  loadHandlers,
  makePlayer,
  matchScenarios,
  playAll,
  snapshotRatings,
} from "./arenaHarness.ts";
import { judge, vacate, beats, type Challenge, type CrownState, type RunSet, type RunTier } from "../src/core/crowns/crowns.ts";
import { seededRandom } from "../src/core/match/scenarioSelection.ts";

const db = await freshDatabase();
const season = await fixtureSeason(db);
const H = await loadHandlers(db, season, ["list-crowns", "challenge-crown", "settle-match", "abandon-match", "race-status"]);

const NAMES = ["Rook", "Ash", "Birch", "Cedar", "Dune", "Elm", "Fern", "Gale", "Heath", "Iris", "Juniper", "Kestrel", "Larch", "Moss", "Nettle"];
const P: Record<string, string> = {};
for (const [i, n] of NAMES.entries()) {
  P[n] = await makePlayer(db, i + 1, n);
  await history(db, P[n], season, 100);
}
const ratingsBefore = await snapshotRatings(db);

const PT = "Precise Tracking";
const call = (who: string, name: string, body: unknown = {}) => { H.as(P[who]); return H.handlers[name](body); };
const challenge = (who: string, category = PT, window = 1) => call(who, "challenge-crown", { category, window });
const settle = (who: string, matchId: string) => call(who, "settle-match", { matchId });
const board = (who: string, seen?: string[]) => call(who, "list-crowns", seen ? { seen } : {});
const crownRow = async (category = PT, window = 1) => (await db.query<any>(
  `select c.cycle, c.scenario_ids, r.id as reign_id, r.holder_id, r.defences, r.challenges, r.match_score, r.started_at
     from crowns c left join crown_reigns r on r.id = c.reign_id where c.category = $1 and c.window_index = $2`, [category, window])).rows[0];
const outcome = async (matchId: string) => (await db.query<any>("select * from crown_challenges where match_id = $1", [matchId])).rows[0];
const resetLimits = () => db.query("delete from rate_limits");
const card = (b: any, category = PT, window = 1) => b.crowns.find((c: any) => c.key === `${category}|${window}`);

/* ------------------------------------------------------------------------------- */
console.log("\n── an empty board ───────────────────────────────");
{
  const b = await board("Rook");
  check("list-crowns answers", b.status === 200, JSON.stringify(b.body).slice(0, 200));
  check("every category and band of the season is a Crown", b.body.crowns.length === 4 && b.body.bands.length === 2);
  check("all vacant, all claimable", b.body.crowns.every((c: any) => c.status === "vacant" && c.action.kind === "claim" && c.scenarios === null));
  check("a field it does not take is refused", (await call("Rook", "list-crowns", { holder: P.Rook })).status === 400);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── claiming a vacant Crown ──────────────────────");
let rookReign = "";
{
  const r = await challenge("Rook");
  check("a vacant Crown can be claimed", r.status === 200 && r.body.seeding === true && r.body.crown?.claim === true, JSON.stringify(r.body).slice(0, 300));
  check("the claim is a one-sided match on three scenarios", r.body.opponent === null && r.body.scenarios.length === 3);
  const a = await challenge("Ash");
  check("a second claimant gets a match too", a.status === 200 && a.body.crown?.claim === true);
  const [ra, aa] = [await matchScenarios(db, r.body.matchId), await matchScenarios(db, a.body.matchId)];
  check("both claimants play the same three", JSON.stringify(ra) === JSON.stringify(aa) && JSON.stringify((await crownRow()).scenario_ids.map(Number)) === JSON.stringify(ra));
  check("Crown matches are unrated", (await db.query<any>("select bool_and(not rated) as all from matches where id = any($1::uuid[])", [[r.body.matchId, a.body.matchId]])).rows[0].all === true);
  const again = await challenge("Rook");
  check("pressing Claim twice hands back the same match", again.status === 200 && again.body.matchId === r.body.matchId && again.body.resumed === true);

  await playAll(db, P.Rook, r.body.matchId, [102, 102, 102]);
  await playAll(db, P.Ash, a.body.matchId, [101, 101, 101]);
  const sr = await settle("Rook", r.body.matchId);
  check("the first claim to settle takes the Crown", sr.status === 200 && sr.body.arena?.crown?.outcome === "took", JSON.stringify(sr.body.arena));
  check("its result screen says so, and says nothing about the pool", /You took the Precise Tracking Crown \(Intermediate\)/.test(sr.body.message) && !/pool/.test(sr.body.explanation));
  const sa = await settle("Ash", a.body.matchId);
  check("the second claimant is judged against the new holder", sa.body.arena?.crown?.outcome === "defended" && sa.body.arena.crown.judgedAgainstNewHolder === true, JSON.stringify(sa.body.arena));
  check("and is told why", /changed hands while you played/.test(sa.body.arena.crown.explanation));
  const row = await crownRow();
  rookReign = row.reign_id;
  check("Rook holds it with one defence", row.holder_id === P.Rook && row.defences === 1 && Math.abs(Number(row.match_score) - 0.02) < 1e-9);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the board, and who may challenge ─────────────");
{
  const b = await board("Birch");
  const c = card(b.body);
  check("the board shows holder, bar, defences, tier", c.holder?.name === "Rook" && Math.abs(c.bar - 0.02) < 1e-9 && c.defences === 1 && c.tier === "consistent", JSON.stringify(c).slice(0, 300));
  check("and offers Birch a challenge", c.action.kind === "challenge" && c.scenarios.length === 3);
  check("Rook's own board says the Crown is theirs", card((await board("Rook")).body).action.kind === "yours");
  const own = await challenge("Rook");
  check("a holder cannot challenge their own Crown", own.status === 409 && /You hold this Crown/.test(own.body.error), JSON.stringify(own.body));
  const cooled = await challenge("Ash");
  check("one challenge per Crown every 20 hours", cooled.status === 429 && /20 hours/.test(cooled.body.error), JSON.stringify(cooled.body));
  check("Ash's board shows the cooldown", card((await board("Ash")).body).action.kind === "cooldown");
  const sneaky = await call("Birch", "challenge-crown", { category: PT, window: 1, scenarios: [1, 2, 3] });
  check("a request naming its own scenarios is refused", sneaky.status === 400);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── two challengers settle together ──────────────");
{
  const c = await challenge("Cedar");
  const d = await challenge("Dune");
  check("both are playing Rook's run set", c.body.opponent?.displayName === "Rook" && d.body.opponent?.displayName === "Rook");
  await playAll(db, P.Cedar, c.body.matchId, [104, 104, 104]);
  await playAll(db, P.Dune, d.body.matchId, [104, 104, 104]);
  H.as(P.Cedar); const pc = H.handlers["settle-match"]({ matchId: c.body.matchId });
  H.as(P.Dune); const pd = H.handlers["settle-match"]({ matchId: d.body.matchId });
  const [rc, rd] = await Promise.all([pc, pd]);
  check("both settle", rc.status === 200 && rd.status === 200);
  check("settle-match called both a win against Rook's run set", rc.body.verdict === "win" && rd.body.verdict === "win");
  const outs = [await outcome(c.body.matchId), await outcome(d.body.matchId)];
  const takes = outs.filter((o) => o.outcome === "took");
  check("exactly one of them takes the Crown", takes.length === 1, outs.map((o) => o.outcome).join(", "));
  const other = outs.find((o) => o.outcome !== "took");
  check("the other drew with the new holder, and a draw is a defence", other?.outcome === "defended" && other.judged_reign_id !== rookReign);
  const ended = (await db.query<any>("select end_reason, ended_by from crown_reigns where id = $1", [rookReign])).rows[0];
  check("Rook's reign ended once, dethroned by the taker", ended.end_reason === "dethroned" && ended.ended_by === takes[0].challenger_id);
  const live = (await db.query<any>("select count(*)::int as n from crown_reigns where category = $1 and window_index = 1 and ended_at is null", [PT])).rows[0].n;
  check("there is one live reign", live === 1);
  const takerName = takes[0].challenger_id === P.Cedar ? "Cedar" : "Dune";
  const loserNote = (takerName === "Cedar" ? rd : rc).body.arena.crown;
  check("the second to settle is told it changed hands", loserNote.judgedAgainstNewHolder === true && loserNote.holderName === takerName, JSON.stringify(loserNote));
}

/* ------------------------------------------------------------------------------- */
console.log("\n── different scores settling together ───────────");
{
  const holderBefore = (await crownRow()).holder_id;
  const e = await challenge("Elm");
  const f = await challenge("Fern");
  await playAll(db, P.Elm, e.body.matchId, [106, 106, 106]);
  await playAll(db, P.Fern, f.body.matchId, [105, 105, 105]);
  H.as(P.Fern); const pf = H.handlers["settle-match"]({ matchId: f.body.matchId });
  H.as(P.Elm); const pe = H.handlers["settle-match"]({ matchId: e.body.matchId });
  await Promise.all([pf, pe]);
  const row = await crownRow();
  check("the best run set holds the Crown whatever order they settled in", row.holder_id === P.Elm, NAMES.find((n) => P[n] === row.holder_id));
  const endedOnce = (await db.query<any>("select count(*)::int as n from crown_reigns where holder_id = $1 and category = $2 and window_index = 1 and end_reason = 'dethroned'", [holderBefore, PT])).rows[0].n;
  check("the previous holder was dethroned exactly once", endedOnce === 1);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── what cannot take a Crown ─────────────────────");
{
  const before = await crownRow();
  const g = await challenge("Gale");
  await playAll(db, P.Gale, g.body.matchId, [150, 150, 150], ["consistent", "rejected", "consistent"]);
  const sg = await settle("Gale", g.body.matchId);
  check("a Rejected run voids the challenge", sg.body.verdict === "void" && (await outcome(g.body.matchId)).outcome === "void");
  let row = await crownRow();
  check("the holder keeps it, with no defence added", row.holder_id === before.holder_id && row.defences === before.defences && row.challenges === before.challenges);

  const h = await challenge("Heath");
  await playAll(db, P.Heath, h.body.matchId, [150, 150, 150], ["consistent", "suspect", "verified"]);
  const sh = await settle("Heath", h.body.matchId);
  check("settle-match calls a Suspect run set a win", sh.body.verdict === "win");
  check("but a Suspect run does not take a Crown", (await outcome(h.body.matchId)).outcome === "void" && (await crownRow()).holder_id === before.holder_id);
  check("and the screen says why", /held for review/.test(sh.body.arena?.crown?.explanation ?? ""), sh.body.arena?.crown?.explanation);

  const i = await challenge("Iris");
  const ab = await call("Iris", "abandon-match", {});
  check("abandoning a challenge is a forfeit", ab.status === 200 && (await outcome(i.body.matchId)).outcome === "forfeit", JSON.stringify(ab.body).slice(0, 200));
  row = await crownRow();
  check("a forfeit is not a defence", row.defences === before.defences && row.challenges === before.challenges);
  check("and it spends the cooldown", (await challenge("Iris")).status === 429);

  const j = await challenge("Juniper");
  const ids = await matchScenarios(db, j.body.matchId);
  await db.query("update scenarios set duration_seconds = 60 where id = $1", [ids[0]]);
  await land(db, P.Juniper, j.body.matchId, ids[0], 300, "consistent", 12);
  const sj = await settle("Juniper", j.body.matchId);
  await db.query("update scenarios set duration_seconds = null where id = $1", [ids[0]]);
  check("an abandoned scenario voids the challenge", sj.body.verdict === "void" && (await outcome(j.body.matchId)).outcome === "void" && (await crownRow()).holder_id === before.holder_id);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the live view of a challenge ─────────────────");
{
  const holder = (await crownRow()).holder_id;
  const k = await challenge("Kestrel");
  const ids = await matchScenarios(db, k.body.matchId);
  const holderDeltas = (await db.query<any>("select deltas from match_sides where match_id = $1 and player_id = $2", [k.body.matchId, holder])).rows[0].deltas.map(Number);
  let v = await call("Kestrel", "race-status", { matchId: k.body.matchId });
  check("before a run lands, every holder round is sealed", v.status === 200 && v.body.kind === "crown" && v.body.rounds.every((r: any) => r.them.sealed && r.them.delta === null), JSON.stringify(v.body).slice(0, 300));
  await land(db, P.Kestrel, k.body.matchId, ids[1], 103);
  v = await call("Kestrel", "race-status", { matchId: k.body.matchId });
  check("the round you landed opens the holder's round", Math.abs(v.body.rounds[1].them.delta - holderDeltas[1]) < 1e-9 && Math.abs(v.body.rounds[1].you.delta - 0.03) < 1e-9);
  check("the others stay sealed", v.body.rounds[0].them.sealed && v.body.rounds[2].them.sealed && v.body.rounds[0].them.delta === null);
  check("the bar is that one round's margin", Math.abs(v.body.margin - (0.03 - holderDeltas[1])) < 1e-9 && v.body.marginRounds === 1);
  check("nobody else can watch it", (await call("Larch", "race-status", { matchId: k.body.matchId })).status === 404);
  await land(db, P.Kestrel, k.body.matchId, ids[0], 90);
  await land(db, P.Kestrel, k.body.matchId, ids[2], 90);
  await settle("Kestrel", k.body.matchId);
  v = await call("Kestrel", "race-status", { matchId: k.body.matchId });
  check("after settling it shows the verdict", v.body.verdict === "loss" && v.body.rounds.every((r: any) => !r.them.sealed));
}

/* ------------------------------------------------------------------------------- */
console.log("\n── notices belong to their owner ────────────────");
{
  const rookNotices = (await db.query<any>("select id, kind from crown_notices where player_id = $1 order by created_at", [P.Rook])).rows;
  check("Rook has a dethroned notice", rookNotices.some((n) => n.kind === "dethroned"));
  const dethroned = rookNotices.find((n) => n.kind === "dethroned")!;
  await db.exec("set role authenticated");
  await db.query("select set_config('test.player_id', $1, false)", [P.Rook]);
  const own = (await db.query<any>("select id, kind, other_name from crown_notices")).rows;
  await db.query("select set_config('test.player_id', $1, false)", [P.Larch]);
  const others = (await db.query<any>("select id from crown_notices")).rows;
  const writes: string[] = [];
  for (const sql of [
    `update crown_notices set seen_at = now() where id = '${dethroned.id}'`,
    `delete from crown_notices where id = '${dethroned.id}'`,
    `insert into crown_notices (player_id, kind, category, window_index) values ('${P.Larch}', 'dethroned', 'x', 0)`,
    "select * from crowns", "select * from crown_reigns", "select * from crown_challenges",
    `select crown_resolve('${dethroned.id}')`,
  ]) {
    try { const r = await db.query(sql); if ((r.affectedRows ?? 0) > 0 || (r.rows?.length ?? 0) > 0) writes.push(sql); } catch { /* refused */ }
  }
  await db.exec("reset role");
  check("the owner reads their own notices directly", own.length === rookNotices.length && own.every((n) => n.other_name !== undefined));
  check("another player reads none of them", others.length === 0);
  check("nobody writes or deletes a notice, reads the Crown tables or calls the decision", writes.length === 0, writes.join(" | "));

  const rb = await board("Rook");
  const note = rb.body.notices.find((n: any) => n.id === dethroned.id);
  check("list-crowns shows Rook the dethroned notice as a sentence", /^You lost the Precise Tracking Crown \(Intermediate\) to (Cedar|Dune) after 1 defence\./.test(note?.text ?? ""), note?.text);
  check("nobody else's board carries it", !(await board("Larch")).body.notices.some((n: any) => n.id === dethroned.id));
  await board("Larch", [dethroned.id]);
  check("another player cannot mark it read", (await db.query<any>("select seen_at from crown_notices where id = $1", [dethroned.id])).rows[0].seen_at === null);
  await board("Rook", [dethroned.id]);
  check("its owner can", (await db.query<any>("select seen_at from crown_notices where id = $1", [dethroned.id])).rows[0].seen_at !== null);
  check("and it leaves the board", !(await board("Rook")).body.notices.some((n: any) => n.id === dethroned.id));
}

/* ------------------------------------------------------------------------------- */
console.log("\n── lapse and reset ──────────────────────────────");
{
  await resetLimits();
  const before = await crownRow();
  await db.query("update crown_reigns set started_at = now() - interval '8 days' where id = $1", [before.reign_id]);
  const l = await challenge("Larch");
  check("a challenge on a reign past the cap lapses it first, and claims the new cycle", l.status === 200 && l.body.crown.claim === true,
    JSON.stringify(l.body).slice(0, 200));
  const after = await crownRow();
  check("the lapse ends the reign and starts a new cycle", after.reign_id === null && after.cycle === before.cycle + 1);
  check("the new cycle drew a new three", after.scenario_ids !== null);
  const lapsed = (await db.query<any>("select kind, defences from crown_notices where player_id = $1 and kind = 'lapsed'", [before.holder_id])).rows;
  check("the holder is told it lapsed, with their defences", lapsed.length === 1 && lapsed[0].defences === before.defences);
  await playAll(db, P.Larch, l.body.matchId, [99, 99, 99]);
  await settle("Larch", l.body.matchId);
  check("the claimant holds the new cycle", (await crownRow()).holder_id === P.Larch);

  // A challenge being played holds a lapse open.
  const larchReign = (await crownRow()).reign_id;
  const m = await challenge("Moss");
  check("Moss challenges Larch", m.status === 200 && m.body.opponent?.displayName === "Larch", JSON.stringify(m.body).slice(0, 200));
  // The reign reaches the cap while Moss is playing.
  await db.query("update crown_reigns set started_at = now() - interval '8 days' where id = $1", [larchReign]);
  await board("Nettle");
  check("a live challenge holds the lapse", (await crownRow()).reign_id === larchReign);
  await call("Moss", "abandon-match", {});
  await board("Nettle");
  check("once it ends, the next look lapses the reign", (await crownRow()).reign_id === null);

  // Reset: the season drops a Crown's scenarios.
  const s = await challenge("Nettle", "Speed Switching", 0);
  await playAll(db, P.Nettle, s.body.matchId, [101, 101, 101]);
  await settle("Nettle", s.body.matchId);
  const ssBefore = await crownRow("Speed Switching", 0);
  const pool = season.pools.get(0)!;
  const kept = pool.filter((x) => !(ssBefore.scenario_ids as number[]).map(Number).includes(x.id) || x.subCategory !== "Speed Switching");
  const extra = (await db.query<any>("select id, name from scenarios order by id offset 20 limit 3")).rows
    .map((x: any) => ({ id: Number(x.id), name: x.name, aimType: "Switching", subCategory: "Speed Switching" }));
  season.pools.set(0, [...kept, ...extra]);
  await board("Ash");
  const reset = await crownRow("Speed Switching", 0);
  check("a Crown whose scenarios left the season resets", reset.reign_id === null && reset.cycle === ssBefore.cycle + 1 && reset.scenario_ids === null);
  check("its holder is told", (await db.query<any>("select count(*)::int as n from crown_notices where player_id = $1 and kind = 'reset'", [P.Nettle])).rows[0].n === 1);
  season.pools.set(0, pool);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── nothing is rated ─────────────────────────────");
{
  check("no rating and no rating history moved", (await snapshotRatings(db)) === ratingsBefore);
  const rated = (await db.query<any>("select count(*)::int as n from crown_challenges cc join matches m on m.id = cc.match_id where m.rated")).rows[0].n;
  check("every Crown match is unrated", rated === 0);
  const limited = (await db.query<any>("select distinct action from rate_limits where action in ('list-crowns','challenge-crown','race-status')")).rows.map((r) => r.action).sort();
  check("the shipped rate limiter counted the arena calls", limited.length >= 2, limited.join(", "));
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the SQL decides what the reducer decides ─────");
{
  const category = "Speed Switching";
  const window = 1;
  const players = NAMES.map((n) => P[n]);
  const scen = season.pools.get(1)!.filter((s) => s.subCategory === category).slice(0, 3).map((s) => s.id);
  let ts: CrownState = { category, window, cycle: 0, scenarioIds: null, reign: null };
  const r = seededRandom("differential");
  const scores = [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05];
  let steps = 0, mismatches = 0;
  const kinds = { took: 0, defended: 0, void: 0, forfeit: 0, stale: 0 } as Record<string, number>;
  const mismatch = (what: string) => { mismatches++; if (mismatches <= 5) console.log(`       mismatch at step ${steps}: ${what}`); };
  let fileSerial = 0;

  for (let round = 0; round < 60; round++) {
    // Occasionally age the reign past the cap and lapse it, with nothing being played.
    if (ts.reign && r() < 0.12) {
      await db.query("update crown_reigns set started_at = now() - interval '8 days' where id = $1", [ts.reign.id]);
      const lapsed = (await H.admin.rpc("crown_lapse_due", { p_category: category, p_window: window, p_cap_seconds: 604800 })).data;
      ts = vacate(ts, Date.now(), "lapsed").state;
      if (lapsed !== true) mismatch("lapse did not happen in SQL");
    }
    const holder = ts.reign?.holderId ?? null;
    const pool = players.filter((p) => p !== holder);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const opened: { c: Challenge; claim: boolean }[] = [];
    for (const who of pool.slice(0, 1 + Math.floor(r() * 3))) {
      const res = await H.admin.rpc("crown_open_challenge", {
        p_category: category, p_window: window, p_player: who, p_seed: `diff-${round}-${who}`, p_scenarios: scen,
        p_benchmark: "Season 1", p_difficulty: "Intermediate", p_ttl_seconds: 480, p_cooldown_seconds: 0, p_reign_cap_seconds: 604800,
      });
      if (res.error) { mismatch(`open refused: ${res.error.message}`); continue; }
      opened.push({ c: { matchId: res.data.matchId, challengerId: who, cycle: ts.cycle, reignId: ts.reign?.id ?? null, openedAt: Date.now() }, claim: res.data.claim });
      if (ts.scenarioIds === null) ts = { ...ts, scenarioIds: scen };
    }
    for (let i = opened.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [opened[i], opened[j]] = [opened[j], opened[i]]; }

    for (const { c, claim } of opened) {
      steps++;
      const kind = r();
      const score = scores[Math.floor(r() * scores.length)];
      const tiers: RunTier[] = kind < 0.1 ? ["consistent", "rejected", "verified"] : kind < 0.18 ? ["verified", "suspect", "consistent"] : r() < 0.5 ? ["verified", "verified", "verified"] : ["consistent", "verified", "consistent"];
      const forfeit = kind >= 0.18 && kind < 0.26;
      const voided = kind >= 0.26 && kind < 0.3;
      let set: RunSet;
      const ids = await matchScenarios(db, c.matchId);
      if (forfeit) {
        // What forfeitMatch commits: a loss for a contested challenge, a void for a claim.
        const sides = [{ player_id: c.challengerId, result: claim ? null : "loss" }];
        await db.query("select commit_match_result($1, $2, $3::jsonb, '[]'::jsonb, true)", [c.matchId, claim ? "void" : "settled", JSON.stringify(sides)]);
        set = claim ? { status: "void", matchScore: null, tiers: [], scenarios: 3 } : { status: "settled", matchScore: null, tiers: [], scenarios: 3, forfeit: true };
      } else if (voided || (!claim && tiers.includes("rejected"))) {
        // settle-match voids a contested match with a rejected round (uneven sides), and any
        // match with an abandoned one.
        await db.query("select commit_match_result($1, 'void', $2::jsonb)", [c.matchId, JSON.stringify([{ player_id: c.challengerId, result: null }])]);
        set = { status: "void", matchScore: null, tiers: [], scenarios: 3 };
      } else {
        const runIds: string[] = [];
        for (const [i, sid] of ids.entries()) {
          const name = season.pools.get(1)!.find((s) => s.id === sid)!.name;
          const row = (await db.query<any>(
            `insert into runs (player_id, scenario_name, score, played_at, csv_sha256, verification_tier, match_id)
             values ($1, $2, $3, clock_timestamp(), $4, $5, $6) returning id`,
            [c.challengerId, name, 100 * (1 + score), `diff-run-${++fileSerial}`, tiers[i], c.matchId])).rows[0];
          runIds.push(row.id);
        }
        const holderScore = ts.reign?.matchScore ?? 0;
        const result = claim ? null : beats(score, holderScore) ? "win" : beats(holderScore, score) ? "loss" : "draw";
        const sides = [{ player_id: c.challengerId, run_ids: runIds, deltas: [score, score, score], match_score: score, result, provisional: false }];
        await db.query("select commit_match_result($1, 'settled', $2::jsonb)", [c.matchId, JSON.stringify(sides)]);
        set = { status: "settled", matchScore: score, tiers, scenarios: 3 };
      }
      const sqlRow = await crownRow(category, window);
      const decided = await outcome(c.matchId);
      const j = judge(ts, c, set, Date.now(), sqlRow.reign_id ?? "none");
      kinds[j.outcome] = (kinds[j.outcome] ?? 0) + 1;
      if (decided.outcome !== j.outcome) mismatch(`outcome ${decided.outcome} vs ${j.outcome}`);
      ts = j.state;
      if ((sqlRow.holder_id ?? null) !== (ts.reign?.holderId ?? null)) mismatch(`holder ${sqlRow.holder_id} vs ${ts.reign?.holderId}`);
      if (ts.reign && (sqlRow.defences !== ts.reign.defences || sqlRow.challenges !== ts.reign.challenges)) {
        mismatch(`defences ${sqlRow.defences}/${sqlRow.challenges} vs ${ts.reign.defences}/${ts.reign.challenges}`);
      }
      if (ts.reign && Math.abs(Number(sqlRow.match_score) - ts.reign.matchScore) > 1e-12) mismatch("bar differs");
      if (sqlRow.cycle !== ts.cycle) mismatch(`cycle ${sqlRow.cycle} vs ${ts.cycle}`);
    }
  }
  const notices = (await db.query<any>("select kind, count(*)::int as n from crown_notices where category = $1 and window_index = $2 group by kind", [category, window])).rows;
  const count = (k: string) => notices.find((n) => n.kind === k)?.n ?? 0;
  check(`${steps} random challenges decided identically by SQL and reducer`, mismatches === 0 && steps > 100,
    `${mismatches} mismatches; took ${kinds.took}, defended ${kinds.defended}, void ${kinds.void}, forfeit ${kinds.forfeit}, stale ${kinds.stale}`);
  check("every outcome kind occurred", kinds.took > 5 && kinds.defended > 5 && kinds.void > 5 && kinds.forfeit > 3);
  check("one dethroned notice per take from a holder, one defended per defence", count("defended") === kinds.defended && count("dethroned") <= kinds.took && count("dethroned") > 0);
}

console.log(failed() === 0 ? "\nOK: Crowns hold against the real schema and handlers" : `\n${failed()} check(s) failed`);
await db.close();
if (failed() > 0) process.exit(1);
