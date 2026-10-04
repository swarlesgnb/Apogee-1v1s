/**
 * Everything the duel panel shows: your inbox, what you sent, who else plays, and your
 * shortlist.
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR SELECTS
 *
 * `duels` is readable by the two players it names, so the rows themselves are within
 * reach - but a row is two uuids, and a uuid is not a person. `players` has been
 * owner-only since 20260817000004 and the rule that replaced the old world-readable
 * policy is that anything a client sees about another player is a decision the server
 * makes. So the names come from here, joined under the service role, exactly as
 * `find-match` hands over an opponent's name and `apex-board` hands over a board.
 *
 * WHAT THIS HANDS OUT THAT NOTHING ELSE DOES, AND WHY
 *
 * A player id for somebody who is not the caller. `apex-board` deliberately withholds
 * exactly that - it marks the caller's own row with a flag rather than naming anybody,
 * "so there is no identifier here to correlate against anything".
 *
 * A duel has to be addressed, and the alternatives are worse. `display_name` is not
 * unique, is not indexed, and is re-upserted from Steam on every sign-in, so a duel sent
 * to a name would sometimes reach the wrong person and would break when somebody renamed.
 * `steam_id` is a real-world identity and is not ours to hand out. What is left is the
 * uuid, which is a random `auth.users.id`: it identifies nothing outside this system,
 * unlocks nothing - every table is closed to it by RLS - and is only useful as the
 * argument to `send-duel`.
 *
 * It is still a narrowing of the rule those two migrations set, and the honest way to
 * describe it is that this function enumerates the people who have played. That is the
 * feature: you cannot duel somebody you cannot find. It is right at the size this
 * launches at, and an opt-out belongs here before the roster is bigger than a room.
 *
 * The roster is gated on having actually played - a side with a score - so it is a list
 * of participants rather than a list of accounts, and signing in alone never puts anybody
 * on it. The one exception is the caller's own Steam friends (steamFriendIds below), who
 * are listed from their first sign-in: the caller's Steam account already knows them, so
 * listing them tells the caller nothing new about anybody.
 */

import {
  handler,
  json,
  requireCaller,
  HttpError,
} from "../_shared/apogee.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";

import { effectiveStatus, type Duel, type DuelStatus } from "../../../src/core/match/duels.ts";

/** How many players the picker lists. A room, not a directory. */
const ROSTER_LIMIT = 200;

/** How long a resolved duel stays in the sent list, so the sender learns what happened. */
const RESOLVED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const STEAM_API_KEY = Deno.env.get("STEAM_WEB_API_KEY") ?? "";
/** The board is read on sign-in and after every duel action; Steam must not hold it up. */
const STEAM_TIMEOUT_MS = 2500;
/** `.in()` goes into the query string, and a big friends list would outgrow it. */
const IN_CHUNK = 150;

interface Person {
  playerId: string;
  displayName: string;
  rating: number;
  provisional: boolean;
  lastPlayedAt: string | null;
  friend: boolean;
  /** On the caller's Steam friends list. */
  steamFriend: boolean;
}

/**
 * Whether Steam would say who the caller's friends are. "private" is the common case
 * that is nobody's fault: Steam only answers for a friends list set to public.
 */
type SteamFriendsState = "public" | "private" | "unavailable";

/**
 * The caller's Steam friends who have signed in to Apogee.
 *
 * WHY STEAM AND NOT A FRIENDS SYSTEM OF OUR OWN
 *
 * The roster below only lists people who have finished a match, so a friend who has just
 * installed is invisible, and the shortlist can only star somebody already visible. The
 * people a player wants to duel first are, overwhelmingly, the ones on their Steam list,
 * and steam-auth already holds the Web API key that can read it: no requests, no codes,
 * nothing to accept.
 *
 * WHAT IT HANDS OUT
 *
 * Nothing the roster did not already: a player id, a name and a rating, for somebody the
 * caller's own Steam account already names as a friend. Steam ids never leave the server.
 *
 * It never fails the board. A private list is a 401 from Steam, a missing key or a slow
 * Steam is "unavailable", and either way the roster is what it was before this existed.
 */
