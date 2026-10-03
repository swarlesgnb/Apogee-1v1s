/**
 * Open challenges by code: create one, look one up, answer one, take one back, list yours.
 *
 * An open challenge is a duel with a code instead of a named opponent (migration
 * 20261003000024, src/core/social/openDuel.ts). The challenger plays first, exactly as a
 * named duel's sender does: `create` makes the same seeding match send-duel makes and a
 * `duels` row carrying a fresh code. Anyone signed in with the code can then `view` it and
 * `accept` it, each answer building its own two-sided match against the challenger's
 * frozen side, the way answer-duel builds one.
 *
 * EVERY ANSWER IS UNRATED. An open link invites answering with an alt account and losing on
 * purpose, so the match `accept` creates has `rated = false` (the path tournament fixtures
 * take), settle-match skips every rating write for it, find-match never draws its sides,
 * and the open_duel_answers trigger refuses to record an answer against a rated match.
 * The challenger's own seeding match is an ordinary one: it is rated only in the sense that
 * every seeding match is (it rates nothing, and its run set joins the pool).
 *
 * WHAT THE ANSWERER CANNOT SEE: the challenger's score, for the reason PLAN.md §6 gives.
 * `view` says whether the challenge can be answered, never how the challenger did.
 *
 * Kept out of send-duel and answer-duel on purpose. Those are the named, rated duel and
 * their rules are unchanged; the match-building below mirrors them and says so where it does.
 */

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  forfeitMatch,
  handler,
  INITIAL_TTL_MS,
  isOffPool,
  json,
  loadSeasonPool,
  readJson,
  requireCaller,
  requireEligible,
  sweepStaleMatches,
  HttpError,
  type Caller,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { selectScenarios } from "../../../src/core/match/scenarioSelection.ts";
import { ANY_CATEGORY } from "../../../src/core/match/matchmaking.ts";
import { updateRating, winProbability } from "../../../src/core/rating/glicko2.ts";
import {
  canAnswerOpenDuel,
  isOpenDuelCode,
  mintCode,
  openDuelView,
  OPEN_DUEL_REFUSAL,
  OPEN_DUEL_TTL_MS,
  type OpenDuelFacts,
  type OpenDuelStatus,
} from "../../../src/core/social/openDuel.ts";

type SupabaseAdmin = SupabaseClient;

interface Body {
  action?: unknown;
  code?: unknown;
  category?: unknown;
  window?: unknown;
}

interface DuelRow {
  id: string;
  challenger_id: string;
  match_id: string;
  status: OpenDuelStatus;
  expires_at: string;
  code: string;
}

/** A code as sent: eight letters of the alphabet, case forgiven, nothing else. */
function readCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!isOpenDuelCode(code)) throw new HttpError(400, "That is not a challenge code: eight letters and digits, with no 0, O, 1, I or L.");
  return code;
}

async function duelByCode(admin: SupabaseAdmin, code: string): Promise<DuelRow> {
  const { data, error } = await admin
    .from("duels")
    .select("id, challenger_id, match_id, status, expires_at, code")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "There is no open challenge with that code.");
  return data as DuelRow;
}

/** Everything `canAnswerOpenDuel` needs, read fresh. */
async function factsFor(admin: SupabaseAdmin, row: DuelRow, callerId: string) {
  const [{ data: side, error: sideError }, { data: match, error: matchError }, answers, mine] = await Promise.all([
    admin
      .from("match_sides")
      .select("player_id, deltas, match_score, provisional, rating_before, rd_before, submitted_at")
      .eq("match_id", row.match_id)
      .eq("player_id", row.challenger_id)
      .maybeSingle(),
    admin
      .from("matches")
      .select("status, category, difficulty, window_index, scenario_ids, benchmark_name")
      .eq("id", row.match_id)
      .maybeSingle(),
    admin.from("open_duel_answers").select("player_id", { count: "exact", head: true }).eq("duel_id", row.id),
    admin.from("open_duel_answers").select("match_id").eq("duel_id", row.id).eq("player_id", callerId).maybeSingle(),
  ]);
  if (sideError) throw new HttpError(500, sideError.message);
  if (matchError) throw new HttpError(500, matchError.message);
  if (answers.error) throw new HttpError(500, answers.error.message);
  if (mine.error) throw new HttpError(500, mine.error.message);
  if (!match || !side) throw new HttpError(410, "That challenge's match is gone.");
  const facts: OpenDuelFacts = {
    challengerId: row.challenger_id,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    ready: side.match_score != null,
    challengerMatchVoid: match.status === "void",
    answers: answers.count ?? 0,
    alreadyAnswered: !!mine.data,
  };
  return { facts, side, match };
}

