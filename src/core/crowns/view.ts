/**
 * What a client is told about the Crowns.
 *
 * Declared in the core and imported by both the Edge Function that builds it and the
 * client that draws it, the arrangement `tournament/view.ts` uses, for its reason: a shape
 * written out twice is a renamed field that compiles on both sides and arrives undefined.
 *
 * WHAT IS IN IT, AND WHY THAT IS ENOUGH
 *
 * The holder's name, the weakest verification tier among their three runs, how long they
 * have held it, how many people failed to take it, and what taking it needs: more of the
 * three rounds on raw score. Not the holder's raw scores. Those are sealed from a
 * challenger round by round until the challenger's own run on that scenario lands (the live
 * view in race-status applies the rule), so the board cannot carry them. Nor their
 * baselines or deltas: since ranked v2 a delta decides nothing, and it is theirs.
 *
 * An ended reign is history, and its result is shown as the round tally that ended it.
 */

import {
  CHALLENGE_COOLDOWN_MS,
  CROWN_TIERS,
  crownName,
  noticeText,
  REIGN_CAP_MS,
  tally,
  tallyText,
  type NoticeKind,
  type RunTier,
  type Tally,
} from "./crowns.ts";

export interface CrownHistoryEntry {
  holder: string;
  startedAt: string;
  endedAt: string;
  defences: number;
  endReason: "dethroned" | "lapsed" | "reset";
  /** Who took it, for a dethroning. */
  endedBy: string | null;
  /** The round tally that ended it, from the taker's side ("2-1"), for a dethroning. */
  takenOn: string | null;
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
  /** What taking it needs, said as a rule: the holder's scores stay sealed until yours land. */
  toTake: string | null;
  /** How many rounds (scenarios) a challenge is. */
  rounds: number;
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
  /** Rounds the taker won and lost against this reign, for a dethroning. */
  endedWon: number | null;
  endedLost: number | null;
}

export interface BoardNoticeRow {
  id: string;
  kind: NoticeKind;
  category: string;
  window: number;
  defences: number;
  reignMs: number;
  otherName: string | null;
  createdAt: number;
  challengerRounds?: number | null;
  holderRounds?: number | null;
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
        takenOn: h.endReason === "dethroned" && h.endedWon != null && h.endedLost != null ? `${h.endedWon}\u2013${h.endedLost}` : null,
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
      toTake: reign ? "Win more of the three rounds than the holder, on raw score. A tie on rounds keeps the Crown where it is." : null,
      rounds: row?.scenarioIds?.length ?? 3,
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
  /**
   * The rounds against the holder it was judged against, raw score against raw score.
   * Every round of the challenger's has landed by the time there is a decision, so none of
   * the holder's numbers is sealed any more. Null for a claim, a void or a forfeit.
   */
  rounds: { scenario: string; you: number; holder: number; result: "won" | "lost" | "tied" }[] | null;
  tally: Tally | null;
  /** Defences of the reign it was judged against, after this challenge. */
  defences: number | null;
  headline: string;
  explanation: string;
}

export function crownResultNote(input: {
  outcome: CrownResultNote["outcome"];
  category: string;
  window: number;
  band: string;
  claim: boolean;
  holderName: string | null;
  judgedAgainstNewHolder: boolean;
  /** Scenario names, in round order. */
  scenarios: string[];
  challengerScores: number[] | null;
  holderScores: number[] | null;
  defences: number | null;
  reason?: string | null;
}): CrownResultNote {
  const crown = crownName(input.category, input.band);
  const holder = input.holderName ?? "the holder";
  const moved = input.judgedAgainstNewHolder
    ? ` The Crown changed hands while you played, so you were measured against ${holder}, the holder when your result came in.`
    : "";
  const paired = input.challengerScores && input.holderScores &&
    input.challengerScores.length === input.holderScores.length && input.challengerScores.length > 0;
  const rounds = paired
    ? input.challengerScores!.map((you, i) => {
        const h = input.holderScores![i];
        return { scenario: input.scenarios[i] ?? `round ${i + 1}`, you, holder: h, result: (you > h ? "won" : you < h ? "lost" : "tied") as "won" | "lost" | "tied" };
      })
    : null;
  const t = paired ? tally(input.challengerScores!, input.holderScores!) : null;
  let headline: string;
  let explanation: string;
  switch (input.outcome) {
    case "took":
      headline = `You took the ${crown}.`;
      explanation = input.claim || !t
        ? `It was vacant, and your three scores are now the ones to beat. Nothing was rated.`
        : `You won ${tallyText(t)} on rounds against ${holder}. Your three scores are now the ones to beat. Nothing was rated.${moved}`;
      break;
    case "defended":
      headline = `${holder} keeps the ${crown}.`;
      explanation = (t && t.won === t.lost
        ? `${tallyText(t)} on rounds against ${holder}, and a tie on rounds is a defence.`
        : t ? `You won ${t.won} of ${t.won + t.lost + t.tied} rounds against ${holder}; taking the Crown needs more rounds won than lost.`
        : `Your rounds did not take it from ${holder}.`) +
        ` You can challenge it again in 20 hours. Nothing was rated.${moved}`;
      break;
    case "forfeit":
      headline = `Challenge forfeited.`;
      explanation = `The ${crown} challenge was abandoned or ran out of time. It used today's challenge on this Crown. Nothing was rated.`;
      break;
    case "stale":
      headline = `The ${crown} moved on.`;
      explanation = `The Crown was reset onto new scenarios while you played, so these rounds cannot be measured against it. Nothing was rated.`;
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
    rounds: input.outcome === "took" || input.outcome === "defended" ? rounds : null,
    tally: input.outcome === "took" || input.outcome === "defended" ? t : null,
    defences: input.defences,
    headline,
    explanation,
  };
}
