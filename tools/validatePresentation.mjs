/** Data truth and keyboard focus in the renderer that ships. No network or Electron needed. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = readFileSync('src/app/renderer/renderer.js', 'utf8').replace(/\r\n/g, '\n');
function lift(marker) {
  const start = source.indexOf(marker);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, marker);
  return source.slice(start, end + 3);
}
function node() {
  const classes = new Set();
  return { children: [], hidden: false, textContent: '', innerHTML: '', title: '', attrs: {},
    style: { setProperty() {} },
    classList: { add: c => classes.add(c), remove: c => classes.delete(c),
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: c => classes.has(c) },
    append(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    setAttribute(k, v) { this.attrs[k] = v; }, focus() { document.activeElement = this; }, isConnected: true,
  };
}
const nodes = new Map();
const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
const background = [node(), node()];
const document = { createElement: node, activeElement: node(), querySelectorAll: () => background,
  querySelector: () => $('level') };
const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const declarations = ['function roundPresentation(', 'function renderDebrief(', 'function renderScoreline('].map(lift).join('\n');
const ui = new Function('$', 'document', 'esc', 'pct', declarations + '\nreturn {roundPresentation, renderDebrief, renderScoreline};')($, document, esc, v => (v * 100).toFixed(1) + '%');
const round = (delta, opponentDelta, counted = true) => ({ scenario: 'VT scenario', delta, opponentDelta, counted });
for (const [r, label] of [[round(0,0),'Draw'],[round(.1,0),'Won'],[round(-.1,0),'Lost'],[round(null,1),'Unavailable'],[round(.1,null),'Recorded'],[round(.1,NaN),'Recorded'],[round(.1,0,false),'Excluded']]) {
  assert.equal(ui.roundPresentation(r).label, label);
}
ui.renderScoreline([round(0,0), round(.1,0), round(null,1), round(.1,null)]);
assert.equal($('scoreTally').textContent, '1–0 on rounds · 1 drawn');
assert.equal($('scoreMarks').children[0].title, 'Draw');
assert.equal($('scoreMarks').children[2].title, 'Unavailable');
ui.renderScoreline([]); assert.equal($('scoreline').hidden, true);
ui.renderDebrief([{...round(.1,null),scenario:'<img src=x onerror=alert(1)>'}], 'Example match');
assert.equal($('debriefProvenance').textContent, 'Example match');
assert.ok($('debriefRounds').children[0].innerHTML.includes('&lt;img'));
assert.ok(!$('debriefRounds').children[0].innerHTML.includes('<img'));
assert.ok($('debriefRounds').children[0].innerHTML.includes('Recorded'));
ui.renderDebrief([], 'No settled match'); assert.equal($('debriefRounds').hidden, true);

const settlement = new Function('$','document','esc','num','pct','roundPresentation','renderDebrief','renderRematch','renderScoreline','settled',
  'let hasRealResult=false;\n' + lift('function renderSettled(') + '\nreturn renderSettled;')(
  $,document,esc,String,v=>(v*100).toFixed(1)+'%',ui.roundPresentation,ui.renderDebrief,()=>{},()=>{},()=>{});
settlement({verdict:'win',rounds:[{...round(null,null),score:null,baseline:null}],ratingChange:null,ratingAfter:null,yourMatchScore:null,theirMatchScore:null,explanation:'Recorded by server'});
assert.ok($('verdictScores').textContent.includes('unavailable vs unavailable'));
assert.ok($('ratingMove').innerHTML.includes('unavailable'));
assert.ok(!$('roundsBody').children.at(-1).innerHTML.includes('0.0%'));
assert.ok($('roundsBody').children.at(-1).innerHTML.includes('unavailable'));
settlement({verdict:'draw',rounds:[{...round(0,0),score:0,baseline:0}],ratingChange:0,ratingAfter:1500,yourMatchScore:0,theirMatchScore:0,explanation:'Equal improvement'});
assert.ok($('verdictScores').textContent.includes('0.0% vs 0.0%'));
assert.ok($('roundsBody').children.at(-1).innerHTML.includes('draw'));

const pending = [{ id: 1, label: 'VT Pasu', done: false }, { id: 2, label: 'VT Pasu Small', done: false }];
const toast = new Function('$','pendingScenarios','num','playSound','renderTodo','setTimeout','clearTimeout',
  'let toastTimer = null;\n' + lift('function showRunToast(') + '\nreturn showRunToast;')($,pending,String,()=>{},()=>{},()=>1,()=>{});
toast({ scenario: 'VT Pasu', score: 100 });
assert.equal(pending[0].done, false, 'local detection never completes a submission');
assert.equal(pending[0].uploading, true);
assert.equal(pending[1].uploading, undefined, 'scenario identity is exact');
assert.equal($('toastNote').textContent, 'Run detected locally');
toast({ scenario: 'VT Pasu', score: 110, localPersonalBest: {previous:100} });
assert.equal($('toastNote').textContent, 'Local personal best · previous 100');

const start = source.indexOf('  api.onMatchProgress((p) => {');
const end = source.indexOf('\n  });', start);
let receipt;
new Function('api','$','pendingScenarios','renderTodo','startMatchClock','showError',
  'let activeMatch = {matchId:"current"};\n' + source.slice(start, end + 6))(
  {onMatchProgress: fn => {receipt=fn;}},$,pending,()=>{},()=>{},()=>{});
receipt({matchId:'old',status:'submitted',scenarioId:1,verificationTier:'verified'});
assert.equal(pending[0].done,false,'stale match receipt ignored');
receipt({matchId:'current',status:'submitted',scenarioId:1,verificationTier:'verified',remaining:['second']});
assert.equal(pending[0].done,true); assert.equal(pending[0].uploading,false);
receipt({matchId:'current',status:'failed',scenarioId:2,message:'Offline'});
assert.equal(pending[1].done,false); assert.equal(pending[1].failed,true);

const focusBefore = document.activeElement;
const celebrations = [{promotion:{from:'Lunar',to:'Odyssey'}}];
const next = new Function('$','document','celebrationQueue','playSound','setFill','requestAnimationFrame',
  'let celebrating=false, celebrationReturnFocus=null;\n' + lift('function nextCelebration(') + '\nreturn nextCelebration;')($,document,celebrations,()=>{},()=>{},fn=>fn());
$('celebrate').dataset = {};
next(); assert.equal(document.activeElement,$('celebrateClose'));
assert.ok(background.every(n=>n.inert)); assert.equal($('celebrateTitle').textContent,'Odyssey');
next(); assert.equal(document.activeElement,focusBefore); assert.ok(background.every(n=>!n.inert));
assert.equal($('celebrate').hidden,true);
console.log('OK: round truth, escaped debriefs, local detection, server receipts, and promotion focus.');
