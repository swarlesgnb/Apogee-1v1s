/**
 * Everything a player or a host does to a tournament that is not playing a fixture:
 * create, enter, leave, check in, remove an entrant, start, cancel.
 *
 * WHAT A REQUEST MAY SAY
 *
 * Which action, which tournament, and the one or two plain fields that action takes. The
 * player is the verified token, never a body field. Any other field is refused outright,
 * so a body naming a winner, an outcome, a score, a seed, a phase or a whole replacement
 * state is a 400, not a request that half works. There is deliberately no action that
 * records a result: results come from settled matches, through `reconcile`, and nothing
 * else.
 *
 * WHO MAY DO WHAT
 *
 *   anybody signed in     create one (if they could queue), look
 *   anybody who could queue   enter, leave, check themselves in or out
 *   the host              remove an entrant, start, cancel
 *
 * "Could queue" is `requireEligible`, the same bar as the ladder: every fixture is an
 * ordinary match, so entering is agreeing to play them.
 */

import {
  handler,
  HttpError,
  json,
  loadSeasonPool,
  readJson,
  requireCaller,
  requireEligible,
  type Caller,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import {
  mutate,
  normaliseRow,
  onlyFields,
  refusal,
  requireUuid,
  TOURNAMENT_COLUMNS,
  viewFor,
  type TournamentRow,
} from "../_shared/tournament.ts";

import {
  addEntrant,
  assignSeeds,
  cancelTournament,
  createTournament,
  removeEntrant,
  setCheckIn,
  startTournament,
} from "../../../src/core/tournament/tournament.ts";
import type { Tournament } from "../../../src/core/tournament/types.ts";
import {
  cleanDisplayName,
  cleanText,
  MAX_CANCEL_REASON,
  MAX_TOURNAMENT_NAME,
  nextFreeSeed,
} from "../../../src/core/tournament/policy.ts";
import { matchesCategory } from "../../../src/core/match/scenarioSelection.ts";
import { ANY_CATEGORY } from "../../../src/core/match/matchmaking.ts";

/** The fields each action takes, beyond `action` itself. Anything else is refused. */
const FIELDS: Record<string, readonly string[]> = {
  create: ["name", "category", "window", "groupCount", "groupSize", "qualifiers", "seeding"],
  join: ["tournamentId"],
  leave: ["tournamentId"],
  "check-in": ["tournamentId", "checkedIn"],
  remove: ["tournamentId", "playerId"],
  start: ["tournamentId", "revision"],
  cancel: ["tournamentId", "reason"],
};

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "tournament-action");

  const body = await readJson<Record<string, unknown>>(req);
  const action = typeof body?.action === "string" ? body.action : "";
  const fields = FIELDS[action];
  if (!fields) throw new HttpError(400, "unknown action");
  onlyFields(body, ["action", ...fields]);

  if (action === "create") return json({ ok: true, view: await create(admin, caller, body) });

  const tournamentId = requireUuid(body.tournamentId, "tournamentId");
  let row: TournamentRow;

  switch (action) {
    case "join": {
      await requireEligible(admin, caller.playerId);
      row = await mutate(admin, tournamentId, caller.playerId, ({ state }) => {
        if (state.entrants.some((e) => e.id === caller.playerId)) throw new HttpError(409, "You are already entered.");
        return {
          next: addEntrant(state, {
            id: caller.playerId,
            name: cleanDisplayName(caller.displayName),
            seed: nextFreeSeed(state),
            checkedIn: false,
          }),
          kind: "joined",
        };
      });
      break;
    }

    case "leave": {
      row = await mutate(admin, tournamentId, caller.playerId, ({ state }) => ({
        next: removeEntrant(state, caller.playerId),
        kind: "left",
      }));
      break;
    }

    case "check-in": {
      if (typeof body.checkedIn !== "boolean") throw new HttpError(400, "checkedIn must be true or false");
      const checkedIn = body.checkedIn;
      row = await mutate(admin, tournamentId, caller.playerId, ({ state }) => ({
        next: setCheckIn(state, caller.playerId, checkedIn),
        kind: checkedIn ? "checked-in" : "checked-out",
      }));
      break;
    }

    case "remove": {
      const playerId = requireUuid(body.playerId, "playerId");
      row = await mutate(admin, tournamentId, caller.playerId, (current) => {
        requireHost(current, caller);
        return { next: removeEntrant(current.state, playerId), kind: "removed", detail: { playerId } };
      });
      break;
    }

    case "start": {
      // The revision the host was looking at when they pressed Start. The warning about
      // who will be left out was drawn from that revision, so if anything has moved since,
      // the warning is out of date and so is the decision.
      if (typeof body.revision !== "number" || !Number.isSafeInteger(body.revision)) {
        throw new HttpError(400, "revision is required");
      }
      const seen = body.revision;

      // Read once, outside the retry loop. A rating that moves in the millisecond between
      // two attempts changes nothing worth a second query.
      const { data: current } = await admin.from("tournaments").select("state").eq("id", tournamentId).maybeSingle();
      const ids = ((current?.state as Tournament | undefined)?.entrants ?? []).map((e) => e.id);
      const { data: ratings } = ids.length
        ? await admin.from("ratings").select("player_id, rating").in("player_id", ids)
        : { data: [] as any[] };
      const ratingOf = new Map((ratings ?? []).map((r: any) => [r.player_id, Number(r.rating)]));

      row = await mutate(admin, tournamentId, caller.playerId, (fresh) => {
        requireHost(fresh, caller);
        if (fresh.revision !== seen) {
          throw new HttpError(409, "The roster changed since you looked. Check it again, then start.");
        }
        // Strongest first by ladder rating, entry order breaking ties. A tournament is
        // unrated, but the rating is still the best measure of who should not meet whom in
        // the first group, which is all a seed is for.
        const order = [...fresh.state.entrants]
          .sort((a, b) => (ratingOf.get(b.id) ?? 1500) - (ratingOf.get(a.id) ?? 1500) || a.seed - b.seed)
          .map((e) => e.id);
        const excluded = fresh.state.entrants.filter((e) => !e.checkedIn).length;
        return {
          next: startTournament(assignSeeds(fresh.state, order)),
          kind: "started",
          detail: { excluded, seeding: fresh.state.config.seeding },
        };
      });
      break;
    }

    case "cancel": {
      const reason = cleanText(body.reason, MAX_CANCEL_REASON);
      if (!reason) throw new HttpError(400, "Say why it is being cancelled.");
      row = await mutate(admin, tournamentId, caller.playerId, (current) => {
        requireHost(current, caller);
        return { next: cancelTournament(current.state, reason), kind: "cancelled" };
      });
      break;
    }

    default:
      throw new HttpError(400, "unknown action");
  }

  return json({ ok: true, view: await viewFor(admin, row, caller.playerId) });
}));

