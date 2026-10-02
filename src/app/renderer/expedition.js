/* Expedition presentation. Progress and rewards are settled by the main process. */
(() => {
  'use strict';
  const root = document.getElementById('expeditionRoot');
  if (!root) return;
  // Expedition onboarding must also be reachable before the first stats snapshot exists.
  const appRoot = document.getElementById('app');
  appRoot.before(root.parentElement);
  const bridge = window.apogee;
  let view = null, page = 'map', filter = 'all', listMode = false, busy = false;
  let previewSelected = null, previewBand = null, announced = new Set(), initialized = false;
  let renderContext = '';
  let renderPending = false;
  const resumeRender = () => { if (renderPending) render(); };
  window.addEventListener('focus', resumeRender);
  document.addEventListener('visibilitychange', resumeRender);
  // First view. The first outside playtest opened this screen to four difficulty cards, six
  // planets, two reward spotlights, a locked gate, three tabs and a difficulty select at
  // once, and the tester closed it without playing. Before joining, the screen is the chart
  // and one button, with the difficulties and a planet's detail shown only when asked for
  // (`showBands`, `picked`). The reward pitches and the last passage wait for a first clear.
  let showBands = false, picked = false;
  const newcomer = () => !Object.keys(view.state?.rewards || {}).some(id => id.endsWith(':clear'));
  // The loop is play in KovaaK's, come back, see the verdict. `awaiting` is the launch that
  // is waiting for a run; `signal` is the verdict on the last one that arrived.
  let awaiting = null, signal = null;
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // KovaaK's scores carry fractions no one reads; one decimal keeps 1,156.5 honest without noise.
  const number = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const percent = (score, target) => Math.floor(score / target * 100);
  const button = (text, action, data = '', disabled = false, primary = false) => `<button type="button" class="exp-button ${primary ? 'exp-primary' : ''}" data-exp-action="${action}" ${data} ${disabled ? 'disabled' : ''}>${text}</button>`;
  const label = kind => ({ discovery: 'Survey', steady: 'Steady set', score_attack: 'Score attack', circuit: 'Mixed circuit' }[kind] || kind);
  let messageTimer;
  const message = (text, temporary = false) => {
    clearTimeout(messageTimer);
    const area = document.getElementById('expeditionMessage'); area.replaceChildren();
    if (!text) return;
    const content = document.createElement('span'); content.textContent = text; area.append(content);
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss notification'); close.onclick = () => message(''); area.append(close);
    if (temporary) messageTimer = setTimeout(() => message(''), 9000);
  };
  const key = (d, b) => `${d}:${b}`;
  const has = id => !!view.state?.rewards[id];
  const destinationName = id => view.definition.destinations.find(d => d.id === id)?.name || 'First Light';
  const intel = name => view.intel?.[name];

  // What each discipline is for, in a sentence. The definition's own description is flavour.
  const disciplines = {
    'Static Clicking': 'Flick to still targets and stop on them.',
    'Dynamic Clicking': 'Click moving targets. Timing matters as much as speed.',
    'Precise Tracking': 'Stay on targets that move smoothly and predictably.',
    'Reactive Tracking': 'Stay on targets that change direction without warning.',
    'Speed Switching': 'Kill a target, then get to the next one fast.',
    'Evasive Switching': 'Switch between targets that dodge.',
  };
  const bandGuide = [
    { tag: 'Checkpoints save', miss: 'Retry a missed target as often as you like. Cleared targets stay cleared, even after closing the app.', best: 'are new to these scenarios, or want progress without pressure' },
    { tag: 'Warm-up first', miss: 'One short warm-up opens a three-round trial. A miss ends that attempt, but the warm-up stays done: try again straight away.', best: 'like a short goal before the real test' },
    { tag: 'One safety net', miss: 'Finish a warm-up here and every attempt gets one retry. Clearing without it earns a separate trophy.', best: 'want a real test with a little room for error' },
    { tag: 'Every run counts', miss: 'No warm-ups. A miss ends the attempt; try again any time.', best: 'want every run to count' },
  ];

  function art(kind, design = 0, color = '#8de8ff') {
    if (window.ApogeeCosmic) return window.ApogeeCosmic.art(kind, design, color);
    const n = design % 7;
    const ships = [
      'M50 8 64 48 88 73 61 66 50 86 39 66 12 73 36 48Z',
      'M50 9 61 37 86 27 76 69 57 62 50 88 43 62 24 69 14 27 39 37Z',
      'M50 9 66 42 93 56 71 76 50 64 29 76 7 56 34 42Z',
      'M50 8 60 45 81 20 88 81 60 70 50 86 40 70 12 81 19 20 40 45Z',
      'M50 10 71 38 91 65 65 60 72 87 50 75 28 87 35 60 9 65 29 38Z',
      'M50 5 60 36 83 48 73 78 58 68 50 90 42 68 27 78 17 48 40 36Z',
      'M50 5 63 33 94 26 78 55 85 87 58 70 50 92 42 70 15 87 22 55 6 26 37 33Z',
    ];
    let inner = '';
    if (kind === 'ship') inner = `<path d="${design < 0 ? 'M50 20 67 75 50 65 33 75Z' : ships[n]}" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="2"/><path d="M50 20 55 54 50 65 45 54Z" fill="currentColor"/><path d="M44 77 50 97 56 77" fill="currentColor" opacity=".55"/>`;
    else if (kind === 'banner') inner = `<path d="M10 18H90V85L50 70 10 85Z" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="2"/><path d="M${20 + n * 4} 18 70 73M15 30 84 61M20 58 80 30" stroke="currentColor" stroke-width="${2 + n}" opacity=".65"/><circle cx="50" cy="45" r="11" fill="currentColor"/>`;
    else if (kind === 'frame') inner = `<rect x="${12 + n}" y="${12 + n}" width="${76 - n * 2}" height="${76 - n * 2}" rx="${n * 4}" fill="none" stroke="currentColor" stroke-width="${2 + n % 3}"/><path d="M8 30V8H30M70 8H92V30M92 70V92H70M30 92H8V70" fill="none" stroke="currentColor" stroke-width="4"/><path d="M50 30 65 60H35Z" fill="currentColor" opacity=".6"/>`;
    else if (kind === 'title') inner = `<path d="M15 65 10 32 34 46 50 17 66 46 90 32 85 65ZM20 77H80" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="3"/><circle cx="50" cy="50" r="${6 + n}" fill="currentColor"/>`;
    else {
      const sides = 3 + n, points = Array.from({ length: sides }, (_, i) => {
        const a = (i / sides * 2 - .5) * Math.PI;
        return `${50 + Math.cos(a) * 35},${47 + Math.sin(a) * 35}`;
      }).join(' ');
      inner = `<polygon points="${points}" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="2"/><path d="M50 20 65 47 50 73 35 47Z" fill="currentColor" fill-opacity=".35"/><circle cx="50" cy="47" r="7" fill="currentColor"/>${kind === 'trophy' ? '<path d="M36 82 31 93H69L64 82" fill="currentColor"/>' : ''}`;
    }
    return `<svg class="exp-art" viewBox="0 0 100 100" style="color:${e(color)}" aria-hidden="true">${inner}</svg>`;
  }
  function selected() { return view.state?.selected || previewSelected || view.definition.destinations[0].id; }
  function band() { return view.state?.band ?? previewBand ?? view.recommendation?.band ?? 0; }
  function journey() { return view.state ? view.journey : { ...view.journeys?.[band()], cleared: 0, next: view.definition.destinations[0].id, ready: selected() !== 'final' && band() !== 1, checkpoints: 0, preparationReady: false }; }
  function activeTrial() { return view.state?.trials.find(t => t.status === 'active'); }
  function currentChallenge(route) { return route?.challenges.find(c => c.kind === route.selectedKind && !c.completedAt); }
  function roster(id, b) {
    const def = view.definition;
    return id === 'final' ? def.destinations.map(d => ({ ...d.bands[b][0], target: d.bands[b][0].finalTarget }))
      : def.destinations.find(d => d.id === id).bands[b];
  }
  const focusOf = name => view.definition.destinations.flatMap(d => [...d.bands, ...(d.pool || [])].flat()).find(s => s.name === name)?.focus || '';
  // How far away a target is, from the player's own best. Shown, never enforced.
  function readiness(name, target) {
    const i = intel(name);
    if (!i) return { tone: 'unknown', text: 'Not played yet' };
    const p = i.best / target;
    return p >= 1 ? { tone: 'met', text: 'Beaten before' } : p >= .9 ? { tone: 'close', text: 'Within reach' } : p >= .75 ? { tone: 'stretch', text: 'A stretch' } : { tone: 'far', text: 'Far off for now' };
  }
  function intelLine(name, target) {
    const i = intel(name);
    if (!i) return 'No runs on this scenario yet. Your first one sets the baseline.';
    const gap = target - i.best;
    return `Your best ${number(i.best)} (${percent(i.best, target)}% of target)${gap > 0 ? ` · ${number(gap)} to find` : ' · already beaten once'} · recent median ${number(i.median)} over ${Math.min(10, i.runs)} run${i.runs === 1 ? '' : 's'}`;
  }
  function trialRule(t) {
    return t?.mode === 'checkpoint' ? 'Miss? Retry the same target. Secured checkpoints stay, even if you stop for the day.'
      : t?.mode === 'prepared' ? (t.misses?.length ? 'No retries left: the next miss ends this attempt.' : 'One retry left. A miss uses it; a second miss ends this attempt.')
      : `${t && !t.mode ? 'Resumed legacy attempt. ' : ''}One run each, in order. A run under target, or on a trial scenario out of turn, ends the attempt.`;
  }
  const routeRule = kind => ({ steady: 'Only runs on this scenario matter, and one under target resets the streak.', score_attack: 'Only a run at or over the target counts. Misses cost nothing.', circuit: 'Each scenario stays done once met. Misses cost nothing.', discovery: 'Any finished run counts. No targets.' }[kind]);
  function routeEffect(id, b, ready, kind) {
    // Survey never counts toward the gate or the retry (engine.ts preparationReady).
    if (kind === 'discovery') return 'Optional: the Survey fragment. It does not open the trial.';
    if (b === 1 && !ready) return 'Completing it opens the trial here.';
    if (b === 2 && !journey().destinations?.[id]?.preparationReady) return 'Completing it gives every attempt here one retry. The trial is open unassisted meanwhile.';
    return 'Optional: an extra relic. The trial here is already open.';
  }
  function routeSummary(offer) {
    const step = offer.steps[0];
    if (offer.kind === 'score_attack') return `One run of ${number(step.target)}+ on ${step.scenario}`;
    if (offer.kind === 'steady') return `${number(step.target)}+ three runs in a row on ${step.scenario}`;
    if (offer.kind === 'circuit') return `Meet a target on three scenarios: ${offer.steps.map(s => s.scenario).join(', ')}`;
    return `One run each on ${offer.steps.map(s => s.scenario).join(', ')}`;
  }
  function rewardGoal(id, b) {
    const def = view.definition;
    if (!has(`${id}:ship`)) return { name: `${id === 'final' ? 'First Light' : destinationName(id)} ship` };
    if (!has(`${id}:${b}:clear`)) return { name: `${def.bands[b]} insignia` };
    return null;
  }

  // Every state of the campaign reduces to one next move: what to play, why, and the rule
  // that applies if it goes wrong. The deck, the lobby card and the focus target use it.
  function nextMove() {
    const { definition: def, state: s } = view, b = band(), id = selected(), j = journey();
    const active = activeTrial();
    if (!s) return { kind: 'enroll' };
    if (active) {
      const t = active, i = t.results.length, step = t.steps[i], final = t.destination === 'final';
      const where = destinationName(t.destination), goal = rewardGoal(t.destination, t.band);
      const unit = t.mode === 'checkpoint' ? 'Checkpoint' : 'Round';
      return { kind: 'trial', id: t.destination, band: t.band, trial: t, scenario: step.scenario, target: step.target,
        eyebrow: `${unit} ${i + 1} of ${t.steps.length} · ${where} · ${def.bands[t.band]}`,
        headline: `Score ${number(step.target)} on ${step.scenario}`,
        why: i + 1 === t.steps.length ? `Last one. Meet it and ${final ? 'the last passage is yours' : `${where} is cleared`}${goal ? `, with the ${goal.name}` : ''}.`
          : `${t.steps.length - i} to go at ${where}${goal ? `. Clear them all for the ${goal.name}` : ''}.`,
        rule: trialRule(t),
        path: t.steps.map((st, n) => ({ scenario: st.scenario, target: st.target, score: t.results[n]?.score, state: n < i ? 'done' : n === i ? 'current' : 'next' })),
        actions: button('Play in KovaaK’s ↗', 'launch', '', !view.canPlay || !bridge, true) + button(t.mode === 'checkpoint' ? 'Stop · keep checkpoints' : 'End attempt', 'abandon', '', !bridge) };
    }
    const route = s.routes[key(id, b)], c = id === 'final' ? null : currentChallenge(route);
    const cleared = has(`${id}:${b}:clear`), where = destinationName(id);
    if (c) {
      const pending = c.steps.find(st => (c.progress[st.scenario] || 0) < st.required) || c.steps[0];
      const done = c.steps.reduce((n, st) => n + Math.min(st.required, c.progress[st.scenario] || 0), 0), total = c.steps.reduce((n, st) => n + st.required, 0);
      const gate = b === 1 && !j.ready;
      return { kind: 'route', id, band: b, scenario: pending.scenario, target: pending.target,
        eyebrow: `${c.kind === 'discovery' ? 'Survey' : 'Warm-up'} · ${label(c.kind)} · ${where} · ${done}/${total}`,
        headline: pending.target === null ? `Play one run of ${pending.scenario}` : c.kind === 'steady' ? `Score ${number(pending.target)}+ on ${pending.scenario}, ${pending.required - (c.progress[pending.scenario] || 0)} more in a row` : `Score ${number(pending.target)} on ${pending.scenario}`,
        why: `${routeEffect(id, b, j.ready, c.kind)} Runs from ordinary training count too.`,
        rule: routeRule(c.kind),
        path: c.steps.flatMap(st => Array.from({ length: st.required }, (_, n) => ({ scenario: st.scenario, target: st.target, state: n < (c.progress[st.scenario] || 0) ? 'done' : st === pending && n === (c.progress[st.scenario] || 0) ? 'current' : 'next' }))),
        actions: button('Play in KovaaK’s ↗', 'launch', '', !view.canPlay || !bridge, true) + button(gate ? 'Set warm-up aside' : 'Back to the trial', 'pause-route', '', !bridge) };
    }
    if (id === 'final' && !j.ready && !cleared) {
      const left = def.destinations.length - j.cleared;
      return { kind: 'travel', id, band: b, eyebrow: `The last passage · ${def.bands[b]}`, headline: `${left} destination${left === 1 ? '' : 's'} to go`,
        why: `Clear all six destinations in ${def.bands[b]} to open the last passage: six rounds, one from each, for the First Light ship.`,
        path: def.destinations.map(d => ({ scenario: d.name, state: has(`${d.id}:${b}:clear`) ? 'done' : d.id === j.next ? 'current' : 'next' })),
        actions: button(`Fly to ${e(destinationName(j.next))} →`, 'select', `data-destination="${j.next}"`, !bridge, true) };
    }
    if (cleared) {
      const nextId = j.next, finished = has(`final:${b}:clear`);
      const higher = b + 1 < def.bands.length ? b + 1 : null;
      const actions = id !== 'final' && nextId !== id && !(nextId === 'final' && finished)
        ? button(nextId === 'final' ? 'Open the last passage →' : `Fly to ${e(destinationName(nextId))} →`, 'select', `data-destination="${nextId}"`, !bridge, true)
        : higher !== null ? button(`Try ${e(def.bands[higher])} →`, 'select', `data-destination="${def.destinations[0].id}" data-band="${higher}"`, !bridge, true)
        : button('Open your collection', 'page', 'data-page="collection"', false, true);
      return { kind: 'cleared', id, band: b, eyebrow: `Cleared · ${where} · ${def.bands[b]}`,
        headline: id === 'final' ? `First Light reached in ${def.bands[b]}` : `${where} is yours`,
        why: has(`${id}:${b}:mastery`) ? 'Cleared and mastered. Nothing left to earn here in this difficulty.'
          : id === 'final' ? 'Every destination and the last passage. Replay for mastery, or take the next difficulty.'
          : `${nextId === 'final' ? 'All six are clear: the last passage is open.' : `Next on the chart: ${destinationName(nextId)}.`} Mastery here is still open: beat every target by 10% in one clean attempt.`,
        actions };
    }
    const r = roster(id, b), goal = rewardGoal(id, b);
    if (!j.ready) {
      const offers = (view.offers || []).filter(o => o.kind !== 'discovery');
      return { kind: 'choose', id, band: b, eyebrow: `${where} · ${def.bands[b]}`, headline: 'Pick one warm-up to open the trial',
        why: `Any one of these opens the ${r.length}-round trial${goal ? ` for the ${goal.name}` : ''}. You never need more than one, and switching keeps progress.`,
        offers, rule: 'Warm-ups count runs from ordinary training too. Misses never undo them.' };
    }
    const count = b === 0 ? j.checkpoints : 0;
    const banked = b === 0 && count ? (s.trials.filter(t => t.destination === id && t.band === b && t.mode === 'checkpoint').sort((x, y) => y.results.length - x.results.length)[0]?.results || []) : [];
    const first = r[count] || r[0];
    const prepared = b === 2 && j.preparationReady;
    const startLabel = b === 0 ? count ? `Resume at checkpoint ${count + 1} ↗` : 'Start checkpoints ↗' : b === 2 ? prepared ? 'Start with one retry ↗' : 'Start unassisted ↗' : 'Start the trial ↗';
    const rule = b === 0 ? trialRule({ mode: 'checkpoint' }) : prepared ? trialRule({ mode: 'prepared', misses: [] }) : trialRule({ mode: 'strict' });
    return { kind: 'start', id, band: b, scenario: first.name, target: first.target,
      eyebrow: `${id === 'final' ? 'The last passage' : where} · ${def.bands[b]} · ${r.length} rounds`,
      headline: count ? `${count} of ${r.length} checkpoints secured. ${first.name} is next` : `Take on the ${id === 'final' ? 'last passage' : `${where} trial`}`,
      why: `${r.length} scenarios, in order${goal ? `, for the ${goal.name}` : ''}. Starting opens round ${count + 1} in KovaaK’s straight away.`,
      rule: b === 2 && !prepared ? `${rule} Unassisted clears earn the Unassisted trophy.` : rule,
      path: r.map((sc, n) => ({ scenario: sc.name, target: sc.target, score: banked[n]?.score, state: n < count ? 'done' : n === count ? 'current' : 'next' })),
      actions: button(startLabel, 'start', `data-approach="${prepared ? 'prepared' : 'direct'}" data-launch="1"`, !bridge || !view.canPlay, true)
        + (prepared ? button('Start unassisted ↗', 'start', 'data-approach="direct" data-launch="1"', !bridge || !view.canPlay) : '') };
  }

  function flightPath(path) {
    if (!path?.length) return '';
    return `<ol class="exp-flight" aria-label="Progress">${path.map((p, n) => `<li class="exp-flight-${p.state}"><b aria-hidden="true">${p.state === 'done' ? '✓' : n + 1}</b><span>${e(p.scenario)}</span>${p.score !== undefined ? `<small>${number(p.score)}${p.target ? ` / ${number(p.target)}` : ''}</small>` : p.target ? `<small>${number(p.target)}</small>` : ''}<i class="sr-only">${p.state === 'done' ? 'complete' : p.state === 'current' ? 'current' : 'upcoming'}</i></li>`).join('')}</ol>`;
  }
  function transmission() {
    if (!signal) return '';
    const s = signal, scale = 1.25, fill = s.target ? Math.min(100, s.score / s.target / scale * 100) : 100;
    const fresh = !s.shown; s.shown = true;
    return `<div class="exp-transmission exp-signal-${s.tone} ${fresh ? 'exp-transmission-new' : ''}" role="status"><div class="exp-transmission-head"><small>SIGNAL RECEIVED · ${e(new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}${s.more ? ` · +${s.more} more run${s.more === 1 ? '' : 's'}` : ''}</small><button type="button" class="exp-transmission-close" data-exp-action="dismiss-signal" aria-label="Dismiss result">×</button></div>
      <div class="exp-transmission-body"><div class="exp-transmission-score"><strong>${number(s.score)}</strong>${s.target ? `<span>of ${number(s.target)} · ${percent(s.score, s.target)}%</span>` : ''}</div><div><h4>${e(s.title)}</h4><p>${e(s.scenario)}. ${e(s.text)}</p></div></div>
      ${s.target ? `<div class="exp-gauge" aria-hidden="true"><i style="width:${fill}%"></i><b style="left:${100 / scale}%"></b></div>` : ''}</div>`;
  }
  function onboarding() {
    const def = view.definition, b = band(), rec = view.recommendation;
    const bands = showBands ? `<div class="exp-bands" role="radiogroup" aria-label="Difficulty">${def.bands.map((name, i) => {
        const f = view.fit?.[i], g = bandGuide[i] || bandGuide[0];
        return `<button type="button" role="radio" class="exp-band-card ${i === b ? 'selected' : ''}" data-exp-action="preview-band" data-band="${i}" aria-checked="${i === b}">${rec?.band === i ? '<em>SUGGESTED</em>' : ''}<small>${e(name)}</small><strong>${e(g.tag)}</strong><span>${e(g.miss)}</span><span class="exp-band-fit">${f?.played ? `Your bests meet ${f.met} of ${f.played} targets you have played` : 'Not played yet'}</span></button>`;
      }).join('')}</div>${rec ? `<p class="exp-rec">${e(rec.reason)}</p>` : ''}` : '';
    return `<section class="exp-objective exp-deck exp-onboard" style="--destination:#daf49a"><div class="exp-deck-main"><span class="exp-eyebrow">SOLO · SEPARATE FROM RANKED</span><h3>Six planets, one per aim category</h3>
      <p class="exp-deck-why">Beat three scenario targets at a planet to earn its ship.</p>
      <button type="button" class="exp-text-button" data-exp-action="toggle-bands" aria-expanded="${showBands}">Difficulty: ${e(def.bands[b])} · ${showBands ? 'done' : 'change'}</button>${bands}</div>
      <div class="exp-deck-side"><div class="exp-actions exp-main-action">${button(view.canPlay ? 'Start →' : 'Choose stats folder →', view.canPlay ? 'enroll' : 'folder', '', !bridge, true)}</div></div></section>`;
  }
  function deck() {
    if (!view.state) return onboarding();
    const m = nextMove(), color = view.definition.destinations.find(d => d.id === m.id)?.color || '#f9df83';
    const listening = awaiting && (m.kind === 'trial' || m.kind === 'route');
    let body = '';
    if (m.kind === 'choose') body = `<div class="exp-deck-choices">${m.offers.map(o => {
      const accepted = view.state.routes[key(m.id, m.band)]?.challenges.find(c => c.kind === o.kind);
      const progress = accepted ? accepted.steps.reduce((n, st) => n + Math.min(st.required, accepted.progress[st.scenario] || 0), 0) : 0;
      return `<button type="button" class="exp-deck-choice" data-exp-action="accept" data-kind="${o.kind}" ${!bridge ? 'disabled' : ''}><strong>${e(o.name)}${accepted ? ` · ${progress} done, resume` : ''}</strong><span>${e(routeSummary(o))}</span><small>${e(routeRule(o.kind))}</small></button>`;
    }).join('')}</div>`;
    const latest = (view.state.trials || []).filter(t => t.destination === m.id && t.band === m.band).at(-1);
    // The verdict card already says this when it is showing; this is the note that outlives it.
    const lastMiss = m.kind === 'start' && !signal && latest?.status === 'failed' ? (latest.misses?.at(-1) || latest.results.at(-1)) : null;
    const missStep = lastMiss && latest.steps[latest.results.filter(r => r.id !== lastMiss.id).length];
    return `<section class="exp-objective exp-deck exp-deck-${m.kind}" style="--destination:${e(color)}">${transmission()}
      <div class="exp-deck-main"><span class="exp-eyebrow">NEXT MOVE · ${e(m.eyebrow).toUpperCase()}</span><h3>${e(m.headline)}</h3><p class="exp-deck-why">${e(m.why)}</p>
        ${flightPath(m.path)}${body}
        ${m.scenario && m.target ? `<p class="exp-intel"><b>${e(readiness(m.scenario, m.target).text)}</b>${e(intelLine(m.scenario, m.target))}</p>` : ''}
        ${m.scenario && focusOf(m.scenario) ? `<p class="exp-cue">“${e(focusOf(m.scenario))}”</p>` : ''}
        ${lastMiss && missStep ? `<div class="exp-last-result failed"><strong>Last attempt ended · your destination progress is safe</strong><span>${e(lastMiss.scenario)}: ${number(lastMiss.score)} of ${number(missStep.target)} (${percent(lastMiss.score, missStep.target)}%).${lastMiss.scenario !== missStep.scenario ? ` Played out of turn; ${e(missStep.scenario)} was next.` : ` ${number(Math.max(0, missStep.target - lastMiss.score))} short.`}</span></div>` : ''}</div>
      <div class="exp-deck-side">${m.actions ? `<div class="exp-actions exp-main-action">${m.actions}</div>` : ''}
        ${listening ? `<p class="exp-uplink"><i aria-hidden="true"></i>Listening for your run on ${e(awaiting.scenario)}. Finish it in KovaaK’s; the result lands here.</p>` : ''}
        ${m.rule ? `<p class="exp-rule"><b>If you miss</b>${e(m.rule)}</p>` : ''}</div></section>`;
  }

  function rewardCard(r) {
    const owned = has(r.id), equipped = view.state?.equipped[r.kind] === r.id;
    const milestone = /^(runs|variety):(\d+)$/.exec(r.id);
    const progress = milestone ? Math.min(Number(milestone[2]), milestone[1] === 'runs' ? view.state?.runs.length || 0 : new Set((view.state?.runs || []).map(run => run.scenario)).size) : 0;
    return `<article class="exp-reward ${owned ? 'owned' : 'locked'}" data-reward-card="${e(r.id)}" tabindex="-1" style="--destination:${e(r.color)}">
      <div class="exp-reward-art">${art(r.kind, r.design, r.color)}<span>${equipped ? 'EQUIPPED' : owned ? 'EARNED' : 'LOCKED'}</span></div>
      <small>${e(r.kind)}</small><h3>${e(r.name)}</h3><p>${e(r.requirement)}</p>${milestone ? `<div class="exp-milestone"><span>${progress} / ${milestone[2]} ${milestone[1] === 'runs' ? 'runs' : 'scenarios'}</span><progress aria-label="${e(r.name)} progress" max="${milestone[2]}" value="${progress}"></progress></div>` : ''}
      ${['ship', 'frame', 'banner', 'title', 'insignia'].includes(r.kind) ? button(equipped ? 'Equipped' : owned ? 'Equip' : 'Earn to equip', 'equip', `data-reward="${e(r.id)}"`, !owned || equipped || !bridge) : ''}</article>`;
  }
  function header() {
    const { definition: def, state: s } = view, b = band();
    if (!s) return `<header class="exp-heading"><div><span class="exp-eyebrow">SOLO EXPEDITION</span><h1>First Light</h1></div></header>`;
    return `<header class="exp-heading"><div><span class="exp-eyebrow">SOLO EXPEDITION / 01</span><h1>First Light<span>Make your way out there.</span></h1></div>
      <div class="exp-heading-controls"><label>Difficulty<select id="expBand" aria-label="Expedition difficulty">${def.bands.map((name, i) => `<option value="${i}" ${i === b ? 'selected' : ''}>${e(name)}</option>`).join('')}</select></label><span class="exp-local">Saved on this device</span></div></header>
      <div class="exp-toolbar"><div class="exp-tabs" role="group" aria-label="Expedition views">${['map', 'collection', 'recap'].map(p => `<button data-exp-action="page" data-page="${p}" aria-pressed="${page === p}">${p === 'map' ? 'Star chart' : p === 'collection' ? `Collection · ${Object.keys(s?.rewards || {}).length}/${view.rewards.length}` : 'Session recap'}</button>`).join('')}</div><details class="exp-band-help"><summary>What changes with difficulty?</summary><p>How forgiving a miss is, and how high the targets are. You can start at any difficulty. Ships and profile rewards are earned once; each difficulty has its own insignias and trophies.</p></details></div>`;
  }
  function rewardSpotlight(id, kicker, explanation) {
    const reward = view.rewards.find(r => r.id === id);
    if (!reward) return '';
    return `<div class="exp-payoff" style="--destination:${e(reward.color)}"><div class="exp-payoff-art">${art(reward.kind, reward.design, reward.color)}</div><div><small>${e(kicker)}</small><strong>${e(reward.name)}</strong><p>${e(explanation)}</p><button class="exp-text-button" data-exp-action="reward" data-reward="${e(id)}">${has(id) ? 'View in your collection' : 'Preview reward'} →</button></div></div>`;
  }
  function routeChoices(id, b, route, ready) {
    const offers = (view.offers || []).filter(o => o.kind !== 'discovery');
    return `<section class="exp-choice-section" aria-label="Warm-ups"><div class="exp-choice-heading"><p>${e(routeEffect(id, b, ready))} You only ever need one. Runs from ordinary training count, and a warm-up keeps its target and progress if you set it aside.</p></div><div class="exp-choices">${offers.map(offer => {
      const accepted = route?.challenges.find(c => c.kind === offer.kind), active = accepted && !accepted.completedAt;
      const reward = view.rewards.find(r => r.id === offer.reward), required = offer.steps.reduce((n, step) => n + step.required, 0);
      return `<article class="exp-choice ${active && route.selectedKind === offer.kind ? 'selected' : ''}"><div class="exp-choice-art">${art('relic', reward.design, reward.color)}</div><div><span class="exp-choice-count">${required} qualifying run${required === 1 ? '' : 's'}${offer.kind === 'steady' ? ' · in a row' : ''}</span><h4>${e(offer.name)}</h4><p>${e(accepted?.completedAt ? 'Complete. Your relic and progress are saved.' : routeSummary(offer))}</p><small>${has(reward.id) ? 'Relic collected' : `Earns ${e(reward.name)}`}</small></div>${button(accepted?.completedAt ? 'Complete ✓' : active ? 'Resume' : 'Choose', 'accept', `data-kind="${offer.kind}"`, !bridge || !!accepted?.completedAt || active && route.selectedKind === offer.kind)}</article>`;
    }).join('')}</div></section>`;
  }
  // The selected destination: what it trains, what it asks, what it pays. The action lives
  // in the deck, so this panel answers "why here" rather than repeating "what next".
  function detail() {
    const { definition: def, state: s } = view, b = band(), id = selected(), j = journey();
    const d = def.destinations.find(d => d.id === id), final = id === 'final', route = s?.routes[key(id, b)];
    const active = activeTrial(), inTrial = active?.destination === id && active.band === b, cleared = has(`${id}:${b}:clear`);
    const localTrials = (s?.trials || []).filter(t => t.destination === id && t.band === b);
    const record = localTrials.filter(t => t.status === 'cleared').map(t => Math.min(...t.results.map((r, i) => r.score / t.steps[i].target)));
    const r = roster(id, b), done = inTrial ? active.results.length : 0;
    const status = has(`${id}:${b}:mastery`) ? '✦ Mastered' : cleared ? '✓ Cleared' : inTrial ? 'Attempt in progress' : final ? j.ready ? 'Open' : `${j.cleared} / 6 destinations cleared` : b === 1 && !j.ready ? 'Warm-up needed' : j.checkpoints ? `${j.checkpoints}/${r.length} checkpoints` : 'Trial open';
    const rows = r.map((sc, i) => {
      const target = inTrial ? active.steps[i].target : sc.target, ready = readiness(sc.name, target), result = inTrial ? active.results[i] : null, i2 = intel(sc.name);
      return `<li class="${i < done ? 'exp-step-done' : ''}"><span class="exp-step-number">${i < done ? '✓' : i + 1}</span><div><strong>${e(sc.name)}</strong><span>${result ? `Scored ${number(result.score)} · ` : ''}Target ${number(target)}${i2 ? ` · your best ${number(i2.best)} (${percent(i2.best, target)}%)` : ''}</span><p>${e(sc.focus)}</p></div><em class="exp-ready exp-ready-${ready.tone}">${e(ready.text)}</em></li>`;
    }).join('');
    const goalId = cleared ? has(`${id}:${b}:mastery`) ? `${id}:${b}:clear` : `${id}:${b}:mastery` : has(`${id}:ship`) ? `${id}:${b}:clear` : `${id}:ship`;
    const begin = () => button(b === 0 && !cleared ? 'Start checkpoints ↗' : 'Replay the trial ↗', 'start', 'data-approach="direct" data-launch="1"', !bridge || !view.canPlay || !!active);
    return `<aside class="exp-detail" style="--destination:${e(d?.color || '#f9df83')}"><span class="exp-eyebrow">${final ? 'THE LAST PASSAGE' : e(d.category)}</span><h2>${e(final ? 'Beyond the first light' : d.name)}</h2>
      <p class="exp-brief">${e(final ? 'One scenario from each planet, back to back.' : disciplines[d.category] || d.description)}</p>${final ? '' : `<p class="exp-flavour">${e(d.description)}</p>`}
      <div class="exp-brief-status"><span>${e(def.bands[b])}</span><b>${e(status)}</b>${record.length ? `<span>Best clear ${number(Math.max(...record) * 100)}% on the weakest round</span>` : ''}</div>
      ${active && !inTrial ? `<div class="exp-finale-ready"><p>Your attempt at ${e(destinationName(active.destination))} is still running. Finish or stop it to start one here.</p>${button('Back to that attempt', 'select', `data-destination="${active.destination}" data-band="${active.band}"`)}</div>` : ''}
      <div class="exp-roster-head"><small>THE TRIAL · ${r.length} ROUNDS, IN ORDER</small></div><ol class="exp-scenarios exp-roster">${rows}</ol>
      ${newcomer() ? '' : rewardSpotlight(goalId, cleared ? has(`${id}:${b}:mastery`) ? 'EARNED IN THIS DIFFICULTY' : 'STILL TO EARN · MASTERY' : 'CLEAR IT TO EARN', cleared ? has(`${id}:${b}:mastery`) ? 'Clear and mastery complete here.' : 'Beat every target by 10% in one attempt, with no misses and no carried checkpoints.' : has(`${id}:ship`) ? `Your ship from here is already collected. This clear earns the ${def.bands[b]} insignia.` : 'Plus its frame, banner and title. The ship flies on your star chart once equipped.')}
      ${cleared && has(`${id}:ship`) && s?.equipped.ship !== `${id}:ship` ? `<div class="exp-actions">${button('Equip earned ship', 'equip', `data-reward="${id}:ship"`, !bridge)}</div>` : ''}
      ${cleared && s?.equipped.insignia !== `${id}:${b}:clear` ? `<div class="exp-actions exp-equip-insignia">${button(`Wear ${e(def.bands[b])} insignia`, 'equip', `data-reward="${id}:${b}:clear"`, !bridge)}</div>` : ''}
      ${s && !final && !inTrial ? `<details class="exp-optional"><summary>Warm-ups${b === 1 && !j.ready ? ' · one opens the trial' : b === 2 && !j.preparationReady ? ' · one earns a retry' : ' · optional relics'}</summary>${routeChoices(id, b, route, j.ready)}</details>` : ''}
      ${s && !final && !inTrial ? `<details class="exp-optional"><summary>Survey · try three new scenarios</summary><p>No score targets: one run on each of three scenario families earns the Survey fragment. Never required.</p>${button(route?.challenges.find(c => c.kind === 'discovery')?.completedAt ? 'Survey complete ✓' : 'Survey three scenarios', 'accept', 'data-kind="discovery"', !bridge || !!route?.challenges.find(c => c.kind === 'discovery')?.completedAt)}</details>` : ''}
      ${b === 2 && final && j.ready && !j.preparationReady && !inTrial ? '<p class="exp-record">For a retry in the last passage, finish one warm-up at each of the six destinations. You can go in unassisted now.</p>' : ''}
      ${cleared && !inTrial ? `<details class="exp-optional"><summary>Replay for mastery or a better record</summary><p>Mastery needs 110% of every target in one attempt, with no misses. Your clear is permanent whatever happens.</p><div class="exp-actions">${begin()}${b === 2 && j.preparationReady ? button('Replay with one retry ↗', 'start', 'data-approach="prepared" data-launch="1"', !bridge || !view.canPlay || !!active) : ''}</div></details>` : ''}
      <details class="exp-optional"><summary>How ${e(def.bands[b])} works</summary><p>${e(j.rules)}</p><p>Unrelated scenarios never affect an attempt. Only runs finished after you start count.</p></details>
    </aside>`;
  }

  function map() {
    const { definition: def, state: s } = view, b = band(), j = journey();
    const ship = view.rewards.find(r => r.id === s?.equipped.ship), badge = view.rewards.find(r => r.id === s?.equipped.insignia);
    const finished = has(`final:${b}:clear`);
    return `${deck()}
      ${s ? `<section class="exp-journey" aria-label="Your expedition goal"><div class="exp-journey-copy"><span class="exp-eyebrow">${e(def.bands[b]).toUpperCase()} · ${e(bandGuide[b]?.tag || '').toUpperCase()}</span><h2>${e(j.title)}</h2><p>${e(j.description)}</p></div><div class="exp-journey-progress"><strong>${finished ? 'First Light conquered' : `${j.cleared} / 6 destinations`}</strong><span>${finished ? 'Your collection and records stay yours.' : j.cleared === 6 ? 'The last passage is open.' : 'All six open the last passage.'}</span><div class="exp-signals" role="group" aria-label="Destination progress">${def.destinations.map((d, i) => `<button data-exp-action="select" data-destination="${d.id}" aria-label="${e(d.name)}: ${has(`${d.id}:${b}:clear`) ? 'cleared' : 'not cleared'}" title="${e(d.name)}" class="${has(`${d.id}:${b}:clear`) ? 'lit' : ''}">${has(`${d.id}:${b}:clear`) ? '✓' : i + 1}</button>`).join('')}</div></div></section>` : ''}
      ${finished ? `<div class="exp-finish"><span aria-hidden="true">✦</span><div><small>${e(def.bands[b]).toUpperCase()} EXPEDITION COMPLETE</small><h2>Expedition complete</h2><p>Clears and rewards are permanent. Mastery and the other difficulties are still open.</p></div>${button('Visit your collection', 'page', 'data-page="collection"')}</div>` : ''}
      <div class="exp-layout ${!s && !picked ? 'exp-layout-solo' : ''}">${!s && !picked ? '' : detail()}<div class="exp-chart-panel"><div class="exp-chart-top"><span>STAR CHART · ANY DESTINATION, ANY ORDER</span><button class="exp-button" data-exp-action="layout" aria-pressed="${listMode}">${listMode ? 'Show star chart' : 'Show destination list'}</button></div>
        <div class="exp-map ${listMode ? 'exp-map-list' : ''}"><div class="exp-orbits" aria-hidden="true"><i></i><i></i><i></i></div>
          ${def.destinations.map((d, i) => {
            const progress = j.destinations?.[d.id];
            const status = has(`${d.id}:${b}:mastery`) ? '✦ Mastered' : has(`${d.id}:${b}:clear`) ? '✓ Cleared' : progress?.checkpoints ? `${progress.checkpoints}/3 checkpoints` : b === 0 ? 'Checkpoints open' : b === 1 && !progress?.ready ? 'Warm-up needed' : b === 2 && progress?.preparationReady ? 'Retry ready' : 'Trial open';
            return `<button class="exp-planet exp-planet-${i} ${selected() === d.id ? 'selected' : ''} ${has(`${d.id}:${b}:clear`) ? 'cleared' : ''}" data-exp-action="select" data-destination="${d.id}" aria-pressed="${selected() === d.id}" style="--destination:${e(d.color)}"><span class="exp-planet-body" aria-hidden="true"><i></i></span><span class="exp-planet-name">${e(d.name)}</span><span class="exp-planet-category">${e(d.category)}</span><span class="exp-planet-status">${status}</span>${j.next === d.id && !activeTrial() ? '<span class="exp-suggested">SUGGESTED NEXT</span>' : ''}</button>`;
          }).join('')}
          <div class="exp-map-ship">${art('ship', ship?.design ?? -1, ship?.color || '#d6e6ed')}<span>${e(ship?.name || 'Your starting ship')}${badge ? `<small class="exp-worn-insignia">${e(badge.name)}</small>` : ''}</span></div>
        </div>${newcomer() ? `<button class="exp-final-gate exp-final-dim ${selected() === 'final' ? 'selected' : ''}" data-exp-action="select" data-destination="final" aria-label="The last passage, locked"><span class="exp-final-symbol" aria-hidden="true">✦</span></button>` : `<button class="exp-final-gate ${selected() === 'final' ? 'selected' : ''}" data-exp-action="select" data-destination="final"><span class="exp-final-symbol" aria-hidden="true">✦</span><span><small>THE LAST PASSAGE</small><strong>Beyond the first light</strong><span>${j.cleared} / 6 destinations cleared</span></span><b>${finished ? 'CLEARED' : j.cleared === 6 ? 'OPEN' : 'LOCKED'} →</b></button>`}
        ${newcomer() ? '' : rewardSpotlight('final:ship', finished ? 'FIRST LIGHT COLLECTION' : 'THE WHOLE EXPEDITION EARNS', has('final:ship') ? 'Your First Light ship is collected. Each difficulty also has its own final insignia and mastery trophy.' : 'Clear all six destinations in one difficulty, then the last passage, for this ship and the First Light profile set.')}</div></div>`;
  }

  function collection() {
    const s = view.state, equipped = kind => view.rewards.find(r => r.id === s?.equipped[kind]);
    const ship = equipped('ship'), frame = equipped('frame'), banner = equipped('banner'), title = equipped('title');
    const count = Object.keys(s?.rewards || {}).length;
    const visible = view.rewards.filter(r => filter === 'all' || filter === 'earned' ? filter !== 'earned' || has(r.id) : r.kind === filter);
    return `<div class="exp-hangar"><div class="exp-hangar-ship">${art('ship', ship?.design ?? -1, ship?.color || '#8de8ff')}</div><div><span class="exp-eyebrow">YOUR HANGAR</span><h2>${e(ship?.name || 'Your first ship')}</h2><p>${count} of ${view.rewards.length} rewards earned.</p><div class="exp-equipped-summary">${['ship', 'frame', 'banner', 'title', 'insignia'].map(kind => `<span><small>${kind}</small>${e(equipped(kind)?.name || 'Default')}</span>`).join('')}</div></div>
      <div class="exp-profile-preview ${frame?.id === 'final:frame' ? 'exp-animated-frame' : ''}" style="--destination:${e(frame?.color || '#658493')};--profile-banner:${e(banner?.color || '#273846')}" data-design="${frame ? frame.design % 3 : 0}"><div class="exp-profile-banner">${banner ? art('banner', banner.design, banner.color) : ''}</div><div class="exp-profile-avatar">${art('ship', ship?.design || 0, ship?.color || '#8de8ff')}</div><strong>${e(title?.name || 'New explorer')}</strong><span>Your expedition identity</span></div></div>
      <div class="exp-filters" role="group" aria-label="Filter collection">${['all', 'earned', 'ship', 'relic', 'frame', 'banner', 'title', 'insignia', 'trophy'].map(f => `<button data-exp-action="filter" data-filter="${f}" aria-pressed="${filter === f}">${f === 'all' ? 'All rewards' : f}</button>`).join('')}</div>
      ${visible.length ? `<div class="exp-rewards">${visible.map(rewardCard).join('')}</div>` : '<div class="exp-empty"><h2>Your collection begins with one clear.</h2><p>Clear a destination to earn its ship, or finish a warm-up for a relic.</p></div>'}`;
  }
  function recap() {
    const s = view.state, since = view.sessionStartedAt;
    const runs = (s?.runs || []).filter(r => r.at >= since), trials = (s?.trials || []).filter(t => t.startedAt >= since || t.endedAt >= since);
    const earned = view.rewards.filter(r => (s?.rewards[r.id] || 0) >= since);
    const completed = Object.entries(s?.routes || {}).flatMap(([key, r]) => r.challenges.filter(c => c.completedAt >= since).map(c => ({ key, c })));
    const active = Object.entries(s?.routes || {}).flatMap(([key, r]) => r.challenges.filter(c => !c.completedAt).map(c => ({ key, c })));
    const checkpoints = (s?.trials || []).filter(t => t.mode === 'checkpoint').flatMap(t => t.results).filter(r => r.at >= since);
    const banked = new Set(checkpoints.map(r => r.id)).size;
    const gains = [...new Set(runs.map(r => r.scenario))].map(scenario => {
      const before = (s?.runs || []).filter(r => r.scenario === scenario && r.at < since).map(r => r.score);
      const best = Math.max(...runs.filter(r => r.scenario === scenario).map(r => r.score));
      return { scenario, previous: before.length ? Math.max(...before) : null, best };
    }).filter(g => g.previous !== null && g.best > g.previous).sort((a, b) => (b.best / (b.previous || 1)) - (a.best / (a.previous || 1))).slice(0, 4);
    return `<div class="exp-recap-hero"><span class="exp-eyebrow">SINCE YOU OPENED APOGEE</span><h2>This session</h2><div class="exp-stats"><span><b>${runs.length}</b>valid runs</span><span><b>${completed.length}</b>warm-ups finished</span><span><b>${trials.length}</b>trials attempted</span><span><b>${earned.length}</b>rewards earned</span></div></div>
      ${banked || gains.length ? `<div class="exp-session-progress"><h3>Session progress</h3>${banked ? `<p>${banked} new checkpoint${banked === 1 ? '' : 's'} secured this session.</p>` : ''}${gains.map(g => `<p><strong>${e(g.scenario)}</strong><span>${number(g.previous)} → ${number(g.best)} · new best in your expedition log</span></p>`).join('')}<small>Score comparisons use runs recorded since joining this expedition.</small></div>` : ''}
      <div class="exp-recap-columns"><div><h3>Warm-ups</h3>${completed.map(({ key: k, c }) => `<p class="exp-recap-entry">✓ ${e(destinationName(k.split(':')[0]))} / ${e(view.definition.bands[Number(k.split(':')[1])])} · ${label(c.kind)} complete</p>`).join('')}${active.map(({ key: k, c }) => `<p class="exp-recap-entry">${e(destinationName(k.split(':')[0]))} / ${e(view.definition.bands[Number(k.split(':')[1])])} · ${label(c.kind)}<span>${c.steps.reduce((n, step) => n + (c.progress[step.scenario] || 0), 0)} qualifying runs so far</span></p>`).join('') || '<p>Nothing completed this session.</p>'}</div><div><h3>Trial log & records</h3>${[...trials].reverse().map(t => {
        const prior = (s?.trials || []).filter(p => p.destination === t.destination && p.band === t.band && p.status === 'cleared' && p.startedAt < t.startedAt);
        const score = t.status === 'cleared' ? Math.min(...t.results.map((r, i) => r.score / t.steps[i].target)) : 0;
        const record = score && prior.every(p => Math.min(...p.results.map((r, i) => r.score / p.steps[i].target)) < score);
        const status = t.status === 'abandoned' && t.mode === 'checkpoint' ? (t.results.length ? 'Stopped · checkpoints saved' : 'Stopped') : { active: 'In progress', failed: 'Attempt ended · retry available', cleared: 'Cleared', abandoned: 'Attempt ended' }[t.status];
        return `<p class="exp-recap-entry">${e(destinationName(t.destination))} · ${e(view.definition.bands[t.band])}<span>${e(status)}${t.mode === 'prepared' ? ' · with retry support' : ''}${record ? ' · Personal trial record' : ''}${score ? ` · ${number(score * 100)}% minimum target` : ''}</span></p>`;
      }).join('') || '<p>No trials attempted this session.</p>'}</div></div>
      <h3>New in your collection</h3>${earned.length ? `<div class="exp-rewards">${earned.map(rewardCard).join('')}</div>` : '<p>No new rewards this session. Warm-ups and checkpoints stay saved.</p>'}<div class="exp-actions">${button('Back to the star chart →', 'page', 'data-page="map"', false, true)}</div>`;
  }
  function render() {
    if (!view) return;
    if (bridge && (document.hidden || !document.hasFocus())) { renderPending = true; return; }
    renderPending = false;
    const controlClass = el => String(el?.className || '').split(/\s+/).filter(c => !['selected','lit','owned','locked'].includes(c)).sort().join(' ');
    const focused = document.activeElement, focusId = focused?.id, focusedClass = controlClass(focused);
    const context = `${page}:${selected()}:${band()}`;
    const detailKey = el => `${el.className}:${el.querySelector(':scope > summary')?.textContent}:${el.closest('.exp-choice')?.querySelector('h4')?.textContent || ''}`;
    const open = context === renderContext ? new Set([...root.querySelectorAll('details[open]')].map(detailKey)) : new Set();
    const focusedDetail = focused?.tagName === 'SUMMARY' ? detailKey(focused.parentElement) : null;
    renderContext = context;
    const focusAction = focused?.dataset?.expAction;
    const focusData = focused?.dataset ? JSON.stringify({ ...focused.dataset }) : null;
    window.ApogeeCosmic?.beforeRender();
    root.innerHTML = header() + (view.error ? `<div class="exp-error" role="alert">${e(view.error)}</div>` : '') + (view.warning ? `<p class="exp-preview-note">${e(view.warning)}</p>` : '') + (!bridge ? '<p class="exp-preview-note">Design preview · campaign progress and game launching are available in the desktop app.</p>' : '') + (page === 'map' ? map() : page === 'collection' ? collection() : recap());
    if (view.state && !view.canPlay && bridge) root.querySelector('.exp-toolbar').insertAdjacentHTML('afterend', `<div class="exp-folder-needed"><div><strong>Reconnect your stats folder</strong><p>Your saved progress is safe. Choose your KovaaK’s stats folder to continue playing.</p></div>${button('Choose stats folder', 'folder')}</div>`);
    root.querySelectorAll('details').forEach(el => { el.open = open.has(detailKey(el)); });
    root.querySelectorAll('button, select').forEach(el => { if (busy) el.disabled = true; });
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    else if (focusAction) [...root.querySelectorAll('[data-exp-action]')].find(el => controlClass(el) === focusedClass && JSON.stringify({ ...el.dataset }) === focusData)?.focus({ preventScroll: true });
    else if (focusedDetail) [...root.querySelectorAll('details')].find(el => detailKey(el) === focusedDetail)?.querySelector('summary')?.focus({ preventScroll: true });
    window.ApogeeCosmic?.mount(root, { view, selected: selected(), page, listMode });
    const homeTitle = document.getElementById('expeditionHomeTitle'), homeDetail = document.getElementById('expeditionHomeDetail');
    const m = nextMove();
    if (homeTitle) homeTitle.textContent = !view.state ? 'First Light expedition' : m.kind === 'trial' ? `${destinationName(m.id)} · attempt in progress` : `${destinationName(m.id)} · ${view.definition.bands[m.band]}`;
    if (homeDetail) homeDetail.textContent = !view.state ? 'Solo. Six planets, one per aim category.'
      : m.kind === 'cleared' && !m.actions?.includes('data-destination') ? 'Rewards collected. Try mastery, beat your record, or explore another destination.'
      : m.kind === 'choose' ? 'Next: pick one warm-up to open the trial.'
      : `Next: ${m.headline}.`;
    const profile = document.getElementById('screen-profile');
    let identity = document.getElementById('expeditionIdentity');
    if (profile && Object.keys(view.state?.equipped || {}).length) {
      if (!identity) { identity = document.createElement('div'); identity.id = 'expeditionIdentity'; identity.className = 'exp-identity'; profile.prepend(identity); }
      const title = view.rewards.find(r => r.id === view.state.equipped.title), frame = view.rewards.find(r => r.id === view.state.equipped.frame), banner = view.rewards.find(r => r.id === view.state.equipped.banner), insignia = view.rewards.find(r => r.id === view.state.equipped.insignia);
      identity.style.setProperty('--destination', frame?.color || title?.color || '#8de8ff');
      identity.style.setProperty('--profile-banner', banner?.color || '#223544');
      identity.dataset.design = String(frame ? frame.design % 3 : 0);
      identity.classList.toggle('exp-animated-frame', frame?.id === 'final:frame');
      identity.innerHTML = `${art('frame', frame?.design || 0, frame?.color || title?.color)}<span><small>EXPEDITION TITLE</small><strong>${e(title?.name || 'New explorer')}</strong>${insignia ? `<small class="exp-worn-insignia">${e(insignia.name)}</small>` : ''}</span>${insignia ? art('insignia', insignia.design, insignia.color) : banner ? art('banner', banner.design, banner.color) : ''}`;
    }
  }

  /**
   * The verdict on runs that arrived between two views. Both states were settled by the
   * main process; this only reads what changed between them so it can be said out loud.
   */
  function interpret(prev, next) {
    if (!prev || !next) return null;
    const before = new Set(prev.runs.map(r => r.id)), fresh = next.runs.filter(r => !before.has(r.id));
    if (!fresh.length) return null;
    const more = n => Math.max(0, fresh.length - n);
    const base = run => ({ scenario: run.scenario, score: run.score, at: run.at });
    const priorTrial = prev.trials.find(t => t.status === 'active');
    const t = priorTrial && next.trials.find(x => x.id === priorTrial.id);
    if (t) {
      const subjects = new Set(t.steps.map(s => s.scenario)), relevant = fresh.filter(r => subjects.has(r.scenario) && r.at > t.startedAt);
      if (relevant.length) {
        const where = destinationName(t.destination), missCount = (t.misses?.length || 0) - (priorTrial.misses?.length || 0);
        if (t.status === 'cleared') {
          const run = t.results.at(-1);
          return { ...base(run), target: t.steps.at(-1).target, tone: 'clear', more: more(1), title: t.destination === 'final' ? 'First Light reached' : `${where} cleared`, text: 'Every target met. The clear and its rewards are saved for good.' };
        }
        if (t.status === 'failed') {
          const run = t.misses?.at(-1) || t.results.at(-1), step = t.steps[t.misses?.length ? t.results.length : t.results.length - 1];
          const wrong = run.scenario !== step.scenario;
          return { ...base(run), target: wrong ? null : step.target, tone: 'fail', more: more(1), title: 'Attempt over',
            text: `${wrong ? `Played out of turn: ${step.scenario} was next.` : `${number(step.target - run.score)} short.`} The destination stays open${t.band === 1 ? ' and its warm-up stays done' : ''}. Go again whenever you are ready.` };
        }
        if (t.results.length > priorTrial.results.length) {
          const run = t.results.at(-1), step = t.steps[t.results.length - 1], upcoming = t.steps[t.results.length];
          return { ...base(run), target: step.target, tone: 'pass', more: more(1), title: t.mode === 'checkpoint' ? `Checkpoint ${t.results.length} secured` : `Round ${t.results.length} cleared`,
            text: `${run.score > step.target ? `${number(run.score - step.target)} over. ` : ''}Next: ${upcoming.scenario}, target ${number(upcoming.target)}.` };
        }
        if (missCount > 0) {
          const run = t.misses.at(-1), step = t.steps[t.results.length];
          return { ...base(run), target: step.target, tone: 'miss', more: more(1), title: t.mode === 'prepared' ? 'Retry used' : 'Not this time',
            text: t.mode === 'prepared' ? `${number(step.target - run.score)} short. You are still in: the next miss ends the attempt.` : `${number(step.target - run.score)} short. Same target, as many tries as you need${t.results.length ? `; ${t.results.length} checkpoint${t.results.length === 1 ? '' : 's'} safe` : ''}.` };
        }
        const run = relevant.at(-1);
        return { ...base(run), target: null, tone: 'info', more: more(1), title: 'Not the current target', text: `Checkpoints only count the next target in order: ${t.steps[t.results.length].scenario}.` };
      }
    }
    for (const [routeKey, route] of Object.entries(next.routes)) for (const c of route.challenges) {
      const old = prev.routes[routeKey]?.challenges.find(o => o.kind === c.kind);
      if (!old || old.completedAt) continue;
      const relevant = fresh.filter(r => c.steps.some(s => s.scenario === r.scenario) && r.at > c.acceptedAt);
      if (!relevant.length) continue;
      const run = relevant.at(-1), step = c.steps.find(s => s.scenario === run.scenario), [id, b] = routeKey.split(':');
      const count = progress => c.steps.reduce((n, st) => n + Math.min(st.required, progress[st.scenario] || 0), 0);
      const total = c.steps.reduce((n, st) => n + st.required, 0), now = count(c.progress), was = count(old.progress);
      if (c.completedAt)
        return { ...base(run), target: step.target, tone: 'clear', more: more(1), title: `${label(c.kind)} complete`, text: `${c.kind === 'discovery' ? '' : Number(b) === 1 ? `The trial at ${destinationName(id)} is open.` : Number(b) === 2 ? `Every attempt at ${destinationName(id)} now gets one retry.` : ''} Its relic is in your collection.`.trim() };
      if (now > was) return { ...base(run), target: step.target, tone: 'pass', more: more(1), title: `${label(c.kind)} · ${now} of ${total}`, text: `${total - now} to go.` };
      if (now < was) return { ...base(run), target: step.target, tone: 'miss', more: more(1), title: 'Streak reset', text: `${number(step.target - run.score)} short. Three in a row, starting again now.` };
      if (step.target !== null && run.score >= step.target) return { ...base(run), target: step.target, tone: 'pass', more: more(1), title: `${label(c.kind)} · ${now} of ${total}`, text: 'Already counted for this scenario.' };
      if (step.target !== null && c.kind === 'steady') return { ...base(run), target: step.target, tone: 'miss', more: more(1), title: 'Not yet', text: `${number(step.target - run.score)} short. The streak starts from zero.` };
      if (step.target !== null) return { ...base(run), target: step.target, tone: 'miss', more: more(1), title: 'Not yet', text: `${number(step.target - run.score)} short. Misses cost nothing here.` };
    }
    // Practice on the selected destination's own scenarios still says how close it was.
    const id = next.selected, b = next.band;
    if (id !== 'final') {
      const rows = roster(id, b), run = [...fresh].reverse().find(r => rows.some(s => s.name === r.scenario));
      if (run) {
        const step = rows.find(s => s.name === run.scenario);
        return { ...base(run), target: step.target, tone: 'info', more: more(1), title: 'Practice logged', text: `${run.score >= step.target ? 'That would have met the trial target.' : `${number(step.target - run.score)} short of the trial target.`} It counts once you start the trial.` };
      }
    }
    return null;
  }

  function receive(next, initial = false) {
    const previous = view?.state;
    view = next;
    const ids = Object.keys(view.state?.rewards || {});
    if (!initial && initialized) {
      const verdict = interpret(previous, view.state);
      if (verdict) { signal = verdict; awaiting = null; }
      const added = ids.filter(id => !announced.has(id));
      if (added.length) { window.ApogeeCosmic?.celebrate(view, added); message(`Earned: ${added.slice(0, 2).map(id => view.rewards.find(r => r.id === id)?.name || id).join(' · ')}${added.length > 2 ? ` · +${added.length - 2} more in your collection` : ''}`, true); root.classList.remove('exp-celebrate'); void root.offsetWidth; root.classList.add('exp-celebrate'); }
      if (verdict && typeof window.playSound === 'function' && !added.length) window.playSound(['pass', 'clear'].includes(verdict.tone) ? 'ok' : 'run');
    }
    initialized = true; announced = new Set(ids); render();
  }
  function showNextStep(moveFocus = false) {
    const target = root.querySelector('.exp-objective');
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    if (moveFocus) {
      const heading = target?.querySelector('h3');
      heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true });
    }
  }
  async function send(action) {
    const result = await bridge.expeditionAction(action);
    if (result.view) receive(result.view);
    if (result.error) { message(result.error); return false; }
    return true;
  }
  async function act(action) {
    if (!bridge || busy) return;
    // Busy controls cannot receive focus during intermediate renders. Restore the
    // originating selector only after the final render enables them again.
    const origin = document.activeElement;
    const focusSelector = origin?.matches('.exp-planet') ? '.exp-planet' : origin?.closest('.exp-signals') ? '.exp-signals button' : null;
    const focusDestination = origin?.dataset?.destination;
    const focusId = origin?.id, priorBand = band();
    busy = true; render(); message('');
    // A verdict belongs to the activity it judged; a new activity or difficulty retires it.
    if (['launch', 'start', 'accept', 'abandon'].includes(action.type) || action.type === 'select' && action.band !== band()) signal = null;
    try {
      // Starting and launching were two clicks with nothing to decide between them.
      const ok = await send(action);
      if (ok && (action.type === 'launch' || action.launch && view.canPlay)) {
        const launched = action.type === 'launch' || await send({ type: 'launch' });
        const m = nextMove();
        if (launched) awaiting = { scenario: m.scenario || '', at: Date.now() };
      }
      if (action.type === 'abandon' || action.type === 'select' && action.band !== priorBand) awaiting = null;
    } catch (err) { message(`The action could not finish: ${err.message || err}`); }
    finally { busy = false; render();
      if (action.type === 'select') {
        const control = focusSelector ? [...root.querySelectorAll(focusSelector)].find(el => el.dataset.destination === focusDestination) : focusId ? document.getElementById(focusId) : null;
        control?.focus({preventScroll:true});
      }
      if (page === 'map' && ['enroll', 'accept', 'start', 'pause-route', 'abandon'].includes(action.type)) showNextStep(true); }
  }
  root.addEventListener('click', event => {
    const target = event.target.closest('[data-exp-action]');
    if (!target || busy) return;
    const a = target.dataset.expAction;
    if (a === 'page') { page = target.dataset.page; render(); document.querySelector('.scroll')?.scrollTo({ top: 0, behavior: 'instant' }); return; }
    if (a === 'filter') { filter = target.dataset.filter; render(); return; }
    if (a === 'layout') { listMode = !listMode; render(); return; }
    if (a === 'toggle-bands') { showBands = !showBands; render(); return; }
    if (a === 'select') picked = true;
    if (a === 'dismiss-signal') { signal = null; render(); root.querySelector('.exp-objective h3')?.focus?.({ preventScroll: true }); return; }
    if (a === 'preview-band') { previewBand = Number(target.dataset.band); render(); root.querySelector(`.exp-band-card[data-band="${previewBand}"]`)?.focus({ preventScroll: true }); return; }
    if (a === 'reward') {
      const reward = view.rewards.find(r => r.id === target.dataset.reward);
      if (!reward) return;
      page = 'collection'; filter = reward.kind; render();
      const card = [...root.querySelectorAll('[data-reward-card]')].find(el => el.dataset.rewardCard === reward.id);
      card?.focus({ preventScroll: true }); card?.scrollIntoView({ block: 'center', behavior: 'instant' }); return;
    }
    if (a === 'folder') { bridge?.chooseFolder().then(() => bridge.expedition()).then(v => receive(v)).catch(err => message(String(err))); return; }
    if (a === 'select' && !view.state) { previewSelected = target.dataset.destination; render(); return; }
    if (a === 'enroll') { void act({ type: a, destination: selected(), band: band() }); return; }
    void act({ type: a, destination: target.dataset.destination || selected(), band: target.dataset.band === undefined ? band() : Number(target.dataset.band), reward: target.dataset.reward, kind: target.dataset.kind, approach: target.dataset.approach, launch: target.dataset.launch === '1' });
  });
  root.addEventListener('keydown', event => {
    // Arrow keys move between difficulty cards, as a radio group should.
    const card = event.target.closest?.('.exp-band-card');
    if (!card || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const count = view.definition.bands.length, step = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
    previewBand = (Number(card.dataset.band) + step + count) % count; render();
    root.querySelector(`.exp-band-card[data-band="${previewBand}"]`)?.focus({ preventScroll: true });
  });
  root.addEventListener('change', event => {
    if (event.target.id !== 'expBand') return;
    if (!view.state) { previewBand = Number(event.target.value); render(); }
    else void act({ type: 'select', destination: selected(), band: Number(event.target.value) });
  });
  if (bridge?.expedition) {
    bridge.onExpedition(v => receive(v));
    bridge.expedition().then(v => receive(v, true)).catch(err => { root.textContent = 'The expedition could not load.'; message(String(err)); });
  } else if (window.__APOGEE_EXPEDITION__) receive(window.__APOGEE_EXPEDITION__, true);
  else root.innerHTML = '<p class="exp-empty">Rebuild the design preview to include the expedition.</p>';
})();
