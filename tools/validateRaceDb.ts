/**
 * Live races against a real schema: the shipped race-action, race-status, settle-match and
 * abandon-match handlers on Postgres-in-WASM, with every migration applied.
 *
 *   npx tsx tools/validateRaceDb.ts
 *
 * What it proves:
 *
 *   invitations   one out at a time; only the invitee accepts or declines, only the inviter
 *                 takes it back; an expired one cannot be accepted
 *   the start     accepting creates both matches in one transaction, same three, same
 *                 start, unrated; a player already in a match cannot start one
 *   sealed        through race-status, the other side's round appears only once your own run
 *                 on it has landed; through RLS, the other player's match is not readable at all
 *   the result    decided once both legs end, from what settlement stored; a leg that did not
 *                 finish loses to one that did; two legs ending together decide it once
 *   unrated       no rating or rating history moves
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

const db = await freshDatabase();
const season = await fixtureSeason(db);
const H = await loadHandlers(db, season, ["race-action", "race-status", "settle-match", "abandon-match", "challenge-crown"]);
const NAMES = ["Ana", "Bo", "Cy", "Di", "Ed"];
const P: Record<string, string> = {};
for (const [i, n] of NAMES.entries()) {
  P[n] = await makePlayer(db, 100 + i, n);
  await history(db, P[n], season, 100);
}
const ratingsBefore = await snapshotRatings(db);
const call = (who: string, name: string, body: unknown = {}) => { H.as(P[who]); return H.handlers[name](body); };
const act = (who: string, body: unknown) => call(who, "race-action", body);
const status = (who: string, body: unknown = {}) => call(who, "race-status", body);
const invite = (from: string, to: string, category = "Precise Tracking", window = 1) => act(from, { action: "invite", to: P[to], category, window });
const race = async (id: string) => (await db.query<any>("select * from races where id = $1", [id])).rows[0];

/* ------------------------------------------------------------------------------- */
console.log("\n── invitations ──────────────────────────────────");
let raceId = "";
{
  const inv = await invite("Ana", "Bo");
  check("an invitation is sent", inv.status === 200 && inv.body.race?.status === "invited" && inv.body.race.scenarios.length === 3, JSON.stringify(inv.body).slice(0, 300));
  raceId = inv.body.race.id;
  check("one out at a time", (await invite("Ana", "Cy")).status === 409);
  check("nobody races themselves", (await invite("Ana", "Ana")).status === 400);
  check("a field it does not take is refused", (await act("Ana", { action: "invite", to: P.Bo, category: "Precise Tracking", window: 1, seed: "x" })).status === 400);
  const bo = await status("Bo");
  check("Bo sees it, with the three, from Ana", bo.status === 200 && bo.body.incoming.length === 1 && bo.body.incoming[0].opponent.name === "Ana" && bo.body.incoming[0].scenarios.length === 3);
  check("and nothing about anybody's scores", !/score|delta|baseline/i.test(JSON.stringify(bo.body)));
  check("Ana sees it as hers", (await status("Ana")).body.outgoing?.id === raceId);
  check("Cy does not see it", (await status("Cy")).body.incoming.length === 0);
  check("Ana cannot decline her own invitation", (await act("Ana", { action: "decline", raceId })).status === 403);
  check("Bo cannot take back Ana's", (await act("Bo", { action: "cancel", raceId })).status === 403);
  check("Cy cannot accept it", (await act("Cy", { action: "accept", raceId })).status === 404);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── starting ─────────────────────────────────────");
let aMatch = "", bMatch = "";
{
  const acc = await act("Bo", { action: "accept", raceId });
  check("Bo accepts and gets a match", acc.status === 200 && acc.body.race?.id === raceId && acc.body.scenarios.length === 3, JSON.stringify(acc.body).slice(0, 300));
  const r = await race(raceId);
  aMatch = r.inviter_match_id; bMatch = r.invitee_match_id;
  check("the race is live with a match for each", r.status === "live" && !!aMatch && !!bMatch && acc.body.matchId === bMatch);
  const ms = (await db.query<any>("select id, scenario_ids, created_at, rated, mode from matches where id = any($1::uuid[])", [[aMatch, bMatch]])).rows;
  check("same three, same start", JSON.stringify(ms[0].scenario_ids) === JSON.stringify(ms[1].scenario_ids) && String(ms[0].created_at) === String(ms[1].created_at));
  check("both unrated, both live mode", ms.every((m) => m.rated === false && m.mode === "live"));
  check("the scenarios are the ones Bo was shown", JSON.stringify(ms[0].scenario_ids.map(Number)) === JSON.stringify(r.scenario_ids.map(Number)));
  check("Ana learns her match id from the list", (await status("Ana")).body.live?.yourMatchId === aMatch);
  const again = await act("Bo", { action: "accept", raceId });
  check("accepting twice hands back the same match", again.status === 200 && again.body.matchId === bMatch && again.body.resumed === true);
  // Anybody in a race is in a match: no second race, no Crown challenge.
  const second = await invite("Cy", "Ana");
  check("Cy can invite Ana", second.status === 200);
  check("but Ana cannot accept while racing", (await act("Ana", { action: "accept", raceId: second.body.race.id })).status === 409);
  check("and Bo cannot start a Crown challenge mid-race", (await call("Bo", "challenge-crown", { category: "Precise Tracking", window: 1 })).status === 409);
  await act("Cy", { action: "cancel", raceId: second.body.race.id });
}

/* ------------------------------------------------------------------------------- */
console.log("\n── sealed rounds ────────────────────────────────");
{
  const ids = await matchScenarios(db, aMatch);
  await land(db, P.Ana, aMatch, ids[0], 104);
  let bo = await status("Bo", { raceId });
  check("Ana's round 1 lands: Bo sees it landed and sealed", bo.status === 200 && bo.body.them.landed === 1 && bo.body.rounds[0].them.sealed && bo.body.rounds[0].them.delta === null, JSON.stringify(bo.body).slice(0, 200));
  check("no trace of the number anywhere in Bo's view", !JSON.stringify(bo.body).includes("0.04"));
  await land(db, P.Bo, bMatch, ids[1], 97);
  bo = await status("Bo", { raceId });
  check("Bo landing round 2 opens nothing of Ana's round 1", bo.body.rounds[0].them.sealed && bo.body.rounds[0].them.delta === null);
  await land(db, P.Bo, bMatch, ids[0], 102);
  bo = await status("Bo", { raceId });
  check("Bo landing round 1 opens Ana's round 1", !bo.body.rounds[0].them.sealed && Math.abs(bo.body.rounds[0].them.delta - 0.04) < 1e-9);
  check("Bo's own rounds are measured against Bo's baseline", Math.abs(bo.body.rounds[0].you.delta - 0.02) < 1e-9 && Math.abs(bo.body.rounds[1].you.delta + 0.03) < 1e-9);
  check("the bar is the one round both have revealed", Math.abs(bo.body.margin - (0.02 - 0.04)) < 1e-9 && bo.body.marginRounds === 1);
  const ana = await status("Ana", { matchId: aMatch });
  check("Ana sees Bo's round 1 (she landed hers) but not round 2", Math.abs(ana.body.rounds[0].them.delta - 0.02) < 1e-9 && ana.body.rounds[1].them.sealed);
  check("nobody else can watch", (await status("Cy", { raceId })).status === 404);

  await db.exec("set role authenticated");
  await db.query("select set_config('test.player_id', $1, false)", [P.Bo]);
  const sides = (await db.query("select player_id from match_sides where match_id = $1", [aMatch])).rows.length;
  const matches = (await db.query("select id from matches where id = $1", [aMatch])).rows.length;
  let racesReadable = true;
  try { await db.query("select * from races"); } catch { racesReadable = false; }
  let runs = 0;
  try { runs = (await db.query("select id from runs where match_id = $1", [aMatch])).rows.length; } catch { runs = 0; }
  await db.exec("reset role");
  check("through RLS Bo reads nothing of Ana's match", sides === 0 && matches === 0 && runs === 0);
  check("and cannot read the races table at all", !racesReadable);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── the result ───────────────────────────────────");
{
  const ids = await matchScenarios(db, aMatch);
  await land(db, P.Ana, aMatch, ids[1], 101);
  await land(db, P.Ana, aMatch, ids[2], 101);
  const sa = await call("Ana", "settle-match", { matchId: aMatch });
  check("Ana's leg settles on its own", sa.status === 200 && sa.body.seeding === true && sa.body.arena?.kind === "race");
  check("and says Bo is still playing, not that her run set joined the pool", /still playing/.test(sa.body.explanation) && !/pool/.test(sa.body.explanation), sa.body.explanation);
  check("the race is not decided yet", (await race(raceId)).status === "live");
  let bo = await status("Bo", { raceId });
  check("Bo still cannot see Ana's round 3", bo.body.rounds[2].them.sealed && bo.body.them.matchScore === null);
  await land(db, P.Bo, bMatch, ids[2], 101);
  const sb = await call("Bo", "settle-match", { matchId: bMatch });
  const r = await race(raceId);
  check("Bo's last leg decides the race", r.status === "finished" && r.result === "inviter" && !r.by_forfeit, `${r.status} ${r.result}`);
  check("Bo's result screen says who won", /Ana won the race/.test(sb.body.arena?.headline ?? ""), sb.body.arena?.headline);
  bo = await status("Bo", { raceId });
  check("and the live view now shows everything, with the verdict", bo.body.verdict === "loss" && bo.body.rounds.every((x: any) => !x.them.sealed) && bo.body.them.matchScore != null);
  check("Ana's view reads it from her side", (await status("Ana", { raceId })).body.verdict === "win");
  check("the race is in both players' recent results", (await status("Ana")).body.recent[0]?.verdict === "win" && (await status("Bo")).body.recent[0]?.verdict === "loss");
}

/* ------------------------------------------------------------------------------- */
console.log("\n── forfeits, expiry, simultaneous finishes ──────");
{
  const inv = await invite("Cy", "Di");
  await act("Di", { action: "accept", raceId: inv.body.race.id });
  let r = await race(inv.body.race.id);
  await playAll(db, P.Cy, r.inviter_match_id, [95, 95, 95]);
  await call("Cy", "settle-match", { matchId: r.inviter_match_id });
  const ab = await call("Di", "abandon-match", {});
  r = await race(inv.body.race.id);
  check("the side that finished beats the side that quit, even from behind", ab.status === 200 && r.status === "finished" && r.result === "inviter" && r.by_forfeit === true, `${r.status} ${r.result}`);

  const late = await invite("Ed", "Ana");
  await db.query("update races set expires_at = now() - interval '1 second' where id = $1", [late.body.race.id]);
  check("an expired invitation cannot be accepted", (await act("Ana", { action: "accept", raceId: late.body.race.id })).status === 409);
  check("and reads expired in the list", (await status("Ed")).body.outgoing === null && (await race(late.body.race.id)).status === "expired");

  const both = await invite("Ed", "Bo");
  await act("Bo", { action: "accept", raceId: both.body.race.id });
  r = await race(both.body.race.id);
  await playAll(db, P.Ed, r.inviter_match_id, [103, 103, 103]);
  await playAll(db, P.Bo, r.invitee_match_id, [103, 103, 103]);
  H.as(P.Ed); const pe = H.handlers["settle-match"]({ matchId: r.inviter_match_id });
  H.as(P.Bo); const pb = H.handlers["settle-match"]({ matchId: r.invitee_match_id });
  await Promise.all([pe, pb]);
  r = await race(both.body.race.id);
  check("two legs ending together decide the race once: a draw", r.status === "finished" && r.result === "draw");

  const rejected = await invite("Ed", "Cy");
  await act("Cy", { action: "accept", raceId: rejected.body.race.id });
  r = await race(rejected.body.race.id);
  await playAll(db, P.Ed, r.inviter_match_id, [130, 130, 130], ["consistent", "rejected", "consistent"]);
  await playAll(db, P.Cy, r.invitee_match_id, [99, 99, 99]);
  await call("Ed", "settle-match", { matchId: r.inviter_match_id });
  await call("Cy", "settle-match", { matchId: r.invitee_match_id });
  r = await race(rejected.body.race.id);
  check("a leg with a Rejected run did not finish, whatever it scored", r.result === "invitee" && r.by_forfeit === true);
}

/* ------------------------------------------------------------------------------- */
console.log("\n── nothing is rated ─────────────────────────────");
check("no rating and no rating history moved", (await snapshotRatings(db)) === ratingsBefore);
check("every race match is unrated", (await db.query<any>(
  "select count(*)::int as n from matches m join races r on m.id in (r.inviter_match_id, r.invitee_match_id) where m.rated")).rows[0].n === 0);

console.log(failed() === 0 ? "\nOK: races hold against the real schema and handlers" : `\n${failed()} check(s) failed`);
await db.close();
if (failed() > 0) process.exit(1);
