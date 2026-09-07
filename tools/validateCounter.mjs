/**
 * countTo, exercised against the source that ships.
 *
 * The function is lifted out of renderer.js rather than retyped here, so this cannot
 * pass against a copy that has drifted from the client. The clock is virtual, so an
 * 800ms tween runs in no time and this stays a script rather than a wait.
 *
 *   npm run validate:counter
 *
 * The first check is the one worth keeping. A counter that spins up from zero on first
 * paint is the default every implementation reaches for, it looks like the others, and
 * it is wrong here: it announces movement on a number that has not moved. If someone
 * simplifies the from === undefined branch away, that check is what says so.
 */
import { readFileSync } from "node:fs";

const src = readFileSync("src/app/renderer/renderer.js", "utf8");
const start = src.indexOf("const COUNT_MIN");
const end = src.indexOf("\n}\n", src.indexOf("function countTo")) + 3;
const code = src.slice(start, end);
if (start < 0 || end < 3) throw new Error("could not lift countTo out of renderer.js");

// Minimal harness: a virtual clock, so a 800ms tween runs in no time at all.
let now = 0;
const queue = [];
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
globalThis.cancelAnimationFrame = (id) => { queue[id - 1] = null; };
let reduce = false;
const reduceMotion = { get matches() { return reduce; } };

const { countTo, COUNT_MIN, COUNT_MAX } = new Function(
  "reduceMotion",
  code + "\nreturn { countTo, COUNT_MIN, COUNT_MAX };",
)(reduceMotion);

const el = () => ({ textContent: "", offsetParent: {}, _countRaf: 0 });
/** Run the clock forward, draining frames at 16ms. */
function run(ms) {
  const until = now + ms;
  while (now < until) {
    now = Math.min(now + 16, until);
    const frame = queue.splice(0, queue.length);
    for (const fn of frame) if (fn) fn(now);
  }
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(52) + String(got) + (ok ? "" : "   want " + want));
};

console.log("countTo, against the shipped source\n");
console.log("clamps: min " + COUNT_MIN + "ms, max " + COUNT_MAX + "ms\n");

// 1. First value is set outright - no tween, no spin-up from zero.
let a = el();
countTo(a, 1617);
check("first value is set immediately", a.textContent, "1617");
check("  and queued no frame", queue.length, 0);

// 2. A change tweens, and lands exactly on the target.
countTo(a, 1634);
check("a change does not jump to the target", a.textContent !== "1634", true);
run(COUNT_MAX + 100);
check("a change lands exactly", a.textContent, "1634");

// 3. Same value again is a no-op.
const before = queue.length;
countTo(a, 1634);
check("re-rendering the same value queues nothing", queue.length, before);

// 4. Duration follows the distance, both ends clamped.
const span = (from, to) => {
  const e = el();
  countTo(e, from);
  countTo(e, to);
  let frames = 0;
  const started = now;
  while (queue.some(Boolean) && frames < 200) { run(16); frames++; }
  return now - started;
};
const small = span(1500, 1502);
const big = span(1500, 1560);
check("a 2-point move is at least the floor", small >= COUNT_MIN, true);
check("a 60-point move takes longer than a 2-point one", big > small, true);
check("a huge move is capped", span(0, 100000) <= COUNT_MAX + 32, true);

// 5. Interrupting retargets from where it is, not from the old start.
const b = el();
countTo(b, 1000);
countTo(b, 2000);
run(120);
const mid = Number(b.textContent);
countTo(b, 1500);
const afterInterrupt = Number(b.textContent);
check("interrupting keeps the value it had reached", afterInterrupt === mid, true);
run(COUNT_MAX + 100);
check("  and still lands on the new target", b.textContent, "1500");

// 6. Reduced motion snaps.
reduce = true;
const c = el();
countTo(c, 100);
countTo(c, 200);
check("reduced motion snaps", c.textContent, "200");
check("  and queues no frame", queue.filter(Boolean).length, 0);
reduce = false;

// 7. A hidden readout snaps rather than burning frames.
const d = el();
countTo(d, 100);
d.offsetParent = null;
countTo(d, 200);
check("a hidden readout snaps", d.textContent, "200");

// 8. The formatters match what render() used to print.
const num = (v) => Math.round(v).toLocaleString();
const e1 = el(); countTo(e1, 105, (v) => "±" + Math.round(v) + " uncertainty");
check("rd formatting", e1.textContent, "±105 uncertainty");
const e2 = el(); countTo(e2, 100 - 50.1, (v) => "top " + v.toFixed(1) + "%");
check("percentile formatting", e2.textContent, "top 49.9%");
const e3 = el(); countTo(e3, 12662, num);
check("runs formatting", e3.textContent, (12662).toLocaleString());

console.log("\n" + (fails === 0 ? "OK: countTo behaves" : fails + " failure(s)"));
process.exit(fails === 0 ? 0 : 1);
