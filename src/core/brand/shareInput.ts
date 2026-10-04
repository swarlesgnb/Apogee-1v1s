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
  const rated = !seeding && !s.tournament && s.rated !== false;
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

  const mode = s.tournament ? `Tournament · ${s.tournament.label}` : seeding && rec.sentDuel ? "Duel sent" : null;

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

// ================================================================ the mechanic cards
//
// Four more cards, for the mechanics built in the fleet branches. Each has two types:
//
//   <Kind>Record     what main holds once the server has answered: the facts, no wording.
//                    The engineer who owns the mechanic builds one from the response and
//                    hands it to ShareCards.record<Kind>() in src/app/shareCard.ts.
//   <Kind>CardInput  what the drawing takes (mechanicCards.ts). <kind>CardInput() makes one
//                    from a record and the CardContext, or refuses with a reason.
//
// The renderer then asks for the card by name ("daily", "crown", "flag", "shadow"), a
// shape and an action, exactly as it does for "match": it never sends a figure.

export type MechanicCardKind = "daily" | "crown" | "flag" | "shadow";

/** One settled round as main holds it; the other side's raw numbers only when the server sent them. */
export interface SettledRound {
  scenario: string;
  score: number;
  baseline: number;
  delta: number | null;
  opponentDelta: number | null;
  /** Sent for the cards whose other side is a stored set (a crown, a flag); absent on settle-match. */
  opponentScore?: number | null;
  opponentBaseline?: number | null;
  counted: boolean;
  excludedReason: string | null;
}

/**
 * Settled rounds as card rounds, as matchCardInput maps them: a round that did not count
 * prints "Excluded" in place of a result, and a side whose raw numbers never reached main
 * prints that, not a dash. A crown or a flag is played against a stored set, so the other
 * side's raw score and baseline can be known; they print when they are sent.
 */
export function settledRounds(rounds: SettledRound[]): CardRound[] {
  return rounds.map((r) => {
    const theirs = r.counted && finite(r.opponentDelta) ? r.opponentDelta : null;
    return {
      scenario: r.scenario,
      you: { score: finite(r.score) ? r.score : null, baseline: finite(r.baseline) ? r.baseline : null, delta: r.counted && finite(r.delta) ? r.delta : null },
      // The server sends the opponent's improvement and nothing else; the card says so
      // rather than printing a dash where their score would be.
      them: theirs === null ? null : { score: finite(r.opponentScore) ? r.opponentScore : null, baseline: finite(r.opponentBaseline) ? r.opponentBaseline : null, delta: theirs },
      excluded: r.counted ? null : "Excluded",
    };
  });
}


/**
 * Where one daily scenario landed, in the social branch's own words (core/social/daily.ts
 * `Glyph`): above, near or below the player's own baseline; "first" for a first run with
 * no baseline yet (it stands as its own); "pending" for one not played.
 */
export type DailyMark = "above" | "near" | "below" | "first" | "pending";

export const DAILY_MARKS: readonly DailyMark[] = ["above", "near", "below", "first", "pending"];

/** Within this fraction of baseline either way is "near": core/social/daily.ts NEAR_BAND. */
export const DAILY_NEAR_BAND = 0.01;

/**
 * Apogee Daily, as main holds it once the day's scenarios are played. There is no scenario
 * name anywhere in this type, deliberately: the card is spoiler-free because it cannot be
 * handed a name to print, not because it promises to leave one out. The fields are the
 * Daily screen's (dailyService.ts `DailyScreen`), so a record is one line to build:
 * `{ number, band: band.name, marks: rounds.map((r) => r.glyph), meanDelta, streak, provisional }`.
 * No link: the Daily's landing URL runs to seventy characters, which no card can print
 * legibly and no image can make clickable. The text paste carries it; the card carries
 * the number and the band, which is what a reader types into the app.
 */
