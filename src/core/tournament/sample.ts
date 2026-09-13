/**
 * An example tournament, played part of the way, for the two places that need one with no
 * server behind them: the shareable preview and the smoke test.
 *
 * Built by the real engine and the real view, so what they draw is exactly what a live
 * tournament draws. Only the players and the results are invented, and the preview says
 * so on the screen.
 */

import {
  addEntrant,
  createTournament,
  getReadyFixtures,
  recordResult,
  setCheckIn,
  startTournament,
  type Fixture,
  type Outcome,
  type Tournament,
} from "./tournament.ts";
import { buildView, type LegSummary, type TournamentView } from "./view.ts";
import { seededRandom } from "../match/scenarioSelection.ts";

const HANDLES = [
  "kestrel", "vanta", "Ossia", "marlow", "Juno", "halcyon", "tarn", "Pike",
  "sable", "Wren", "ember", "Corvid", "lumen", "quill", "Rook", "fen",
];

export type SampleStage = "registration" | "groups" | "playoffs" | "completed";

export interface SampleOptions {
  stage: SampleStage;
  /** Whose screen this is. The first handle is always the viewer. */
  viewerHosts?: boolean;
  /** Put markup in a name, so the smoke test can check it arrives as text. */
  hostileName?: string;
}

const id = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

/** The lower seed wins more often than not, which is what makes an example look like a tournament. */
function decide(fixture: Fixture, state: Tournament, random: () => number): Outcome {
  const seedOf = (p: string) => state.entrants.find((e) => e.id === p)!.seed;
  const roll = random();
  if (fixture.stage === "group" && roll < 0.1) return { kind: "draw" };
  const favourite = seedOf(fixture.playerA) < seedOf(fixture.playerB) ? fixture.playerA : fixture.playerB;
  const other = favourite === fixture.playerA ? fixture.playerB : fixture.playerA;
  return { kind: "win", winnerId: roll < 0.68 ? favourite : other };
}

export function sampleTournamentView(options: SampleOptions): TournamentView {
  const random = seededRandom(`sample:${options.stage}`);
  const tournamentId = "00000000-0000-4000-8000-00000000cafe";
  let state = createTournament(tournamentId, {
    name: options.stage === "registration" ? "Thursday Switching Cup" : "Apogee Autumn Open",
    groupCount: 4,
    groupSize: 4,
    qualifiers: 2,
    seeding: "seeded",
    randomSeed: "sample",
  });

  const names = [...HANDLES];
  if (options.hostileName) names[5] = options.hostileName;
  const viewer = id(0);
  const hostId = options.viewerHosts ? viewer : id(2);

  const entering = options.stage === "registration" ? 11 : 16;
  for (let i = 0; i < entering; i++) {
    state = addEntrant(state, { id: id(i), name: names[i], seed: i + 1, checkedIn: options.stage !== "registration" || i % 3 !== 0 });
  }
  if (options.stage === "registration") state = setCheckIn(state, viewer, false);

  const legs: LegSummary[] = [];
  if (options.stage !== "registration") {
    state = startTournament(state);
    let n = 0;
    const settle = (fixture: Fixture) => {
      state = recordResult(state, { id: `sample-${n++}`, fixtureId: fixture.id, attempt: fixture.attempt, outcome: decide(fixture, state, random) });
    };

    if (options.stage === "groups") {
      // Round one done everywhere, round two part of the way, the viewer's still to play.
      for (const f of getReadyFixtures(state)) settle(f);
      const second = getReadyFixtures(state);
      const mine = second.find((f) => f.playerA === viewer || f.playerB === viewer);
      const others = second.filter((f) => f !== mine);
      others.slice(0, 3).forEach(settle);
      const inPlay = others[3];
      if (inPlay) legs.push({ fixtureId: inPlay.id, attempt: inPlay.attempt, leg: 1, playerId: inPlay.playerA, live: true });
      const answered = others[4];
      if (answered) legs.push({ fixtureId: answered.id, attempt: answered.attempt, leg: 1, playerId: answered.playerB, live: false });
    } else {
      let guard = 0;
      while (state.phase === "groups" && guard++ < 50) getReadyFixtures(state).forEach(settle);
      if (options.stage === "playoffs") {
        const quarters = getReadyFixtures(state);
        quarters.slice(0, 2).forEach(settle);
        const live = quarters[2];
        if (live) legs.push({ fixtureId: live.id, attempt: live.attempt, leg: 1, playerId: live.playerB, live: false });
      } else {
        guard = 0;
        while (state.phase === "playoffs" && guard++ < 50) getReadyFixtures(state).forEach(settle);
      }
    }
  }

  return buildView({
    state,
    hostId,
    hostName: options.viewerHosts ? names[0] : names[2],
    viewerId: viewer,
    category: "Tracking",
    windowName: "Intermediate",
    createdAt: "2026-09-10T18:00:00Z",
    updatedAt: "2026-09-12T20:30:00Z",
    legs,
  });
}
