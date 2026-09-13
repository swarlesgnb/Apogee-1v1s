/**
 * What a client is told about a tournament.
 *
 * Declared here, in the core, and imported by both the Edge Function that builds it and
 * the client that reads it - the same arrangement as `apexWire.ts`, for the same reason: a
 * shape written out twice is a renamed field that compiles on both sides and arrives
 * undefined.
 *
 * WHAT IS NOT IN IT
 *
 * No score, delta, baseline, verification tier or rating, and no receipt history. A
 * fixture says whether it is waiting, being played or decided, and once decided, who won.
 * That is the reveal a duel already makes - "they have played", never "how well" - and it
 * is enough to run a bracket on. `scoreFieldsIncluded: false` is on every view so a reader
 * does not have to take this paragraph's word for it; `validateTournament.ts` walks the
 * whole object looking for the keys that would contradict it.
 *
 * Player ids ARE in it. The host needs one to remove an entrant and the client needs one to
 * find its own row, and it is the same narrowing `list-duels` already makes: a random uuid
 * that unlocks nothing outside this system.
 */

import { getReadyFixtures, getStandings } from "./tournament.ts";
import type { Fixture, Phase, Tournament } from "./types.ts";
import { capacityOf, cleanDisplayName, cleanText, MAX_CANCEL_REASON, MAX_TOURNAMENT_NAME, minimumToStart } from "./policy.ts";

/** One leg of the current attempt at a fixture, as far as the view needs to know. */
export interface LegSummary {
  fixtureId: string;
  attempt: number;
  leg: 1 | 2;
  playerId: string;
  /** Its match is still being played. */
  live: boolean;
}

export type Progress = "none" | "first-playing" | "first-played" | "second-playing" | "settling";

export interface ViewEntrant {
  playerId: string;
  name: string;
  seed: number;
  checkedIn: boolean;
  you: boolean;
  groupId: string | null;
}

export interface ViewStanding {
  playerId: string;
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  /** Still level after points, the mini-table and wins, so the frozen seed decided it. */
  seedFallback: boolean;
  /** Inside the qualifying places. Provisional until the group is finished. */
  qualifies: boolean;
}

export interface ViewGroup {
  id: string;
  name: string;
  letter: string;
  played: number;
  total: number;
  standings: ViewStanding[];
}

export interface ViewFixture {
  id: string;
  stage: "group" | "playoff";
  groupId: string | null;
  round: number;
  slot: number;
  label: string;
  a: string;
  b: string;
  status: "waiting" | "ready" | "completed";
  attempt: number;
  progress: Progress;
  /** Who played, or is playing, the first leg of the current attempt. */
  firstBy: string | null;
  outcome: { kind: "win" | "draw" | "forfeit"; winnerId: string | null } | null;
  yours: boolean;
}

export interface BracketSlot {
  fixtureId: string | null;
  a: string | null;
  b: string | null;
  /** Where each side comes from, for a slot nobody has reached yet. */
  aFrom: string;
  bFrom: string;
  winnerId: string | null;
}

export interface BracketRound {
  round: number;
  title: string;
  slots: BracketSlot[];
}

export interface NextFixture {
  fixtureId: string;
  attempt: number;
  label: string;
  opponentId: string;
  opponentName: string;
  /** play: press it now. resume: your leg is open. wait: the other player is up. */
  action: "play" | "resume" | "wait";
  /** The leg the viewer plays, or would play once the other side is in. */
  leg: 1 | 2;
  /** Somebody has already played the first three of this attempt. */
  firstPlayed: boolean;
  replay: boolean;
}

export interface TournamentView {
  schemaVersion: 1;
  id: string;
  revision: number;
  phase: Phase;
  name: string;
  category: string;
  windowName: string;
  host: { name: string; you: boolean };
  config: { groupCount: 2 | 4 | 8; groupSize: number; qualifiers: 1 | 2; seeding: "seeded" | "shuffle" };
  capacity: number;
  minimumToStart: number;
  playoffSpots: number;
  /** Null until the draw, because the group sizes are not known before it. */
  fixturesTotal: number | null;
  fixturesSettled: number;
  you: { playerId: string | null; entered: boolean; checkedIn: boolean; host: boolean; out: boolean };
  entrants: ViewEntrant[];
  groups: ViewGroup[];
  fixtures: ViewFixture[];
  bracket: BracketRound[];
  next: NextFixture | null;
  champion: { playerId: string; name: string } | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
  scoreFieldsIncluded: false;
}

