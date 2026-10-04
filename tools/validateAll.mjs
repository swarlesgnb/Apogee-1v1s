/**
 * Run every validation suite, then say which passed.
 *
 * `npm run validate` used to be one `&&` chain, so the first suite to fail ended the run
 * and every suite after it went unrun and unreported: on f853c20 one failure in
 * validate:standing hid twenty-two suites, and the last of them was failing too. This
 * runs them all, one after another, prints each suite's own output as it goes, and ends
 * with a table of every suite, its result, how long it took and, for a failure, its last
 * line of output. It exits non-zero if any suite failed.
 *
 * The suites are the `npm run` steps of the `validate:suites` script in package.json,
 * kept in the chain form they always had, so adding one is the edit it always was.
 *
 *   npm run validate                       every suite
 *   npm run validate -- validate:parser    only the ones named
 *   npm run validate -- --bail             stop at the first failure, as the chain did
 *   npm run validate -- --timeout 300      seconds before a suite is stopped (default 900)
 *
 * Each suite's full output is also written to .cache/validate/<suite>.log.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const chain = pkg.scripts["validate:suites"];
if (typeof chain !== "string") {
  console.error("package.json has no validate:suites script to read the suites from");
  process.exit(2);
}

const all = chain
  .split("&&")
  .map((step) => /^\s*npm run ([\w:.-]+)\s*$/.exec(step)?.[1])
  .filter(Boolean);

const args = process.argv.slice(2);
const bail = args.includes("--bail");
const timeoutAt = args.indexOf("--timeout");
const timeoutSec = timeoutAt >= 0 ? Number(args[timeoutAt + 1]) : 900;
const named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--timeout");
const unknown = named.filter((n) => !pkg.scripts[n]);
if (unknown.length > 0) {
  console.error(`no such script: ${unknown.join(", ")}`);
  process.exit(2);
}
const suites = named.length > 0 ? named : all;

const logDir = join(root, ".cache", "validate");
mkdirSync(logDir, { recursive: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** Run one suite, echoing its output, and resolve with how it ended. */
function run(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(npm, ["run", "--silent", suite], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const chunks = [];
    const take = (stream, out) =>
      stream.on("data", (b) => {
        chunks.push(b);
        out.write(b);
      });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      writeFileSync(join(logDir, `${suite.replace(/[:/\\]/g, "-")}.log`), output);
      const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // The line that says why, where there is one: a FAIL line beats a stack frame.
      const reason =
        [...lines].reverse().find((l) => /\bFAIL\b|Error:|error:|Cannot|failed/i.test(l) && !/^at /.test(l)) ??
        lines[lines.length - 1] ??
        "";
      resolve({
        suite,
        ok: code === 0 && !timedOut,
        code: timedOut ? "timeout" : signal ?? code,
        seconds: (Date.now() - started) / 1000,
        reason: timedOut ? `stopped after ${timeoutSec}s` : reason,
      });
    });
  });
}

const results = [];
for (const suite of suites) {
  console.log(`\n━━ ${suite} ${"━".repeat(Math.max(4, 72 - suite.length))}`);
  const result = await run(suite);
  results.push(result);
  if (!result.ok && bail) break;
}

const width = Math.max(...results.map((r) => r.suite.length), 5);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
console.log(`\n${"═".repeat(width + 60)}`);
console.log(`${"suite".padEnd(width)}  result  ${"time".padStart(7)}  why`);
for (const r of results) {
  console.log(
    `${r.suite.padEnd(width)}  ${r.ok ? "pass  " : "FAIL  "}  ${`${r.seconds.toFixed(1)}s`.padStart(7)}  ` +
      (r.ok ? "" : clip(`${r.code === "timeout" ? "" : `exit ${r.code}: `}${r.reason}`, 90)),
  );
}
const failed = results.filter((r) => !r.ok);
const skipped = suites.length - results.length;
const total = results.reduce((s, r) => s + r.seconds, 0);
console.log(
  `\n${results.length - failed.length} passed, ${failed.length} failed` +
    (skipped ? `, ${skipped} not run (--bail)` : "") +
    ` in ${total.toFixed(0)}s. Logs: .cache/validate/`,
);
process.exit(failed.length > 0 ? 1 : 0);
