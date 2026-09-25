/** Isolated rendered UI checks. All campaign history here is explicitly synthetic. */
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ExpeditionService } from "../src/app/expedition.ts";
import { ExpeditionStore } from "../src/core/expedition/store.ts";
import { acceptChallenge, enroll, startTrial, syncExpedition, trialSteps } from "../src/core/expedition/engine.ts";
import { loadExpedition } from "../src/core/expedition/definition.ts";
import type { ExpeditionRun, ExpeditionState, ExpeditionView } from "../src/core/expedition/types.ts";

const output = resolve(".cache/expedition-ui"), isolated = mkdtempSync(join(tmpdir(), "apogee-expedition-ui-"));
app.setPath("userData", join(isolated, "electron"));
const stats = join(isolated, "stats"); mkdirSync(stats);
let dir: string | null = null, service = new ExpeditionService(isolated);
const def = loadExpedition();
const store = new ExpeditionStore(join(isolated, "expedition-first-light-v5.json"), def);
const realNow = Date.now;
let time = realNow(), serial = 0;
const sessionStartedAt = time;
const sessionView = (view: ExpeditionView): ExpeditionView => ({ ...view, sessionStartedAt });
Date.now = () => time;
const advance = () => time += 1000;
const run = (scenario: string, score: number, at = advance()): ExpeditionRun => ({ id: `ui-run-${++serial}`, scenario, score, at });
let win: BrowserWindow;
ipcMain.handle("test:view", () => sessionView(service.view(dir)));
ipcMain.handle("test:folder", () => { dir = stats; return stats; });
ipcMain.handle("test:action", (_e, a) => {
  advance();
  try {
    if (a.type === "launch") return { view: sessionView(service.view(dir)), note: service.playlist(dir).note };
    return { view: sessionView(service.action(a, dir)) };
  } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
});
async function evaluate<T>(source: string): Promise<T> { return win.webContents.executeJavaScript(source, true); }
async function waitFor(source: string) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate<boolean>(source)) return;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error(`UI condition timed out: ${source}`);
}
async function click(selector: string) {
  const found = await evaluate<boolean>(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el||el.disabled||!el.checkVisibility())return false;el.click();return true})()`);
  assert.ok(found, `Missing or disabled control ${selector}`);
  await waitFor(`!document.querySelector('#expBand')?.disabled`);
}
async function publish(state: ExpeditionState) {
  store.save(state); service = new ExpeditionService(isolated);
  win.webContents.send("test:update", sessionView(service.view(dir)));
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await waitFor(`document.querySelector('.exp-tabs').textContent.includes('${Object.keys(state.rewards).length}/122')`);
  await evaluate(`document.querySelector('.cosmic-cinematic:not([hidden]) button')?.click()`);
}
async function screenshot(name: string) {
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await new Promise(r => setTimeout(r, 100));
  writeFileSync(join(output, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function noOverflow() {
  const overflow = await evaluate<string[]>(`[...document.querySelectorAll('#expeditionRoot *')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&s.position!=='absolute'&&r.right>innerWidth+2}).map(e=>e.className?.baseVal??e.className).slice(0,10)`);
  assert.deepEqual(overflow, [], "Expedition content extends beyond the window");
}

app.whenReady().then(async () => {
  const html = readFileSync(resolve("tools/apogee-ui-preview.html"), "utf8").replace('<script>/* Expedition presentation.', '<script>window.apogee=window.expeditionTest;/* Expedition presentation.');
  assert.ok(html.includes("window.apogee=window.expeditionTest"));
  writeFileSync(join(output, "fixture.html"), html);
  const errors: string[] = [];
  win = new BrowserWindow({ show: false, width: 1440, height: 1080, webPreferences: { preload: join(output, "preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(join(output, "fixture.html"));
  await waitFor(`!!document.querySelector('[data-exp-action="folder"]')`);
  const screens = await evaluate<string[]>(`[...document.querySelectorAll('.tab')].filter(el=>!el.hidden && el.checkVisibility()).map(el=>el.dataset.screen)`);
  const screenSizes = process.env.APOGEE_EXPEDITION_UI_ONLY === '1' ? [] : [[1440,1080],[940,640],[600,900]];
  for (const [width,height] of screenSizes) {
    win.setSize(width,height);
    for (const screen of screens) {
      await click(`.tab[data-screen="${screen}"]`);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const layout = await evaluate<{active:boolean, text:number, overflow:number}>(`(()=>{const panel=document.getElementById('screen-${screen}'), scroller=document.querySelector('.scroll');return {active:panel.classList.contains('active'),text:panel.textContent.trim().length,overflow:scroller.scrollWidth-scroller.clientWidth}})()`);
      assert.ok(layout.active && layout.text > 0, `${screen} has no visible content`);
      assert.ok(layout.overflow <= 2, `${screen} overflows at ${width}px by ${layout.overflow}px`);
      if (screen === 'queue' && width >= 940) {
        assert.ok(await evaluate(`document.getElementById('expeditionHome').getBoundingClientRect().bottom < innerHeight`), 'Solo entry must be visible from the lobby');
        await screenshot(`queue-fit-${width}x${height}`);
        const queueFit = await evaluate<{bottom:number,height:number}>(`({bottom:document.getElementById('queueBtn').getBoundingClientRect().bottom,height:innerHeight})`);
        assert.ok(queueFit.bottom <= queueFit.height, `Queue action must fit without scrolling at ${width}x${height}: ${JSON.stringify(queueFit)}`);
      }
      await screenshot(`app-${screen}-${width}x${height}`);
    }
  }
  if (screenSizes.length) console.log(`PASS: ${screens.length} application screens render without page overflow at three window sizes.`);
  win.setSize(1440,1080);
  await click('.tab[data-screen="expedition"]');
  await evaluate(`document.getElementById('app').hidden=true; document.getElementById('empty').hidden=false`);
  assert.ok(await evaluate(`document.getElementById('expeditionRoot').checkVisibility()`), 'Expedition onboarding must work without a first stats snapshot');
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('empty')).display`), 'none');
  await evaluate(`document.getElementById('app').hidden=false; document.getElementById('empty').hidden=true`);
  assert.equal(await evaluate(`document.querySelector('#screen-expedition').classList.contains('active')`), true);
  await noOverflow(); await screenshot("01-onboarding");
  await click('[data-exp-action="folder"]');
  await waitFor(`!!document.querySelector('[data-exp-action="enroll"]')`);
  async function chooseBand(b: number) {
    await evaluate(`document.getElementById('expBand').value='${b}';document.getElementById('expBand').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`!document.getElementById('expBand').disabled && document.getElementById('expBand').value==='${b}'`);
  }
  await chooseBand(3);
  assert.match(await evaluate<string>(`document.querySelector('.exp-band-card.selected').textContent`), /Expert/);
  assert.equal(await evaluate(`document.querySelectorAll('.exp-band-card').length`), 4, 'every difficulty is explained before joining');
  await click('[data-exp-action="enroll"]');
  assert.equal(service.view(dir).state!.band, 3, 'enrollment respects preview difficulty');
  await click('.exp-main-action [data-exp-action="start"]');
  assert.equal(await evaluate(`document.activeElement.matches('.exp-objective h3')`), true, 'starting an activity moves keyboard focus to the new objective');
  const d = def.destinations[0], roster = d.bands[0];
  let state = syncExpedition(service.view(dir).state!, def, [run(d.bands[3][0].name, 0)], advance());
  // A prior-session baseline makes the recap verify actual improvement copy.
  state.enrolledAt = sessionStartedAt - 10000;
  state.runs.push({ id: 'ui-prior-session', scenario: roster[0].name, score: roster[0].target * .9, at: sessionStartedAt - 1000 });
  await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-transmission').textContent`), /Attempt over/);
  await screenshot('02-expert-retry');
  await click('[data-exp-action="dismiss-signal"]');
  assert.match(await evaluate<string>(`document.querySelector('.exp-last-result').textContent`), /attempt ended/i, 'the miss outlives its dismissed verdict');
  await chooseBand(0);
  // One click starts the attempt and opens its first scenario; the deck then listens.
  await click('.exp-main-action [data-exp-action="start"]');
  assert.match(await evaluate<string>(`document.querySelector('.exp-uplink').textContent`), new RegExp(`Listening for your run on ${roster[0].name}`));
  state = syncExpedition(service.view(dir).state!, def, [run(roster[0].name, roster[0].target), run(roster[1].name, 0)], advance());
  await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-objective .exp-eyebrow').textContent`), /Checkpoint 2 of 3/i);
  assert.match(await evaluate<string>(`document.querySelector('.exp-objective h3').textContent`), new RegExp(roster[1].name));
  assert.match(await evaluate<string>(`document.querySelector('.exp-transmission').textContent`), /Checkpoint 1 secured/);
  assert.equal(await evaluate(`document.querySelectorAll('.exp-flight li').length`), 3, 'every round is visible');
  assert.equal(await evaluate(`document.querySelectorAll('.exp-flight-current').length`), 1, 'one current round');
  assert.equal(await evaluate(`!!document.querySelector('.exp-uplink')`), false, 'a landed run ends the listening state');
  await click('.exp-detail > details:last-of-type > summary');
  await publish(state);
  assert.equal(await evaluate(`document.querySelector('.exp-detail > details:last-of-type').open`), true, 'live refresh preserves expanded sections');
  await screenshot('03-novice-checkpoint');
  state = syncExpedition(service.view(dir).state!, def, [run(roster[1].name, roster[1].target * .9)], advance());
  await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-transmission').textContent`), /Not this time/);
  assert.match(await evaluate<string>(`document.querySelector('.exp-transmission').textContent`), /1 checkpoint safe/);
  await screenshot('03b-novice-miss');
  await click('[data-exp-action="abandon"]');
  assert.match(await evaluate<string>(`document.querySelector('.exp-main-action').textContent`), /Resume at checkpoint 2/);
  await click('.exp-main-action [data-exp-action="start"]');
  state = syncExpedition(service.view(dir).state!, def, roster.slice(1).map(sc => run(sc.name, sc.target * 1.2)), advance());
  await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-objective h3').textContent`), new RegExp(`${d.name} is yours`));
  assert.match(await evaluate<string>(`document.querySelector('.exp-transmission').textContent`), new RegExp(`${d.name} cleared`));
  assert.match(await evaluate<string>(`document.querySelector('.exp-journey-progress').textContent`), /1 \/ 6 destinations/);
  await click('.exp-detail [data-exp-action="equip"]');
  assert.equal(service.view(dir).state!.equipped.ship, `${d.id}:ship`);
  await click('.exp-equip-insignia [data-exp-action="equip"]');
  assert.equal(service.view(dir).state!.equipped.insignia, `${d.id}:0:clear`);
  assert.match(await evaluate<string>(`document.querySelector('.exp-map-ship').textContent`), /Novice/);
  assert.match(await evaluate<string>(`document.getElementById('expeditionIdentity').textContent`), /Novice/);
  await screenshot('04-destination-clear');
  await click('.exp-main-action [data-exp-action="select"]');
  assert.equal(service.view(dir).state!.selected, def.destinations[1].id, 'clear offers next destination');
  await click(`.exp-planet[data-destination="${d.id}"]`);
  await chooseBand(1);
  assert.equal(await evaluate(`document.querySelectorAll('.exp-deck-choice').length`), 3, 'the three warm-ups are the next move');
  assert.match(await evaluate<string>(`document.querySelector('.exp-objective').textContent`), /Pick one warm-up/);
  for (const [w, h] of [[1440,1080],[940,640],[600,900]]) {
    win.setSize(w,h); await noOverflow(); await screenshot(`05-intermediate-${w}x${h}`);
  }
  win.setSize(1440,1080);
  await click('[data-exp-action="accept"][data-kind="score_attack"]');
  state = service.view(dir).state!;
  const accepted = state.routes[`${d.id}:1`].challenges.at(-1)!;
  assert.equal(accepted.steps![0].source, 'published');
  state = syncExpedition(state, def, accepted.steps!.map(st => run(st.scenario, st.target!)), advance());
  await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-objective h3').textContent`), /Take on the/);
  assert.match(await evaluate<string>(`document.querySelector('.exp-transmission').textContent`), /trial at .* is open/);
  await click('.exp-optional > summary');
  await click('[data-exp-action="accept"][data-kind="circuit"]');
  assert.match(await evaluate<string>(`document.querySelector('.exp-objective').textContent`), /already open/);
  await click('.exp-main-action [data-exp-action="pause-route"]');
  await click('.exp-main-action [data-exp-action="start"]');
  state = syncExpedition(service.view(dir).state!, def, [run(d.bands[1][0].name, 0)], advance());
  await publish(state);
  // A paused optional route must not take over the retry action after a failed trial.
  await click('.exp-main-action [data-exp-action="start"]');
  state = syncExpedition(service.view(dir).state!, def, d.bands[1].map(sc => run(sc.name, sc.target * 1.2)), advance());
  await publish(state);
  await click('.exp-detail [data-exp-action="reward"]');
  assert.ok(await evaluate(`!!document.activeElement.dataset.rewardCard`));
  await click('[data-page="map"]');
  await chooseBand(2);
  assert.match(await evaluate<string>(`document.querySelector('.exp-main-action').textContent`), /Start unassisted/);
  await click('.exp-optional > summary');
  await click('[data-exp-action="accept"][data-kind="score_attack"]');
  state = service.view(dir).state!;
  const prep = state.routes[`${d.id}:2`].challenges.at(-1)!;
  state = syncExpedition(state, def, prep.steps!.map(st => run(st.scenario, st.target!)), advance());
  await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-main-action').textContent`), /Start with one retry/);
  await screenshot('06-advanced-choice');
  await click('.exp-main-action [data-approach="prepared"]');
  state = syncExpedition(service.view(dir).state!, def, [run(d.bands[2][0].name, 0)], advance());
  await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-rule').textContent`), /No retries left/);
  assert.match(await evaluate<string>(`document.querySelector('.exp-transmission').textContent`), /Retry used/);
  state = syncExpedition(service.view(dir).state!, def, d.bands[2].map(sc => run(sc.name, sc.target * 1.2)), advance());
  await publish(state);
  assert.ok(!state.rewards[`${d.id}:2:direct`]);
  await evaluate(`[...document.querySelectorAll('.exp-optional')].find(el=>el.querySelector('summary').textContent.includes('Replay')).open=true`);
  await click('.exp-optional [data-approach="direct"]');
  state = syncExpedition(service.view(dir).state!, def, d.bands[2].map(sc => run(sc.name, sc.target * 1.2)), advance());
  await publish(state);
  assert.ok(state.rewards[`${d.id}:2:direct`]);
  dir = null; await publish(state);
  assert.match(await evaluate<string>(`document.querySelector('.exp-folder-needed').textContent`), /saved progress is safe/);
  await click('.exp-folder-needed [data-exp-action="folder"]');
  await waitFor(`!document.querySelector('.exp-folder-needed')`);
  assert.ok(service.view(dir).state!.rewards[`${d.id}:2:direct`]);
  await click('[data-page="recap"]');
  assert.equal(await evaluate(`document.querySelector('.scroll').scrollTop`), 0, 'page navigation opens recap at the beginning');
  assert.equal(Number(await evaluate(`document.querySelector('.exp-stats b').textContent`)), state.runs.filter(r => r.at >= sessionStartedAt).length);
  assert.match(await evaluate<string>(`document.querySelector('.exp-session-progress').textContent`), /3 new checkpoints/);
  assert.match(await evaluate<string>(`document.querySelector('.exp-session-progress').textContent`), /new best in your expedition log/);
  assert.match(await evaluate<string>(`document.querySelector('.exp-recap-columns').textContent`), /checkpoints saved/);
  await screenshot('07-session-recap'); await noOverflow();
  await click('[data-page="map"]');
  await click('[data-exp-action="layout"]');
  assert.equal(await evaluate(`document.querySelectorAll('.exp-map-list .exp-planet').length`), 6);
  await evaluate(`document.querySelector('[data-exp-action="layout"]').focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await waitFor(`document.activeElement.classList.contains('exp-planet')`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
  await waitFor(`!document.querySelector('#expBand').disabled`);

  // Seed a fully earned, synthetic collection through the same pure evaluator.
  let full = enroll(def, advance());
  for (let b = 0; b < 4; b++) for (const destination of def.destinations) {
    const scenarios = destination.bands[b];
    for (const kind of ["discovery", "score_attack", "steady", "circuit"] as const) {
      full = acceptChallenge(full, def, destination.id, b, [], advance(), kind);
      const steps=full.routes[`${destination.id}:${b}`].challenges.at(-1)!.steps!;
      full = syncExpedition(full, def, steps.flatMap(step=>Array.from({length:step.required},()=>run(step.scenario,step.target??100))), advance());
    }
    full = startTrial(full, def, destination.id, b, advance());
    full = syncExpedition(full, def, scenarios.map(sc=>run(sc.name,sc.target*1.2)),advance());
  }
  for(let b=0;b<4;b++) {
    full=startTrial(full,def,'final',b,advance());
    full=syncExpedition(full,def,trialSteps(def,'final',b).map(sc=>run(sc.scenario,sc.target*1.2)),advance());
  }
  full=syncExpedition(full,def,Array.from({length:500},(_,i)=>run(`Free training ${i}`,100)),advance());
  full.equipped={ship:'final:ship',frame:'final:frame',banner:'final:banner',title:'final:title'};
  full.selected = 'final';
  await publish(full);
  assert.match(await evaluate<string>(`document.getElementById('expeditionHomeDetail').textContent`), /Rewards collected/);
  await click('[data-page="collection"]');
  await click('[data-filter="all"]');
  assert.equal(await evaluate(`document.querySelectorAll('.exp-reward.owned').length`),122);
  await screenshot("06-complete-collection");
  await click('[data-page="map"]'); await click('[data-exp-action="layout"]');
  await screenshot("07-expedition-complete");
  // Controlled foreground signals in the isolated hidden fixture exercise real WebGL
  // rendering and event handlers without taking focus away from the user's apps.
  await evaluate(`Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});Object.defineProperty(document,'hidden',{configurable:true,value:false});window.dispatchEvent(new Event('focus'));`);
  await waitFor(`window.ApogeeCosmic.inspect().animating`);
  assert.ok(await evaluate(`window.ApogeeCosmic.inspect().available`), 'WebGL scene initialized');
  await evaluate(`document.querySelector('.exp-planet[data-destination="destination-2"]').focus()`);
  await click('.exp-planet[data-destination="destination-2"]');
  assert.ok(await evaluate(`document.activeElement.matches('.exp-planet.selected[data-destination="destination-2"]')`),'Map selection retains focus on its own button after selected styling changes');
  await waitFor(`window.ApogeeCosmic.inspect().traveling`);
  const arrivalDuration = await evaluate<number>(`window.ApogeeCosmic.inspect().travelDuration`);
  assert.equal(arrivalDuration,3200,'Unvisited destination gets a longer arrival');
  await screenshot('10-first-arrival');
  await click('.cosmic-travel.active button');
  assert.equal(await evaluate(`window.ApogeeCosmic.inspect().traveling`),false,'Arrival can be skipped');
  await click('.exp-planet[data-destination="destination-3"]');
  await evaluate(`document.querySelector('.exp-planet.selected').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await click('.exp-planet[data-destination="destination-2"]');
  assert.equal(await evaluate(`window.ApogeeCosmic.inspect().travelDuration`),900,'Revisit uses brief travel');
  await evaluate(`document.querySelector('.exp-planet.selected').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await click('.cosmic-map-controls button[aria-pressed]');
  const pausedFrames = await evaluate<number>(`window.ApogeeCosmic.inspect().frames`);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(await evaluate(`window.ApogeeCosmic.inspect().frames`),pausedFrames,'Paused scene does not keep rendering');
  await click('.cosmic-map-controls button[aria-pressed]');
  const geometryCount = await evaluate<number>(`window.ApogeeCosmic.inspect().geometries`);
  await evaluate(`window.__cosmicTestCanvas=document.querySelector('.cosmic-canvas')`);
  for(let i=0;i<3;i++){await click('[data-page="collection"]');await click('[data-page="map"]');}
  assert.ok(await evaluate(`document.querySelector('.cosmic-canvas')===window.__cosmicTestCanvas`),'Map and hangar reuse their renderer');
  assert.equal(await evaluate(`window.ApogeeCosmic.inspect().geometries`),geometryCount,'Page changes do not accumulate geometry');
  await click('.tab[data-screen="profile"]');
  await waitFor(`!window.ApogeeCosmic.inspect().animating`);
  await click('.tab[data-screen="expedition"]');
  await waitFor(`window.ApogeeCosmic.inspect().animating`);
  // Simulate context loss through the browser event so fallback can be checked deterministically.
  await evaluate(`document.querySelector('.cosmic-canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true}))`);
  assert.equal(await evaluate(`document.querySelector('.exp-map').classList.contains('cosmic-ready')`),false);
  assert.ok(await evaluate(`[...document.querySelectorAll('.exp-planet')].every(e=>!e.style.left&&!e.style.top&&e.checkVisibility())`),'Fallback exposes all six ordinary buttons');
  await screenshot('11-map-fallback');
  await click('.exp-planet[data-destination="destination-4"]');
  assert.match(await evaluate<string>(`document.querySelector('.exp-detail h2').textContent`),/Ion Wilds/);
  await evaluate(`window.__cosmicTestCanvas.dispatchEvent(new Event('webglcontextrestored'))`);
  assert.ok(await evaluate(`document.querySelector('.exp-map.cosmic-ready>.cosmic-canvas')&&document.querySelectorAll('.cosmic-map-controls').length===1`),'Context restoration reconnects canvas and controls after fallback navigation');
  await click('[data-page="collection"]');await screenshot('12-hangar');await click('[data-page="map"]');
  await evaluate(`document.querySelector('.exp-planet.selected').focus();window.ApogeeCosmic.celebrate(${JSON.stringify(sessionView(service.view(dir)))},['destination-4:0:clear'])`);
  assert.ok(await evaluate(`document.activeElement.closest('.cosmic-cinematic')!==null`),'Clear reveal receives keyboard focus');
  await screenshot('13-clear-reveal');
  await click('.cosmic-cinematic button');
  assert.ok(await evaluate(`document.activeElement.classList.contains('exp-planet')`),'Closing reveal restores keyboard focus');
  await evaluate(`delete document.hasFocus;delete document.hidden;window.dispatchEvent(new Event('blur'))`);
  console.log('PASS: real 3D rendering, arrival/revisit timing, skip, pause, renderer reuse, background suspension, context-loss fallback, clear reveal focus.');
  for (const [w,h] of [[940,640],[600,900]]) {
    win.setSize(w,h); await new Promise(r=>setTimeout(r,80));
    await noOverflow(); await screenshot(`08-map-${w}x${h}`);
    await click('[data-page="collection"]'); await noOverflow(); await screenshot(`09-collection-${w}x${h}`);
    await click('[data-page="map"]');
  }
  await win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await click('[data-page="collection"]');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.exp-animated-frame')).animationName`),'none');
  await click('[data-page="recap"]'); await noOverflow();
  assert.deepEqual(errors,[]);
  console.log('PASS: rendered enrollment, route choices, reward previews, optional routes, trial failure/retry/clear, equipment, band switching, parallel list, all 122 rewards, compact layouts, reduced motion, no renderer errors.');
  console.log(`Screenshots: ${output}`);
  Date.now=realNow; app.exit(0);
}).catch(e=>{console.error(e);Date.now=realNow;app.exit(1);});
