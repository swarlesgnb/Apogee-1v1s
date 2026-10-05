import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('.cache', { recursive: true });
await build({
  entryPoints: ['supabase/functions/_shared/apogee.ts'],
  outfile: '.cache/ranked-pool.mjs', bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'test-client', setup(builder) {
    builder.onResolve({ filter: /^jsr:/ }, () => ({ path: 'client', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
      contents: 'export function createClient() { throw new Error("unexpected client creation"); }',
    }));
  } }],
});
globalThis.Deno = { env: { get: () => '' } };
const { loadSeasonPool, isOffPool } = await import('../.cache/ranked-pool.mjs');
const season = { id: 'test-season', name: 'Season 1', status: 'published',
  windows: ['Novice', 'Intermediate', 'Advanced', 'Expert'], window_size: 20 };
const rows = season.windows.map((name, index) => ({
  season_id: season.id, window_index: index, category: 'Static Clicking',
  scenarios: { id: index + 1, name: `Test ${name}`, aim_type: 'Clicking', sub_category: 'old category' },
}));
function adminFor(activeSeason = season) {
  return { from(table) {
    const filters = [];
    const query = {
      select() { return query; }, order() { return query; }, limit() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      in(key, values) { filters.push(row => values.includes(row[key])); return query; },
      then(resolve) {
        const data = table === 'seasons' ? [activeSeason] : rows;
        return Promise.resolve({ data: data.filter(row => filters.every(filter => filter(row))), error: null }).then(resolve);
      },
    };
    return query;
  } };
}
for (let window = 0; window < 4; window++) {
  const pool = await loadSeasonPool(adminFor(), window);
  assert.equal(pool.windowName, season.windows[window]);
  assert.deepEqual(pool.selectable.map(row => row.id), window === 1 ? [1, 2] : [window + 1]);
  assert.ok(pool.selectable.every(row => row.subCategory === 'Static Clicking'));
  console.log(`PASS: ${pool.windowName} has exactly its intended scenario pool`);
}
assert.equal(await isOffPool(adminFor(), [1, 2], 1), false);
assert.equal(await isOffPool(adminFor(), [2, 4], 1), true);
assert.equal(await isOffPool(adminFor(), [1, 4], 3), true);
console.log('PASS: mixed Novice matches remain playable; unrelated difficulties remain off-pool');
for (const index of [-1, 0.5, 4, 99]) {
  await assert.rejects(loadSeasonPool(adminFor(), index), /valid season difficulty/);
}
console.log('PASS: invalid windows cannot fall back to the Novice pool');
const renamed = { ...season, windows: ['Entry', 'Intermediate', 'Advanced', 'Expert'] };
assert.deepEqual((await loadSeasonPool(adminFor(renamed), 3)).selectable.map(row => row.id), [4]);
console.log('PASS: seasons without a Novice window retain their selected pool');
