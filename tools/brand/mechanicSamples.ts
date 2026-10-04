/**
 * Records for the mechanic cards: the committed samples, and the cases built to break them.
 *
 * Each sample is a *record* (what main would hold once the server answered) run through
 * the real adapter (dailyCardInput, crownCardInput, flagCardInput, shadowCardInput), so a
 * sample also proves the adapter. Where a card prints rounds, the scenarios and the
 * player's raw scores are the committed snapshot's (data/snapshot.json), and every delta
 * and match score comes from the real settleMatch(), as renderShareCard.ts builds the
 * result-card samples. The other side of each crown and flag match is constructed. A
 * Shadow's score is the committed Shadow table's day at its percentile, and the placement
 * and streak are core/match/shadow.ts's own read-outs over the sample's results.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CardTier } from "../../src/core/brand/shareCard.ts";
import {
  crownCardInput,
  dailyCardInput,
  flagCardInput,
  shadowCardInput,
  type CardContext,
  type MechanicCardInput,
  type Refusal,
  type SettledRound,
  type ShadowMatch,
  type ShadowRecord,
} from "../../src/core/brand/shareInput.ts";
import { placement, shadowQuantile, shadowStreak, skillOf, type ShadowRecord as LadderRecord } from "../../src/core/match/shadow.ts";
import { SHADOW_DAYS } from "../../src/core/match/shadowDays.ts";
import { settleMatch, type RoundSubmission } from "../../src/core/match/settle.ts";
import { root } from "./kit.ts";

interface SnapshotScenario { name: string; label: string; score: number; runs: number }
interface Snapshot {
  generatedAt: string;
  player: { apogee: { rating: number; rd: number; percentile: number; tier: CardTier } };
  categories: { name: string; scenarios: SnapshotScenario[] }[];
}

const snap = JSON.parse(readFileSync(join(root, "data", "snapshot.json"), "utf8")) as Snapshot;
const me = snap.player.apogee;
const at = Date.parse("2026-10-03T19:30:00");

const ctx = (playerName = "rylee"): CardContext => ({ playerName, season: "Season 1", tier: { id: me.tier.id, name: me.tier.name, color: me.tier.color } });

function played(category: string): SnapshotScenario[] {
  const c = snap.categories.find((x) => x.name === category);
  if (!c) throw new Error(`snapshot has no ${category}`);
  const out = c.scenarios.filter((s) => s.runs > 0 && s.score > 0).slice(0, 3);
  if (out.length < 3) throw new Error(`snapshot has fewer than three played ${category} scenarios`);
  return out;
}

const sub = (id: number, name: string, score: number, baseline: number): RoundSubmission =>
  ({ scenarioId: id, scenarioName: name, score, baseline, provisional: false, verificationTier: "verified" });

/**
 * A settled set from real scores: `mine` and `theirs` are each side's gain over its own
 * baseline per round; the verdict and match scores are settleMatch()'s.
 */
function settled(category: string, mine: number[], theirs: number[]) {
  const sc = played(category);
  const you = sc.map((s, i) => sub(i, s.name, s.score, Math.round(s.score / (1 + mine[i]))));
  const them = sc.map((s, i) => {
    const base = Math.round(you[i].baseline * 0.97);
    return sub(i, s.name, Math.round(base * (1 + theirs[i])), base);
  });
  const r = settleMatch({ playerRounds: you, opponentRounds: them });
  if (r.verdict === "void") throw new Error("sample settled void");
  const rounds: SettledRound[] = sc.map((s, i) => ({
    scenario: s.label,
    score: you[i].score,
    baseline: you[i].baseline,
    delta: r.player.rounds[i].delta,
    opponentDelta: r.opponent.rounds[i].delta,
    opponentScore: them[i].score,
    opponentBaseline: them[i].baseline,
    counted: true,
    excludedReason: null,
  }));
  return { verdict: r.verdict, rounds, yourMatchScore: r.player.matchScore, theirMatchScore: r.opponent.matchScore };
}

/**
 * A Shadow history as main would hold it after the queue board is read: each day is the
 * percentile fielded and the player's match score. The Shadow's score is the committed
 * table's three-round day at that percentile for the category's skill, the verdict is
 * settleMatch's rule (level within 0.05 points), and the placement and streak are
 * placement() and shadowStreak() over the results, as queue-board serves them. Only the
 * last match carries scores: the board's ladder sends none for the others.
 */