export interface DailyRecord {
  /** The daily's number, counted from the first daily: Apogee Daily #3. */
  number: number;
  /** The band the draw was made for ("Intermediate"): each band has its own daily. */
  band: string;
  /** One mark per scenario, in draw order, as core/social/daily.ts glyphFor() gave it. */
  marks: DailyMark[];
  /** Mean gain over own baselines across the rounds that had one; null when every round was a first run. */
  meanDelta: number | null;
  /** Consecutive days with a finished daily, this one included. */
  streak: number;
  /** A measured round leaned on fewer earlier runs than a settled baseline needs. */
  provisional?: boolean;
  /** The day, "2026-10-03"; the card prints it when given. */
  date?: string | null;
  /** The near band the daily used; DAILY_NEAR_BAND when absent. */
  nearBand?: number | null;
  /** Share of today's players in the band this result beats, 0..100, once the board knows it. */
  percentile?: number | null;
}

export interface DailyCardInput {
  kind: "daily";
  number: number;
  band: string;
  date: string | null;
  season: string;
  player: { name: string; tier?: CardTier | null };
  /** One mark per scenario in draw order (1 to 6). */
  marks: DailyMark[];
  nearBand: number;
  meanDelta: number | null;
  streak: number;
  provisional: boolean;
  percentile: number | null;
}

/** A crown changing hands or holding, as main holds it after the crown match settles. */
export interface CrownRecord {
  event: "taken" | "defended";
  /** The category the crown is held in, as the Crowns screen names it. */
  category: string;
  /** The band within it, as the Crowns screen names it ("Lunar", "1500-1650"); the card adds "band". */
  band: string;
  /** Taken: the holder it was taken from. Defended: the challenger who fell short. Null for a vacant crown. */
  rival: { displayName: string } | null;
  /** Successful defences in the current reign, this one included; 0 for a crown just taken. */
  defences: number;
  /** When the current reign began, ISO date. A crown just taken began today. */
  heldSince?: string | null;
  /** Taken: how many days the previous holder had held it. */
  rivalReignDays?: number | null;
  yourMatchScore: number | null;
  theirMatchScore: number | null;
  /** The deciding match from this player's side: you are the holder on a defence. */
  rounds: SettledRound[];
  /** When main received it, epoch ms. */
  at: number;
}

export interface CrownCardInput {
  kind: "crown";
  event: "taken" | "defended";
  season: string;
  category: string;
  band: string;
  player: { name: string; tier: CardTier | null };
  rival: { name: string } | null;
  defences: number;
  heldSince?: string | null;
  rivalReignDays?: number | null;
  matchScore: { you: number | null; them: number | null } | null;
  rounds: CardRound[];
  playedAt?: string | null;
}

/** A planted flag that somebody answered, as main holds it once the answer settles. */
export interface FlagRecord {
  /** From the planter's side: did the planted set hold? Void is refused. */
  verdict: "win" | "loss" | "draw" | "void";
  category?: string | null;
  challenger: { displayName: string };
  /** When the flag was planted and answered: ISO dates or epoch ms. */
  plantedAt: string | number;
  answeredAt: string | number;
  rated?: boolean;
  ratingAfter?: number | null;
  ratingChange?: number | null;
  yourMatchScore: number | null;
  theirMatchScore: number | null;
  /** The planted set (you) against the answer (them). */
  rounds: SettledRound[];
  /** The planter's other flags still standing after this one settled. */
  standing?: number | null;
}

export interface FlagCardInput {
  kind: "flag";
  verdict: "win" | "loss" | "draw";
  season: string;
  category: string | null;
  player: { name: string; tier: CardTier | null; rating?: number | null; ratingChange?: number | null };
  challenger: { name: string };
  plantedAt: string;
  answeredAt: string;
  matchScore: { you: number | null; them: number | null } | null;
  rounds: CardRound[];
  standing?: number | null;
}

/** One match against a Shadow in a placement series. */
export interface ShadowMatch {
  verdict: "win" | "loss" | "draw" | "void";
  /** The rating the Shadow was calibrated to for this match. */
  shadowRating?: number | null;
  yourMatchScore?: number | null;
  theirMatchScore?: number | null;
}

