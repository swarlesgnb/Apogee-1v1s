/**
 * Glicko-2, per Mark Glickman's specification.
 *
 * Chosen over Elo because Apogee's play pattern is exactly what Elo handles badly
 * (PLAN.md §4): sparse, bursty, asynchronous, against a small and initially unknown
 * population. Glicko-2 carries a rating deviation (uncertainty) and a volatility
 * alongside the rating, so a new or returning player converges quickly while a settled
 * player's rating stays stable.
 *
 * Implemented from the published algorithm rather than adapted from a library, and
 * checked against Glickman's own worked example. See validateGlicko.ts.
 */

/** Conversion between the human-facing 1500-scale and Glicko-2's internal scale. */
const SCALE = 173.7178;
const DEFAULT_RATING = 1500;

/**
 * System constant τ, constraining volatility change. Glickman suggests 0.3–1.2;
 * smaller values prevent volatility spikes from improbable results. 0.5 is the
 * middle of the recommended range and the value used in the reference example.
 */
export const DEFAULT_TAU = 0.5;

/** Convergence tolerance for the volatility iteration. */
const EPSILON = 0.000001;

export interface Rating {
  rating: number;
  rd: number;
  volatility: number;
}

/** One completed game against an opponent, from the subject player's perspective. */
export interface GameResult {
  opponent: Rating;
  /** 1 win, 0 loss, 0.5 draw. */
  score: number;
}

export function defaultRating(): Rating {
  return { rating: DEFAULT_RATING, rd: 350, volatility: 0.06 };
}

/** Human scale -> Glicko-2 scale. */
function toGlicko2(r: Rating): { mu: number; phi: number; sigma: number } {
  return {
    mu: (r.rating - DEFAULT_RATING) / SCALE,
    phi: r.rd / SCALE,
    sigma: r.volatility,
  };
}

/** Glicko-2 scale -> human scale. */
function fromGlicko2(mu: number, phi: number, sigma: number): Rating {
  return {
    rating: SCALE * mu + DEFAULT_RATING,
    rd: SCALE * phi,
    volatility: sigma,
  };
}

/** g(φ): how much an opponent's uncertainty damps the impact of a result. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** E(μ, μj, φj): expected score against one opponent. */
function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Solve for the new volatility σ' using the Illinois variant of regula falsi, exactly
 * as specified. This is the fiddly part of Glicko-2 and the usual source of subtly
 * wrong implementations.
 */
function newVolatility(
  phi: number,
  sigma: number,
  v: number,
  delta: number,
  tau: number,
): number {
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const delta2 = delta * delta;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const numerator = ex * (delta2 - phi2 - v - ex);
    const denominator = 2 * Math.pow(phi2 + v + ex, 2);
    return numerator / denominator - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;

  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    // Step down until f(B) is negative, per the specification.
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);

  let guard = 0;
  while (Math.abs(B - A) > EPSILON) {
    if (++guard > 1000) break; // never spin forever on a pathological input
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);

    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }

    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

/**
 * Update a rating from the games played in one rating period.
 *
 * Glicko-2 is defined over rating PERIODS, not individual games: results are batched
 * and applied together. Apogee batches nightly (PLAN.md §4).
 */
export function updateRating(
  player: Rating,
  games: GameResult[],
  tau = DEFAULT_TAU,
): Rating {
  const { mu, phi, sigma } = toGlicko2(player);

  // A player who did not play still becomes less certain: RD grows toward the
  // maximum, which is what lets a returning player's rating move quickly again.
  if (games.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return fromGlicko2(mu, phiStar, sigma);
  }

  let vInverse = 0;
  let deltaSum = 0;

  for (const game of games) {
    const opp = toGlicko2(game.opponent);
    const gPhi = g(opp.phi);
    const e = expectedScore(mu, opp.mu, opp.phi);

    vInverse += gPhi * gPhi * e * (1 - e);
    deltaSum += gPhi * (game.score - e);
  }

  const v = 1 / vInverse;
  const delta = v * deltaSum;

  const sigmaPrime = newVolatility(phi, sigma, v, delta, tau);
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return fromGlicko2(muPrime, phiPrime, sigmaPrime);
}

/**
 * Probability that `player` beats `opponent`, for display and for matchmaking.
 * Accounts for both players' uncertainty.
 */
export function winProbability(player: Rating, opponent: Rating): number {
  const p = toGlicko2(player);
  const o = toGlicko2(opponent);
  // Combine uncertainties so a match against an unknown opponent reads closer to even.
  const combinedPhi = Math.sqrt(p.phi * p.phi + o.phi * o.phi);
  return 1 / (1 + Math.exp(-g(combinedPhi) * (p.mu - o.mu)));
}

/**
 * Conservative public rating: rating minus two deviations. Standard Glicko practice
 * for leaderboards, since it stops a brand-new player with a huge RD from appearing at the
 * top after one lucky match.
 */
export function conservativeRating(r: Rating): number {
  return r.rating - 2 * r.rd;
}
