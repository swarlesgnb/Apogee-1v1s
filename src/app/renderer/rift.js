/* Rift presentation. The desktop main process owns choices, receipts and persistence. */
(() => {
  'use strict';
  const root = document.getElementById('riftRoot');
  if (!root) return;
  document.getElementById('app').before(root.parentElement);
  const bridge = window.apogee;
  const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  let view = window.__APOGEE_RIFT__ || null, busy = false, message = '', band = 0, starter = 'charge', overdrive = false, confirm = '';
  let lastReceipt = null;
  const item = id => view.abilities.find(a => a.id === id);
  const button = (action, label, attrs = '', kind = '') => `<button type="button" class="rift-button ${kind}" data-rift="${action}" ${attrs} ${busy ? 'disabled' : ''}>${label}</button>`;
  const portal = (small = false) => `<div class="rift-portal ${small ? 'small' : ''}" aria-hidden="true"><div class="rift-orbit one"></div><div class="rift-orbit two"></div><div class="rift-singularity"></div><span class="rift-cross north">+</span><span class="rift-cross south">+</span><div class="rift-coordinate">RA 00:48 / DEC +05</div></div>`;
  function ability(id, action = null) {
    const a = item(id); if (!a) return '';
    const replacement = action && view.state?.abilities.length === 5 ? `<label class="rift-replace">Replace<select data-replace="${e(id)}"><option value="">Choose a slot…</option>${view.state.abilities.map(x => `<option value="${e(x)}">${e(item(x).name)}</option>`).join('')}</select></label>` : '';
    return `<article class="rift-ability" data-ability="${e(id)}"><span class="rift-tag">${e(a.tag)}</span><h3>${e(a.name)}</h3><p>${e(a.text)}</p>${replacement}${action ? button(action, action === 'buy' ? `Install · ${a.price} salvage` : 'Install ability', `data-id="${e(id)}" ${action === 'buy' && view.state.salvage < a.price ? 'disabled' : ''}`) : ''}</article>`;
  }
  function loadout(s) {
    return `<section class="rift-loadout"><div class="rift-section-title"><h2>Your build</h2><span>${s.abilities.length} / 5 slots · replace freely when choosing a reward</span></div><div class="rift-equipment">${s.abilities.map(id => ability(id)).join('')}${Array.from({length:5-s.abilities.length}, () => '<div class="rift-empty-slot"><span>+</span>Open slot</div>').join('')}</div></section>`;
  }
  function stats(s) {
    return `<div class="rift-stats" aria-label="Voyage resources"><div><span>HULL</span><strong>${s.hull}<small> / 12</small></strong><meter min="0" max="12" value="${s.hull}" aria-label="Hull"></meter></div><div><span>SHIELD</span><strong>${s.shield}<small> / 6</small></strong></div><div><span>CHARGE</span><strong>${s.charge}<small> / ${s.abilities.includes('battery') ? 5 : 3}</small></strong></div><div><span>SALVAGE</span><strong>${s.salvage}<small> ◇</small></strong></div></div>`;
  }
  function routeStrip(s) {
    return `<ol class="rift-route-strip" aria-label="Voyage progress">${s.map.map((_, i) => `<li class="${i === s.depth ? 'current' : i < s.depth ? 'past' : ''}" ${i === s.depth ? 'aria-current="step"' : ''}><span>${[3,7].includes(i) ? '✦' : String(i+1).padStart(2,'0')}</span><small>${i===3?'WARDEN':i===7?'HORIZON':i<s.depth?'PASSED':i===s.depth?'YOU ARE HERE':'SECTOR'}</small></li>`).join('')}</ol>`;
  }
  function briefing(s) {
    const next = s.depth <= 3 ? view.bosses[0] : view.bosses[1];
    return `<aside class="rift-forecast"><span class="rift-tag">BOSS INTEL · SECTOR ${s.depth <= 3 ? '04' : '08'}</span><strong>${e(next.name)}</strong><p>${e(next.rule)}</p></aside>`;
  }
  function home() {
    const play = !!bridge?.riftAction && view.canPlay && !view.error;
    return `<div class="rift-intro"><div class="rift-intro-copy"><span class="rift-eyebrow">A SOLO ROGUELITE / FIRST FLIGHT</span><h1>INTO<br>THE <em>RIFT.</em></h1><p class="rift-lede">Your aim is the power source.<br>Build something extraordinary.</p><p>Eight sectors. Two bosses. Five ability slots.<br>Choose a route, play in KovaaK’s, and watch your build ignite.</p><div class="rift-intro-notes"><span>↗ Branching encounters</span><span>◇ Abilities that combine</span><span>⌁ Saved between sessions</span></div></div>${portal()}</div>
      <section class="rift-departure"><div class="rift-section-title"><h2>Choose your starting ship</h2><span>Every ship can discover every ability.</span></div><div class="rift-kits">${view.starters.map((k,i) => `<button type="button" data-rift="starter" data-id="${e(k.id)}" class="rift-kit ${starter===k.id?'selected':''}" aria-pressed="${starter===k.id}"><span class="rift-kit-mark" aria-hidden="true">${['⌁','⟐','↗'][i]}</span><span class="rift-tag">0${i+1} / ${e(k.id.toUpperCase())}</span><h3>${e(k.name)}</h3><p>${e(k.text)}</p><small>${k.abilities.map(id => e(item(id).name)).join(' + ')}</small></button>`).join('')}</div><div class="rift-departure-controls"><label>Scenario difficulty<select id="riftBand">${view.bands.map((b,i)=>`<option value="${i}" ${i===band?'selected':''}>${e(b)}</option>`).join('')}</select></label>${button('start', 'Enter the Rift <span aria-hidden="true">↗</span>', play ? '' : 'disabled', 'primary')}${!view.canPlay && bridge?.chooseFolder ? button('folder','Connect stats folder') : ''}</div><p class="rift-caption">References use the first published score threshold in your chosen difficulty and freeze for the voyage. Reach the reference for 100 base damage; up to 150 for stronger runs. Balance is in playtesting.</p>${!bridge?.riftAction ? '<p class="rift-notice">Open the desktop app to play. This preview cannot receive KovaaK’s runs.</p>' : !view.canPlay ? '<p class="rift-notice">Connect your KovaaK’s stats folder to begin. Steam sign-in is not required for this solo mode.</p>' : ''}</section>`;
  }
  function route(s) {
    return `<div class="rift-section-title"><div><span class="rift-eyebrow">SECTOR ${String(s.depth+1).padStart(2,'0')}</span><h2>Choose your next encounter.</h2></div><span>Every route joins the next sector.</span></div><div class="rift-paths">${s.map[s.depth].map((r,i) => `<article class="rift-path ${r.kind}"><div class="rift-path-top"><span class="rift-tag">${e(r.kind.toUpperCase())}</span><span class="rift-lane">${['A','B','C'][i]}</span></div><h3>${e(r.name)}</h3><p class="rift-discipline">${e(r.category)}</p><p class="rift-scenario">${e(r.scenario)}</p><dl><div><dt>Score reference</dt><dd>${num(r.target)}</dd></div><div><dt>Enemy hull / attack</dt><dd>${r.hp} / ${r.attack}</dd></div><div><dt>Run limit / reward</dt><dd>${r.rounds} / ${r.reward} ◇</dd></div></dl>${r.boss?`<p class="rift-rule">${e(view.bosses.find(b=>b.id===r.boss).rule)}</p>`:''}${button('enter','Take this route ↗',`data-id="${e(r.id)}"`)}</article>`).join('')}</div>${briefing(s)}<p class="rift-caption">An uncleared enemy retaliates after each run. Running out of rounds forces a retreat and costs 2 hull through shields. At Event Horizon, running out of rounds ends the voyage.</p>`;
  }
  function combat(s) {
    const f = s.fight, r = f.encounter, armed = f.armed;
    return `<div class="rift-battle"><div class="rift-enemy-art ${r.kind}" aria-hidden="true">${portal(true)}<span class="rift-enemy-glyph">${r.boss==='collapse'?'◉':r.boss==='warden'?'⟐':r.kind==='elite'?'✧':'◇'}</span></div><div class="rift-battle-copy"><span class="rift-eyebrow">${e(r.kind.toUpperCase())} / ROUND ${f.round+1} OF ${r.rounds}</span><h2>${e(r.name)}</h2><div class="rift-enemy-hp"><span>ENEMY HULL <b>${f.hp} / ${r.hp}</b></span><meter min="0" max="${r.hp}" value="${f.hp}" aria-label="Enemy hull"></meter></div><p class="rift-discipline">${e(r.category)}</p><h3>${e(r.scenario)}</h3><p>Score <strong>${num(r.target)}</strong> for 100 base damage. Higher scores deal more, up to 150. Your abilities apply afterward.</p>${r.boss?`<p class="rift-rule">${e(view.bosses.find(b=>b.id===r.boss).rule)}</p>`:''}${armed?`<div class="rift-listening" role="status"><span></span><div><strong>Listening for your completed run</strong><p>${armed.overdrive?'Overdrive is armed. Charge is spent when the result arrives.':'Your first complete run on this scenario settles this round.'}</p></div></div>${button('launch','Open scenario again')}`:`${s.abilities.includes('overdrive')?`<label class="rift-overdrive"><input type="checkbox" id="riftOverdrive" ${overdrive&&s.charge?'checked':''} ${s.charge?'':'disabled'}><span><strong>Overdrive</strong>Spend ${s.charge} Charge for +${s.charge*25} damage${s.abilities.includes('afterglow')?` and up to ${s.charge} shield`:''}.</span></label>`:''}${button('arm','Play in KovaaK’s ↗',view.canPlay?'':'disabled','primary')}`}</div></div><p class="rift-caption">Complete the named scenario after pressing Play. Partial, unrelated, old, and duplicate runs do not settle a round. You can close Apogee and resume; a completed armed round is recovered from your stats folder.</p>`;
  }
  function result(s) {
    const r=s.last, titles={clear:'Encounter cleared.',continue:'The fight continues.',retreat:'Hull breached. Fall back.',lost:'The Rift takes this one.'};
    return `<section class="rift-resolution ${r.verdict}" data-receipt="${e(r.receipt.id)}"><span class="rift-eyebrow">SIGNAL RECEIVED / ${e(s.fight.encounter.name.toUpperCase())}</span><h2 tabindex="-1" id="riftResultTitle">${titles[r.verdict]}</h2><div class="rift-score-line"><div><span>KOVAAK’S SCORE</span><strong>${num(r.receipt.score)}</strong><small>${num(r.ratio*100)}% of the frozen reference</small></div><span class="rift-score-arrow" aria-hidden="true">→</span><div><span>RIFT ATTACK</span><strong class="rift-damage">${r.damage}</strong><small>${r.base} base damage + your build</small></div></div><ol class="rift-triggers">${r.effects.map((effect,i)=>`<li style="--trigger:${i}"><span aria-hidden="true">✦</span>${e(effect)}</li>`).join('') || '<li>Your aim supplied the whole attack.</li>'}</ol><div class="rift-aftermath"><span>Enemy hull <strong>${r.enemyLeft}</strong></span><span>Retaliation <strong>${r.retaliation}</strong></span><span>Shield absorbed <strong>${r.absorbed}</strong></span><span>Hull lost <strong>${r.hullLost}</strong></span></div>${button('continue',r.verdict==='clear'?(s.depth===7?'Escape the Rift →':'Choose your reward →'):r.verdict==='continue'?'Prepare the next round →':r.verdict==='lost'?'Voyage recap →':'Continue to the next sector →','','primary')}</section>`;
  }
  function rewards(s) {
    return `<section class="rift-rewards"><span class="rift-eyebrow">SALVAGED TECHNOLOGY</span><div class="rift-section-title"><h2>Make the build yours.</h2><span>${s.abilities.length===5?'All slots filled. Choose what to replace.':'Choose one ability. The others stay behind.'}</span></div><div class="rift-offers">${s.offers.map(id=>ability(id,'take')).join('')}</div><div class="rift-actions">${button('reroll','Reroll · 8 salvage',s.rerolled||s.salvage<8?'disabled':'')}${button('skip','Keep your build · take 6 salvage')}</div></section>`;
  }
  function shop(s) {
    return `<section class="rift-shop"><span class="rift-eyebrow">WAYSTATION / BEFORE SECTOR ${s.depth+1}</span><div class="rift-section-title"><h2>A little breathing room.</h2><span>${s.salvage} salvage to spend</span></div><div class="rift-offers">${s.shop.map(id=>ability(id,'buy')).join('')||'<p>You have bought everything here.</p>'}</div><div class="rift-shop-footer"><div><h3>Patch the hull</h3><p>Restore up to 4 hull. One repair per visit.</p></div>${button('repair',s.repaired?'Repair used':'Repair · 12 salvage',s.repaired||s.hull===12||s.salvage<12?'disabled':'')}${button('leave','Back into the Rift →','','primary')}</div></section>`;
  }
  function ended(s) {
    const title=s.phase==='won'?'You broke through.':s.phase==='extracted'?'Home in one piece.':'Every voyage teaches you something.';
    return `<section class="rift-ending"><span class="rift-eyebrow">${s.phase==='won'?'RIFT CLEARED':s.phase==='extracted'?'EXTRACTED':'VOYAGE ENDED'}</span><h2>${title}</h2><p>${s.log.filter(r=>r.verdict==='clear').length} encounters cleared · ${s.log.reduce((n,r)=>n+r.damage,0)} total damage · ${e(s.bandName)}</p>${s.phase==='lost'?`<p>${s.hull===0?'Your hull ran out. Shields, repairs, or an earlier burst could change the next voyage.':s.last?.verdict==='lost'?'Event Horizon survived the three-round limit. Prepare more burst damage before returning.':'This voyage was ended before its encounter finished.'}</p>`:''}<p>Your voyage record is saved. Try a different starting ship or discover a new combination.</p>${button('new','Plan another voyage ↗','','primary')}</section>`;
  }
  let planning = false;
  function render() {
    if (!view?.abilities) { root.innerHTML=`<div class="rift-notice" role="alert">${e(view?.error||'Opening the Rift…')}${button('refresh','Try again')}</div>`; return; }
    const focused = document.activeElement?.closest('[data-rift]');
    const focusKey = focused ? {action:focused.dataset.rift,id:focused.dataset.id} : null;
    const s=view.state, finished=s&&['won','lost','extracted'].includes(s.phase);
    let content;
    if (!s || finished&&planning) content=home();
    else content=`<header class="rift-voyage-head"><div><span class="rift-eyebrow">INTO THE RIFT / ${e(s.bandName.toUpperCase())}</span><h1>${e(view.starters.find(k=>k.id===s.starter)?.name||'Your voyage')}</h1></div><span class="rift-save-mark">● Progress saved locally</span></header>${stats(s)}${routeStrip(s)}${({route,combat,result,reward:rewards,shop,won:ended,lost:ended,extracted:ended}[s.phase])(s)}${loadout(s)}`;
    const endAction=s?.phase==='combat'?'abandon':s&&['route','shop'].includes(s.phase)?'extract':null;
    root.innerHTML=`<div class="rift-page">${view.error?`<div class="rift-notice" role="alert">${e(view.error)}</div>`:''}${view.warning?`<p class="rift-notice">${e(view.warning)}</p>`:''}${content}<p class="rift-message" role="status" aria-live="polite">${e(message)}</p><footer class="rift-footer"><span>SOLO · FIRST FLIGHT<br><small>Rift damage is separate from your aim score and ranked rating.</small></span><div>${endAction?confirm===endAction?`<span>${endAction==='abandon'?'End this voyage? Your current build will be lost.':'Extract now and save this voyage’s record?'}</span>${button(endAction,'Confirm', 'data-confirm="true"')}${button('cancel','Keep going')}`:button(endAction,endAction==='abandon'?'End voyage':'Extract safely'):''}${button('refresh','Refresh')}</div></footer>${view.records?.length?`<details class="rift-records"><summary>Flight recorder · ${view.records.length} recent voyages</summary>${view.records.map(r=>`<div><strong>${e(r.outcome==='won'?'Cleared':r.outcome==='lost'?'Lost':'Extracted')}</strong><span>${e(r.band)} · ${r.cleared} encounters · ${r.damage} damage</span></div>`).join('')}</details>`:''}</div>`;
    if (view.error) root.querySelectorAll('[data-rift]:not([data-rift="refresh"])').forEach(b=>b.disabled=true);
    if(focusKey) [...root.querySelectorAll('[data-rift]')].find(el=>el.dataset.rift===focusKey.action&&el.dataset.id===focusKey.id)?.focus({preventScroll:true});
    if(s?.phase==='result'&&s.last.receipt.id!==lastReceipt&&document.body.dataset.screen==='rift') {
      lastReceipt=s.last.receipt.id; document.getElementById('riftResultTitle')?.focus({preventScroll:true});
      if(typeof window.playSound==='function') window.playSound(s.last.verdict==='clear'?'celebrate':'nav');
    }
  }
  async function refresh() {
    if(!bridge?.rift) { render(); return; }
    try { view=await bridge.rift(); } catch(err) { message=String(err.message||err); }
    render();
  }
  root.addEventListener('change',event=>{
    if(event.target.id==='riftBand') band=Number(event.target.value);
    if(event.target.id==='riftOverdrive') overdrive=event.target.checked;
  });
  root.addEventListener('click',async event=>{
    const el=event.target.closest('[data-rift]'); if(!el||el.disabled||busy) return;
    const type=el.dataset.rift;
    if(type==='starter'){starter=el.dataset.id;render();return;}
    if(type==='refresh'){await refresh();return;}
    if(type==='new'){planning=true;confirm='';message='';render();return;}
    if(type==='cancel'){confirm='';render();return;}
    if(['extract','abandon'].includes(type)&&!el.dataset.confirm){confirm=type;render();return;}
    if(type==='folder'){try { await bridge.chooseFolder(); await refresh(); } catch(err){message=String(err.message||err);render();} return;}
    if(!bridge?.riftAction) return;
    const action={type};
    if(el.dataset.id) action.id=el.dataset.id;
    if(type==='start'){action.band=band;action.starter=starter;}
    if(type==='arm') action.overdrive=overdrive&&view.state.charge>0;
    if(['take','buy'].includes(type)&&view.state.abilities.length===5){
      const replacement=root.querySelector(`[data-replace="${el.dataset.id}"]`);if(!replacement?.value){message='Choose an equipped ability to replace first.';render();return;}action.replace=replacement.value;
    }
    busy=true;message='';render();
    try {
      const response=await bridge.riftAction(action);
      if(response.view){view=response.view;planning=false;}
      if(response.error) message=response.error;
      else {confirm='';overdrive=false;}
    } catch(err){message=String(err.message||err);}
    finally {busy=false;render();}
  });
  bridge?.onRift?.(next=>{view=next;render();});
  document.querySelector('.tab[data-screen="rift"]')?.addEventListener('click',refresh);
  window.addEventListener('focus',()=>{if(document.body.dataset.screen==='rift'&&!busy) void refresh();});
  void refresh();
})();
