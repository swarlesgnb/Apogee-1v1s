/**
 * Time the real bundled client from launch to a usable queue, and from a run landing to the
 * screen showing it.
 *
 *   npm run build:app
 *   npx electron tools/measureFlow.cjs --stats <dir> [--profile <dir>] [--ingest <staged dir>]
 *        [--out result.json]
 *
 * Loads dist/app/main.cjs into this process, as tools/flowScreens.cjs does, so what is
 * timed is main's own startup. Every time is in milliseconds from this process starting
 * (`performance.timeOrigin`), and renderer times are moved onto the same clock.
 *
 *   firstPaint      the renderer's first contentful paint
 *   readyToShow     main's ready-to-show for the window
 *   queueReady      the first frame on which the queue screen shows the run count, which is
 *                   painted from the snapshot: the earliest moment the queue is usable
 *   mainBlockMax    the longest the main process went without turning its event loop over
 *                   (monitorEventLoopDelay), which is how long a click, an IPC answer or a
 *                   window repaint could have been held up
 *   longTasks       renderer tasks over 50 ms during startup: count, total, longest
 *   memory          main's heap and resident size, and every process's working set, after
 *                   startup has settled
 *
 * With `--ingest <dir>`, each stats file in that folder is moved into the stats folder one
 * at a time (a rename, so it lands whole), and two times are taken for each from the
 * moment of the move: the run toast on screen (main read and parsed it) and the run count
 * on the queue screen going up (the snapshot was rebuilt and painted).
 *
 * `--profile <dir>` keeps the app's profile in that folder instead of a throwaway one, so a
 * second launch can be measured against what the first one left behind. Without it the
 * profile is temporary, like `--fresh`.
 */

