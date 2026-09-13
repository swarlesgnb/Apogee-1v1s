/**
 * The tournament list, and one tournament in full.
 *
 * A function rather than a select for the reason list-duels is: the tables are closed to
 * clients, names live in an owner-only `players`, and what anybody sees about another
 * player is the server's decision. What comes back is `view.ts`, which carries no score,
 * delta, baseline or rating at all.
 *
 * It also writes, a little, and on purpose. Before reading it folds any finished legs into
 * the tournaments the caller is looking at (see `reconcile`), so a result the opponent just
 * produced is on the bracket the moment somebody looks, with nothing running on a timer.
 */

import { handler, json, readJson, requireCaller } from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  legsFor,
  loadTournament,
  namesFor,
  normaliseRow,
  onlyFields,
  reconcile,
  requireUuid,
  TOURNAMENT_COLUMNS,
  type TournamentRow,
} from "../_shared/tournament.ts";

import { buildSummary, buildView, type TournamentSummary } from "../../../src/core/tournament/view.ts";

/** How long a finished tournament stays in the list. Long enough to see who won. */
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

/** A room, not a directory, the same as the duel roster. */
const LIST_LIMIT = 40;

/** How many of the caller's own tournaments to bring up to date on the way in. */
const RECONCILE_LIMIT = 12;

const PHASE_ORDER: Record<string, number> = { groups: 0, playoffs: 0, registration: 1, completed: 2, cancelled: 3 };

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "list-tournaments");

  const body = await readJson<Record<string, unknown>>(req);
  onlyFields(body, ["tournamentId"]);
  const selected = body.tournamentId === undefined || body.tournamentId === null
    ? null
    : requireUuid(body.tournamentId, "tournamentId");

  const { data: memberships } = await admin
    .from("tournament_members")
    .select("tournament_id")
    .eq("player_id", caller.playerId)
    .limit(RECONCILE_LIMIT);

  const { data: hosting } = await admin
    .from("tournaments")
    .select("id")
    .eq("host_id", caller.playerId)
    .in("phase", ["groups", "playoffs"]);

  const toReconcile = new Set<string>([
    ...(memberships ?? []).map((m: any) => m.tournament_id),
    ...(hosting ?? []).map((t: any) => t.id),
    ...(selected ? [selected] : []),
  ]);
  for (const id of toReconcile) {
    try {
      await reconcile(admin, id);
    } catch (err) {
      // Reading a slightly stale bracket beats failing to read it at all.
      console.error(`could not reconcile tournament ${id}:`, err);
    }
  }

  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const { data: rawRows, error } = await admin
    .from("tournaments")
    .select(TOURNAMENT_COLUMNS)
    .or(`phase.in.(registration,groups,playoffs),updated_at.gte.${since}`)
    .order("updated_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(error.message);

  const rows: TournamentRow[] = (rawRows ?? []).map(normaliseRow);
  if (selected && !rows.some((r) => r.id === selected)) rows.push(await loadTournament(admin, selected));

  const playing = rows.filter((r) => r.phase === "groups" || r.phase === "playoffs").map((r) => r.id);
  const [legs, hosts] = await Promise.all([
    legsFor(admin, playing),
    namesFor(admin, rows.map((r) => r.host_id)),
  ]);

  const inputFor = (row: TournamentRow) => ({
    state: row.state,
    hostId: row.host_id,
    hostName: hosts.get(row.host_id) ?? "host",
    viewerId: caller.playerId,
    category: row.category,
    windowName: row.window_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    legs: legs.get(row.id) ?? [],
  });

  const tournaments: TournamentSummary[] = rows
    .filter((r) => r.id !== selected || r.phase === "registration" || r.phase === "groups" ||
      r.phase === "playoffs" || new Date(r.updated_at).getTime() >= Date.parse(since))
    .map((row) => buildSummary(inputFor(row)))
    .sort((a, b) =>
      Number(b.yourTurn) - Number(a.yourTurn) ||
      Number(b.entered || b.hostedByYou) - Number(a.entered || a.hostedByYou) ||
      (PHASE_ORDER[a.phase] ?? 9) - (PHASE_ORDER[b.phase] ?? 9) ||
      b.updatedAt.localeCompare(a.updatedAt));

  const row = selected ? rows.find((r) => r.id === selected)! : null;

  return json({
    tournaments,
    view: row ? buildView(inputFor(row)) : null,
  });
}));
