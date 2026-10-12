/**
 * Render share cards: every sample to .cache/brand/cards, three of them to
 * assets/brand/samples.
 *
 *   npm run brand:cards                    the samples below, both layouts, both themes
 *   npm run brand:cards -- result.json     one ShareCardInput from a file, same four renders
 *
 * The samples are built from data/snapshot.json, the same player state the UI preview is
 * built from, so the scenario names, the player's raw scores, rating, percentile and tier
 * are real. What a single player's stats folder cannot hold is the other side of a match
 * and the baseline at the moment of play, so those are constructed exactly as snapshot.ts
 * constructs its demo opponent (a baseline 3% under the player's, a fixed spread of
 * deltas), and every verdict, delta and match score is then computed by the real
 * settleMatch() and the rating change by the real updateRating(), not typed in. A sample
 * that disagreed with how a match actually settles would be a sample of a bug.
 *
 * The cases are chosen to break the layout: a loss on more raw points (the confusion the
 * card exists to answer), a seeding match with no opponent yet, a draw, a promotion,
 * placements, and a player whose name and scenarios are as long as the client allows.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { anyCardSvg } from "../../src/core/brand/mechanicCards.ts";
import { palettes } from "../../src/core/brand/palette.ts";
import {
  FIT_TEXT_SCRIPT,
  SHARE_CARD_SIZES,
  type CardLayout,
  type CardRound,
  type CardTier,
  type ShareCardInput,
} from "../../src/core/brand/shareCard.ts";
import type { AnyCardInput } from "../../src/core/brand/shareInput.ts";
import { settleMatch, type RoundSubmission } from "../../src/core/match/settle.ts";
import { updateRating } from "../../src/core/rating/glicko2.ts";
import { emblem, ensureDir, rasterize, root, tiers, tokens, withFonts, type RasterJob } from "./kit.ts";
import { MECHANIC_COMMITTED, mechanicSamples } from "./mechanicSamples.ts";

const P = palettes(tokens);

/** A card as a finished SVG: fonts embedded, the fit script riding along for the rasteriser. */
export function cardSvg(input: AnyCardInput, layout: CardLayout, theme: "dark" | "light"): string {
  const svg = anyCardSvg(input, { layout, palette: P[theme], emblem });
  return withFonts(svg).replace("</svg>", `<script type="text/fit">${FIT_TEXT_SCRIPT}</script></svg>`);
}

// ------------------------------------------------------------------ samples

interface SnapshotScenario { name: string; label: string; score: number; runs: number }
interface Snapshot {
  generatedAt: string;
  player: { apogee: { rating: number; rd: number; percentile: number; tier: CardTier } };
  categories: { name: string; scenarios: SnapshotScenario[] }[];
  match: { category: string; opponent: { name: string; rating: number; tier: CardTier } };
}

const snap = JSON.parse(readFileSync(join(root, "data", "snapshot.json"), "utf8")) as Snapshot;
const me = snap.player.apogee;
const tierByName = (n: string) => {
  const t = tiers.find((x) => x.name === n);
  if (!t) throw new Error(`no tier named ${n}`);
  return { id: t.id, name: t.name, color: t.color };
};

/** Three played scenarios from a category, in the order the snapshot lists them. */
function played(category: string, skip = 0): SnapshotScenario[] {
  const c = snap.categories.find((x) => x.name === category);
  if (!c) throw new Error(`snapshot has no ${category}`);
  const out = c.scenarios.filter((s) => s.runs > 0 && s.score > 0).slice(skip, skip + 3);
  if (out.length < 3) throw new Error(`snapshot has fewer than three played ${category} scenarios`);
  return out;
}

function submission(id: number, name: string, score: number, baseline: number): RoundSubmission {
  return { scenarioId: id, scenarioName: name, score, baseline, provisional: false, verificationTier: "verified" };
}

/**
 * A match from real scores. `mine` is the player's gain over their baseline per round;
 * `theirs` the opponent's, or null for a seeding match with no second side.
 */
function match(
  category: string,
  mine: number[],
  theirs: number[] | null,
  opponent: { name: string; tier: string; rating: number } | null,
  extra: Partial<ShareCardInput> = {},
  skip = 0,
): ShareCardInput {
  const scenarios = played(category, skip);
  const you = scenarios.map((s, i) => submission(i, s.name, s.score, Math.round(s.score / (1 + mine[i]))));
  const them = theirs
    ? scenarios.map((s, i) => {
        const base = you[i].baseline * 0.97;
        return submission(i, s.name, Math.round(base * (1 + theirs[i])), Math.round(base));
      })
    : null;
  const settled = them ? settleMatch({ playerRounds: you, opponentRounds: them }) : null;
  const rounds: CardRound[] = scenarios.map((s, i) => ({
    scenario: s.label,
    you: { score: you[i].score, baseline: you[i].baseline, delta: settled ? settled.player.rounds[i].delta : (you[i].score - you[i].baseline) / you[i].baseline },
    them: settled && them ? { score: them[i].score, baseline: them[i].baseline, delta: settled.opponent.rounds[i].delta } : null,
  }));
  let verdict: ShareCardInput["verdict"] = null;
  let ratingChange: number | null = null;
  if (settled && opponent && settled.verdict !== "void") {
    verdict = settled.verdict;
    const score = verdict === "win" ? 1 : verdict === "loss" ? 0 : 0.5;
    const before = { rating: me.rating, rd: me.rd, volatility: 0.06 };
    ratingChange = (updateRating(before, [{ opponent: { rating: opponent.rating, rd: 85, volatility: 0.06 }, score }]).rating - me.rating) * settled.ratingWeight;
  }
  return {
    kind: "match",
    season: "Season 1",
    category,
    player: { name: "rylee", tier: me.tier, rating: me.rating + (ratingChange ?? 0), ratingChange, percentile: me.percentile },
    opponent: opponent ? { name: opponent.name, tier: tierByName(opponent.tier) } : null,
    verdict,
    matchScore: settled ? { you: settled.player.matchScore, them: settled.opponent.matchScore } : null,
    rounds,
    playedAt: snap.generatedAt,
    ...extra,
  };
}

