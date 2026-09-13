/**
 * The shape of a tournament, as the engine in `tournament.ts` holds it.
 *
 * One JSON document per tournament, stored whole in `tournaments.state` and replaced by
 * compare-and-swap on `revision`. That is why every field here is plain data: the database
 * writes exactly what the reducer returned, and a reload reads back exactly what was
 * written, with nothing reconstructed in between.
 */

export type Phase = "registration" | "groups" | "playoffs" | "completed" | "cancelled";

export interface Config {
  name: string;
  groupCount: 2 | 4 | 8;
  groupSize: number;
  qualifiers: 1 | 2;
  seeding: "seeded" | "shuffle";
  /** Server-generated. Only read when `seeding` is "shuffle". */
  randomSeed: string;
}

export interface Entrant {
  /** The player's id. */
  id: string;
  /** A display-name snapshot taken when they entered, so a Steam rename mid-event moves nothing. */
  name: string;
  seed: number;
  checkedIn: boolean;
}

export interface Group {
  id: string;
  name: string;
  entrantIds: string[];
}

export interface Outcome {
  kind: "win" | "draw" | "void" | "forfeit";
  winnerId?: string;
  reason?: string;
}

/**
 * One settled attempt at a fixture.
 *
 * Built only on the server, from a match the existing settlement path already decided.
 * The engine checks its shape; that is not the same as trusting where it came from.
 */
export interface Receipt {
  id: string;
  fixtureId: string;
  attempt: number;
  outcome: Outcome;
}

export interface Fixture {
  id: string;
  stage: "group" | "playoff";
  groupId?: string;
  round: number;
  slot: number;
  playerA: string;
  playerB: string;
  status: "pending" | "completed";
  attempt: number;
  outcome?: Outcome;
  history: Receipt[];
}

export interface Standing {
  playerId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  miniPoints: number;
  rank: number;
  seedFallback: boolean;
}

export interface Tournament {
  schemaVersion: 1;
  id: string;
  revision: number;
  config: Config;
  phase: Phase;
  entrants: Entrant[];
  groups: Group[];
  fixtures: Fixture[];
  championId?: string;
  cancellationReason?: string;
}
