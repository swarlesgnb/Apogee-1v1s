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

const held: [string, number, string, number, number, number, "verified" | "consistent", number?][] = [
  // category, band, holder, bar, held for (ms), defences, tier, live
  ["Static Clicking", 0, "Wren", 0.018, 2 * D + 4 * H, 3, "verified"],
  ["Static Clicking", 1, "Kestrel", 0.041, 5 * D + 2 * H, 6, "verified", 1],
  ["Static Clicking", 2, "Me", 0.012, 9 * H, 1, "consistent"],
  ["Dynamic Clicking", 1, "Halcyon", 0.027, 3 * D, 2, "consistent"],
  ["Dynamic Clicking", 2, "Osprey", -0.006, 20 * H, 0, "verified"],
  ["Precise Tracking", 0, "Plover", 0.009, 6 * D + 20 * H, 4, "consistent"],
  ["Precise Tracking", 1, "Kestrel", 0.034, 1 * D + 3 * H, 3, "verified", 2],
  ["Reactive Tracking", 1, "Merlin", 0.022, 2 * D, 1, "consistent"],
  ["Reactive Tracking", 3, "Siskin", 0.051, 4 * D, 5, "verified"],
  ["Speed Switching", 1, "Tern", 0.015, 11 * H, 0, "consistent"],
  ["Speed Switching", 2, "Wren", 0.031, 3 * D + 6 * H, 2, "verified"],
  ["Evasive Switching", 0, "Halcyon", 0.004, 5 * H, 0, "consistent"],
  ["Evasive Switching", 1, "Osprey", 0.024, 2 * D + 8 * H, 3, "verified"],
];

const cells = categories.flatMap((category) => bands.map((_, window) => ({ category, window })));
const rows: BoardInput["rows"] = cells.map(({ category, window }) => {
  const h = held.find((x) => x[0] === category && x[1] === window);
  const drawn = h || (window === 3 && category.includes("Clicking"));
  return {
    category, window, cycle: h ? 2 : 1,
    scenarioIds: drawn ? threeOf(category, window) : null,
    live: h?.[7] ?? 0,
    reign: h ? { id: `r-${category}-${window}`, holderId: id(h[2]), matchScore: h[3], startedAt: NOW - h[4], defences: h[5], challenges: h[5] + 1, lowestTier: h[6], provisional: false } : null,
  };
});

const history: BoardInput["history"] = [
  { category: "Precise Tracking", window: 1, holderId: id("Me"), startedAt: NOW - 4 * D, endedAt: NOW - 1 * D - 3 * H, defences: 3, endReason: "dethroned", endedBy: id("Kestrel"), matchScore: 0.028 },
  { category: "Precise Tracking", window: 1, holderId: id("Wren"), startedAt: NOW - 6 * D, endedAt: NOW - 4 * D, defences: 1, endReason: "dethroned", endedBy: id("Me"), matchScore: 0.013 },
  { category: "Precise Tracking", window: 1, holderId: id("Siskin"), startedAt: NOW - 14 * D, endedAt: NOW - 7 * D, defences: 2, endReason: "lapsed", endedBy: null, matchScore: 0.02 },
  { category: "Static Clicking", window: 1, holderId: id("Merlin"), startedAt: NOW - 8 * D, endedAt: NOW - 5 * D - 2 * H, defences: 2, endReason: "dethroned", endedBy: id("Kestrel"), matchScore: 0.026 },
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
    { id: "n-1", kind: "dethroned", category: "Precise Tracking", window: 1, defences: 3, reignMs: 2 * D + 21 * H, otherName: "Kestrel", createdAt: NOW - 1 * D - 3 * H },
    { id: "n-2", kind: "defended", category: "Static Clicking", window: 2, defences: 1, reignMs: 7 * H, otherName: "Tern", createdAt: NOW - 2 * H },
  ],
};
const board = buildBoard(boardInput);
const boardEmpty = buildBoard({ ...boardInput, rows: [], history: [], notices: [], lastChallenge: new Map() });
const boardPlaying = buildBoard({ ...boardInput, notices: [], openChallenge: { key: crownKey("Precise Tracking", 1), matchId: "m-crown" } });

