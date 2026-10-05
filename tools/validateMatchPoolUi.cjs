const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { resolve, join } = require('node:path');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-pool-ui-')));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(resolve('tools/apogee-ui-preview.html'));
  const state = await win.webContents.executeJavaScript(`(() => {
    selectedCategory = 'Any';
    renderDraw(current);
    document.getElementById('drawPanel').open = true;
    const names = [...document.querySelectorAll('#drawRows .nm')].map(e => e.title);
    const all = { names, count: document.getElementById('drawCount').textContent };
    const categories = [...new Set(practice.scenarios.map(s => s.category))];
    const filtered = categories.map(category => {
      selectedCategory = category; renderDraw(current);
      return { category, expected: practice.scenarios.filter(s => [0,1].includes(s.window) && s.category === category).length,
        count: document.querySelectorAll('#drawRows .draw-row').length };
    });
    return { all, filtered, pool: current.benchmark.matchPool, name: current.benchmark.matchPoolName };
  })()`);
  assert.deepEqual(state.pool.windows, [1, 0]);
  assert.equal(state.all.names.length, 82);
  assert.equal(state.all.names.filter(name => name.endsWith(' Novice')).length, 41);
  assert.equal(state.all.names.filter(name => name.endsWith(' Intermediate')).length, 41);
  assert.match(state.all.count, /^82 scenarios/);
  assert.equal(state.name, 'Intermediate + Novice');
  for (const row of state.filtered) assert.equal(row.count, row.expected, row.category);
  console.log('PASS: actual dropdown shows 41 Novice and 41 Intermediate scenarios, with correct category filtering and count');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