function shadowHistory(category: string | null, days: { p: number; you: number | "forfeit" | "void" }[]): Omit<ShadowRecord, "at"> {
  const skill = skillOf(category);
  const ladder: LadderRecord[] = [];
  const series: ShadowMatch[] = days.map((d, i) => {
    const them = shadowQuantile(SHADOW_DAYS, skill, 3, d.p);
    const verdict = typeof d.you !== "number" ? d.you : Math.abs(d.you - them) < 0.0005 ? "draw" : d.you > them ? "win" : "loss";
    ladder.push({ ordinal: i, percentile: d.p, result: verdict });
    return { verdict, percentile: d.p, ...(i === days.length - 1 && typeof d.you === "number" ? { yourMatchScore: d.you, shadowScore: them } : {}) };
  });
  const read = placement(ladder);
  return { category, series, placement: read ? { estimate: read.estimate, decided: read.decided } : null, streak: shadowStreak(ladder) };
}

function ok<T>(v: T | Refusal, name: string): T {
  if (v && typeof v === "object" && "refused" in v) throw new Error(`sample ${name} was refused: ${v.refused}`);
  return v as T;
}

const LONG = "ThisIsAThirtyTwoCharacterHandle!";
const LONG_ME = "AnotherVeryLongDisplayNameHere..";

/** The samples, by name. `committed` marks the ones copied to assets/brand/samples. */
export function mechanicSamples(): Record<string, MechanicCardInput> {
  const crownTaken = settled("Speed Switching", [0.031, 0.012, 0.024], [0.018, 0.016, 0.004]);
  const crownHeld = settled("Precise Tracking", [0.022, -0.006, 0.019], [0.011, 0.004, 0.009]);
  const flagHeld = settled("Dynamic Clicking", [0.027, 0.009, -0.004], [0.014, 0.012, -0.011]);
  const flagLost = settled("Reactive Tracking", [0.004, 0.011, -0.008], [0.019, 0.006, 0.013]);
  if (crownTaken.verdict !== "win" || crownHeld.verdict !== "win" || flagHeld.verdict !== "win" || flagLost.verdict !== "loss") {
    throw new Error("a sample settled differently from what its name says");
  }
  return {
    // Daily #3 is the real number for 3 October (core/social/daily.ts counts from 1 October).
    daily: ok(dailyCardInput({ number: 3, band: "Intermediate", date: "2026-10-03", marks: ["above", "near", "below"], meanDelta: (0.031 + 0.006 - 0.018) / 3, streak: 3 }, ctx()), "daily"),
    "crown-taken": ok(crownCardInput({ event: "taken", category: "Speed Switching", band: "Intermediate", rival: { displayName: "ravenous" }, defences: 0, rivalReignDays: 3, ...crownTaken, at }, ctx()), "crown-taken"),
    "crown-defended": ok(crownCardInput({ event: "defended", category: "Precise Tracking", band: "Intermediate", rival: { displayName: "kestrel" }, defences: 4, heldSince: "2026-09-28", ...crownHeld, at }, ctx()), "crown-defended"),
    "flag-held": ok(flagCardInput({ category: "Dynamic Clicking", challenger: { displayName: "orbitwalker" }, plantedAt: "2026-10-01", answeredAt: "2026-10-03", rated: true, ratingAfter: 1630, ratingChange: 13, standing: 2, ...flagHeld, verdict: "win" }, ctx()), "flag-held"),
    "flag-lost": ok(flagCardInput({ category: "Reactive Tracking", challenger: { displayName: "tardigrade_main" }, plantedAt: "2026-09-29", answeredAt: "2026-10-03", rated: true, ratingAfter: 1604, ratingChange: -13, ...flagLost, verdict: "loss" }, ctx()), "flag-lost"),
    // A first Shadow match, won: placement still two results away.
    "shadow-placing": ok(shadowCardInput({ ...shadowHistory("Speed Switching", [{ p: 51, you: 0.021 }]), at }, ctx()), "shadow-placing"),
    // Six results up and down the ladder, the read-out showing, the latest a win.
    "shadow-placement": ok(shadowCardInput({
      ...shadowHistory("Speed Switching", [{ p: 51, you: 0.019 }, { p: 64, you: 0.004 }, { p: 49, you: 0.012 }, { p: 66, you: 0.031 }, { p: 81, you: 0.015 }, { p: 63, you: 0.027 }]),
      at,
    }, ctx()), "shadow-placement"),
  };
}

