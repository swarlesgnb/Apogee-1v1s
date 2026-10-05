/**
 * What a client is told about the Crowns.
 *
 * Declared in the core and imported by both the Edge Function that builds it and the
 * client that draws it, the arrangement `tournament/view.ts` uses, for its reason: a shape
 * written out twice is a renamed field that compiles on both sides and arrives undefined.
 *
 * WHAT IS IN IT, AND WHY THAT IS ENOUGH
 *
 * The holder's name, their match score (the bar to beat), the weakest verification tier
 * among their three runs, how long they have held it and how many people failed to take
 * it. Not their raw scores, baselines or per-round deltas: the bar is the one number a
 * challenger needs, and the rest is theirs.
 *
 * Showing the bar before a challenge is deliberate, and is the opposite of the duel rule
 * (PLAN.md §6) for a reason. A duel recipient who saw the score first could pick only the
 * duels they expect to win, and every duel they skipped would cost the sender. Picking the
 * Crown with the lowest bar costs nobody anything: a low bar is supposed to fall. That is
 * the game.
 */

import {
  CHALLENGE_COOLDOWN_MS,
  CROWN_TIERS,
  crownName,
  noticeText,
  REIGN_CAP_MS,
  type NoticeKind,
  type RunTier,
} from "./crowns.ts";

export interface CrownHistoryEntry {
  holder: string;
  startedAt: string;
  endedAt: string;
  defences: number;
  endReason: "dethroned" | "lapsed" | "reset";
  /** Who took it, for a dethroning. */
  endedBy: string | null;
  bar: number;
}

export type CrownAction =
  | { kind: "challenge"; label: string }
  | { kind: "claim"; label: string }
  | { kind: "yours"; label: string }
  | { kind: "cooldown"; label: string; availableAt: string }
  | { kind: "playing"; label: string; matchId: string }
  | { kind: "busy"; label: string };

export interface CrownCard {
  key: string;
  category: string;
  window: number;
  band: string;
  name: string;
  status: "held" | "vacant";
  cycle: number;
  /** The three, by name. Null until the first claim of a cycle draws them. */
  scenarios: string[] | null;
  holder: { playerId: string; name: string; you: boolean } | null;
  /** The holder's match score: what a challenger has to beat by more than a draw. */
  bar: number | null;
  tier: RunTier | null;
  provisional: boolean;
  heldSince: string | null;
  reignEndsAt: string | null;
  defences: number;
  challenges: number;
  /** Challenges being played against it right now. */
  live: number;
  history: CrownHistoryEntry[];
  action: CrownAction;
}

export interface CrownNoticeView {
  id: string;
  kind: NoticeKind;
  category: string;
  window: number;
  crown: string;
  text: string;
  otherName: string | null;
  defences: number;
  /**
   * The two match scores the decision compared, as the notice row stores them: on a
   * defence, the challenger who fell short and the holder's bar. The owner can already read
   * them from crown_notices directly; the board carries them so a defence can be shared.
   */
  challengerScore: number | null;
  holderScore: number | null;
  createdAt: string;
}

export interface CrownBoard {
  season: string;
  bands: { index: number; name: string }[];
  categories: string[];
  crowns: CrownCard[];
  notices: CrownNoticeView[];
  /** How many Crowns the viewer holds. */
  holding: number;
  rules: { reignCapDays: number; cooldownHours: number; tiers: string[] };
  now: string;
}

export interface BoardReign {
  id: string;
  holderId: string;
  matchScore: number;
  startedAt: number;
  defences: number;
  challenges: number;
  lowestTier: RunTier;
  provisional: boolean;
}

export interface BoardRow {
  category: string;
  window: number;
  cycle: number;
  scenarioIds: number[] | null;
  reign: BoardReign | null;
  live: number;
}

export interface BoardHistoryRow {
  category: string;
  window: number;
  holderId: string;
  startedAt: number;
  endedAt: number;
  defences: number;
  endReason: "dethroned" | "lapsed" | "reset";
  endedBy: string | null;
  matchScore: number;
}

export interface BoardNoticeRow {
  id: string;
  kind: NoticeKind;
  category: string;
  window: number;
  defences: number;
  reignMs: number;
  otherName: string | null;
  challengerScore?: number | null;
  holderScore?: number | null;
  createdAt: number;
}

