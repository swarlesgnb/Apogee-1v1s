// Exercise the shipped presentation against the standalone renderer fixture.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const baseline = process.argv.includes('--baseline');
const output = resolve('.cache/reference-polish');
mkdirSync(output, { recursive: true });
app.setPath('userData', mkdtempSync(join(tmpdir(), 'apogee-presentation-')));
let win;
const run = source => win.webContents.executeJavaScript(source, true);
const settle = () => new Promise(r => setTimeout(r, 450));
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1440, height: 1080, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(resolve('tools/apogee-ui-preview.html'));
  await settle();
  const screens = await run(`[...document.querySelectorAll('.tab')].filter(e=>!e.hidden).map(e=>e.dataset.screen)`);
  assert.ok(screens.length >= 10, 'Real navigation must be populated');
  if (!baseline) {
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const key = key => run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
    await click('.tab[data-screen="home"]');
    await click('.tab[data-screen="daily"]');
    assert.equal(await run("document.querySelectorAll('#dailyRoot .dy-lane').length"), 3);
    if (await run("document.querySelectorAll('[data-sample-row]').length > 0")) {
      const name = await run("document.querySelector('#dailyRoot .dy-lane strong').textContent");
      await click('[data-sample-row="0"]');
      assert.equal(await run('document.body.dataset.screen'), 'scenarios');
      assert.equal(await run("document.querySelector('#scSearch').value"), name);
    }
    await click('.tab[data-screen="home"]');
    await click('#homeRiftAcademy');
    assert.ok(await run("document.querySelector('#apogeeGuide').open && document.querySelector('#guideTitle').innerText.includes('Rift')"));
    await run('window.ApogeeGuide.close()');
    await click('[data-home-route="rift"]');
    assert.equal(await run('document.body.dataset.screen'), 'rift');
    await click('.tab[data-screen="home"]');
    await click('#theme > summary');
    const looks = await run("[...document.querySelectorAll('.theme-look')].map(b=>b.dataset.art)");
    assert.equal(looks.length, 6);
    const prints = new Set();
    for (const look of looks) {
      await click('.theme-look[data-art="' + look + '"]');
      assert.equal(await run('document.documentElement.dataset.art'), look);
      prints.add(await run("getComputedStyle(document.querySelector('.theme-look[aria-pressed=true] .studio-print')).backgroundImage"));
    }
    assert.equal(prints.size, 6);
    assert.ok(!prints.has('none'));
    await settle();
    writeFileSync(join(output,'studio-looks.png'),(await win.webContents.capturePage()).toPNG());
    await win.reload();
    await settle();
    assert.equal(await run('document.documentElement.dataset.art'), 'sun');
    await click('#theme > summary');
    await click('#themeReset');
    assert.equal(await run("document.documentElement.hasAttribute('data-art')"), false);
    await click('#theme > summary');
    await click('#arcadeJump');
    await click('[data-pin="rift"]');
    assert.equal(await run("document.querySelector('[data-jump]').dataset.jump"), 'rift');
    await click('#arcadeCommandClose');
    await win.reload();
    await settle();
    await click('#arcadeJump');
    await key('ArrowDown');
    assert.equal(await run('document.activeElement.dataset.jump'), 'rift');
    await key('s');
    assert.equal(await run("document.querySelector('[data-pin=rift]').getAttribute('aria-pressed')"), 'false');
    assert.equal(await run('document.activeElement.dataset.jump'), 'rift');
    await click('[data-jump="rift"]');
    assert.equal(await run('document.body.dataset.screen'), 'rift');
    console.log('PASS: Home to Rift and Academy, six distinct studio prints, theme reset and reload, pinning and keyboard navigation after reload.');
  }
  let checked = 0;
  for (const [width, height] of baseline ? [[1440,1080]] : [[1440,1080],[940,640],[600,900]]) {
    win.setSize(width,height);
    if (!baseline) {
      await run("document.querySelector('#theme > summary').click()");
      await settle();
      if (width <= 1100) {
        assert.ok(await run(`[...document.querySelectorAll('.nav .tab:not([hidden])')].every(tab=>{
          const box=tab.getBoundingClientRect(), icon=tab.querySelector('svg').getBoundingClientRect();
          return icon.width>0 && Math.abs((box.left+box.right-icon.left-icon.right)/2)<2;
        })`),'Icons are centered inside compact navigation targets');
      }
      assert.ok(await run(`(()=>{const el=document.querySelector('.theme-menu'),r=el.getBoundingClientRect();return r.width>200 && r.left>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1})()`),'Theme menu fits '+width);
      await run("document.querySelector('#theme > summary').click()");
    }
    for (const screen of baseline ? ['queue','ranks'] : screens) {
      await run(`document.querySelector('.tab[data-screen="${screen}"]').click()`);
      await settle();
      const state = await run(`(()=>{const p=document.querySelector('.screen.active'),s=document.querySelector('.scroll');return {id:p?.id,text:p?.innerText.trim().length,overflow:s.scrollWidth-s.clientWidth,queueBottom:document.getElementById('queueBtn').getBoundingClientRect().bottom,height:innerHeight}})()`);
      assert.equal(state.id, 'screen-'+screen);
      assert.ok(state.text > 0, 'Populated screen '+screen);
      assert.ok(state.overflow <= 2, `${screen} at ${width}: overflow ${state.overflow}`);
      if (screen==='queue' && width>=940) assert.ok(state.queueBottom<=state.height, 'Queue action fits');
      if (!baseline && screen==='queue' && width===1440) assert.ok(await run(`(()=>{const panel=document.querySelector('.rank-showcase').getBoundingClientRect(),figures=[...document.querySelectorAll('.hero-stats .stat-v,.climb-pct')];return figures.length===4&&figures.every(e=>e.getBoundingClientRect().right<=panel.right-12)})()`),'Four rank figures have a readable right inset');
      if (['home','queue','ranks','profile','expedition','result'].includes(screen)) writeFileSync(join(output,`${baseline?'before':'after'}-${screen}-${width}.png`),(await win.webContents.capturePage()).toPNG());
      checked++;
    }
  }
  if (!baseline) {
    assert.equal(await run(`!!document.querySelector('.nav-indicator')`),true,'Sliding navigation marker exists');
    await run(`document.querySelector('.tab[data-screen="ranks"]').click()`);
    await settle();
    assert.ok(await run(`(()=>{const a=document.querySelector('.tab[aria-selected="true"]').getBoundingClientRect(),b=document.querySelector('.nav-indicator').getBoundingClientRect();return Math.abs(a.top-b.top)<2&&Math.abs(a.height-b.height)<2})()`),'Marker aligns with selected tab after resizing');
    // The hidden fixture explicitly simulates foreground visibility for motion checks.
    await run(`Object.defineProperty(document,'hidden',{configurable:true,value:false});document.querySelector('.tab[data-screen="profile"]').click()`);
    assert.ok(await run(`document.getAnimations().some(a=>a.id==='apogee-entrance' && a.effect.getTiming().duration===240)`),'Navigation creates a real entrance animation');
    // Rapid navigation must cancel old entrance animations without leaving content hidden.
    await run(`for(const name of ['profile','queue','ranks','queue']) document.querySelector('.tab[data-screen="'+name+'"]').click()`);
    await settle();
    assert.equal(await run(`getComputedStyle(document.querySelector('#screen-queue .queue-stage')).opacity`),'1');
    await run(`document.getElementById('arcadeJump').click()`);
    assert.equal(await run(`document.getElementById('arcadeCommand').open`),true,'Command dialog opens');
    assert.equal(await run(`document.getElementById('arcadeCommand').contains(document.activeElement)`),true,'Dialog receives focus');
    assert.equal(await run(`getComputedStyle(document.getElementById('arcadeCommand')).animationName`),'surface-arrive','Dialog uses the surface transition');
    await run(`document.getElementById('arcadeCommand').close()`);
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await run(`document.querySelector('.tab[data-screen="ranks"]').click()`);
    await settle();
    assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`),true);
    assert.equal(await run(`document.getAnimations().filter(a=>a.id==='apogee-entrance'&&a.playState==='running').length`),0,'Reduced motion bypasses entrances');
    // A broken marker must fail the alignment assertion, proving the check is active.
    await run(`document.querySelector('.nav-indicator').style.transform='translateY(-10000px)'`);
    assert.equal(await run(`(()=>{const a=document.querySelector('.tab[aria-selected="true"]').getBoundingClientRect(),b=document.querySelector('.nav-indicator').getBoundingClientRect();return Math.abs(a.top-b.top)<2})()`),false,'Alignment check detects displaced marker');
    win.webContents.debugger.detach();
  }
  assert.deepEqual(errors,[], 'Renderer errors');
  console.log(`PASS: ${checked} populated screen/size combinations; ${baseline?'baseline screenshots':'navigation marker, rapid navigation, reduced motion, queue fit and screenshots'}.`);
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