/** The same shape find-match returns, so the client adopts it through the path it has. */
function foundMatch(m: {
  matchId: string;
  category: string;
  difficulty: string;
  expiresAt: string;
  scenarios: { id: number; name: string }[];
  opponent: unknown;
  seeding: boolean;
  winProbability: number | null;
  duel: Record<string, unknown>;
}) {
  return { ...m, poolSize: null };
}

async function scenarioNames(admin: SupabaseAdmin, ids: number[]): Promise<Map<number, string>> {
  const { data } = await admin.from("scenarios").select("id, name").in("id", ids);
  return new Map((data ?? []).map((s: { id: number; name: string }) => [s.id, s.name]));
}

// ---- create ------------------------------------------------------------------------
// send-duel's seeding match, with a code where the opponent would be.
async function create(admin: SupabaseAdmin, caller: Caller, body: Body) {
  const category = body.category;
  if (typeof category !== "string" || !category || category.length > 40) throw new HttpError(400, "category is required");
  if (typeof body.window !== "number" || !Number.isInteger(body.window) || body.window < 0 || body.window > 15) {
    throw new HttpError(400, "window is required");
  }
  // "Any" is not a duel, for send-duel's reason: an unanswered one would be filed where only
  // another wildcard queue can draw it.
  if (category === ANY_CATEGORY) throw new HttpError(400, "pick a category to challenge in");

  const live = await sweepStaleMatches(admin, caller.playerId, updateRating);
  if (live) throw new HttpError(409, "finish or abandon your current match before posting a challenge");

  // The challenger's three are an ordinary seeding match that joins the pool, so the
  // challenger meets the queue's bar, as a named duel's sender does.
  await requireEligible(admin, caller.playerId);

  const { season, windowName, selectable } = await loadSeasonPool(admin, body.window);
  const seed = crypto.randomUUID();
  const chosen = selectScenarios(selectable, seed, { category });
  if (chosen.length === 0) throw new HttpError(404, `${windowName} has no ${category} scenarios`);
  const scenarioIds = chosen.map((s) => s.id);
  const expiresAt = new Date(Date.now() + INITIAL_TTL_MS).toISOString();

  const { data: match, error: matchError } = await admin
    .from("matches")
    .insert({
      mode: "async",
      category,
      benchmark_name: season.name,
      difficulty: windowName,
      window_index: body.window,
      seed,
      scenario_ids: scenarioIds,
      status: "awaiting_runs",
      expires_at: expiresAt,
    })
    .select("id")
    .maybeSingle();
  if (matchError || !match) throw new HttpError(500, matchError?.message ?? "could not create the challenge's match");

  const { data: rating } = await admin.from("ratings").select("rating, rd").eq("player_id", caller.playerId).maybeSingle();
  const { error: sideError } = await admin.from("match_sides").insert({
    match_id: match.id,
    player_id: caller.playerId,
    rating_before: Number(rating?.rating ?? 1500),
    rd_before: Number(rating?.rd ?? 350),
  });
  if (sideError) throw new HttpError(500, sideError.message);

  let duel: { id: string; code: string } | null = null;
  for (let attempt = 0; !duel && attempt < 4; attempt++) {
    const code = mintCode(crypto.getRandomValues(new Uint8Array(8)));
    const { data, error } = await admin
      .from("duels")
      .insert({
        challenger_id: caller.playerId,
        challenged_id: null,
        code,
        match_id: match.id,
        expires_at: new Date(Date.now() + OPEN_DUEL_TTL_MS).toISOString(),
      })
      .select("id, code")
      .maybeSingle();
    if (data) duel = data as { id: string; code: string };
    // A code collision is the only conflict worth another try.
    else if (error?.code !== "23505") throw new HttpError(500, error?.message ?? "could not post the challenge");
  }
  if (!duel) throw new HttpError(500, "could not mint a challenge code");

  const byId = new Map(selectable.map((s) => [s.id, s.name]));
  return foundMatch({
    matchId: match.id,
    category,
    difficulty: windowName,
    expiresAt,
    scenarios: scenarioIds.map((id) => ({ id, name: byId.get(id) ?? `scenario ${id}` })),
    opponent: null,
    seeding: true,
    winProbability: null,
    duel: { id: duel.id, code: duel.code, open: true },
  });
}

