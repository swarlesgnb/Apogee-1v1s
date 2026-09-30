/**
 * Photograph every screen a brand-new player can reach, in the real bundled client.
 *
 *   npm run build:app
 *   npx electron tools/flowScreens.cjs [--no-stats] [--out .cache/flow/after]
 *
 * Runs dist/app/main.cjs itself rather than the single-file preview, because the first-run
 * flow is mostly main's decisions - folder detection, sign-in state, what the queue is
 * allowed to offer - and the preview stubs all of those out. `--fresh` gives it the same
 * throwaway profile `npm run fresh` uses, so nothing here touches the real one.
 *
 * The signed-in core loop (searching, a match in progress, a settled result) cannot be
 * reached headlessly: sign-in goes through Steam in a browser. Those states are painted
 * by handing the renderer the same shapes main sends it, which is the only honest way to
 * look at them without a second player; each such shot is named `loop-*` so it is never
 * mistaken for a state the app reached by itself.
 */

const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const outArg = process.argv.indexOf("--out");
const out = resolve(root, outArg > 0 ? process.argv[outArg + 1] : ".cache/flow/shots");
const noStats = process.argv.includes("--no-stats");
const prefix = noStats ? "nostats-" : "fresh-";
mkdirSync(out, { recursive: true });

// Windows stops painting a window it thinks is covered, and capturePage then hands back
// whatever frame was last drawn: the first run of this printed each loop state one step
// late. Painting has to continue whether or not anything is in front of the window.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

app.on("browser-window-created", (_e, win) => {
  // The first window is the app's own; anything opened after it is not what is being walked.
  if (app.__flowWin) return;
  app.__flowWin = win;
  win.webContents.on("console-message", (_ev, level, message) => {
    if (level >= 3) errors.push(message);
  });
  win.webContents.once("did-finish-load", () => void drive(win).catch((err) => {
    console.error(err);
    app.exit(1);
  }));
});

async function shot(win, name) {
  await wait(700);
  win.webContents.invalidate();
  await wait(150);
  const png = (await win.webContents.capturePage()).toPNG();
  writeFileSync(join(out, prefix + name + ".png"), png);
  console.log("  " + prefix + name + ".png");
}

async function drive(win) {
  win.setSize(1280, 820);
  const run = (js) => win.webContents.executeJavaScript(js, true);
  // Long enough for the first stats rebuild on the real corpus to land.
  await wait(noStats ? 2500 : 9000);
  await shot(win, "00-first-launch");

  const tabs = await run(`[...document.querySelectorAll('.tab')].filter(t=>!t.hidden).map(t=>t.dataset.screen)`);
  for (const [i, name] of tabs.entries()) {
    await run(`document.querySelector('.tab[data-screen="${name}"]').click(); document.querySelector('.scroll').scrollTop=0`);
    await shot(win, String(i + 1).padStart(2, "0") + "-" + name);
    const tall = await run(`(()=>{const s=document.querySelector('.scroll');return s.scrollHeight>s.clientHeight+40})()`);
    if (tall) {
      await run(`document.querySelector('.scroll').scrollTop=document.querySelector('.scroll').clientHeight*0.9`);
      await shot(win, String(i + 1).padStart(2, "0") + "-" + name + "-lower");
    }
  }

  // The list a match is drawn from, folded at the foot of the queue.
  if (!noStats) {
    await run(`document.querySelector('.tab[data-screen="queue"]').click();
      (() => { const d = document.getElementById('drawPanel'); d.open = true; d.scrollIntoView({ block: 'start' }); })()`);
    await shot(win, "01-queue-pool");
  }

  // What the page says, for the audit: every visible heading, empty-state and button label
  // on the queue screen, so a claim about wording can be checked against the text itself.
  await run(`document.querySelector('.tab[data-screen="queue"]').click()`);
  const text = await run(`(()=>{
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
    return [...document.querySelectorAll('h1,h2,h3,p,button,.empty,.status')].filter(vis).map(e=>e.tagName+': '+e.textContent.replace(/\\s+/g,' ').trim()).filter(s=>s.length>4).slice(0,120);
  })()`);
  writeFileSync(join(out, prefix + "queue-text.txt"), text.join("\n"));

  if (!noStats) await loop(win, run);

  if (errors.length) console.log("renderer errors:\n  " + errors.slice(0, 10).join("\n  "));
  app.exit(0);
}

