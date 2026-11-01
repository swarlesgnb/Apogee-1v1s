/* Rift presentation. The desktop main process owns choices, receipts, scoring and persistence. */
(() => {
  'use strict';
  const root = document.getElementById('riftRoot');
  if (!root) return;
  document.getElementById('app').before(root.parentElement);
  const bridge = window.apogee;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const big = v => Number(v) >= 1e6 ? Number(v).toExponential(2).replace('e+', 'e') : Number(v).toLocaleString();
  let view = window.__APOGEE_RIFT__ || null, busy = false, message = '', band = 0, vessel = 'drifter', confirm = '', planning = false;
  let selling = null, animated = null, timers = [];
  const def = id => view.anomalies.find(a => a.id === id);
  const cometDef = id => view.comets.find(c => c.id === id);
  const hazardDef = id => view.hazards.find(h => h.id === id);
  const signalDef = id => view.signals.find(s => s.id === id);
  const button = (action, label, attrs = '', kind = '') => `<button type="button" class="rift-button ${kind}" data-rift="${action}" ${attrs} ${busy ? 'disabled' : ''}>${label}</button>`;
  const family = c => c.endsWith('Tracking') ? 'tracking' : c.endsWith('Switching') ? 'switching' : 'clicking';
  const portal = (small = false) => `<div class="rift-portal ${small ? 'small' : ''}" aria-hidden="true"><div class="rift-orbit one"></div><div class="rift-orbit two"></div><div class="rift-singularity"></div><span class="rift-cross north">+</span><span class="rift-cross south">+</span>${small ? '' : '<div class="rift-coordinate">RA 00:48 / DEC +05</div>'}</div>`;
  const body = (stage, s, extra = '') => `<div class="rift-body stage-${stage} sys-${s.system % 4} ${stage === 2 ? `hz-${e(s.hazards[s.system])}` : ''} ${extra}" aria-hidden="true"><span></span></div>`;

  /** What a stateful anomaly has grown to, in the same words its ability uses. */
  function growth(o) {
    if (['accretion', 'scrap'].includes(o.id)) return `+${num(o.n)} Flux`;
    if (['volatile', 'horizon', 'blackhole'].includes(o.id)) return `×${num(o.n)} Flux`;
    return '';
  }
  function anomalyCard(o, s, opts = {}) {
    const a = def(o.id); if (!a) return '';
    const dark = s?.fight?.dark?.includes(o.uid), i = s ? s.anomalies.indexOf(o) : -1, g = growth(o);
    const controls = opts.controls ? `<div class="rift-card-controls">${button('move', '←', `data-uid="${o.uid}" data-dir="-1" aria-label="Move ${e(a.name)} left" ${i <= 0 ? 'disabled' : ''}`, 'icon')}${button('move', '→', `data-uid="${o.uid}" data-dir="1" aria-label="Move ${e(a.name)} right" ${i >= s.anomalies.length - 1 ? 'disabled' : ''}`, 'icon')}${selling === o.uid ? button('sell', `Sell · ${Math.max(1, Math.floor(a.price / 2))} ✦`, `data-uid="${o.uid}" data-confirm="true"`, 'danger') : button('sell', 'Sell', `data-uid="${o.uid}" aria-label="Sell ${e(a.name)}"`, 'ghost')}</div>` : '';
    return `<article class="rift-anomaly ${a.rarity} ${dark ? 'dark' : ''}" data-uid="${o.uid}" data-anomaly="${e(a.id)}"><header><span class="rift-tag">${e(a.tag)}</span>${i >= 0 ? `<span class="rift-slot-no">${i + 1}</span>` : ''}</header><h3>${e(a.name)}</h3><p>${e(a.text)}</p>${g ? `<strong class="rift-growth">${e(g)}</strong>` : ''}${dark ? '<em class="rift-dark-note">Dark this fight</em>' : ''}${controls}</article>`;
  }
  function offerCard(id, price, attrs, free, can) {
    const a = def(id); if (!a) return '';
    return `<article class="rift-anomaly offer ${a.rarity}"><header><span class="rift-tag">${e(a.tag)}</span><span class="rift-rarity">${e(a.rarity.toUpperCase())}</span></header><h3>${e(a.name)}</h3><p>${e(a.text)}</p>${button('buy', free ? 'Take · free' : `Buy · ${price} ✦`, `${attrs} ${can ? '' : 'disabled'}`, 'buy')}</article>`;
  }
  function consumableName(c) { return c.kind === 'chart' ? `Star Chart · ${c.category}` : cometDef(c.id)?.name ?? c.id; }
  function consumableText(c) { return c.kind === 'chart' ? `Level up ${c.category}: +20 Thrust and +1 Flux whenever you play it.` : cometDef(c.id)?.text ?? ''; }
  function consumables(s) {
    const slots = Array.from({ length: 2 }, (_, i) => s.consumables[i]);
    return `<div class="rift-consumables" aria-label="Comets and charts">${slots.map((c, i) => c ? `<article class="rift-consumable ${c.kind}"><span class="rift-tag">${c.kind === 'chart' ? 'STAR CHART' : 'COMET'}</span><h3>${e(consumableName(c))}</h3><p>${e(consumableText(c))}</p><div class="rift-card-controls">${button('use', 'Use', `data-slot="${i}" ${s.fight?.armed ? 'disabled' : ''}`, 'small')}${button('discard', '×', `data-slot="${i}" aria-label="Discard ${e(consumableName(c))}" ${s.fight?.armed ? 'disabled' : ''}`, 'icon')}</div></article>` : '<div class="rift-empty-slot small"><span>☄</span>Comet slot</div>').join('')}</div>`;
  }
  function rail(s) {
    const editable = ['map', 'combat', 'shop'].includes(s.phase) && !s.fight?.armed;
    return `<section class="rift-rail" aria-label="Your build"><div class="rift-rail-head"><h2>Anomalies <small>${s.anomalies.length} / ${s.slots}</small></h2><span>Resolve left → right. Order changes the total.</span></div><div class="rift-rail-row"><div class="rift-anomalies" style="--slots:${s.slots}">${s.anomalies.map(o => anomalyCard(o, s, { controls: editable })).join('')}${Array.from({ length: s.slots - s.anomalies.length }, () => '<div class="rift-empty-slot"><span>+</span>Open slot</div>').join('')}</div>${consumables(s)}</div></section>`;
  }
  function hud(s) {
    const pending = s.signals.map(id => signalDef(id)).filter(Boolean);
    return `<header class="rift-hud"><div class="rift-hud-id"><span class="rift-eyebrow">INTO THE RIFT / ${e(s.bandName.toUpperCase())}${s.stats.endless ? ' / DEEP RIFT' : ''}</span><h1>${e(view.vessels.find(v => v.id === s.vessel)?.name || 'Your voyage')}</h1></div><dl class="rift-hud-stats"><div><dt>System</dt><dd>${s.system + 1}<small>${s.system <= 3 ? ' / 4' : ''}</small></dd></div><div><dt>Hull</dt><dd class="rift-pips" aria-label="${s.hull} of ${s.maxHull} hull">${Array.from({ length: s.maxHull }, (_, i) => `<i class="${i < s.hull ? 'on' : ''}"></i>`).join('')}</dd></div><div><dt>Stardust</dt><dd class="rift-dust">${s.stardust}<small> ✦</small></dd></div><div><dt>Best hit</dt><dd>${big(s.stats.bestHit)}</dd></div></dl>${pending.length || s.surge ? `<div class="rift-signals">${pending.map(x => `<span class="rift-chip" title="${e(x.text)}">⟟ ${e(x.name)}</span>`).join('')}${s.surge ? '<span class="rift-chip">⟟ Overcharge</span>' : ''}</div>` : ''}</header>`;
  }
  function track(s) {
    const r = view.derived?.route || [];
    return `<ol class="rift-track" aria-label="System ${s.system + 1}">${r.map(st => `<li class="${st.stage < s.stage ? 'past' : st.stage === s.stage ? 'current' : ''}">${body(st.stage, s, 'tiny')}<span>${e(st.name)}</span></li>`).join('<li class="rift-track-line" aria-hidden="true"></li>')}</ol>`;
  }
  function planets(s) {
    return `<section class="rift-planets" aria-label="Discipline levels"><div class="rift-rail-head"><h2>Planets</h2><span>Each level: +20 Thrust and +1 Flux for that discipline.</span></div><div class="rift-planet-row">${Object.entries(s.levels).map(([c, l]) => `<div class="rift-planet ${family(c)} ${s.stats.last === c ? 'orbit' : ''}"><span class="rift-planet-dot" aria-hidden="true"></span><div><strong>${e(c)}</strong><small>Lv ${l} · +${20 * l} Thrust · ${1 + l} Flux${s.stats.last === c && s.stats.chain > 1 ? ` · ${s.stats.chain} in orbit` : ''}</small></div></div>`).join('')}</div></section>`;
  }

  function home() {
    const play = !!bridge?.riftAction && view.canPlay && !view.error;
    const v = view.vessels.find(x => x.id === vessel) || view.vessels[0];
    return `<div class="rift-intro"><div class="rift-intro-copy"><span class="rift-eyebrow">A SOLO ROGUELITE / APOGEE</span><h1>INTO<br>THE <em>RIFT.</em></h1><p class="rift-lede">Your aim is the engine.<br>Your build is the multiplier.</p><p>Four star systems. Every run you play becomes <b class="t">Thrust</b> × <b class="f">Flux</b>. Collect anomalies that feed each other, chart the planets you love, and break stars that bend the rules.</p><div class="rift-intro-notes"><span>◈ 35 anomalies</span><span>☄ Comets &amp; star charts</span><span>✦ Eight stellar hazards</span><span>↘ An endless deep Rift</span></div></div>${portal()}</div>
      <section class="rift-how"><div><b>1</b><h3>Pick a target</h3><p>Each fight deals three scenarios. Play one in KovaaK’s, or Jump to redraw it.</p></div><div><b>2</b><h3>Thrust × Flux</h3><p>Your score sets Thrust. The planet’s level sets Flux. Anomalies fire left to right.</p></div><div><b>3</b><h3>Break the body</h3><p>Moons and planets can be skipped for a signal. Stars cannot, and each has a hazard.</p></div><div><b>4</b><h3>Build to multiply</h3><p>Hulls grow about 2.5× a system. Adding is not enough; you need ×Flux.</p></div></section>
      <section class="rift-departure"><div class="rift-section-title"><h2>Choose your vessel</h2><span>Every vessel can find every anomaly.</span></div><div class="rift-kits">${view.vessels.map((k, i) => `<button type="button" data-rift="vessel" data-id="${e(k.id)}" class="rift-kit ${vessel === k.id ? 'selected' : ''}" aria-pressed="${vessel === k.id}"><span class="rift-kit-mark" aria-hidden="true">${['◌', '✦', '⌖', '◇'][i] || '◌'}</span><span class="rift-tag">0${i + 1}</span><h3>${e(k.name)}</h3><p>${e(k.text)}</p><small>${k.hull} hull · ${k.slots} slots · ${k.stardust} ✦ · ${k.start.map(id => e(def(id)?.name)).join(', ')}</small></button>`).join('')}</div><div class="rift-departure-controls"><label>Scenario difficulty<select id="riftBand">${view.bands.map((b, i) => `<option value="${i}" ${i === band ? 'selected' : ''}>${e(b)}</option>`).join('')}</select></label>${button('start', `Launch ${e(v?.name || '')} <span aria-hidden="true">↗</span>`, play ? '' : 'disabled', 'primary')}${!view.canPlay && bridge?.chooseFolder ? button('folder', 'Connect stats folder') : ''}</div><p class="rift-caption">References are the first published score threshold in the chosen difficulty and freeze for the voyage. Below 80% is a Drift, 80% a Graze, 100% a Strike, 115% a Nova. Rift damage never touches your scores, ranks or quests.</p>${!bridge?.riftAction ? '<p class="rift-notice">Open the desktop app to play. This preview cannot receive KovaaK’s runs.</p>' : !view.canPlay ? '<p class="rift-notice">Connect your KovaaK’s stats folder to begin. Steam sign-in is not required for this solo mode.</p>' : ''}</section>`;
  }

  function map(s) {
    const r = view.derived?.route || [], hz = hazardDef(s.hazards[s.system]);
    return `<section class="rift-map"><div class="rift-section-title"><div><span class="rift-eyebrow">SYSTEM ${s.system + 1}${s.system > 3 ? ' · DEEP RIFT' : ''}</span><h2>${s.stage === 2 ? 'The star is waiting.' : 'Choose: fight or slip past.'}</h2></div><span>Fights pay stardust and open a shop. Skips grant a signal instead.</span></div><div class="rift-bodies">${r.map(st => {
      const cur = st.stage === s.stage, done = st.stage < s.stage, sig = st.stage < 2 ? signalDef(s.skips[st.stage]) : null;
      return `<article class="rift-body-card ${cur ? 'current' : ''} ${done ? 'past' : ''} stage-${st.stage}">${body(st.stage, s)}<span class="rift-tag">${e(st.name.toUpperCase())}${st.stage === 2 ? ' · BOSS' : ''}</span><h3>${st.stage === 2 ? e(hz?.name || 'Star') : `${['Outer', 'Inner', 'Far', 'Deep'][s.system % 4]} ${e(st.name)}`}</h3><dl><div><dt>Hull</dt><dd>${big(st.hull)}</dd></div><div><dt>Reward</dt><dd>${st.pay}${st.stage === 2 && s.hazards[s.system] === 'bluegiant' ? '+5' : ''} ✦ + shop</dd></div></dl>${st.stage === 2 ? `<p class="rift-rule">${e(hz?.rule)}</p>` : sig ? `<p class="rift-signal"><b>Skip signal · ${e(sig.name)}</b>${e(sig.text)}</p>` : ''}${cur ? `<div class="rift-body-actions">${button('engage', st.stage === 2 ? 'Face the star ↗' : 'Engage ↗', '', 'primary')}${st.stage < 2 ? button('skip', 'Skip', '', 'ghost') : ''}</div>` : done ? '<em class="rift-done">Behind you</em>' : '<em class="rift-done">Ahead</em>'}</article>`;
    }).join('')}</div></section>`;
  }

  function combat(s) {
    const f = s.fight, armed = f.armed, hz = f.stage === 2 ? hazardDef(s.hazards[s.system]) : null;
    const left = Math.max(0, f.hull - f.dealt), pct = Math.min(100, f.dealt / f.hull * 100), previews = view.derived?.previews || [];
    const enemy = `<div class="rift-enemy"><div class="rift-enemy-art">${body(f.stage, s, 'large')}</div><div class="rift-enemy-copy"><span class="rift-eyebrow">${e(['MOON', 'PLANET', 'STAR'][f.stage])} · SALVO ${Math.min(f.salvo + 1, f.salvos)} OF ${f.salvos}</span><h2>${e(f.name)}</h2><div class="rift-hullbar" role="meter" aria-valuemin="0" aria-valuemax="${f.hull}" aria-valuenow="${left}" aria-label="Hull remaining"><i style="width:${100 - pct}%"></i></div><p class="rift-hull-text"><b>${big(left)}</b> hull left of ${big(f.hull)}</p><div class="rift-fight-meta"><span>Salvos <b>${'◆'.repeat(Math.max(0, f.salvos - f.salvo))}${'◇'.repeat(f.salvo)}</b></span><span>Jumps <b>${f.jumps}</b></span>${f.boost ? '<span class="rift-chip hot">☄ Halley primed · ×2 Flux</span>' : ''}${f.lock ? `<span class="rift-chip">Locked · ${e(f.lock)}</span>` : ''}</div>${hz ? `<p class="rift-rule"><b>${e(hz.name)}.</b> ${e(hz.rule)}</p>` : ''}</div></div>`;
    if (armed) {
      const c = f.hand[armed.card];
      return `${enemy}<section class="rift-listening-card ${family(c.category)}" role="status"><span class="rift-pulse" aria-hidden="true"></span><div><span class="rift-eyebrow">LISTENING FOR YOUR RUN</span><h3>${e(c.scenario)}</h3><p>${e(c.category)} · reference ${num(c.target)}. Your first complete run on it, started after you pressed Play, fires this salvo.</p></div>${button('launch', 'Open scenario again')}</section><p class="rift-caption">You can close Apogee and come back; a completed armed run is recovered from your stats folder. Partial, unrelated, old and duplicate runs never settle a salvo.</p>`;
    }
    const hand = f.hand.map((c, i) => {
      const blocked = f.lock && c.category !== f.lock, lv = s.levels[c.category] || 1, lethal = (previews[i] || 0) >= left;
      return `<article class="rift-target ${family(c.category)} ${blocked ? 'blocked' : ''}" data-card="${i}"><span class="rift-tag">${e(c.category.toUpperCase())}</span><h3>${e(c.scenario)}</h3><dl><div><dt>Reference</dt><dd>${num(c.target)}</dd></div><div><dt>Planet</dt><dd>Lv ${lv}</dd></div></dl><div class="rift-preview ${lethal ? 'lethal' : ''}"><small>At reference</small><strong>${big(previews[i] ?? 0)}</strong>${lethal ? '<em>BREAKS IT</em>' : `<em>${Math.round((previews[i] || 0) / left * 100)}% of hull</em>`}</div><div class="rift-target-actions">${button('arm', 'Play ↗', `data-card="${i}" ${view.canPlay && !blocked ? '' : 'disabled'}`, 'primary')}${button('jump', 'Jump', `data-card="${i}" ${f.jumps ? '' : 'disabled'} aria-label="Jump away from ${e(c.scenario)}"`, 'ghost')}</div></article>`;
    }).join('');
    return `${enemy}<div class="rift-section-title"><h2>Your hand</h2><span>Previews assume exactly the reference. Beat it and the number grows.</span></div><div class="rift-hand">${hand}</div>`;
  }

  function result(s) {
    const r = s.last, titles = { clear: 'Broken.', continue: 'It holds. Again.', failed: 'It held. Press on.', lost: 'The Rift takes this one.' };
    const left = Math.max(0, r.hull - r.dealt), total = r.payout.reduce((n, p) => n + p.amount, 0);
    const label = r.verdict === 'clear' ? (s.stage === 2 && s.system === 3 && !s.stats.endless ? 'Escape the Rift →' : 'Cash out and shop →') : r.verdict === 'continue' ? 'Next salvo →' : r.verdict === 'lost' ? 'Voyage recap →' : 'Back to the map →';
    return `<section class="rift-resolution ${r.verdict}" data-receipt="${e(r.receipt.id)}"><div class="rift-res-head"><div><span class="rift-eyebrow">SIGNAL RECEIVED / ${e(r.card.scenario.toUpperCase())}</span><h2 tabindex="-1" id="riftResultTitle">${titles[r.verdict]}</h2></div><div class="rift-grade ${r.grade}"><strong>${e(view.grades[r.grade].name)}</strong><small>KovaaK’s ${num(r.receipt.score)} · ${Math.round(r.ratio * 100)}% of ${num(r.card.target)}</small></div></div>
      <div class="rift-equation" aria-label="Damage equation"><div class="rift-thrust"><small>THRUST</small><strong data-final="${r.thrust}">${big(r.thrust)}</strong></div><span class="rift-op" aria-hidden="true">×</span><div class="rift-flux"><small>FLUX</small><strong data-final="${r.flux}">${num(r.flux)}</strong></div><span class="rift-op" aria-hidden="true">=</span><div class="rift-damage"><small>DAMAGE</small><strong data-final="${r.damage}">${big(r.damage)}</strong></div></div>
      <ol class="rift-steps">${r.steps.map((x, i) => `<li data-step="${i}" ${x.uid ? `data-uid="${x.uid}"` : ''}><span class="rift-step-src">${e(x.source)}</span><span class="rift-step-text">${e(x.text)}</span><span class="rift-step-run">${big(x.thrust)} × ${num(x.flux)}</span></li>`).join('')}</ol>
      <div class="rift-hullbar after" role="meter" aria-valuemin="0" aria-valuemax="${r.hull}" aria-valuenow="${left}" aria-label="Hull remaining"><i style="width:${100 - Math.min(100, r.dealt / r.hull * 100)}%"></i></div><p class="rift-hull-text">${left ? `<b>${big(left)}</b> hull left · salvo ${r.salvo} spent` : `<b>${big(r.dealt)}</b> dealt to a hull of ${big(r.hull)}`}</p>
      ${r.notes.length ? `<ul class="rift-notes">${r.notes.map(n => `<li>${e(n)}</li>`).join('')}</ul>` : ''}
      ${r.payout.length ? `<div class="rift-payout"><h3>Cash out <b>+${total} ✦</b></h3>${r.payout.map(p => `<div><span>${e(p.label)}</span><b>+${p.amount} ✦</b></div>`).join('')}</div>` : ''}
      <div class="rift-res-actions">${button('continue', label, '', 'primary')}${button('skipanim', 'Skip animation', '', 'ghost')}</div></section>`;
  }

  function shop(s) {
    const sh = s.shop, room = s.anomalies.length < s.slots, next = s.stage === 2 ? `System ${s.system + 2}` : view.derived?.route?.[s.stage + 1]?.name;
    const anomalies = sh.anomalies.map((o, i) => o ? offerCard(o.id, o.price, `data-row="anomaly" data-index="${i}"`, sh.free, room && (sh.free || s.stardust >= o.price)) : '<div class="rift-empty-slot sold"><span>✓</span>Taken</div>').join('');
    const goods = sh.goods.map((o, i) => o ? `<article class="rift-consumable offer ${o.item.kind}"><span class="rift-tag">${o.item.kind === 'chart' ? 'STAR CHART' : 'COMET'}</span><h3>${e(consumableName(o.item))}</h3><p>${e(consumableText(o.item))}</p>${button('buy', `Buy · ${o.price} ✦`, `data-row="goods" data-index="${i}" ${s.stardust >= o.price && s.consumables.length < 2 ? '' : 'disabled'}`, 'buy')}</article>` : '<div class="rift-empty-slot sold small"><span>✓</span>Taken</div>').join('');
    return `<section class="rift-shop"><div class="rift-section-title"><div><span class="rift-eyebrow">TRADING POST / SYSTEM ${s.system + 1}</span><h2>Spend it, or let it earn.</h2></div><span>Interest pays 1 ✦ per 5 held at each clear, up to ${s.anomalies.some(o => o.id === 'gasgiant') ? 10 : 5} ✦.</span></div>${sh.free ? '<p class="rift-chip hot">⟟ Free Berth: your first anomaly here costs nothing.</p>' : ''}<div class="rift-shop-grid"><div><h3 class="rift-sub">Anomalies</h3><div class="rift-offers">${anomalies || '<p>Nothing left to find here.</p>'}</div>${room ? '' : '<p class="rift-caption">Every slot is full. Sell an anomaly from your rail to make room.</p>'}</div><div><h3 class="rift-sub">Comets &amp; charts</h3><div class="rift-offers goods">${goods}</div></div></div><div class="rift-shop-footer">${button('reroll', `Reroll anomalies · ${sh.rerollCost} ✦`, s.stardust >= sh.rerollCost ? '' : 'disabled')}${button('leave', `On to the ${e(next || 'next body')} →`, '', 'primary')}</div></section>`;
  }

  function ended(s) {
    const won = s.phase === 'won', title = won ? 'You broke through.' : s.phase === 'extracted' ? 'Home in one piece.' : 'The Rift closes.';
    const why = s.phase !== 'lost' ? '' : s.hull === 0 ? 'Your hull ran out.' : s.last?.verdict === 'lost' ? `${e(s.fight?.name || 'The star')} outlasted your salvos.` : 'This voyage was ended mid-fight.';
    return `<section class="rift-ending ${s.phase}">${won ? portal(true) : ''}<span class="rift-eyebrow">${won ? 'RIFT CLEARED' : s.phase === 'extracted' ? 'EXTRACTED' : 'VOYAGE ENDED'} · SYSTEM ${s.system + 1}</span><h2>${title}</h2>${why ? `<p>${why}</p>` : ''}<dl class="rift-end-stats"><div><dt>Best hit</dt><dd>${big(s.stats.bestHit)}</dd></div><div><dt>Total damage</dt><dd>${big(s.stats.damage)}</dd></div><div><dt>Bodies broken</dt><dd>${s.stats.clears}</dd></div><div><dt>Salvos</dt><dd>${s.stats.salvos}</dd></div></dl><div class="rift-end-build">${s.anomalies.map(o => `<span class="rift-chip ${def(o.id)?.rarity}">${e(def(o.id)?.name)}</span>`).join('')}</div><div class="rift-res-actions">${won ? button('deeper', 'Go deeper ↘', '', 'primary') : ''}${button('new', 'Plan another voyage ↗', '', won ? '' : 'primary')}</div>${won ? '<p class="rift-caption">The deep Rift keeps going: every system is 2.5× the last, and the record keeps your furthest system and best hit.</p>' : ''}</section>`;
  }

  function records() {
    if (!view.records?.length) return '';
    return `<details class="rift-records"><summary>Flight recorder · ${view.records.length} recent voyages</summary>${view.records.map(r => `<div><strong>${e(r.outcome === 'won' ? 'Cleared' : r.outcome === 'lost' ? 'Lost' : 'Extracted')}</strong><span>${e(view.vessels.find(v => v.id === r.vessel)?.name || r.vessel)} · ${e(r.band)} · system ${r.system} · best hit ${big(r.bestHit)}</span><small>${r.anomalies.map(id => e(def(id)?.name || id)).join(' · ')}</small></div>`).join('')}</details>`;
  }

  function render() {
    stopAnimation();
    if (!view?.anomalies) { root.innerHTML = `<div class="rift-notice" role="alert">${e(view?.error || 'Opening the Rift…')}${button('refresh', 'Try again')}</div>`; return; }
    const focused = document.activeElement?.closest('[data-rift]');
    const focusKey = focused ? ['rift', 'uid', 'card', 'slot', 'index', 'row', 'dir', 'id'].map(k => focused.dataset[k] ?? '').join('|') : null;
    const s = view.state, finished = s && ['won', 'lost', 'extracted'].includes(s.phase);
    let content;
    if (!s || finished && planning) content = home();
    else {
      const stage = ({ map, combat, result, shop, won: ended, lost: ended, extracted: ended })[s.phase](s);
      content = `${hud(s)}${finished ? '' : track(s)}<div class="rift-stage phase-${s.phase}">${stage}</div>${rail(s)}${planets(s)}`;
    }
    const endAction = s?.phase === 'combat' ? 'abandon' : s && ['map', 'shop'].includes(s.phase) ? 'extract' : null;
    root.innerHTML = `<div class="rift-page">${view.error ? `<div class="rift-notice" role="alert">${e(view.error)}</div>` : ''}${view.warning ? `<p class="rift-notice">${e(view.warning)}</p>` : ''}${content}<p class="rift-message" role="status" aria-live="polite">${e(message)}</p><footer class="rift-footer"><span>SOLO · ROGUELITE<br><small>Rift damage is separate from your aim score and ranked rating.</small></span><div>${endAction ? confirm === endAction ? `<span>${endAction === 'abandon' ? 'End this voyage? Your build will be lost.' : 'Extract now and keep this voyage’s record?'}</span>${button(endAction, 'Confirm', 'data-confirm="true"', 'danger')}${button('cancel', 'Keep going')}` : button(endAction, endAction === 'abandon' ? 'End voyage' : 'Extract safely', '', 'ghost') : ''}${button('refresh', 'Refresh', '', 'ghost')}</div></footer>${records()}</div>`;
    if (view.error) root.querySelectorAll('[data-rift]:not([data-rift="refresh"])').forEach(b => b.disabled = true);
    if (focusKey) [...root.querySelectorAll('[data-rift]')].find(el => ['rift', 'uid', 'card', 'slot', 'index', 'row', 'dir', 'id'].map(k => el.dataset[k] ?? '').join('|') === focusKey)?.focus({ preventScroll: true });
    if (s?.phase === 'result' && s.last.receipt.id !== animated && document.body.dataset.screen === 'rift') {
      animated = s.last.receipt.id;
      document.getElementById('riftResultTitle')?.focus({ preventScroll: true });
      animate(s.last);
    }
  }

  /**
   * Replays the breakdown one trigger at a time, lighting each anomaly as it fires. The final
   * numbers are already in the markup, so skipping, a re-render or reduced motion lose nothing.
   */
  function animate(r) {
    const sound = name => { if (typeof window.playSound === 'function') window.playSound(name); };
    if (reduced?.matches) { sound(r.verdict === 'clear' ? 'celebrate' : r.verdict === 'lost' ? 'defeat' : 'ok'); return; }
    const page = root.querySelector('.rift-resolution'); if (!page) return;
    const thrust = page.querySelector('.rift-thrust strong'), flux = page.querySelector('.rift-flux strong'), dmg = page.querySelector('.rift-damage strong');
    const items = [...page.querySelectorAll('.rift-steps li')];
    page.classList.add('playing'); dmg.textContent = '0';
    const pace = Math.max(140, Math.min(420, 2600 / Math.max(1, r.steps.length)));
    r.steps.forEach((x, i) => timers.push(setTimeout(() => {
      items.forEach(li => li.classList.remove('now')); items[i]?.classList.add('now', 'shown');
      thrust.textContent = big(x.thrust); flux.textContent = num(x.flux);
      for (const el of [thrust, flux]) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
      if (x.uid) { const card = root.querySelector(`.rift-anomaly[data-uid="${x.uid}"]`); card?.classList.remove('firing'); void card?.offsetWidth; card?.classList.add('firing'); }
      sound('tap');
    }, i * pace)));
    timers.push(setTimeout(() => {
      items.forEach(li => li.classList.remove('now'));
      dmg.textContent = big(r.damage); dmg.classList.add('slam'); page.classList.remove('playing'); page.classList.add('landed');
      sound(r.verdict === 'clear' ? 'celebrate' : r.verdict === 'lost' ? 'defeat' : 'ok');
    }, r.steps.length * pace + 120));
  }
  function stopAnimation() { timers.forEach(clearTimeout); timers = []; }
  function finishAnimation() {
    stopAnimation();
    const page = root.querySelector('.rift-resolution'); if (!page) return;
    page.classList.remove('playing'); page.classList.add('landed');
    page.querySelectorAll('[data-final]').forEach(el => { const v = Number(el.dataset.final); el.textContent = el.closest('.rift-flux') ? num(v) : big(v); });
    page.querySelectorAll('.rift-steps li').forEach(li => li.classList.remove('now'));
  }

  async function refresh() {
    if (!bridge?.rift) { render(); return; }
    try { view = await bridge.rift(); } catch (err) { message = String(err.message || err); }
    render();
  }
  root.addEventListener('change', event => { if (event.target.id === 'riftBand') band = Number(event.target.value); });
  root.addEventListener('click', async event => {
    const el = event.target.closest('[data-rift]'); if (!el || el.disabled || busy) return;
    const type = el.dataset.rift;
    if (type === 'vessel') { vessel = el.dataset.id; render(); return; }
    if (type === 'refresh') { await refresh(); return; }
    if (type === 'skipanim') { finishAnimation(); return; }
    if (type === 'new') { planning = true; confirm = ''; message = ''; render(); return; }
    if (type === 'cancel') { confirm = ''; render(); return; }
    if (['extract', 'abandon'].includes(type) && !el.dataset.confirm) { confirm = type; render(); return; }
    if (type === 'sell' && !el.dataset.confirm) { selling = Number(el.dataset.uid); render(); return; }
    if (type === 'folder') { try { await bridge.chooseFolder(); await refresh(); } catch (err) { message = String(err.message || err); render(); } return; }
    if (!bridge?.riftAction) return;
    const action = { type };
    for (const k of ['card', 'slot', 'uid', 'dir', 'index']) if (el.dataset[k] !== undefined) action[k] = Number(el.dataset[k]);
    if (el.dataset.row) action.row = el.dataset.row;
    if (type === 'start') { action.band = band; action.vessel = vessel; }
    busy = true; message = ''; render();
    try {
      const response = await bridge.riftAction(action);
      if (response.view) { view = response.view; planning = false; }
      if (response.error) message = response.error;
      else { confirm = ''; selling = null; if (type === 'buy' && typeof window.playSound === 'function') window.playSound('ok'); }
    } catch (err) { message = String(err.message || err); }
    finally { busy = false; render(); }
  });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && (selling !== null || confirm)) { selling = null; confirm = ''; render(); } });
  bridge?.onRift?.(next => { view = next; render(); });
  document.querySelector('.tab[data-screen="rift"]')?.addEventListener('click', refresh);
  window.addEventListener('focus', () => { if (document.body.dataset.screen === 'rift' && !busy && !timers.length) void refresh(); });
  void refresh();
})();
