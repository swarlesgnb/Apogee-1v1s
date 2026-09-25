/* Mixtape: saved, local sessions built from the real season pool. */
(() => {
  const root = document.getElementById('mixtapeRoot');
  if (!root) return;
  document.getElementById('app').before(root.parentElement);
  const engine = globalThis.ApogeeMixtape, bridge = window.apogee;
  const key = 'apogee.mixtape.v1';
  const e = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = n => Number(n).toLocaleString(undefined,{maximumFractionDigits:1});
  const signed = n => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${number(Math.abs(n))}`;
  const names = {balance:'Full spectrum',push:'Close the gap',discover:'Side quests'};
  const descriptions = {balance:'One of each discipline. A warm-up, or a check-up on everything at once.',push:'The scenarios where your best sits closest to the next threshold. Your likeliest rank-ups.',discover:'Your least-played scenarios. Widen the base the rest is built on.'};
  const captions = {balance:'One of each discipline',push:'Closest to a threshold',discover:'Least played first'};
  let data = typeof practice !== 'undefined' ? practice : window.__APOGEE_PRACTICE__;
  if (!data && window.__APOGEE_SEASON__) {
    const season=window.__APOGEE_SEASON__;
    data={season,scenarios:season.scenarios.map(r=>({...r,best:null,last:null,runs:0,nextRankScore:null}))};
  }
  let mood = 'balance', band = 0, count = 6, seed = Date.now(), tracks = [], active = null, history = [], selectedRecap = null;
  let busy = false, storageError = '', message = '';
  // The loop is: open a track, play it in KovaaK's, see how it landed. `awaiting` is the
  // track opened and not yet played; `signal` is the verdict on the run that just arrived.
  let awaiting = null, signal = null;
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
      // Sets saved before tracks carried best and threshold kept them as reference and
      // target; left undefined they pass every !== null test and render as NaN.
      const upgrade=s=>{for (const t of s.tracks) { t.best??=t.referenceLabel==='Personal best'?t.reference:null; t.threshold??=t.target??null; t.thresholdIndex??=null; } return s;};
      if (active) upgrade(active); history.forEach(upgrade);
      if (active) { mood=active.mood; band=active.band; count=[3,6,9].find(n=>n>=active.tracks.length); }
    }
  } catch { storageError = 'Saved sessions could not be read. You can still make a new mix.'; }
  const windows = () => data?.season?.windows?.length ? data.season.windows : ['Novice','Intermediate','Advanced','Expert'];
  const button = (label, action, attrs='', disabled=false) => `<button type="button" data-mix="${action}" ${attrs} ${disabled?'disabled':''}>${label}</button>`;
  const canLaunch = () => !!bridge?.launchScenario;
  // Threshold indices run across every window, as the season's rank names do.
  const rankName = t => (t.thresholdIndex !== null && t.thresholdIndex !== undefined && data?.season?.categories?.find(c=>c.name===t.category)?.rankNames?.[t.thresholdIndex]) || 'the next threshold';
  const percent = (score, of) => Math.round(score / of * 100);
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
    const s=active; if(!s||!canLaunch()||busy) return;
    const current=s.tracks[s.index];
    busy=true;message='';render();
    try{const result=await bridge.launchScenario(current.scenario);
      if(result?.error) message=/not in this match or this season/.test(result.error)?'This scenario left the season pool. Skip it to continue.':result.error;
      else awaiting=current.scenario;}
    catch{message='Could not open KovaaK’s. You can open the named scenario manually; tracking still works.';}
    finally{busy=false;render();}
  }
  function complete(next) {
    if (next.endedAt) { history=[next,...history.filter(s=>s.id!==next.id)].slice(0,12); active=null; selectedRecap=next; signal=null; awaiting=null; completionBurst=next.tracks.every(t=>t.status==='played'); }
    else active=next;
    save(); render();
    if (next.endedAt) root.querySelector('.mix-recap h2')?.focus({preventScroll:true});
  }
  // Why a track is in this set, in the mood's own terms, from what was frozen at planning.
  function reason(t, m) {
    if (m === 'push') return t.threshold === null ? 'Nothing left above your best here in this difficulty.'
      : t.best === null ? `No best yet; ${rankName(t)} starts at ${number(t.threshold)}.`
      : `${number(t.threshold - t.best)} from ${rankName(t)}. Your best is ${percent(t.best,t.threshold)}% of the way.`;
    if (m === 'discover') return t.runs ? `Played ${t.runs} time${t.runs===1?'':'s'}. Widens your base.` : 'Never played. A fresh look.';
    return t.best === null ? 'New to you. Your first run sets the reference.' : `Best ${number(t.best)}${t.threshold!==null?` · ${number(t.threshold-t.best)} to ${rankName(t)}`:''}.`;
  }
  /** How a run landed against what its track froze. Display only; nothing is awarded. */
  function judge(track, played) {
    const ref=track.reference, refName=(track.referenceLabel||'').toLowerCase(), cleared=track.threshold!==null&&played.score>=track.threshold;
    const base={scenario:track.label,score:played.score,reference:ref,referenceLabel:track.referenceLabel,at:Date.now()};
    if (played.pb) return {...base,tone:'clear',title:cleared?`New best, and past ${rankName(track)}`:'New personal best',text:track.best!==null?`${signed(played.score-track.best)} on your previous best of ${number(track.best)}.`:'Your first best on this scenario.'};
    if (cleared) return {...base,tone:'clear',title:`Past ${rankName(track)}`,text:`Scored over the ${number(track.threshold)} threshold on this run.`};
    if (ref===null) return {...base,tone:'info',title:'Reference set',text:'Your first recorded run here. Next time, this is the score to beat.'};
    const delta=played.score-ref;
    if (delta>=0) return {...base,tone:'pass',title:`Up on your ${refName}`,text:`${signed(delta)} (${percent(played.score,ref)}% of ${number(ref)}).`};
    return {...base,tone:'miss',title:`Under your ${refName}`,text:`${signed(delta)} (${percent(played.score,ref)}%). One run is noise; the set is about the rhythm.`};
  }
  function record(run) {
    if (!active) return;
    const i=active.index, track=active.tracks[i];
    const next=engine.receive(active,run);
    if (!next) {
      // A later track played early does not count: say so instead of silently ignoring it.
      const later=active.tracks.findIndex((t,n)=>n>i&&t.status==='pending'&&t.scenario===run?.scenario);
      if (later>=0 && Date.parse(run.playedAt)>=active.armedAt) { signal={tone:'info',scenario:active.tracks[later].label,score:run.score,reference:null,at:Date.now(),title:`That was track ${later+1}`,text:`The set plays in order, so it did not count. ${track.label} is up; skip to move on.`}; render(); }
      return;
    }
    signal=judge(track,next.tracks[i]); awaiting=null; message='';
    complete(next);
    skipRetired();
    // With auto-open on, the next track opens itself: one tab switch per track was the
    // friction between a set and the rhythm it is meant to have.
    if (autoOpen && active && !active.endedAt) void launchCurrent();
    if (typeof window.playSound==='function') window.playSound(['clear','pass'].includes(signal?.tone)?'ok':'run');
  }
  function trackLine(t) {
    if (t.status==='played') {
      const vs=t.reference!==null?` · ${signed(t.score-t.reference)} vs ${e(t.referenceLabel.toLowerCase())}`:' · first reference';
      return `Recorded ${number(t.score)}${vs}${t.pb?' · <b class="mix-pb">PB</b>':''}${t.threshold!==null&&t.score>=t.threshold&&!t.pb?' · threshold met':''}`;
    }
    if (t.status==='skipped') return 'Skipped · no run counted';
    return `${e(t.referenceLabel)}${t.reference!==null?' · '+number(t.reference):''}${t.target!==null?' · next threshold '+number(t.target):''}`;
  }
  function trackList(list, current=-1, why=null) {
    return `<ol class="mix-tracklist">${list.map((t,i)=>`<li class="mix-track ${i===current?'is-current':''} ${t.status}" style="--track-order:${i}"><span class="mix-track-number">${t.status==='played'?'✓':t.status==='skipped'?'−':String(i+1).padStart(2,'0')}</span><div><small>${e(t.category)}</small><strong>${e(t.label)}</strong><span>${trackLine(t)}</span>${why&&t.status==='pending'?`<em class="mix-why">${e(reason(t,why))}</em>`:''}</div>${i===current?`<b class="mix-now">${awaiting===t.scenario?'LISTENING':'UP NEXT'}</b>`:''}</li>`).join('')}</ol>`;
  }
  function verdict() {
    if (!signal) return '';
    const s=signal, scale=1.25, fresh=!s.shown; s.shown=true;
    const fill=s.reference?Math.min(100,s.score/s.reference/scale*100):100;
    const next=active&&!active.endedAt?active.tracks[active.index]:null;
    return `<div class="mix-signal mix-signal-${s.tone} ${fresh?'mix-signal-new':''}" role="status"><div class="mix-signal-head"><small>RUN RECEIVED · ${e(new Date(s.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</small>${button('×','dismiss','class="mix-signal-close" aria-label="Dismiss result"')}</div>
      <div class="mix-signal-body"><div class="mix-signal-score"><strong>${number(s.score)}</strong>${s.reference!==null?`<span>${e(s.referenceLabel)} ${number(s.reference)}</span>`:''}</div><div><h3>${e(s.title)}</h3><p>${e(s.scenario)}. ${e(s.text)}</p></div></div>
      ${s.reference?`<div class="mix-gauge" aria-hidden="true"><i style="width:${fill}%"></i><b style="left:${100/scale}%"></b></div>`:''}
      ${next?`<p class="mix-signal-next">Up next: <b>${e(next.label)}</b>${autoOpen&&canLaunch()?' · opening in KovaaK’s':''}</p>`:''}</div>`;
  }
  function recap(s) {
    const stats=engine.summary(s);
    const played=s.tracks.filter(t=>t.status==='played'&&t.reference);
    const standout=played.sort((a,b)=>b.score/b.reference-a.score/a.reference)[0];
    const highlight=stats.bests?`${stats.bests} new personal best${stats.bests===1?'':'s'}: ${s.tracks.filter(t=>t.pb).map(t=>t.label).join(', ')}.`
      : standout&&standout.score>standout.reference?`Standout: ${standout.label}, ${signed(standout.score-standout.reference)} on its ${standout.referenceLabel.toLowerCase()}.`
      : stats.compared?'No track beat its reference this time. The same set again is the fairest rematch.':'Every played track now has a reference to beat next time.';
    return `<section class="mix-recap"><div class="mix-eyebrow">SESSION SLEEVE / ${e(new Date(s.startedAt).toLocaleDateString())}</div><h2 tabindex="-1">${stats.played===s.tracks.length?'That’s a wrap.':'Your set, saved.'}</h2><p>${e(names[s.mood])} · ${e(windows()[s.band])} · local run results</p>
      <div class="mix-recap-stats"><div><strong>${stats.played}<small>/${s.tracks.length}</small></strong><span>tracks played</span></div>${stats.compared?`<div><strong>${stats.improved}<small>/${stats.compared}</small></strong><span>above their reference</span></div>`:`<div><strong>${stats.played}</strong><span>references set</span></div>`}<div><strong>${stats.bests}</strong><span>personal bests</span></div><div><strong>${stats.categories}</strong><span>disciplines played</span></div></div>
      <p class="mix-highlight">${e(highlight)}</p>${stats.skipped?`<p>${stats.skipped} skipped. Skips never count as played.</p>`:''}${trackList(s.tracks)}
      <div class="mix-actions">${button(canLaunch()?'Run it back ↗':'Run it back','again','class="mix-primary"',!!active||!engine.replay(data?.scenarios,s).length)}${button('Make another mix','new')}${button('Copy recap','copy')}</div><p class="mix-footnote">Run it back plays the same tracks in the same order against your latest scores. References were frozen when this set started. These local results do not award rating or XP.</p></section>`;
  }
  function builder() {
    const disciplines=new Set(tracks.map(t=>t.category)).size, near=tracks.filter(t=>t.threshold!==null&&t.best!==null&&t.best/t.threshold>=.95).length;
    const start=label=>button(label,'start','class="mix-primary"',!tracks.length);
    const startLabel=canLaunch()?'Start · open track 1 ↗':'Start mix ↗';
    return `<div class="mix-console-top"><h2>What are you feeling?</h2>${start(startLabel)}</div>
      <ol class="mix-how"><li><b>1</b>Pick a mood and length</li><li><b>2</b>Start: track 1 opens in KovaaK’s</li><li><b>3</b>One run per track; Apogee follows along</li></ol>
      <div class="mix-moods" aria-label="Session mood">${Object.entries(names).map(([id,name],i)=>button(`<span>0${i+1}</span><strong>${name}</strong><small>${captions[id]}</small>`,'mood',`data-value="${id}" aria-pressed="${mood===id}" class="mix-mood"`)).join('')}</div>
      <p class="mix-mood-note">${e(descriptions[mood])}</p>
      <div class="mix-controls"><label>Difficulty<select data-mix="band">${windows().map((w,i)=>`<option value="${i}" ${band===i?'selected':''}>${e(w)}</option>`).join('')}</select></label><fieldset><legend>Set length</legend>${[3,6,9].map(n=>button(String(n)+' tracks','count',`data-value="${n}" aria-pressed="${count===n}"`)).join('')}</fieldset></div>
      <div class="mix-track-heading"><h3>Your tracklist <span>${tracks.length} scenario${tracks.length===1?'':'s'} · ${disciplines} discipline${disciplines===1?'':'s'}${near?` · ${near} within 5% of a threshold`:''}</span></h3>${button('↻ Remix','remix','',!tracks.length)}</div>
      ${tracks.length?trackList(tracks,-1,mood):'<p class="mix-empty">No scenarios are available in this band yet. Try another difficulty or load a season.</p>'}
      <div class="mix-actions">${start(startLabel)}<span>One run per track.<br>No timer. No pressure.</span></div>`;
  }
  function playing() {
    const current=active.tracks[active.index], stats=engine.summary(active);
    const chips=[current.reference!==null?`<span><small>TO BEAT · ${e(current.referenceLabel.toUpperCase())}</small><b>${number(current.reference)}</b></span>`:'<span><small>TO BEAT</small><b>First look</b></span>',
      current.best!==null&&current.referenceLabel!=='Personal best'?`<span><small>YOUR BEST</small><b>${number(current.best)}</b></span>`:'',
      current.threshold!==null?`<span><small>${e(rankName(current).toUpperCase())}</small><b>${number(current.threshold)}</b></span>`:''].join('');
    const listening=awaiting===current.scenario;
    return `<div class="mix-console-top"><span class="mix-eyebrow">TRACK ${active.index+1} OF ${active.tracks.length} · ${e(names[active.mood].toUpperCase())}</span>${button('End set','end','class="mix-text"')}</div><progress max="${active.tracks.length}" value="${active.index}" aria-label="Tracks completed or skipped"></progress>
      <p class="mix-tally">${stats.played} played${stats.compared?` · ${stats.improved} above reference`:''}${stats.bests?` · ${stats.bests} PB${stats.bests===1?'':'s'}`:''}${stats.skipped?` · ${stats.skipped} skipped`:''}</p>
      ${verdict()}
      <div class="mix-current"><small>${e(current.category)}</small><h2>${e(current.label)}</h2><div class="mix-chips">${chips}</div><p class="mix-reason">${e(reason(current,active.mood))}</p>
        <div class="mix-actions">${button(busy?'Opening…':listening?'Open again ↗':'Open in KovaaK’s ↗','launch','class="mix-primary"',busy||!canLaunch())}${button('Skip track','skip','',busy)}</div>
        ${listening?`<p class="mix-listening"><i aria-hidden="true"></i>Listening for your run on ${e(current.label)}. Play it in KovaaK’s; the result lands here.</p>`:''}
        ${bridge?.onRun&&canLaunch()?`<div class="mix-auto">${button(`<i aria-hidden="true"></i>Auto-open next track: ${autoOpen?'on':'off'}`,'auto',`aria-pressed="${autoOpen}" class="mix-switch"`)}<span>After each run, the next scenario opens in KovaaK’s by itself.</span></div>`:''}
        <p class="mix-footnote">${bridge?.onRun?'The next matching run advances the set by itself; opening a scenario alone does not complete it. Keep Apogee open while playing: runs played while it is closed are not added.':'This preview lets you build a set. Launching and automatic run tracking need the desktop app.'}</p>
        ${bridge?.onRun&&!data?.playlistDir&&bridge.chooseFolder?button('Connect your stats folder','folder'):''}</div>${trackList(active.tracks,active.index,active.mood)}`;
  }
  function render() {
    cancelMotion();
    const focus = root.contains(document.activeElement) ? document.activeElement?.getAttribute('data-mix') : null;
    const focusValue = document.activeElement?.getAttribute('data-value');
    root.dataset.mood=mood;
    const isPlaying=!!active;
    root.innerHTML=`<header class="mix-heading"><div><div class="mix-eyebrow">PERSONAL PRACTICE / ON YOUR TERMS</div><h1>Mixtape<span>Find your next groove.</span></h1></div><span class="mix-local">${bridge?.onRun?'LOCAL RUN TRACKING':'DESIGN PREVIEW · TRACKING NEEDS DESKTOP'}</span></header>
      <div class="mix-message" role="status">${e(storageError || message)}</div>
      ${selectedRecap ? recap(selectedRecap) : `<div class="mix-workspace"><section class="mix-sleeve ${isPlaying?'is-playing':''}" aria-label="${e(names[mood])} session cover"><div class="mix-sleeve-top"><span>APOGEE SELECTS</span><span>VOL. ${String(band+1).padStart(2,'0')}</span></div><div class="mix-record" aria-hidden="true"><div class="mix-record-label"><svg viewBox="0 0 100 100"><path d="M20 74 50 16 80 74 50 56Z M35 62 50 35 65 62"/></svg><span>${String(isPlaying?active.index+1:tracks.length).padStart(2,'0')}</span></div></div><div class="mix-sleeve-title"><small>${isPlaying?'NOW IN SESSION':e(windows()[band])+' / '+tracks.length+' TRACKS'}</small><h2>${e(names[mood])}</h2><p>${e(descriptions[mood])}</p></div><div class="mix-sleeve-bottom"><span>${isPlaying?'ONE RUN. THEN THE NEXT.':'BUILT FROM YOUR SEASON POOL'}</span><div class="mix-bars" aria-hidden="true">${'<i></i>'.repeat(14)}</div></div></section>
      <section class="mix-console" aria-label="${isPlaying?'Session in progress':'Session builder'}">${isPlaying?playing():builder()}</section></div>`}
      <section class="mix-history"><div><span class="mix-eyebrow">YOUR BACK CATALOGUE</span><h2>Sessions worth keeping.</h2><p>Up to 12 recent sets, saved on this machine. Open one to see it again or run it back.</p></div><div class="mix-history-cards">${history.length?history.map(s=>{const a=engine.summary(s);return button(`<small>${e(new Date(s.startedAt).toLocaleDateString())}</small><strong>${e(names[s.mood])}</strong><span>${a.played}/${s.tracks.length} played · ${a.improved} above reference${a.bests?` · ${a.bests} PB${a.bests===1?'':'s'}`:''}</span>`,'history',`data-value="${e(s.id)}" class="mix-history-card" ${active?'disabled':''}`)}).join(''):'<div class="mix-history-empty"><span aria-hidden="true">◎</span>Your first sleeve goes here.<br>Finish a set to start your collection.</div>'}</div></section>`;
    if(completionBurst && !reduced.matches) {
      const burst=document.createElement('div');burst.className='mix-burst';burst.setAttribute('aria-hidden','true');
      for(let i=0;i<16;i++){const particle=document.createElement('i');particle.style.setProperty('--burst-angle',`${i*22.5}deg`);particle.style.setProperty('--burst-distance',`${70+i%3*24}px`);burst.append(particle);}
      root.querySelector('.mix-recap')?.append(burst);
    }
    completionBurst=false;
    if (focus) [...root.querySelectorAll('[data-mix]')].find(el=>el.dataset.mix===focus && (el.dataset.value||null)===focusValue)?.focus({preventScroll:true});
  }
  async function begin(list) {
    active=engine.create(list,mood,band); selectedRecap=null; signal=null; awaiting=null;
    message=canLaunch()?'':'Set started. Your score references are saved.'; save(); render();
    root.querySelector('[data-mix="launch"]')?.focus();
    // Starting and opening track 1 were two clicks with nothing to decide between them.
    if (canLaunch()) { await launchCurrent(); root.querySelector('[data-mix="launch"]')?.focus(); }
  }
  root.addEventListener('change',event=>{if(event.target.dataset.mix==='band'&&!active){band=Number(event.target.value);remake();render();}});
  root.addEventListener('click',async event=>{
    const el=event.target.closest('[data-mix]'); if(!el||el.disabled)return;
    const action=el.dataset.mix;
    if (['mood','count','remix'].includes(action)&&!active) { if(action==='mood')mood=el.dataset.value;if(action==='count')count=Number(el.dataset.value);seed++;remake();render();animateMix(); }
    if(action==='start'&&!active&&tracks.length) await begin(tracks);
    if(action==='again'&&!active&&selectedRecap){const s=selectedRecap,list=engine.replay(data?.scenarios,s);if(list.length){mood=s.mood;band=s.band;count=[3,6,9].find(n=>n>=list.length);await begin(list);}}
    if(action==='dismiss'){signal=null;render();root.querySelector('[data-mix="launch"]')?.focus();}
    if(action==='skip'&&active){signal=null;awaiting=null;complete(engine.skip(active));}
    // A set with nothing played is not a session worth a sleeve in the back catalogue.
    if(action==='end'&&active){awaiting=null;signal=null;if(active.tracks.some(t=>t.status==='played')){complete({...active,endedAt:Date.now()});message='';}else{active=null;selectedRecap=null;message='Set ended. Nothing was played, so it was not saved.';save();seed++;remake();render();}}
    if(action==='auto'){autoOpen=!autoOpen;try{localStorage.setItem(autoKey,autoOpen?'1':'0');}catch{}render();}
    if(action==='new'&&!active){selectedRecap=null;message='';seed++;remake();render();root.querySelector('[data-mix="start"]')?.focus();}
    if(action==='history'&&!active){selectedRecap=history.find(s=>s.id===el.dataset.value);render();root.querySelector('.mix-recap h2')?.focus({preventScroll:true});}
    if(action==='copy'&&selectedRecap){try{const s=selectedRecap,a=engine.summary(s);await navigator.clipboard.writeText(`Apogee Mixtape — ${names[s.mood]}\n${a.played}/${s.tracks.length} tracks played; ${a.improved}/${a.compared} above saved reference; ${a.bests} personal best${a.bests===1?'':'s'}.\n`+s.tracks.map(t=>`${t.label}: ${t.status==='played'?number(t.score)+(t.pb?' (PB)':''):t.status}`).join('\n'));message='Recap copied.';}catch{message='Clipboard unavailable. Your recap is still saved here.';}render();}
    if(action==='folder'&&bridge?.chooseFolder){el.disabled=true;try{const folder=await bridge.chooseFolder();if(folder){const latest=await bridge.practice?.();if(latest&&!latest.error)data=latest;message='Stats folder connected. Play the current track to continue.';}else message='Folder selection cancelled. Your set is still saved.';}catch{message='Could not connect the stats folder. Try again from the status menu.';}render();}
    if(action==='launch'&&active){signal=null;await launchCurrent();}
  });
  window.addEventListener('apogee:practice-ready',event=>{data=event.detail; if(!active)remake(); skipRetired(); render();});
  bridge?.onRun?.(record);
  remake(); skipRetired(); render();
})();
