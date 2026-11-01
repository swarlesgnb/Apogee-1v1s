import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RiftService, RIFT_SAVE } from '../src/app/rift.ts';
import { registerRiftHandlers } from '../src/app/riftIpc.ts';
import { RiftStore } from '../src/core/rift/store.ts';
import { catalog, countersFor, Dice, rng, renderRun, fileNameFor } from './fixtures/syntheticStats.ts';
import { readStatsFolder } from '../src/core/stats/folderCache.ts';

const out=resolve('.cache/rift-ui');mkdirSync(out,{recursive:true});
const folder=mkdtempSync(join(out,'profile-')),stats=join(folder,'stats');mkdirSync(stats);
app.setPath('userData',join(folder,'electron'));
let now=Date.now(), connected=false, failLaunch=false, service=new RiftService(folder,()=>now), win:BrowserWindow;
const launches:string[]=[], errors:string[]=[], checks:string[]=[];
const current=()=>service.view(connected?stats:null).state!;
const armedCard=()=>{const f=current().fight!;return f.hand[f.armed!.card];};
const run=(js:string)=>win.webContents.executeJavaScript(js,true);
const settle=()=>new Promise(r=>setTimeout(r,160));
const pass=(name:string)=>{checks.push(name);console.log(`PASS ${name}`);};
async function click(selector:string){
  assert.ok(await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!el.checkVisibility())return false;el.click();return true})()`),`Available control: ${selector}`);
  await settle();
}
const action=(type:string)=>click(`[data-rift="${type}"]`);
const fits=()=>run(`document.querySelector('#riftRoot').scrollWidth<=document.querySelector('#riftRoot').clientWidth+2`);
async function shot(name:string){writeFileSync(join(out,`${name}.png`),(await win.webContents.capturePage()).toPNG());}
const specs=catalog().season;
function addRun(options:{scenario?:string;old?:boolean;partial?:boolean;ratio?:number}={}){
  const s=current(),c=armedCard(),spec=specs.find(p=>p.name===(options.scenario??c.scenario))!;
  assert.ok(spec,'Real authored scenario has a fixture specification');
  now+=Math.ceil(spec.seconds*1000)+5000;
  const end=new Date(options.old?s.fight!.armed!.at-1000:now);
  const dice=new Dice(rng(123));
  const counters=countersFor(spec,c.target*(options.ratio??1.3),.95,dice);
  const content=renderRun(options.partial?{...spec,seconds:5}:spec,counters,end,dice);
  const file=join(stats,fileNameFor(spec.name,end));writeFileSync(file,content);utimesSync(file,new Date(Date.now()-5000),new Date(Date.now()-5000));
  return file;
}
/** Writes straight to the save, as a stand-in for the many voyages it takes to earn a strong build. */
function seedBuild(){
  const store=new RiftStore(join(folder,RIFT_SAVE)),save=store.load().save,s=save.state!;
  for(const c of Object.keys(s.levels))s.levels[c]=30;
  store.save(save);service=new RiftService(folder,()=>now);
}
registerRiftHandlers(ipcMain,{service:()=>service,statsDir:()=>connected?stats:null,ready:async()=>{},
  launch:async name=>{launches.push(name);return failLaunch?{ok:false,error:'Fixture launch unavailable. Retry opening the saved round.'}:{ok:true};},
  broadcast:(channel,view)=>win?.webContents.send(channel,view)});
ipcMain.handle('test:folder',()=>{connected=true;return stats;});

app.whenReady().then(async()=>{
  const timeout=setTimeout(()=>{console.error('Rift UI validation timed out');app.exit(1);},180000);
  try{
    win=new BrowserWindow({show:false,width:1440,height:1050,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,preload:join(out,'preload.cjs')}});
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=3&&!message.includes('favicon'))errors.push(message);});
    const preview=readFileSync('tools/apogee-ui-preview.html','utf8');
    const marker='<script>/* Rift presentation.';assert.ok(preview.includes(marker));
    const fixture=preview.replace(marker,'<script>window.__beforeRiftBridge=window.apogee;window.apogee=window.riftTest;/* Rift presentation.')
      .replace('<script>/* Presentation only:','<script>window.apogee=window.__beforeRiftBridge;</script><script>/* Presentation only:');
    writeFileSync(join(out,'fixture.html'),fixture);await win.loadFile(join(out,'fixture.html'));await settle();
    await click('.tab[data-screen="rift"]');
    assert.equal(await run(`document.querySelectorAll('.rift-kit').length`),4);
    assert.equal(await run(`document.querySelector('[data-rift="start"]').disabled`),true);
    pass('Rift opens without personal history, shows four vessels and names the missing stats connection');
    for(const [width,height] of [[1440,1050],[940,750],[600,900]]){
      win.setSize(width,height);await settle();assert.ok(await fits(),`Intro fits ${width}`);await shot(`onboarding-${width}`);
    }
    pass('Onboarding fits desktop, compact and narrow widths');
    win.setSize(1440,1050);await settle();await action('folder');
    await click('[data-rift="vessel"][data-id="prospector"]');await action('start');
    assert.equal(current().vessel,'prospector');assert.equal(current().phase,'map');
    assert.equal(await run(`document.querySelectorAll('.rift-body-card').length`),3);
    assert.equal(await run(`document.querySelectorAll('.rift-anomaly[data-uid]').length`),1);await shot('map');
    pass('The chosen vessel persists; the system map shows moon, planet and star with its hazard');
    await action('engage');assert.equal(current().phase,'combat');
    assert.equal(await run(`document.querySelectorAll('.rift-target').length`),3);
    assert.ok(await run(`[...document.querySelectorAll('.rift-preview strong')].every(el=>Number(el.textContent.replace(/[^0-9]/g,''))>0)`),'Every target shows a damage preview');
    const before=current().fight!.hand[1].scenario;await click('[data-rift="jump"][data-card="1"]');
    assert.notEqual(current().fight!.hand[1].scenario,before);assert.equal(current().fight!.jumps,1);await shot('hand');
    pass('A fight deals three previewed targets, and a Jump redraws one');
    failLaunch=true;await click('[data-rift="arm"][data-card="0"]');
    assert.ok(current().fight!.armed);assert.equal(current().log.length,0);
    assert.ok(await run(`document.querySelector('.rift-message').textContent.includes('Fixture launch unavailable')`));
    failLaunch=false;await action('launch');assert.equal(launches.length,2);assert.equal(current().log.length,0);
    pass('Failed game launch stays visible; retry keeps the same armed salvo without granting progress');
    const armedAt=current().fight!.armed!.at;service=new RiftService(folder,()=>now);await win.reload();await settle();await click('.tab[data-screen="rift"]');
    assert.equal(current().fight!.armed!.at,armedAt);assert.ok(await run(`!!document.querySelector('.rift-listening-card')`));
    pass('Main-process recreation and window reload resume the armed salvo');
    addRun({old:true});addRun({scenario:specs.find(s=>s.name!==armedCard().scenario)!.name});
    addRun({partial:true});await action('refresh');assert.equal(current().log.length,0);
    pass('Old, unrelated and incomplete CSV files cannot settle the salvo');
    addRun();await action('refresh');
    const parsed=readStatsFolder(stats).filter(r=>r.run.scenario===current().last!.card.scenario);
    assert.ok(parsed.some(r=>r.run.coherent),'At least one actual parsed fixture is coherent');
    assert.equal(current().phase,'result');assert.equal(current().log.length,1);
    assert.ok(await run(`document.querySelector('.rift-equation').innerText.includes('THRUST')&&document.querySelector('.rift-equation').innerText.includes('FLUX')`));
    await shot('resolution-playing');await action('skipanim');
    const last=current().last!;
    assert.equal(await run(`document.querySelector('.rift-damage strong').textContent.replace(/[^0-9]/g,'')`),String(last.damage));
    assert.ok(await run(`[...document.querySelectorAll('.rift-steps li')].every(el=>Number(getComputedStyle(el).opacity)>0.9)`),'Every step is legible once the animation ends');
    assert.equal(await run(`document.querySelectorAll('.rift-steps li').length`),last.steps.length);
    await shot('resolution');await action('refresh');assert.equal(current().log.length,1);
    pass('A coherent CSV travels through production IPC/service/parser into one visible Thrust × Flux breakdown');
    while(current().phase!=='shop'){
      const s=current();
      if(s.phase==='result')await action('continue');
      else if(s.phase==='combat'){await click('[data-rift="arm"][data-card="0"]');addRun({ratio:2});await action('refresh');}
      else if(s.phase==='map')await action('engage');
    }
    await shot('shop');
    const dust=current().stardust;await action('reroll');assert.equal(current().stardust,dust-3);assert.equal(current().shop!.rerollCost,4);
    const offer=current().shop!.anomalies.findIndex(o=>o&&o.price<=current().stardust);
    if(offer>=0){await click(`[data-rift="buy"][data-row="anomaly"][data-index="${offer}"]`);assert.equal(current().anomalies.length,2);
      const uid=current().anomalies[1].uid;await click(`[data-rift="move"][data-uid="${uid}"][data-dir="-1"]`);assert.equal(current().anomalies[0].uid,uid);}
    const count=current().anomalies.length,sold=current().anomalies[0].uid;
    await click(`[data-rift="sell"][data-uid="${sold}"]`);assert.equal(current().anomalies.length,count,'Selling asks first');
    await click(`[data-rift="sell"][data-uid="${sold}"][data-confirm="true"]`);assert.equal(current().anomalies.length,count-1);
    pass('Shops reroll at a rising price, buy into the rail, reorder, and sell only after confirmation');
    await action('leave');assert.equal(current().phase,'map');
    if(current().stage<2){const stage=current().stage;await action('skip');assert.equal(current().stage,stage+1);assert.equal(current().phase,'map');}
    seedBuild();await action('refresh');
    let steps=0,sawStar=false,sawShop=false;
    while(!['won','lost','extracted'].includes(current().phase)&&steps++<200){
      const s=current();
      if(s.phase==='map'){if(s.stage===2){sawStar=true;await shot(`star-${s.system}`);}await action('engage');}
      else if(s.phase==='combat'){await click('[data-rift="arm"][data-card="0"]');addRun({ratio:2});await action('refresh');assert.equal(current().phase,'result');}
      else if(s.phase==='result'){await action('skipanim').catch(()=>{});await action('continue');}
      else if(s.phase==='shop'){sawShop=true;await action('leave');}
    }
    assert.equal(current().phase,'won');assert.ok(sawStar&&sawShop);
    assert.equal(service.view(stats).records.length,1);assert.equal(service.view(stats).records[0].outcome,'won');
    await shot('victory');
    await action('deeper');assert.equal(current().phase,'shop');assert.ok(current().stats.endless);
    pass('A seeded build completes all four systems through stars and shops, and the deep Rift opens after the win');
    await action('leave');await action('engage');
    for(const [width,height] of [[940,750],[600,900]]){win.setSize(width,height);await settle();assert.ok(await fits());await shot(`combat-${width}`);}
    await win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await run(`getComputedStyle(document.querySelector('.rift-body.large')).animationName`),'none');win.webContents.debugger.detach();
    pass('Combat fits compact widths and respects reduced motion');
    win.setSize(1440,1050);await settle();await action('abandon');await click('[data-rift="abandon"][data-confirm="true"]');
    assert.equal(current().phase,'lost');assert.equal(service.view(stats).records.length,1,'The deep voyage refreshes its own record');
    assert.equal(service.view(stats).records[0].outcome,'lost');await shot('ended');
    await action('new');await action('start');await action('extract');await click('[data-rift="extract"][data-confirm="true"]');assert.equal(current().phase,'extracted');
    assert.equal(service.view(stats).records.length,2);
    pass('Ending a fight and safe extraction have explicit confirmation and distinct saved outcomes');
    const saved=readFileSync(join(folder,RIFT_SAVE),'utf8');
    win.webContents.send('apogee:rift',{...service.view(stats),error:'Fixture read error <img src=x onerror=alert(1)>'});await settle();
    assert.equal(await run(`document.querySelector('[data-rift="new"]').disabled`),true);
    assert.equal(await run(`document.querySelectorAll('.rift-notice img').length`),0);
    assert.ok(await run(`document.querySelector('.rift-notice').textContent.includes('<img')`));
    assert.equal(readFileSync(join(folder,RIFT_SAVE),'utf8'),saved);await action('refresh');
    assert.equal(await run(`document.querySelector('[data-rift="new"]').disabled`),false);
    pass('Read errors disable mutations, display text safely, preserve progress and recover on refresh');
    assert.deepEqual(errors,[],'Renderer emitted no errors');assert.equal(checks.length,13);
    writeFileSync(join(out,'report.json'),JSON.stringify({passed:checks.length,checks,launches:launches.length,screenshots:out,limitations:['Synthetic CSVs and a simulated game launcher; no human aiming or live Steam hand-off tested.','The full-voyage check seeds high planet levels into the save rather than earning a build.']},null,2));
    console.log(`Rift UI: ${checks.length}/${checks.length} checks passed. Screenshots: ${out}`);clearTimeout(timeout);app.exit(0);
  }catch(err){console.error(err);clearTimeout(timeout);if(win)await shot('failure');app.exit(1);}
});
