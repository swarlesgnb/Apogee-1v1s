/**
 * The readout helpers, exercised against the source that ships.
 *
 * countTo and fillTo are lifted out of renderer.js rather than retyped here, so this
 * cannot pass against a copy that has drifted from the client. The clock is virtual, so
 * an 800ms tween runs in no time and this stays a script rather than a wait.
 *
 *   npm run validate:counter
 *
 * Two behaviours are worth the file on their own.
 *
 * A counter that spins up from zero on first paint is the default every implementation
 * reaches for, it looks like the others, and it is wrong here: it announces movement on
 * a number that has not moved. If someone simplifies the `from === undefined` branch
 * away, the first check is what says so.
 *
 * The keyed path is what makes any of this work on the ranks and season screens, which
 * throw their DOM away and rebuild it on every snapshot. An element there has never held
 * a value, so without the key nothing would ever animate - and it would fail silently,
 * looking exactly like a screen whose numbers happen not to have changed.
 */

import { readFileSync } from "node:fs";

const src = readFileSync("src/app/renderer/renderer.js", "utf8").replace(/\r\n/g, "\n");

/** Lift one declaration out of the client, or fail loudly rather than test nothing. */
function lift(marker, kind = "fn") {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error("could not find `" + marker + "` in renderer.js");
  if (kind === "line") return src.slice(at, src.indexOf("\n", at) + 1);
  const end = src.indexOf("\n}\n", at);
  if (end < 0) throw new Error("could not find the end of `" + marker + "`");
  return src.slice(at, end + 3);
}

const code = [
  lift("const lastReadout = new Map();", "line"),
  lift("const COUNT_MIN", "line"),
  lift("const COUNT_MAX", "line"),
  lift("const COUNT_PER_UNIT", "line"),
  lift("const easeOutQuint", "line"),
  lift("function countTo("),
  lift("function setFill("),
  lift("const pendingFills = [];", "line"),
  lift("function fillTo("),
  lift("function flushFills("),
].join("\n");

// Minimal harness: a virtual clock, so a tween runs in no time at all.
let now = 0;
const queue = [];
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
globalThis.cancelAnimationFrame = (id) => { queue[id - 1] = null; };
let reduce = false;
const reduceMotion = { get matches() { return reduce; } };
let reflows = 0;
const document = { body: { get offsetWidth() { reflows++; return 1; } } };

const { countTo, fillTo, flushFills, lastReadout, COUNT_MIN, COUNT_MAX } = new Function(
  "reduceMotion",
  "document",
  code + "\nreturn { countTo, fillTo, flushFills, lastReadout, COUNT_MIN, COUNT_MAX };",
)(reduceMotion, document);

const el = () => ({ textContent: "", offsetParent: {}, _countRaf: 0, style: {} });
const scaleOf = (e) => Number(/scaleX\(([\d.]+)\)/.exec(e.style.transform ?? "")?.[1]);

function run(ms) {
  const until = now + ms;
  while (now < until) {
    now = Math.min(now + 16, until);
    for (const fn of queue.splice(0, queue.length)) if (fn) fn(now);
  }
}

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(56) + String(got) + (ok ? "" : "   want " + want));
};

console.log("readout helpers, against the shipped source\n");
console.log("clamps: min " + COUNT_MIN + "ms, max " + COUNT_MAX + "ms\n");
console.log("counters");

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
  while (queue.some(Boolean) && frames < 300) { run(16); frames++; }
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
check("interrupting keeps the value it had reached", Number(b.textContent) === mid, true);
run(COUNT_MAX + 100);
check("  and still lands on the new target", b.textContent, "1500");

// 6. Reduced motion, and a readout nobody is looking at, both snap.
reduce = true;
const c = el();
countTo(c, 100); countTo(c, 200);
check("reduced motion snaps", c.textContent, "200");
check("  and queues no frame", queue.filter(Boolean).length, 0);
reduce = false;
const d = el();
countTo(d, 100);
d.offsetParent = null;
countTo(d, 200);
check("a hidden readout snaps", d.textContent, "200");

// 7. The formatters match what the screens used to print.
const num = (v) => Math.round(v).toLocaleString();
const f1 = el(); countTo(f1, 105, (v) => "±" + Math.round(v) + " uncertainty");
check("rd formatting", f1.textContent, "±105 uncertainty");
const f2 = el(); countTo(f2, 100 - 50.1, (v) => "top " + v.toFixed(1) + "%");
check("percentile formatting", f2.textContent, "top 49.9%");
const f3 = el(); countTo(f3, 12662, num);
check("runs formatting", f3.textContent, (12662).toLocaleString());

// 8. The keyed path: a readout that is a different element every render.
console.log("\nkeyed readouts, for the screens that rebuild their DOM");
const rebuilt1 = el();
countTo(rebuilt1, 3, undefined, "held:Static Clicking");
check("first render of a keyed readout snaps", rebuilt1.textContent, "3");
const rebuilt2 = el();                       // a different element, same readout
countTo(rebuilt2, 4, undefined, "held:Static Clicking");
check("a rebuilt element still knows it changed", rebuilt2.textContent !== "4", true);
run(COUNT_MAX + 100);
check("  and lands on the new value", rebuilt2.textContent, "4");
const rebuilt3 = el();
countTo(rebuilt3, 4, undefined, "held:Static Clicking");
check("an unchanged keyed readout does not move", rebuilt3.textContent, "4");
check("  and queues no frame", queue.filter(Boolean).length, 0);
const other = el();
countTo(other, 9, undefined, "held:Tracking");
check("a different key is its own readout", other.textContent, "9");

// 9. Fills.
console.log("\nfills");
const bar1 = el();
fillTo(bar1, 0.4, "bandbar:x");
check("a fill with no history is set outright", scaleOf(bar1), 0.4);
check("  and queues nothing to flush", (flushFills(), reflows), 0);

const bar2 = el();                            // rebuilt, same bar
fillTo(bar2, 0.75, "bandbar:x");
check("a rebuilt fill starts from the old value", scaleOf(bar2), 0.4);
flushFills();
check("  and flushing moves it to the new one", scaleOf(bar2), 0.75);
check("  having forced exactly one layout", reflows, 1);

const bar3 = el(), bar4 = el();
fillTo(bar3, 0.1, "bandbar:y");  fillTo(bar3, 0.2, "bandbar:y");
fillTo(bar4, 0.1, "bandbar:z");  fillTo(bar4, 0.3, "bandbar:z");
flushFills();
check("two bars share one forced layout", reflows, 2);
check("  first bar moved", scaleOf(bar3), 0.2);
check("  second bar moved", scaleOf(bar4), 0.3);

const clampd = el();
fillTo(clampd, 0.5, "bandbar:c");
fillTo(clampd, 4, "bandbar:c");
flushFills();
check("a share past 1 is clamped", scaleOf(clampd), 1);

reduce = true;
const bar5 = el();
fillTo(bar5, 0.9, "bandbar:x");
check("reduced motion sets the fill outright", scaleOf(bar5), 0.9);
const wasReflows = reflows;
flushFills();
check("  and leaves nothing to flush", reflows, wasReflows);
reduce = false;

check("the keyed memory holds every readout touched", lastReadout.size > 5, true);

console.log("\n" + (fails === 0 ? "OK: the readout helpers behave" : fails + " failure(s)"));
process.exit(fails === 0 ? 0 : 1);