// ---- view --------------------------------------------------------------------------
async function view(admin: SupabaseAdmin, caller: Caller, body: Body) {
  const code = readCode(body.code);
  const row = await duelByCode(admin, code);
  const { facts, match } = await factsFor(admin, row, caller.playerId);
  const { data: sender } = await admin.from("players").select("display_name").eq("id", row.challenger_id).maybeSingle();
  return openDuelView({
    code,
    senderName: sender?.display_name ?? null,
    category: String(match.category ?? ""),
    band: String(match.difficulty ?? ""),
    facts,
    callerId: caller.playerId,
    now: new Date(),
  });
}

// ---- accept ------------------------------------------------------------------------
// answer-duel's accept, unrated, once per answering player.
async function accept(admin: SupabaseAdmin, caller: Caller, body: Body) {
  const code = readCode(body.code);
  const row = await duelByCode(admin, code);
  const { facts, side, match } = await factsFor(admin, row, caller.playerId);
  const verdict = canAnswerOpenDuel(facts, caller.playerId, new Date());
  if (!verdict.ok) {
    const r = OPEN_DUEL_REFUSAL[verdict.refusal];
    throw new HttpError(r.status, r.message);
  }

  // One match at a time, the queue's rule.
  const live = await sweepStaleMatches(admin, caller.playerId, updateRating);
  if (live) throw new HttpError(409, "finish or abandon your current match before answering a challenge");

  // Posted before the pool was rebuilt: nothing to launch any more. Closed for good.
  if (await isOffPool(admin, match.scenario_ids, match.window_index)) {
    await admin.from("duels").update({ status: "expired" }).eq("id", row.id).eq("status", "open");
    throw new HttpError(410, "That challenge was posted on scenarios this season no longer has.");
  }

  const { data: myRating } = await admin.from("ratings").select("rating, rd").eq("player_id", caller.playerId).maybeSingle();
  const expiresAt = new Date(Date.now() + INITIAL_TTL_MS).toISOString();
  const { data: created, error: matchError } = await admin
    .from("matches")
    .insert({
      mode: "async",
      category: match.category,
      benchmark_name: match.benchmark_name,
      difficulty: match.difficulty,
      window_index: match.window_index,
      seed: crypto.randomUUID(),
      scenario_ids: match.scenario_ids,
      status: "awaiting_runs",
      expires_at: expiresAt,
      // The whole point: an open link can be answered by an alt, so nothing here is rated.
      rated: false,
    })
    .select("id")
    .maybeSingle();
  if (matchError || !created) throw new HttpError(500, matchError?.message ?? "could not create the match");

  const undo = async () => {
    await admin.from("matches").delete().eq("id", created.id);
  };

  const { error: sidesError } = await admin.from("match_sides").insert([
    {
      match_id: created.id,
      player_id: caller.playerId,
      rating_before: Number(myRating?.rating ?? 1500),
      rd_before: Number(myRating?.rd ?? 350),
    },
    {
      match_id: created.id,
      player_id: row.challenger_id,
      deltas: side.deltas,
      match_score: side.match_score,
      provisional: side.provisional,
      rating_before: side.rating_before,
      rd_before: side.rd_before,
      submitted_at: side.submitted_at,
    },
  ], { defaultToNull: false });
  if (sidesError) {
    await undo();
    throw new HttpError(500, sidesError.message);
  }

  // Recorded last. The primary key is the "once per player" rule, decided by the database,
  // so two clicks racing get one match between them and the loser's is removed.
  const { error: answerError } = await admin
    .from("open_duel_answers")
    .insert({ duel_id: row.id, player_id: caller.playerId, match_id: created.id });
  if (answerError) {
    await undo();
    if (answerError.code === "23505") throw new HttpError(409, OPEN_DUEL_REFUSAL.answered.message);
    throw new HttpError(500, answerError.message);
  }

  const names = await scenarioNames(admin, match.scenario_ids ?? []);
  const { data: challenger } = await admin.from("players").select("display_name").eq("id", row.challenger_id).maybeSingle();
  const mine = { rating: Number(myRating?.rating ?? 1500), rd: Number(myRating?.rd ?? 350), volatility: 0.06 };
  const theirs = { rating: Number(side.rating_before ?? 1500), rd: Number(side.rd_before ?? 350), volatility: 0.06 };
  return foundMatch({
    matchId: created.id,
    category: match.category,
    difficulty: match.difficulty,
    expiresAt,
    scenarios: (match.scenario_ids ?? []).map((id: number) => ({ id, name: names.get(id) ?? `scenario ${id}` })),
    opponent: {
      displayName: challenger?.display_name ?? "player",
      rating: Math.round(theirs.rating),
      playedAt: side.submitted_at,
      provisional: !!side.provisional,
    },
    seeding: false,
    winProbability: winProbability(mine, theirs),
    duel: { id: row.id, code, open: true, from: challenger?.display_name ?? "player", unrated: true },
  });
}

