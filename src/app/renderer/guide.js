/* The Guide: a beginner's map of Apogee, spotlight tours of the real screens, and the Rift
 * Academy. Presentation only. It opens screens through their own tabs, so every screen's
 * lifecycle runs exactly as if the player had clicked, and it scores practice salvos with
 * the real Rift engine (rift-lab.js) rather than a copy of the formula. Progress is a
 * per-machine convenience in localStorage; nothing here is uploaded or decides anything.
 */
(() => {
  'use strict';
  const KEY = 'apogee.guide.v1';
  const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const big = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const sound = name => { if (typeof window.playSound === 'function') window.playSound(name); };
  const lab = () => window.ApogeeRiftLab;
  let store = { done: {}, nudged: false, hints: true };
  try { store = { ...store, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* Private window or blocked storage: start fresh. */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* Progress is a convenience. */ } };

  const MODES = [
    { group: 'Practice', screen: 'home', name: 'Practice home', what: 'Your starting point for training. Pick a difficulty and jump into a drill, or pick up where you left off.',
      how: ['Choose your difficulty band at the top.', 'Pick a suggested drill or resume a session.', 'Play it in KovaaK’s; your score appears here automatically.'], tip: 'Not sure what to train? Start here.' },
    { group: 'Practice', screen: 'mixtape', name: 'Practice session', what: 'Builds a short playlist of 3, 6 or 9 scenarios for you, in one difficulty.',
      how: ['Pick a mood: Full spectrum (a bit of everything), Close the gap (nearest to your next threshold) or Side quests (what you play least).', 'Press start. Each track says why it is in the set.', 'Play the current track in KovaaK’s. A finished run moves you to the next one; you can skip.'], tip: 'Perfect for a 15-minute warm-up with a purpose.' },
    { group: 'Practice', screen: 'scenarios', name: 'Scenario library', what: 'Every scenario Apogee knows, searchable, with your scores beside them.',
      how: ['Type a name, a category or an aim type.', 'Open a row to see your history on it.', 'Launch it straight into KovaaK’s.'], tip: 'Use it to look something up, not to plan a session.' },
    { group: 'Practice', screen: 'ghost', name: 'Ghost', what: 'Race your own past self. Apogee draws scenarios and freezes a ghost from your history on each.',
      how: ['Choose a ghost kind and start.', 'Play each drawn scenario before the clock runs out.', 'You win by showing up sharper than your usual on those scenarios.'], tip: 'Great when you want stakes without another player.' },
    { group: 'Practice', screen: 'expedition', name: 'Expedition', what: 'A permanent solo campaign called First Light: six destinations, one per aim discipline, then a final passage.',
      how: ['Pick a difficulty. Each one plays differently, from checkpoints at Novice to strict trials at Expert.', 'Clear a destination’s targets by playing its scenarios in KovaaK’s.', 'Each clear earns a ship and a profile appearance. Nothing expires.'], tip: 'A long-term goal you can chip away at between other modes.' },
    { group: 'Practice', screen: 'rift', name: 'Rift', what: 'A roguelite. Every run you play becomes Thrust × Flux damage, and the anomalies you collect multiply it.',
      how: ['Pick a vessel and a difficulty, then fight moons, planets and stars across four systems.', 'Each fight deals three scenarios. Play one in KovaaK’s; your score becomes an attack.', 'Spend stardust in shops on anomalies that combine. Order matters.'], tip: 'New to it? Take the Rift Academy: seven short, hands-on lessons.', academy: true },
    { group: 'Compete', screen: 'queue', name: 'Ranked 1v1', what: 'The heart of Apogee. Queue a category and get matched with someone near your rank.',
      how: ['Sign in with Steam and choose a category, or Any.', 'Apogee picks three scenarios. You both play each one once.', 'Higher score takes each round; more rounds wins. Your rating updates by itself.'], tip: 'You never type a score: it is read from your stats folder.' },
    { group: 'Compete', screen: 'daily', name: 'Daily', what: 'Three scenarios a day, the same three for everyone in your band.',
      how: ['Open it once a day to see today’s draw.', 'Play the three in KovaaK’s.', 'Compare on the board, keep your streak, share your result.'], tip: 'Two minutes a day keeps a streak alive.' },
    { group: 'Compete', screen: 'crowns', name: 'Crowns', what: 'One Crown per category and band. Hold it, or take it from whoever does.',
      how: ['Find a Crown you want.', 'Challenge its holder by beating their score.', 'Or race a friend live on the same scenario.'], tip: 'Short, personal rivalries.' },
    { group: 'Compete', screen: 'seasonview', name: 'Season', what: 'This season’s benchmark scenarios and what your next rank needs.',
      how: ['See every scenario in your band.', 'Each one shows your best and the next threshold.', 'Close the smallest gaps first to rank up fastest.'], tip: 'Pairs well with Practice session’s Close the gap mood.' },
    { group: 'Compete', screen: 'tournaments', name: 'Tournaments', what: 'Organised events with groups, brackets and fixtures.',
      how: ['Join an open tournament.', 'Play your fixtures when they are due; the top bar tells you when one is waiting.', 'Advance from groups into the bracket.'], tip: 'Check the top bar: a fixture waiting for you shows there on every screen.' },
    { group: 'Compete', screen: 'leaderboards', name: 'Leaderboards', what: 'Compare scores and ladder standings with everyone else.', how: ['Pick a board.', 'Find yourself and the people around you.', 'Open a player to compare.'], tip: '' },
    { group: 'Compete', screen: 'result', name: 'Last match', what: 'The breakdown of your most recent ranked match.', how: ['See every round side by side.', 'See “against your usual”: how each score compared with your own baseline.', 'See your rating change.'], tip: '' },
    { group: 'Progress', screen: 'profile', name: 'Your aim', what: 'Your strengths and weak spots by category, from your real history.', how: ['Read your strongest and weakest categories.', 'Open a category to see the scenarios behind it.', 'Train the weak ones in Practice session.'], tip: 'The honest answer to “what should I train?”' },
    { group: 'Progress', screen: 'quests', name: 'Quests', what: 'Goals you are working toward, including any benchmark you paste in from an evxl link.', how: ['Add a quest or paste a benchmark link.', 'Play normally; matching runs count automatically.', 'Watch the progress fill.'], tip: '' },
    { group: 'Progress', screen: 'ranks', name: 'Ranks', what: 'Apogee’s rank ladder: every threshold, and exactly where you sit.', how: ['Find your current rank.', 'See what the next one needs.', 'Click your rank badge anywhere in the app to come back here.'], tip: '' },
    { group: 'Progress', screen: 'consistency', name: 'Consistency', what: 'How steady your recent scores are, not just how high.', how: ['See which scenarios swing the most.', 'Steady scores usually mean real skill rather than a lucky run.', 'Use it to decide what to drill.'], tip: '' },
  ];
  const GOALS = [
    { id: 'warm', label: 'Warm up or fix a weakness', modes: ['mixtape', 'home', 'profile'], why: 'A focused set picked for you, then see what to work on next.' },
    { id: 'self', label: 'Beat my own scores', modes: ['ghost', 'daily', 'consistency'], why: 'Race your past self, then check you are improving for real.' },
    { id: 'game', label: 'Play a game on my own', modes: ['rift', 'expedition'], why: 'Rift is a run-based roguelite; Expedition is a campaign you finish over weeks.' },
    { id: 'pvp', label: 'Play against real people', modes: ['queue', 'crowns', 'tournaments'], why: 'Ranked matches, Crown challenges and organised events.' },
    { id: 'track', label: 'See how I’m doing', modes: ['profile', 'ranks', 'seasonview', 'quests'], why: 'Your strengths, your rank, and what the next one needs.' },
  ];
  const GLOSSARY = [
    ['Stats folder', 'Where KovaaK’s writes a file after every run. Apogee reads it; you never type a score.'],
    ['Band / difficulty', 'Novice, Intermediate, Advanced or Expert: which set of scenarios and thresholds you play.'],
    ['Threshold / reference', 'The score a rank, or a Rift fight, measures you against.'],
    ['Thrust', 'Rift: the part of an attack that comes from your score. 100 × your score ÷ the reference, plus 20 per planet level.'],
    ['Flux', 'Rift: the multiplier. Starts at planet level + 1, then anomalies add to it or multiply it.'],
    ['Damage', 'Rift: Thrust × Flux, rounded down. It stacks across salvos until the body breaks.'],
    ['Grade', 'Rift: Drift (under 80% of reference), Graze (80%+), Strike (100%+), Nova (115%+). Some anomalies only fire on certain grades.'],
    ['Salvo', 'Rift: one run you play in a fight. You get two per fight unless something adds more.'],
    ['Jump', 'Rift: swap one of the three scenarios in your hand for a new one.'],
    ['Anomaly', 'Rift: an item in your build. They fire left to right, so their order changes the total.'],
    ['Planet level', 'Rift: each discipline has a level. Higher means more Thrust and Flux whenever you play it.'],
    ['Star chart', 'Rift: a one-use item that levels up one discipline’s planet.'],
    ['Comet', 'Rift: a one-use item, like Halley’s Comet (×2 Flux next salvo) or Wormhole (+1 salvo).'],
    ['Stardust (✦)', 'Rift: money. Earned by breaking bodies, spent in shops. Holding it pays interest.'],
    ['Signal', 'Rift: the bonus you get for skipping a moon or planet instead of fighting it.'],
    ['Hazard', 'Rift: the special rule each star plays by. Shown before you fight it.'],
    ['Ghost', 'A frozen copy of your own past performance to race.'],
    ['Crown', 'A title for the best player in one category and band, which anyone can challenge.'],
  ];

  /* ---------- Rift Academy ---------- */
  const LESSONS = [
    { id: 'attack', title: 'One run, one attack', short: 'How your score becomes damage.' },
    { id: 'order', title: 'Order matters', short: 'Anomalies fire left to right.' },
    { id: 'combo', title: 'Build a combo', short: 'Hit 3,000 damage at 100% score.' },
    { id: 'hand', title: 'Pick your target', short: 'Which card in your hand hits hardest?' },
    { id: 'map', title: 'Fight, skip, or face the star', short: 'Moons, planets, stars and hazards.' },
    { id: 'shop', title: 'Stardust and the shop', short: 'Interest, and when to spend.' },
    { id: 'real', title: 'Your first real salvo', short: 'From the Play button to KovaaK’s and back.' },
  ];
  const doneCount = () => LESSONS.filter(l => store.done['rift:' + l.id]).length;
  function complete(id, el) {
    if (store.done[id]) return;
    store.done[id] = true; save(); sound('celebrate');
    el?.querySelector('.guide-goal')?.classList.add('met');
    paintNav();
  }
  function equation(r) {
    return `<div class="guide-eq"><div class="t"><small>THRUST</small><b>${big(r.thrust)}</b></div><span>×</span><div class="f"><small>FLUX</small><b>${big(r.flux)}</b></div><span>=</span><div class="d"><small>DAMAGE</small><b>${big(r.damage)}</b></div></div>`;
  }
  const gradeName = g => ({ drift: 'Drift', graze: 'Graze', strike: 'Strike', nova: 'Nova' })[g];
  function steps(r) { return `<ol class="guide-steps">${r.steps.map(x => `<li><span>${e(x.source)}</span><b>${e(x.text)}</b></li>`).join('')}</ol>`; }
  function goal(id, text) { return `<p class="guide-goal ${store.done['rift:' + id] ? 'met' : ''}"><span aria-hidden="true">◎</span><b>Goal:</b> ${e(text)}<em>✓ Done</em></p>`; }
  const anomalyName = id => lab()?.anomalies.find(a => a.id === id)?.name ?? id;
  const anomalyText = id => lab()?.anomalies.find(a => a.id === id)?.text ?? '';
  function noLab(el) { el.innerHTML = '<p class="guide-note">The practice calculator did not load. Rebuild the app (npm run build:app) and reopen the Guide.</p>'; }

  const LESSON_VIEWS = {
    attack(el) {
      if (!lab()) return noLab(el);
      let pct = 100, level = 1;
      el.innerHTML = `<p>In a Rift fight you play a real scenario in KovaaK’s. Apogee compares your score with the fight’s <b>reference</b> score and turns it into an attack:</p>
        <ul class="guide-bullets"><li><b class="t">Thrust</b> comes from your score: 100 × (your score ÷ reference), capped at 2×, plus 20 per planet level.</li><li><b class="f">Flux</b> is the multiplier. With no anomalies it is just the planet level + 1.</li><li>Damage is Thrust × Flux.</li></ul>
        <div class="guide-lab"><label>Your score vs. the reference <output id="gPct"></output><input type="range" id="gPctIn" min="40" max="200" step="5" value="100"></label>
        <label>Planet level of this discipline <output id="gLv"></output><input type="range" id="gLvIn" min="1" max="6" step="1" value="1"></label>
        <div id="gOut"></div></div>${goal('attack', 'Reach a Nova grade and deal at least 500 damage.')}<p class="guide-note">Notice: doubling your score doesn’t double damage on its own, but a higher planet level raises both Thrust and Flux. That’s why star charts are worth buying.</p>`;
      const paint = () => {
        const r = lab().salvo({ ratio: pct / 100, level });
        el.querySelector('#gPct').textContent = `${pct}%`; el.querySelector('#gLv').textContent = `Lv ${level}`;
        el.querySelector('#gOut').innerHTML = `<p class="guide-grade ${r.grade}">${gradeName(r.grade)}</p>${equation(r)}`;
        if (r.grade === 'nova' && r.damage >= 500) complete('rift:attack', el);
      };
      el.querySelector('#gPctIn').oninput = ev => { pct = Number(ev.target.value); paint(); };
      el.querySelector('#gLvIn').oninput = ev => { level = Number(ev.target.value); paint(); };
      paint();
    },
    order(el) {
      if (!lab()) return noLab(el);
      let row = ['volatile', 'pulsar'];
      el.innerHTML = `<p>Your anomalies fire one at a time, <b>left to right</b>. Some <b>add</b> Flux (Pulsar: +4). Some <b>multiply</b> it (Volatile Reactor: ×2.5). Adding before multiplying means the multiplier boosts the addition too.</p>
        <div class="guide-lab"><div class="guide-row" id="gRow"></div><div id="gOut"></div></div>${goal('order', 'Swap them into the order that deals more damage.')}<p class="guide-note">In the real game, the ← → arrows under each anomaly reorder your build between salvos.</p>`;
      const paint = () => {
        const r = lab().salvo({ ratio: 1, anomalies: row.map(id => ({ id })) });
        el.querySelector('#gRow').innerHTML = row.map((id, i) => `<div class="guide-chip-card"><small>${i + 1}</small><b>${e(anomalyName(id))}</b><span>${e(anomalyText(id))}</span></div>${i === 0 ? '<button type="button" class="guide-btn" id="gSwap">⇄ Swap</button>' : ''}`).join('');
        el.querySelector('#gOut').innerHTML = `${equation(r)}${steps(r)}`;
        el.querySelector('#gSwap').onclick = () => { row = row.reverse(); sound('tap'); paint(); };
        if (row[0] === 'pulsar') complete('rift:order', el);
      };
      paint();
    },
    combo(el) {
      if (!lab()) return noLab(el);
      const palette = ['ion', 'pulsar', 'graviton', 'supernova', 'volatile', 'overclock', 'lens', 'binary', 'singularity', 'railgun', 'tractor', 'lastlight'];
      let row = [], pct = 100, cat = lab().categories[0];
      el.innerHTML = `<p>Now build your own. Pick up to four anomalies, put them in an order, and watch the breakdown. Tip: anomalies that <b>multiply</b> (×) get stronger the more Flux you add before them, and a <b>Gravitational Lens</b> repeats whatever sits on its left.</p>
        <div class="guide-lab"><div class="guide-palette" id="gPal"></div><div class="guide-build" id="gBuild"></div>
        <div class="guide-controls"><label>Score <output id="gPct"></output><input type="range" id="gPctIn" min="50" max="160" step="5" value="100"></label><label>Scenario discipline<select id="gCat">${lab().categories.map(c => `<option>${e(c)}</option>`).join('')}</select></label></div><div id="gOut"></div></div>
        ${goal('combo', 'Deal 3,000 or more damage at exactly 100% score.')}`;
      const paint = () => {
        el.querySelector('#gPal').innerHTML = palette.map(id => `<button type="button" class="guide-pick ${row.includes(id) ? 'on' : ''}" data-id="${id}" title="${e(anomalyText(id))}" ${!row.includes(id) && row.length >= 4 ? 'disabled' : ''}>${e(anomalyName(id))}</button>`).join('');
        el.querySelector('#gBuild').innerHTML = row.length ? row.map((id, i) => `<div class="guide-chip-card"><small>${i + 1}</small><b>${e(anomalyName(id))}</b><span>${e(anomalyText(id))}</span><div><button type="button" class="guide-mini" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move left">←</button><button type="button" class="guide-mini" data-move="${i}" data-dir="1" ${i === row.length - 1 ? 'disabled' : ''} aria-label="Move right">→</button><button type="button" class="guide-mini" data-drop="${i}" aria-label="Remove">×</button></div></div>`).join('') : '<p class="guide-note">Click anomalies above to add them.</p>';
        const r = lab().salvo({ ratio: pct / 100, category: cat, anomalies: row.map(id => ({ id })) });
        el.querySelector('#gPct').textContent = `${pct}%`;
        el.querySelector('#gOut').innerHTML = `<p class="guide-grade ${r.grade}">${gradeName(r.grade)}</p>${equation(r)}${steps(r)}`;
        if (pct === 100 && r.damage >= 3000) complete('rift:combo', el);
      };
      el.addEventListener('click', ev => {
        const p = ev.target.closest('[data-id]'), m = ev.target.closest('[data-move]'), d = ev.target.closest('[data-drop]');
        if (p && !p.disabled) { const id = p.dataset.id; row = row.includes(id) ? row.filter(x => x !== id) : [...row, id]; }
        else if (m && !m.disabled) { const i = Number(m.dataset.move), j = i + Number(m.dataset.dir); [row[i], row[j]] = [row[j], row[i]]; }
        else if (d) row.splice(Number(d.dataset.drop), 1);
        else return;
        sound('tap'); paint();
      });
      el.querySelector('#gPctIn').oninput = ev => { pct = Number(ev.target.value); paint(); };
      el.querySelector('#gCat').onchange = ev => { cat = ev.target.value; paint(); };
      paint();
    },
    hand(el) {
      if (!lab()) return noLab(el);
      const c = lab().categories, build = [{ id: 'railgun' }, { id: 'tidal' }];
      const hand = [c[0], c[2], c[4]], spec = cat => ({ ratio: 1, category: cat, anomalies: build, last: c[2], chain: 2 });
      const dmg = hand.map(cat => lab().salvo(spec(cat)).damage), best = dmg.indexOf(Math.max(...dmg));
      el.innerHTML = `<p>Every fight deals you a <b>hand</b> of three scenarios from different disciplines. The best pick depends on your build. In the real game each card shows a preview, but try it in your head first.</p>
        <div class="guide-scenario"><b>Your build:</b> ${build.map(a => `${e(anomalyName(a.id))} (${e(anomalyText(a.id))})`).join(' · ')}<br><b>Your last two salvos</b> were both ${e(c[2])}.</div>
        <p>Which card hits hardest if you score exactly the reference?</p><div class="guide-cards" id="gCards">${hand.map((cat, i) => `<button type="button" class="guide-card" data-i="${i}"><small>${e(cat)}</small><b>?</b></button>`).join('')}</div><div id="gOut"></div>${goal('hand', 'Pick the strongest card.')}`;
      el.querySelector('#gCards').onclick = ev => {
        const b = ev.target.closest('[data-i]'); if (!b) return;
        const i = Number(b.dataset.i);
        el.querySelectorAll('.guide-card').forEach((x, j) => { x.querySelector('b').textContent = big(dmg[j]); x.classList.toggle('best', j === best); x.classList.toggle('picked', j === i); });
        el.querySelector('#gOut').innerHTML = i === best
          ? `<p class="guide-yes">Right. Tidal Lock gives +4 Flux for every salvo in a row in the same discipline, and you have two. Staying in orbit beat Railgun’s +7.</p>`
          : `<p class="guide-no">Not quite: ${e(hand[best])} deals ${big(dmg[best])}. Tidal Lock adds +4 Flux for each salvo in a row in the same discipline, and your last two were ${e(c[2])}, so it gives +8 there. Try another card.</p>`;
        sound(i === best ? 'ok' : 'error');
        if (i === best) complete('rift:hand', el);
      };
    },
    map(el) {
      const seen = new Set();
      const bodies = [
        { id: 'moon', name: 'Moon', text: 'The smallest hull (×1). Fight it for 3 ✦ and a shop, or skip it for a signal: a free bonus such as +10 ✦, a free anomaly, or an extra salvo next fight.' },
        { id: 'planet', name: 'Planet', text: 'Hull ×1.5. Same choice: fight for 4 ✦ and a shop, or skip for its signal. Skipping saves time but means no shop and no stardust.' },
        { id: 'star', name: 'Star', text: 'The boss: hull ×2, 5 ✦, and it can’t be skipped. Each star has a hazard, shown before you fight. Failing a star ends the voyage, so make sure your build is ready.' },
      ];
      const hazards = [['Brown Dwarf', 'Flux is halved.'], ['Eclipse', 'Your leftmost anomaly is turned off.'], ['Magnetar', 'Every salvo must be the same discipline as your first.'], ['Dead Star', 'No Jumps.'], ['Neutron Star', 'References are 10% higher.'], ['White Dwarf', 'No extra Thrust for beating the reference.'], ['Blue Giant', '1.5× hull, +5 ✦.'], ['Collapsar', 'The final star: after each salvo, your rightmost anomaly turns off.']];
      el.innerHTML = `<p>A voyage is <b>four systems</b>. Each system has three bodies in order. Click each one.</p><div class="guide-bodies">${bodies.map(b => `<button type="button" class="guide-orb ${b.id}" data-b="${b.id}"><i aria-hidden="true"></i><b>${b.name}</b></button>`).join('<span class="guide-arrow" aria-hidden="true">→</span>')}</div><div id="gOut" class="guide-reveal"><p class="guide-note">Pick a body above.</p></div>
        <h4>Star hazards (click to reveal)</h4><div class="guide-flips">${hazards.map(([n, r]) => `<button type="button" class="guide-flip"><b>${e(n)}</b><span>${e(r)}</span></button>`).join('')}</div>
        <p class="guide-note">Losing a moon or planet fight costs 1 hull (you start with 3). Bodies get about 2.5× tougher every system, so you need multipliers, not just additions.</p>${goal('map', 'Look at all three bodies.')}`;
      el.querySelector('.guide-bodies').onclick = ev => {
        const b = ev.target.closest('[data-b]'); if (!b) return;
        const body = bodies.find(x => x.id === b.dataset.b); seen.add(body.id);
        el.querySelectorAll('.guide-orb').forEach(x => x.classList.toggle('on', x === b));
        el.querySelector('#gOut').innerHTML = `<h4>${body.name}</h4><p>${body.text}</p>`; sound('tap');
        if (seen.size === 3) complete('rift:map', el);
      };
      el.querySelector('.guide-flips').onclick = ev => { const f = ev.target.closest('.guide-flip'); if (f) { f.classList.toggle('open'); sound('tap'); } };
    },
    shop(el) {
      let dust = 12;
      el.innerHTML = `<p>Breaking a body pays <b>stardust (✦)</b>: 3, 4 or 5 depending on the body, +1 for every salvo you didn’t need, plus <b>interest</b>: 1 ✦ for every 5 you’re holding, up to 5. Then a shop opens with two anomalies, a star chart and a comet.</p>
        <div class="guide-lab"><label>Stardust you hold when you break a moon <output id="gDust"></output><input type="range" id="gDustIn" min="0" max="40" step="1" value="12"></label><div id="gOut"></div></div>
        <h4>Quick check</h4><p>You hold <b>25 ✦</b>. A shop offers a 6 ✦ anomaly you only sort of want. If you buy it, what happens to your interest at the next clear?</p>
        <div class="guide-cards" id="gQuiz"><button type="button" class="guide-card" data-a="0"><b>Nothing changes</b></button><button type="button" class="guide-card" data-a="1"><b>It drops from 5 ✦ to 3 ✦</b></button><button type="button" class="guide-card" data-a="2"><b>It goes up</b></button></div><div id="gQuizOut"></div>${goal('shop', 'Answer the quick check.')}
        <p class="guide-note">Other shop tricks: rerolling the anomalies costs 3 ✦ and gets 1 ✦ pricier each time in the same shop. You can sell an anomaly from your build for half its price.</p>`;
      const paint = () => {
        const interest = Math.min(5, Math.floor(dust / 5)), total = 3 + 1 + interest;
        el.querySelector('#gDust').textContent = `${dust} ✦`;
        el.querySelector('#gOut').innerHTML = `<div class="guide-payout"><div><span>Moon broken</span><b>+3 ✦</b></div><div><span>1 salvo unspent</span><b>+1 ✦</b></div><div><span>Interest (${dust} ÷ 5, max 5)</span><b>+${interest} ✦</b></div><div class="sum"><span>Cash out</span><b>+${total} ✦</b></div></div>`;
      };
      el.querySelector('#gDustIn').oninput = ev => { dust = Number(ev.target.value); paint(); };
      el.querySelector('#gQuiz').onclick = ev => {
        const b = ev.target.closest('[data-a]'); if (!b) return;
        const ok = b.dataset.a === '1';
        el.querySelector('#gQuizOut').innerHTML = ok ? '<p class="guide-yes">Right: 25 ✦ pays 5 interest; 19 ✦ only pays 3. Spending is fine when it makes you stronger, but every 5 ✦ you sit on earns 1 more.</p>' : '<p class="guide-no">Not quite. Interest is 1 ✦ per 5 you hold. 25 ✦ pays 5, but after spending 6 you hold 19, which pays 3.</p>';
        sound(ok ? 'ok' : 'error'); if (ok) complete('rift:shop', el);
      };
      paint();
    },
    real(el) {
      el.innerHTML = `<p>Here is exactly what happens when you fight for real:</p><ol class="guide-flow">
        <li><b>Engage</b> a moon, planet or star from the system map.</li>
        <li>Read your <b>hand</b>. Each card shows what it would deal if you score exactly the reference, and says <b>BREAKS IT</b> if that’s enough to win.</li>
        <li>Not happy with a card? Press <b>Jump</b> to swap it (you get a few per fight).</li>
        <li>Press <b>Play ↗</b>. KovaaK’s opens that scenario. Apogee is now listening.</li>
        <li>Play one <b>complete</b> run. Quitting halfway doesn’t count, and neither do runs started before you pressed Play.</li>
        <li>Come back to Apogee. The result appears by itself, with your score turned into Thrust × Flux and every anomaly lighting up as it fires.</li>
        <li>Keep going until the body breaks or you run out of salvos.</li></ol>
        <p class="guide-note">You can close Apogee mid-fight. A run you finish while a salvo is armed is picked up next time you open it.</p>
        <div class="guide-actions"><button type="button" class="guide-btn primary" id="gGo">Got it, open the Rift ↗</button><button type="button" class="guide-btn" id="gTour">Show me around the Rift screen</button></div>`;
      el.querySelector('#gGo').onclick = () => { complete('rift:real', el); close(); openScreen('rift'); };
      el.querySelector('#gTour').onclick = () => { complete('rift:real', el); tour('rift'); };
    },
  };

  /* ---------- The dialog ---------- */
  let dialog, nav, body, current = 'welcome';
  function build() {
    dialog = document.createElement('dialog');
    dialog.id = 'apogeeGuide'; dialog.className = 'guide'; dialog.setAttribute('aria-labelledby', 'guideTitle');
    dialog.innerHTML = `<div class="guide-shell"><aside class="guide-nav" aria-label="Guide chapters"></aside><main class="guide-main"><button type="button" class="guide-close" aria-label="Close the guide">×</button><div class="guide-body" tabindex="-1"></div></main></div>`;
    document.body.append(dialog);
    nav = dialog.querySelector('.guide-nav'); body = dialog.querySelector('.guide-body');
    dialog.querySelector('.guide-close').onclick = close;
    dialog.addEventListener('click', ev => { if (ev.target === dialog) close(); });
    nav.addEventListener('click', ev => { const b = ev.target.closest('[data-go]'); if (b) show(b.dataset.go); });
    body.addEventListener('click', ev => {
      const go = ev.target.closest('[data-go]'), open = ev.target.closest('[data-open]'), t = ev.target.closest('[data-tour]');
      if (go) show(go.dataset.go);
      else if (open) { close(); openScreen(open.dataset.open); }
      else if (t) tour(t.dataset.tour);
    });
  }
  const icon = screen => document.querySelector(`.tab[data-screen="${screen}"] svg`)?.outerHTML || '';
  function paintNav() {
    if (!nav) return;
    const item = (id, label, extra = '') => `<button type="button" data-go="${id}" class="${current === id ? 'on' : ''}" ${current === id ? 'aria-current="page"' : ''}>${extra}<span>${e(label)}</span>${store.done[id] ? '<i class="guide-tick" aria-label="done">✓</i>' : ''}</button>`;
    const groups = ['Practice', 'Compete', 'Progress'].map(g => `<h3>${g}</h3>${MODES.filter(m => m.group === g && document.querySelector(`.tab[data-screen="${m.screen}"]`)).map(m => item('mode:' + m.screen, m.name, `<span class="guide-ico" aria-hidden="true">${icon(m.screen)}</span>`)).join('')}`).join('');
    nav.innerHTML = `<div class="guide-brand"><b>Guide</b><small>Everything Apogee, one step at a time</small></div><h3>Start here</h3>${item('welcome', 'Welcome')}${item('finder', 'Find your mode')}<h3>Rift Academy <small>${doneCount()}/${LESSONS.length}</small></h3>${item('rift', 'Overview')}${LESSONS.map((l, i) => item('rift:' + l.id, `${i + 1}. ${l.title}`)).join('')}${groups}<h3>Reference</h3>${item('glossary', 'Glossary')}`;
  }
  function welcome() {
    const status = document.getElementById('statusText')?.textContent?.trim() || '';
    return `<span class="guide-eyebrow">WELCOME TO APOGEE</span><h2 id="guideTitle">Aim training that keeps score for you.</h2>
      <p class="guide-lede">Apogee sits beside KovaaK’s. You play normally; Apogee reads each finished run from KovaaK’s stats folder and turns it into progress, games and ranked matches. You never type in a score.</p>
      <div class="guide-three"><div><b>1</b><h4>Connect your stats folder</h4><p>Apogee finds it automatically in most cases.${status ? ` Right now the top bar says: <em>${e(status)}</em>.` : ''}</p><button type="button" class="guide-link" data-tour="folder">Show me where →</button></div>
      <div><b>2</b><h4>Play KovaaK’s like normal</h4><p>Every run you finish is picked up within a few seconds, whether you launched it from Apogee or not.</p></div>
      <div><b>3</b><h4>Pick a mode</h4><p>Practice, solo games, ranked matches, or just your stats. The rail on the left lists them all.</p><button type="button" class="guide-link" data-go="finder">Help me choose →</button></div></div>
      <div class="guide-actions"><button type="button" class="guide-btn primary" data-tour="basics">Take the 1-minute tour ↗</button><button type="button" class="guide-btn" data-go="finder">What should I play?</button><button type="button" class="guide-btn" data-go="rift">Learn the Rift</button></div>
      <p class="guide-note">Open this guide any time with the <b>Guide</b> button in the top bar, or press <kbd>?</kbd>.</p>`;
  }
  let goalPick = null;
  function finder() {
    const g = GOALS.find(x => x.id === goalPick);
    return `<span class="guide-eyebrow">FIND YOUR MODE</span><h2 id="guideTitle">What are you in the mood for?</h2><div class="guide-goals">${GOALS.map(x => `<button type="button" class="guide-goalbtn ${goalPick === x.id ? 'on' : ''}" data-goal="${x.id}">${e(x.label)}</button>`).join('')}</div>
      ${g ? `<p class="guide-lede">${e(g.why)}</p><div class="guide-modes">${g.modes.map(s => MODES.find(m => m.screen === s)).filter(m => m && document.querySelector(`.tab[data-screen="${m.screen}"]`)).map(modeCard).join('')}</div>` : '<p class="guide-note">Pick one and you’ll get two to four modes that fit, each with a one-click tour.</p>'}`;
  }
  function modeCard(m) {
    return `<article class="guide-mode"><header><span class="guide-ico" aria-hidden="true">${icon(m.screen)}</span><h4>${e(m.name)}</h4></header><p>${e(m.what)}</p><div class="guide-actions">${m.academy ? `<button type="button" class="guide-btn primary" data-go="rift">Rift Academy</button>` : ''}<button type="button" class="guide-btn ${m.academy ? '' : 'primary'}" data-tour="${m.screen}">Show me ↗</button><button type="button" class="guide-btn" data-go="mode:${m.screen}">Learn more</button></div></article>`;
  }
  function modePage(m) {
    return `<span class="guide-eyebrow">${e(m.group.toUpperCase())}</span><h2 id="guideTitle"><span class="guide-ico big" aria-hidden="true">${icon(m.screen)}</span>${e(m.name)}</h2><p class="guide-lede">${e(m.what)}</p>
      <h4>How it works</h4><ol class="guide-flow">${m.how.map(x => `<li>${e(x)}</li>`).join('')}</ol>${m.tip ? `<p class="guide-tip"><b>Tip:</b> ${e(m.tip)}</p>` : ''}
      <div class="guide-actions">${m.academy ? `<button type="button" class="guide-btn primary" data-go="rift">Start the Rift Academy</button>` : ''}<button type="button" class="guide-btn ${m.academy ? '' : 'primary'}" data-tour="${m.screen}">Show me around ↗</button><button type="button" class="guide-btn" data-open="${m.screen}">Just open it</button></div>`;
  }
  function riftOverview() {
    return `<span class="guide-eyebrow">RIFT ACADEMY</span><h2 id="guideTitle">Learn the Rift in about ten minutes.</h2><p class="guide-lede">Seven short lessons. Each one is hands-on and uses the game’s real damage engine, so what you see here is exactly what happens in a voyage.</p>
      <div class="guide-progress"><i style="width:${doneCount() / LESSONS.length * 100}%"></i></div><p class="guide-note">${doneCount()} of ${LESSONS.length} done</p>
      <ol class="guide-lessons">${LESSONS.map((l, i) => `<li><button type="button" data-go="rift:${l.id}" class="${store.done['rift:' + l.id] ? 'done' : ''}"><b>${i + 1}</b><span><strong>${e(l.title)}</strong><small>${e(l.short)}</small></span><i>${store.done['rift:' + l.id] ? '✓' : '→'}</i></button></li>`).join('')}</ol>
      <div class="guide-actions"><button type="button" class="guide-btn primary" data-go="rift:${(LESSONS.find(l => !store.done['rift:' + l.id]) || LESSONS[0]).id}">${doneCount() ? 'Continue' : 'Start lesson 1'} →</button><button type="button" class="guide-btn" data-tour="rift">Tour the Rift screen ↗</button></div>`;
  }
  function glossary() {
    return `<span class="guide-eyebrow">REFERENCE</span><h2 id="guideTitle">Glossary</h2><input type="search" class="guide-search" id="gSearch" placeholder="Search a word, like Flux or Crown" aria-label="Search the glossary"><dl class="guide-gloss" id="gGloss">${GLOSSARY.map(([t, d]) => `<div><dt>${e(t)}</dt><dd>${e(d)}</dd></div>`).join('')}</dl>`;
  }
  function show(id) {
    current = id; goalPick = id === 'finder' ? goalPick : null;
    paintNav();
    if (id === 'welcome') body.innerHTML = welcome();
    else if (id === 'finder') body.innerHTML = finder();
    else if (id === 'rift') body.innerHTML = riftOverview();
    else if (id === 'glossary') body.innerHTML = glossary();
    else if (id.startsWith('mode:')) body.innerHTML = modePage(MODES.find(m => m.screen === id.slice(5)) || MODES[0]);
    else if (id.startsWith('rift:')) {
      const i = LESSONS.findIndex(l => 'rift:' + l.id === id), l = LESSONS[i];
      body.innerHTML = `<span class="guide-eyebrow">RIFT ACADEMY · LESSON ${i + 1} OF ${LESSONS.length}</span><h2 id="guideTitle">${e(l.title)}</h2><div class="guide-lesson"></div><div class="guide-pager">${i > 0 ? `<button type="button" class="guide-btn" data-go="rift:${LESSONS[i - 1].id}">← ${e(LESSONS[i - 1].title)}</button>` : '<span></span>'}${i < LESSONS.length - 1 ? `<button type="button" class="guide-btn primary" data-go="rift:${LESSONS[i + 1].id}">Next: ${e(LESSONS[i + 1].title)} →</button>` : '<button type="button" class="guide-btn primary" data-go="rift">Back to the overview</button>'}</div>`;
      LESSON_VIEWS[l.id](body.querySelector('.guide-lesson'));
    }
    if (id === 'finder') body.querySelectorAll('[data-goal]').forEach(b => b.onclick = () => { goalPick = b.dataset.goal; show('finder'); });
    if (id === 'glossary') body.querySelector('#gSearch').oninput = ev => {
      const q = ev.target.value.trim().toLowerCase();
      body.querySelectorAll('#gGloss>div').forEach(d => { d.hidden = !!q && !d.textContent.toLowerCase().includes(q); });
    };
    if (id.startsWith('mode:')) { store.done[id] = true; save(); paintNav(); }
    body.scrollTop = 0; body.focus({ preventScroll: true });
  }
  function open(id = 'welcome') {
    if (!dialog) build();
    endTour();
    hideNudge();
    if (!dialog.open) dialog.showModal();
    show(id);
  }
  function close() { if (dialog?.open) dialog.close(); }
  function openScreen(name) { document.querySelector(`.tab[data-screen="${name}"]`)?.click(); }

  /* ---------- Spotlight tours ---------- */
  const TOURS = {
    basics: [
      { target: '.nav', title: 'Every mode lives here', body: 'Practice at the top, Compete in the middle, Progress at the bottom. The number beside each one is a shortcut: press 1 to 9 to jump there.' },
      { target: '#status', title: 'Your stats folder', body: 'This shows whether Apogee can see KovaaK’s stats folder. Click it to rescan or to choose a different folder.' },
      { target: '#arcadeJump', title: 'Jump anywhere', body: 'Press Ctrl K and type a mode’s name. Fastest way around.' },
      { target: '#soundStudio', title: 'Sound', body: 'Volume and previews. Press M to mute.' },
      { target: '#theme', title: 'Make it yours', body: 'Colour themes for the whole app.' },
      { target: '#guideButton', title: 'Lost? Come back here', body: 'The Guide is always one click away. You can also press ?.' },
    ],
    folder: [{ target: '#status', title: 'Your stats folder', body: 'This pill shows whether Apogee is reading KovaaK’s stats folder. Click it: you can rescan now, choose the folder yourself, or open it in Explorer.' }],
    rift: [
      { screen: 'rift', target: '.tab[data-screen="rift"]', title: 'The Rift', body: 'A roguelite played through real KovaaK’s runs. Your voyage is saved, so you can leave and come back any time.' },
      { screen: 'rift', target: '.rift-how', title: 'The whole game in four boxes', body: 'Pick a target, turn your score into Thrust × Flux, break the body, and build anomalies that multiply.' },
      { screen: 'rift', target: '.rift-kits', title: 'Choose a vessel', body: 'Each vessel starts differently. The Drifter is the most forgiving for a first voyage.' },
      { screen: 'rift', target: '#riftBand', title: 'Choose a difficulty', body: 'This picks which scenarios you play and their reference scores. Choose the band you normally train in.' },
      { screen: 'rift', target: '.rift-hud', title: 'Your voyage at a glance', body: 'System (1 to 4), hull (lose it all and the voyage ends), stardust to spend, and your best single hit.' },
      { screen: 'rift', target: '.rift-track', title: 'Moon → Planet → Star', body: 'Each system is three fights in order. The star is the boss.' },
      { screen: 'rift', target: '.rift-bodies', title: 'Fight or skip', body: 'Engage to fight for stardust and a shop, or skip a moon or planet for its signal.' },
      { screen: 'rift', target: '.rift-hand', title: 'Your hand', body: 'Three scenarios. The big number is what each would deal at exactly the reference. Press Play to launch it in KovaaK’s, or Jump to swap it.' },
      { screen: 'rift', target: '.rift-listening-card', title: 'Listening', body: 'Apogee is waiting for one complete run of this scenario. Finish it in KovaaK’s and come back.' },
      { screen: 'rift', target: '.rift-equation', title: 'The result', body: 'Thrust × Flux = Damage, then every step that got you there. Anomalies light up as they fire.' },
      { screen: 'rift', target: '.rift-shop', title: 'The shop', body: 'Buy anomalies, star charts and comets. Unspent stardust earns interest.' },
      { screen: 'rift', target: '.rift-rail', title: 'Your build', body: 'Anomalies fire left to right. Use the arrows to reorder and Sell to make room. Comets and charts sit on the right.' },
      { screen: 'rift', target: '.rift-planets', title: 'Planets', body: 'One per discipline. Star charts level them up for more Thrust and Flux whenever you play that discipline.' },
      { screen: 'rift', target: '.rift-coach', title: 'Hints as you play', body: 'This line always tells you what to do next. You can turn hints off here once you’re comfortable.' },
    ],
  };
  function modeTour(screen) {
    const m = MODES.find(x => x.screen === screen);
    if (!m) return [];
    return [
      { screen, target: `.tab[data-screen="${screen}"]`, title: m.name, body: m.what },
      { screen, target: `#screen-${screen}`, title: 'How it works', body: m.how.map((h, i) => `${i + 1}. ${h}`).join('\n') },
      ...(m.tip ? [{ screen, target: '#guideButton', title: 'Tip', body: m.tip + ' The Guide has more on every mode.' }] : []),
    ];
  }
  let layer = null, stops = [], at = 0, tourId = '';
  function tour(id) {
    close();
    stops = (TOURS[id] || modeTour(id)).slice(); at = 0; tourId = id;
    if (!stops.length) return;
    if (!layer) {
      layer = document.createElement('div'); layer.className = 'guide-tour'; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true'); layer.setAttribute('aria-labelledby', 'guideTourTitle');
      layer.innerHTML = '<div class="guide-spot" aria-hidden="true"></div><div class="guide-pop"><small></small><h3 id="guideTourTitle"></h3><p></p><div class="guide-pop-actions"><button type="button" data-t="skip" class="guide-btn ghost">End tour</button><span></span><button type="button" data-t="back" class="guide-btn">Back</button><button type="button" data-t="next" class="guide-btn primary">Next</button></div></div>';
      document.body.append(layer);
      layer.addEventListener('click', ev => { const b = ev.target.closest('[data-t]'); if (!b) return; if (b.dataset.t === 'skip') endTour(); else step(b.dataset.t === 'next' ? 1 : -1); });
      window.addEventListener('resize', place); document.addEventListener('scroll', place, true);
    }
    layer.hidden = false; document.body.classList.add('guide-touring');
    step(0);
  }
  /** Steps whose target is not on screen right now (a voyage that has not started yet, say) are passed over. */
  function step(dir) {
    if (dir === 0) at = 0; else at += dir;
    const want = dir < 0 ? -1 : 1;
    const resolve = () => {
      while (at >= 0 && at < stops.length) {
        const s = stops[at];
        if (s.screen && document.body.dataset.screen !== s.screen) openScreen(s.screen);
        const el = document.querySelector(s.target);
        if (el && el.getClientRects().length) return el;
        at += want;
      }
      return null;
    };
    const el = resolve();
    if (!el) { if (at >= stops.length) { store.done['tour:' + tourId] = true; save(); } endTour(); return; }
    const s = stops[at], shown = stops.filter(x => document.querySelector(x.target)?.getClientRects().length).length;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    layer.querySelector('small').textContent = `${stops.slice(0, at + 1).filter(x => document.querySelector(x.target)?.getClientRects().length).length} of ${shown}`;
    layer.querySelector('h3').textContent = s.title;
    layer.querySelector('p').textContent = s.body;
    layer.querySelector('[data-t="back"]').disabled = !stops.slice(0, at).some(x => document.querySelector(x.target)?.getClientRects().length);
    const last = !stops.slice(at + 1).some(x => document.querySelector(x.target)?.getClientRects().length);
    layer.querySelector('[data-t="next"]').textContent = last ? 'Finish' : 'Next';
    layer.dataset.target = s.target;
    place(); sound('nav');
    layer.querySelector('[data-t="next"]').focus({ preventScroll: true });
  }
  function place() {
    if (!layer || layer.hidden) return;
    const el = document.querySelector(layer.dataset.target); if (!el) return;
    const r = el.getBoundingClientRect(), pad = 6, spot = layer.querySelector('.guide-spot'), pop = layer.querySelector('.guide-pop');
    const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad), w = Math.min(innerWidth - left - 4, r.width + pad * 2), h = Math.min(innerHeight - top - 4, r.height + pad * 2);
    Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${w}px`, height: `${h}px` });
    const pw = Math.min(360, innerWidth - 24), ph = pop.offsetHeight || 180;
    let pt = top + h + 12, pl = Math.min(Math.max(12, left), innerWidth - pw - 12);
    if (pt + ph > innerHeight - 12) pt = top - ph - 12;
    if (pt < 12) { pt = Math.min(innerHeight - ph - 12, Math.max(12, top + 12)); pl = left + w + 12 + pw < innerWidth ? left + w + 12 : Math.max(12, left - pw - 12); }
    Object.assign(pop.style, { top: `${pt}px`, left: `${pl}px`, width: `${pw}px` });
  }
  function endTour() { if (layer) layer.hidden = true; document.body.classList.remove('guide-touring'); }
  document.addEventListener('keydown', ev => {
    if (layer && !layer.hidden) {
      if (ev.key === 'Escape') { ev.preventDefault(); endTour(); }
      else if (ev.key === 'ArrowRight' || ev.key === 'Enter' && !ev.target.closest('button')) { ev.preventDefault(); step(1); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
      ev.stopImmediatePropagation();
      return;
    }
    const typing = ev.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if (ev.key === '?' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); open(dialog?.open ? current : 'welcome'); }
  }, true);

  /* ---------- Entry points ---------- */
  let nudge = null;
  function hideNudge() { if (nudge) nudge.hidden = true; if (!store.nudged) { store.nudged = true; save(); } }
  function offer() {
    if (store.nudged || document.body.dataset.preview === 'static') return;
    nudge = document.createElement('div'); nudge.className = 'guide-nudge'; nudge.setAttribute('role', 'status');
    nudge.innerHTML = '<b>New to Apogee?</b><span>A quick guide to every mode, plus hands-on Rift lessons.</span><div><button type="button" class="guide-btn primary" data-n="open">Open the guide</button><button type="button" class="guide-btn ghost" data-n="later">Not now</button></div>';
    nudge.onclick = ev => { const b = ev.target.closest('[data-n]'); if (!b) return; if (b.dataset.n === 'open') open('welcome'); else hideNudge(); };
    document.body.append(nudge);
  }
  const topbar = document.querySelector('.topbar-right');
  if (topbar && !document.getElementById('guideButton')) {
    const b = document.createElement('button'); b.type = 'button'; b.id = 'guideButton'; b.className = 'guide-open'; b.title = 'Guide · press ?';
    b.innerHTML = '<span aria-hidden="true">?</span> Guide'; b.onclick = () => open(current === 'welcome' ? 'welcome' : current);
    topbar.prepend(b);
  }
  window.ApogeeGuide = {
    open, close, tour,
    hints: () => store.hints !== false,
    setHints: on => { store.hints = !!on; save(); },
    lessonFor: phase => ({ map: 'rift:map', combat: 'rift:hand', result: 'rift:order', shop: 'rift:shop' })[phase] || 'rift',
  };
  setTimeout(offer, 1200);
})();
