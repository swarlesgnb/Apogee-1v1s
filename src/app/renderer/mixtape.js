/* Mixtape: saved, local sessions built from the real season pool. */
(() => {
  const root = document.getElementById('mixtapeRoot');
  if (!root) return;
  document.getElementById('app').before(root.parentElement);
  const engine = globalThis.ApogeeMixtape, bridge = window.apogee;
  const key = 'apogee.mixtape.v1';
  const e = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = n => Number(n).toLocaleString(undefined,{maximumFractionDigits:2});
  const names = {balance:'Full spectrum',push:'Close the gap',discover:'Side quests'};
  const descriptions = {balance:'A little of everything. Find your rhythm across the aim disciplines.',push:'Start with the smallest relative gaps to your next scenario thresholds.',discover:'Give your less-played scenarios a turn. No score target required.'};
  let data = typeof practice !== 'undefined' ? practice : window.__APOGEE_PRACTICE__;
  if (!data && window.__APOGEE_SEASON__) {
    const season=window.__APOGEE_SEASON__;
    data={season,scenarios:season.scenarios.map(r=>({...r,best:null,last:null,runs:0,nextRankScore:null}))};
  }
  let mood = 'balance', band = 0, count = 6, seed = Date.now(), tracks = [], active = null, history = [], selectedRecap = null;
  let busy = false, storageError = '', message = '';
  let completionBurst = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)'), motion = new Set();
  const cancelMotion = () => { for (const animation of motion) animation.cancel(); motion.clear(); };
  reduced.addEventListener('change',cancelMotion);
  function animateMix() {
    if (reduced.matches || document.hidden) return;
    [...root.querySelectorAll('.mix-track')].forEach((track,index)=>{
      const animation=track.animate([{opacity:0,transform:'translateX(12px)'},{opacity:1,transform:'translateX(0)'}],{duration:220,delay:index*18,easing:'cubic-bezier(.22,1,.36,1)',fill:'backwards'});
      motion.add(animation);animation.onfinish=animation.oncancel=()=>motion.delete(animation);
    });
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw && raw.length < 100000) {
      const saved = JSON.parse(raw);
      active = engine.valid(saved.active) && !saved.active.endedAt ? saved.active : null;
      history = Array.isArray(saved.history) ? saved.history.filter(s=>engine.valid(s)&&s.endedAt).slice(0,12) : [];
      if (active) { mood=active.mood; band=active.band; count=[3,6,9].find(n=>n>=active.tracks.length); }
    }
  } catch { storageError = 'Saved sessions could not be read. You can still make a new mix.'; }
  const windows = () => data?.season?.windows?.length ? data.season.windows : ['Novice','Intermediate','Advanced','Expert'];
  const button = (label, action, attrs='', disabled=false) => `<button type="button" data-mix="${action}" ${attrs} ${disabled?'disabled':''}>${label}</button>`;
  function save() {
    try { localStorage.setItem(key,JSON.stringify({active,history})); storageError=''; }
    catch { storageError='This session is running in memory. Local storage is unavailable; keep Apogee open to retain it.'; }
  }
  function remake() { tracks=engine.plan(data?.scenarios,{mood,band,count,seed}); }
  // A set saved before the season changed can name scenarios the pool no longer has. They
  // are skipped with the reason rather than offered, since launching one only fails.
  function skipRetired() {
    const pool=new Set((data?.scenarios||[]).map(r=>r.scenario));
    if (!active || pool.size===0) return;
    const skipped=[];
    while (active && !active.endedAt && !pool.has(active.tracks[active.index].scenario)) {
      skipped.push(active.tracks[active.index].label);
      const next=engine.skip(active); if(!next) break;
      if (next.endedAt) { complete(next); break; }
      active=next;
    }
    if (skipped.length && active) { message=`${skipped.join(', ')} left the season pool, so ${skipped.length===1?'it was':'they were'} skipped.`; save(); }
  }
  const autoKey='apogee.mixtape.autoopen';
  let autoOpen=false; try { autoOpen=localStorage.getItem(autoKey)==='1'; } catch {}
  async function launchCurrent() {
    const s=active; if(!s||!bridge?.launchScenario||busy) return;
    busy=true;message='';render();
    try{const result=await bridge.launchScenario(s.tracks[s.index].scenario);message=result?.error?(/not in this match or this season/.test(result.error)?'This scenario left the season pool. Skip it to continue.':result.error):result?.note||'Scenario launch requested. Complete the run in KovaaK’s.';}
    catch{message='Could not open KovaaK’s. You can open the named scenario manually; tracking still works.';}
    finally{busy=false;render();}
  }
  function complete(next) {
    if (next.endedAt) { history=[next,...history.filter(s=>s.id!==next.id)].slice(0,12); active=null; selectedRecap=next; completionBurst=next.tracks.every(t=>t.status==='played'); }
    else active=next;
    save(); render();
    if (next.endedAt) root.querySelector('.mix-recap h2')?.focus({preventScroll:true});
  }
  function record(run) {
    const next=engine.receive(active,run);
    if (!next) return;
    message=`Recorded ${run.scenario}: ${number(run.score)}.`;
    complete(next);
    skipRetired();
    // With auto-open on, the next track opens itself: one tab switch per track was the
    // friction between a set and the rhythm it is meant to have.
    if (autoOpen && active && !active.endedAt) void launchCurrent();
  }
  function trackList(list, current=-1) {
    return `<ol class="mix-tracklist">${list.map((t,i)=>`<li class="mix-track ${i===current?'is-current':''} ${t.status}" style="--track-order:${i}"><span class="mix-track-number">${t.status==='played'?'✓':t.status==='skipped'?'−':String(i+1).padStart(2,'0')}</span><div><small>${e(t.category)}</small><strong>${e(t.label)}</strong><span>${t.status==='played'?`Recorded ${number(t.score)}${t.reference!==null?` · ${t.score>t.reference?'+':''}${number(t.score-t.reference)} vs reference`: ' · first reference'}`:t.status==='skipped'?'Skipped · no run counted':`${e(t.referenceLabel)}${t.reference!==null?' · '+number(t.reference):''}${t.target!==null?' · next threshold '+number(t.target):''}`}</span></div>${i===current?'<b class="mix-now">UP NEXT</b>':''}</li>`).join('')}</ol>`;
  }
  function recap(s) {
    const stats=engine.summary(s);
    return `<section class="mix-recap"><div class="mix-eyebrow">SESSION SLEEVE / ${e(new Date(s.startedAt).toLocaleDateString())}</div><h2 tabindex="-1">${stats.played===s.tracks.length?'That’s a wrap.':'Your set, saved.'}</h2><p>${e(names[s.mood])} · ${e(windows()[s.band])} · local run results</p><div class="mix-recap-stats"><div><strong>${stats.played}<small>/${s.tracks.length}</small></strong><span>tracks played</span></div><div><strong>${stats.improved}<small>/${stats.compared}</small></strong><span>above saved reference</span></div><div><strong>${stats.categories}</strong><span>disciplines played</span></div></div>${stats.skipped?`<p>${stats.skipped} skipped. Skips never count as played.</p>`:''}${trackList(s.tracks)}<div class="mix-actions">${button('Make another mix ↗','new','class="mix-primary"')}${button('Copy recap','copy')}</div><p class="mix-footnote">References were frozen when this set started. These local results do not award rating or XP.</p></section>`;
  }
  function render() {
    cancelMotion();
    const focus = root.contains(document.activeElement) ? document.activeElement?.getAttribute('data-mix') : null;
    const focusValue = document.activeElement?.getAttribute('data-value');
    root.dataset.mood=mood;
    const playing=!!active, current=active?.tracks[active.index];
    root.innerHTML=`<header class="mix-heading"><div><div class="mix-eyebrow">PERSONAL PRACTICE / ON YOUR TERMS</div><h1>Mixtape<span>Find your next groove.</span></h1></div><span class="mix-local">${bridge?.onRun?'LOCAL RUN TRACKING':'DESIGN PREVIEW · TRACKING NEEDS DESKTOP'}</span></header>
      <div class="mix-message" role="status">${e(storageError || message)}</div>
      ${selectedRecap ? recap(selectedRecap) : `<div class="mix-workspace"><section class="mix-sleeve ${playing?'is-playing':''}" aria-label="${e(names[mood])} session cover"><div class="mix-sleeve-top"><span>APOGEE SELECTS</span><span>VOL. ${String(band+1).padStart(2,'0')}</span></div><div class="mix-record" aria-hidden="true"><div class="mix-record-label"><svg viewBox="0 0 100 100"><path d="M20 74 50 16 80 74 50 56Z M35 62 50 35 65 62"/></svg><span>${String(playing?active.index+1:tracks.length).padStart(2,'0')}</span></div></div><div class="mix-sleeve-title"><small>${playing?'NOW IN SESSION':e(windows()[band])+' / '+tracks.length+' TRACKS'}</small><h2>${e(names[mood])}</h2><p>${e(descriptions[mood])}</p></div><div class="mix-sleeve-bottom"><span>${playing?'ONE RUN. THEN THE NEXT.':'BUILT FROM YOUR SEASON POOL'}</span><div class="mix-bars" aria-hidden="true">${'<i></i>'.repeat(14)}</div></div></section>
      <section class="mix-console" aria-label="Session builder">${playing?`<div class="mix-console-top"><span class="mix-eyebrow">TRACK ${active.index+1} OF ${active.tracks.length}</span>${button('End set','end','class="mix-text"')}</div><progress max="${active.tracks.length}" value="${active.index}" aria-label="Tracks completed or skipped"></progress><div class="mix-current"><small>${e(current.category)}</small><h2>${e(current.label)}</h2><p>${current.reference!==null?`${e(current.referenceLabel)}: <b>${number(current.reference)}</b>. See where this run lands.`:'Your first run here becomes a reference to build on.'}</p>${current.target!==null?`<p>Next scenario threshold: <b>${number(current.target)}</b></p>`:''}<div class="mix-actions">${button(busy?'Opening…':'Open in KovaaK’s ↗','launch','class="mix-primary"',busy||!bridge?.launchScenario)}${button('Skip track','skip','',busy)}</div><p class="mix-footnote">${bridge?.onRun?'Play the scenario above. The next matching run advances your set automatically; launching alone does not complete it.':'This preview lets you build a set. Launching and automatic run tracking need the desktop app.'}</p></div>${trackList(active.tracks,active.index)}`:
      `<div class="mix-console-top"><h2>What are you feeling?</h2>${button('Start mix ↗','start','class="mix-primary"',!tracks.length)}</div><div class="mix-moods" aria-label="Session mood">${Object.entries(names).map(([id,name],i)=>button(`<span>0${i+1}</span><strong>${name}</strong><small>${id==='balance'?'A varied circuit':id==='push'?'Nearby thresholds':'Less-played picks'}</small>`,'mood',`data-value="${id}" aria-pressed="${mood===id}" class="mix-mood"`)).join('')}</div><div class="mix-controls"><label>Difficulty<select data-mix="band">${windows().map((w,i)=>`<option value="${i}" ${band===i?'selected':''}>${e(w)}</option>`).join('')}</select></label><fieldset><legend>Set length</legend>${[3,6,9].map(n=>button(String(n)+' tracks','count',`data-value="${n}" aria-pressed="${count===n}"`)).join('')}</fieldset></div><div class="mix-track-heading"><h3>Your tracklist <span>${tracks.length} scenarios</span></h3>${button('↻ Remix','remix','',!tracks.length)}</div>${tracks.length?trackList(tracks):'<p class="mix-empty">No scenarios are available in this band yet. Try another difficulty or load a season.</p>'}<div class="mix-actions">${button('Start this mix ↗','start','class="mix-primary"',!tracks.length)}<span>One run per track.<br>No timer. No pressure.</span></div>`}</section></div>`}
      <section class="mix-history"><div><span class="mix-eyebrow">YOUR BACK CATALOGUE</span><h2>Sessions worth keeping.</h2><p>Up to 12 recent sets, saved on this machine.</p></div><div class="mix-history-cards">${history.length?history.map(s=>{const a=engine.summary(s);return button(`<small>${e(new Date(s.startedAt).toLocaleDateString())}</small><strong>${e(names[s.mood])}</strong><span>${a.played}/${s.tracks.length} played · ${a.improved} above reference</span>`,'history',`data-value="${e(s.id)}" class="mix-history-card" ${active?'disabled':''}`)}).join(''):'<div class="mix-history-empty"><span aria-hidden="true">◎</span>Your first sleeve goes here.<br>Finish a set to start your collection.</div>'}</div></section>`;
    if(completionBurst && !reduced.matches) {
      const burst=document.createElement('div');burst.className='mix-burst';burst.setAttribute('aria-hidden','true');
      for(let i=0;i<16;i++){const particle=document.createElement('i');particle.style.setProperty('--burst-angle',`${i*22.5}deg`);particle.style.setProperty('--burst-distance',`${70+i%3*24}px`);burst.append(particle);}
      root.querySelector('.mix-recap')?.append(burst);
    }
    completionBurst=false;
    if (active && bridge?.onRun) {
      const note=document.createElement('p');note.className='mix-footnote';
      note.textContent='Keep Apogee open while playing. Runs played while it is closed are not added to this set.';
      root.querySelector('.mix-current')?.append(note);
      if (bridge.launchScenario) {
        const auto=document.createElement('button');auto.type='button';auto.dataset.mix='auto';auto.className='mix-text';
        auto.setAttribute('aria-pressed',String(autoOpen));
        auto.textContent=autoOpen?'Auto-open next track: on':'Auto-open next track: off';
        root.querySelector('.mix-current')?.append(auto);
      }
      if (!data?.playlistDir && bridge.chooseFolder) {
        const connect=document.createElement('button');connect.type='button';connect.dataset.mix='folder';connect.textContent='Connect your stats folder';
        root.querySelector('.mix-current')?.append(connect);
      }
    }
    if (focus) [...root.querySelectorAll('[data-mix]')].find(el=>el.dataset.mix===focus && (el.dataset.value||null)===focusValue)?.focus({preventScroll:true});
  }
  root.addEventListener('change',event=>{if(event.target.dataset.mix==='band'&&!active){band=Number(event.target.value);remake();render();}});
  root.addEventListener('click',async event=>{
    const el=event.target.closest('[data-mix]'); if(!el||el.disabled)return;
    const action=el.dataset.mix;
    if (['mood','count','remix'].includes(action)&&!active) { if(action==='mood')mood=el.dataset.value;if(action==='count')count=Number(el.dataset.value);seed++;remake();render();animateMix(); }
    if(action==='start'&&!active&&tracks.length){active=engine.create(tracks,mood,band);message='Set started. Your score references are saved.';save();render();root.querySelector('[data-mix="launch"]')?.focus();}
    if(action==='skip'&&active)complete(engine.skip(active));
    // A set with nothing played is not a session worth a sleeve in the back catalogue.
    if(action==='end'&&active){if(active.tracks.some(t=>t.status==='played')){complete({...active,endedAt:Date.now()});message='';}else{active=null;selectedRecap=null;message='Set ended. Nothing was played, so it was not saved.';save();seed++;remake();render();}}
    if(action==='auto'){autoOpen=!autoOpen;try{localStorage.setItem(autoKey,autoOpen?'1':'0');}catch{}render();}
    if(action==='new'&&!active){selectedRecap=null;message='';seed++;remake();render();root.querySelector('[data-mix="start"]')?.focus();}
    if(action==='history'&&!active){selectedRecap=history.find(s=>s.id===el.dataset.value);render();root.querySelector('.mix-recap h2')?.focus({preventScroll:true});}
    if(action==='copy'&&selectedRecap){try{const s=selectedRecap,a=engine.summary(s);await navigator.clipboard.writeText(`Apogee Mixtape — ${names[s.mood]}\n${a.played}/${s.tracks.length} tracks played; ${a.improved}/${a.compared} above saved reference.\n`+s.tracks.map(t=>`${t.label}: ${t.status==='played'?number(t.score):t.status}`).join('\n'));message='Recap copied.';}catch{message='Clipboard unavailable. Your recap is still saved here.';}render();}
    if(action==='folder'&&bridge?.chooseFolder){el.disabled=true;try{const folder=await bridge.chooseFolder();if(folder){const latest=await bridge.practice?.();if(latest&&!latest.error)data=latest;message='Stats folder connected. Play the current track to continue.';}else message='Folder selection cancelled. Your set is still saved.';}catch{message='Could not connect the stats folder. Try again from the status menu.';}render();}
    if(action==='launch'&&active)await launchCurrent();
  });
  window.addEventListener('apogee:practice-ready',event=>{data=event.detail; if(!active)remake(); skipRetired(); render();});
  bridge?.onRun?.(record);
  remake(); skipRetired(); render();
})();
