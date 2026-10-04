// Shadows and Flags, rendered from the shareable preview and photographed.
//
//   npx tsx tools/validateQueueFlow.ts          (writes .cache/queue-ui/screens.json)
//   APOGEE_PREVIEW_OUT=.cache/queue-ui/preview.html npx tsx tools/buildUiPreview.ts
//   xvfb-run -a npx electron tools/queueUi.cjs --no-sandbox
//
// The same approach as ghostUi.cjs: the preview page, with a synthetic bridge handed to the
// one feature script under test. What it serves is not invented: screens.json is the real
// output of find-match, settle-match and queue-board from the PGlite flow test, so every
// sentence photographed here is one the server wrote. Pictures land in QUEUE_SHOTS, or
// .cache/queue-ui/shots.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

const root = resolve('.cache/queue-ui');
const output = process.env.QUEUE_SHOTS ? resolve(process.env.QUEUE_SHOTS) : join(root, 'shots');
mkdirSync(output, { recursive: true });
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-queue-')));
const screens = JSON.parse(readFileSync(join(root, 'screens.json'), 'utf8'));
const errors = [];
let win;
const run = (s) => win.webContents.executeJavaScript(s, true).catch((e) => { console.error('FAILED:', s.slice(0, 160), errors); throw e; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { writeFileSync(join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
const settle = async () => { await run('document.getAnimations().forEach(a=>{try{a.finish()}catch{}});true'); await wait(150); };
const J = (v) => JSON.stringify(JSON.stringify(v));

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_, level, message) => { if (level >= 3) errors.push(message); });

  const marker = '<script>/* Shadows and Flags on the queue';
  const bridge = '<script>window.__qbAsks=[];window.__qbH={board:[],match:[],settled:[],session:[]};' +
    `window.__qbBoard=${JSON.stringify(screens.planShadow)};` +
    'window.__qbSet=(json)=>{window.__qbBoard=JSON.parse(json);};' +
    'window.__qbPush=(json)=>{window.__qbBoard=JSON.parse(json);window.__qbH.board.forEach(h=>h(window.__qbBoard));};' +
    'window.apogee=Object.assign(window.apogee||{},{' +
    'queueBoard:async(a)=>{window.__qbAsks.push(a||{});return {board:a&&a.ack?{...window.__qbBoard,news:[]}:window.__qbBoard};},' +
    'onQueueBoard:h=>window.__qbH.board.push(h),onMatch:h=>window.__qbH.match.push(h),' +
    'onMatchSettled:h=>window.__qbH.settled.push(h),onSession:h=>window.__qbH.session.push(h)});</script>';
  const page = readFileSync(join(root, 'preview.html'), 'utf8');
  assert.ok(page.includes(marker), 'the preview carries queue-board.js: build it with APOGEE_PREVIEW_OUT=.cache/queue-ui/preview.html');
  writeFileSync(join(root, 'fixture.html'), page.replace(marker, bridge + marker));
  await win.loadFile(join(root, 'fixture.html'));
  await wait(1200);

  const fits = async (label) => assert.ok(await run(`document.querySelector('.scroll')?(document.querySelector('.scroll').scrollWidth<=document.querySelector('.scroll').clientWidth+2):document.documentElement.scrollWidth<=innerWidth+2`), 'no sideways scroll: ' + label);
  const clean = async (selector, label) => {
    const text = await run(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(e=>e.innerText).join(' ')`);
    assert.ok(!/NaN|undefined|null/.test(text), `no NaN, undefined or null: ${label}: ${text.slice(0, 200)}`);
    return text;
  };
  const choose = async (category) => {
    await run(`(document.querySelector('#cats button[aria-label^=${JSON.stringify(category)}]')||{click(){}}).click();true`);
    await wait(500);
  };
  const scrollTo = async (sel, block = 'center') => { await run(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'${block}'});true`); await wait(250); };

  // 1. before committing: nobody in the band, so a Shadow, and a Flag
  await run(`document.querySelector('.tab[data-screen="queue"]').click();true`);
  await choose(screens.planShadow.preview.category);
  assert.equal(await run(`document.getElementById('queuePlan').hidden`), false, 'the plan is shown before queueing');
  const plan = await clean('#queuePlan', 'plan');
  assert.match(plan, /No one in your band right now\./);
  assert.match(plan, /You'll face a Shadow now: a \d+(st|nd|rd|th)-percentile day/);
  assert.match(plan, /planted as a Flag in Intermediate · Static Clicking/);
  await scrollTo('#queuePlan'); await settle(); await fits('plan'); await shot('1-queue-plan-shadow');
  await run(`document.querySelector('#queuePlan details').open=true;true`); await wait(200); await shot('1b-queue-plan-what-is-a-shadow');

  // 2. the Shadow match itself
  await run(`activeMatch=JSON.parse(${J(screens.matchShadow)});paintActiveMatch();true`); await wait(500);
  assert.equal(await run(`document.getElementById('oppName').textContent`), 'Shadow');
  assert.equal(await run(`document.getElementById('queueLiveText').textContent`), 'Shadow match', 'the top bar names it too');
  assert.match(await run(`document.getElementById('oppTier').textContent`), /-percentile day · synthetic$/);
  assert.match(await run(`document.getElementById('oddsYou').textContent`), /^a typical day wins \d+%$/);
  assert.equal(await run(`document.getElementById('queuePlan').hidden`), true, 'the plan steps aside once a match is open');
  await clean('#opponent', 'match card');
  await scrollTo('#opponent', 'start'); await settle(); await fits('match'); await shot('2-shadow-match');

  // 3. the result: beaten, and lost
  const settledInApp = `activeMatch=null;document.getElementById('opponent').classList.remove('on');document.getElementById('matchActions').hidden=true;`;
  await run(`${settledInApp}renderSettled(JSON.parse(${J(screens.resultShadowWin)}));window.__qbPush(${J(screens.boardAfterFirst)});document.querySelector('.tab[data-screen="result"]').click();true`);
  await wait(600); await settle();
  assert.equal(await run(`document.getElementById('verdictBig').textContent`), 'Shadow beaten');
  const result = await clean('#screen-result .panel', 'result');
  assert.ok(!/Nothing was rated|no opponent/.test(result), 'the result never says there was nobody');
  assert.match(result, /Flag planted\s+Intermediate band, Static Clicking\. It settles when someone answers it \(up to 7 days\)\./);
  assert.match(result, /Shadow · unrated/i);
  assert.match(result, /Next Shadow: an? \d+(st|nd|rd|th)-percentile day/);
  await run(`document.querySelector('#screen-result').scrollIntoView({block:'start'});true`); await wait(200);
  await fits('result'); await shot('3-shadow-result-win');
  await run(`renderSettled(JSON.parse(${J(screens.resultShadowLoss)}));true`); await wait(400); await settle();
  assert.equal(await run(`document.getElementById('verdictBig').textContent`), 'Shadow wins');
  await clean('#screen-result .panel', 'loss result');
  await shot('3b-shadow-result-loss');

  // 4. the second player: a run set is waiting, they answer the Flag
  await run(`window.__qbSet(${J(screens.planOpponent)});document.querySelector('.tab[data-screen="queue"]').click();true`);
  await choose('Any'); await choose(screens.planOpponent.preview.category);
  const opp = await clean('#queuePlan', 'opponent plan');
  assert.match(opp, /stored run set is waiting in Intermediate · Static Clicking\. You'll be matched on rating; the result is rated\./);
  await scrollTo('#queuePlan'); await shot('4-queue-plan-opponent');
  await run(`activeMatch=JSON.parse(${J(screens.matchAnswer)});paintActiveMatch();true`); await wait(500);
  assert.match(await run(`document.getElementById('oppAge').textContent`), /answering their Flag$/);
  assert.match(await run(`document.getElementById('matchHint').textContent`), /settles rated for both of you/);
  await scrollTo('#opponent', 'start'); await settle(); await shot('4b-answer-match');
  await run(`${settledInApp}renderSettled(JSON.parse(${J(screens.resultAnswer)}));document.querySelector('.tab[data-screen="result"]').click();true`);
  await wait(500); await settle();
  assert.match(await clean('#queueResult', 'answer card'), /You answered a Flag, so this settled rated for both of you\./);
  await shot('4c-answer-result');

  // 5. the planter's next launch: the news, once
  await run(`document.querySelector('.tab[data-screen="queue"]').click();window.__qbPush(${J(screens.planterNews)});true`); await wait(700);
  assert.equal(await run(`document.getElementById('queueToast').hidden`), false, 'the answered Flag is announced');
  const toast = await clean('#queueToast', 'toast');
  assert.match(toast, /Your Static Clicking Flag was answered by kestrel: you won, \+\d+ rating\./);
  assert.ok(await run(`window.__qbAsks.some(a=>Array.isArray(a.ack)&&a.ack.length===1)`), 'and acknowledged so it is said once');
  await scrollTo('#queueFlags'); await settle(); await shot('5-flag-answered-toast');
  await run(`window.__qbPush(${J(screens.planterNews)});true`); await wait(300);
  const asks = await run(`window.__qbAsks.filter(a=>a.ack).length`);
  assert.equal(asks, 1, 'the same news is not announced twice in one session');

  // 6. the Flags panel later on: answered, raced, expired
  await run(`window.__qbPush(${J(screens.boardLater)});true`); await wait(400);
  assert.match(await clean('#queueToast', 'second toast'), /Your Precise Tracking Flag was answered by rook: they won, −\d+ rating\./, 'a lost Flag is news too');
  await run(`document.querySelector('#queueToast [data-qb="close"]').click();true`); await wait(150);
  assert.equal(await run(`document.getElementById('queueToast').hidden`), true, 'the toast dismisses');
  const panel = await clean('#queueFlags', 'flags panel');
  assert.match(panel, /Expired unanswered/);
  assert.match(panel, /Won vs kestrel/);
  assert.match(panel, /Next Shadow:/);
  await scrollTo('#queueFlags'); await settle(); await fits('flags panel'); await shot('6-flags-panel');

  // Narrow window.
  win.setSize(820, 1000); await wait(400);
  await fits('flags panel 820'); await shot('6b-flags-panel-narrow');
  await run(`window.__qbSet(${J(screens.planShadow)});true`); await choose('Any'); await choose('Static Clicking');
  await scrollTo('#queuePlan'); await fits('plan 820'); await shot('1c-queue-plan-narrow');

  assert.deepEqual(errors, [], 'renderer errors');
  console.log(`PASS: queue plan (Shadow and opponent), Shadow match card, Shadow results, Flag answer, news toast and Flags panel; screenshots in ${output}`);
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