// ---- cancel ------------------------------------------------------------------------
// answer-duel's take-back: an unplayed challenge's empty match is voided with it.
async function cancel(admin: SupabaseAdmin, caller: Caller, body: Body) {
  const code = readCode(body.code);
  const row = await duelByCode(admin, code);
  if (row.challenger_id !== caller.playerId) throw new HttpError(403, "only the player who posted a challenge can take it back");
  const { data: cancelled } = await admin
    .from("duels")
    .update({ status: "cancelled", answered_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  if (!cancelled) throw new HttpError(409, "that challenge is already closed");
  const { data: side } = await admin
    .from("match_sides")
    .select("match_score")
    .eq("match_id", row.match_id)
    .eq("player_id", caller.playerId)
    .maybeSingle();
  if (side && side.match_score == null) {
    await forfeitMatch(admin, row.match_id, caller.playerId, updateRating);
    return { ok: true, status: "cancelled", matchVoided: row.match_id };
  }
  return { ok: true, status: "cancelled" };
}

// ---- mine --------------------------------------------------------------------------
// Your recent open challenges and how the answers went, from the answerers' sides.
async function mine(admin: SupabaseAdmin, caller: Caller) {
  const { data: rows, error } = await admin
    .from("duels")
    .select("id, code, match_id, status, created_at, expires_at")
    .eq("challenger_id", caller.playerId)
    .not("code", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new HttpError(500, error.message);
  const duels = (rows ?? []) as (DuelRow & { created_at: string })[];
  if (duels.length === 0) return { challenges: [] };

  const [{ data: matches }, { data: sides }, { data: answers }] = await Promise.all([
    admin.from("matches").select("id, category, difficulty").in("id", duels.map((d) => d.match_id)),
    admin.from("match_sides").select("match_id, match_score").eq("player_id", caller.playerId).in("match_id", duels.map((d) => d.match_id)),
    admin.from("open_duel_answers").select("duel_id, player_id, match_id").in("duel_id", duels.map((d) => d.id)),
  ]);
  const answerMatchIds = (answers ?? []).map((a: { match_id: string }) => a.match_id);
  const { data: answerSides } = answerMatchIds.length
    ? await admin.from("match_sides").select("match_id, player_id, result").in("match_id", answerMatchIds)
    : { data: [] as { match_id: string; player_id: string; result: string | null }[] };
  const matchById = new Map((matches ?? []).map((m: { id: string; category: string; difficulty: string }) => [m.id, m]));
  const playedById = new Map((sides ?? []).map((s: { match_id: string; match_score: number | null }) => [s.match_id, s.match_score != null]));
  const now = new Date();

  return {
    challenges: duels.map((d) => {
      const mine = (answers ?? []).filter((a: { duel_id: string }) => a.duel_id === d.id);
      // The answerer's own result says how it went; the challenger's copied side carries none
      // in an unrated match, so a win for them is a loss for you and the reverse.
      const results = mine.map((a: { match_id: string; player_id: string }) =>
        (answerSides ?? []).find((s: { match_id: string; player_id: string }) => s.match_id === a.match_id && s.player_id === a.player_id)?.result ?? null);
      const m = matchById.get(d.match_id);
      return {
        code: d.code,
        status: d.status === "open" && new Date(d.expires_at) <= now ? "expired" : d.status,
        category: m?.category ?? "",
        band: m?.difficulty ?? "",
        played: playedById.get(d.match_id) ?? false,
        createdAt: d.created_at,
        expiresAt: d.expires_at,
        answers: mine.length,
        beatYou: results.filter((r: string | null) => r === "win").length,
        youBeat: results.filter((r: string | null) => r === "loss").length,
        drawn: results.filter((r: string | null) => r === "draw").length,
      };
    }),
  };
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "open-duel");
  const body = await readJson<Body>(req);
  switch (body?.action) {
    case "create":
      return json(await create(admin, caller, body));
    case "view":
      return json(await view(admin, caller, body));
    case "accept":
      return json(await accept(admin, caller, body));
    case "cancel":
      return json(await cancel(admin, caller, body));
    case "mine":
      return json(await mine(admin, caller));
    default:
      throw new HttpError(400, "unknown action");
  }
}));
