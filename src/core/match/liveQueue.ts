/**
 * Live synchronous matchmaking.
 *
 * Async matches (matchmaking.ts) carry the ladder from day one. This is the layer that
 * switches on once there is a concurrent population, roughly 100 players, per the
 * plan. Everything downstream is unchanged: the same seeded scenario selection, the
 * same settlement, the same Glicko-2 update. Live mode only changes how two players
 * are brought together.
 *
 * The problem it has to solve that async does not is **starvation**. A player at the
 * very top or bottom of the ladder may have nobody close, and a queue that insists on
 * a fair pairing will leave them waiting forever. So the tolerance widens with waiting
 * time: everyone is matched eventually, and the system gives up fairness gradually and
 * visibly rather than silently.
 */

import { winProbability, type Rating } from "../rating/glicko2.ts";

export interface QueueEntry {
  playerId: string;
  displayName: string;
  rating: Rating;
  category: string;
  difficulty: string;
  joinedAt: number;
  /** Opponents to avoid re-pairing with immediately. */
  recentOpponentIds?: Set<string>;
}

export interface Pairing {
  a: QueueEntry;
  b: QueueEntry;
  /** Probability that `a` wins. */
  winProbability: number;
  /** Longest wait of the two, in ms. */
  waitedMs: number;
  /** True when the pairing only happened because tolerance had widened. */
  stretched: boolean;
}

export interface QueueConfig {
  /** Tightest acceptable |winProbability − 0.5| at the moment of joining. */
  initialTolerance: number;
  /** Widest tolerance the queue will ever accept. */
  maxTolerance: number;
  /** How long it takes to widen from initial to max. */
  widenOverMs: number;
  /** Give up and offer an async match after this long. */
  giveUpAfterMs: number;
  /** Avoid immediately re-pairing the same two players. */
  avoidRematch: boolean;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  // 0.08 ≈ a 58/42 matchup: close enough to feel like a real contest.
  initialTolerance: 0.08,
  // 0.35 ≈ 85/15. Lopsided, but better than never matching at all.
  maxTolerance: 0.35,
  widenOverMs: 90_000,
  giveUpAfterMs: 150_000,
  avoidRematch: true,
};

/** Tolerance for an entry that has been waiting `waited` ms. */
export function toleranceAt(config: QueueConfig, waited: number): number {
  const progress = Math.max(0, Math.min(1, waited / config.widenOverMs));
  return config.initialTolerance + (config.maxTolerance - config.initialTolerance) * progress;
}

export interface MatchAttempt {
  pairings: Pairing[];
  /** Entries that have waited too long and should fall back to an async match. */
  giveUp: QueueEntry[];
  /** Still waiting. */
  waiting: QueueEntry[];
}

/**
 * Pair everyone who can be paired, at a given moment.
 *
 * Longest-waiting players are considered first, which is what makes the queue
 * starvation-free: waiting only ever improves your position, never worsens it.
 */
export function attemptPairings(
  entries: QueueEntry[],
  now: number,
  config: QueueConfig = DEFAULT_QUEUE_CONFIG,
): MatchAttempt {
  const pairings: Pairing[] = [];
  const giveUp: QueueEntry[] = [];
  const paired = new Set<string>();

  const byWait = [...entries].sort((x, y) => x.joinedAt - y.joinedAt);

  for (const entry of byWait) {
    if (paired.has(entry.playerId)) continue;

    const waited = now - entry.joinedAt;
    if (waited >= config.giveUpAfterMs) {
      giveUp.push(entry);
      paired.add(entry.playerId);
      continue;
    }

    let best: { other: QueueEntry; p: number; cost: number } | null = null;

    for (const other of byWait) {
      if (other.playerId === entry.playerId || paired.has(other.playerId)) continue;
      if (other.category !== entry.category) continue;
      if (other.difficulty !== entry.difficulty) continue;

      if (
        config.avoidRematch &&
        (entry.recentOpponentIds?.has(other.playerId) ||
          other.recentOpponentIds?.has(entry.playerId))
      ) {
        continue;
      }

      const p = winProbability(entry.rating, other.rating);
      const cost = Math.abs(p - 0.5);

      // Both sides must accept: the pair is only valid inside the tolerance of the
      // one who has waited less, otherwise a long-waiting player would drag a
      // freshly-queued player into a lopsided match.
      const otherWaited = now - other.joinedAt;
      const allowed = Math.min(
        toleranceAt(config, waited),
        toleranceAt(config, otherWaited),
      );
      if (cost > allowed) continue;

      if (!best || cost < best.cost) best = { other, p, cost };
    }

    if (best) {
      paired.add(entry.playerId);
      paired.add(best.other.playerId);
      const waitedMs = Math.max(waited, now - best.other.joinedAt);
      pairings.push({
        a: entry,
        b: best.other,
        winProbability: best.p,
        waitedMs,
        stretched: best.cost > config.initialTolerance,
      });
    }
  }

  return {
    pairings,
    giveUp,
    waiting: entries.filter((e) => !paired.has(e.playerId)),
  };
}

/**
 * A live queue with mutable membership.
 *
 * Deliberately transport-agnostic (no websockets, no Supabase realtime) so the
 * pairing rules can be tested exhaustively without a server. The transport layer calls
 * `tick()` on an interval and acts on what comes back.
 */
export class LiveQueue {
  private entries = new Map<string, QueueEntry>();

  constructor(private config: QueueConfig = DEFAULT_QUEUE_CONFIG) {}

  join(entry: Omit<QueueEntry, "joinedAt">, now: number): void {
    // Re-joining refreshes position rather than creating a duplicate.
    this.entries.set(entry.playerId, { ...entry, joinedAt: now });
  }

  leave(playerId: string): void {
    this.entries.delete(playerId);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Players currently queued, for a "N searching" readout. */
  list(): QueueEntry[] {
    return [...this.entries.values()];
  }

  /** Estimated wait for a newly joining player, from the current population. */
  estimatedWaitMs(category: string, difficulty: string, rating: Rating): number | null {
    const peers = this.list().filter(
      (e) => e.category === category && e.difficulty === difficulty,
    );
    if (peers.length === 0) return null;

    const close = peers.filter(
      (e) => Math.abs(winProbability(rating, e.rating) - 0.5) <= this.config.initialTolerance,
    );
    if (close.length > 0) return 0;

    // Nobody close right now: wait until tolerance widens enough to reach the nearest.
    const nearest = Math.min(
      ...peers.map((e) => Math.abs(winProbability(rating, e.rating) - 0.5)),
    );
    const span = this.config.maxTolerance - this.config.initialTolerance;
    if (nearest > this.config.maxTolerance) return null;
    return ((nearest - this.config.initialTolerance) / span) * this.config.widenOverMs;
  }

  /** Run one pass. Paired and given-up players are removed from the queue. */
  tick(now: number): MatchAttempt {
    const result = attemptPairings(this.list(), now, this.config);

    for (const p of result.pairings) {
      this.entries.delete(p.a.playerId);
      this.entries.delete(p.b.playerId);
    }
    for (const e of result.giveUp) {
      this.entries.delete(e.playerId);
    }

    return result;
  }
}
