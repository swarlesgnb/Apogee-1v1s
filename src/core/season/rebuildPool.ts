/**
 * The pool, rewritten from a season the editor just changed.
 *
 * `data/pool.json` is what `buildSeason` reads and `data/seasons/season-1.json` is what it
 * writes, so an edit made to the season has to be pushed back into the pool or the next
 * build regenerates over it. Doing that means reconstructing families from a season that
 * does not model everything a family has - and everything it does not model used to be
 * dropped on the floor.
 *
 * Sixteen written reasons went that way on a single save: twelve `admitted`, three
 * `$order`, one `thinBoard`. Those are the sentences saying why a hand-picked rung is
 * allowed to be where it is, `validate:pool` requires them, and losing them turned a
 * passing pool into three failures with no message at any point. It is also what "the pool
 * silently reverted" was, twice.
 *
 * Lives here rather than in `main.ts` so it can be run against the real pool without an
 * Electron window. `npm run validate:season` asserts the thing that actually matters: that
 * rebuilding from a season the pool itself produced changes nothing at all.
 */

/** Properties of a variant this rebuild owns. Everything else is carried through. */
const OWNED_VARIANT = new Set([
  "window", "scenario", "label", "leaderboardId", "rankMaxes", "source",
]);

/** Properties of a family this rebuild owns. Everything else is carried through. */
const OWNED_FAMILY = new Set(["family", "category", "subCategory", "variants"]);

export interface RebuildSeason {
  windowSize?: number;
  windows?: string[];
  matchPool?: { window?: number };
  categories: { name: string; headline?: string; description?: string }[];
  scenarios: {
    scenario: string;
    category: string;
    family: string;
    label: string;
    leaderboardId?: number | null;
    rankMaxes: number[];
    window?: number;
    source?: { kind?: string } & Record<string, unknown>;
    arm?: string;
    armFrom?: string;
    subCategory?: string;
    focus?: string;
  }[];
}

/**
 * Merge `season` into `pool`, returning the new pool. Neither argument is mutated.
 *
 * Carried by listing what this owns rather than what it must keep. The old shape had to be
 * extended every time the pool grew a field, and a field nobody remembered to add was
 * deleted without a message; this way a new one survives by default, and the worst case is
 * a stale value rather than no value.
 */
