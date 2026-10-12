/**
 * Records for the mechanic cards: the committed samples, and the cases built to break them.
 *
 * Each sample is a *record* (what main would hold once the server answered) run through
 * the real adapter (dailyCardInput, crownCardInput, flagCardInput, shadowCardInput), so a
 * sample also proves the adapter. Where a card prints rounds, the scenarios and the
 * player's raw scores are the committed snapshot's (data/snapshot.json), and every delta
 * and match score comes from the real settleMatch(), as renderShareCard.ts builds the
 * result-card samples. The other side of each match and the Shadows' ratings are
 * constructed; the mechanics are being built tonight on other branches and have no real
 * results yet.
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
} from "../../src/core/brand/shareInput.ts";
import { settleMatch, type RoundSubmission } from "../../src/core/match/settle.ts";
import { root, tiers } from "./kit.ts";

interface SnapshotScenario { name: string; label: string; score: number; runs: number }
interface Snapshot {
  generatedAt: string;
  player: { apogee: { rating: number; rd: number; percentile: number; tier: CardTier } };
  categories: { name: string; scenarios: SnapshotScenario[] }[];
}

const snap = JSON.parse(readFileSync(join(root, "data", "snapshot.json"), "utf8")) as Snapshot;
const me = snap.player.apogee;
const at = Date.parse("2026-10-03T19:30:00");

export const tierByName = (n: string): CardTier => {
  const t = tiers.find((x) => x.name === n);
  if (!t) throw new Error(`no tier named ${n}`);
  return { id: t.id, name: t.name, color: t.color };
};

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
    "shadow-placing": ok(shadowCardInput({
      category: "Speed Switching", of: 5, placed: null, at,
      series: [
        { verdict: "win", shadowRating: 1604, yourMatchScore: 0.021, theirMatchScore: 0.012 },
        { verdict: "loss", shadowRating: 1621, yourMatchScore: 0.004, theirMatchScore: 0.017 },
        { verdict: "win", shadowRating: 1611, yourMatchScore: 0.019, theirMatchScore: 0.008 },
      ],
    }, ctx()), "shadow-placing"),
    "shadow-placed": ok(shadowCardInput({
      category: "Speed Switching", of: 5, placed: tierByName("Lunar"), rating: 1617, percentile: me.percentile, at,
      series: [
        { verdict: "win", shadowRating: 1604, yourMatchScore: 0.021, theirMatchScore: 0.012 },
        { verdict: "loss", shadowRating: 1621, yourMatchScore: 0.004, theirMatchScore: 0.017 },
        { verdict: "win", shadowRating: 1611, yourMatchScore: 0.019, theirMatchScore: 0.008 },
        { verdict: "draw", shadowRating: 1619, yourMatchScore: 0.011, theirMatchScore: 0.011 },
        { verdict: "win", shadowRating: 1615, yourMatchScore: 0.026, theirMatchScore: 0.014 },
      ],
    }, ctx()), "shadow-placed"),
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
    "edge-shadow-ten": ok(shadowCardInput({
      category: "Evasive Switching", of: 10, placed: tierByName("Supernova"), rating: 2144, percentile: 99.6, at,
      series: Array.from({ length: 10 }, (_, i) => ({ verdict: (["win", "loss", "draw"] as const)[i % 3], shadowRating: 2000 + i * 17, yourMatchScore: 0.1234, theirMatchScore: -0.0567 })),
    }, ctx(LONG_ME)), "edge-shadow-ten"),
    "edge-shadow-first": ok(shadowCardInput({ category: null, of: 7, placed: null, at, series: [{ verdict: "loss", shadowRating: null }] }, ctx()), "edge-shadow-first"),
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
  ["shadow-placed", "landscape", "dark"],
  ["shadow-placing", "portrait", "dark"],
];
