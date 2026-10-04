/**
 * From a result the main process holds to the card that shows it.
 *
 * The client's rule is that main decides and the renderer is a pure view, and a share card
 * is the one view of a result that leaves the machine, so it is built only from main's
 * own record: the settle-match response as main received it, or the ghost result
 * ghostService booked. The renderer sends which card and which shape, never a number
 * (parseShareRequest drops anything else it sends). Pure, so validate:share can drive it
 * with real settlements and hold every printed figure against the record.
 *
 * Void is refused. A void did not count, and a picture of it with a verdict-sized
 * headline invites exactly the "but I won that" the void exists to prevent.
 */

import type { CardRound, CardTier, ShareCardInput } from "./shareCard.ts";

/** The parts of api.ts's SettledMatch a card reads. Structural, so core does not import the app. */
export interface SettledRecord {
  matchId: string;
  verdict: "win" | "loss" | "draw" | "void" | null;
  seeding?: boolean;
  rated?: boolean;
  tournament?: { name: string; label: string } | null;
  /** A Crown challenge or a race leg (settle-match's `arena` note). Unrated, like a tournament leg. */
  arena?: { kind: "crown" | "race"; race?: { opponentName: string } | null } | null;
  opponent?: { displayName: string } | null;
  category?: string;
  yourMatchScore: number | null;
  theirMatchScore: number | null;
  ratingAfter: number;
  ratingChange: number;
  rounds: {
    scenario: string;
    score: number;
    baseline: number;
    delta: number | null;
    opponentDelta: number | null;
    counted: boolean;
    excludedReason: string | null;
  }[];
}

export interface MatchRecord {
  settled: SettledRecord;
  /** When main received the settlement, epoch ms. */
  at: number;
  /** A duel this player sent: one-sided like a seeding match, but somebody has been named. */
  sentDuel: boolean;
}

/** The parts of a booked ghost result a card reads (core/ghost GhostResult plus its kind's name). */
export interface GhostRecord {
  id: string;
  verdict: "win" | "loss" | "draw" | "void";
  end: "complete" | "abandoned" | "expired";
  margin: number | null;
  at: number;
  rounds: {
    scenario: string;
    live: number | null;
    ghost: number;
    baseline: number;
    delta: number | null;
    ghostDelta: number;
    abandoned: boolean;
  }[];
  /** "last month's you", KIND_NAME in core/ghost. */
  against: string;
  /** The code post-ghost minted for this result, when it has. */
  code: string | null;
}

/** What main knows about the player that is not part of the result. */
export interface CardContext {
  playerName: string;
  season: string;
  /** The player's season rank from their own scores, as the Ranks screen shows it. */
  tier: CardTier | null;
}

export type Refusal = { refused: string };

