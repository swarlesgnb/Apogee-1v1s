import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RiftService } from '../src/app/rift.ts';
import { registerRiftHandlers } from '../src/app/riftIpc.ts';
import { catalog, countersFor, Dice, rng, renderRun, fileNameFor } from './fixtures/syntheticStats.ts';
import { readStatsFolder } from '../src/core/stats/folderCache.ts';

const out=resolve('.cache/rift-ui');mkdirSync(out,{recursive:true});
const folder=mkdtempSync(join(out,'profile-')),stats=join(folder,'stats');mkdirSync(stats);
app.setPath('userData',join(folder,'electron'));
let now=Date.now(), connected=false, failLaunch=false, service=new RiftService(folder,()=>now), win:BrowserWindow;
const launches:string[]=[], errors:string[]=[], checks:string[]=[];
const current=()=>service.view(connected?stats:null).state!;
const run=(js:string)=>win.webContents.executeJavaScript(js,true);
const settle=()=>new Promise(r=>setTimeout(r,160));
const pass=(name:string)=>{checks.push(name);console.log(`PASS ${name}`);};
async function click(selector:string){
  assert.ok(await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!el.checkVisibility())return false;el.click();return true})()`),`Available control: ${selector}`);
  await settle();
}
const action=(type:string)=>click(`[data-rift="${type}"]`);
async function shot(name:string){writeFileSync(join(out,`${name}.png`),(await win.webContents.capturePage()).toPNG());}
const specs=catalog().season;
function addRun(options:{scenario?:string;old?:boolean;partial?:boolean;ratio?:number}={}){
  const s=current(),e=s.fight!.encounter,spec=specs.find(p=>p.name===(options.scenario??e.scenario))!;
  assert.ok(spec,'Real authored scenario has a fixture specification');
  now+=Math.ceil(spec.seconds*1000)+5000;
  const end=new Date(options.old?s.fight!.armed!.at-1000:now);
  const dice=new Dice(rng(123));
  const counters=countersFor(spec,e.target*(options.ratio??1.65),.95,dice);
  const content=renderRun(options.partial?{...spec,seconds:5}:spec,counters,end,dice);
  const file=join(stats,fileNameFor(spec.name,end));writeFileSync(file,content);utimesSync(file,new Date(Date.now()-5000),new Date(Date.now()-5000));
  return file;
}
registerRiftHandlers(ipcMain,{service:()=>service,statsDir:()=>connected?stats:null,ready:async()=>{},
  launch:async name=>{launches.push(name);return failLaunch?{ok:false,error:'Fixture launch unavailable. Retry opening the saved round.'}:{ok:true};},
  broadcast:(channel,view)=>win?.webContents.send(channel,view)});
ipcMain.handle('test:folder',()=>{connected=true;return stats;});

app.whenReady().then(async()=>{
  const timeout=setTimeout(()=>{console.error('Rift UI validation timed out');app.exit(1);},120000);
  try{
    win=new BrowserWindow({show:false,width:1440,height:1050,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,preload:join(out,'preload.cjs')}});
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=3&&!message.includes('favicon'))errors.push(message);});
    const preview=readFileSync('tools/apogee-ui-preview.html','utf8');
    const marker='<script>/* Rift presentation.';assert.ok(preview.includes(marker));
    const fixture=preview.replace(marker,'<script>window.__beforeRiftBridge=window.apogee;window.apogee=window.riftTest;/* Rift presentation.')
      .replace('<script>/* Presentation only:','<script>window.apogee=window.__beforeRiftBridge;</script><script>/* Presentation only:');
    writeFileSync(join(out,'fixture.html'),fixture);await win.loadFile(join(out,'fixture.html'));await settle();
    await click('.tab[data-screen="rift"]');
    assert.equal(await run(`document.querySelectorAll('.rift-kit').length`),3);
    assert.equal(await run(`document.querySelector('[data-rift="start"]').disabled`),true);
    pass('Rift opens without personal history and names the missing stats connection');
    for(const [width,height] of [[1440,1050],[940,750],[600,900]]){
      win.setSize(width,height);await settle();
      assert.ok(await run(`document.querySelector('#riftRoot').scrollWidth<=document.querySelector('#riftRoot').clientWidth+2`),`Intro fits ${width}`);
      await shot(`onboarding-${width}`);
    }
    pass('Onboarding fits desktop, compact and narrow widths');
    win.setSize(1440,1050);await settle();await action('folder');
    await click('[data-rift="starter"][data-id="momentum"]');await action('start');
    assert.equal(current().starter,'momentum');assert.equal(current().phase,'route');
    assert.equal(await run(`document.querySelectorAll('.rift-path').length`),3);await shot('routes');
    pass('Starting ship persists and all three routes show frozen references and risk');
    await action('enter');failLaunch=true;await action('arm');
    assert.ok(current().fight!.armed);assert.equal(current().log.length,0);
    assert.ok(await run(`document.querySelector('.rift-message').textContent.includes('Fixture launch unavailable')`));
    failLaunch=false;await action('launch');assert.equal(launches.length,2);assert.equal(current().log.length,0);
    pass('Failed game launch stays visible; retry keeps the same armed round without granting progress');
    const armedAt=current().fight!.armed!.at;service=new RiftService(folder,()=>now);await win.reload();await settle();await click('.tab[data-screen="rift"]');
    assert.equal(current().fight!.armed!.at,armedAt);assert.ok(await run(`!!document.querySelector('.rift-listening')`));
    pass('Main-process recreation and window reload resume the armed encounter');
    addRun({old:true});addRun({scenario:specs.find(s=>s.name!==current().fight!.encounter.scenario)!.name});
    addRun({partial:true});await action('refresh');assert.equal(current().log.length,0);
    pass('Old, unrelated and incomplete CSV files cannot complete the round');
    addRun();await action('refresh');
    const parsed=readStatsFolder(stats).filter(r=>r.run.scenario===current().fight!.encounter.scenario);
    assert.ok(parsed.some(r=>r.run.coherent),'At least one actual parsed fixture is coherent');
    assert.equal(current().phase,'result');assert.equal(current().log.length,1);
    assert.ok(await run(`document.querySelector('.rift-score-line').innerText.includes('KOVAAK’S SCORE')&&document.querySelector('.rift-score-line').innerText.includes('RIFT ATTACK')`));
    assert.ok(await run(`[...document.querySelectorAll('.rift-triggers li')].every(el=>Number(getComputedStyle(el).opacity)>0.9)`),'Ability feedback remains visible even while animation is paused');
    await shot('resolution');await action('refresh');assert.equal(current().log.length,1);
    pass('A coherent CSV travels through production IPC/service/parser into one visible ability resolution');
    await action('continue');assert.equal(current().phase,'reward');await shot('reward');
    const salvage=current().salvage;await action('reroll');assert.equal(current().salvage,salvage-8);
    assert.equal(await run(`document.querySelector('[data-rift="reroll"]').disabled`),true);
    await action('take');assert.equal(current().depth,1);assert.equal(current().abilities.length,3);
    pass('Reward selection and paid one-use rerolls change the persisted build');
    let steps=0,sawShop=false,sawReplacement=false,sawBoss=false;
    while(!['won','lost','extracted'].includes(current().phase)&&steps++<100){
      const s=current();
      if(s.phase==='route'){if([3,7].includes(s.depth)){sawBoss=true;await shot(`boss-route-${s.depth}`);}await action('enter');}
      else if(s.phase==='combat'){await action('arm');addRun({ratio:1.8});await action('refresh');assert.equal(current().phase,'result');}
      else if(s.phase==='result')await action('continue');
      else if(s.phase==='reward'){
        if(s.abilities.length===5){
          sawReplacement=true;
          const before=JSON.stringify(current());await action('take');assert.equal(JSON.stringify(current()),before);
          assert.ok(await run(`document.querySelector('.rift-message').textContent.includes('replace')`));
          await run(`(()=>{const el=document.querySelector('[data-replace]');el.value=${JSON.stringify(s.abilities.at(-1))};el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
        }
        await action('take');
      } else if(s.phase==='shop'){
        sawShop=true;await shot('shop');
        if(s.hull<12&&s.salvage>=12){await action('repair');assert.equal(current().hull,Math.min(12,s.hull+4));}
        await action('leave');
      }
    }
    assert.equal(current().phase,'won');assert.ok(sawShop&&sawReplacement&&sawBoss);assert.ok(steps<100);
    assert.equal(service.view(stats).records.length,1);assert.equal(current().log.filter(r=>r.verdict==='clear').length,8);
    await shot('victory');pass('Complete voyage includes full-slot replacement, waystations, both bosses and a saved victory');
    await action('new');await action('start');await action('enter');
    for(const [width,height] of [[940,750],[600,900]]){win.setSize(width,height);await settle();assert.ok(await run(`document.querySelector('#riftRoot').scrollWidth<=document.querySelector('#riftRoot').clientWidth+2`));await shot(`combat-${width}`);}
    await win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await run(`getComputedStyle(document.querySelector('.rift-orbit')).animationName`),'none');win.webContents.debugger.detach();
    pass('Combat fits compact widths and respects reduced motion');
    win.setSize(1440,1050);await settle();await action('abandon');await click('[data-rift="abandon"][data-confirm="true"]');
    assert.equal(current().phase,'lost');assert.equal(service.view(stats).records.length,2);await shot('ended');
    await action('new');await action('start');await action('extract');await click('[data-rift="extract"][data-confirm="true"]');assert.equal(current().phase,'extracted');
    pass('Ending an encounter and safe extraction have explicit confirmation and distinct saved outcomes');
    const saved=readFileSync(join(folder,'rift-v1.json'),'utf8');
    win.webContents.send('apogee:rift',{...service.view(stats),error:'Fixture read error <img src=x onerror=alert(1)>'});await settle();
    assert.equal(await run(`document.querySelector('[data-rift="new"]').disabled`),true);
    assert.equal(await run(`document.querySelectorAll('.rift-notice img').length`),0);
    assert.ok(await run(`document.querySelector('.rift-notice').textContent.includes('<img')`));
    assert.equal(readFileSync(join(folder,'rift-v1.json'),'utf8'),saved);await action('refresh');
    assert.equal(await run(`document.querySelector('[data-rift="new"]').disabled`),false);
    pass('Read errors disable mutations, display text safely, preserve progress and recover on refresh');
    assert.deepEqual(errors,[],'Renderer emitted no errors');assert.equal(checks.length,12);
    writeFileSync(join(out,'report.json'),JSON.stringify({passed:checks.length,checks,launches:launches.length,screenshots:out,limitations:['Synthetic CSVs and a simulated game launcher; no human aiming or live Steam hand-off tested.']},null,2));
    console.log(`Rift UI: ${checks.length}/${checks.length} checks passed. Screenshots: ${out}`);clearTimeout(timeout);app.exit(0);
  }catch(err){console.error(err);clearTimeout(timeout);if(win)await shot('failure');app.exit(1);}
});
