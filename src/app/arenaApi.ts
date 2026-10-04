/**
 * Calls from the desktop client to the Crown and race functions.
 *
 * Kept out of api.ts so that file, which every feature touches, gains one exported word
 * rather than a section. Same transport, same error wording: `callFunction`.
 */

import { callFunction, type FoundMatch } from "./api.ts";
import type { CrownBoard, CrownResultNote } from "../core/crowns/view.ts";
import type { LiveView, RaceBoard, RaceSummary } from "../core/race/view.ts";

export type { CrownBoard, CrownResultNote, LiveView, RaceBoard, RaceSummary };

/** What challenge-crown adds to the find-match shape. */
export interface CrownMatchInfo {
  category: string;
  window: number;
  band: string;
  name: string;
  claim: boolean;
  holderName: string | null;
  bar: number | null;
}

/** What an accepted race adds to the find-match shape. */
export interface RaceMatchInfo {
  id: string;
  opponentName: string;
  role: "inviter" | "invitee";
  band: string;
}

export type ArenaMatch = FoundMatch & { crown?: CrownMatchInfo | null; race?: RaceMatchInfo | null };

/** The board, with the caller's unread notices. `seen` marks notices read first. */
export function fetchCrowns(seen?: string[]): Promise<CrownBoard> {
  return callFunction<CrownBoard>("list-crowns", seen && seen.length ? { seen } : {});
}

/** Claim a vacant Crown or challenge a held one. Shaped like findMatch. */
export function challengeCrown(category: string, window: number): Promise<ArenaMatch> {
  return callFunction<ArenaMatch>("challenge-crown", { category, window });
}

/** Invitations in and out, the race being played, recent results. */
export function fetchRaces(): Promise<RaceBoard> {
  return callFunction<RaceBoard>("race-status", {});
}

/** The sealed live view of a race leg or a Crown challenge the caller is playing. */
export function fetchLive(matchId: string): Promise<LiveView> {
  return callFunction<LiveView>("race-status", { matchId });
}

export function inviteRace(to: string, category: string, window: number): Promise<{ ok: boolean; race: RaceSummary }> {
  return callFunction("race-action", { action: "invite", to, category, window });
}

export function answerRace(raceId: string, action: "accept"): Promise<ArenaMatch>;
export function answerRace(raceId: string, action: "decline" | "cancel"): Promise<{ ok: boolean; race: RaceSummary }>;
export function answerRace(raceId: string, action: "accept" | "decline" | "cancel"): Promise<unknown> {
  return callFunction("race-action", { action, raceId });
}
