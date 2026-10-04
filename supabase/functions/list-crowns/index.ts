/**
 * The Crowns board: every category and band of the live season, who holds each Crown, the
 * bar to beat, how long they have held it and how many people failed to take it. Plus the
 * caller's own notices ("You lost the Precise Tracking Crown to X after 3 defences"), which
 * is the comeback loop, and a way to mark them read.
 *
 * WORK DONE ON THE WAY IN
 *
 * Nothing runs on a timer, so nothing can quietly stop running: the idiom list-duels and
 * the tournament reconcile already use. Each request first lapses reigns past the cap,
 * ends challenges whose clock ran out (through forfeitMatch, the ordinary rule, which ends
 * the match and so lets the trigger decide the challenge), and resets any Crown whose
 * scenarios the season no longer has. Then it reads.
 *
 * WHAT IT MAY BE TOLD
 *
 * `seen`: ids of the caller's own notices to mark read. Scoped to the caller in the
 * update, so naming somebody else's notice marks nothing.
 */

import { forfeitMatch, handler, HttpError, json, readJson, requireCaller } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { namesFor, onlyFields, requireId, scenarioNamesFor, seasonCells } from "../_shared/arena.ts";

import { updateRating } from "../../../src/core/rating/glicko2.ts";
import { CHALLENGE_COOLDOWN_MS, REIGN_CAP_MS, type RunTier } from "../../../src/core/crowns/crowns.ts";
import {
  buildBoard,
  crownKey,
  type BoardHistoryRow,
  type BoardNoticeRow,
  type BoardRow,
} from "../../../src/core/crowns/view.ts";
import type { NoticeKind } from "../../../src/core/crowns/crowns.ts";