export interface BoardInput {
  season: string;
  /** Window names, by index. */
  bands: string[];
  /** Every (category, window) the season can hold a Crown in. */
  cells: { category: string; window: number }[];
  rows: BoardRow[];
  history: BoardHistoryRow[];
  names: Map<string, string>;
  scenarioNames: Map<number, string>;
  viewerId: string;
  now: number;
  /** The viewer's most recent challenge on each Crown, by key. */
  lastChallenge: Map<string, number>;
  /** The viewer's challenge being played now, if they have one. */
  openChallenge: { key: string; matchId: string } | null;
  /** The viewer has a match open that is not a Crown challenge. */
  viewerBusy: boolean;
  notices: BoardNoticeRow[];
}

export const crownKey = (category: string, window: number) => `${category}|${window}`;

const HISTORY_SHOWN = 5;

const iso = (ms: number) => new Date(ms).toISOString();

function displayName(names: Map<string, string>, id: string | null | undefined): string {
  if (!id) return "player";
  return names.get(id) ?? "player";
}

export function buildBoard(input: BoardInput): CrownBoard {
  const rowByKey = new Map(input.rows.map((r) => [crownKey(r.category, r.window), r]));
  const bandName = (w: number) => input.bands[w] ?? `Band ${w + 1}`;

  const crowns: CrownCard[] = input.cells.map(({ category, window }) => {
    const key = crownKey(category, window);
    const row = rowByKey.get(key);
    const reign = row?.reign ?? null;
    const you = reign?.holderId === input.viewerId;

    let action: CrownAction;
    const last = input.lastChallenge.get(key);
    if (input.openChallenge?.key === key) {
      action = { kind: "playing", label: "Your challenge is open", matchId: input.openChallenge.matchId };
    } else if (you) {
      action = { kind: "yours", label: "You hold this Crown" };
    } else if (last != null && input.now - last < CHALLENGE_COOLDOWN_MS) {
      action = { kind: "cooldown", label: "Challenged today", availableAt: iso(last + CHALLENGE_COOLDOWN_MS) };
    } else if (input.viewerBusy || input.openChallenge) {
      action = { kind: "busy", label: "Finish your current match first" };
    } else {
      action = reign ? { kind: "challenge", label: "Challenge" } : { kind: "claim", label: "Claim" };
    }

    const history = input.history
      .filter((h) => h.category === category && h.window === window)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, HISTORY_SHOWN)
      .map((h) => ({
        holder: displayName(input.names, h.holderId),
        startedAt: iso(h.startedAt),
        endedAt: iso(h.endedAt),
        defences: h.defences,
        endReason: h.endReason,
        endedBy: h.endedBy ? displayName(input.names, h.endedBy) : null,
        bar: h.matchScore,
      }));

    return {
      key,
      category,
      window,
      band: bandName(window),
      name: crownName(category, bandName(window)),
      status: reign ? "held" : "vacant",
      cycle: row?.cycle ?? 0,
      scenarios: row?.scenarioIds ? row.scenarioIds.map((id) => input.scenarioNames.get(id) ?? `scenario ${id}`) : null,
      holder: reign ? { playerId: reign.holderId, name: displayName(input.names, reign.holderId), you } : null,
      bar: reign ? reign.matchScore : null,
      tier: reign ? reign.lowestTier : null,
      provisional: reign ? reign.provisional : false,
      heldSince: reign ? iso(reign.startedAt) : null,
      reignEndsAt: reign ? iso(reign.startedAt + REIGN_CAP_MS) : null,
      defences: reign?.defences ?? 0,
      challenges: reign?.challenges ?? 0,
      live: row?.live ?? 0,
      history,
      action,
    };
  });

  const notices: CrownNoticeView[] = input.notices
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      category: n.category,
      window: n.window,
      crown: crownName(n.category, bandName(n.window)),
      text: noticeText(n, bandName(n.window), n.otherName),
      otherName: n.otherName,
      defences: n.defences,
      challengerScore: Number.isFinite(n.challengerScore) ? (n.challengerScore as number) : null,
      holderScore: Number.isFinite(n.holderScore) ? (n.holderScore as number) : null,
      createdAt: iso(n.createdAt),
    }));

  const categories = [...new Set(input.cells.map((c) => c.category))];
  const windows = [...new Set(input.cells.map((c) => c.window))].sort((a, b) => a - b);

  return {
    season: input.season,
    bands: windows.map((index) => ({ index, name: bandName(index) })),
    categories,
    crowns,
    notices,
    holding: crowns.filter((c) => c.holder?.you).length,
    rules: {
      reignCapDays: REIGN_CAP_MS / 86_400_000,
      cooldownHours: CHALLENGE_COOLDOWN_MS / 3_600_000,
      tiers: [...CROWN_TIERS],
    },
    now: iso(input.now),
  };
}