const { app } = require("electron");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const { mkdirSync, readdirSync, renameSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const argv = process.argv;
const arg = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
const statsDir = arg("--stats");
const ingestDir = arg("--ingest");
const outFile = arg("--out");
const profile = arg("--profile");
if (!statsDir) {
  console.error("usage: electron tools/measureFlow.cjs --stats <dir> [--profile <dir>] [--ingest <dir>] [--out file]");
  process.exit(2);
}

const now = () => performance.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const harnessAt = now();

// The main process's longest stall. Started before main.cjs is loaded, so the initial scan
// is inside it.
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const result = { statsDir: resolve(statsDir), harnessAt: Math.round(harnessAt) };

app.on("browser-window-created", (_e, win) => {
  if (app.__measured) return;
  app.__measured = win;
  result.windowCreated = Math.round(now());
  win.once("ready-to-show", () => { result.readyToShow = Math.round(now()); });
  // Before the page's own scripts run: a frame loop that notes the first frame on which the
  // run count is painted, and a long-task observer from the start.
  win.webContents.on("dom-ready", () => {
    void win.webContents.executeJavaScript(`(() => {
      window.__flow = { longTasks: [], readyAt: null, toastAt: [], runsAt: [] };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__flow.longTasks.push([e.startTime, e.duration]);
        }).observe({ type: "longtask", buffered: true });
      } catch {}
      // The renderer's own painters, timed, so a long task can be put down to one of them.
      window.__flow.fns = {};
      for (const name of ["render", "paintPractice", "renderBand", "renderSeasonView", "renderRanks",
        "renderScenarioRanks", "renderProfile", "renderPool", "renderCategories", "renderTournaments",
        "renderQuests", "renderCoverage", "renderConsistency", "renderSetup"]) {
        const fn = window[name];
        if (typeof fn !== "function") continue;
        window[name] = function (...args) {
          const t = performance.now();
          try { return fn.apply(this, args); } finally {
            const f = (window.__flow.fns[name] ??= { calls: 0, total: 0, max: 0 });
            const ms = performance.now() - t;
            f.calls++; f.total += ms; f.max = Math.max(f.max, ms);
          }
        };
      }
      const abs = () => performance.timeOrigin + performance.now();
      let lastRuns = null;
      let toastOn = false;
      const frame = () => {
        const runs = document.getElementById("heroRuns");
        const text = runs ? runs.textContent.trim() : "";
        if (/\\d/.test(text)) {
          if (window.__flow.readyAt === null) window.__flow.readyAt = abs();
          if (lastRuns !== null && text !== lastRuns) window.__flow.runsAt.push([abs(), text]);
          lastRuns = text;
        }
        const toast = document.getElementById("toast");
        const on = !!toast && toast.classList.contains("on");
        if (on && !toastOn) window.__flow.toastAt.push(abs());
        toastOn = on;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })()`);
  });
  win.webContents.once("did-finish-load", () => void drive(win).catch((err) => {
    console.error(err);
    app.exit(1);
  }));
});

/** A renderer epoch time on this process's clock. */
const local = (epoch) => (epoch == null ? null : Math.round(epoch - performance.timeOrigin));

async function drive(win) {
  const run = (js) => win.webContents.executeJavaScript(js, true);
  win.show();
  win.focus();

  // Startup: wait for the queue to be painted, then a settle period for anything after it.
  const deadline = now() + 120_000;
  while (now() < deadline) {
    const ready = await run("window.__flow && window.__flow.readyAt");
    if (ready) break;
    await wait(50);
  }
  await wait(3000);

  const start = await run(`(() => {
    const paint = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint");
    const lt = window.__flow.longTasks;
    return {
      origin: performance.timeOrigin,
      fcp: paint ? performance.timeOrigin + paint.startTime : null,
      readyAt: window.__flow.readyAt,
      runs: document.getElementById("heroRuns").textContent.trim(),
      longTasks: lt.length,
      longTaskList: lt.map((t) => [Math.round(performance.timeOrigin + t[0]), Math.round(t[1])]),
      longTaskTotal: lt.reduce((s, t) => s + t[1], 0),
      longTaskMax: lt.reduce((m, t) => Math.max(m, t[1]), 0),
      heap: performance.memory ? performance.memory.usedJSHeapSize : null,
      focused: document.hasFocus(),
      fns: Object.fromEntries(Object.entries(window.__flow.fns).map(([k, v]) =>
        [k, { calls: v.calls, total: Math.round(v.total), max: Math.round(v.max) }])),
    };
  })()`);
  result.firstPaint = local(start.fcp);
  result.queueReady = local(start.readyAt);
  result.runsShown = start.runs;
  result.focused = start.focused;
  result.mainBlockMax = Math.round(loop.max / 1e6);
  result.mainBlockP99 = Math.round(loop.percentile(99) / 1e6);
  result.longTasks = { count: start.longTasks, total: Math.round(start.longTaskTotal), max: Math.round(start.longTaskMax) };
  result.rendererFns = start.fns;
  result.longTaskList = start.longTaskList.map(([at, ms]) => [local(at), ms]);
  const mem = process.memoryUsage();
  result.memory = {
    mainHeapMB: +(mem.heapUsed / 1048576).toFixed(1),
    mainRssMB: +(mem.rss / 1048576).toFixed(1),
    rendererHeapMB: start.heap ? +(start.heap / 1048576).toFixed(1) : null,
    processes: app.getAppMetrics().map((m) => ({ type: m.type, workingSetMB: +(m.memory.workingSetSize / 1024).toFixed(1) })),
  };
  result.memory.totalWorkingSetMB = +result.memory.processes.reduce((s, p) => s + p.workingSetMB, 0).toFixed(1);

  if (ingestDir) {
    loop.reset();
    const staged = readdirSync(ingestDir).filter((f) => f.endsWith("Stats.csv")).sort();
    result.ingest = [];
    for (const file of staged) {
      const before = await run("({ toasts: window.__flow.toastAt.length, runs: window.__flow.runsAt.length })");
      const at = now();
      renameSync(join(ingestDir, file), join(statsDir, file));
      const until = now() + 20_000;
      let toast = null;
      let painted = null;
      while (now() < until && (toast === null || painted === null)) {
        await wait(20);
        const seen = await run(`({ toast: window.__flow.toastAt[${before.toasts}] ?? null, runs: window.__flow.runsAt[${before.runs}] ?? null })`);
        if (seen.toast !== null && toast === null) toast = local(seen.toast) - Math.round(at);
        if (seen.runs !== null && painted === null) painted = local(seen.runs[0]) - Math.round(at);
      }
      result.ingest.push({ file, toastMs: toast, paintedMs: painted });
      // The toast stays up for a few seconds; the next arrival is timed from a clear screen.
      const clear = now() + 10_000;
      while (now() < clear && (await run(`document.getElementById("toast").classList.contains("on")`))) await wait(100);
      await wait(500);
    }
    result.ingestMainBlockMax = Math.round(loop.max / 1e6);
    const lt = await run("window.__flow.longTasks");
    result.longTasksAfterStartup = lt.filter((t) => t[0] + start.origin > start.readyAt + 3000).length;
  }

  console.log(JSON.stringify(result, null, 2));
  if (outFile) {
    mkdirSync(resolve(outFile, ".."), { recursive: true });
    writeFileSync(outFile, JSON.stringify(result, null, 2));
  }
  app.exit(0);
}

// Every IPC handler main registers, timed: a handler that runs long on the main process
// is the usual reason a window that has painted still cannot answer.
const { ipcMain } = require("electron");
const handle = ipcMain.handle.bind(ipcMain);
result.slowIpc = [];
ipcMain.handle = (channel, fn) =>
  handle(channel, async (...a) => {
    const t = now();
    try {
      return await fn(...a);
    } finally {
      const ms = now() - t;
      if (ms >= 50) result.slowIpc.push({ channel, at: Math.round(t), ms: Math.round(ms) });
    }
  });

if (profile) {
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", resolve(profile));
  app.setPath("sessionData", resolve(profile));
} else if (!argv.includes("--fresh")) {
  // Never the real profile.
  argv.push("--fresh");
}
if (!argv.includes("--stats")) argv.push("--stats", statsDir);
require(join(root, "dist", "app", "main.cjs"));
