/**
 * Ghost links: race somebody else's ghost by its code.
 *
 * A ghost card's share code (post-ghost mints it) doubles as an invitation: anyone with it
 * races the sender's three live runs as a ghost of their own. This is the growth loop in
 * docs/design/mechanics.md ("Follow-up 1"): the sender needs to be a player, the
 * recipient needs a library and a sign-in, and nothing either side does moves a rating.
 *
 * Scoring is ranked's (PLAN.md §3), not a raw-score race: each round is each side's delta
 * over its OWN baseline, and the bigger improvement takes it. The sender's baseline is the
 * one the server stored with their card; the recipient's is rebuilt here from the
 * recipient's own history, frozen at local midnight exactly as a past-self draw is. A
 * round the recipient has no baseline on is played and not scored (`measured: false`),
 * and a match with fewer than MIN_MEASURED_ROUNDS scored rounds is practice.
 *
 * Pure, like ghost.ts: the Edge Function (ghost-link) imports the lookup half, the app
 * imports the match half, and validateGhostLinks.ts runs both over the real corpus.
 */

import { baselineFromScores, MIN_RUNS_FOR_BASELINE } from "../history/baseline.ts";
import { dayKey } from "../quests/progression.ts";
import { GHOST_ROUNDS, startOfLocalDay, type GhostHistory, type GhostMatch } from "./ghost.ts";

// ---------------------------------------------------------------------------
// the code
// ---------------------------------------------------------------------------

/** ghost_code_shape in 20260930000020_ghost_results.sql: 8 of a 31-letter alphabet, no 0/O/1/I/L. */
export const LINK_CODE_SHAPE = /^[2-9A-HJKMNP-Z]{8}$/;

/**
 * A code as a person pastes it, or null when it cannot be one.
 *
 * Case, spaces and dashes are forgiven, because the code is read off a screenshot or out
 * of a chat message and "abcd-2345" is plainly the same code. Nothing else is: a letter
 * outside the alphabet is not a typo this can safely guess at.
 */
export function normaliseLinkCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  return LINK_CODE_SHAPE.test(code) ? code : null;
}

// ---------------------------------------------------------------------------
// the lookup (server side)
// ---------------------------------------------------------------------------

/**
 * Everything a recipient is sent, and all of it: the scenarios, the name the ghost races
 * under, and per scenario the sender's live score and the sender's baseline. No player
 * id, no Steam id, no run ids, no verdict, no rating: none of it is needed to race, and a
 * code is shared in public places.
 */
export interface GhostLinkRound {
  scenario: string;
  score: number;
  baseline: number;
}

export interface GhostLink {
  code: string;
  sender: string;
  rounds: GhostLinkRound[];
}

/** The exact keys a link may carry. validateGhostLinks holds `linkFromRow` to these. */
export const GHOST_LINK_KEYS = ["code", "rounds", "sender"] as const;
export const GHOST_LINK_ROUND_KEYS = ["baseline", "scenario", "score"] as const;

/** The columns ghost-link reads. player_id is read to refuse an own code, never sent. */
export const GHOST_LINK_COLUMNS = "code, player_id, scenario_names, live_scores, baselines";

export interface GhostLinkRow {
  code: string;
  player_id: string;
  scenario_names: string[];
  live_scores: (number | string)[];
  baselines: (number | string)[];
}

export type LinkRefusal = "malformed" | "unknown" | "own" | "unusable";

/**
 * Status and wording per refusal. `unknown` keeps the phrase "no ghost card", which is
 * how the client's `isNotDeployed` tells a missing code from a missing function (both are
 * 404s). None of them names whose card a code belongs to.
 */
export const LINK_REFUSAL: Record<LinkRefusal, { status: number; message: string }> = {
  malformed: { status: 400, message: "That is not a ghost code: eight letters and digits, with no 0, O, 1, I or L." },
  unknown: { status: 404, message: "There is no ghost card with that code." },
  own: { status: 409, message: "That is your own ghost. Send the code to a friend instead." },
  unusable: { status: 422, message: "That ghost card cannot be raced." },
};

export type LinkAnswer =
  | { ok: true; link: GhostLink }
  | { ok: false; refusal: LinkRefusal; status: number; message: string };

function refuse(refusal: LinkRefusal): LinkAnswer {
  return { ok: false, refusal, ...LINK_REFUSAL[refusal] };
}

/** Longest sender name sent. Display names come from Steam and can be anything. */
const SENDER_MAX = 32;

/**
 * The answer to a lookup, from the row the code found (or null), who is asking, and the
 * sender's display name. Built key by key rather than by spreading the row, so a column
 * added to the select later cannot leak through.
 */