/** Local calendar day, so a match settled at 23:30 is not dated tomorrow in UTC. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function matchCardInput(rec: MatchRecord, ctx: CardContext): ShareCardInput | Refusal {
  const s = rec.settled;
  if (s.verdict === "void") return { refused: "A void match did not count, so it has no card." };
  if (!s.rounds?.length) return { refused: "This result has no rounds to show." };

  // Seeding is decided by the flag and a missing verdict together, as renderSettled
  // decides it: a seeding match sent with a verdict still has nobody on the other side.
  const seeding = s.seeding === true || s.verdict == null;
  const rated = !seeding && !s.tournament && !s.arena && s.rated !== false;
  const opponent = !seeding && s.opponent ? { name: s.opponent.displayName } : null;

  const rounds: CardRound[] = s.rounds.map((r) => {
    const theirs = r.counted && finite(r.opponentDelta) ? r.opponentDelta : null;
    return {
      scenario: r.scenario,
      you: { score: finite(r.score) ? r.score : null, baseline: finite(r.baseline) ? r.baseline : null, delta: r.counted && finite(r.delta) ? r.delta : null },
      // The server sends the opponent's improvement and nothing else; the card says so
      // rather than printing a dash where their score would be.
      them: theirs === null ? null : { score: null, baseline: null, delta: theirs },
      excluded: r.counted ? null : "Excluded",
    };
  });

  const mode = s.tournament
    ? `Tournament · ${s.tournament.label}`
    : s.arena?.kind === "crown"
      ? "Crown challenge · unrated"
      : s.arena?.kind === "race"
        ? `Race${s.arena.race?.opponentName ? ` against ${s.arena.race.opponentName}` : ""} · unrated`
        : seeding && rec.sentDuel ? "Duel sent" : null;

  return {
    kind: "match",
    mode,
    season: ctx.season,
    category: s.category && s.category !== "Any" ? s.category : null,
    player: {
      name: ctx.playerName,
      tier: ctx.tier,
      rating: rated && finite(s.ratingAfter) ? s.ratingAfter : null,
      ratingChange: rated && finite(s.ratingChange) ? s.ratingChange : null,
      percentile: null,
    },
    opponent,
    verdict: seeding ? null : (s.verdict as "win" | "loss" | "draw"),
    matchScore: { you: finite(s.yourMatchScore) ? s.yourMatchScore : null, them: seeding || !finite(s.theirMatchScore) ? null : s.theirMatchScore },
    rounds,
    duelCode: null,
    playedAt: localDay(rec.at),
  };
}

export function ghostCardInput(rec: GhostRecord, ctx: CardContext): ShareCardInput | Refusal {
  if (rec.verdict === "void") return { refused: "A ghost match with no result has no card." };
  if (!rec.rounds?.length) return { refused: "This result has no rounds to show." };
  return {
    kind: "ghost",
    season: ctx.season,
    player: { name: ctx.playerName, tier: null },
    opponent: { name: rec.against },
    verdict: rec.verdict,
    matchScore: null,
    rounds: rec.rounds.map((r) => ({
      scenario: r.scenario,
      you: { score: r.live, baseline: r.baseline, delta: r.live === null || r.abandoned ? null : r.delta },
      them: { score: r.ghost, baseline: r.baseline, delta: r.ghostDelta },
      excluded: r.live === null ? "Not played" : r.abandoned ? "Left early" : null,
    })),
    duelCode: rec.code,
    playedAt: localDay(rec.at),
    ghost: { against: rec.against, margin: rec.margin, end: rec.end },
  };
}

export const SHARE_SOURCES = ["match", "ghost"] as const;
export const SHARE_LAYOUTS = ["landscape", "portrait"] as const;
export const SHARE_ACTIONS = ["preview", "copy", "save"] as const;

export interface ShareRequest {
  source: (typeof SHARE_SOURCES)[number];
  layout: (typeof SHARE_LAYOUTS)[number];
  action: (typeof SHARE_ACTIONS)[number];
}

/**
 * The only three things a renderer may say about a card. Every other field is dropped
 * here, so a renderer that sent a score would have it ignored rather than drawn.
 */
export function parseShareRequest(raw: unknown): ShareRequest | string {
  if (!raw || typeof raw !== "object") return "no request given";
  const r = raw as Record<string, unknown>;
  const pick = <T extends readonly string[]>(v: unknown, from: T): T[number] | null => (from as readonly unknown[]).includes(v) ? (v as T[number]) : null;
  const source = pick(r.source, SHARE_SOURCES);
  const layout = pick(r.layout ?? "landscape", SHARE_LAYOUTS);
  const action = pick(r.action, SHARE_ACTIONS);
  if (!source) return "unknown card";
  if (!layout) return "unknown layout";
  if (!action) return "unknown action";
  return { source, layout, action };
}

/** "2026-09-30-victory.png", "2026-09-30-ghost-out-of-time.png". */
export function shareFileName(input: ShareCardInput, headlineText: string): string {
  const slug = headlineText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "result";
  return `${input.playedAt ?? "apogee"}-${input.kind === "ghost" ? "ghost-" : ""}${slug}.png`;
}