export interface TournamentSummary {
  id: string;
  name: string;
  phase: Phase;
  hostName: string;
  hostedByYou: boolean;
  entered: boolean;
  entrants: number;
  checkedIn: number;
  capacity: number;
  category: string;
  windowName: string;
  groupCount: number;
  groupSize: number;
  qualifiers: number;
  championName: string | null;
  /** A fixture of yours can be played or resumed right now. */
  yourTurn: boolean;
  updatedAt: string;
}

export interface ViewInput {
  state: Tournament;
  hostId: string;
  hostName: string;
  viewerId: string | null;
  category: string;
  windowName: string;
  createdAt: string;
  updatedAt: string;
  legs: readonly LegSummary[];
}

const letterOf = (index: number) => String.fromCharCode(65 + index);

/** "Final", "Semifinals", "Quarterfinals", "Round of 16". */
export function roundTitle(matches: number): string {
  if (matches === 1) return "Final";
  if (matches === 2) return "Semifinals";
  if (matches === 4) return "Quarterfinals";
  return `Round of ${matches * 2}`;
}

/** The singular, for a label on one fixture: "Semifinal 2", "Final". */
function roundShort(matches: number, slot: number): string {
  if (matches === 1) return "Final";
  if (matches === 2) return `Semifinal ${slot + 1}`;
  if (matches === 4) return `Quarterfinal ${slot + 1}`;
  return `Round of ${matches * 2} · ${slot + 1}`;
}

/** Short enough to sit in a bracket slot: "QF3", "SF1". */
function roundAbbrev(matches: number, slot: number): string {
  if (matches === 1) return "Final";
  if (matches === 2) return `SF${slot + 1}`;
  if (matches === 4) return `QF${slot + 1}`;
  return `R${matches * 2}-${slot + 1}`;
}

/** Winner of the ordinal-th group placing: "A1", "B2". Matches `initialPlayoffFixtures`. */
function firstRoundSources(groupCount: number, qualifiers: 1 | 2): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const pairs = groupCount / 2;
  if (qualifiers === 1) {
    for (let p = 0; p < pairs; p += 1) out.push([`${letterOf(p * 2)}1`, `${letterOf(p * 2 + 1)}1`]);
    return out;
  }
  // Two per group: winners against the paired group's runner-up, and the two ties from one
  // pair split across the halves.
  for (let p = 0; p < pairs; p += 1) out[p] = [`${letterOf(p * 2)}1`, `${letterOf(p * 2 + 1)}2`];
  for (let p = 0; p < pairs; p += 1) out[pairs + p] = [`${letterOf(p * 2 + 1)}1`, `${letterOf(p * 2)}2`];
  return out;
}

function fixtureLabel(state: Tournament, fixture: Fixture, spots: number): string {
  if (fixture.stage === "group") {
    const group = state.groups.find((g) => g.id === fixture.groupId);
    return `${group ? group.name : "Group"} · Round ${fixture.round}`;
  }
  const matches = spots / 2 ** fixture.round;
  return roundShort(matches, fixture.slot);
}

/** The label a fixture carries everywhere it is named: on the bracket, the match panel and the result. */
export function fixtureLabelFor(state: Tournament, fixtureId: string): string {
  const fixture = state.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return "Fixture";
  return fixtureLabel(state, fixture, state.config.groupCount * state.config.qualifiers);
}

function progressOf(fixture: Fixture, legs: readonly LegSummary[]): { progress: Progress; firstBy: string | null } {
  if (fixture.status === "completed") return { progress: "none", firstBy: null };
  const mine = legs.filter((l) => l.fixtureId === fixture.id && l.attempt === fixture.attempt);
  const first = mine.find((l) => l.leg === 1);
  const second = mine.find((l) => l.leg === 2);
  if (!first) return { progress: "none", firstBy: null };
  if (first.live) return { progress: "first-playing", firstBy: first.playerId };
  if (!second) return { progress: "first-played", firstBy: first.playerId };
  if (second.live) return { progress: "second-playing", firstBy: first.playerId };
  // Both legs finished and the result not yet folded in. The server reconciles before it
  // builds a view, so this is the window between two requests, not a resting state.
  return { progress: "settling", firstBy: first.playerId };
}