/** The cases built to break the layout. Rendered by validate:brand, never committed. */
export function mechanicEdgeCases(): Record<string, MechanicCardInput> {
  const crown = settled("Speed Switching", [0.121, -0.083, 0.004], [-0.052, 0.14, 0.0041]);
  const flag = settled("Static Clicking", [0.02, -0.01, 0.015], [0.02, -0.01, 0.015]);
  const long = (r: SettledRound[]) => r.map((x, i) => ({ ...x, scenario: ["Apogee Constellation Intermediate Advanced", "Shooting Stars Advanced", "CockpiTS Intermediate"][i] }));
  return {
    "edge-daily-six": ok(dailyCardInput({ number: 99999, band: "Intermediate to Advanced", date: "2026-12-31", marks: ["above", "first", "below", "near", "near", "pending"], meanDelta: -0.1234, nearBand: 0.015, streak: 1234, provisional: true, percentile: 99.9 }, ctx(LONG_ME)), "edge-daily-six"),
    "edge-daily-first": ok(dailyCardInput({ number: 1, band: "Novice", marks: ["first", "first", "first"], meanDelta: null, streak: 1 }, ctx()), "edge-daily-first"),
    "edge-daily-four": ok(dailyCardInput({ number: 40, band: "Expert", date: "2026-11-12", marks: ["above", "above", "below", "pending"], meanDelta: 0.0033, streak: 2, provisional: true }, ctx()), "edge-daily-four"),
    "edge-crown-long": ok(crownCardInput({ event: "taken", category: "Evasive Switching", band: "Cosmonaut to Odyssey", rival: { displayName: LONG }, defences: 0, rivalReignDays: 365, ...crown, rounds: long(crown.rounds), at }, ctx(LONG_ME)), "edge-crown-long"),
    "edge-crown-vacant": ok(crownCardInput({ event: "taken", category: "Static Clicking", band: "Stargazer", rival: null, defences: 0, ...crown, at }, ctx()), "edge-crown-vacant"),
    "edge-crown-many": ok(crownCardInput({ event: "defended", category: "Reactive Tracking", band: "1500-1650", rival: { displayName: LONG }, defences: 999, heldSince: "2026-01-01", ...crown, at }, ctx(LONG_ME)), "edge-crown-many"),
    "edge-flag-draw": ok(flagCardInput({ category: null, challenger: { displayName: LONG }, plantedAt: at, answeredAt: at + 3600_000, rated: false, ...flag, verdict: "draw", rounds: long(flag.rounds) }, ctx(LONG_ME)), "edge-flag-draw"),
    "edge-flag-excluded": ok(flagCardInput({ category: "Speed Switching", challenger: { displayName: "kestrel" }, plantedAt: "2025-10-03", answeredAt: "2026-10-03", rated: true, ratingAfter: 2101, ratingChange: -40, standing: 0, ...flag, verdict: "loss", rounds: flag.rounds.map((r, i) => (i === 1 ? { ...r, counted: false, excludedReason: "left early" } : r)) }, ctx()), "edge-flag-excluded"),
    // Eleven results with a void, an abandon and a level one: trimmed to the last eight.
    "edge-shadow-eight": ok(shadowCardInput({
      ...shadowHistory("Evasive Switching", [
        { p: 50, you: 0.02 }, { p: 65, you: 0.01 }, { p: 50, you: "void" }, { p: 49, you: 0.03 }, { p: 66, you: "forfeit" },
        { p: 51, you: 0.05 }, { p: 64, you: 0.03 }, { p: 79, you: 0.02 }, { p: 66, you: 0.03 }, { p: 80, you: 0.033 }, { p: 81, you: 0.1234 },
      ]),
      at,
    }, ctx(LONG_ME)), "edge-shadow-eight"),
    // Two results: one tile still to play.
    "edge-shadow-two": ok(shadowCardInput({ ...shadowHistory("Static Clicking", [{ p: 50, you: 0.01 }, { p: 65, you: -0.02 }]), at }, ctx()), "edge-shadow-two"),
    // No category, a loss, and the board not read since: no placement line at all.
    "edge-shadow-first": ok(shadowCardInput({ ...shadowHistory(null, [{ p: 52, you: -0.031 }]), placement: undefined, at }, ctx()), "edge-shadow-first"),
  };
}

/** The renders copied to assets/brand/samples: one of each card, both themes, both shapes. */
export const MECHANIC_COMMITTED: [string, "landscape" | "portrait", "dark" | "light"][] = [
  ["daily", "landscape", "dark"],
  ["daily", "portrait", "dark"],
  ["crown-taken", "landscape", "dark"],
  ["crown-defended", "portrait", "light"],
  ["flag-held", "landscape", "dark"],
  ["flag-lost", "landscape", "light"],
  ["shadow-placement", "landscape", "dark"],
  ["shadow-placing", "portrait", "dark"],
];
