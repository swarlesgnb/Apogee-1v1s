// The Crowns screen, the live bar, the race panel and a challenge's result, rendered headless
// from a private copy of the UI preview and photographed.
//
//   npm run validate:crowns-ui      (under Linux: xvfb-run -a npx electron tools/crownsUi.cjs --no-sandbox)
//
// The approach of ghostUi.cjs: the preview page, with a synthetic bridge handed to the
// feature scripts under test. The payloads it serves come from the real view builders
// (tools/crownsUiFixture.ts), so the pictures are what the app would draw for that data.
// Pictures land in .cache/crowns/, and in APOGEE_SHOTS_DIR when that is set.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

const output = resolve('.cache/crowns');
mkdirSync(output, { recursive: true });
const shotsDir = process.env.APOGEE_SHOTS_DIR || null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-crowns-')));
const screens = JSON.parse(readFileSync(join(output, 'screens.json'), 'utf8'));
const errors = [];
let win;
const run = (s) => win.webContents.executeJavaScript(s, true).catch((e) => { console.error('FAILED:', s.slice(0, 160), errors); throw e; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const file = join(output, name + '.png');
  writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  if (shotsDir) copyFileSync(file, join(shotsDir, name + '.png'));
};
const settle = async () => { await run(`document.getAnimations().forEach(a=>{try{a.finish()}catch{}});true`); await wait(120); };
const push = (channel, payload) => run(`window.__arenaPush(${JSON.stringify(channel)}, ${JSON.stringify(JSON.stringify(payload))});true`);

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_, level, message) => { if (level >= 3) errors.push(message); });

  // The bridge: what preload exposes, answering from the fixtures and recording calls.
  const bridge = `<script>
    window.__arena = { calls: [], handlers: {}, board: ${JSON.stringify(screens.board)}, races: ${JSON.stringify(screens.races)}, duels: ${JSON.stringify(screens.duels)} };
    window.__arenaPush = (channel, json) => { const v = JSON.parse(json); (window.__arena.handlers[channel] || []).forEach((h) => h(v)); };
    const on = (channel) => (h) => { (window.__arena.handlers[channel] ||= []).push(h); return () => {}; };
    const rec = (name, result) => async (...args) => { window.__arena.calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };
    window.apogee = Object.assign(window.apogee || {}, {
      crowns: rec('crowns', () => ({ board: window.__arena.board })),
      challengeCrown: rec('challengeCrown', () => ({ match: ${JSON.stringify(screens.crownMatch)} })),
      onCrowns: on('crowns'),
      races: rec('races', () => ({ board: window.__arena.races })),
      inviteRace: rec('inviteRace', { race: null }),
      acceptRace: rec('acceptRace', { match: null }),
      declineRace: rec('declineRace', { race: null }),
      cancelRace: rec('cancelRace', { race: null }),
      onRaces: on('races'),
      raceLive: rec('raceLive', { view: null }),
      onLive: on('live'),
      duels: rec('duels', () => ({ board: window.__arena.duels })),
      onDuels: on('duels'),
      onMatch: on('match'),
      onMatchSettled: on('settled'),
    });
  </script>`;
  const marker = '<script>/* Crowns:';
  const page = readFileSync(join(output, 'preview.html'), 'utf8');
  assert.ok(page.includes(marker), 'the preview carries crowns.js: run tsx tools/crownsUiFixture.ts first');
  writeFileSync(join(output, 'fixture.html'), page.replace(marker, bridge + marker));
  await win.loadFile(join(output, 'fixture.html'));
  await wait(700);

  const fits = async (label) => assert.ok(await run(`document.querySelector('.scroll').scrollWidth<=document.querySelector('.scroll').clientWidth+2`), 'no sideways scroll: ' + label);
  const noNaN = async (label) => assert.ok(!(await run(`/NaN|undefined|\\[object/.test(document.getElementById('crownsRoot').innerText)`)), 'no NaN or undefined: ' + label);

  // ---- 1. the board ----------------------------------------------------------------
  await run(`document.querySelector('.tab[data-screen="crowns"]').click();true`);
  await wait(400);
  assert.equal(await run(`document.getElementById('screen-crowns').classList.contains('active')`), true, 'the Crowns tab opens its screen');
  await push('crowns', screens.board);
  await wait(300);
  assert.equal(await run(`document.querySelectorAll('.cr-card').length`), screens.board.crowns.length, 'one card per Crown');
  assert.equal(await run(`document.querySelectorAll('.cr-card.held').length`), screens.board.crowns.filter((c) => c.status === 'held').length, 'held Crowns drawn as held');
  assert.equal(await run(`document.querySelectorAll('.cr-card.yours').length`), 1, 'the Crown you hold is marked');
  assert.equal(await run(`document.querySelectorAll('.cr-notice').length`), 2, 'both notices shown');
  assert.ok(await run(`document.querySelector('.cr-notice.dethroned p').textContent.startsWith('You lost the Precise Tracking Crown (Intermediate) to Kestrel after 3 defences')`), 'the dethroned notice reads as specified');
  assert.ok(await run(`!!document.querySelector('.cr-notice.dethroned [data-cr="challenge"]')`), 'the dethroned notice offers a challenge back');
  assert.equal(await run(`document.querySelector('.tab[data-screen="crowns"] .cr-badge').textContent`), '2', 'the tab carries the unread count');
  assert.ok(await run(`(()=>{const t=document.querySelector('.tab[data-screen="crowns"]');const k=t.querySelector('.tab-key').getBoundingClientRect();const l=t.querySelector('.tab-label').getBoundingClientRect();return Math.abs((k.top+k.bottom)/2-(l.top+l.bottom)/2)<6;})()`), 'the badge leaves the shortcut key on the label line');
  assert.ok(await run(`[...document.querySelectorAll('.cr-card')].every(c=>c.scrollWidth<=c.clientWidth+1)`), 'nothing overflows a card');
  assert.ok(await run(`[...document.querySelectorAll('.cr-card')].some(c=>/Again in/.test(c.textContent))`), 'a Crown on cooldown says when it opens');
  await run(`document.querySelector('.cr-card[data-key="Precise Tracking|1"] [data-cr="toggle"]').click();true`);
  await wait(150);
  assert.ok(await run(`document.querySelector('.cr-card[data-key="Precise Tracking|1"] .cr-detail').textContent.includes('taken by Kestrel')`), 'the detail shows the history');
  const rebased = { ...screens.races, incoming: screens.races.incoming.map((r) => ({ ...r, expiresAt: new Date(Date.now() + 140000).toISOString() })) };
  await push('races', rebased);
  await wait(200);
  await settle();
  await fits('board'); await noNaN('board');
  await shot('crowns-1-board');

  // A Challenge press sends the Crown and nothing else.
  await run(`document.querySelector('.cr-card[data-key="Dynamic Clicking|1"] [data-cr="challenge"]').click();true`);
  await wait(300);
  assert.deepEqual(await run(`window.__arena.calls.find(c=>c[0]==='challengeCrown')`), ['challengeCrown', 'Dynamic Clicking', 1], 'Challenge sends the category and band only');
  await run(`document.querySelector('.tab[data-screen="crowns"]').click();true`);
  await wait(200);
  await run(`document.querySelector('.cr-notice.defended [data-cr="dismiss"]').click();true`);
  await wait(200);
  assert.deepEqual(await run(`window.__arena.calls.filter(c=>c[0]==='crowns').at(-1)`), ['crowns', ['n-2']], 'Dismiss marks that notice read');
  assert.equal(await run(`document.querySelectorAll('.cr-notice').length`), 1, 'and it leaves the screen');

  // ---- 2. narrow -------------------------------------------------------------------
  win.setSize(860, 1000); await wait(400);
  await fits('board 860'); await shot('crowns-2-board-narrow');
  win.setSize(1440, 1000); await wait(300);

  // ---- 3. a challenge being played: the live bar -----------------------------------
  await push('crowns', screens.boardPlaying);
  await push('match', screens.crownMatch);
  await push('live', screens.liveCrown);
  await wait(300);
  await run(`document.querySelector('.scroll').scrollTop=0;true`);
  assert.equal(await run(`document.querySelectorAll('#crownsRoot .ar-lane').length`), 3, 'three lanes');
  assert.equal(await run(`document.querySelectorAll('#crownsRoot .ar-lane .sealed').length`), 1, 'the holder round you have not played is sealed');
  assert.ok(!(await run(`document.querySelector('#crownsRoot .ar-lane .sealed').closest('.ar-lane').textContent.includes('2.9')`)), 'and shows no number');
  assert.ok(await run(`document.querySelector('#crownsRoot .ar-tug i').classList.contains('ahead')`), 'ahead on the revealed rounds');
  await settle(); await noNaN('live crown');
  await shot('crowns-3-challenge-live');

  // ---- 4. the same bar inside the match panel --------------------------------------
  // No invitation in this one. The preview's renderer has no bridge of its own, so the
  // match panel is painted by the renderer's own painter, as onMatch would in the app.
  await push('races', { ...screens.races, incoming: [] });
  await run(`document.querySelector('.tab[data-screen="queue"]').click();true`);
  await run(`activeMatch = ${JSON.stringify({ ...screens.crownMatch, expiresAt: new Date(Date.now() + 361000).toISOString() })}; paintActiveMatch(); document.getElementById('opponent').classList.add('on'); true`);
  await push('live', screens.liveCrown);
  await wait(300);
  assert.ok(await run(`!!document.querySelector('#opponent .pbody #arenaMatchLive .ar-live')`), 'the match panel carries the live bar');
  await run(`document.getElementById('opponent').scrollIntoView({block:'start'});true`);
  await wait(200); await settle();
  await shot('crowns-4-match-panel-live');

  // ---- 5. a race being played, with a sealed round ----------------------------------
  await push('match', { ...screens.crownMatch, matchId: 'm-race', crown: null, race: { id: 'race-1', opponentName: 'Wren', role: 'invitee', band: 'Intermediate' } });
  await push('live', screens.liveRace);
  await run(`document.querySelector('.tab[data-screen="crowns"]').click();true`);
  await wait(300);
  await run(`document.querySelector('.scroll').scrollTop=0;true`);
  assert.equal(await run(`document.querySelectorAll('#crownsRoot .ar-lane .sealed').length`), 1, "Wren's round you have not played is sealed");
  assert.ok(!(await run(`document.querySelector('#crownsRoot .ar-lane .sealed').closest('.ar-lane').textContent.includes('2.7')`)), 'and carries no number');
  assert.ok(await run(`document.querySelector('#crownsRoot .ar-status').textContent.includes('each opens when yours lands')`), 'the status names the sealed round');
  await settle(); await noNaN('live race');
  await shot('crowns-5-race-live');

  // ---- 6. a race invitation on another screen ----------------------------------------
  await push('match', null);
  await push('live', { ...screens.liveRace, matchId: 'gone' });
  const invite = { ...screens.races, incoming: screens.races.incoming.map((r) => ({ ...r, expiresAt: new Date(Date.now() + 140000).toISOString() })) };
  await push('races', invite);
  await run(`document.querySelector('.tab[data-screen="queue"]').click();true`);
  await wait(400);
  assert.ok(await run(`!!document.getElementById('raceToast')`), 'an invitation shows as a toast off the Crowns screen');
  assert.ok(await run(`/Wren/.test(document.getElementById('raceToast').textContent) && /2:\\d\\d/.test(document.getElementById('raceToast').textContent)`), 'with who and the time left');
  await shot('crowns-6-race-invite-toast');
  await run(`document.querySelector('#raceToast [data-rc="accept"]').click();true`);
  await wait(200);
  assert.deepEqual(await run(`window.__arena.calls.find(c=>c[0]==='acceptRace')`), ['acceptRace', 'race-in'], 'Accept sends the race id');
  await run(`document.querySelector('.tab[data-screen="crowns"]').click();true`);
  await wait(300);
  assert.equal(await run(`!!document.getElementById('raceToast')`), false, 'the toast steps aside on the Crowns screen');
  await run(`document.getElementById('raceRoot').scrollIntoView({block:'start'});true`);
  await wait(200);
  await shot('crowns-7-race-panel');

  // ---- 7. the result of a challenge --------------------------------------------------
  await push('races', { ...screens.races, incoming: [] });
  for (const [name, settled, kind] of [['crowns-8-result-take', screens.settledTake, 'took'], ['crowns-9-result-defend', screens.settledDefend, 'defended']]) {
    await run(`document.querySelector('.tab[data-screen="result"]').click();true`);
    await wait(250);
    await run(`try{renderSettled(${JSON.stringify(settled)})}catch(e){console.warn(String(e))};true`);
    await push('settled', settled);
    await wait(300);
    assert.ok(await run(`document.getElementById('arenaResult')?.classList.contains(${JSON.stringify(kind)})`), `the ${kind} result is drawn`);
    assert.ok(await run(`document.getElementById('arenaResult').textContent.includes(${JSON.stringify(settled.arena.headline)})`), 'with its headline');
    await run(`document.querySelector('.scroll').scrollTop=0;true`);
    await settle();
    await fits(kind);
    await shot(name);
  }
  assert.ok(await run(`/changed hands while you played/.test(document.getElementById('arenaResult').textContent)`), 'the defend result explains the new holder');

  // ---- 8. an empty board -------------------------------------------------------------
  await run(`document.querySelector('.tab[data-screen="crowns"]').click();true`);
  await push('crowns', screens.boardEmpty);
  await push('live', { ...screens.liveRace, matchId: 'gone', verdict: null });
  await run(`window.__arenaPush('live', 'null');true`);
  await wait(300);
  assert.equal(await run(`document.querySelectorAll('.cr-card.vacant').length`), screens.boardEmpty.crowns.length, 'every Crown vacant');
  assert.ok(await run(`[...document.querySelectorAll('.cr-card [data-cr="challenge"]')].every(b=>b.textContent==='Claim')`), 'and every one claimable');
  await run(`document.querySelector('.scroll').scrollTop=0;true`);
  await settle(); await fits('empty'); await noNaN('empty');
  await shot('crowns-10-board-empty');

  assert.deepEqual(errors, [], 'renderer errors');
  console.log(`PASS: board, notices, cooldown, history, narrow layout, live challenge bar, match-panel bar, sealed race round, invitation toast, race panel, take and defend results, empty board; screenshots in ${output}${shotsDir ? ' and ' + shotsDir : ''}`);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