function nextFor(
  state: Tournament,
  viewerId: string,
  ready: readonly Fixture[],
  legs: readonly LegSummary[],
  names: Map<string, string>,
  spots: number,
): NextFixture | null {
  const fixture = ready.find((f) => f.playerA === viewerId || f.playerB === viewerId);
  if (!fixture) return null;
  const opponentId = fixture.playerA === viewerId ? fixture.playerB : fixture.playerA;
  const current = legs.filter((l) => l.fixtureId === fixture.id && l.attempt === fixture.attempt);
  const first = current.find((l) => l.leg === 1);
  const second = current.find((l) => l.leg === 2);

  const base = {
    fixtureId: fixture.id,
    attempt: fixture.attempt,
    label: fixtureLabel(state, fixture, spots),
    opponentId,
    opponentName: names.get(opponentId) ?? "player",
    replay: fixture.attempt > 1,
  };

  if (!first) return { ...base, action: "play", leg: 1, firstPlayed: false };
  if (first.playerId === viewerId) {
    return { ...base, action: first.live ? "resume" : "wait", leg: 1, firstPlayed: !first.live };
  }
  if (first.live) return { ...base, action: "wait", leg: 2, firstPlayed: false };
  if (!second) return { ...base, action: "play", leg: 2, firstPlayed: true };
  return { ...base, action: second.live ? "resume" : "wait", leg: 2, firstPlayed: true };
}

function isOut(state: Tournament, viewerId: string): boolean {
  if (state.phase !== "playoffs" && state.phase !== "completed") return false;
  const playoff = state.fixtures.filter(
    (f) => f.stage === "playoff" && (f.playerA === viewerId || f.playerB === viewerId),
  );
  if (playoff.length === 0) return true;
  return playoff.some(
    (f) => f.status === "completed" && f.outcome?.winnerId !== undefined && f.outcome.winnerId !== viewerId,
  );
}

