/* Crowns: a view of what list-crowns serves, and the result of a Crown challenge.
 *
 * Main makes every call (src/app/arena.ts) and the server decides every Crown in SQL. This
 * file draws the board, sends "challenge this one", marks notices read, and shows what a
 * settled challenge came to. It computes no result. The one thing it works out is
 * presentation: how long ago and how long until, from the times the board carries.
 *
 * The race panel and the live bar live in race.js and draw into their own containers.
 */
(() => {
  const root = document.getElementById('crownsRoot');
  if (!root) return;
  const bridge = window.apogee || {};
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v * 100).toFixed(1)}%` : '–');
  const tone = (v) => (!Number.isFinite(v) ? '' : v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : '');
  const span = (ms) => {
    const m = Math.max(1, Math.round(ms / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
    return `${mm}m`;
  };
  const GLYPH = (held, cls = '') => `<svg class="cr-glyph ${held ? 'held' : ''} ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path class="body" d="M4 17.5h16L21 7l-5 4.2L12 4.5 8 11.2 3 7Z"/><path d="M4 20.5h16"/></svg>`;

  root.innerHTML = `
    <div class="screen-head cr-head">
      <div>
        <div class="mode-tag">Compete · Unrated</div>
        <h1>Crowns</h1>
        <p>One Crown for each category and band. Play its three scenarios; beat the holder's score against your own baselines and it is yours until somebody beats you. Nothing is rated.</p>
      </div>
      <svg class="cr-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" aria-hidden="true"><path d="M4 17.5h16L21 7l-5 4.2L12 4.5 8 11.2 3 7Z"/><path d="M4 20.5h16"/></svg>
    </div>
    <div class="cr-notices" id="crNotices"></div>
    <div data-arena-live></div>
    <div class="cr-status" id="crStatus" role="status" aria-live="polite"></div>
    <div id="crBoard"></div>
    <div id="raceRoot"></div>`;

  const els = {
    notices: root.querySelector('#crNotices'),
    status: root.querySelector('#crStatus'),
    board: root.querySelector('#crBoard'),
  };

  let board = null;
  let error = '';
  let busy = null;
  let open = null;
  let received = Date.now();
  const dismissed = new Set();
  let announced = false;

  const now = () => (board ? Date.parse(board.now) + (Date.now() - received) : Date.now());

  function say(text, bad = false) {
    els.status.textContent = text || '';
    els.status.classList.toggle('bad', !!bad);
  }

  function badge() {
    // Inside the label: the tab is a three-column grid (icon, label, shortcut key), and a
    // fourth child wrapped the shortcut onto a line of its own.
    const tab = document.querySelector('.tab[data-screen="crowns"] .tab-label');
    if (!tab) return;
    let el = tab.querySelector('.cr-badge');
    const unread = (board?.notices || []).filter((n) => !dismissed.has(n.id)).length;
    if (!unread) { el?.remove(); return; }
    if (!el) { el = document.createElement('span'); el.className = 'cr-badge'; tab.append(el); }
    el.textContent = String(unread);
    el.setAttribute('aria-label', `${unread} unread Crown notice${unread === 1 ? '' : 's'}`);
  }

  // ---- notices ---------------------------------------------------------------------

  function renderNotices() {
    const list = (board?.notices || []).filter((n) => !dismissed.has(n.id));
    els.notices.innerHTML = list.map((n) => {
      const crown = (board.crowns || []).find((c) => c.category === n.category && c.window === n.window);
      const back = n.kind === 'dethroned' && crown && (crown.action.kind === 'challenge' || crown.action.kind === 'claim');
      return `<article class="cr-notice ${e(n.kind)}">
        ${GLYPH(n.kind !== 'dethroned')}
        <div><p>${e(n.text)}</p><small>${e(new Date(n.createdAt).toLocaleString())}</small></div>
        <div class="cr-notice-actions">
          ${back ? `<button type="button" class="cr-btn primary" data-cr="challenge" data-category="${e(crown.category)}" data-window="${crown.window}">${crown.action.kind === 'claim' ? 'Claim it back' : 'Challenge back'}</button>` : ''}
          <button type="button" class="cr-btn quiet" data-cr="dismiss" data-id="${e(n.id)}">Dismiss</button>
        </div>
      </article>`;
    }).join('');
  }

  // ---- the board -------------------------------------------------------------------

  function actionButton(c) {
    const a = c.action;
    const label = busy === c.key ? 'Opening…' : a.label;
    switch (a.kind) {
      case 'challenge':
      case 'claim':
        return `<button type="button" class="cr-btn ${a.kind === 'challenge' ? 'primary' : ''}" data-cr="challenge" data-category="${e(c.category)}" data-window="${c.window}" ${busy ? 'disabled' : ''}>${e(label)}</button>`;
      case 'playing':
        return `<button type="button" class="cr-btn primary" data-cr="go-match">Go to your challenge</button>`;
      case 'cooldown':
        return `<button type="button" class="cr-btn" disabled title="One challenge per Crown every ${board.rules.cooldownHours} hours">Again in ${e(span(Date.parse(a.availableAt) - now()))}</button>`;
      default:
        return `<button type="button" class="cr-btn" disabled>${e(a.label)}</button>`;
    }
  }

  function card(c) {
    const held = c.status === 'held';
    const ends = c.reignEndsAt ? Date.parse(c.reignEndsAt) - now() : null;
    const detail = open === c.key;
    const history = (c.history || []).map((h) => `<li>${e(h.holder)} · ${e(pct(h.bar))} · ${h.defences} defence${h.defences === 1 ? '' : 's'} · ${
      h.endReason === 'dethroned' ? `taken by ${e(h.endedBy || 'a challenger')}` : h.endReason === 'lapsed' ? 'held to the 7-day limit' : 'reset'}</li>`).join('');
    return `<article class="cr-card ${held ? 'held' : 'vacant'} ${c.holder?.you ? 'yours' : ''} ${c.action.kind === 'playing' ? 'playing' : ''}" data-key="${e(c.key)}" aria-label="${e(c.name)}">
      <div class="cr-card-top">${GLYPH(held)}<span>${e(c.band)}</span>${c.live > 0 ? `<span class="cr-pill live" title="Challenges being played now">${c.live} playing</span>` : ''}</div>
      <div class="cr-holder" title="${e(c.holder?.name || 'Vacant')}">${held ? e(c.holder.name) + (c.holder.you ? ' (you)' : '') : 'Vacant'}</div>
      ${held
        ? `<div class="cr-bar"><b class="${tone(c.bar)}">${e(pct(c.bar))}</b><span>to beat</span></div>
           <div class="cr-meta"><strong>${e(span(now() - Date.parse(c.heldSince)))}</strong> held · <strong>${c.defences}</strong> defence${c.defences === 1 ? '' : 's'}<br>
             <span class="cr-pill ${c.tier === 'verified' ? 'verified' : ''}" title="The weakest verification tier among the holder's three runs">${c.tier === 'verified' ? 'Verified' : 'Consistent'}</span>${c.provisional ? ' <span class="cr-pill" title="At least one round used a provisional baseline">provisional</span>' : ''}
             ${ends != null && ends > 0 ? ` · lapses in ${e(span(ends))}` : ''}</div>`
        : `<div class="cr-meta">${c.scenarios ? 'Three drawn for this cycle. The first qualifying run set to settle takes it.' : 'Nothing drawn yet. The first claim draws its three.'}</div>`}
      ${actionButton(c)}
      <button type="button" class="cr-more" data-cr="toggle" aria-expanded="${detail}">${detail ? 'Less' : 'Scenarios and history'}</button>
      ${detail ? `<div class="cr-detail">
        <span class="k">Scenarios</span>
        ${c.scenarios ? `<ol>${c.scenarios.map((s) => `<li>${e(s)}</li>`).join('')}</ol>` : '<span>Drawn by the first claim.</span>'}
        <span class="k">Previous holders</span>
        ${history ? `<ul>${history}</ul>` : '<span>None yet.</span>'}
      </div>` : ''}
    </article>`;
  }

  function renderBoard() {
    if (error && !board) {
      els.board.innerHTML = `<div class="cr-empty"><strong>Crowns are not available</strong>${e(error)}</div>`;
      return;
    }
    if (!board) {
      els.board.innerHTML = `<div class="cr-empty"><strong>Loading the Crowns</strong>Reading who holds what.</div>`;
      return;
    }
    const bands = board.bands || [];
    const head = `<div class="cr-row head" style="--bands:${bands.length}"><span></span>${bands.map((b) => `<span>${e(b.name)}</span>`).join('')}</div>`;
    const rows = (board.categories || []).map((cat) => {
      const cells = bands.map((b) => {
        const c = board.crowns.find((x) => x.category === cat && x.window === b.index);
        return c ? card(c) : '<div></div>';
      }).join('');
      return `<div class="cr-row" style="--bands:${bands.length}"><div class="cr-cat">${e(cat)}</div>${cells}</div>`;
    }).join('');
    const held = board.crowns.filter((c) => c.status === 'held').length;
    els.board.innerHTML = `<div class="cr-board" role="list" aria-label="Crowns by category and band">${head}${rows}</div>
      <p class="cr-rules"><b>${held} of ${board.crowns.length}</b> Crowns held${board.holding ? `, <b>${board.holding}</b> by you` : ''}.
        A challenger needs a higher match score than the holder; a draw is a defence. Every run must be Verified or Consistent.
        One challenge per Crown every ${e(board.rules.cooldownHours)} hours. A reign lasts at most ${e(board.rules.reignCapDays)} days, then the Crown falls vacant on three new scenarios.</p>`;
  }

  function render() {
    renderNotices();
    renderBoard();
    badge();
  }

  // ---- the result of a challenge ---------------------------------------------------

  function showResult(settled) {
    const note = settled?.arena;
    const host = document.querySelector('#screen-result .panel');
    document.getElementById('arenaResult')?.remove();
    if (!note || !host) return;
    const crown = note.crown;
    const el = document.createElement('div');
    el.id = 'arenaResult';
    const kind = crown ? crown.outcome : note.race?.verdict === 'win' ? 'took' : 'race';
    el.className = `cr-result ${e(kind)}`;
    const figures = crown && crown.challengerScore != null
      ? `<span class="cr-figures">you ${e(pct(crown.challengerScore))}${crown.holderScore != null ? ` · ${e(crown.holderName || 'holder')} ${e(pct(crown.holderScore))}` : ''}${crown.defences != null && crown.outcome === 'defended' ? ` · ${crown.defences} defence${crown.defences === 1 ? '' : 's'} this reign` : ''}</span>`
      : '';
    el.innerHTML = `${GLYPH(kind === 'took')}
      <h3>${e(note.headline)}</h3>
      <p>${e(note.explanation)}</p>
      ${figures}
      <div class="cr-result-actions"><button type="button" class="cr-btn ${kind === 'took' ? 'primary' : ''}" data-cr-open>${crown ? 'See the Crowns' : 'Race again'}</button></div>`;
    el.querySelector('[data-cr-open]').addEventListener('click', () => {
      if (typeof window.openScreen === 'function') window.openScreen('crowns');
      else document.querySelector('.tab[data-screen="crowns"]')?.click();
    });
    const explain = host.querySelector('#explain');
    (explain?.nextSibling ? host.insertBefore(el, explain.nextSibling) : host.append(el));
  }

  // ---- actions ---------------------------------------------------------------------

  async function challenge(category, windowIndex) {
    if (!bridge.challengeCrown) { say('Crowns need the desktop app.', true); return; }
    busy = `${category}|${windowIndex}`;
    say('');
    render();
    try {
      const result = await bridge.challengeCrown(category, windowIndex);
      if (result?.error) { say(result.error, true); return; }
      const m = result.match;
      say(m.crown?.claim
        ? `Claiming the ${m.crown.name}. Play the three on the Play screen; the first qualifying run set to settle takes it.`
        : `Challenging ${m.crown?.holderName || 'the holder'} for the ${m.crown?.name || 'Crown'}. Beat ${pct(m.crown?.bar)} against your own baselines.`);
      if (typeof window.openScreen === 'function') window.openScreen('queue');
    } finally {
      busy = null;
      render();
    }
  }

  root.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-cr]');
    if (!t) return;
    const what = t.dataset.cr;
    if (what === 'challenge') await challenge(t.dataset.category, Number(t.dataset.window));
    else if (what === 'toggle') { const key = t.closest('[data-key]')?.dataset.key; open = open === key ? null : key; renderBoard(); }
    else if (what === 'go-match') { if (typeof window.openScreen === 'function') window.openScreen('queue'); }
    else if (what === 'dismiss') {
      dismissed.add(t.dataset.id);
      render();
      const r = await bridge.crowns?.([t.dataset.id]);
      if (r?.error) say(r.error, true);
    }
  });

  // ---- data ------------------------------------------------------------------------

  function take(next) {
    if (!next) { board = null; error = 'Sign in with Steam to play for Crowns.'; render(); return; }
    board = next;
    received = Date.now();
    error = '';
    // "Challenging Kestrel for..." is about a challenge being played; once the board shows
    // none, the sentence is history.
    if (!(board.crowns || []).some((c) => c.action.kind === 'playing') && !busy) say('');
    render();
    // The comeback loop: say it on whatever screen the client opened to, once a session.
    const fresh = (board.notices || []).find((n) => n.kind === 'dethroned' && !dismissed.has(n.id));
    if (fresh && !announced && document.body.dataset.screen !== 'crowns' && typeof window.showNotice === 'function') {
      announced = true;
      window.showNotice(`${fresh.text} Open Crowns to challenge back.`);
    }
  }

  bridge.onCrowns?.((next) => take(next));
  bridge.onMatchSettled?.((settled) => showResult(settled));
  // A minute is the finest unit any countdown here shows.
  setInterval(() => { if (board && document.body.dataset.screen === 'crowns') renderBoard(); }, 30_000);

  (async () => {
    if (!bridge.crowns) { error = 'Crowns need the desktop app and a signed-in account.'; render(); return; }
    const r = await bridge.crowns();
    if (r?.error) { error = r.error; render(); return; }
    take(r.board);
  })();
})();
