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
  let previewSelected = null, previewBand = 0, announced = new Set(), initialized = false;
  let renderContext = '';
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });
  const button = (text, action, data = '', disabled = false, primary = false) => `<button type="button" class="exp-button ${primary ? 'exp-primary' : ''}" data-exp-action="${action}" ${data} ${disabled ? 'disabled' : ''}>${text}</button>`;
  const label = kind => ({ discovery: 'Discovery', steady: 'Steady set', score_attack: 'Score attack', circuit: 'Mixed circuit' }[kind] || kind);
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
  const done = (d, b) => {
    if (view.state?.rewards[`${d}:${b}:clear`]) return 3;
    if (view.journey?.destinations[d]?.ready) return 2;
    const challenges = view.state?.routes[key(d, b)]?.challenges || [];
    return challenges.some(c => c.kind !== 'discovery' && c.completedAt) ? 2 : challenges.some(c => c.kind === 'discovery' && c.completedAt) ? 1 : 0;
  };
  const has = id => !!view.state?.rewards[id];
  const destinationName = id => view.definition.destinations.find(d => d.id === id)?.name || 'First Light';
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
  function band() { return view.state?.band ?? previewBand; }
  function journey() { return view.state ? view.journey : { ...view.journeys?.[band()], cleared: 0, next: view.definition.destinations[0].id, ready: selected() !== 'final' && band() !== 1, checkpoints: 0, preparationReady: false }; }
  function trialRule(t) {
    return t?.mode === 'checkpoint' ? 'Successful steps stay saved. Retry the current target after a miss.'
      : t?.mode === 'prepared' ? `${Math.max(0, 1 - (t.misses?.length || 0))} retry remaining. A miss uses your retry; a second miss ends this attempt.`
      : `${t && !t.mode ? 'Resumed legacy attempt: ' : ''}Meet every target in order. A miss or an out-of-order trial scenario ends this attempt.`;
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
    return `<header class="exp-heading"><div><span class="exp-eyebrow">SOLO EXPEDITION / 01</span><h1>First Light<span>Make your way out there.</span></h1></div>
      <div class="exp-heading-controls"><label>Difficulty<select id="expBand" aria-label="Expedition difficulty">${def.bands.map((name, i) => `<option value="${i}" ${i === b ? 'selected' : ''}>${e(name)}</option>`).join('')}</select></label><span class="exp-local">Saved on this device</span></div></header>
      <div class="exp-toolbar"><div class="exp-tabs" role="group" aria-label="Expedition views">${['map', 'collection', 'recap'].map(p => `<button data-exp-action="page" data-page="${p}" aria-pressed="${page === p}">${p === 'map' ? 'Star chart' : p === 'collection' ? `Collection · ${Object.keys(s?.rewards || {}).length}/${view.rewards.length}` : 'Session recap'}</button>`).join('')}</div><details class="exp-band-help"><summary>Why choose a difficulty?</summary><p>Start at the band that suits your aim. Lower bands are never required. Each band has its own clear insignias and mastery trophies. Ships, frames, banners, titles, and relics are shared: earn each once, in any band.</p></details></div>`;
  }
  function currentChallenge(route) { return route?.challenges.find(c => c.kind === route.selectedKind && !c.completedAt); }
  function rewardSpotlight(id, kicker, explanation) {
    const reward = view.rewards.find(r => r.id === id);
    if (!reward) return '';
    return `<div class="exp-payoff" style="--destination:${e(reward.color)}"><div class="exp-payoff-art">${art(reward.kind, reward.design, reward.color)}</div><div><small>${e(kicker)}</small><strong>${e(reward.name)}</strong><p>${e(explanation)}</p><button class="exp-text-button" data-exp-action="reward" data-reward="${e(id)}">${has(id) ? 'View in your collection' : 'Preview reward'} →</button></div></div>`;
  }
  function routeChoices(id, b, route, ready) {
    const offers = (view.offers || []).filter(o => o.kind !== 'discovery');
    const preparation = b === 2 && !journey().preparationReady;
    return `<section class="exp-choice-section" aria-label="Choose your route"><div class="exp-choice-heading"><span class="exp-eyebrow">${preparation ? 'OPTIONAL PREPARATION' : ready ? 'OPTIONAL COLLECTION' : 'PICK ONE ROUTE'}</span><h3>${preparation ? 'Earn an extra retry' : ready ? 'Optional challenges' : 'Choose a challenge'}</h3><p>${preparation ? 'Any one route permanently unlocks one retry per attempt at this destination.' : ready ? 'Your trial is open. These challenges add relics to your collection.' : 'Complete any one route to open the finale. You never have to clear all three.'}</p></div><div class="exp-choices">${offers.map(offer => {
      const accepted = route?.challenges.find(c => c.kind === offer.kind), active = accepted && !accepted.completedAt;
      const reward = view.rewards.find(r => r.id === offer.reward), required = offer.steps.reduce((n, step) => n + step.required, 0);
      const purpose = accepted?.completedAt ? 'Complete. Your reward and progress are saved.' : offer.purpose;
      return `<article class="exp-choice ${active && route.selectedKind === offer.kind ? 'selected' : ''}"><div class="exp-choice-art">${art('relic', reward.design, reward.color)}</div><div><span class="exp-choice-count">${required} ${required === 1 ? 'qualifying run' : 'qualifying runs'}${offer.kind === 'steady' ? ' · consecutive' : ''}</span><h4>${e(offer.name)}</h4><p>${e(purpose)}</p><details class="exp-choice-targets"><summary>Preview targets</summary><div class="exp-choice-scenarios">${offer.steps.map(step => `<span>${e(step.scenario)} <b>≥ ${number(step.target)}</b></span>`).join('')}</div></details><small>${has(reward.id) ? 'Relic collected' : `Earn ${e(reward.name)}`}</small></div>${button(accepted?.completedAt ? 'Complete ✓' : active ? 'Resume route' : 'Choose route', 'accept', `data-kind="${offer.kind}"`, !bridge || !!accepted?.completedAt || active && route.selectedKind === offer.kind)}</article>`;
    }).join('')}</div></section>`;
  }
  function detail() {
    const { definition: def, state: s } = view, b = band(), id = selected(), j = journey();
    const d = def.destinations.find(d => d.id === id), final = id === 'final', route = s?.routes[key(id, b)];
    const challenge = currentChallenge(route), active = s?.trials.find(t => t.status === 'active');
    const inTrial = active?.destination === id && active.band === b, cleared = has(`${id}:${b}:clear`);
    const localTrials = (s?.trials || []).filter(t => t.destination === id && t.band === b), latest = localTrials.at(-1);
    const ready = j.ready, canAct = !!bridge && view.canPlay && !active;
    const roster = final ? def.destinations.map(d => ({ ...d.bands[b][0], target: d.bands[b][0].finalTarget })) : d.bands[b];
    const offer = view.offers?.find(o => o.kind === challenge?.kind);
    const count = inTrial ? active.results.length : b === 0 ? j.checkpoints : 0;
    const goalId = cleared ? has(`${id}:${b}:mastery`) ? `${id}:${b}:clear` : `${id}:${b}:mastery` : has(`${id}:ship`) ? `${id}:${b}:clear` : `${id}:ship`;
    const nextId = j.next;
    const begin = (primary = true) => button(b === 0 ? cleared ? 'Replay for mastery →' : count ? 'Resume checkpoints →' : 'Start checkpoints →' : b === 2 ? 'Start unassisted →' : cleared ? 'Replay trial →' : b === 3 ? 'Start trial →' : 'Start finale →', 'start', 'data-approach="direct"', !canAct, primary);
    let heading, reason, actions = '';
    if (!s) {
      heading = 'Your first destination'; reason = j.description;
      actions = button(view.canPlay ? `Begin ${def.bands[b]} expedition →` : 'Choose stats folder →', view.canPlay ? 'enroll' : 'folder', '', !bridge, true);
    } else if (inTrial) {
      heading = `${active.mode === 'checkpoint' ? 'Checkpoint' : 'Round'} ${count + 1} of ${active.steps.length}`;
      reason = trialRule(active);
      actions = button('Play next scenario ↗', 'launch', '', !view.canPlay || !bridge, true) + button(active.mode === 'checkpoint' ? 'Stop · keep checkpoints' : 'End attempt', 'abandon');
    } else if (challenge) {
      heading = label(challenge.kind); reason = offer?.purpose || 'Finish your accepted targets. Your progress stays saved.';
      actions = button('Play next scenario ↗', 'launch', '', !canAct, true) + button('Put route aside', 'pause-route', '', !bridge);
    } else if (cleared) {
      heading = final ? `${def.bands[b]} expedition complete` : 'Destination secured';
      reason = final ? 'Your First Light rewards are yours. Replay for mastery or try another difficulty.' : 'Your rewards are saved. Continue toward First Light, or return whenever you want to improve this clear.';
      actions = !final && nextId !== id ? button(nextId === 'final' ? 'Continue to First Light →' : `Next: ${destinationName(nextId)} →`, 'select', `data-destination="${nextId}"`, !bridge, true) : button('Open collection', 'page', 'data-page="collection"', false, true);
    } else if (!ready && final) {
      heading = `${6 - j.cleared} destinations to First Light`;
      reason = 'Clear each destination in this difficulty. Each clear lights one part of the final passage.';
      actions = button(`Continue: ${destinationName(nextId)} →`, 'select', `data-destination="${nextId}"`, !bridge, true);
    } else if (!ready) {
      heading = 'Choose a route'; reason = 'One short route unlocks your finale. Pick a challenge below; you can switch without losing progress.';
    } else {
      heading = b === 0 ? count ? `${count} of ${roster.length} checkpoints secured` : 'One target at a time' : b === 2 ? 'Choose how to attempt the trial' : b === 3 ? 'Your trial is open' : 'Your finale is open';
      reason = b === 0 ? 'Meet the targets in order. Successful steps stay saved, even if you stop for the day.' : b === 2 ? j.preparationReady ? 'Your preparation is complete. Use one retry, or earn the Unassisted trophy without support.' : 'Go straight in for the Unassisted trophy, or complete an optional preparation route for one retry per attempt.' : 'Meet every target in order in one attempt. Your destination clear is permanent.';
      actions = b === 2 && j.preparationReady ? button('Start with one retry →', 'start', 'data-approach="prepared"', !canAct, true) + begin(false) : begin();
    }
    const steps = inTrial ? active.steps.map(step => ({ ...step, focus: roster.find(sc => sc.name === step.scenario)?.focus || '', required: 1, source: 'published' }))
      : challenge ? challenge.steps : roster.map(sc => ({ scenario: sc.name, target: sc.target, focus: sc.focus, required: 1, source: 'published' }));
    const progress = challenge && !inTrial ? challenge.steps.reduce((n, st) => n + (challenge.progress[st.scenario] || 0), 0) : count;
    const total = challenge && !inTrial ? challenge.steps.reduce((n, st) => n + st.required, 0) : steps.length;
    const stepRows = steps.map((step, i) => {
      const r = inTrial ? active.results[i] : null, n = challenge && !inTrial ? challenge.progress[step.scenario] || 0 : 0;
      const complete = challenge && !inTrial ? n >= step.required : i < count;
      const target = step.target === null ? 'Complete a run' : `Target ${number(step.target)}`;
      const source = step.source === 'personal' ? `${challenge.kind === 'steady' ? '95%' : '103%'} of your recent median · fixed when accepted` : step.source === 'preserved' ? 'Your original accepted target' : step.target === null ? 'Any valid completed run counts' : 'Published target';
      return `<li class="${complete ? 'exp-step-done' : ''}"><span class="exp-step-number">${complete ? '✓' : i + 1}</span><div><strong>${e(step.scenario)}</strong><span>${r ? `Scored ${number(r.score)} · ` : challenge && !inTrial ? `${n}/${step.required} · ` : ''}${target}</span><p>${e(step.focus)}</p><small class="exp-target-source">${e(source)}</small></div></li>`;
    });
    const showSteps = inTrial || challenge || ready && !cleared;
    const currentIndex = challenge && !inTrial ? steps.findIndex(st => (challenge.progress[st.scenario] || 0) < st.required) : count;
    const lastMiss = inTrial ? active.misses?.at(-1) : latest?.misses?.at(-1) || (latest?.status === 'failed' ? latest.results.at(-1) : null);
    const missTarget = lastMiss && (inTrial ? active : latest)?.steps.find(st => st.scenario === lastMiss.scenario);
    const feedback = lastMiss && missTarget ? `${lastMiss.scenario}: ${number(lastMiss.score)} / ${number(missTarget.target)} (${number(lastMiss.score / missTarget.target * 100)}%).${lastMiss.score >= missTarget.target ? ' This scenario was played out of order.' : ` ${number(Math.max(0, missTarget.target - lastMiss.score))} points below target.`}` : '';
    const currentTrial = inTrial ? active : latest;
    const recovered = inTrial && lastMiss && active.results.some(r => r.at > lastMiss.at);
    const record = localTrials.filter(t => t.status === 'cleared').map(t => Math.min(...t.results.map((r, i) => r.score / t.steps[i].target)));
    return `<aside class="exp-detail" style="--destination:${e(d?.color || '#f9df83')}"><span class="exp-eyebrow">${final ? 'THE LAST PASSAGE' : e(d.category)}</span><h2>${e(final ? 'Beyond the first light' : d.name)}</h2>
      <div class="exp-objective"><small>${inTrial ? 'PLAYING NOW' : challenge ? ready ? 'OPTIONAL ACTIVITY' : 'YOUR CHOSEN ROUTE' : cleared ? 'CLEAR COMPLETE' : 'YOUR NEXT STEP'}</small><h3>${e(heading)}</h3><p>${e(reason)}</p></div>
      <div class="exp-actions exp-main-action">${actions}</div>
      ${active && !inTrial ? `<div class="exp-finale-ready"><p>An attempt at ${e(destinationName(active.destination))} is still active.</p>${button('Return to active attempt', 'select', `data-destination="${active.destination}" data-band="${active.band}"`)}</div>` : ''}
      ${showSteps ? `<div class="exp-step-progress"><span>${progress} / ${total} ${challenge && !inTrial ? 'qualifying runs' : 'targets cleared'}</span><progress max="${total}" value="${progress}" aria-label="Current activity progress"></progress></div><ol class="exp-scenarios exp-next-target">${stepRows[currentIndex] || ''}</ol>${steps.length > 1 ? `<details class="exp-all-targets"><summary>See all ${steps.length} targets</summary><ol class="exp-scenarios">${stepRows.join('')}</ol></details>` : ''}` : ''}
      ${feedback && currentTrial?.status !== 'cleared' ? `<div class="exp-last-result ${currentTrial?.status === 'failed' ? 'failed' : ''}"><strong>${recovered ? 'Earlier miss · you have moved on' : currentTrial?.status === 'failed' ? 'Attempt ended · your destination progress is safe' : 'Keep going · your cleared steps are safe'}</strong><span>${e(feedback)}</span></div>` : ''}
      ${s && !inTrial && !challenge && !ready && !final ? routeChoices(id, b, route, ready) : ''}
      ${rewardSpotlight(goalId, cleared ? has(`${id}:${b}:mastery`) ? 'EARNED IN THIS DIFFICULTY' : 'OPTIONAL MASTERY' : 'YOUR DESTINATION REWARD', cleared ? has(`${id}:${b}:mastery`) ? 'Clear and mastery complete. Try another destination or difficulty whenever you like.' : 'For a mastery trophy, beat every target by 10% in one attempt with no misses or carried checkpoints.' : has(`${id}:ship`) ? `Your ship is already collected. Earn the ${def.bands[b]} insignia here and move closer to this difficulty’s First Light clear.` : 'Clear these targets to earn this ship, plus its frame, banner, and title. Equip the ship on your star chart.')}
      ${cleared && has(`${id}:ship`) && s?.equipped.ship !== `${id}:ship` ? `<div class="exp-actions">${button('Equip earned ship', 'equip', `data-reward="${id}:ship"`, !bridge)}</div>` : ''}
      ${cleared && s?.equipped.insignia !== `${id}:${b}:clear` ? `<div class="exp-actions exp-equip-insignia">${button(`Wear ${def.bands[b]} insignia`, 'equip', `data-reward="${id}:${b}:clear"`, !bridge)}</div>` : ''}
      ${ready && challenge && !inTrial ? `<div class="exp-finale-ready"><strong>Your finale is already unlocked.</strong><p>Your accepted route will keep its progress when you put it aside.</p>${button('Return to finale', 'pause-route', '', !bridge)}</div>` : ''}
      ${s && !final && !inTrial && (ready || challenge) ? `<details class="exp-optional"><summary>${b === 2 && !j.preparationReady ? 'Prepare for one retry per attempt' : 'Other routes & optional relics'}</summary>${routeChoices(id, b, route, ready)}</details>` : ''}
      ${s && !final && !inTrial ? `<details class="exp-optional"><summary>Explore unfamiliar scenarios</summary><p>Discovery has no score targets. Try three families for the Survey fragment; it is never required for a clear.</p>${button(route?.challenges.find(c => c.kind === 'discovery')?.completedAt ? 'Discovery complete ✓' : 'Explore three scenarios', 'accept', 'data-kind="discovery"', !bridge || !!route?.challenges.find(c => c.kind === 'discovery')?.completedAt)}</details>` : ''}
      ${b === 2 && final && ready && !j.preparationReady && !inTrial ? '<p class="exp-record">For retry support in the last passage, complete one preparation route at each of the six destinations. You can enter unassisted now.</p>' : ''}
      ${cleared && !inTrial ? `<details class="exp-optional"><summary>Replay for mastery or a personal record</summary><p>Mastery needs 110% on every target with no misses or carried checkpoints.</p><div class="exp-actions">${begin()}${b === 2 && j.preparationReady ? button('Replay with one retry', 'start', 'data-approach="prepared"', !canAct) : ''}</div></details>` : ''}
      ${record.length ? `<p class="exp-record">Best clear: ${number(Math.max(...record) * 100)}% of target on your weakest round.</p>` : ''}
    </aside>`;
  }

  function map() {
    const { definition: def, state: s } = view, b = band(), j = journey();
    const ship = view.rewards.find(r => r.id === s?.equipped.ship), badge = view.rewards.find(r => r.id === s?.equipped.insignia), active = s?.trials.find(t => t.status === 'active');
    const finished = has(`final:${b}:clear`);
    return `${!s ? `<div class="exp-welcome"><span class="exp-eyebrow">FIRST LIGHT</span><h2>Train six aim skills. Earn a ship for each.</h2><p>Each destination focuses on a different aim skill. Complete all six to open the final challenge. Choose a difficulty to get started.</p><div class="exp-actions exp-main-action">${button(view.canPlay ? `Begin ${def.bands[b]} expedition →` : 'Choose stats folder →', view.canPlay ? 'enroll' : 'folder', '', !bridge, true)}</div></div>` : ''}
      <section class="exp-journey" aria-label="Your expedition goal"><div class="exp-journey-copy"><span class="exp-eyebrow">${e(def.bands[b]).toUpperCase()} JOURNEY</span><h2>${e(j.title)}</h2><p>${e(j.description)}</p><details class="exp-journey-rules"><summary>How this difficulty works</summary><p>${e(j.rules)}</p><p>Start in any difficulty. Each has separate clears; ships and other appearances are shared. Nothing expires.</p></details></div><div class="exp-journey-progress"><strong>${finished ? 'First Light conquered' : `${j.cleared} / 6 destinations`}</strong><span>${finished ? 'Your collection and records stay yours.' : j.cleared === 6 ? 'The final passage is open.' : 'Clear all six to open the final passage.'}</span><div class="exp-signals" role="group" aria-label="Destination progress">${def.destinations.map((d, i) => `<button data-exp-action="select" data-destination="${d.id}" aria-label="${e(d.name)}: ${has(`${d.id}:${b}:clear`) ? 'cleared' : 'not cleared'}" title="${e(d.name)}" class="${has(`${d.id}:${b}:clear`) ? 'lit' : ''}">${has(`${d.id}:${b}:clear`) ? '✓' : i + 1}</button>`).join('')}</div></div></section>
      ${active ? `<div class="exp-active-bar"><span>${active.mode === 'checkpoint' ? 'Checkpoints' : 'Trial'} in progress · ${e(destinationName(active.destination))} · ${e(def.bands[active.band])} · ${active.results.length}/${active.steps.length}</span>${button('Return to attempt', 'select', `data-destination="${active.destination}" data-band="${active.band}"`)}</div>` : ''}
      ${finished ? `<div class="exp-finish"><span aria-hidden="true">✦</span><div><small>${e(def.bands[b]).toUpperCase()} EXPEDITION COMPLETE</small><h2>You found the first light.</h2><p>Your clears and rewards are permanent. Return for mastery, or choose another difficulty above.</p></div>${button('Visit your collection', 'page', 'data-page="collection"')}</div>` : ''}
      <div class="exp-layout">${detail()}<div class="exp-chart-panel"><div class="exp-chart-top"><span>CHOOSE A DESTINATION</span><button class="exp-button" data-exp-action="layout" aria-pressed="${listMode}">${listMode ? 'Show star chart' : 'Show destination list'}</button></div>
        <div class="exp-map ${listMode ? 'exp-map-list' : ''}"><div class="exp-orbits" aria-hidden="true"><i></i><i></i><i></i></div>
          ${def.destinations.map((d, i) => {
            const progress = j.destinations?.[d.id];
            const status = has(`${d.id}:${b}:mastery`) ? '✦ Mastered' : has(`${d.id}:${b}:clear`) ? '✓ Cleared' : progress?.checkpoints ? `${progress.checkpoints}/3 checkpoints` : b === 0 ? 'Checkpoints open' : b === 1 && !progress?.ready ? 'Choose one route' : b === 2 && progress?.preparationReady ? 'Retry support ready' : 'Trial open';
            return `<button class="exp-planet exp-planet-${i} ${selected() === d.id ? 'selected' : ''} ${has(`${d.id}:${b}:clear`) ? 'cleared' : ''}" data-exp-action="select" data-destination="${d.id}" aria-pressed="${selected() === d.id}" style="--destination:${e(d.color)}"><span class="exp-planet-body" aria-hidden="true"><i></i></span><span class="exp-planet-name">${e(d.name)}</span><span class="exp-planet-category">${e(d.category)}</span><span class="exp-planet-status">${status}</span>${j.next === d.id && !active ? '<span class="exp-suggested">SUGGESTED NEXT</span>' : ''}</button>`;
          }).join('')}
          <div class="exp-map-ship">${art('ship', ship?.design ?? -1, ship?.color || '#d6e6ed')}<span>${e(ship?.name || 'Your starting ship')}${badge ? `<small class="exp-worn-insignia">${e(badge.name)}</small>` : ''}</span></div>
        </div><button class="exp-final-gate ${selected() === 'final' ? 'selected' : ''}" data-exp-action="select" data-destination="final"><span class="exp-final-symbol" aria-hidden="true">✦</span><span><small>THE LAST PASSAGE</small><strong>Beyond the first light</strong><span>${j.cleared} / 6 destinations cleared</span></span><b>${finished ? 'CLEARED' : j.cleared === 6 ? 'OPEN' : 'LOCKED'} →</b></button>
        ${rewardSpotlight('final:ship', finished ? 'FIRST LIGHT COLLECTION' : 'YOUR EXPEDITION GOAL', has('final:ship') ? `Your First Light ship is collected. Each difficulty also has its own final insignia and mastery trophy.` : 'Clear all six destinations in this difficulty, then conquer the final passage to earn this ship and the First Light profile set.')}<div class="exp-map-foot"><p>Pick any destination. The suggested order is a guide, not a requirement.</p><span>Accepted routes also progress during ordinary training. Trials count only after you start an attempt.</span></div></div></div>`;
  }

  function collection() {
    const s = view.state, equipped = kind => view.rewards.find(r => r.id === s?.equipped[kind]);
    const ship = equipped('ship'), frame = equipped('frame'), banner = equipped('banner'), title = equipped('title');
    const count = Object.keys(s?.rewards || {}).length;
    const visible = view.rewards.filter(r => filter === 'all' || filter === 'earned' ? filter !== 'earned' || has(r.id) : r.kind === filter);
    return `<div class="exp-hangar"><div class="exp-hangar-ship">${art('ship', ship?.design ?? -1, ship?.color || '#8de8ff')}</div><div><span class="exp-eyebrow">YOUR HANGAR</span><h2>${e(ship?.name || 'Your first ship')}</h2><p>${count} of ${view.rewards.length} rewards earned.</p><div class="exp-equipped-summary">${['ship', 'frame', 'banner', 'title', 'insignia'].map(kind => `<span><small>${kind}</small>${e(equipped(kind)?.name || 'Default')}</span>`).join('')}</div></div>
      <div class="exp-profile-preview ${frame?.id === 'final:frame' ? 'exp-animated-frame' : ''}" style="--destination:${e(frame?.color || '#658493')};--profile-banner:${e(banner?.color || '#273846')}" data-design="${frame ? frame.design % 3 : 0}"><div class="exp-profile-banner">${banner ? art('banner', banner.design, banner.color) : ''}</div><div class="exp-profile-avatar">${art('ship', ship?.design || 0, ship?.color || '#8de8ff')}</div><strong>${e(title?.name || 'New explorer')}</strong><span>Your expedition identity</span></div></div>
      <div class="exp-filters" role="group" aria-label="Filter collection">${['all', 'earned', 'ship', 'relic', 'frame', 'banner', 'title', 'insignia', 'trophy'].map(f => `<button data-exp-action="filter" data-filter="${f}" aria-pressed="${filter === f}">${f === 'all' ? 'All rewards' : f}</button>`).join('')}</div>
      ${visible.length ? `<div class="exp-rewards">${visible.map(rewardCard).join('')}</div>` : '<div class="exp-empty"><h2>Your collection begins with a single route.</h2><p>Clear a destination to earn its ship, or try an optional route for a relic.</p></div>'}`;
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
    return `<div class="exp-recap-hero"><span class="exp-eyebrow">SINCE YOU OPENED APOGEE</span><h2>Every session leaves a trace.</h2><div class="exp-stats"><span><b>${runs.length}</b>valid runs</span><span><b>${completed.length}</b>challenges cleared</span><span><b>${trials.length}</b>trials attempted</span><span><b>${earned.length}</b>rewards earned</span></div></div>
      ${banked || gains.length ? `<div class="exp-session-progress"><h3>Session progress</h3>${banked ? `<p>${banked} new checkpoint${banked === 1 ? '' : 's'} secured this session.</p>` : ''}${gains.map(g => `<p><strong>${e(g.scenario)}</strong><span>${number(g.previous)} → ${number(g.best)} · new best in your expedition log</span></p>`).join('')}<small>Score comparisons use runs recorded since joining this expedition.</small></div>` : ''}
      <div class="exp-recap-columns"><div><h3>Along your route</h3>${completed.map(({ key: k, c }) => `<p class="exp-recap-entry">✓ ${e(destinationName(k.split(':')[0]))} / ${e(view.definition.bands[Number(k.split(':')[1])])} · ${label(c.kind)} complete</p>`).join('')}${active.map(({ key: k, c }) => `<p class="exp-recap-entry">${e(destinationName(k.split(':')[0]))} / ${e(view.definition.bands[Number(k.split(':')[1])])} · ${label(c.kind)}<span>${c.steps.reduce((n, step) => n + (c.progress[step.scenario] || 0), 0)} qualifying runs so far</span></p>`).join('') || '<p>Nothing completed this session.</p>'}</div><div><h3>Trial log & records</h3>${[...trials].reverse().map(t => {
        const prior = (s?.trials || []).filter(p => p.destination === t.destination && p.band === t.band && p.status === 'cleared' && p.startedAt < t.startedAt);
        const score = t.status === 'cleared' ? Math.min(...t.results.map((r, i) => r.score / t.steps[i].target)) : 0;
        const record = score && prior.every(p => Math.min(...p.results.map((r, i) => r.score / p.steps[i].target)) < score);
        const status = t.status === 'abandoned' && t.mode === 'checkpoint' ? (t.results.length ? 'Stopped · checkpoints saved' : 'Stopped') : { active: 'In progress', failed: 'Attempt ended · retry available', cleared: 'Cleared', abandoned: 'Attempt ended' }[t.status];
        return `<p class="exp-recap-entry">${e(destinationName(t.destination))} · ${e(view.definition.bands[t.band])}<span>${e(status)}${t.mode === 'prepared' ? ' · with retry support' : ''}${record ? ' · Personal trial record' : ''}${score ? ` · ${number(score * 100)}% minimum target` : ''}</span></p>`;
      }).join('') || '<p>No trials attempted this session.</p>'}</div></div>
      <h3>New in your collection</h3>${earned.length ? `<div class="exp-rewards">${earned.map(rewardCard).join('')}</div>` : '<p>No new rewards this session. Accepted challenges stay saved.</p>'}<div class="exp-actions">${button('Continue your route →', 'page', 'data-page="map"', false, true)}</div>`;
  }
  function render() {
    if (!view) return;
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
    const id = selected(), d = destinationName(id), b = band(), c = currentChallenge(view.state?.routes[key(id, b)]);
    const homeTitle = document.getElementById('expeditionHomeTitle'), homeDetail = document.getElementById('expeditionHomeDetail');
    if (homeTitle) homeTitle.textContent = view.state ? `${d} · ${view.definition.bands[b]}` : 'First Light expedition';
    if (homeDetail) {
      const signals = view.definition.destinations.filter(destination => has(`${destination.id}:${b}:clear`)).length;
      homeDetail.textContent = !view.state ? 'Six destinations, a ship from each, then the final passage.'
        : c ? `${label(c.kind)} · ${c.steps.reduce((n, step) => n + (c.progress[step.scenario] || 0), 0)} / ${c.steps.reduce((n, step) => n + step.required, 0)} runs · ${done(id, b) >= 2 ? 'optional relic · finale unlocked' : 'earn your next relic'}`
        : has(`${id}:${b}:clear`) ? 'Rewards collected. Try mastery, beat your record, or explore another destination.'
        : id === 'final' ? signals === 6 ? 'All six signals are lit. Your First Light finale is ready.' : `${signals} / 6 signals lit. Clear each destination in this band to open the last passage.`
        : band() === 1 && done(id, b) < 2 ? 'Choose one short route to unlock your finale.'
        : done(id, b) >= 2 ? 'Your finale is open. Claim your ship or this band’s insignia.'
        : 'Choose a destination to start practicing.';
    }
    const activeTrial = view.state?.trials.find(t => t.status === 'active');
    if (activeTrial && homeTitle && homeDetail) {
      const step = activeTrial.steps[activeTrial.results.length];
      homeTitle.textContent = `${destinationName(activeTrial.destination)} · trial in progress`;
      homeDetail.textContent = `Step ${activeTrial.results.length + 1}/${activeTrial.steps.length} · ${step.scenario} · target ${number(step.target)}`;
    }
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
  function receive(next, initial = false) {
    const previous = view?.state, priorRoute = previous?.routes[key(previous.selected, previous.band)];
    const justFinished = priorRoute?.challenges.some(c => !c.completedAt && next.state?.routes[key(previous.selected, previous.band)]?.challenges.find(n => n.kind === c.kind)?.completedAt);
    const priorTrial = previous?.trials.find(t => t.status === 'active');
    const updatedTrial = priorTrial && next.state?.trials.find(t => t.id === priorTrial.id);
    const checkpointEarned = priorTrial?.mode === 'checkpoint' && updatedTrial?.status === 'active' && updatedTrial.results.length > priorTrial.results.length;
    view = next;
    const ids = Object.keys(view.state?.rewards || {});
    if (!initial && initialized) {
      const added = ids.filter(id => !announced.has(id));
      if (checkpointEarned && !added.length) message(`Checkpoint secured · ${updatedTrial.results.length}/${updatedTrial.steps.length}. Your progress is saved.`, true);
      if (added.length) { window.ApogeeCosmic?.celebrate(view, added); message(`Earned: ${added.slice(0, 2).map(id => view.rewards.find(r => r.id === id)?.name || id).join(' · ')}${added.length > 2 ? ` · +${added.length - 2} more in your collection` : ''}`, true); root.classList.remove('exp-celebrate'); void root.offsetWidth; root.classList.add('exp-celebrate'); }
    }
    initialized = true; announced = new Set(ids); render();
    if (justFinished && page === 'map' && root.closest('.screen')?.classList.contains('active')) showNextStep();
  }
  function showNextStep(moveFocus = false) {
    const active = currentChallenge(view.state?.routes[key(selected(), band())]);
    const target = !active && root.querySelector('.exp-choice-section:not(.exp-optional .exp-choice-section)') || root.querySelector('.exp-objective');
    target?.scrollIntoView({block:'start', behavior:'instant'});
    if (moveFocus) {
      const heading = target?.querySelector('h3');
      heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true });
    }
  }
  async function act(action) {
    if (!bridge || busy) return;
    // Busy controls cannot receive focus during intermediate renders. Restore the
    // originating selector only after the final render enables them again.
    const origin = document.activeElement;
    const focusSelector = origin?.matches('.exp-planet') ? '.exp-planet' : origin?.closest('.exp-signals') ? '.exp-signals button' : null;
    const focusDestination = origin?.dataset?.destination;
    const focusId = origin?.id;
    busy = true; render(); message('');
    try {
      const result = await bridge.expeditionAction(action);
      if (result.view) receive(result.view);
      if (result.error) message(result.error);
      else if (result.note) message(result.note, true);
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
    if (a === 'reward') {
      const reward = view.rewards.find(r => r.id === target.dataset.reward);
      if (!reward) return;
      page = 'collection'; filter = reward.kind; render();
      const card = [...root.querySelectorAll('[data-reward-card]')].find(el => el.dataset.rewardCard === reward.id);
      card?.focus({ preventScroll: true }); card?.scrollIntoView({ block: 'center', behavior: 'instant' }); return;
    }
    if (a === 'folder') { bridge?.chooseFolder().then(() => bridge.expedition()).then(v => receive(v)).catch(err => message(String(err))); return; }
    if (a === 'select' && !view.state) { previewSelected = target.dataset.destination; render(); return; }
    void act({ type: a, destination: target.dataset.destination || selected(), band: target.dataset.band === undefined ? band() : Number(target.dataset.band), reward: target.dataset.reward, kind: target.dataset.kind, approach: target.dataset.approach });
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
