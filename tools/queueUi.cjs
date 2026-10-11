// Shadows and Flags, rendered from the shareable preview and photographed.
//
//   npx tsx tools/validateQueueFlow.ts          (writes .cache/queue-ui/screens.json)
//   APOGEE_PREVIEW_OUT=.cache/queue-ui/preview.html npx tsx tools/buildUiPreview.ts
//   xvfb-run -a npx electron tools/queueUi.cjs --no-sandbox
//
// The same approach as ghostUi.cjs: the preview page, with a synthetic bridge handed to the
// one feature script under test. What it serves is not invented: screens.json is the real
// output of ranked v2's find-match and settle-match and of queue-board from the PGlite flow
// test, so every sentence photographed here is one the server wrote. Pictures land in
// QUEUE_SHOTS, or .cache/queue-ui/shots.
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
  const settledInApp = `activeMatch=null;document.getElementById('opponent').classList.remove('on');document.getElementById('matchActions').hidden=true;`;

  // 1. before committing: nobody in the band, so a Shadow, and the bank
  await run(`document.querySelector('.tab[data-screen="queue"]').click();true`);
  await choose(screens.planShadow.preview.category);
  assert.equal(await run(`document.getElementById('queuePlan').hidden`), false, 'the plan is shown before queueing');
  const plan = await clean('#queuePlan', 'plan');
  assert.match(plan, /No one in your band right now\./);
  assert.match(plan, /You'll face a Shadow now: an? \d+(st|nd|rd|th)-percentile score on each, a synthetic opponent decided like ranked, best of three on raw score/);
  assert.match(plan, /Your three runs join the bank/);
  await scrollTo('#queuePlan'); await settle(); await fits('plan'); await shot('1-queue-plan-shadow');
  await run(`document.querySelector('#queuePlan details').open=true;true`); await wait(200);
  assert.match(await clean('#queuePlan', 'plan open'), /Season 1's own thresholds put at that percentile/);
  await shot('1b-queue-plan-what-is-a-shadow');

  // 1c. find-match planting fresh scenarios
  await run(`window.__qbSet(${J(screens.planPlant)});true`); await choose('Static Clicking'); await choose('All categories');
  assert.match(await clean('#queuePlan', 'plant plan'), /mostly scenarios you just played, so this is three fresh ones/);
  await scrollTo('#queuePlan'); await shot('1c-queue-plan-planting');

  // 2. the Shadow match itself
  await run(`activeMatch=JSON.parse(${J(screens.matchShadow)});paintActiveMatch();true`); await wait(500);
  assert.equal(await run(`document.getElementById('oppName').textContent`), 'Shadow');
  assert.match(await run(`document.getElementById('oppTier').textContent`), /-percentile score on each · synthetic$/);
  assert.equal(await run(`document.getElementById('queueLiveText').textContent`), 'Shadow match', 'the top bar names it too');
  assert.equal(await run(`document.getElementById('queuePlan').hidden`), true, 'the plan steps aside once a match is open');
  await clean('#opponent', 'match card');
  await scrollTo('#opponent', 'start'); await settle(); await fits('match'); await shot('2-shadow-match');

  // 3. the result: beaten, and lost
  await run(`${settledInApp}renderSettled(JSON.parse(${J(screens.resultShadowWin)}));window.__qbPush(${J(screens.ownerNews)});document.querySelector('.tab[data-screen="result"]').click();true`);
  await wait(600); await settle();
  assert.equal(await run(`document.getElementById('verdictBig').textContent`), 'Shadow beaten');
  const result = await clean('#screen-result .panel', 'result');
  assert.ok(!/Nothing was rated|no opponent/.test(result), 'the result never says there was nobody');
  assert.match(result, /2–1 on rounds · Shadow: an? \d+(st|nd|rd|th)-percentile score on each/);
  assert.match(result, /In the bank/);
  assert.match(result, /Shadow · unrated/i);
  assert.match(result, /Next Shadow: an? \d+(st|nd|rd|th)-percentile score on each/);
  await run(`document.getElementById('queueToast').hidden=true;document.querySelector('#screen-result').scrollIntoView({block:'start'});true`); await wait(200);
  await fits('result'); await shot('3-shadow-result-win');
  await run(`renderSettled(JSON.parse(${J(screens.resultShadowLoss)}));true`); await wait(400); await settle();
  assert.equal(await run(`document.getElementById('verdictBig').textContent`), 'Shadow wins');
  assert.match(await clean('#screen-result .panel', 'loss result'), /0–3 on rounds/);
  await shot('3b-shadow-result-loss');

  // 4. the next launch: somebody played the banked rounds
  await run(`document.querySelector('.tab[data-screen="queue"]').click();true`); await wait(300);
  await run(`window.__qbH.board.forEach(h=>h(JSON.parse(${J(screens.ownerNews)})));true`); await wait(600);
  const toast = await clean('#queueToast', 'toast');
  assert.match(toast, /kestrel played your banked rounds and took 2 of 3\. Unrated for you\./);
  assert.ok(await run(`window.__qbAsks.some(a=>typeof a.ack==='string')`), 'and acknowledged so it is said once');
  await scrollTo('#queueFlags'); await settle(); await shot('4-banked-rounds-toast');
  await run(`document.querySelector('#queueToast [data-qb="close"]').click();true`); await wait(150);
  assert.equal(await run(`document.getElementById('queueToast').hidden`), true, 'the toast dismisses');

  // 5. the panel later on
  await run(`window.__qbPush(${J(screens.boardLater)});true`); await wait(400);
  const panel = await clean('#queueFlags', 'panel');
  assert.match(panel, /kestrel played your banked rounds and took 2 of 3\./);
  assert.match(panel, /Next Shadow:/);
  assert.match(panel, /beaten up to the \d+(st|nd|rd|th)/);
  await scrollTo('#queueFlags'); await settle(); await fits('panel'); await shot('5-shadows-and-banked-rounds');

  win.setSize(820, 1000); await wait(400);
  await fits('panel 820'); await shot('5b-panel-narrow');
  await run(`window.__qbSet(${J(screens.planShadow)});true`); await choose('All categories'); await choose('Static Clicking');
  await scrollTo('#queuePlan'); await fits('plan 820'); await shot('1d-queue-plan-narrow');

  assert.deepEqual(errors, [], 'renderer errors');
  console.log(`PASS: queue plan (Shadow and planting), Shadow match card, Shadow results, banked-rounds toast and panel; screenshots in ${output}`);
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
