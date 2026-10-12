/**
 * Photograph the social screens in the real bundled client, and check the link path end to
 * end: a first launch carrying a link, and a second launch handing one to the first.
 *
 *   npx tsx tools/socialUiFixture.ts
 *   npm run build:app
 *   xvfb-run -a npx electron tools/socialUi.cjs --no-sandbox [--out <dir>]
 *
 * Runs dist/app/main.cjs itself, in a throwaway profile (socialUiFixture.ts writes it, with
 * settings.json pointing at the synthetic stats folder). The Daily is drawn, read and scored
 * by main from that folder; two of today's runs are copied in while the app watches, so the
 * screen fills because the watcher saw them land. The second-instance check launches this
 * file again with the same profile and a link on its command line: Electron's lock hands
 * that argv to the first instance, which must show what the link proposes.
 *
 * Signed-in states (the board, a checked challenge, the open-challenge panel) cannot be
 * reached without Steam and a deployed backend. Those are painted by sending the window the
 * exact shapes main sends, and every such picture is named `painted-*`.
 */

const { app, BrowserWindow } = require("electron");
const { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const root = resolve(__dirname, "..");
const fixture = resolve(root, ".cache/social-ui");
const profile = join(fixture, "profile");
const second = process.argv.includes("--second");
const outArg = process.argv.indexOf("--out");
const out = resolve(root, outArg > 0 ? process.argv[outArg + 1] : ".cache/social-ui/shots");

app.setPath("userData", profile);
app.setPath("sessionData", join(profile, "session"));
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

if (!second) {
  mkdirSync(out, { recursive: true });
  const draw = JSON.parse(readFileSync(join(fixture, "draw.json"), "utf8"));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const errors = [];
  let driving = false;

  app.on("browser-window-created", (_e, win) => {
    if (driving) return;
    driving = true;
    win.webContents.on("console-message", (_ev, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.once("did-finish-load", () => void drive(win, draw, errors).catch((err) => {
      console.error(err);
      app.exit(1);
    }));
  });

  async function shot(win, name) {
    await wait(500);
    win.webContents.invalidate();
    await wait(150);
    writeFileSync(join(out, name + ".png"), (await win.webContents.capturePage()).toPNG());
    console.log("  " + name + ".png");
  }

  async function drive(win, draw, errors) {
    win.setSize(1320, 900);
    const run = (js) => win.webContents.executeJavaScript(js, true);
    await wait(6000);

    // 1. The first launch carried apogee://duel/...: signed out, so the prompt says sign in.
    const prompt = await run(`(() => { const d = document.querySelector('.sl-dialog'); return d ? d.innerText : null; })()`);
    assert.ok(prompt && /Open challenge/.test(prompt) && /Sign in with Steam/.test(prompt), "a first launch from a challenge link shows the prompt: " + prompt);
    assert.ok(/ABCD2345/.test(prompt), "the prompt names the parsed code");
    await shot(win, "01-link-prompt-first-launch-signed-out");
    await run(`document.querySelector('[data-sl="dismiss"]').click()`);
    await wait(300);
    assert.equal(await run(`document.querySelector('.sl-overlay').hidden`), true, "Close dismisses the prompt");

    // 2. The Daily, one of three played.
    await run(`document.querySelector('.tab[data-screen="daily"]').click(); document.querySelector('.scroll').scrollTop = 0`);
    await wait(800);
    const one = await run(`document.getElementById('dailyRoot').innerText`);
    assert.ok(one.includes("Daily #" + draw.number), "the Daily screen shows today's number");
    for (const s of draw.scenarios) assert.ok(one.includes(s), "the Daily screen names " + s);
    assert.ok(/1 of 3 in/.test(one), "one of three is counted: " + one.slice(0, 400));
    await shot(win, "02-daily-one-of-three");

    // 3. Two more runs land: copied in as KovaaK's would write them.
    for (const f of draw.pending) copyFileSync(join(fixture, "pending", f), join(fixture, "stats", f));
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      await wait(500);
      done = await run(`document.getElementById('dailyRoot').dataset.state === 'complete'`);
    }
    assert.ok(done, "the watcher saw both runs land and the Daily completed");
    const text = await run(`document.querySelector('.dy-share pre').textContent`);
    assert.match(text, new RegExp("^Apogee Daily #" + draw.number + " · Intermediate\\n"), "share text heads with the number and band");
    for (const s of draw.scenarios) assert.ok(!text.includes(s), "the share text names no scenario");
    writeFileSync(join(out, "share-text.txt"), text);
    await wait(2500); // the share image is drawn by main's card renderer
    const img = await run(`!!document.querySelector('.dy-frame img')`);
    assert.ok(img, "the share image preview was drawn by the card renderer");
    await shot(win, "03-daily-complete");
    await run(`document.querySelector('.dy-result').scrollIntoView({ block: 'start' })`);
    await shot(win, "04-daily-share");
    const png = await run(`window.apogee.shareCard('daily', 'landscape', 'preview')`);
    assert.ok(png.ok, "the daily card renders: " + png.error);
    writeFileSync(join(out, "05-daily-share-card-landscape.png"), Buffer.from(png.png.split(",")[1], "base64"));
    const story = await run(`window.apogee.shareCard('daily', 'portrait', 'preview')`);
    writeFileSync(join(out, "06-daily-share-card-story.png"), Buffer.from(story.png.split(",")[1], "base64"));

    // 4. A second launch with a daily link for another band: Electron hands its argv to
    //    this instance, which must open the Daily and offer (not make) the switch.
    await run(`document.querySelector('.tab[data-screen="queue"]').click()`);
    await wait(400);
    const child = spawn(process.execPath, [__filename, "--no-sandbox", "--second", "apogee://daily/" + draw.today + "/advanced"], { stdio: "inherit", env: process.env });
    const code = await new Promise((r) => child.on("exit", r));
    let banner = null;
    for (let i = 0; i < 30 && !banner; i++) {
      await wait(300);
      banner = await run(`(() => { const p = document.querySelector('.dy-proposal'); return p && document.getElementById('screen-daily').classList.contains('active') ? p.innerText : null; })()`);
    }
    assert.ok(banner && /Advanced/.test(banner), "second-instance argv opened the Daily with the Advanced band offered: " + banner);
    assert.equal(await run(`document.querySelector('.dy-bands [aria-pressed="true"]').textContent`), "Intermediate", "the link did not switch the band on its own");
    console.log("  second instance exited " + code + "; its link reached the first instance");
    await run(`document.querySelector('.scroll').scrollTop = 0`);
    await shot(win, "07-daily-link-from-second-instance");

    // 5. A refused link from a second launch leaves a notice, never the link's text.
    const bad = spawn(process.execPath, [__filename, "--no-sandbox", "--second", "apogee://open/C:/Windows/System32/calc.exe"], { stdio: "inherit", env: process.env });
    await new Promise((r) => bad.on("exit", r));
    await wait(800);
    const notice = await run(`document.getElementById('banner') ? document.getElementById('banner').innerText : ''`);
    assert.ok(/asks for something this version does not do/.test(notice), "a refused link leaves its notice: " + notice);
    assert.ok(!/calc/.test(notice), "and never echoes the link");
    await shot(win, "08-refused-link-notice");

    // 6. Painted: what the prompt says once a code is looked up for a signed-in player.
    win.webContents.send("apogee:link", {
      id: 9001, kind: "duel", code: "Q7MX4KPA", state: "ready", title: "Open challenge from RYLEE",
      lines: ["Precise Tracking · Intermediate", "Unrated: an open challenge never moves anybody's rating.", "You play the same three scenarios. Their score stays hidden until yours is in.", "3 players have answered it."],
      confirm: "Accept and play", error: null, duel: null, navigate: "queue",
    });
    await wait(400);
    await shot(win, "painted-09-link-prompt-ready");
    await run(`document.querySelector('[data-sl="dismiss"]').click()`);

    // 7. Painted: signed in, the board placed, and the open-challenge panel.
    win.webContents.send("apogee:session", { displayName: "RYLEE", steamId: "76561190000000000", playerId: "p" });
    const screen = await run(`window.apogee.daily()`);
    screen.signedIn = true;
    screen.board = { state: "posted", message: null, board: { dailyNumber: screen.number, window: 1, band: "Intermediate", players: 23, ranked: 21,
      quartiles: [-0.021, 0.004, 0.027], you: { meanDelta: screen.meanDelta, glyphs: screen.rounds.map((r) => r.glyph), provisional: screen.provisional, percentile: 71.4, rank: 7 }, streak: 4 } };
    // The tab first: opening the screen asks main for the real (signed-out) one.
    await run(`document.querySelector('.tab[data-screen="daily"]').click()`);
    await wait(700);
    win.webContents.send("apogee:daily", screen);
    await wait(500);
    const board = await run(`document.querySelector('.dy-board').innerText`);
    assert.ok(/Ahead of 71%/.test(board), "the board places the player: " + board);
    await run(`document.querySelector('.dy-board').scrollIntoView({ block: 'center' })`);
    await shot(win, "painted-10-daily-board");
    await run(`document.querySelector('.tab[data-screen="queue"]').click()`);
    await wait(500);
    const panel = await run(`(() => { const p = document.getElementById('openChallenge'); if (!p || p.hidden) return null; p.scrollIntoView({ block: 'center' }); return p.innerText; })()`);
    assert.ok(panel && /Open challenge/.test(panel), "the open-challenge panel appears once signed in");
    await shot(win, "painted-11-open-challenge-panel");

    // 8. The Links & Discord menu.
    await run(`document.getElementById('socialMenu').open = true`);
    await wait(300);
    await shot(win, "12-links-and-discord-menu");
    const box = await run(`document.getElementById('slDiscord').disabled`);
    assert.equal(box, true, "with no Discord application id in this build, the toggle is off and disabled");

    // 9. Narrow window.
    await run(`document.getElementById('socialMenu').open = false; document.querySelector('.tab[data-screen="daily"]').click()`);
    win.setSize(960, 820);
    await wait(600);
    await shot(win, "13-daily-narrow");

    const real = errors.filter((e) => !/Autofill|net::ERR|favicon/i.test(e));
    if (real.length) console.log("renderer errors:\n  " + real.join("\n  "));
    assert.equal(real.length, 0, "no renderer errors");
    console.log("OK: social screens photographed to " + out);
    app.exit(0);
  }

  // The first launch carries a challenge link, as Windows passes one to a new process.
  process.argv.push("apogee://duel/abcd2345");
}

require(join(root, "dist", "app", "main.cjs"));