async function steamFriendIds(
  admin: any,
  callerId: string,
): Promise<{ ids: Set<string>; state: SteamFriendsState }> {
  const none = (state: SteamFriendsState) => ({ ids: new Set<string>(), state });
  if (!STEAM_API_KEY) return none("unavailable");

  const { data: me } = await admin.from("players").select("steam_id").eq("id", callerId).maybeSingle();
  if (!me?.steam_id) return none("unavailable");

  let steamIds: string[];
  try {
    const res = await fetch(
      "https://api.steampowered.com/ISteamUser/GetFriendList/v1/" +
        `?key=${STEAM_API_KEY}&steamid=${me.steam_id}&relationship=friend`,
      { signal: AbortSignal.timeout(STEAM_TIMEOUT_MS) },
    );
    if (res.status === 401 || res.status === 403) return none("private");
    if (!res.ok) return none("unavailable");
    const body = await res.json();
    steamIds = (body?.friendslist?.friends ?? [])
      .map((f: { steamid?: string }) => f.steamid)
      .filter((s: unknown): s is string => typeof s === "string" && /^7656\d{13}$/.test(s));
  } catch {
    return none("unavailable");
  }

  const ids = new Set<string>();
  for (let i = 0; i < steamIds.length; i += IN_CHUNK) {
    const { data } = await admin
      .from("players")
      .select("id")
      .in("steam_id", steamIds.slice(i, i + IN_CHUNK));
    for (const p of (data ?? []) as { id: string }[]) ids.add(p.id);
  }
  ids.delete(callerId);
  return { ids, state: "public" };
}

