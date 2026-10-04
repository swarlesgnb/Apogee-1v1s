/**
 * The Crowns board, a Crown being taken and a live race, built by the real view builders
 * and frozen into tools/video/arena.json.
 *
 *   npx tsx tools/video/arenaDemo.ts
 *
 * The approach of tools/crownsUiFixture.ts, which photographs the same screens: every
 * payload is what list-crowns, race-status and settle-match would send, made by
 * `buildBoard`, `crownResultNote`, `sealView`, `liveStatus` and `raceVerdict`, on Season 1's
 * own scenario names. The players and their deltas are invented, and chosen: the board
 * needs Crowns held across the ladder, the challenge needs to be close (two rounds ahead of
 * the holder, one behind), and the race needs to change leader once. Whether a challenge
 * takes the Crown is asked of `beats()`, the rule the SQL is differential-tested against.
 *
 * Frozen and committed, like ghost.json. The bridge in record.cjs rebases every timestamp
 * to the moment of filming, so "held 2d 6h" and "lapses in 4d 18h" read as they do here.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beats } from "../../src/core/crowns/crowns.ts";
import { buildBoard, crownKey, crownResultNote, type BoardInput } from "../../src/core/crowns/view.ts";
import { raceVerdict, sealView, verdictFor, type FinalLeg, type LiveSide } from "../../src/core/race/race.ts";
import { liveStatus, type LiveView } from "../../src/core/race/view.ts";

const out = fileURLToPath(new URL("./arena.json", import.meta.url));
const season = JSON.parse(readFileSync("data/seasons/season-1.json", "utf8"));
const bands: string[] = season.windows;
const categories: string[] = [...new Set<string>(season.scenarios.map((s: any) => s.category))];
const ids = new Map<string, number>();
const names = new Map<number, string>();
for (const [i, s] of season.scenarios.entries()) { ids.set(s.scenario, i + 1); names.set(i + 1, s.scenario); }
const threeOf = (category: string, window: number): number[] =>
  season.scenarios.filter((s: any) => s.category === category && s.window === window).slice(0, 3).map((s: any) => ids.get(s.scenario)!);

// A fixed instant; the bridge moves it to the moment of filming.
const NOW = Date.UTC(2026, 9, 3, 19, 40, 0);
const H = 3_600_000, D = 24 * H;
const people = ["Kestrel", "Wren", "Halcyon", "Osprey", "Merlin", "Plover", "Siskin", "Tern", "Vega"];
const id = (n: string) => `00000000-0000-4000-8000-${String(people.indexOf(n) + 1).padStart(12, "0")}`;
const nameMap = new Map(people.map((p) => [id(p), p]));
const ME = id("Vega");

// category, band, holder, bar, held for, defences, tier, playing now
type Held = [string, number, string, number, number, number, "verified" | "consistent", number?];
const held: Held[] = [
  ["Static Clicking", 0, "Wren", 0.018, 2 * D + 4 * H, 3, "verified"],
  ["Static Clicking", 1, "Merlin", 0.041, 5 * D + 2 * H, 6, "verified", 1],
  ["Static Clicking", 2, "Siskin", 0.012, 9 * H, 1, "consistent"],
  ["Dynamic Clicking", 1, "Halcyon", 0.027, 3 * D, 2, "consistent"],
  ["Dynamic Clicking", 2, "Osprey", 0.006, 20 * H, 0, "verified"],
  ["Precise Tracking", 0, "Plover", 0.009, 6 * D + 20 * H, 4, "consistent"],
  ["Precise Tracking", 1, "Kestrel", 0.034, 2 * D + 6 * H, 3, "verified"],
  ["Precise Tracking", 2, "Tern", 0.022, 1 * D + 2 * H, 1, "verified"],
  ["Reactive Tracking", 1, "Merlin", 0.022, 2 * D, 1, "consistent"],
  ["Reactive Tracking", 3, "Siskin", 0.051, 4 * D, 5, "verified"],
  ["Speed Switching", 1, "Tern", 0.015, 11 * H, 0, "consistent"],
  ["Speed Switching", 2, "Wren", 0.031, 3 * D + 6 * H, 2, "verified"],
  ["Evasive Switching", 0, "Halcyon", 0.004, 5 * H, 0, "consistent"],
  ["Evasive Switching", 1, "Osprey", 0.024, 2 * D + 8 * H, 3, "verified"],
];

const TARGET = { category: "Precise Tracking", window: 1, band: bands[1] };
const pt = threeOf(TARGET.category, TARGET.window);
const cells = categories.flatMap((category) => bands.map((_, window) => ({ category, window })));
const rowsFor = (list: Held[], extra: Partial<Record<string, BoardInput["rows"][number]["reign"]>> = {}): BoardInput["rows"] =>
  cells.map(({ category, window }) => {
    const h = list.find((x) => x[0] === category && x[1] === window);
    const key = crownKey(category, window);
    const reign = extra[key] !== undefined ? extra[key]! : h
      ? { id: `r-${key}`, holderId: id(h[2]), matchScore: h[3], startedAt: NOW - h[4], defences: h[5], challenges: h[5] + 1, lowestTier: h[6], provisional: false }
      : null;
    return { category, window, cycle: reign ? 2 : 1, scenarioIds: reign || window === 3 ? threeOf(category, window) : null, live: h?.[7] ?? 0, reign };
  });

const history: BoardInput["history"] = [
  { category: TARGET.category, window: TARGET.window, holderId: id("Wren"), startedAt: NOW - 6 * D, endedAt: NOW - 2 * D - 6 * H, defences: 1, endReason: "dethroned", endedBy: id("Kestrel"), matchScore: 0.013 },
  { category: TARGET.category, window: TARGET.window, holderId: id("Siskin"), startedAt: NOW - 14 * D, endedAt: NOW - 7 * D, defences: 2, endReason: "lapsed", endedBy: null, matchScore: 0.02 },
];

const base: BoardInput = {
  season: season.name, bands, cells, rows: rowsFor(held), history, names: nameMap, scenarioNames: names,
  viewerId: ME, now: NOW, lastChallenge: new Map(), openChallenge: null, viewerBusy: false, notices: [],
};

// ---- the challenge: Vega against Kestrel's Precise Tracking Crown ---------------------------

const MY = [0.046, 0.031, 0.046];
const HOLDER = [0.021, 0.052, 0.029];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
assert.ok(Math.abs(mean(HOLDER) - 0.034) < 0.0005, "the holder's three reproduce the bar the board shows");
assert.ok(beats(mean(MY), mean(HOLDER)), "the challenge takes the Crown by the Crown's own rule");

const side = (name: string, scenarios: number[], deltas: number[], landed: boolean[], terminal: boolean): LiveSide => ({
  name, terminal, void: false,
  matchScore: terminal ? mean(deltas) : null,
  rounds: scenarios.map((sid, i) => ({ scenarioId: sid, scenario: names.get(sid)!, landed: landed[i], delta: landed[i] ? deltas[i] : null, counted: landed[i], provisional: false, tier: landed[i] ? "verified" : null })),
});
const view = (kind: "crown" | "race", you: LiveSide, them: LiveSide, title: string, matchId: string, verdict: LiveView["verdict"] = null): LiveView => {
  const sealed = sealView(you, them);
  return { ...sealed, kind, matchId, raceId: kind === "race" ? "race-1" : null, title, verdict, byForfeit: false, status: liveStatus(sealed, verdict, kind) };
};
const crownTitle = `${TARGET.category} Crown (${TARGET.band})`;
const holderSide = side("Kestrel", pt, HOLDER, [true, true, true], true);
const crownLive = [
  view("crown", side("Vega", pt, MY, [false, false, false], false), holderSide, crownTitle, "m-crown"),
  view("crown", side("Vega", pt, MY, [true, false, false], false), holderSide, crownTitle, "m-crown"),
  view("crown", side("Vega", pt, MY, [true, true, false], false), holderSide, crownTitle, "m-crown"),
  view("crown", side("Vega", pt, MY, [true, true, true], true), holderSide, crownTitle, "m-crown", "win"),
];

const crownMatch = {
  matchId: "m-crown", category: TARGET.category, difficulty: TARGET.band, expiresAt: new Date(NOW + 44 * 60_000).toISOString(),
  scenarios: pt.map((sid) => ({ id: sid, name: names.get(sid)! })),
  opponent: { displayName: "Kestrel", rating: 1702, playedAt: new Date(NOW - 2 * D - 6 * H).toISOString(), provisional: false },
  seeding: false, resumed: false, winProbability: null, poolSize: null,
  crown: { category: TARGET.category, window: TARGET.window, band: TARGET.band, name: crownTitle, claim: false, holderName: "Kestrel", bar: mean(HOLDER) },
};

const BASELINES = [2210, 1985, 2460];
const note = crownResultNote({ outcome: "took", category: TARGET.category, window: TARGET.window, band: TARGET.band, claim: false, holderName: "Kestrel", judgedAgainstNewHolder: false, challengerScore: mean(MY), holderScore: mean(HOLDER), defences: 3 });
const pctText = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;
const settledTake = {
  matchId: "m-crown", verdict: "win", rated: false, tournament: null, category: TARGET.category,
  arena: { kind: "crown", headline: note.headline, explanation: note.explanation, crown: note, race: null },
  explanation: `You win: ${pctText(mean(MY))} vs ${pctText(mean(HOLDER))} against your own baselines. ${note.headline}`,
  yourMatchScore: mean(MY), theirMatchScore: mean(HOLDER), ratingBefore: 1617, ratingAfter: 1617, ratingChange: 0, ratingWeight: 1,
  opponent: { playerId: id("Kestrel"), displayName: "Kestrel" }, voidReason: null,
  rounds: pt.map((sid, i) => ({
    scenario: names.get(sid)!, score: Math.round(BASELINES[i] * (1 + MY[i])), baseline: BASELINES[i], delta: MY[i], opponentDelta: HOLDER[i],
    counted: true, excludedReason: null, verificationTier: "verified",
  })),
};

const board = buildBoard(base);
const boardPlaying = buildBoard({ ...base, openChallenge: { key: crownKey(TARGET.category, TARGET.window), matchId: "m-crown" } });
const boardAfter = buildBoard({
  ...base,
  now: NOW + 20 * 60_000,
  rows: rowsFor(held, { [crownKey(TARGET.category, TARGET.window)]: { id: "r-vega", holderId: ME, matchScore: mean(MY), startedAt: NOW + 19 * 60_000, defences: 0, challenges: 0, lowestTier: "verified", provisional: false } }),
  history: [{ category: TARGET.category, window: TARGET.window, holderId: id("Kestrel"), startedAt: NOW - 2 * D - 6 * H, endedAt: NOW + 19 * 60_000, defences: 3, endReason: "dethroned", endedBy: ME, matchScore: mean(HOLDER) }, ...history],
  lastChallenge: new Map([[crownKey(TARGET.category, TARGET.window), NOW]]),
});

// ---- the race: Vega and Wren, live, on Speed Switching (Intermediate) ----------------------

const RACE = { category: "Speed Switching", window: 1, band: bands[1] };
const sw = threeOf(RACE.category, RACE.window);
const ME_RACE = [0.012, 0.034, 0.015];
const WREN = [0.019, 0.006, 0.020];
const raceTitle = "Race against Wren";
// Landing order, one step per landed run: Wren 1, Vega 1, Vega 2, Wren 2, Wren 3, Vega 3.
const steps: [boolean[], boolean[]][] = [
  [[false, false, false], [false, false, false]],
  [[false, false, false], [true, false, false]],
  [[true, false, false], [true, false, false]],
  [[true, true, false], [true, false, false]],
  [[true, true, false], [true, true, false]],
  [[true, true, false], [true, true, true]],
  [[true, true, true], [true, true, true]],
];
const leg = (deltas: number[]): FinalLeg => ({ status: "settled", matchScore: mean(deltas), tiers: ["verified", "verified", "verified"], scenarios: 3 });
const result = raceVerdict(leg(WREN), leg(ME_RACE));
const raceVerdictForMe = verdictFor(result.result, false);
assert.equal(raceVerdictForMe, "win", "the race goes to the bigger mean gain");
const raceLive = steps.map(([mine, theirs], k) => {
  const done = k === steps.length - 1;
  return view("race", side("Vega", sw, ME_RACE, mine, done), side("Wren", sw, WREN, theirs, done), raceTitle, "m-race", done ? raceVerdictForMe : null);
});
const raceMatch = {
  matchId: "m-race", category: RACE.category, difficulty: RACE.band, expiresAt: new Date(NOW + 44 * 60_000).toISOString(),
  scenarios: sw.map((sid) => ({ id: sid, name: names.get(sid)! })),
  opponent: { displayName: "Wren", rating: 1588, playedAt: null, provisional: false },
  seeding: false, resumed: false, winProbability: null, poolSize: null,
  crown: null, race: { id: "race-1", opponentName: "Wren", role: "invitee", band: RACE.band },
};

writeFileSync(out, JSON.stringify({
  about: "Written by tools/video/arenaDemo.ts with the real Crowns and race view builders (players and deltas invented, scenarios Season 1's). Do not edit by hand; re-run the generator.",
  generatedAt: new Date(NOW).toISOString(),
  board, boardPlaying, boardAfter, crownMatch, crownLive, settledTake, raceMatch, raceLive,
  races: { incoming: [], outgoing: null, live: null, recent: [], inviteTtlSeconds: 180 },
  duels: { incoming: [], outgoing: [], steamFriends: "public", friends: [], roster: [] },
}, null, 1) + "\n");
console.log(`wrote ${out}`);
for (const v of crownLive) console.log(`  crown  ${v.status}`);
for (const v of raceLive) console.log(`  race   ${v.status}`);
console.log(`  take   ${note.headline} ${note.explanation}`);
