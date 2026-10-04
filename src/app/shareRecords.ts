/**
 * The mechanic share cards' records, built in main from what the server already sent.
 *
 * Each mechanic's card is drawn from a record main holds (src/app/shareCard.ts), never from
 * anything the renderer says. This file turns three server answers into those records:
 *
 *   Shadow   settle-match's `shadow` body for the match just played, then the queue
 *            board's Shadow ladder (`shadow.recent`, `placement`, `streak`) read after it
 *   Flag     the queue board's newest answered Flag (the news it announces)
 *   Crown    a Crown taken (settle-match's `arena.crown` note, from the challenger's side)
 *            or defended (list-crowns' newest unread `defended` notice, from the holder's)
 *
 * Every record carries a key naming the result it is of. Main sends the keys to the
 * renderer (apogee:shareRecords), and each screen offers Share only beside the result whose
 * key main holds, so the card a player previews is the card of the thing they are looking
 * at. Pure apart from the sink, so validate:share drives it with server-shaped payloads.
 */

import type { CrownRecord, FlagRecord, SettledRound, ShadowMatch, ShadowRecord } from "../core/brand/shareInput.ts";
import type { CrownBoard, CrownResultNote } from "../core/crowns/view.ts";
import type { QueueBoard, SettledMatch } from "./api.ts";

/** Where records go: ShareCards, or a fake in a test. */
export interface RecordSink {
  recordShadow(rec: ShadowRecord | null, key?: string | null): void;
  recordFlag(rec: FlagRecord | null, key?: string | null): void;
  recordCrown(rec: CrownRecord | null, key?: string | null): void;
}

/** settle-match's body, with the Crown note settle-match adds for an unrated arena match. */
export type SettledWithArena = SettledMatch & { arena?: { kind: "crown" | "race"; crown?: CrownResultNote | null } | null };

export interface Keyed<T> {
  key: string;
  record: T;
}