export function linkFromRow(row: GhostLinkRow | null, callerId: string, senderName: string | null): LinkAnswer {
  if (!row) return refuse("unknown");
  if (row.player_id === callerId) return refuse("own");
  const n = GHOST_ROUNDS;
  if (row.scenario_names?.length !== n || row.live_scores?.length !== n || row.baselines?.length !== n) return refuse("unusable");
  const rounds = row.scenario_names.map((scenario, i) => ({
    scenario: String(scenario),
    score: Number(row.live_scores[i]),
    baseline: Number(row.baselines[i]),
  }));
  if (!rounds.every((r) => r.scenario && Number.isFinite(r.score) && r.baseline > 0)) return refuse("unusable");
  const sender = (senderName ?? "").trim().slice(0, SENDER_MAX) || "A player";
  return { ok: true, link: { code: row.code, sender, rounds } };
}

// ---------------------------------------------------------------------------
// the match (client side)
// ---------------------------------------------------------------------------

/**
 * Whether a server answer is a link this client can race, key for key. The client trusts
 * the server, but a shape it did not expect (an older or newer function) should be
 * refused with a sentence, not drawn as NaN.
 */
export function isGhostLink(value: unknown): value is GhostLink {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== GHOST_LINK_KEYS.join()) return false;
  if (typeof v.code !== "string" || !LINK_CODE_SHAPE.test(v.code)) return false;
  if (typeof v.sender !== "string" || !v.sender) return false;
  if (!Array.isArray(v.rounds) || v.rounds.length !== GHOST_ROUNDS) return false;
  const names = new Set<string>();
  for (const r of v.rounds) {
    if (!r || typeof r !== "object") return false;
    const round = r as Record<string, unknown>;
    if (Object.keys(round).sort().join() !== GHOST_LINK_ROUND_KEYS.join()) return false;
    if (typeof round.scenario !== "string" || !round.scenario) return false;
    if (typeof round.score !== "number" || !Number.isFinite(round.score)) return false;
    if (typeof round.baseline !== "number" || !(round.baseline > 0)) return false;
    names.add(round.scenario);
  }
  return names.size === GHOST_ROUNDS;
}

/**
 * A friend's-ghost match, ready to Start.
 *
 * The ghost side is the link as sent: the friend's score and the friend's baseline, per
 * scenario. The player's side is frozen at local midnight from their own history, the way
 * `drawGhostMatch` freezes a past self, so warming up before pressing Start cannot move
 * the bar: the same MIN_RUNS_FOR_BASELINE runs, the same `baselineFromScores` with no PB
 * floor. A scenario with fewer runs than that is `measured: false`.
 *
 * The id carries the draw's instant, so every race of a code is its own record: the quest
 * board and the result list both refuse an id they have already booked.
 */
export function friendMatch(history: Map<string, GhostHistory>, now: Date, link: GhostLink): GhostMatch {
  const frozen = startOfLocalDay(now).getTime();
  const day = dayKey(now);
  const rounds = link.rounds.map((r) => {
    const before = (history.get(r.scenario)?.runs ?? [])
      .filter((x) => x.playedAt && x.playedAt.getTime() < frozen && Number.isFinite(x.score))
      .map((x) => x.score);
    const baseline = before.length >= MIN_RUNS_FOR_BASELINE ? baselineFromScores(r.scenario, before).value : 0;
    const measured = baseline > 0;
    return {
      scenario: r.scenario,
      ghost: r.score,
      ghostBaseline: r.baseline,
      // A friend's ghost has no session of the player's behind it.
      sessionDay: "",
      sessionRuns: 1,
      baseline: measured ? baseline : 0,
      measured,
      pb: before.length ? Math.max(...before) : 0,
      live: null,
    };
  });
  return {
    id: `${day}:friend:${link.code}:${now.getTime()}`,
    kind: "friend",
    link: { code: link.code, sender: link.sender },
    day,
    ordinal: 0,
    drawnAt: now.getTime(),
    startedAt: null,
    deadline: null,
    rounds,
    result: null,
  };
}

/** The link a friend's-ghost match was built from, to rebuild it on a new day or for a rematch. */
export function linkOf(match: GhostMatch): GhostLink | null {
  if (match.kind !== "friend" || !match.link) return null;
  return {
    code: match.link.code,
    sender: match.link.sender,
    rounds: match.rounds.map((r) => ({ scenario: r.scenario, score: r.ghost, baseline: r.ghostBaseline ?? r.baseline })),
  };
}
