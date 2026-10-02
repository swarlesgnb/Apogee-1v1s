import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync('src/app/renderer/renderer.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, `shipped ${name} present`);
  return source.slice(start, end + 3);
}
let focused = false;
const document = { hidden: false, hasFocus: () => focused };
const paints = [], practice = [], bands = [], matches = [];
const controller = new Function('document', 'render', 'refreshPractice', 'renderBand', 'paintActiveMatch', '$',
  'let current=null,lastSnapshot=null,snapshotPaintPending=false,practicePaintPending=false,activeMatch=true;' +
  'function paintPractice() { throw new Error("unexpected practice paint"); }' +
  lift('receiveSnapshot') + lift('flushSnapshotPaint') +
  'return {receiveSnapshot,flushSnapshotPaint,state:()=>current};')(
    document, s => paints.push(s), () => practice.push(1), () => bands.push(1), () => matches.push(1),
    () => ({ classList: { contains: () => false } }));
for (let i=0; i<100; i++) controller.receiveSnapshot({ sequence: i });
assert.equal(controller.state().sequence, 99, 'background state stays current');
assert.equal(paints.length, 0);
assert.equal(practice.length, 0);
focused = true; document.hidden = true;
controller.flushSnapshotPaint(); assert.equal(paints.length, 0, 'hidden windows stay quiet');
document.hidden = false;
controller.flushSnapshotPaint();
assert.deepEqual(paints, [{ sequence: 99 }]);
assert.equal(practice.length, 1); assert.equal(bands.length, 1); assert.equal(matches.length, 1);
controller.flushSnapshotPaint(); assert.equal(paints.length, 1, 'duplicate focus events do not repaint');
controller.receiveSnapshot({ sequence: 100 }); assert.equal(paints.length, 2, 'foreground updates remain immediate');
const handler = source.slice(source.indexOf('api.onSnapshot((snapshot) =>'), source.indexOf('api.onSeasonChanged('));
assert.match(handler, /receiveSnapshot\(snapshot\)/);
assert.doesNotMatch(handler, /\n\s+render\(snapshot\)/);
assert.match(source, /addEventListener\('focus', flushSnapshotPaint\)/);
assert.match(source, /addEventListener\('visibilitychange', flushSnapshotPaint\)/);
console.log('OK: shipped snapshot receiver coalesces 100 background updates and resumes on focus');