/**
 * What the result screen says about a settled challenge.
 *
 * Built from the challenge row the database decided, never from the verdict the client
 * was shown: a challenge is judged against whoever holds the Crown when it settles, and
 * that can be somebody other than the holder the challenger set out against.
 */
export interface CrownResultNote {
  kind: "crown";
  outcome: "took" | "defended" | "void" | "forfeit" | "stale" | "pending";
  crown: string;
  category: string;
  window: number;
  claim: boolean;
  /** The holder it was judged against, when it was judged against one. */
  holderName: string | null;
  /** True when the Crown changed hands while the challenge was played. */
  judgedAgainstNewHolder: boolean;
  challengerScore: number | null;
  holderScore: number | null;
  /** Defences of the reign it was judged against, after this challenge. */
  defences: number | null;
  headline: string;
  explanation: string;
}

const pct = (v: number | null) =>
  v == null || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

export function crownResultNote(input: {
  outcome: CrownResultNote["outcome"];
  category: string;
  window: number;
  band: string;
  claim: boolean;
  holderName: string | null;
  judgedAgainstNewHolder: boolean;
  challengerScore: number | null;
  holderScore: number | null;
  defences: number | null;
  reason?: string | null;
}): CrownResultNote {
  const crown = crownName(input.category, input.band);
  const you = pct(input.challengerScore);
  const bar = pct(input.holderScore);
  const holder = input.holderName ?? "the holder";
  const moved = input.judgedAgainstNewHolder
    ? ` The Crown changed hands while you played, so you were measured against ${holder}, the holder when your result came in.`
    : "";
  let headline: string;
  let explanation: string;
  switch (input.outcome) {
    case "took":
      headline = `You took the ${crown}.`;
      explanation = input.claim || input.holderScore == null
        ? `It was vacant, and your run set (${you} against your baselines) is now the one to beat. Nothing was rated.`
        : `${you} against your baselines beat ${holder}'s ${bar}. Your run set is now the one to beat. Nothing was rated.${moved}`;
      break;
    case "defended":
      headline = `${holder} keeps the ${crown}.`;
      explanation = (input.challengerScore != null && input.holderScore != null &&
        Math.abs(input.challengerScore - input.holderScore) < 0.0005
        ? `${you} drew with ${holder}'s ${bar}, and a draw is a defence.`
        : `${you} against your baselines did not beat ${holder}'s ${bar}.`) +
        ` You can challenge it again in 20 hours. Nothing was rated.${moved}`;
      break;
    case "forfeit":
      headline = `Challenge forfeited.`;
      explanation = `The ${crown} challenge was abandoned or ran out of time. It used today's challenge on this Crown. Nothing was rated.`;
      break;
    case "stale":
      headline = `The ${crown} moved on.`;
      explanation = `The Crown was reset onto new scenarios while you played, so this run set cannot be measured against it. Nothing was rated.`;
      break;
    case "pending":
      headline = `${crown} challenge recorded.`;
      explanation = `Your result is in. The Crown decision has not been read back yet; the Crowns screen shows it.`;
      break;
    default:
      headline = `This challenge did not count.`;
      explanation = `${input.reason ? input.reason[0].toUpperCase() + input.reason.slice(1) : "The match did not count"}, so the ${crown} was not at stake. It used today's challenge on this Crown. Nothing was rated.`;
  }
  return {
    kind: "crown",
    outcome: input.outcome,
    crown,
    category: input.category,
    window: input.window,
    claim: input.claim,
    holderName: input.holderName,
    judgedAgainstNewHolder: input.judgedAgainstNewHolder,
    challengerScore: input.challengerScore,
    holderScore: input.holderScore,
    defences: input.defences,
    headline,
    explanation,
  };
}