/** A placement series played against Shadows, as main holds it after each match settles. */
export interface ShadowRecord {
  category?: string | null;
  /** In the order played. Void matches did not count and are left off the card. */
  series: ShadowMatch[];
  /** How many counted matches the series needs. */
  of: number;
  /** The tier the series placed the player in, once it is complete; null while placing. */
  placed: CardTier | null;
  rating?: number | null;
  /** Share of the ladder this player beats, 0..100. */
  percentile?: number | null;
  at: number;
}

export interface ShadowCardInput {
  kind: "shadow";
  season: string;
  category: string | null;
  player: { name: string; tier: CardTier | null; rating?: number | null; percentile?: number | null };
  series: { verdict: "win" | "loss" | "draw"; shadowRating: number | null; matchScore: { you: number | null; them: number | null } | null }[];
  of: number;
  placed: CardTier | null;
  playedAt?: string | null;
}

export type MechanicCardInput = DailyCardInput | CrownCardInput | FlagCardInput | ShadowCardInput;

/** Any card the drawing takes: the result cards and the mechanic cards. */
export type AnyCardInput = ShareCardInput | MechanicCardInput;

export function isMechanicCard(input: AnyCardInput): input is MechanicCardInput {
  return input.kind === "daily" || input.kind === "crown" || input.kind === "flag" || input.kind === "shadow";
}

const isoDay = (v: string | number | null | undefined): string | null => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? localDay(v) : null;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
};
const clean = (s: unknown, max = 64): string => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
const matchScore = (you: number | null | undefined, them: number | null | undefined) =>
  finite(you) || finite(them) ? { you: finite(you) ? you : null, them: finite(them) ? them : null } : null;

export function dailyCardInput(rec: DailyRecord, ctx: CardContext): DailyCardInput | Refusal {
  if (!Number.isInteger(rec.number) || rec.number < 1) return { refused: "This daily has no number." };
  if (!Array.isArray(rec.marks) || rec.marks.length < 1) return { refused: "This daily has no scenarios." };
  if (rec.marks.length > 6) return { refused: "A daily card shows at most six scenarios." };
  if (!rec.marks.every((m) => DAILY_MARKS.includes(m))) return { refused: "This daily has a mark the card does not know." };
  if (rec.marks.every((m) => m === "pending")) return { refused: "Play today's daily to share it." };
  const band = finite(rec.nearBand) && rec.nearBand > 0 && rec.nearBand < 0.5 ? rec.nearBand : DAILY_NEAR_BAND;
  return {
    kind: "daily",
    number: rec.number,
    band: clean(rec.band, 32),
    date: isoDay(rec.date ?? null),
    season: ctx.season,
    player: { name: ctx.playerName, tier: ctx.tier },
    marks: [...rec.marks],
    nearBand: band,
    meanDelta: finite(rec.meanDelta) ? rec.meanDelta : null,
    streak: Number.isInteger(rec.streak) && rec.streak > 0 ? rec.streak : 1,
    provisional: rec.provisional === true,
    percentile: finite(rec.percentile) ? Math.max(0, Math.min(100, rec.percentile)) : null,
  };
}

export function crownCardInput(rec: CrownRecord, ctx: CardContext): CrownCardInput | Refusal {
  if (rec.event !== "taken" && rec.event !== "defended") return { refused: "Unknown crown event." };
  if (!rec.rounds?.length) return { refused: "This crown match has no rounds to show." };
  if (rec.event === "defended" && !rec.rival) return { refused: "A defence needs the challenger it held off." };
  return {
    kind: "crown",
    event: rec.event,
    season: ctx.season,
    category: clean(rec.category) || "Any",
    band: clean(rec.band, 32),
    player: { name: ctx.playerName, tier: ctx.tier },
    rival: rec.rival ? { name: clean(rec.rival.displayName) } : null,
    defences: Number.isInteger(rec.defences) && rec.defences > 0 ? rec.defences : 0,
    heldSince: isoDay(rec.heldSince ?? null) ?? (rec.event === "taken" ? localDay(rec.at) : null),
    rivalReignDays: finite(rec.rivalReignDays) && rec.rivalReignDays >= 0 ? Math.round(rec.rivalReignDays) : null,
    matchScore: matchScore(rec.yourMatchScore, rec.theirMatchScore),
    rounds: settledRounds(rec.rounds),
    playedAt: localDay(rec.at),
  };
}

