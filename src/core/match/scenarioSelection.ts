/**
 * Pick the three scenarios for a match.
 *
 * Both sides of a match must receive the same three scenarios, and no client may be
 * able to reroll them. So selection is a pure function of the match seed: given the
 * seed, anyone can reproduce and audit the choice, and nobody can influence it
 * (PLAN.md §3).
 */

export interface SelectableScenario {
  id: number;
  name: string;
  aimType: string | null;
  subCategory: string | null;
}

export interface SelectionOptions {
  /** 'Clicking' | 'Tracking' | 'Switching' | a sub-category | 'Any'. */
  category: string;
  /** Scenario names either player has played recently, to avoid where possible. */
  playedRecently?: Set<string>;
  count?: number;
}

/**
 * xmur3 string hash -> 32-bit seed. Used to turn a match id into PRNG state.
 */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32: small, fast, and deterministic across platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: string): () => number {
  return mulberry32(xmur3(seed)());
}

/** Fisher-Yates, driven by a supplied PRNG so the shuffle is reproducible. */
function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function matchesCategory(scenario: SelectableScenario, category: string): boolean {
  if (category === "Any") return true;
  return scenario.aimType === category || scenario.subCategory === category;
}

/**
 * Choose scenarios for a match.
 *
 * Scenarios either player warmed up on today are deprioritised rather than excluded:
 * a sub-category pool holds only two scenarios, so excluding outright would often make
 * selection impossible. Where the pool is smaller than the required count, scenarios
 * repeat, which is expected for a sub-category queue and makes it a deliberate
 * specialist choice.
 */
export function selectScenarios(
  pool: SelectableScenario[],
  seed: string,
  options: SelectionOptions,
): SelectableScenario[] {
  const count = options.count ?? 3;
  const eligible = pool.filter((s) => matchesCategory(s, options.category));

  if (eligible.length === 0) return [];

  const random = seededRandom(seed);
  const recent = options.playedRecently ?? new Set<string>();

  // Two buckets, each shuffled with the same stream, then concatenated: fresh
  // scenarios are preferred but recently-played ones remain available as filler.
  const fresh = shuffle(
    eligible.filter((s) => !recent.has(s.name)),
    random,
  );
  const stale = shuffle(
    eligible.filter((s) => recent.has(s.name)),
    random,
  );

  const ordered = [...fresh, ...stale];
  const chosen: SelectableScenario[] = [];

  for (let i = 0; i < count; i++) {
    // Cycling the ordered list keeps repeats maximally spaced when the pool is
    // smaller than the match length.
    chosen.push(ordered[i % ordered.length]);
  }

  return chosen;
}

/** Categories a player can queue for, derived from the scenario pool. */
export function availableCategories(pool: SelectableScenario[]): {
  skills: string[];
  subCategories: string[];
} {
  const skills = new Set<string>();
  const subCategories = new Set<string>();

  for (const s of pool) {
    if (s.aimType) skills.add(s.aimType);
    if (s.subCategory) subCategories.add(s.subCategory);
  }

  return {
    skills: [...skills].sort(),
    subCategories: [...subCategories].sort(),
  };
}