const opp = { name: snap.match.opponent.name, tier: snap.match.opponent.tier.name, rating: snap.match.opponent.rating };

const SAMPLES: Record<string, ShareCardInput> = {
  // The snapshot's own demo: more raw points on every round, and a loss.
  "defeat-more-points": match(snap.match.category, [0.006, 0.004, 0.002], [0.031, -0.012, 0.018], opp, { duelCode: "RVN-4K2" }),
  victory: match("Precise Tracking", [0.046, 0.012, 0.027], [0.018, 0.021, -0.006], { name: "orbitwalker", tier: "Odyssey", rating: 1688 }, { duelCode: "ORB-77Q" }),
  draw: match("Static Clicking", [0.02, -0.01, 0.015], [0.02, -0.01, 0.015], { name: "kestrel", tier: "Lunar", rating: 1602 }),
  seeding: match("Reactive Tracking", [0.012, -0.004, 0.031], null, null, { duelCode: "PNG-3D1" }),
  promotion: {
    ...match("Dynamic Clicking", [0.052, 0.031, 0.044], [0.011, 0.02, 0.006], { name: "tardigrade_main", tier: "Lunar", rating: 1631 }),
    kind: "rank",
    promotion: { from: tierByName("Lunar"), to: tierByName("Odyssey") },
    player: { name: "rylee", tier: tierByName("Odyssey"), rating: 1702, ratingChange: 17, percentile: 51.2 },
  },
  placed: {
    ...match("Evasive Switching", [0.008, 0.021, -0.013], [0.004, 0.017, 0.009], { name: "skeet_season", tier: "Cosmonaut", rating: 1540 }),
    kind: "rank",
    promotion: { from: null, to: tierByName("Cosmonaut") },
    player: { name: "rylee", tier: tierByName("Cosmonaut"), rating: 1561, ratingChange: null, percentile: 27.4 },
  },
  // As long as a Steam name and the season's scenario labels get. The client allows 32
  // characters for a display name.
  "long-names": {
    ...match("Speed Switching", [0.121, -0.083, 0.004], [-0.052, 0.14, 0.0041], { name: "ThisIsAThirtyTwoCharacterHandle!", tier: "Supernova", rating: 2101 }, { duelCode: "WWWW-WWWW-WW" }, 0),
    player: { name: "AnotherVeryLongDisplayNameHere..", tier: tierByName("Supernova"), rating: 2144, ratingChange: 9, percentile: 99.6 },
    rounds: [
      { scenario: "Apogee Constellation Intermediate Advanced", you: { score: 123456.7, baseline: 110131, delta: 0.1210 }, them: { score: 98765.4, baseline: 104184, delta: -0.052 } },
      { scenario: "Shooting Stars Advanced", you: { score: 1012, baseline: 1104, delta: -0.0833 }, them: { score: 1258, baseline: 1103, delta: 0.1405 } },
      { scenario: "CockpiTS Intermediate", you: { score: 3238, baseline: 3225, delta: 0.004 }, them: { score: 3141, baseline: 3128, delta: 0.0041 } },
    ],
  },
};

/** The three result cards committed, and why: one of each thing a card has to do. */
const COMMITTED: [string, CardLayout, "dark" | "light"][] = [
  // The hard case: a loss on more raw points, and the card still makes it make sense.
  ["defeat-more-points", "landscape", "dark"],
  // A promotion is what people actually post, and a story is where they post it.
  ["promotion", "portrait", "dark"],
  // The light palette, on the result a player most wants to share.
  ["victory", "landscape", "light"],
];

// ------------------------------------------------------------------ render

const arg = process.argv[2];
// The mechanic cards (Daily, Crown, Flag, Shadow) ride along with the result cards: built
// in mechanicSamples.ts from records through the real adapters.
const ALL: Record<string, AnyCardInput> = { ...SAMPLES, ...mechanicSamples() };
const inputs: Record<string, AnyCardInput> = arg && existsSync(arg)
  ? { [arg.replace(/.*[\\/]/, "").replace(/\.json$/, "")]: JSON.parse(readFileSync(arg, "utf8")) as AnyCardInput }
  : ALL;

const out = join(root, ".cache", "brand", "cards");
const jobs: RasterJob[] = [];
for (const [name, input] of Object.entries(inputs)) {
  for (const layout of ["landscape", "portrait"] as const) {
    for (const theme of ["dark", "light"] as const) {
      const { width, height } = SHARE_CARD_SIZES[layout];
      const base = join(out, `${name}-${layout}-${theme}`);
      jobs.push({ svg: cardSvg(input, layout, theme), svgOut: ensureDir(`${base}.svg`), pngOut: `${base}.png`, width, height });
    }
  }
}
console.log(`share cards: ${Object.keys(inputs).length} result(s), ${jobs.length} renders`);
rasterize(jobs, "cards");

if (inputs === ALL) {
  for (const [name, layout, theme] of [...COMMITTED, ...MECHANIC_COMMITTED]) {
    const from = join(out, `${name}-${layout}-${theme}.png`);
    copyFileSync(from, ensureDir(join(root, "assets", "brand", "samples", `${name}-${layout}-${theme}.png`)));
  }
  console.log(`  committed ${COMMITTED.length + MECHANIC_COMMITTED.length} to assets/brand/samples; all ${jobs.length} in .cache/brand/cards`);
}