/** Expired challenges ended per request. A backlog larger than this drains over a few looks. */
const SWEEP_LIMIT = 20;
/** Ended reigns read for the board's history column. Five per Crown is shown. */
const HISTORY_READ = 200;
/** Unread notices returned. Older ones stay unread until these are. */
const NOTICES_READ = 20;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "list-crowns");

  const body = onlyFields(await readJson<unknown>(req).catch(() => ({})), ["seen"]);
  const seen = body.seen == null ? [] : body.seen;
  if (!Array.isArray(seen) || seen.length > 50) throw new HttpError(400, "seen must be a list of at most 50 ids");
  const seenIds = seen.map((id) => requireId(id, "seen"));

  // ---- reconcile ------------------------------------------------------------------
  const lapse = await admin.rpc("crown_lapse_all", { p_cap_seconds: Math.round(REIGN_CAP_MS / 1000) });
  if (lapse.error) throw new HttpError(500, lapse.error.message);

  const { data: open, error: openError } = await admin
    .from("crown_challenges")
    .select("match_id, challenger_id")
    .is("decided_at", null)
    .order("created_at", { ascending: true })
    .limit(200);
  if (openError) throw new HttpError(500, openError.message);
  const openIds = (open ?? []).map((c: any) => c.match_id);
  const { data: openMatches } = openIds.length
    ? await admin.from("matches").select("id, status, expires_at").in("id", openIds)
    : { data: [] as any[] };
  const matchById = new Map((openMatches ?? []).map((m: any) => [m.id, m]));
  let swept = 0;
  for (const c of open ?? []) {
    const m: any = matchById.get(c.match_id);
    if (!m) continue;
    if ((m.status === "open" || m.status === "awaiting_runs") && m.expires_at && ms(m.expires_at) < Date.now()) {
      if (swept++ >= SWEEP_LIMIT) break;
      await forfeitMatch(admin, c.match_id, c.challenger_id, updateRating);
    } else if (m.status === "settled" || m.status === "void") {
      // Ended without being decided: only possible if the match ended before the trigger
      // existed. Decided now, by the same function.
      await admin.rpc("crown_resolve", { p_match_id: c.match_id });
    }
  }

  const { season, bands, pools, cells } = await seasonCells(admin);

  const { data: crownRows, error: crownError } = await admin
    .from("crowns")
    .select("category, window_index, cycle, scenario_ids, reign_id");
  if (crownError) throw new HttpError(500, crownError.message);
  for (const row of crownRows ?? []) {
    if (!row.scenario_ids) continue;
    const pool = new Set((pools.get(Number(row.window_index)) ?? []).map((s) => s.id));
    if (!(row.scenario_ids as number[]).every((id) => pool.has(Number(id)))) {
      await admin.rpc("crown_reset_off_pool", { p_category: row.category, p_window: row.window_index, p_cycle: row.cycle });
    }
  }

  if (seenIds.length > 0) {
    const { error } = await admin
      .from("crown_notices")
      .update({ seen_at: new Date().toISOString() })
      .eq("player_id", caller.playerId)
      .in("id", seenIds)
      .is("seen_at", null);
    if (error) throw new HttpError(500, error.message);
  }

  // ---- read -----------------------------------------------------------------------
  const [crownsNow, reignsLive, history, mine, notices, liveChallenges, sides] = await Promise.all([
    admin.from("crowns").select("category, window_index, cycle, scenario_ids, reign_id"),
    admin
      .from("crown_reigns")
      .select("id, category, window_index, holder_id, match_score, started_at, defences, challenges, lowest_tier, provisional")
      .is("ended_at", null),
    admin
      .from("crown_reigns")
      .select("category, window_index, holder_id, started_at, ended_at, defences, end_reason, ended_by, match_score")
      .not("ended_at", "is", null)
      .order("ended_at", { ascending: false })
      .limit(HISTORY_READ),
    admin
      .from("crown_challenges")
      .select("match_id, category, window_index, created_at, decided_at")
      .eq("challenger_id", caller.playerId)
      .gte("created_at", new Date(Date.now() - CHALLENGE_COOLDOWN_MS).toISOString())
      .order("created_at", { ascending: false }),
    admin
      .from("crown_notices")
      .select("id, kind, category, window_index, defences, reign_seconds, other_name, created_at")
      .eq("player_id", caller.playerId)
      .is("seen_at", null)
      .order("created_at", { ascending: false })
      .limit(NOTICES_READ),
    admin.from("crown_challenges").select("match_id, category, window_index, challenger_id").is("decided_at", null),
    admin.from("match_sides").select("match_id, submitted_at").eq("player_id", caller.playerId).is("submitted_at", null),
  ]);
  for (const r of [crownsNow, reignsLive, history, mine, notices, liveChallenges, sides]) {
    if (r.error) throw new HttpError(500, r.error.message);
  }

  // Which undecided challenges are actually being played, and is the caller in a match?
  const sideIds = (sides.data ?? []).map((s: any) => s.match_id);
  const pendingIds = [...new Set([...(liveChallenges.data ?? []).map((c: any) => c.match_id), ...sideIds])];
  const { data: pendingMatches } = pendingIds.length
    ? await admin.from("matches").select("id, status, expires_at").in("id", pendingIds)
    : { data: [] as any[] };
  const live = new Set(
    (pendingMatches ?? [])
      .filter((m: any) => (m.status === "open" || m.status === "awaiting_runs") && (!m.expires_at || ms(m.expires_at) > Date.now()))
      .map((m: any) => m.id),
  );

  const reignById = new Map((reignsLive.data ?? []).map((r: any) => [r.id, r]));
  const liveCount = new Map<string, number>();
  let openChallenge: { key: string; matchId: string } | null = null;
  for (const c of liveChallenges.data ?? []) {
    if (!live.has(c.match_id)) continue;
    const key = crownKey(c.category, Number(c.window_index));
    liveCount.set(key, (liveCount.get(key) ?? 0) + 1);
    if (c.challenger_id === caller.playerId) openChallenge = { key, matchId: c.match_id };
  }
  const viewerBusy = sideIds.some((id: string) => live.has(id) && id !== openChallenge?.matchId);

  const rows: BoardRow[] = (crownsNow.data ?? []).map((c: any) => {
    const r: any = c.reign_id ? reignById.get(c.reign_id) : null;
    return {
      category: c.category,
      window: Number(c.window_index),
      cycle: Number(c.cycle),
      scenarioIds: c.scenario_ids ? (c.scenario_ids as number[]).map(Number) : null,
      live: liveCount.get(crownKey(c.category, Number(c.window_index))) ?? 0,
      reign: r
        ? {
            id: r.id,
            holderId: r.holder_id,
            matchScore: Number(r.match_score),
            startedAt: ms(r.started_at),
            defences: Number(r.defences),
            challenges: Number(r.challenges),
            lowestTier: r.lowest_tier as RunTier,
            provisional: !!r.provisional,
          }
        : null,
    };
  });

  const historyRows: BoardHistoryRow[] = (history.data ?? []).map((h: any) => ({
    category: h.category,
    window: Number(h.window_index),
    holderId: h.holder_id,
    startedAt: ms(h.started_at),
    endedAt: ms(h.ended_at),
    defences: Number(h.defences),
    endReason: h.end_reason,
    endedBy: h.ended_by,
    matchScore: Number(h.match_score),
  }));

  const lastChallenge = new Map<string, number>();
  for (const c of mine.data ?? []) {
    const key = crownKey(c.category, Number(c.window_index));
    if (!lastChallenge.has(key)) lastChallenge.set(key, ms(c.created_at));
  }

  const noticeRows: BoardNoticeRow[] = (notices.data ?? []).map((n: any) => ({
    id: n.id,
    kind: n.kind as NoticeKind,
    category: n.category,
    window: Number(n.window_index),
    defences: Number(n.defences),
    reignMs: Number(n.reign_seconds) * 1000,
    otherName: n.other_name ?? null,
    createdAt: ms(n.created_at),
  }));

  const names = await namesFor(admin, [
    ...rows.map((r) => r.reign?.holderId),
    ...historyRows.map((h) => h.holderId),
    ...historyRows.map((h) => h.endedBy),
  ]);
  const scenarioNames = await scenarioNamesFor(admin, rows.flatMap((r) => r.scenarioIds ?? []));

  return json(buildBoard({
    season,
    bands,
    cells,
    rows,
    history: historyRows,
    names,
    scenarioNames,
    viewerId: caller.playerId,
    now: Date.now(),
    lastChallenge,
    openChallenge,
    viewerBusy,
    notices: noticeRows,
  }));
}));