/**
 * The signed-in loop, painted from outside. Every shape below is one main really sends:
 * a session, an eligibility answer, a seeding match (the only kind a player gets while the
 * population is zero) and a settled result. The scenarios are the real draw for the
 * queued category, so the rows are the ones a player would be handed.
 */
async function loop(win, run) {
  await run(`openScreen("queue")`);
  // `autoUploaded` first: renderEligibility would otherwise press Upload for real.
  await run(`autoUploaded = true;
    renderSession({ displayName: "new player", steamId: "76561190000000000" }, true);
    eligibility = { eligible: false, uploaded: 12, required: 50, missing: 38 };
    renderEligibility();
    document.querySelector(".queue-stage").scrollIntoView({ block: "start" });`);
  await shot(win, "loop-01-signed-in-gated");

  await run(`eligibility = { eligible: true, uploaded: 60, required: 50, missing: 0 };
    renderEligibility();
    setCommit("working", "Searching", "matching on rating · " + (selectedCategory || "any category"), "0:07");
    document.querySelector(".queue-stage").scrollIntoView({ block: "start" });`);
  await shot(win, "loop-02-searching");

  await run(`(() => {
    setCommit("idle", "Find opponent", "", "");
    const window_ = current.benchmark.matchPool.window;
    const rows = practice.scenarios.filter((s) => s.window === window_ &&
      (!selectedCategory || selectedCategory === "Any" || s.category === selectedCategory)).slice(0, 3);
    activeMatch = {
      matchId: "flow-" + Date.now(), seeding: true, opponent: null, poolSize: 0,
      scenarios: rows.map((r, i) => ({ id: "s" + i, name: r.scenario })),
      submittedScenarioIds: [], expiresAt: new Date(Date.now() + 45 * 60000).toISOString(),
    };
    paintActiveMatch();
    $("opponent").scrollIntoView({ block: "start" });
  })()`);
  await shot(win, "loop-03-seeding-match");

  // What onMatchSettled does before it paints, so the result screen sees no open match.
  const settle = `const SCEN = activeMatch ? activeMatch.scenarios : SCEN_KEPT; window.SCEN_KEPT = SCEN;
    activeMatch = null; pendingMatchId = null; delete $("queueBtn").dataset.held;
    $("matchActions").hidden = true; $("opponent").classList.remove("on"); resetCommit(current);`;
  const rounds = `SCEN.map((s, i) => ({ scenario: s.name, score: 900 + i * 150,
      baseline: 880 + i * 140, delta: [0.023, -0.011, 0.041][i], opponentDelta: OPP[i],
      counted: true, verificationTier: "consistent" }))`;
  await run(`(() => { const OPP = [null, null, null]; ${settle}
    renderSettled({ seeding: true, verdict: null, yourMatchScore: 0.018, rounds: ${rounds},
      explanation: "Nothing was rated: there was no opponent to play against. Your run set is " +
        "now in the pool, and the next player to queue this category plays against it." });
    openScreen("result"); })()`);
  await shot(win, "loop-04-first-result");
  await run(`document.querySelector('.scroll').scrollTop = document.querySelector('.scroll').clientHeight * 0.6`);
  await shot(win, "loop-04-first-result-lower");

  await run(`(() => { const OPP = [0.012, 0.004, 0.02]; ${settle}
    renderSettled({ seeding: false, verdict: "win", yourMatchScore: 0.018, theirMatchScore: 0.012,
      ratingChange: 21, ratingAfter: 1521, ratingWeight: 1, rounds: ${rounds},
      explanation: "" });
    openScreen("result"); })()`);
  await shot(win, "loop-05-rated-result");
}

// Never the real profile: main reads --fresh to swap userData for a temporary one, and a
// walk that forgot the flag would write progress and settings into %APPDATA%\apogee.
if (!process.argv.includes("--fresh")) process.argv.push("--fresh");
require(join(root, "dist", "app", "main.cjs"));
