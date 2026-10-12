/* A starting point for practice; scores and rank targets come from the core. */
(() => {
  const root = document.getElementById('practiceHome');
  if (!root) return;
  document.getElementById('app').before(root.parentElement);
  const prefs = window.ApogeePracticePrefs;
  let data = typeof practice !== 'undefined' ? practice : null;
  let session = window.ApogeePracticeSession || null;
  let loadError = '';
  const e = esc;
  function pool() { return data?.scenarios || []; }
  function windows() { return data?.season?.windows || window.__APOGEE_SEASON__?.windows || ['Novice','Intermediate','Advanced','Expert']; }
  function selectedBand() { return prefs.band(windows(), typeof current !== 'undefined' ? current?.benchmark?.difficulty || current?.benchmark?.matchPool?.window : null); }
  const route = (name, label, cls = '') => `<button type="button" class="${cls}" data-home-route="${name}">${label}</button>`;
  function render() {
    const focus = root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const band = selectedBand(), rows = pool().filter(r => r.window === band);
    const favorites = pool().filter(r => prefs.state.favorites.includes(r.scenario));
    const played = rows.filter(r => r.runs > 0);
    const near = rows.filter(r => Number.isFinite(r.best) && Number.isFinite(r.nextRankScore) && r.nextRankScore > r.best)
      .sort((a,b) => (a.nextRankScore-a.best)/a.nextRankScore - (b.nextRankScore-b.best)/b.nextRankScore).slice(0,3);
    const suggested = near.length ? near : rows.slice(0,3);
    root.innerHTML = `<header class="practice-heading"><div><span class="practice-kicker">PRACTICE / KOVAAK’S</span><h1>What are we playing?</h1><p>A short set, a specific drill, or a match. Pick up where you left off.</p></div><label class="practice-level">Practice difficulty<select id="homeDifficulty">${windows().map((name,i)=>`<option value="${i}" ${i===band?'selected':''}>${e(name)}</option>`).join('')}</select><small>Used for new practice sessions.</small></label></header>
      ${session ? `<section class="practice-continue"><div><span class="practice-kicker">SESSION IN PROGRESS</span><h2>${e(session.label)}</h2><p>Track ${session.index+1} of ${session.total} · ${e(session.difficulty)}</p></div>${route('mixtape','Resume session →','practice-primary')}</section>` : ''}
      <div class="practice-choices"><section class="practice-start"><span class="practice-kicker">YOUR NEXT SET</span><h2>Less setup.<br>More practice.</h2><p>Pick ${prefs.state.count} scenarios at ${e(windows()[band])}. Choose a focus, swap a drill, then play one run per scenario.</p>${route('mixtape',session?'View current session →':'Build a practice session →','practice-primary')}<div class="practice-start-foot"><span>Solo · no sign-in needed</span><span>Scores tracked locally</span></div></section>
      <div class="practice-options"><button type="button" data-home-route="scenarios"><span class="practice-option-icon" aria-hidden="true">⌕</span><span><strong>Find a scenario</strong><small>Search, filter, and save your favorites.</small></span><b aria-hidden="true">→</b></button><button type="button" data-home-route="ghost"><span class="practice-option-icon" aria-hidden="true">◎</span><span><strong>Race a ghost</strong><small>Play against a saved performance.</small></span><b aria-hidden="true">→</b></button><button type="button" data-home-route="expedition"><span class="practice-option-icon" aria-hidden="true">✦</span><span><strong>Play Expedition</strong><small>Solo challenges with places to explore.</small></span><b aria-hidden="true">→</b></button><button type="button" data-home-route="queue"><span class="practice-option-icon" aria-hidden="true">⚑</span><span><strong>Queue ranked 1v1</strong><small>Three rounds against another player.</small></span><b aria-hidden="true">→</b></button></div></div>
      <div class="practice-lower"><section class="practice-drills"><div class="practice-section-title"><div><span class="practice-kicker">${e(windows()[band]).toUpperCase()}</span><h2>${near.length?'Within reach':'Try a scenario'}</h2></div><button type="button" data-home-library="band">Browse difficulty →</button></div><p>${near.length?'Your smallest gaps to the next scenario rank.':'Start with a run to establish your score.'} ${played.length} of ${rows.length} scenarios played at this difficulty.</p><div id="homeDrills">${suggested.map((r,i)=>`<article class="practice-drill"><span class="practice-drill-number">0${i+1}</span><div><small>${e(r.category)}</small><h3>${e(r.label || r.scenario)}</h3><p>${r.best != null ? 'Best '+pts(r.best) : 'No recorded best'}${r.nextRankScore != null ? ' · next target '+tgt(r.nextRankScore) : ' · all ranks reached'}</p></div><div class="practice-drill-actions" data-home-actions="${i}"></div></article>`).join('') || `<div class="practice-no-data"><strong>Your practice starts here.</strong><p>${window.apogee?'Connect your KovaaK’s stats folder to see your scores and scenario targets.':'The preview has no practice scores loaded.'}</p>${window.apogee?'<button type="button" id="homeConnect">Connect stats folder</button>':''}${route('mixtape','Browse a practice session')}</div>`}</div></section>
      <section class="practice-saved"><span class="practice-kicker">SAVED ON THIS MACHINE</span><h2>Your favorites <span>${favorites.length}</span></h2>${favorites.length?`<ul>${favorites.slice(0,4).map(r=>`<li><button type="button" data-home-scenario="${e(r.scenario)}"><strong>${e(r.label || r.scenario)}</strong><small>${e(r.category)} · ${e(r.windowName)}</small></button></li>`).join('')}</ul><button type="button" data-home-library="favorites">View all favorites →</button>`:'<p>Save a scenario with ☆ in the library. Your regular drills will be one click away.</p><button type="button" data-home-route="scenarios">Find a favorite →</button>'}<div class="practice-help"><strong>New to Apogee?</strong><p>Keep it open while you play in KovaaK’s. Your finished runs update your scores here.</p><button type="button" id="homeShortcuts">Keyboard shortcuts</button></div></section></div>`;
    if (loadError) root.insertAdjacentHTML('afterbegin', '<section class="practice-connect" role="status"><div><strong>Practice could not refresh</strong><p>' + e(loadError) + '</p></div><button type="button" id="homeRetry">Try again</button></section>');
    if (window.apogee && !data?.playlistDir) {
      root.insertAdjacentHTML('afterbegin', '<section class="practice-connect"><div><strong>Connect your scores</strong><p>Choose your KovaaK’s stats folder once. You can browse drills now; finished runs can be tracked after connecting.</p></div><button type="button" data-home-connect>Connect stats folder</button></section>');
      root.querySelector('.practice-start-foot span:last-child').textContent = 'Connect stats to track scores';
    }
    suggested.forEach((row,i) => {
      const actions = root.querySelector(`[data-home-actions="${i}"]`);
      actions.append(favoriteButton(row.scenario));
      const play = playButton(row.scenario);
      if (play) actions.append(play);
      else {
        const view = document.createElement('button'); view.type='button'; view.textContent='View';
        view.dataset.homeScenario=row.scenario; actions.append(view);
      }
    });
    const controls = [...root.querySelectorAll('button,select')];
    controls.forEach(el => { el.dataset.focusKey = el.id || el.dataset.homeScenario || el.dataset.homeLibrary || el.dataset.homeRoute || (el.closest('[data-home-actions]')?.dataset.homeActions + ':' + el.className) || el.textContent; });
    if (focus) controls.find(el => el.dataset.focusKey === focus)?.focus({preventScroll:true});
    const chip = document.getElementById('practiceResume');
    chip.hidden = !session;
    if (session) { chip.textContent = `Resume · ${session.index+1}/${session.total}`; chip.title = session.label; }
  }
  root.addEventListener('change', event => {
    if (event.target.id === 'homeDifficulty') prefs.set({ difficulty: windows()[Number(event.target.value)] });
  });
  root.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.homeRoute) openScreen(button.dataset.homeRoute);
    if (button.dataset.homeScenario) browseScenarios({query:button.dataset.homeScenario});
    if (button.dataset.homeLibrary === 'band') browseScenarios({window:selectedBand()});
    if (button.dataset.homeLibrary === 'favorites') browseScenarios({status:'favorites'});
    if (button.id === 'homeConnect' || button.hasAttribute('data-home-connect')) document.getElementById('btnChoose')?.click();
    if (button.id === 'homeShortcuts') document.getElementById('practiceShortcuts').showModal();
    if (button.id === 'homeRetry') { button.disabled=true; button.textContent='Loading…'; refreshPractice(); }
  });
  document.getElementById('practiceResume').addEventListener('click', () => openScreen('mixtape'));
  const help = document.createElement('dialog'); help.id='practiceShortcuts'; help.className='practice-shortcuts';
  help.setAttribute('aria-labelledby','practiceShortcutsTitle');
  help.innerHTML='<form method="dialog"><header><h2 id="practiceShortcutsTitle">Keyboard shortcuts</h2><button aria-label="Close keyboard shortcuts">Close</button></header><dl><dt>Ctrl / ⌘ K</dt><dd>Find a screen or scenario</dd><dt>/</dt><dd>Search the scenario library</dd><dt>1–9</dt><dd>Open the numbered screen</dd><dt>↑ ↓</dt><dd>Move through the navigation</dd><dt>M</dt><dd>Mute or unmute sound</dd><dt>Esc</dt><dd>Close a dialog or menu</dd></dl><p>Shortcuts stay out of the way while you type.</p></form>';
  document.body.append(help);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || document.querySelector('dialog[open]') || !document.getElementById('celebrate').hidden) return;
    if (event.key === '/') { event.preventDefault(); openScreen('scenarios'); document.getElementById('scSearch')?.focus(); }
    if (event.key === '?') { event.preventDefault(); help.showModal(); }
  });
  window.addEventListener('apogee:practice-ready', event => { data=event.detail; loadError=''; render(); });
  window.addEventListener('apogee:practice-error', event => { loadError=String(event.detail); render(); });
  window.addEventListener('apogee:practice-preferences', render);
  window.addEventListener('apogee:practice-session', event => { session=event.detail; render(); });
  new MutationObserver(() => { if (document.body.dataset.screen === 'home') render(); }).observe(document.body,{attributes:true,attributeFilter:['data-screen']});
  render();
})();
