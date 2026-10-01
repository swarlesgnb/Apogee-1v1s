import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";
import { ShareCards } from "../src/app/shareCard.ts";
import { parseShareRequest, type GhostRecord, type SettledRecord } from "../src/core/brand/shareInput.ts";

const output = resolve('.cache/share');
mkdirSync(output, { recursive: true });
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-share-')));
app.on('window-all-closed', () => {});
const settled: SettledRecord = {
  matchId: 'share-test', verdict: 'win', rated: true, yourMatchScore: .1,
  theirMatchScore: .05, ratingAfter: 1550, ratingChange: 15,
  opponent: { displayName: 'Opponent' },
  rounds: ['One', 'Two', 'Three'].map(name => ({ scenario: `Scenario ${name}`, score: 110,
    baseline: 100, delta: .1, opponentDelta: .05, counted: true, excludedReason: null })),
};
let ghost: GhostRecord | null = {
  id: 'ghost-test', verdict: 'win', end: 'complete', margin: .1, at: Date.now(),
  against: "last week's you", code: null,
  rounds: settled.rounds.map(r => ({ scenario: r.scenario, live: 110, ghost: 100,
    baseline: 100, delta: .1, ghostDelta: 0, abandoned: false })),
};
let copied: Buffer | null = null;
let target: string | null = join(output, 'saved.png');
const cards = new ShareCards({
  rendererDir: resolve('dist/app/renderer'), fontsDir: resolve('dist/app/fonts'),
  context: () => ({ playerName: 'Test Player', season: 'First Light', tier: null }),
  ghost: () => ghost, window: () => null,
  copy: png => { copied = png; }, saveAs: async () => target,
});

app.whenReady().then(async () => {
  assert.deepEqual(parseShareRequest({ source: 'match', layout: 'landscape', action: 'preview', score: 999999 }),
    { source: 'match', layout: 'landscape', action: 'preview' });
  assert.equal((await cards.handle({ source: 'match', layout: 'landscape', action: 'preview' })).ok, false);
  cards.recordSettled(settled, false);
  for (const source of ['match', 'ghost'] as const) {
    const input = cards.input(source);
    assert.ok(!('refused' in input));
    for (const layout of ['landscape', 'portrait'] as const) {
      const rendered = await cards.render(input, layout);
      assert.equal(rendered.width, layout === 'landscape' ? 1200 : 1080);
      assert.equal(rendered.height, layout === 'landscape' ? 675 : 1920);
      assert.ok(rendered.png.length > 10000);
      assert.ok(rendered.texts.some(t => t.includes('Test Player')));
      assert.ok(rendered.texts.some(t => t.includes('Scenario One')));
      assert.equal(rendered.input.rounds[0].you.score, 110);
      console.log(`PASS: ${source} ${layout} rendered at ${rendered.width}x${rendered.height}, ${rendered.png.length} bytes`);
    }
  }
  assert.equal((await cards.handle({ source: 'match', layout: 'landscape', action: 'copy' })).ok, true);
  assert.ok(copied && (copied as Buffer).length > 10000);
  assert.equal((await cards.handle({ source: 'match', layout: 'portrait', action: 'save' })).ok, true);
  assert.equal(readFileSync(target!).readUInt32BE(20), 1920);
  target = null;
  const cancelled = await cards.handle({ source: 'match', layout: 'landscape', action: 'save' });
  assert.ok(!cancelled.ok && cancelled.cancelled);
  cards.recordSettled({ ...settled, verdict: 'void' }, false);
  assert.ok('refused' in cards.input('match'));
  ghost = null;
  assert.ok('refused' in cards.input('ghost'));

  // Exercise the shipped panel script with a controlled bridge; rendering above uses
  // the real main-process implementation. No clipboard or real save dialog is used.
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const script = readFileSync('dist/app/renderer/share.js', 'utf8');
  await win.loadURL('data:text/html,' + encodeURIComponent('<div id="screen-result"><div class="panel"></div></div><div id="ghostRoot"></div>'));
  await win.webContents.executeJavaScript(`window.handlers=[];window.requests=[];window.apogee={onMatchSettled:h=>handlers.push(h),shareCard:async(...a)=>{requests.push(a);return {ok:true,png:'data:image/png;base64,AA==',copied:true}},ghost:async()=>null};${script};true`);
  await win.webContents.executeJavaScript(`handlers.forEach(h=>h(${JSON.stringify(settled)}));true`);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-share="match"]').length`), 1);
  await win.webContents.executeJavaScript(`document.querySelector('[data-share-do="portrait"]').click();true`);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(await win.webContents.executeJavaScript('requests.at(-1)'), ['match', 'portrait', 'preview']);
  await win.webContents.executeJavaScript(`document.querySelector('[data-share-do="copy"]').click();true`);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(await win.webContents.executeJavaScript('requests.at(-1)'), ['match', 'portrait', 'copy']);
  await win.webContents.executeJavaScript(`handlers.forEach(h=>h({verdict:'void'}));true`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-share="match"]').length`), 0);
  win.destroy();
  console.log('PASS: main-owned card inputs, copy/save/cancel, void refusal, shipped panel preview/shape/copy/removal');
  app.exit(0);
}).catch(error => { console.error(String(error).slice(0, 500)); app.exit(1); });