export function flagCardInput(rec: FlagRecord, ctx: CardContext): FlagCardInput | Refusal {
  if (rec.verdict === "void") return { refused: "A void answer did not count, so it has no card." };
  if (!rec.rounds?.length) return { refused: "This flag has no rounds to show." };
  const plantedAt = isoDay(rec.plantedAt);
  const answeredAt = isoDay(rec.answeredAt);
  if (!plantedAt || !answeredAt) return { refused: "This flag is missing when it was planted or answered." };
  const rated = rec.rated !== false;
  return {
    kind: "flag",
    verdict: rec.verdict,
    season: ctx.season,
    category: rec.category && rec.category !== "Any" ? clean(rec.category) : null,
    player: {
      name: ctx.playerName,
      tier: ctx.tier,
      rating: rated && finite(rec.ratingAfter) ? rec.ratingAfter : null,
      ratingChange: rated && finite(rec.ratingChange) ? rec.ratingChange : null,
    },
    challenger: { name: clean(rec.challenger?.displayName) || "Challenger" },
    plantedAt,
    answeredAt,
    matchScore: matchScore(rec.yourMatchScore, rec.theirMatchScore),
    rounds: settledRounds(rec.rounds),
    standing: Number.isInteger(rec.standing) && (rec.standing as number) >= 0 ? rec.standing : null,
  };
}

export function shadowCardInput(rec: ShadowRecord, ctx: CardContext): ShadowCardInput | Refusal {
  const series = (rec.series ?? []).filter((m) => m.verdict !== "void").map((m) => ({
    verdict: m.verdict as "win" | "loss" | "draw",
    shadowRating: finite(m.shadowRating) ? Math.round(m.shadowRating) : null,
    matchScore: matchScore(m.yourMatchScore, m.theirMatchScore),
  }));
  if (!series.length) return { refused: "Play a Shadow match to share the placement." };
  const of = Number.isInteger(rec.of) && rec.of >= series.length ? rec.of : series.length;
  if (of > 10) return { refused: "A placement card shows at most ten matches." };
  return {
    kind: "shadow",
    season: ctx.season,
    category: rec.category && rec.category !== "Any" ? clean(rec.category) : null,
    player: {
      name: ctx.playerName,
      tier: rec.placed ?? ctx.tier,
      rating: finite(rec.rating) ? rec.rating : null,
      percentile: finite(rec.percentile) ? Math.max(0, Math.min(100, rec.percentile)) : null,
    },
    series,
    of,
    // A tier before the series is done would be a placement the server has not made.
    placed: series.length >= of ? rec.placed ?? null : null,
    playedAt: localDay(rec.at),
  };
}

export const SHARE_SOURCES = ["match", "ghost", "daily", "crown", "flag", "shadow"] as const;
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

/** "2026-09-30-victory.png", "2026-09-30-ghost-out-of-time.png", "2026-10-03-daily-212.png". */
export function shareFileName(input: AnyCardInput, headlineText: string): string {
  const slug = headlineText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "result";
  const day = input.kind === "daily" ? input.date : input.kind === "flag" ? input.answeredAt : input.playedAt;
  if (input.kind === "daily") return `${day ?? "apogee"}-daily-${input.number}.png`;
  const prefix = input.kind === "ghost" ? "ghost-" : input.kind === "shadow" ? "shadow-" : "";
  return `${day ?? "apogee"}-${prefix}${slug}.png`;
}