const SHADOW_RESULTS = ["win", "loss", "draw", "void", "forfeit"] as const;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The Shadow record for a settled Shadow match, with the board's ladder when the board read
 * after it is the one that already counts it (its newest result is this match's ordinal).
 * Without that board the record holds this match alone and no placement, which the card
 * draws as "Shadow ladder" rather than guessing at a read-out. Null for a match that was not
 * against a Shadow, or one that did not count.
 */
export function shadowRecord(settled: SettledMatch, board: QueueBoard | null, at = Date.now()): Keyed<ShadowRecord> | null {
  const sh = settled.shadow;
  if (!sh || !finite(sh.percentile) || (sh.verdict !== "win" && sh.verdict !== "loss" && sh.verdict !== "draw")) return null;
  const latest: ShadowMatch = { verdict: sh.verdict, percentile: sh.percentile, yourMatchScore: sh.yourScore, shadowScore: sh.shadowScore };
  const ladder = board?.shadow;
  const counted = !!ladder && ladder.recent?.[0]?.ordinal === sh.ordinal;
  if (!counted) return { key: settled.matchId, record: { category: settled.category ?? null, series: [latest], at } };
  // `recent` is newest first and starts with this match; the card wants play order.
  const earlier: ShadowMatch[] = ladder.recent.slice(1).reverse()
    .filter((r) => (SHADOW_RESULTS as readonly string[]).includes(r.result) && finite(r.percentile))
    .map((r) => ({ verdict: r.result as ShadowMatch["verdict"], percentile: r.percentile }));
  return {
    key: `${settled.matchId}:ladder`,
    record: {
      category: settled.category ?? null,
      series: [...earlier, latest],
      placement: ladder.placement ? { estimate: ladder.placement.estimate, decided: ladder.placement.decided } : null,
      streak: ladder.streak,
      at,
    },
  };
}

/**
 * The newest answered Flag on the board, from the planter's side. The queue board sends the
 * two match scores and the rating change, not the rounds, so the card shows the scores.
 */
export function flagRecord(board: QueueBoard): Keyed<FlagRecord> | null {
  const answered = (board.flags ?? [])
    .filter((f) => f.status === "answered" && f.verdict && f.answeredAt && f.answeredBy)
    .sort((a, b) => time(b.answeredAt) - time(a.answeredAt));
  const f = answered[0];
  if (!f || !f.verdict || !f.answeredAt || !f.answeredBy) return null;
  return {
    key: `flag:${f.id}`,
    record: {
      verdict: f.verdict,
      category: f.category,
      challenger: { displayName: f.answeredBy },
      plantedAt: f.plantedAt,
      answeredAt: f.answeredAt,
      // A Flag answer settles rated for both players (core/match/flags.ts).
      rated: true,
      ratingAfter: null,
      ratingChange: f.ratingChange,
      yourMatchScore: f.yourScore,
      theirMatchScore: f.theirScore,
      rounds: [],
      standing: (board.flags ?? []).filter((x) => x.status === "open").length,
    },
  };
}

/**
 * A Crown the player just took, from their own settled challenge. When the Crown changed
 * hands while they played, the decision was against the new holder, whose rounds this match
 * does not hold: the card then shows the two match scores the decision compared.
 */
export function crownTakenRecord(settled: SettledWithArena, band: string, at = Date.now()): Keyed<CrownRecord> | null {
  const c = settled.arena?.kind === "crown" ? settled.arena.crown : null;
  if (!c || c.outcome !== "took") return null;
  const elsewhere = c.judgedAgainstNewHolder;
  const rounds: SettledRound[] = elsewhere ? [] : (settled.rounds ?? []).map((r) => ({
    scenario: r.scenario,
    score: r.score,
    baseline: r.baseline,
    delta: r.delta,
    opponentDelta: r.opponentDelta,
    counted: r.counted,
    excludedReason: r.excludedReason,
  }));
  return {
    key: `crown:taken:${settled.matchId}`,
    record: {
      event: "taken",
      category: c.category,
      band,
      rival: c.holderName ? { displayName: c.holderName } : null,
      defences: 0,
      yourMatchScore: finite(c.challengerScore) ? c.challengerScore : settled.yourMatchScore,
      theirMatchScore: finite(c.holderScore) ? c.holderScore : elsewhere ? null : settled.theirMatchScore,
      rounds,
      at,
    },
  };
}

/** The newest unread defence notice on the Crowns board, from the holder's side. */
export function crownDefendedRecord(board: CrownBoard): Keyed<CrownRecord> | null {
  const n = (board.notices ?? [])
    .filter((x) => x.kind === "defended" && finite(x.challengerScore) && finite(x.holderScore))
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  if (!n) return null;
  const band = board.bands?.find((b) => b.index === n.window)?.name ?? "";
  const held = board.crowns?.find((c) => c.category === n.category && c.window === n.window && c.holder?.you);
  return {
    key: `crown:defended:${n.id}`,
    record: {
      event: "defended",
      category: n.category,
      band,
      rival: { displayName: n.otherName || "a challenger" },
      defences: n.defences,
      heldSince: held?.heldSince ?? null,
      yourMatchScore: n.holderScore,
      theirMatchScore: n.challengerScore,
      rounds: [],
      at: time(n.createdAt),
    },
  };
}

/**
 * Main's side of it: hands each record to the sink as the server answers arrive. One Crown
 * record at a time, so a defence notice replaces a Crown taken only when it is newer.
 */
export class MechanicShares {
  private shadowSettled: SettledMatch | null = null;
  private shadowKey: string | null = null;
  private flagKey: string | null = null;
  private crownKey: string | null = null;
  private crownAt = 0;

  constructor(private readonly sink: RecordSink) {}

  /** After settle-match answers: a Shadow result or a Crown taken. */
  settled(settled: SettledWithArena, band: string, at = Date.now()): void {
    const shadow = shadowRecord(settled, null, at);
    if (shadow || settled.shadow) {
      this.shadowSettled = shadow ? settled : null;
      this.shadowKey = shadow?.key ?? null;
      this.sink.recordShadow(shadow?.record ?? null, shadow?.key ?? null);
    }
    const crown = crownTakenRecord(settled, band, at);
    if (crown) {
      this.crownKey = crown.key;
      this.crownAt = at;
      this.sink.recordCrown(crown.record, crown.key);
    }
  }

  /** Each queue board read: the ladder behind the last Shadow match, and the newest answered Flag. */
  queueBoard(board: QueueBoard): void {
    if (this.shadowSettled) {
      const shadow = shadowRecord(this.shadowSettled, board);
      if (shadow && shadow.key !== this.shadowKey) {
        this.shadowKey = shadow.key;
        this.sink.recordShadow(shadow.record, shadow.key);
      }
    }
    const flag = flagRecord(board);
    if (flag && flag.key !== this.flagKey) {
      this.flagKey = flag.key;
      this.sink.recordFlag(flag.record, flag.key);
    }
  }

  /** Each Crowns board read: the newest defence notice, when it is newer than the Crown record held. */
  crowns(board: CrownBoard): void {
    const crown = crownDefendedRecord(board);
    if (!crown || crown.key === this.crownKey || !(crown.record.at > this.crownAt)) return;
    this.crownKey = crown.key;
    this.crownAt = crown.record.at;
    this.sink.recordCrown(crown.record, crown.key);
  }
}