Deno.serve(handler(async (req, admin) => {
  const caller = await requireCaller(req, admin);
  await enforceRateLimit(admin, caller.playerId, "list-duels");

  const now = new Date();

  // ---- expire what has run out, before reading it --------------------------------
  //
  // Lazily, on read, and scoped to this caller's own rows. Nothing in this system runs
  // on a timer and this is not the place to start one: a sweep that only happens when
  // somebody looks is a sweep that cannot silently stop running, which is the failure a
  // cron has and this does not. The same idiom retires stale matches in find-match.
  await admin
    .from("duels")
    .update({ status: "expired", answered_at: now.toISOString() })
    .eq("status", "open")
    .lt("expires_at", now.toISOString())
    .or(`challenger_id.eq.${caller.playerId},challenged_id.eq.${caller.playerId}`);

  const { data: rows, error } = await admin
    .from("duels")
    .select(
      "id, challenger_id, challenged_id, match_id, answer_match_id, status, " +
        "created_at, expires_at, answered_at",
    )
    .or(`challenger_id.eq.${caller.playerId},challenged_id.eq.${caller.playerId}`)
    // Named duels only. An open challenge names nobody (migration 20261003000024) and is
    // listed by open-duel; here its null opponent would reach the roster lookup.
    .is("code", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new HttpError(500, error.message);

  const duels = rows ?? [];

  // Whether each challenger has finished playing, which is what says a duel is answerable.
  // Read off their side rather than stored, so it cannot disagree with the match.
  const senderMatchIds = duels.map((d: any) => d.match_id);
  const { data: senderSides } = senderMatchIds.length
    ? await admin
        .from("match_sides")
        .select("match_id, player_id, match_score")
        .in("match_id", senderMatchIds)
    : { data: [] as any[] };

  const scoreByMatchAndPlayer = new Map<string, number | null>(
    (senderSides ?? []).map((s: any) => [
      `${s.match_id}:${s.player_id}`,
      s.match_score == null ? null : Number(s.match_score),
    ]),
  );

  // Names and ratings for everybody named in a duel, plus the roster, in one pass.
  const partnerIds = new Set<string>();
  for (const d of duels) {
    partnerIds.add(d.challenger_id === caller.playerId ? d.challenged_id : d.challenger_id);
  }

  // ---- the roster: everybody who has actually played -----------------------------
  const { data: played } = await admin
    .from("match_sides")
    .select("player_id, submitted_at")
    .not("match_score", "is", null)
    .neq("player_id", caller.playerId)
    .order("submitted_at", { ascending: false })
    .limit(1000);

  const lastPlayed = new Map<string, string>();
  for (const s of (played ?? []) as { player_id: string; submitted_at: string }[]) {
    if (!lastPlayed.has(s.player_id)) lastPlayed.set(s.player_id, s.submitted_at);
  }

  const { data: friendRows } = await admin
    .from("friendships")
    .select("friend_id")
    .eq("player_id", caller.playerId);

  const friendIds = new Set((friendRows ?? []).map((f: any) => f.friend_id));

  const steam = await steamFriendIds(admin, caller.playerId);

  const everyone = new Set<string>([...lastPlayed.keys(), ...partnerIds, ...friendIds, ...steam.ids]);
  everyone.delete(caller.playerId);

  const ids = [...everyone];
  const { data: people } = ids.length
    ? await admin.from("players").select("id, display_name").in("id", ids)
    : { data: [] as any[] };
  const { data: ratings } = ids.length
    ? await admin.from("ratings").select("player_id, rating, rd").in("player_id", ids)
    : { data: [] as any[] };

  const nameById = new Map((people ?? []).map((p: any) => [p.id, p.display_name]));
  const ratingById = new Map((ratings ?? []).map((r: any) => [r.player_id, r]));

  const person = (id: string): Person => {
    const r = ratingById.get(id);
    return {
      playerId: id,
      displayName: nameById.get(id) ?? "player",
      rating: Math.round(Number(r?.rating ?? 1500)),
      // A high deviation means the rating has not settled, and a number presented without
      // that reads as more certain than it is.
      provisional: Number(r?.rd ?? 350) > 150,
      lastPlayedAt: lastPlayed.get(id) ?? null,
      friend: friendIds.has(id),
      steamFriend: steam.ids.has(id),
    };
  };

  const resolvedSince = now.getTime() - RESOLVED_WINDOW_MS;

  const incoming = duels
    .filter((d: any) => d.challenged_id === caller.playerId)
    .map((d: any) => {
      const shaped: Duel = {
        id: d.id,
        fromPlayer: d.challenger_id,
        toPlayer: d.challenged_id,
        status: d.status as DuelStatus,
        expiresAt: new Date(d.expires_at),
        challengerMatchScore: scoreByMatchAndPlayer.get(`${d.match_id}:${d.challenger_id}`) ?? null,
      };
      return {
        id: d.id,
        from: person(d.challenger_id),
        status: effectiveStatus(shaped, now),
        createdAt: d.created_at,
        expiresAt: d.expires_at,
        // Whether they have finished, never how they did. The score itself is not in this
        // payload and must not be: an answerer who could see it before deciding would be
        // picking the ones they expect to win.
        ready: shaped.challengerMatchScore !== null,
      };
    })
    .filter((d: any) => d.status === "open");

  const outgoing = duels
    .filter((d: any) => d.challenger_id === caller.playerId)
    .filter(
      (d: any) =>
        d.status === "open" ||
        (d.answered_at && new Date(d.answered_at).getTime() >= resolvedSince),
    )
    .map((d: any) => ({
      id: d.id,
      to: person(d.challenged_id),
      status: d.status as DuelStatus,
      createdAt: d.created_at,
      expiresAt: d.expires_at,
      answeredAt: d.answered_at,
      // Whether you have played your own three yet. A duel you sent and never played is
      // one nobody can answer, and saying so is the only way to know to go and play it.
      played: scoreByMatchAndPlayer.get(`${d.match_id}:${caller.playerId}`) != null,
    }));

  // Steam friends first, whether or not they have played: they are who the roster was
  // missing. In `roster` rather than a list of their own so a client from before this
  // shows them too, as ordinary rows.
  const roster = [...new Set([...steam.ids, ...lastPlayed.keys()])]
    .map(person)
    .sort(
      (a, b) =>
        Number(b.steamFriend) - Number(a.steamFriend) ||
        (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""),
    )
    .slice(0, ROSTER_LIMIT);

  return json({
    incoming,
    outgoing,
    roster,
    friends: [...friendIds].map(person),
    steamFriends: steam.state,
  });
}));