function requireHost(row: TournamentRow, caller: Caller): void {
  if (row.host_id !== caller.playerId) throw new HttpError(403, "Only the host can do that.");
}

async function create(admin: any, caller: Caller, body: Record<string, unknown>) {
  await enforceRateLimit(admin, caller.playerId, "tournament-create");
  await requireEligible(admin, caller.playerId);

  const name = cleanText(body.name, MAX_TOURNAMENT_NAME);
  if (!name) throw new HttpError(400, "Give it a name.");

  const groupCount = body.groupCount;
  const groupSize = body.groupSize;
  const qualifiers = body.qualifiers;
  const seeding = body.seeding;
  const window = body.window;
  const category = typeof body.category === "string" ? body.category : "";

  if (groupCount !== 2 && groupCount !== 4 && groupCount !== 8) throw new HttpError(400, "groupCount must be 2, 4 or 8");
  if (typeof groupSize !== "number" || !Number.isInteger(groupSize) || groupSize < 3 || groupSize > 8) {
    throw new HttpError(400, "groupSize must be 3 to 8");
  }
  if (qualifiers !== 1 && qualifiers !== 2) throw new HttpError(400, "qualifiers must be 1 or 2");
  if (seeding !== "seeded" && seeding !== "shuffle") throw new HttpError(400, "seeding must be seeded or shuffle");
  if (typeof window !== "number" || !Number.isInteger(window) || window < 0) throw new HttpError(400, "window is required");
  if (!category || category.length > 40) throw new HttpError(400, "category is required");

  // Checked against the season now rather than discovered at the first fixture: a
  // tournament whose category draws nothing would take entries and then be unplayable.
  const { windowName, selectable } = await loadSeasonPool(admin, window);
  if (category !== ANY_CATEGORY && !selectable.some((s) => matchesCategory(s, category))) {
    throw new HttpError(400, `${windowName} has no scenarios in ${category}.`);
  }

  const id = crypto.randomUUID();
  let state: Tournament;
  try {
    state = createTournament(id, {
      name,
      groupCount,
      groupSize,
      qualifiers,
      seeding,
      // Only read for a random draw, and generated here because a draw the host could seed
      // is a draw the host could pick.
      randomSeed: crypto.randomUUID(),
    });
  } catch (err) {
    throw refusal(err);
  }

  const { data, error } = await admin
    .from("tournaments")
    .insert({
      id,
      host_id: caller.playerId,
      name,
      category,
      window_index: window,
      window_name: windowName,
      phase: "registration",
      revision: 0,
      state,
    })
    .select(TOURNAMENT_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    // The partial unique index on host_id: one live tournament per host.
    if (error?.code === "23505") {
      throw new HttpError(409, "You already have a tournament running. Finish or cancel it first.");
    }
    throw new HttpError(500, error?.message ?? "could not create the tournament");
  }

  await admin.from("tournament_log").insert({ tournament_id: id, revision: 0, kind: "created", actor_id: caller.playerId });

  return viewFor(admin, normaliseRow(data), caller.playerId);
}
