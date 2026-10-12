const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const output = resolve('.cache/practice-ux');
mkdirSync(output, { recursive:true });
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-practice-ux-')));
let win;
const checks = [];
const run = source => win.webContents.executeJavaScript(source, true);
const settle = () => new Promise(r => setTimeout(r, 450));
const click = async selector => {
  assert.equal(await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!el.checkVisibility())return false;el.focus();el.click();return true})()`), true, 'Available control: '+selector);
  await settle();
};
const select = async (selector,value) => {
  await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); await settle();
};
const pass = label => { checks.push(label); console.log('PASS: '+label); };
const shot = async name => writeFileSync(join(output,name+'.png'), (await win.webContents.capturePage()).toPNG());
app.whenReady().then(async () => {
  const errors=[];
  win = new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message', (_,level,message) => { if(level>=3) { errors.push(message); console.error(message); } });
  await win.loadFile(resolve('tools/apogee-ui-preview.html')); await settle();
  assert.equal(await run(`document.body.dataset.screen`),'home');
  assert.equal(await run(`document.querySelectorAll('.practice-options>button').length`),4);
  assert.ok(await run(`document.querySelectorAll('.practice-drill').length>0&&document.querySelectorAll('.practice-drill').length<=3`));
  pass('First visit opens an actionable practice home');
  for(const [width,height] of [[1440,1000],[940,640],[600,900]]) {
    win.setSize(width,height);
    for (const screen of ['home','mixtape','scenarios']) {
      await click(`.tab[data-screen="${screen}"]`);
      assert.ok(await run(`document.querySelector('.scroll').scrollWidth<=document.querySelector('.scroll').clientWidth+2`),screen+' fits '+width);
      await shot(screen+'-'+width);
    }
  }
  pass('Home, builder and library fit nine screen/size combinations');
  win.setSize(1440,1000);
  await click('.tab[data-screen="home"]');
  await select('#homeDifficulty','1');
  await click('.tab[data-screen="mixtape"]');
  assert.equal(await run(`document.querySelector('[data-mix="band"]').value`),'1');
  await click('[data-mix="count"][data-value="3"]');
  const category = await run(`document.querySelector('[data-mix="category"] option:nth-child(2)').value`);
  await select('[data-mix="category"]',category);
  await win.reload(); await settle();
  assert.equal(await run(`document.querySelector('[data-mix="band"]').value`),'1');
  assert.equal(await run(`document.querySelector('[data-mix="category"]').value`),category);
  assert.equal(await run(`document.querySelector('[data-mix="count"][aria-pressed="true"]').dataset.value`),'3');
  pass('Difficulty, category and length survive reload');
  await select('[data-mix="category"]','');
  const before = await run(`[...document.querySelectorAll('.mix-track strong')].map(el=>el.textContent)`);
  await click('[data-mix="replace"][data-value="1"]');
  const after = await run(`[...document.querySelectorAll('.mix-track strong')].map(el=>el.textContent)`);
  assert.equal(after[0],before[0]); assert.notEqual(after[1],before[1]); assert.equal(after[2],before[2]); assert.equal(new Set(after).size,3);
  pass('Swap changes one scenario and keeps the rest of the set');
  await click('.tab[data-screen="scenarios"]');
  await run(`document.getElementById('scSearch').value='  switching   speed ';document.getElementById('scSearch').dispatchEvent(new Event('input',{bubbles:true}));`);
  const found = await run(`[...document.querySelectorAll('.sc-row')].map(el=>el.dataset.scenario)`);
  const expected = await run(`practice.scenarios.filter(r=>r.category==='Speed Switching').map(r=>r.scenario)`);
  assert.ok(found.length>0); assert.deepEqual([...found].sort(),[...expected].sort());
  // Negative control: the original implementation demonstrably loses this query.
  assert.equal(await run(`practice.scenarios.filter(r=>'switching speed'.split(/s+/).filter(Boolean).every(w=>[r.scenario,r.label,r.family,r.category].join(' ').toLowerCase().includes(w))).length`),0);
  pass('Multiword, out-of-order and whitespace search returns the actual category');
  await click('.sc-row .sc-favorite');
  const favorite = await run(`document.querySelector('.sc-row').dataset.scenario`);
  await click('#scClear'); await select('#scStatus','favorites');
  assert.deepEqual(await run(`[...document.querySelectorAll('.sc-row')].map(el=>el.dataset.scenario)`),[favorite]);
  await win.reload(); await settle();
  assert.equal(await run(`document.getElementById('scStatus').value`),'favorites');
  assert.equal(await run(`document.querySelector('.sc-row').dataset.scenario`),favorite);
  pass('Favorite and library filters survive reload');
  await click('.tab[data-screen="home"]');
  await click('.practice-drill .sc-favorite');
  assert.equal(await run(`document.activeElement.classList.contains('sc-favorite')`),true);
  pass('Saving a Home favorite keeps keyboard focus on the visible star');
  await click('.tab[data-screen="scenarios"]'); await click('#scClear');
  await select('#scStatus','unplayed');
  const unplayed = await run(`[...document.querySelectorAll('.sc-row')].map(el=>el.dataset.scenario)`);
  assert.deepEqual([...unplayed].sort(),(await run(`practice.scenarios.filter(r=>!r.runs).map(r=>r.scenario)`)).sort());
  await run(`document.getElementById('scSearch').value='not-a-real-drill-123';document.getElementById('scSearch').dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await run(`document.getElementById('scCount').textContent`),'0 of '+await run(`practice.scenarios.length`)+' scenarios');
  await click('.sc-reset-empty');
  assert.equal(await run(`document.querySelectorAll('.sc-row').length`),await run(`practice.scenarios.length`));
  pass('Unplayed filter is exact and empty results offer working reset');
  await run(`document.querySelector('.scroll').scrollTop=500;`);
  const scroll = await run(`document.querySelector('.scroll').scrollTop`); assert.ok(scroll>0);
  await click('.tab[data-screen="home"]'); await click('.tab[data-screen="scenarios"]');
  assert.equal(await run(`document.querySelector('.scroll').scrollTop`),scroll);
  pass('Navigation returns to the previous scroll position');
  await click('#arcadeJump');
  await run(`document.getElementById('arcadeCommandSearch').value='switching speed';document.getElementById('arcadeCommandSearch').dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.ok(await run(`document.querySelectorAll('.arcade-command-route').length>0`));
  await click('.arcade-command-route');
  assert.equal(await run(`document.body.dataset.screen`),'scenarios');
  assert.ok(await run(`document.querySelectorAll('.sc-row').length>0`));
  pass('Jump search opens matching scenarios in the library');
  await click('.tab[data-screen="home"]'); await click('#homeShortcuts');
  await run(`document.querySelector('#practiceShortcuts button').dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}));`);
  assert.equal(await run(`document.body.dataset.screen`),'home');
  await run(`document.getElementById('practiceShortcuts').close();`);
  pass('Screen shortcuts do not escape modal dialogs');
  // Desktop-shaped bridge drives the shipped renderer, with delayed stats and failures.
  const page = readFileSync('tools/apogee-ui-preview.html','utf8');
  const marker='<script>\n/* Local practice choices';
  assert.ok(page.includes(marker),'Renderer injection point exists');
  const bridge=`<script>
    document.hasFocus=()=>true;Object.defineProperty(document,'hidden',{get:()=>false});
    window.__practiceData=window.__APOGEE_PRACTICE__;window.__APOGEE_PRACTICE__=null;
    localStorage.clear();localStorage.setItem('apogee.practice.preferences.v1',JSON.stringify({difficulty:'Intermediate',category:'Static Clicking',count:3}));
    window.__calls=[];window.__listeners={};window.__deferred=null;
    const noop=()=>{};
    window.apogee={
      getState:async()=>({snapshot:null,statsDir:null,configured:false,scanning:false,session:null}),
      practice:()=>new Promise(resolve=>window.__practiceReady=resolve),
      getSeason:async()=>null,adminOverrides:async()=>null,duels:async()=>null,tournaments:async()=>null,
      chooseFolder:async()=>{throw Error('Folder chooser unavailable')},rescan:async()=>{},openStatsFolder:async()=>{},
      signIn:async()=>{throw Error('Steam unavailable')},
      launchScenario:async name=>{window.__calls.push(name);if(window.__deferLaunch)return new Promise(resolve=>window.__deferred=resolve);throw Error('Test launch failed')},
      installPlaylists:async()=>{throw Error('Test install failed')},
      onRun:fn=>(window.__listeners.run ||= []).push(fn)
    };
    for(const name of ['onSession','onUploadProgress','onMatch','onMatchProgress','onMatchSettled','onProgression','onQuestComplete','onSigningIn','onSignInUrl','onDuels','onTournaments','onSnapshot','onSeasonChanged','onScanning','onError'])window.apogee[name]=noop;
  </script>`;
  const nativeFile=join(output,'desktop-fixture.html');writeFileSync(nativeFile,page.replace(marker,bridge+marker));
  await win.loadFile(nativeFile); await settle();
  await run(`window.__practiceReady({...window.__practiceData,playlistDir:null});`); await settle();
  assert.equal(await run(`document.querySelector('[data-mix="band"]').value`),'1');
  assert.equal(await run(`document.querySelector('[data-mix="category"]').value`),'Static Clicking');
  assert.equal(await run(`document.querySelector('[data-home-connect]').checkVisibility()`),true);
  await click('[data-home-route="scenarios"]');
  assert.ok(await run(`document.querySelectorAll('.sc-row').length>0&&document.getElementById('scSearch').checkVisibility()`));
  pass('No-stats desktop startup retains preferences, offers connection, and permits browsing');
  await click('.sc-row .scen-play');
  assert.ok(await run(`document.getElementById('banner').textContent.includes('Test launch failed')`));
  assert.equal(await run(`document.querySelector('.sc-row .scen-play').disabled`),false);
  pass('Rejected launch shows a useful error and restores the Play action');
  await click('.tab[data-screen="home"]'); await click('[data-home-connect]');
  assert.ok(await run(`document.getElementById('banner').textContent.includes('Folder chooser unavailable')`));
  pass('Folder picker failure is visible and recoverable');
  await click('.tab[data-screen="mixtape"]');
  await run(`window.__deferLaunch=true;`); await click('[data-mix="start"]');
  await click('[data-mix="auto"]');
  await run(`(()=>{const s=JSON.parse(localStorage.getItem('apogee.mixtape.v1')).active;window.__listeners.run.forEach(fn=>fn({scenario:s.tracks[0].scenario,score:20,playedAt:new Date().toISOString(),file:'race-receipt'}));window.__deferLaunch=false;window.__deferred({ok:true});})()`);await settle();
  assert.equal(await run(`window.__calls.length`),3,'Library launch, initial session launch and automatic next launch');
  assert.equal(await run(`JSON.parse(localStorage.getItem('apogee.mixtape.v1')).active.index`),1);
  assert.ok(await run(`document.getElementById('practiceResume').textContent.includes('2/3')`));
  pass('A run arriving during launch still opens the next track and updates Resume');
  await click('.tab[data-screen="home"]'); await select('#homeDifficulty','2');
  await click('#practiceResume'); await click('[data-mix="end"]'); await click('[data-mix="new"]');
  assert.equal(await run(`document.querySelector('[data-mix="band"]').value`),'2');
  pass('Changing future difficulty leaves active session intact and applies to next set');
  assert.deepEqual(errors,[],'Renderer errors');
  writeFileSync(join(output,'results.json'),JSON.stringify({checks,screenshots:9,limitations:'Synthetic desktop bridge; no live game launch, matchmaking or native-window inspection.'},null,2));
  console.log(`PASS: ${checks.length} practice UX checks; 9 screenshots; zero renderer errors.`);
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
