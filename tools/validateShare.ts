import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";
import { ShareCards, type RecordKeys } from "../src/app/shareCard.ts";
import { MechanicShares } from "../src/app/shareRecords.ts";
import { writeFileSync } from "node:fs";
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
const keyLog: RecordKeys[] = [];
let target: string | null = join(output, 'saved.png');
const cards = new ShareCards({
  rendererDir: resolve('dist/app/renderer'), fontsDir: resolve('dist/app/fonts'),
  context: () => ({ playerName: 'Test Player', season: 'First Light', tier: null }),
  ghost: () => ghost, window: () => null,
  copy: png => { copied = png; }, saveAs: async () => target,
  onRecords: keys => { keyLog.push(keys); },
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

  // The mechanic cards, through the same main-owned path: a record in, a name from the
  // renderer, a card out. Nothing is drawn before a record exists.
  for (const source of ['daily', 'crown', 'flag', 'shadow'] as const) {
    assert.ok('refused' in cards.input(source), `${source} refuses with no record`);
    const none = await cards.handle({ source, layout: 'landscape', action: 'preview' });
    assert.ok(!none.ok, `${source} preview refuses with no record`);
  }
  const at = Date.parse('2026-10-03T12:00:00');
  cards.recordDaily({ number: 212, band: 'Intermediate', date: '2026-10-03', marks: ['above', 'near', 'below'], meanDelta: .0063, streak: 6 });
  cards.recordCrown({ event: 'taken', category: 'Speed Switching', band: 'Lunar', rival: { displayName: 'Holder' }, defences: 0, rivalReignDays: 3, yourMatchScore: .1, theirMatchScore: .05, rounds: settled.rounds, at });
  cards.recordFlag({ verdict: 'win', category: 'Precise Tracking', challenger: { displayName: 'Challenger' }, plantedAt: '2026-10-01', answeredAt: '2026-10-03', rated: true, ratingAfter: 1550, ratingChange: 15, yourMatchScore: .1, theirMatchScore: .05, rounds: settled.rounds });
  // As main builds it after a Shadow match: the board's ladder, the match just settled last
  // with its scores, and placement null because the board says fewer than three results.
  cards.recordShadow({ category: 'Speed Switching', at, placement: null, streak: 0, series: [{ verdict: 'win', percentile: 51 }, { verdict: 'loss', percentile: 64, yourMatchScore: .004, shadowScore: .021 }] });
  const want: Record<string, string[]> = {
    daily: ['Daily #212', 'Test Player', 'ABOVE', 'NEAR', 'BELOW', 'Streak 6 days'],
    crown: ['Crown taken', 'Test Player  vs  Holder', 'Scenario One', 'Lunar band'],
    flag: ['Flag held', 'Test Player  vs  Challenger', 'Scenario One', 'Stood 2 days'],
    shadow: ['Shadow wins', 'Test Player  vs  a 64th-percentile day', 'SYNTHETIC, UNRATED', '51st', '64th', 'TO PLAY', 'PLACEMENT SHOWS AFTER 3', '+0.4% vs +2.1%'],
  };
  for (const source of ['daily', 'crown', 'flag', 'shadow'] as const) {
    const input = cards.input(source);
    assert.ok(!('refused' in input), `${source}: ${'refused' in input ? input.refused : ''}`);
    for (const layout of ['landscape', 'portrait'] as const) {
      const rendered = await cards.renderAny(input, layout);
      assert.equal(rendered.width, layout === 'landscape' ? 1200 : 1080);
      assert.equal(rendered.height, layout === 'landscape' ? 675 : 1920);
      for (const w of want[source]) assert.ok(rendered.texts.some(t => t.includes(w)), `${source} ${layout} prints "${w}"`);
      writeFileSync(join(output, `${source}-${layout}.png`), rendered.png);
      console.log(`PASS: ${source} ${layout} rendered at ${rendered.width}x${rendered.height}, ${rendered.png.length} bytes (${rendered.fileName})`);
    }
    const copiedBefore: Buffer | null = copied;
    assert.equal((await cards.handle({ source, layout: 'portrait', action: 'copy' })).ok, true);
    assert.ok(copied && copied !== copiedBefore, `${source} copies`);
  }
  // A daily card names no scenario: the record has nowhere to put one.
  const daily = await cards.renderAny(cards.input('daily') as never, 'landscape');
  assert.ok(!daily.texts.some(t => /Scenario/.test(t)), 'the daily card prints no scenario');
  cards.recordFlag({ verdict: 'void', challenger: { displayName: 'x' }, plantedAt: '2026-10-01', answeredAt: '2026-10-02', yourMatchScore: 0, theirMatchScore: 0, rounds: settled.rounds });
  assert.ok('refused' in cards.input('flag'), 'a void flag answer has no card');
  console.log('PASS: daily, crown, flag and shadow cards: refused without a record, drawn from main\'s record, copy works, void refused');

  // Main's records for the Shadow, Flag and Crown cards, built by MechanicShares from
  // payloads shaped as settle-match, queue-board and list-crowns send them.
  const shares = new MechanicShares(cards);
  const rounds3 = settled.rounds.map(r => ({ ...r, verificationTier: 'verified' }));
  const shadowSettled = { ...settled, matchId: 'm-shadow', verdict: null, seeding: true, rated: false, category: 'Static Clicking',
    yourMatchScore: .031, theirMatchScore: null, ratingChange: 0, rounds: rounds3,
    shadow: { percentile: 63, label: 'a 63rd-percentile day', rung: 3, ordinal: 4, skill: 'Clicking', synthetic: true, verdict: 'win', yourScore: .031, shadowScore: .018 } } as any;
  shares.settled(shadowSettled, 'Intermediate');
  assert.equal(cards.recordKeys().shadow, 'm-shadow', 'a Shadow result is recorded at settle, keyed by its match');
  let si = cards.input('shadow');
  assert.ok(!('refused' in si) && si.kind === 'shadow' && si.series.length === 1 && si.placement === null, 'before the board is read: this match alone, no read-out');
  const ladder = (first: number) => ({ now: '', preview: null, activeShadow: null, flags: [], news: [],
    shadow: { next: shadowSettled.shadow, placement: { estimate: 58, decided: 3, wins: 2, losses: 1, draws: 0 }, streak: 1, played: 4,
      recent: [{ ordinal: first, percentile: 63, label: '', result: 'win', decidedAt: null }, { ordinal: 3, percentile: 50, label: '', result: 'void', decidedAt: null },
        { ordinal: 2, percentile: 65, label: '', result: 'loss', decidedAt: null }, { ordinal: 1, percentile: 50, label: '', result: 'win', decidedAt: null }] } }) as any;
  shares.queueBoard(ladder(3));
  assert.equal(cards.recordKeys().shadow, 'm-shadow', 'a board that does not count the match yet is not used');
  shares.queueBoard(ladder(4));
  assert.equal(cards.recordKeys().shadow, 'm-shadow:ladder');
  si = cards.input('shadow');
  assert.ok(!('refused' in si) && si.kind === 'shadow', 'shadow input');
  if (si.kind === 'shadow') {
    assert.deepEqual(si.series.map(m => [m.verdict, m.percentile]), [['win', 50], ['loss', 65], ['win', 63]], 'the ladder in play order, voids dropped, this match last');
    assert.deepEqual(si.series[2].matchScore, { you: .031, them: .018 });
    assert.deepEqual(si.placement, { kind: 'read', estimate: 58, decided: 3 }, 'the read-out the board serves');
  }
  const shadowCard = await cards.renderAny(si, 'landscape');
  for (const w of ['Shadow beaten', 'About the 58th percentile', 'PLACEMENT FROM 3 SHADOWS', 'SYNTHETIC, UNRATED'])
    assert.ok(shadowCard.texts.some(t => t.includes(w)), `the Shadow card prints "${w}"`);
  assert.ok(!shadowCard.texts.some(t => /Lunar|Cosmonaut|Rating \d/.test(t)), 'no tier and no rating on a Shadow card');
  shares.settled({ ...shadowSettled, matchId: 'm-void', shadow: { ...shadowSettled.shadow, verdict: 'void' } }, 'Intermediate');
  assert.equal(cards.recordKeys().shadow, null, 'a void Shadow result leaves no Shadow card');

  const flagBoard = { ...ladder(9), flags: [
    { id: 'f-old', category: 'Static Clicking', band: 'Intermediate', status: 'answered', plantedAt: '2026-09-28T10:00:00Z', expiresAt: '', daysLeft: 0, answeredAt: '2026-09-30T10:00:00Z', answeredBy: 'rook', verdict: 'loss', ratingChange: -11, yourScore: .01, theirScore: .02, seen: true, line: '' },
    { id: 'f-new', category: 'Precise Tracking', band: 'Intermediate', status: 'answered', plantedAt: '2026-10-01T10:00:00Z', expiresAt: '', daysLeft: 0, answeredAt: '2026-10-03T10:00:00Z', answeredBy: 'kestrel', verdict: 'win', ratingChange: 13, yourScore: .027, theirScore: .011, seen: false, line: '' },
    { id: 'f-open', category: 'Speed Switching', band: 'Intermediate', status: 'open', plantedAt: '2026-10-03T10:00:00Z', expiresAt: '', daysLeft: 7, answeredAt: null, answeredBy: null, verdict: null, ratingChange: null, yourScore: null, theirScore: null, seen: false, line: '' },
  ] } as any;
  shares.queueBoard(flagBoard);
  assert.equal(cards.recordKeys().flag, 'flag:f-new', 'the newest answered Flag is recorded');
  const flagCard = await cards.renderAny(cards.input('flag') as never, 'landscape');
  for (const w of ['Flag held', 'Test Player  vs  kestrel', '+2.7%', '+1.1%', 'PLANTED SET', 'ANSWER', 'Rated · +13 rating', '1 flag still standing'])
    assert.ok(flagCard.texts.some(t => t.includes(w)), `the Flag card prints "${w}"`);

  const crownNote = (over: Record<string, unknown>) => ({ kind: 'crown', outcome: 'took', crown: 'Speed Switching Crown (Intermediate)', category: 'Speed Switching', window: 1, claim: false,
    holderName: 'Cedar', judgedAgainstNewHolder: false, challengerScore: .1, holderScore: .05, defences: 2, headline: '', explanation: '', ...over });
  const crownSettled = { ...settled, matchId: 'm-crown', rated: false, rounds: rounds3, arena: { kind: 'crown', crown: crownNote({}) } } as any;
  const takenAt = Date.parse('2026-10-03T12:00:00Z');
  shares.settled(crownSettled, 'Intermediate', takenAt);
  assert.equal(cards.recordKeys().crown, 'crown:taken:m-crown');
  let ci = cards.input('crown');
  assert.ok(!('refused' in ci) && ci.kind === 'crown' && ci.event === 'taken' && ci.rounds.length === 3 && ci.rival?.name === 'Cedar' && ci.band === 'Intermediate');
  const crownBoard = (createdAt: string) => ({ season: 'Season 1', bands: [{ index: 1, name: 'Intermediate' }], categories: ['Precise Tracking'], holding: 1, rules: { reignCapDays: 7, cooldownHours: 20, tiers: [] }, now: '',
    crowns: [{ category: 'Precise Tracking', window: 1, holder: { playerId: 'me', name: 'Test Player', you: true }, heldSince: '2026-09-28T09:00:00Z' }],
    notices: [{ id: 'n-def', kind: 'defended', category: 'Precise Tracking', window: 1, crown: '', text: '', otherName: 'Kestrel', defences: 4, challengerScore: .008, holderScore: .012, createdAt }] }) as any;
  shares.crowns(crownBoard('2026-10-03T11:00:00Z'));
  assert.equal(cards.recordKeys().crown, 'crown:taken:m-crown', 'an older defence notice does not replace a Crown just taken');
  shares.crowns(crownBoard('2026-10-03T13:00:00Z'));
  assert.equal(cards.recordKeys().crown, 'crown:defended:n-def', 'a newer defence does');
  ci = cards.input('crown');
  assert.ok(!('refused' in ci) && ci.kind === 'crown' && ci.event === 'defended' && ci.rounds.length === 0 && ci.matchScore?.you === .012 && ci.matchScore?.them === .008 && ci.heldSince === '2026-09-28');
  const defCard = await cards.renderAny(ci, 'portrait');
  for (const w of ['Crown defended', 'Test Player  vs  Kestrel', 'HOLDER', 'CHALLENGER', '+1.2%', '+0.8%', '4 DEFENCES'])
    assert.ok(defCard.texts.some(t => t.includes(w)), `the defended Crown card prints "${w}"`);
  shares.settled({ ...crownSettled, matchId: 'm-crown-2', arena: { kind: 'crown', crown: crownNote({ judgedAgainstNewHolder: true, holderName: 'Wren', holderScore: .07 }) } }, 'Intermediate', Date.parse('2026-10-03T14:00:00Z'));
  ci = cards.input('crown');
  assert.ok(!('refused' in ci) && ci.kind === 'crown' && ci.rounds.length === 0 && ci.rival?.name === 'Wren' && ci.matchScore?.them === .07, 'taken from a holder who changed mid-match: the two scores the decision compared, not the old holder\'s rounds');
  shares.settled({ ...crownSettled, matchId: 'm-crown-3', arena: { kind: 'crown', crown: crownNote({ outcome: 'defended' }) } }, 'Intermediate');
  assert.equal(cards.recordKeys().crown, 'crown:taken:m-crown-2', 'a challenge that fell short leaves the Crown card alone');
  assert.ok(keyLog.length >= 6 && keyLog.at(-1)?.crown === 'crown:taken:m-crown-2', 'every record change is pushed with its keys');
  console.log('PASS: Shadow, Flag and Crown records built in main from settle-match, queue-board and list-crowns payloads, keyed for the renderer');

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
