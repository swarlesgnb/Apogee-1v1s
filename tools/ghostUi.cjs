// Ghost Mode's screens, rendered headless from the shareable preview and photographed.
//
//   npm run validate:ghost-ui
//
// The same approach as mixtapeUi.cjs: the preview page, with a synthetic bridge handed to
// the one feature script under test. The screens it serves are real (ghostUiFixture.ts
// builds them with the core over the real stats folder), so what is photographed is
// what the app would draw for this library today. Pictures land in .cache/ghost/.
const {app,BrowserWindow}=require('electron');
const {readFileSync,writeFileSync,mkdirSync,mkdtempSync}=require('node:fs');
const {resolve,join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const output=resolve('.cache/ghost');mkdirSync(output,{recursive:true});
app.setPath('userData',mkdtempSync(join(tmpdir(),'apogee-ghost-')));
const screens=JSON.parse(readFileSync(join(output,'screens.json'),'utf8'));
const errors=[];let win;const run=s=>win.webContents.executeJavaScript(s,true).catch(e=>{console.error("FAILED:",s.slice(0,160),errors);throw e;});const wait=ms=>new Promise(r=>setTimeout(r,ms));
const shot=async(name)=>{writeFileSync(join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
const show=async(name,ms=500)=>{await run(`window.__ghostPush(${JSON.stringify(JSON.stringify(screens[name]))});true`);await wait(ms);};
// An offscreen window is a hidden page, and Chromium does not advance CSS animations on
// one, so every animation is placed by hand: a frame inside the reveal, or its end.
const at=async(ms)=>{await run(`document.getAnimations().forEach(a=>{a.pause();a.currentTime=${ms}});true`);await wait(120);};
const settle=async()=>{await run(`document.getAnimations().forEach(a=>{try{a.finish()}catch{}});true`);await wait(120);};
app.whenReady().then(async()=>{

  win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(_,level,message)=>{if(level>=3)errors.push(message);});
  const marker='<script>/* Ghost Mode:';
  const bridge=`<script>window.__ghostActions=[];window.__ghostHandlers=[];window.__settled=[];`+
    `window.__ghostScreen=${JSON.stringify(screens.choose)};`+
    `window.__ghostPush=(json)=>{window.__ghostScreen=JSON.parse(json);window.__ghostHandlers.forEach(h=>h(window.__ghostScreen));};`+
    `window.apogee=Object.assign(window.apogee||{},{ghost:async()=>window.__ghostScreen,ghostAction:async(a)=>{window.__ghostActions.push(a);return {view:window.__ghostScreen}},`+
    `onGhost:h=>window.__ghostHandlers.push(h),onMatchSettled:h=>window.__settled.push(h)});</script>`;
  const page=readFileSync('tools/apogee-ui-preview.html','utf8');
  assert.ok(page.includes(marker),'the preview carries ghost.js: run tsx tools/buildUiPreview.ts first');
  writeFileSync(join(output,'fixture.html'),page.replace(marker,bridge+marker));
  await win.loadFile(join(output,'fixture.html'));await wait(600);
  await run(`document.querySelector('.tab[data-screen="ghost"]').click();true`);await wait(400);
  assert.equal(await run(`document.getElementById('screen-ghost').classList.contains('active')`),true,'the Ghost tab opens its screen');

  const fits=async(label)=>assert.ok(await run(`document.querySelector('.scroll').scrollWidth<=document.querySelector('.scroll').clientWidth+2`),'no sideways scroll: '+label);
  const noNaN=async(label)=>assert.ok(!(await run(`/NaN|undefined/.test(document.getElementById('ghostRoot').innerText)`)),'no NaN or undefined: '+label);

  // 1. pick
  await show('choose');
  assert.equal(await run(`document.querySelectorAll('.gh-card').length`),3,'three ghosts offered');
  assert.equal(await run(`document.querySelector('.gh-card.selected').dataset.kind`),screens.choose.defaultKind,'the default is selected');
  await settle();await fits('chooser');await noNaN('chooser');await shot('1-pick');
  await show('firstChoose');
  assert.ok(await run(`document.querySelector('.gh-card.selected .gh-badge').textContent==='First race'`),'the first race defaults to a month ago');
  await shot('1b-pick-first-race');
  await run(`document.querySelector('[data-gh="draw"]').click();true`);await wait(200);
  assert.deepEqual(await run(`window.__ghostActions.at(-1)`),{type:'draw',kind:screens.firstChoose.defaultKind},'Race sends the chosen kind and nothing else');

  // 2. pre-match
  await show('ready');
  assert.equal(await run(`document.querySelectorAll('.gh-lane').length`),3);
  await settle();await fits('ready');await noNaN('ready');await shot('2-ready');
  await run(`document.querySelector('[data-gh="start"]').click();true`);await wait(200);
  assert.deepEqual(await run(`window.__ghostActions.at(-1)`),{type:'start'});

  // 3. play in progress: one landed with the reveal, the next listening
  await show('live',700);
  assert.equal(await run(`document.querySelectorAll('.gh-lane.landed').length`),1);
  assert.equal(await run(`document.querySelectorAll('.gh-lane.listening').length`),1,'the next lane is listening');
  await at(700);await shot('3a-reveal-count');
  await at(2000);await shot('3a-reveal-bars');
  await settle();await wait(2400);
  assert.ok(await run(`/\\d:\\d\\d/.test(document.querySelector('[data-gh-clock]').textContent)`),'the clock counts down');
  await fits('live');await noNaN('live');await shot('3b-live');
  await show('liveTwo',300);await settle();
  assert.ok(await run(`!!document.querySelector('.gh-notice')`),'a refused run is explained');
  await shot('3c-live-two');

  // 4. the last lane lands with the result: the board holds for the reveal, then the verdict
  await show('result',300);await at(1900);
  assert.equal(await run(`document.getElementById('ghostRoot').dataset.state`),'live','the result waits for the last lane to reveal');
  await shot('4a-final-lane');
  await wait(2600);await settle();
  assert.equal(await run(`document.getElementById('ghostRoot').dataset.state`),'result');
  assert.equal(await run(`document.querySelectorAll('.gh-rounds tbody tr').length`),3,'three rounds side by side');
  await fits('result');await noNaN('result');await shot('4b-result');
  assert.equal(await run(`document.querySelector('[data-gh="share"]').disabled`),true,'Share is disabled with a reason until it can work');

  // Narrow window.
  win.setSize(820,1000);await wait(400);await fits('result 820');await shot('4c-result-narrow');
  win.setSize(1440,1000);await wait(300);

  // 5. the seeding result offers a ghost
  await run(`document.querySelector('.tab[data-screen="result"]').click();true`);await wait(300);
  // The preview's result screen is its static example; draw a seeding result on it with
  // the renderer's own function first, so the offer sits under what it answers.
  const seeding={seeding:true,verdict:null,rounds:[],yourMatchScore:0.012,explanation:'Nothing was rated: there was no opponent to play against.'};
  await run(`try{renderSettled(${JSON.stringify(seeding)})}catch(e){console.warn(String(e))};true`);
  await run(`window.__settled.forEach(h=>h(${JSON.stringify(seeding)}));true`);await wait(300);
  assert.ok(await run(`!!document.getElementById('ghostSeedCallout')&&document.getElementById('ghostSeedCallout').checkVisibility()`),'a seeding result offers a ghost');
  await run(`window.__settled.forEach(h=>h(${JSON.stringify({...seeding,sentDuel:true})}));true`);await wait(200);
  assert.equal(await run(`!!document.getElementById('ghostSeedCallout')`),false,'a sent duel does not claim the pool is empty');
  await run(`window.__settled.forEach(h=>h(${JSON.stringify(seeding)}));true`);await wait(300);
  await shot('5-seeding-callout');
  await run(`document.querySelector('#ghostSeedCallout button').click();true`);await wait(300);
  assert.equal(await run(`document.getElementById('screen-ghost').classList.contains('active')`),true,'and the offer opens Ghost Mode');

  assert.deepEqual(errors,[],'renderer errors');
  console.log(`PASS: ghost chooser, pre-match, live board with reveal and clock, held final lane, result, narrow result and the seeding offer; screenshots in ${output}`);
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