export function buildView(input: ViewInput): TournamentView {
  const { state, viewerId } = input;
  const config = state.config;
  const spots = config.groupCount * config.qualifiers;
  const names = new Map(state.entrants.map((e) => [e.id, cleanDisplayName(e.name)]));
  const groupOf = new Map<string, string>();
  for (const g of state.groups) for (const id of g.entrantIds) groupOf.set(id, g.id);

  const ready = getReadyFixtures(state);
  const readyIds = new Set(ready.map((f) => f.id));

  const groups: ViewGroup[] = state.groups.map((group, index) => {
    const fixtures = state.fixtures.filter((f) => f.stage === "group" && f.groupId === group.id);
    return {
      id: group.id,
      name: cleanText(group.name, 24),
      letter: letterOf(index),
      played: fixtures.filter((f) => f.status === "completed").length,
      total: fixtures.length,
      standings: getStandings(state, group.id).map((s) => ({
        playerId: s.playerId,
        rank: s.rank,
        played: s.played,
        won: s.won,
        drawn: s.drawn,
        lost: s.lost,
        points: s.points,
        seedFallback: s.seedFallback,
        qualifies: s.rank <= config.qualifiers,
      })),
    };
  });

  const fixtures: ViewFixture[] = state.fixtures.map((f) => {
    const { progress, firstBy } = progressOf(f, input.legs);
    return {
      id: f.id,
      stage: f.stage,
      groupId: f.groupId ?? null,
      round: f.round,
      slot: f.slot,
      label: fixtureLabel(state, f, spots),
      a: f.playerA,
      b: f.playerB,
      status: f.status === "completed" ? "completed" : readyIds.has(f.id) ? "ready" : "waiting",
      attempt: f.attempt,
      progress,
      firstBy,
      // A completed fixture is never void: the engine refuses to complete one.
      outcome: f.status === "completed" && f.outcome && f.outcome.kind !== "void"
        ? { kind: f.outcome.kind, winnerId: f.outcome.winnerId ?? null }
        : null,
      yours: viewerId !== null && (f.playerA === viewerId || f.playerB === viewerId),
    };
  });

  const rounds = Math.round(Math.log2(spots));
  const sources = firstRoundSources(config.groupCount, config.qualifiers);
  const bracket: BracketRound[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const matches = spots / 2 ** round;
    const previous = spots / 2 ** (round - 1);
    const slots: BracketSlot[] = [];
    for (let slot = 0; slot < matches; slot += 1) {
      const real = state.fixtures.find((f) => f.stage === "playoff" && f.round === round && f.slot === slot);
      const [aFrom, bFrom] = round === 1
        ? sources[slot]
        : [`${roundAbbrev(previous, slot * 2)} winner`, `${roundAbbrev(previous, slot * 2 + 1)} winner`];
      slots.push({
        fixtureId: real ? real.id : null,
        a: real ? real.playerA : null,
        b: real ? real.playerB : null,
        aFrom,
        bFrom,
        winnerId: real && real.status === "completed" ? real.outcome?.winnerId ?? null : null,
      });
    }
    bracket.push({ round, title: roundTitle(matches), slots });
  }

  const entered = viewerId !== null && state.entrants.some((e) => e.id === viewerId);
  const viewerEntrant = viewerId !== null ? state.entrants.find((e) => e.id === viewerId) : undefined;
  const started = state.groups.length > 0;

  return {
    schemaVersion: 1,
    id: state.id,
    revision: state.revision,
    phase: state.phase,
    name: cleanText(config.name, MAX_TOURNAMENT_NAME),
    category: cleanText(input.category, 40),
    windowName: cleanText(input.windowName, 40),
    host: { name: cleanDisplayName(input.hostName), you: viewerId !== null && viewerId === input.hostId },
    config: {
      groupCount: config.groupCount,
      groupSize: config.groupSize,
      qualifiers: config.qualifiers,
      seeding: config.seeding,
    },
    capacity: capacityOf(config),
    minimumToStart: minimumToStart(config),
    playoffSpots: spots,
    fixturesTotal: started ? state.fixtures.filter((f) => f.stage === "group").length + spots - 1 : null,
    fixturesSettled: state.fixtures.filter((f) => f.status === "completed").length,
    you: {
      playerId: viewerId,
      entered,
      checkedIn: Boolean(viewerEntrant?.checkedIn),
      host: viewerId !== null && viewerId === input.hostId,
      out: entered && viewerId !== null && (
        isOut(state, viewerId) || (started && !groupOf.has(viewerId))
      ),
    },
    entrants: [...state.entrants]
      .sort((a, b) => a.seed - b.seed)
      .map((e) => ({
        playerId: e.id,
        name: names.get(e.id)!,
        seed: e.seed,
        checkedIn: e.checkedIn,
        you: e.id === viewerId,
        groupId: groupOf.get(e.id) ?? null,
      })),
    groups,
    fixtures,
    bracket,
    next: viewerId !== null ? nextFor(state, viewerId, ready, input.legs, names, spots) : null,
    champion: state.championId
      ? { playerId: state.championId, name: names.get(state.championId) ?? "player" }
      : null,
    cancellationReason: state.cancellationReason
      ? cleanText(state.cancellationReason, MAX_CANCEL_REASON) || null
      : null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    scoreFieldsIncluded: false,
  };
}

/** The row in the list. Built from the same view so the two cannot disagree about whose turn it is. */
export function buildSummary(input: ViewInput): TournamentSummary {
  const view = buildView(input);
  return {
    id: view.id,
    name: view.name,
    phase: view.phase,
    hostName: view.host.name,
    hostedByYou: view.host.you,
    entered: view.you.entered,
    entrants: view.entrants.length,
    checkedIn: view.entrants.filter((e) => e.checkedIn).length,
    capacity: view.capacity,
    category: view.category,
    windowName: view.windowName,
    groupCount: view.config.groupCount,
    groupSize: view.config.groupSize,
    qualifiers: view.config.qualifiers,
    championName: view.champion ? view.champion.name : null,
    yourTurn: view.next !== null && view.next.action !== "wait",
    updatedAt: view.updatedAt,
  };
}