export function rebuildPool(
  poolIn: Record<string, unknown>,
  season: RebuildSeason,
  /**
   * Families renamed in the editor, "Category/new" to "Category/old". What a family carries
   * that the season does not model - its sub-skill, notes, place in the circuit - is keyed
   * by name in the pool, so without this a rename loses all of it.
   */
  renamed: Record<string, string> = {},
): Record<string, unknown> {
  const presentFamilies = new Set(((poolIn.families ?? []) as {category:string;family:string}[]).map(f => `${f.category}/${f.family}`));
  const was = (key: string): string => presentFamilies.has(key) ? key : renamed[key] ?? key;
  // Deep-copied so a caller's pool is never half-rewritten by a throw partway through, and
  // typed loosely on purpose: the point of this function is that it does not know the whole
  // shape of a pool and must not need to.
  const pool = JSON.parse(JSON.stringify(poolIn)) as Record<string, any>;

  // Thresholds live in the pool now, so this rebuild has to carry them.
  //
  // It did not, and that was the sharpest edge in the whole conversion: the rebuild
  // reconstructs every variant from the season, and a variant without `rankMaxes` is a
  // variant with no numbers. One save from the season editor would have emptied every
  // threshold in the pool, and the next build would have refused with 88 scenarios
  // missing scores.
  //
  // `overrides` is gone with the derivation. It existed so a hand-set number could
  // survive a rebuild that recomputed over it; nothing recomputes now, so there is
  // nothing to override and no diff to take.
  const sourceOf = new Map<string, unknown>(
    (pool.families ?? []).flatMap((f: { variants?: { scenario: string; source?: unknown }[] }) =>
      (f.variants ?? []).map((v) => [v.scenario, v.source] as [string, unknown]),
    ),
  );
  const priorMaxes = new Map<string, number[]>(
    (pool.families ?? []).flatMap((f: { variants?: { scenario: string; rankMaxes?: number[] }[] }) =>
      (f.variants ?? [])
        .filter((v) => Array.isArray(v.rankMaxes))
        .map((v) => [v.scenario, v.rankMaxes!] as [string, number[]]),
    ),
  );

  // Everything on a variant and a family that the season has no field for.
  //
  // The rebuild writes back the handful of properties the season models and, until
  // this, dropped the rest on the floor. `admitted`, `thinBoard` and `$order` are the
  // written reasons a hand-picked rung is allowed to be where it is, and `validate:pool`
  // requires them - so one save deleted sixteen admissions, three order exceptions and
  // a thin-board exception, and turned a passing pool into three failures. It is also
  // what "the pool silently reverted" was, twice, which I twice blamed on a stale
  // window instead of on this.
  //
  // Carried by listing what the rebuild *owns* rather than what it must keep. The old
  // shape had to be extended every time the pool grew a field, and a field nobody
  // remembered to add was deleted without a message; this way a new one survives by
  // default and the failure mode is a stale value rather than no value.
  const keptOnVariant = new Map<string, Record<string, unknown>>();
  const keptOnFamily = new Map<string, Record<string, unknown>>();
  for (const f of (pool.families ?? []) as Record<string, unknown>[]) {
    const familyKey = `${f.category as string}/${f.family as string}`;
    keptOnFamily.set(
      familyKey,
      Object.fromEntries(Object.entries(f).filter(([k]) => !OWNED_FAMILY.has(k))),
    );
    for (const v of (f.variants ?? []) as Record<string, unknown>[]) {
      keptOnVariant.set(
        v.scenario as string,
        Object.fromEntries(Object.entries(v).filter(([k]) => !OWNED_VARIANT.has(k))),
      );
    }
  }

  const families: Record<string, {
    family: string;
    category: string;
    subCategory?: string;
    variants: Record<string, unknown>[];
  } & Record<string, unknown>> = {};

  // The season does not carry a sub-skill - it is a property of the family, and the
  // pool is where families are declared - so it has to be read back off the pool being
  // rewritten. Dropping it would leave the family unclassified, which fails no build
  // and quietly removes it from the weakness map and the sub-category queues.
  const subCategoryOf = new Map<string, string>(
    (pool.families ?? [])
      .filter((f: { subCategory?: string }) => typeof f.subCategory === "string")
      .map((f: { category: string; family: string; subCategory: string }) => [
        `${f.category}/${f.family}`,
        f.subCategory,
      ]),
  );

  for (const scen of season.scenarios) {
    const key = `${scen.category}/${scen.family}`;
    families[key] ??= {
      family: scen.family,
      category: scen.category,
      ...(scen.subCategory ? {subCategory: scen.subCategory} : subCategoryOf.has(was(key)) ? { subCategory: subCategoryOf.get(was(key))! } : {}),
      variants: [],
    };
    // A number the editor changed is a number somebody authored, and it says so.
    // Keeping the old source would let an edit inherit a citation it no longer
    // matches, which is the one thing the provenance is there to prevent.
    const prior = priorMaxes.get(scen.scenario);
    const edited =
      !prior ||
      prior.length !== scen.rankMaxes.length ||
      prior.some((n, i) => n !== scen.rankMaxes[i]);

    families[key].variants.push({
      window: scen.window ?? 0,
      scenario: scen.scenario,
      label: scen.label,
      leaderboardId: scen.leaderboardId ?? null,
      rankMaxes: scen.rankMaxes.slice(),
      // Except a fresh cut. The grid cuts a replacement's thresholds from its own board and
      // says so on the scenario; that is a percentile source validateThresholds can
      // re-derive to the digit, and calling it unexplained would be the less true label.
      source: edited && scen.source?.kind === "percentile"
        ? scen.source
        : edited && scen.source?.kind === "authored" && typeof scen.source.why === "string"
        ? scen.source
        : edited
        ? {
            kind: "authored",
            why:
              "Changed in the season editor and not yet explained. Replace this with " +
              "the reason the number is what it is, or run the adoption tool to trace " +
              "it to a benchmark that publishes it.",
          }
        : (scen.source ?? sourceOf.get(scen.scenario) ?? {
            kind: "seeded",
            note: "no source recorded when this variant was written back",
          }),
      // Last, so the file keeps the shape it had: the properties this owns in their usual
      // order, then the written reasons after them. Spreading first put `admitted` above
      // `window` and rewrote all sixteen of them as pure churn in the diff.
      ...(keptOnVariant.get(scen.scenario) ?? {}),
      // The arm the season carries, over what the pool had. A replacement is a scenario the
      // pool has never held, so it has nothing kept, and validate:pool refuses a variant
      // that does not name a part of the arm. Assigned over a kept one in place, so an
      // unchanged variant keeps its key order.
      ...(scen.arm ? { arm: scen.arm, armFrom: scen.armFrom } : {}),
    });
  }

  for (const [key, f] of Object.entries(families)) {
    f.variants.sort((a, b) => (a.window as number) - (b.window as number));
    Object.assign(f, keptOnFamily.get(was(key)) ?? {});
    const authored = season.scenarios.find(s => `${s.category}/${s.family}` === key);
    if (authored?.focus !== undefined) f.focus = authored.focus;
  }

  pool.windowSize = season.windowSize ?? pool.windowSize;
  pool.windows = season.windows ?? pool.windows;
  pool.matchWindow = season.matchPool?.window ?? pool.matchWindow;
  pool.categories = season.categories.map((c: { name: string }) => c.name);
  // Category names are editable too. Preserve authored sub-skills and guides through a
  // move or rename, and remove declarations for categories that no longer exist.
  const oldSubCategories = pool.subCategories ?? {};
  pool.subCategories = Object.fromEntries(season.categories.map(c => {
    const mine = Object.values(families).filter(f => f.category === c.name);
    const carried = oldSubCategories[c.name] ?? [];
    return [c.name, [...new Set([...carried, ...mine.map(f => f.subCategory).filter(Boolean)])]];
  }));
  const guides = pool.categoryGuides ?? {};
  pool.categoryGuides = Object.fromEntries(season.categories.flatMap(c => {
    const oldKey = Object.entries(renamed).find(([key]) => key.startsWith(`${c.name}/`))?.[1];
    const oldCategory = oldKey?.slice(0, oldKey.indexOf("/"));
    const guide = {...(guides[c.name] ?? (oldCategory ? guides[oldCategory] : null) ?? {}),
      ...(c.headline !== undefined ? {headline:c.headline} : {}),
      ...(c.description !== undefined ? {description:c.description} : {})};
    return Object.keys(guide).length ? [[c.name,guide]] : [];
  }));
  // Category playlists follow the authored circuit. Saving an unrelated threshold
  // must not silently alphabetize that circuit; newly added families go after it.
  const priorOrder = new Map<string, number>(
    (pool.families ?? []).map((f: { category: string; family: string }, i: number) => [
      `${f.category}/${f.family}`, i,
    ]),
  );
  pool.families = Object.values(families).sort((a, b) => {
    const ai = priorOrder.get(was(`${a.category}/${a.family}`)) ?? Infinity;
    const bi = priorOrder.get(was(`${b.category}/${b.family}`)) ?? Infinity;
    return (ai === bi ? 0 : ai < bi ? -1 : 1)
      || a.category.localeCompare(b.category) || a.family.localeCompare(b.family);
  });
  delete pool.overrides;

  // A sub-skill override names one scenario and says why it is filed against the
  // benchmarks. Once that scenario has left the pool the reason is about nothing, and
  // validate:pool refuses the orphan, so it goes with the scenario.
  if (pool.subCategoryOverrides && typeof pool.subCategoryOverrides === "object") {
    const present = new Set(season.scenarios.map((s) => s.scenario));
    for (const name of Object.keys(pool.subCategoryOverrides)) {
      if (!present.has(name)) delete pool.subCategoryOverrides[name];
    }
  }

  return pool;
}