// A Crown challenge of Kestrel's Precise Tracking Crown, two rounds in.
const pt = threeOf("Precise Tracking", 1);
const side = (name: string, landed: boolean[], deltas: number[], terminal: boolean): LiveSide => ({
  name, terminal, void: false,
  matchScore: terminal ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
  rounds: pt.map((sid, i) => ({ scenarioId: sid, scenario: names.get(sid)!, landed: landed[i], delta: landed[i] ? deltas[i] : null, counted: landed[i], provisional: false, tier: landed[i] ? "verified" : null })),
});
const live = (kind: "crown" | "race", you: LiveSide, them: LiveSide, title: string, matchId: string, verdict: LiveView["verdict"] = null): LiveView => {
  const sealed = sealView(you, them);
  return { ...sealed, kind, matchId, raceId: kind === "race" ? "race-1" : null, title, verdict, byForfeit: false, status: liveStatus(sealed, verdict, kind) };
};
const holder = side("Kestrel", [true, true, true], [0.021, 0.052, 0.029], true);
const liveCrown = live("crown", side("Rylee", [true, true, false], [0.046, 0.031, 0], false), holder, "Precise Tracking Crown (Intermediate)", "m-crown");
const liveRace = live("race",
  side("Rylee", [true, false, true], [0.012, 0, -0.008], false),
  side("Wren", [true, true, false], [0.019, 0.027, 0], false),
  "Race against Wren", "m-race");

const crownMatch = {
  matchId: "m-crown", category: "Precise Tracking", difficulty: "Intermediate", expiresAt: new Date(NOW + 6 * 60_000).toISOString(),
  scenarios: pt.map((sid) => ({ id: sid, name: names.get(sid)! })),
  opponent: { displayName: "Kestrel", rating: 1500, playedAt: new Date(NOW - D - 3 * H).toISOString(), provisional: false },
  seeding: false, resumed: false, winProbability: null, poolSize: null,
  crown: { category: "Precise Tracking", window: 1, band: "Intermediate", name: "Precise Tracking Crown (Intermediate)", claim: false, holderName: "Kestrel", bar: 0.034 },
};

const rounds = (mine: number[], theirs: number[]) => pt.map((sid, i) => ({
  scenario: names.get(sid)!, score: Math.round(1000 * (1 + mine[i])), baseline: 1000, delta: mine[i], opponentDelta: theirs[i], counted: true, excludedReason: null, verificationTier: "verified",
}));
const noteTake = crownResultNote({ outcome: "took", category: "Precise Tracking", window: 1, band: "Intermediate", claim: false, holderName: "Kestrel", judgedAgainstNewHolder: false, challengerScore: 0.041, holderScore: 0.034, defences: 3 });
const settledTake = {
  matchId: "m-crown", verdict: "win", rated: false, tournament: null, category: "Precise Tracking",
  arena: { kind: "crown", headline: noteTake.headline, explanation: noteTake.explanation, crown: noteTake, race: null },
  explanation: `You win: +4.1% vs +3.4% against your own baselines. ${noteTake.headline}`,
  yourMatchScore: 0.041, theirMatchScore: 0.034, ratingBefore: 1500, ratingAfter: 1500, ratingChange: 0, ratingWeight: 1,
  opponent: { playerId: id("Kestrel"), displayName: "Kestrel" }, voidReason: null,
  rounds: rounds([0.046, 0.031, 0.046], [0.021, 0.052, 0.029]),
};
const noteDefend = crownResultNote({ outcome: "defended", category: "Precise Tracking", window: 1, band: "Intermediate", claim: false, holderName: "Wren", judgedAgainstNewHolder: true, challengerScore: 0.038, holderScore: 0.044, defences: 1 });
const settledDefend = {
  ...settledTake, matchId: "m-crown-2", verdict: "win",
  arena: { kind: "crown", headline: noteDefend.headline, explanation: noteDefend.explanation, crown: noteDefend, race: null },
  explanation: `You win: +3.8% vs +3.4% against your own baselines. ${noteDefend.headline}`,
  yourMatchScore: 0.038, rounds: rounds([0.041, 0.035, 0.038], [0.021, 0.052, 0.029]),
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
