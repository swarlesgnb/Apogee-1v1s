// Isolated renderer checks use the real season with synthetic catalogue and board replies.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-editor-')));
const out = resolve('.cache/season-editor');
mkdirSync(out, { recursive: true });
let win;
const run = source => win.webContents.executeJavaScript(source, true);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', (_, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(resolve(process.argv.includes('--original') ? '.cache/season-editor/before.html' : 'tools/apogee-ui-preview.html'));
  await new Promise(r => setTimeout(r, 250));
  const season = JSON.parse(readFileSync('data/seasons/season-1.json', 'utf8'));
  const pool = JSON.parse(readFileSync('data/pool.json', 'utf8'));
  await run(`
    window.apogee = { searchScenarios: async () => ({scenarios: []}), sampleScenario: async (name,id,fractions) => ({rankMaxes: fractions.map((_,i)=>(i+1)*100),entries:10000,sampledAt:'2026-09-22',leaderboardId:id}) };
    seasonDraft = ${JSON.stringify(season)};
    seasonPercentiles = ${JSON.stringify(pool.ladder)};
    seasonOriginal = new Map(seasonDraft.scenarios.map(x=>[slotKeyOf(x),structuredClone(x)]));
    seasonAvailable = seasonDraft.scenarios.map(x=>({name:x.scenario,category:x.category,leaderboardId:x.leaderboardId,entries:10000,runs:1}));
    for(let i=0;i<20000;i++) seasonAvailable.push({name:'Test scenario '+i, category:'Static Clicking',leaderboardId:100000+i,entries:10000,runs:0});
    document.querySelector('.tab[data-screen="season"]').hidden=false;
    openScreen('season');
    document.getElementById('app').hidden=false;
    document.getElementById('empty').hidden=true;
    renderSeasonEditor();
  `);
  assert.equal(await run(`document.querySelectorAll('#poolGrid td.pg-cell').length`), season.scenarios.length);
  const timing = await run(`(()=>{
    const samples={search:[],selection:[],render:[]};
    for(let i=0;i<30;i++) {let t=performance.now();gridMatches('test '+i,null);samples.search.push(performance.now()-t);t=performance.now();gridSelect(gridFamilies()[i%64].key,i%4);samples.selection.push(performance.now()-t);}
    for(let i=0;i<5;i++){const t=performance.now();renderPoolGrid();samples.render.push(performance.now()-t);}
    return Object.fromEntries(Object.entries(samples).map(([k,a])=>[k,{median:a.sort((a,b)=>a-b)[Math.floor(a.length/2)],max:Math.max(...a)}]));
  })()`);
  console.log('Renderer timing (milliseconds, synthetic 20k catalogue):', JSON.stringify(timing));
  if (process.argv.includes('--baseline')) {
    console.log('Baseline mode: workflow assertions skipped.');
  } else {
    const test = readFileSync(resolve('tools/seasonEditorChecks.js'),'utf8');
    console.log(await run(`(async()=>{${test}\n})()`));
    writeFileSync(join(out,'timing.json'),JSON.stringify(timing,null,2));
  }
  console.log('Screen:', await run(`({screen:document.body.dataset.screen,active:[...document.querySelectorAll('.screen.active')].map(x=>x.id),tabDisabled:document.getElementById('tabSeason').disabled})`));
  await run(`document.querySelectorAll('.screen.active').forEach(x=>x.classList.remove('active'));document.getElementById('screen-season').classList.add('active');document.body.dataset.screen='season'; gridCloseSearch(false); document.querySelector('.scroll').scrollTop=0;`);
  await new Promise(r=>setTimeout(r,100));
  writeFileSync(join(out,'editor-wide.png'),(await win.webContents.capturePage()).toPNG());
  win.setSize(940,640);
  await new Promise(r=>setTimeout(r,100));
  assert.ok(await run(`document.querySelector('.scroll').scrollWidth <= document.querySelector('.scroll').clientWidth+2`), 'Editor must not overflow the page at 940px');
  assert.ok(await run(`document.getElementById('poolGrid').scrollWidth <= document.getElementById('poolGrid').clientWidth+2`), 'All four difficulty columns fit at 940px');
  writeFileSync(join(out,'editor-compact.png'),(await win.webContents.capturePage()).toPNG());
  win.setSize(600,900);
  await new Promise(r=>setTimeout(r,100));
  assert.ok(await run(`document.querySelector('.scroll').scrollWidth <= document.querySelector('.scroll').clientWidth+2`), 'Editor must not overflow the page at 600px');
  writeFileSync(join(out,'editor-narrow.png'),(await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[], 'Renderer console errors');
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
