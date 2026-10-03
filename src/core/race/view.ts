/**
 * What a client is told about races: the invitations, the race being played, and the live
 * sealed view. Shared by `race-status` and the client, like `crowns/view.ts`.
 *
 * Nothing here carries the other player's per-round numbers except through `sealView`,
 * which is the only place the reveal rule is applied.
 */

import { verdictFor, type RaceResult, type SealedView } from "./race.ts";

export type RaceStatus = "invited" | "live" | "finished" | "declined" | "cancelled" | "expired";

export interface RacePerson {
  playerId: string;
  name: string;
}

export interface RaceSummary {
  id: string;
  status: RaceStatus;
  role: "inviter" | "invitee";
  opponent: RacePerson;
  category: string;
  window: number;
  band: string;
  scenarios: string[];
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The viewer's own match in a live or finished race. */
  yourMatchId: string | null;
  verdict: "win" | "loss" | "draw" | "void" | null;
  byForfeit: boolean;
}

export interface RaceBoard {
  incoming: RaceSummary[];
  outgoing: RaceSummary | null;
  live: RaceSummary | null;
  recent: RaceSummary[];
  inviteTtlSeconds: number;
}

export interface RaceRow {
  id: string;
  inviterId: string;
  inviteeId: string;
  category: string;
  window: number;
  band: string;
  scenarioIds: number[];
  status: RaceStatus;
  createdAt: number;
  expiresAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  inviterMatchId: string | null;
  inviteeMatchId: string | null;
  result: RaceResult | null;
  byForfeit: boolean;
}

/** The columns `raceRowFromDb` reads, for both race functions. */
export const RACE_COLUMNS =
  "id, inviter_id, invitee_id, category, window_index, difficulty, scenario_ids, status, created_at, expires_at, " +
  "started_at, finished_at, inviter_match_id, invitee_match_id, result, by_forfeit";

/** A `races` row as PostgREST returns it, in the shape the builders take. */
export function raceRowFromDb(r: Record<string, any>): RaceRow {
  const t = (v: string | null) => (v ? Date.parse(v) : null);
  return {
    id: r.id,
    inviterId: r.inviter_id,
    inviteeId: r.invitee_id,
    category: r.category,
    window: Number(r.window_index),
    band: r.difficulty,
    scenarioIds: (r.scenario_ids ?? []).map(Number),
    status: r.status,
    createdAt: Date.parse(r.created_at),
    expiresAt: Date.parse(r.expires_at),
    startedAt: t(r.started_at),
    finishedAt: t(r.finished_at),
    inviterMatchId: r.inviter_match_id,
    inviteeMatchId: r.invitee_match_id,
    result: r.result,
    byForfeit: !!r.by_forfeit,
  };
}

/** An invitation past its time reads as expired whether or not anything has written that down. */
export function effectiveRaceStatus(row: Pick<RaceRow, "status" | "expiresAt">, now: number): RaceStatus {
  return row.status === "invited" && row.expiresAt <= now ? "expired" : row.status;
}

export function summarise(
  row: RaceRow,
  viewerId: string,
  names: Map<string, string>,
  scenarioNames: Map<number, string>,
  now: number,
): RaceSummary {
  const role = row.inviterId === viewerId ? "inviter" : "invitee";
  const otherId = role === "inviter" ? row.inviteeId : row.inviterId;
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  return {
    id: row.id,
    status: effectiveRaceStatus(row, now),
    role,
    opponent: { playerId: otherId, name: names.get(otherId) ?? "player" },
    category: row.category,
    window: row.window,
    band: row.band,
    scenarios: row.scenarioIds.map((id) => scenarioNames.get(id) ?? `scenario ${id}`),
    createdAt: iso(row.createdAt)!,
    expiresAt: iso(row.expiresAt)!,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    yourMatchId: role === "inviter" ? row.inviterMatchId : row.inviteeMatchId,
    verdict: row.status === "finished" ? verdictFor(row.result, role === "inviter") : null,
    byForfeit: row.byForfeit,
  };
}

export function buildRaceBoard(
  rows: RaceRow[],
  viewerId: string,
  names: Map<string, string>,
  scenarioNames: Map<number, string>,
  now: number,
  inviteTtlSeconds: number,
): RaceBoard {
  const all = rows
    .map((r) => summarise(r, viewerId, names, scenarioNames, now))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    incoming: all.filter((r) => r.role === "invitee" && r.status === "invited"),
    outgoing: all.find((r) => r.role === "inviter" && r.status === "invited") ?? null,
    live: all.find((r) => r.status === "live") ?? null,
    recent: all.filter((r) => r.status === "finished").slice(0, 5),
    inviteTtlSeconds,
  };
}

export interface LiveView extends SealedView {
  kind: "race" | "crown";
  matchId: string;
  raceId: string | null;
  /** "Race against Kestrel", "Precise Tracking Crown (Intermediate)". */
  title: string;
  /** Set once the race (or challenge) has a result to show. */
  verdict: "win" | "loss" | "draw" | "void" | null;
  byForfeit: boolean;
  /** One plain sentence on where it stands, for the screen and for a screen reader. */
  status: string;
}

const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

/** The sentence under the bar. */
export function liveStatus(view: SealedView, verdict: LiveView["verdict"], kind: LiveView["kind"]): string {
  if (verdict === "win") return kind === "crown" ? "You beat the holder's run set." : `You won the race against ${view.them.name}.`;
  if (verdict === "loss") return kind === "crown" ? "The holder's run set stood." : `${view.them.name} won the race.`;
  if (verdict === "draw") return "Level within the draw margin.";
  if (verdict === "void") return "This one did not count.";
  const sealed = view.rounds.filter((r) => r.them.sealed).length;
  const lead = view.margin == null
    ? "No round revealed yet."
    : view.margin > 0
      ? `You lead by ${pct(view.margin)} over ${view.marginRounds} round${view.marginRounds === 1 ? "" : "s"}.`
      : view.margin < 0
        ? `You trail by ${pct(-view.margin)} over ${view.marginRounds} round${view.marginRounds === 1 ? "" : "s"}.`
        : `Level over ${view.marginRounds} round${view.marginRounds === 1 ? "" : "s"}.`;
  return sealed > 0
    ? `${lead} ${view.them.name} has landed ${sealed} round${sealed === 1 ? "" : "s"} you have not played yet; each opens when yours lands.`
    : lead;
}
