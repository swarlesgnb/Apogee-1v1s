/**
 * Exercise the upload path end-to-end without a backend.
 *
 * Everything up to the network call is testable offline, and that is where the bugs
 * that matter live: payload shape, hashing, replay protection, batching, and partial
 * failure. Running this against the real stats folder catches them before a single row
 * reaches Supabase.
 *
 *   npx tsx src/core/sync/validateSync.ts [statsFolder]
 */

import {
  BATCH_SIZE,
  chunk,
  collectRuns,
  hashCsv,
  uploadRuns,
  type RunPayload,
  type RunUploader,
} from "./uploadRuns.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** Stands in for Supabase, and models the server's uniqueness constraint. */
function mockUploader(options: { failBatch?: number } = {}): {
  client: RunUploader;
  stored: Map<string, RunPayload>;
  rejectedDuplicates: number;
  calls: number;
} {
  const stored = new Map<string, RunPayload>();
  const state = { rejectedDuplicates: 0, calls: 0 };

  const client: RunUploader = {
    from() {
      return {
        async upsert(rows, opts) {
          state.calls++;
          if (options.failBatch === state.calls) {
            return { error: { message: "simulated network failure" } };
          }
          for (const row of rows as RunPayload[]) {
            // The real constraint is unique(player_id, csv_sha256); one player here.
            if (stored.has(row.csv_sha256)) {
              if (!opts.ignoreDuplicates) {
                return { error: { message: "duplicate key" } };
              }
              state.rejectedDuplicates++;
              continue;
            }
            stored.set(row.csv_sha256, row);
          }
          return { error: null };
        },
      };
    },
  };

  return {
    client,
    stored,
    get rejectedDuplicates() {
      return state.rejectedDuplicates;
    },
    get calls() {
      return state.calls;
    },
  };
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;

  console.log(`stats folder : ${dir}`);
  const started = Date.now();
  const { payloads, scanned, skipped } = collectRuns(dir);
  const elapsed = Date.now() - started;

  console.log(`scanned      : ${scanned} files`);
  console.log(`payloads     : ${payloads.length}`);
  console.log(`skipped      : ${skipped}`);
  console.log(`elapsed      : ${elapsed} ms\n`);

  if (payloads.length === 0) {
    console.error("No payloads produced, cannot validate.");
    process.exit(1);
  }

  console.log("payload shape");

  check("every payload has a scenario name", payloads.every((p) => p.scenario_name.length > 0));
  check("every payload has a finite score", payloads.every((p) => Number.isFinite(p.score)));
  check("every payload has an ISO timestamp",
    payloads.every((p) => !Number.isNaN(Date.parse(p.played_at))));
  check("every payload has a 64-char sha256",
    payloads.every((p) => /^[0-9a-f]{64}$/.test(p.csv_sha256)));
  check("kill rows omitted for backfill", payloads.every((p) => p.kill_rows === null));

  const withHash = payloads.filter((p) => p.hash).length;
  check("scenario hash present on all runs", withHash === payloads.length,
    `${withHash}/${payloads.length}`);

  console.log("\nhashing");

  const a = hashCsv("Score:,1020.0\n");
  const b = hashCsv("Score:,1020.0\n");
  const c = hashCsv("Score:,1020.1\n");
  check("hash is deterministic", a === b);
  check("hash changes with content", a !== c);
  check("a one-character score edit changes the hash", a !== c);

  const unique = new Set(payloads.map((p) => p.csv_sha256));
  const collisions = payloads.length - unique.size;
  // Identical files are possible in principle but vanishingly unlikely in practice;
  // a large count here would mean the hash is not covering what we think it is.
  check("hashes are effectively unique", collisions === 0, `${collisions} repeated`);

  console.log("\nbatching");

  const batches = chunk(payloads, BATCH_SIZE);
  check("batches partition the input",
    batches.reduce((n, b) => n + b.length, 0) === payloads.length);
  check("no batch exceeds the limit", batches.every((b) => b.length <= BATCH_SIZE));
  check("chunking an empty list yields no batches", chunk([], BATCH_SIZE).length === 0);

  console.log("\nupload");

  const first = mockUploader();
  const r1 = await uploadRuns(first.client, payloads);
  check("all rows uploaded", r1.uploaded === payloads.length,
    `${r1.uploaded}/${payloads.length}`);
  check("no errors on a clean run", r1.errors.length === 0, r1.errors.join("; "));
  check("stored row count matches", first.stored.size === unique.size);

  console.log("\nidempotence and replay protection");

  const r2 = await uploadRuns(first.client, payloads);
  check("re-upload adds no new rows", first.stored.size === unique.size);
  check("re-upload reports no errors", r2.errors.length === 0);
  check("duplicates were recognised, not inserted",
    first.rejectedDuplicates === payloads.length,
    `${first.rejectedDuplicates}`);

  console.log("\npartial failure");

  const flaky = mockUploader({ failBatch: 2 });
  const r3 = await uploadRuns(flaky.client, payloads);
  const expectedLost = batches[1]?.length ?? 0;
  check("one failed batch does not abort the rest",
    r3.uploaded === payloads.length - expectedLost,
    `${r3.uploaded} of ${payloads.length - expectedLost}`);
  check("the failure is reported", r3.errors.length === 1, r3.errors.join("; "));
  check("a retry heals the gap", await (async () => {
    const r4 = await uploadRuns(flaky.client, payloads);
    return r4.errors.length === 0 && flaky.stored.size === unique.size;
  })());

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(`OK: upload path validated against ${payloads.length} real runs`);
}

main();
