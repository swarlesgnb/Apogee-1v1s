/**
 * The screens the Crowns UI test photographs, built by the real view builders.
 *
 *   npx tsx tools/crownsUiFixture.ts
 *
 * Every payload here is what list-crowns, race-status and settle-match would send: the
 * board from buildBoard, the live views from sealView and liveStatus, the result notes from
 * crownResultNote, the race list from buildRaceBoard. The players and scores are invented
 * and the scenarios are Season 1's own, so the pictures show the real layout with real
 * names. Writes .cache/crowns/screens.json, then builds a private copy of the UI preview
 * at .cache/crowns/preview.html (the tracked preview is left alone).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { buildBoard, crownKey, crownResultNote, type BoardInput } from "../src/core/crowns/view.ts";
import { REIGN_CAP_MS } from "../src/core/crowns/crowns.ts";
import { sealView, type LiveSide } from "../src/core/race/race.ts";
import { buildRaceBoard, liveStatus, type LiveView, type RaceRow } from "../src/core/race/view.ts";

const out = ".cache/crowns";
mkdirSync(out, { recursive: true });

const season = JSON.parse(readFileSync("data/seasons/season-1.json", "utf8"));
const bands: string[] = season.windows;
const categories: string[] = [...new Set<string>(season.scenarios.map((s: any) => s.category))];
const ids = new Map<string, number>();
const names = new Map<number, string>();
for (const [i, s] of season.scenarios.entries()) { ids.set(s.scenario, i + 1); names.set(i + 1, s.scenario); }
const threeOf = (category: string, window: number, offset = 0): number[] =>
  season.scenarios.filter((s: any) => s.category === category && s.window === window).slice(offset, offset + 3).map((s: any) => ids.get(s.scenario)!);

const NOW = Date.UTC(2026, 9, 3, 21, 14, 0);
const H = 3_600_000, D = 24 * H;
const people = ["Kestrel", "Wren", "Halcyon", "Osprey", "Merlin", "Plover", "Siskin", "Tern", "Me"];
const id = (n: string) => `00000000-0000-4000-8000-${String(people.indexOf(n) + 1).padStart(12, "0")}`;
const nameMap = new Map(people.map((p) => [id(p), p]));
nameMap.set(id("Me"), "Rylee");

const held: [string, number, string, number, number, "verified" | "consistent", number?][] = [
  // category, band, holder, held for (ms), defences, tier, live
  ["Static Clicking", 0, "Wren", 2 * D + 4 * H, 3, "verified"],
  ["Static Clicking", 1, "Kestrel", 5 * D + 2 * H, 6, "verified", 1],
  ["Static Clicking", 2, "Me", 9 * H, 1, "consistent"],
  ["Dynamic Clicking", 1, "Halcyon", 3 * D, 2, "consistent"],
  ["Dynamic Clicking", 2, "Osprey", 20 * H, 0, "verified"],
  ["Precise Tracking", 0, "Plover", 6 * D + 20 * H, 4, "consistent"],
  ["Precise Tracking", 1, "Kestrel", 1 * D + 3 * H, 3, "verified", 2],
  ["Reactive Tracking", 1, "Merlin", 2 * D, 1, "consistent"],
  ["Reactive Tracking", 3, "Siskin", 4 * D, 5, "verified"],
  ["Speed Switching", 1, "Tern", 11 * H, 0, "consistent"],
  ["Speed Switching", 2, "Wren", 3 * D + 6 * H, 2, "verified"],
  ["Evasive Switching", 0, "Halcyon", 5 * H, 0, "consistent"],
  ["Evasive Switching", 1, "Osprey", 2 * D + 8 * H, 3, "verified"],
];

const cells = categories.flatMap((category) => bands.map((_, window) => ({ category, window })));
const rows: BoardInput["rows"] = cells.map(({ category, window }) => {
  const h = held.find((x) => x[0] === category && x[1] === window);
  const drawn = h || (window === 3 && category.includes("Clicking"));
  return {
    category, window, cycle: h ? 2 : 1,
    scenarioIds: drawn ? threeOf(category, window) : null,
    live: h?.[6] ?? 0,
    reign: h ? { id: `r-${category}-${window}`, holderId: id(h[2]), startedAt: NOW - h[3], defences: h[4], challenges: h[4] + 1, lowestTier: h[5], provisional: false } : null,
  };
});

const history: BoardInput["history"] = [
  { category: "Precise Tracking", window: 1, holderId: id("Me"), startedAt: NOW - 4 * D, endedAt: NOW - 1 * D - 3 * H, defences: 3, endReason: "dethroned", endedBy: id("Kestrel"), endedWon: 2, endedLost: 1 },
  { category: "Precise Tracking", window: 1, holderId: id("Wren"), startedAt: NOW - 6 * D, endedAt: NOW - 4 * D, defences: 1, endReason: "dethroned", endedBy: id("Me"), endedWon: 3, endedLost: 0 },
  { category: "Precise Tracking", window: 1, holderId: id("Siskin"), startedAt: NOW - 14 * D, endedAt: NOW - 7 * D, defences: 2, endReason: "lapsed", endedBy: null, endedWon: null, endedLost: null },
  { category: "Static Clicking", window: 1, holderId: id("Merlin"), startedAt: NOW - 8 * D, endedAt: NOW - 5 * D - 2 * H, defences: 2, endReason: "dethroned", endedBy: id("Kestrel"), endedWon: 1, endedLost: 0 },
];

const boardInput: BoardInput = {
  season: season.name,
  bands,
  cells,
  rows,
  history,
  names: nameMap,
  scenarioNames: names,
  viewerId: id("Me"),
  now: NOW,
  lastChallenge: new Map([[crownKey("Reactive Tracking", 1), NOW - 5 * H]]),
  openChallenge: null,
  viewerBusy: false,
  notices: [
    { id: "n-1", kind: "dethroned", category: "Precise Tracking", window: 1, defences: 3, reignMs: 2 * D + 21 * H, otherName: "Kestrel", createdAt: NOW - 1 * D - 3 * H, challengerRounds: 2, holderRounds: 1 },
    { id: "n-2", kind: "defended", category: "Static Clicking", window: 2, defences: 1, reignMs: 7 * H, otherName: "Tern", createdAt: NOW - 2 * H, challengerRounds: 1, holderRounds: 1 },
  ],
};
const board = buildBoard(boardInput);
const boardEmpty = buildBoard({ ...boardInput, rows: [], history: [], notices: [], lastChallenge: new Map() });
const boardPlaying = buildBoard({ ...boardInput, notices: [], openChallenge: { key: crownKey("Precise Tracking", 1), matchId: "m-crown" } });

// A Crown challenge of Kestrel's Precise Tracking Crown, two rounds in. Raw scores in
// the ranges these scenarios score in; each player's usual is a little under what they hit.
const pt = threeOf("Precise Tracking", 1);
const side = (name: string, landed: boolean[], scores: number[], terminal: boolean, usual: number[] = scores.map((x) => x / 1.03)): LiveSide => ({
  name, terminal, void: false,
  rounds: pt.map((sid, i) => ({
    scenarioId: sid, scenario: names.get(sid)!, landed: landed[i], score: landed[i] ? scores[i] : null,
    delta: landed[i] ? scores[i] / usual[i] - 1 : null, counted: landed[i], provisional: false, tier: landed[i] ? "verified" : null,
  })),
});
const live = (kind: "crown" | "race", you: LiveSide, them: LiveSide, title: string, matchId: string, verdict: LiveView["verdict"] = null): LiveView => {
  const sealed = sealView(you, them);
  return { ...sealed, kind, matchId, raceId: kind === "race" ? "race-1" : null, title, verdict, byForfeit: false, status: liveStatus(sealed, verdict, kind) };
};
const KESTREL = [3120, 2875, 941];
const holder = side("Kestrel", [true, true, true], KESTREL, true);
// The live view a Crown challenge gets: a holder score opens when the challenger's run lands.
const liveCrown = live("crown", side("Rylee", [true, true, false], [3184, 2861, 0], false), holder, "Precise Tracking Crown (Intermediate)", "m-crown");
const liveRace = live("race",
  side("Rylee", [true, false, true], [912, 0, 2240], false, [900, 1500, 2260]),
  side("Wren", [true, true, false], [905, 1530, 0], false),
  "Race against Wren", "m-race");

const crownMatch = {
  matchId: "m-crown", category: "Precise Tracking", difficulty: "Intermediate", expiresAt: new Date(NOW + 6 * 60_000).toISOString(),
  scenarios: pt.map((sid) => ({ id: sid, name: names.get(sid)! })),
  opponent: { displayName: "Kestrel", rating: 1500, playedAt: new Date(NOW - D - 3 * H).toISOString(), provisional: false },
  seeding: false, resumed: false, winProbability: null, poolSize: null,
  crown: { category: "Precise Tracking", window: 1, band: "Intermediate", name: "Precise Tracking Crown (Intermediate)", claim: false, holderName: "Kestrel", rounds: 3 },
};

// What ranked v2's settleForPlayer returns for a Crown match: rounds format, each round with
// both raw scores and its result. The copied holder side carries no deltas, so there is no
// opponentDelta, and settlement's own verdict is against the holder the match was opened on.
const RESULT = (a: number, b: number) => (a > b ? "won" : a < b ? "lost" : "tied") as "won" | "lost" | "tied";
const rounds = (mine: number[], theirs: number[]) => pt.map((sid, i) => ({
  scenario: names.get(sid)!, score: mine[i], baseline: Math.round(mine[i] / 1.03), delta: mine[i] / Math.round(mine[i] / 1.03) - 1,
  opponentDelta: null, opponentScore: theirs[i], result: RESULT(mine[i], theirs[i]), counted: true, excludedReason: null, verificationTier: "verified",
}));
const tallyOf = (mine: number[], theirs: number[]) => ({
  won: mine.filter((x, i) => x > theirs[i]).length, lost: mine.filter((x, i) => x < theirs[i]).length, tied: mine.filter((x, i) => x === theirs[i]).length,
});
const scen = pt.map((sid) => names.get(sid)!);
const TAKE = [3184, 2861, 958];
const noteTake = crownResultNote({ outcome: "took", category: "Precise Tracking", window: 1, band: "Intermediate", claim: false, holderName: "Kestrel",
  judgedAgainstNewHolder: false, scenarios: scen, challengerScores: TAKE, holderScores: KESTREL, defences: 3 });
const settledTake = {
  matchId: "m-crown", engine: 1, format: "rounds", verdict: "win", rated: false, tournament: null, category: "Precise Tracking",
  arena: { kind: "crown", headline: noteTake.headline, explanation: noteTake.explanation, crown: noteTake, race: null },
  explanation: `You win 2\u20131 on rounds. ${noteTake.headline}`,
  roundTally: tallyOf(TAKE, KESTREL),
  yourMatchScore: 0.03, theirMatchScore: 0, ratingBefore: 1500, ratingAfter: 1500, ratingChange: 0, ratingWeight: 1,
  opponent: { playerId: id("Kestrel"), displayName: "Kestrel" }, voidReason: null,
  rounds: rounds(TAKE, KESTREL),
};
// Opened against Kestrel, decided against Wren, who took it while this was being played.
const WREN = [3201, 2902, 925];
const DEFEND = [3150, 2902, 930];
const noteDefend = crownResultNote({ outcome: "defended", category: "Precise Tracking", window: 1, band: "Intermediate", claim: false, holderName: "Wren",
  judgedAgainstNewHolder: true, scenarios: scen, challengerScores: DEFEND, holderScores: WREN, defences: 1 });
const settledDefend = {
  ...settledTake, matchId: "m-crown-2", verdict: "win",
  arena: { kind: "crown", headline: noteDefend.headline, explanation: noteDefend.explanation, crown: noteDefend, race: null },
  explanation: `You win 2\u20131 on rounds. ${noteDefend.headline}`,
  roundTally: tallyOf(DEFEND, KESTREL), rounds: rounds(DEFEND, KESTREL),
};

const raceRow = (over: Partial<RaceRow>): RaceRow => ({
  id: "race-x", inviterId: id("Wren"), inviteeId: id("Me"), category: "Precise Tracking", window: 1, band: "Intermediate",
  scenarioIds: pt, status: "invited", createdAt: NOW - 40_000, expiresAt: NOW + 140_000, startedAt: null, finishedAt: null,
  inviterMatchId: null, inviteeMatchId: null, result: null, byForfeit: false, ...over,
});
const races = buildRaceBoard([
  raceRow({ id: "race-in" }),
  raceRow({ id: "race-old", inviterId: id("Me"), inviteeId: id("Osprey"), status: "finished", result: "inviter", createdAt: NOW - D, startedAt: NOW - D, finishedAt: NOW - D + 600_000 }),
  raceRow({ id: "race-old2", inviterId: id("Tern"), status: "finished", result: "inviter", createdAt: NOW - 2 * D, startedAt: NOW - 2 * D, finishedAt: NOW - 2 * D + 700_000 }),
], id("Me"), nameMap, names, NOW, 180);
// The preview runs in real time, so give the invitation a deadline relative to now when shown.
const duels = {
  incoming: [], outgoing: [], steamFriends: "public",
  friends: [{ playerId: id("Wren"), displayName: "Wren", rating: 1540, provisional: false, lastPlayedAt: null, friend: true }],
  roster: people.filter((p) => p !== "Me").map((p) => ({ playerId: id(p), displayName: p, rating: 1500, provisional: false, lastPlayedAt: null, friend: false })),
};

writeFileSync(`${out}/screens.json`, JSON.stringify({
  board, boardEmpty, boardPlaying, liveCrown, liveRace, crownMatch, settledTake, settledDefend, races, duels,
  reignCapMs: REIGN_CAP_MS,
}, null, 1));
console.log(`wrote ${out}/screens.json: ${board.crowns.length} Crowns, ${board.notices.length} notices`);

const built = spawnSync(process.execPath, ["--import", "tsx", "tools/buildUiPreview.ts"], {
  env: { ...process.env, APOGEE_PREVIEW_OUT: `${out}/preview.html` },
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);
