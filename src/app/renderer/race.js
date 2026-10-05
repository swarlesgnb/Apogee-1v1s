/* Live races and the live bar: a view of what race-status serves.
 *
 * Three pieces, all drawn from main's pushes (src/app/arena.ts):
 *
 *   the race panel   on the Crowns screen: invite somebody to race now, answer an
 *                    invitation, see the race being played and the last few results
 *   the toast        an invitation arriving while you are on any other screen
 *   the live bar     the tug-of-war, drawn into every [data-arena-live] container: one at
 *                    the top of the Crowns screen and one put into the match panel while a
 *                    race leg or a Crown challenge is being played
 *
 * The server applies the sealed rule (the other side's round opens only once your own run
 * on it lands); this file draws "sealed" where the server sent no number, and never has
 * one to hide. It computes nothing about a result.
 */
(() => {
  const bridge = window.apogee || {};
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v * 100).toFixed(1)}%` : '–');
  const tone = (v) => (!Number.isFinite(v) ? '' : v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : '');
  const mmss = (ms) => `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor((Math.max(0, ms) % 60000) / 1000)).padStart(2, '0')}`;
  const go = (screen) => (typeof window.openScreen === 'function' ? window.openScreen(screen) : document.querySelector(`.tab[data-screen="${screen}"]`)?.click());

  let races = null;
  let crowns = null;
  let people = [];
  let pick = { to: '', category: '', window: null };
  let busy = false;
  let message = '';
  let live = null;
  let activeMatch = null;
  const opened = new Map();

  // ---- the live bar ----------------------------------------------------------------

  /**
   * Half the bar is this much of a margin, on a square-root scale. A three-round match score
   * spreads about 4.5 points either way (docs/overnight/mechanics.md), so most leads are a
   * point or two; drawn linearly they were a sliver, and eight points is decisive.
   */
  const SCALE = 0.08;

  function liveHtml(view) {
    const seen = opened.get(view.matchId) || new Set();
    const fresh = new Set();
    const lanes = view.rounds.map((r, i) => {
      const you = r.you.landed ? (r.you.counted ? `<span class="${tone(r.you.delta)}">${e(pct(r.you.delta))}</span>` : '<span class="wait">not counted</span>') : '<span class="wait">to play</span>';
      let them;
      if (!r.them.landed) them = `<span class="wait">${view.kind === 'crown' ? '–' : 'not yet'}</span>`;
      else if (r.them.sealed) them = '<span class="sealed" title="Opens when your run on this scenario lands">sealed</span>';
      else if (r.them.counted === false) them = '<span class="wait">not counted</span>';
      else {
        them = `<span class="${tone(r.them.delta)}">${e(pct(r.them.delta))}</span>`;
        if (!seen.has(i)) fresh.add(i);
      }
      return `<div class="ar-lane ${fresh.has(i) ? 'fresh' : ''}"><span class="name" title="${e(r.scenario)}">${e(r.scenario)}</span><span class="you">${you}</span><span class="them">${them}</span></div>`;
    }).join('');
    for (const i of fresh) seen.add(i);
    opened.set(view.matchId, seen);
    const m = Number.isFinite(view.margin) ? Math.max(-SCALE, Math.min(SCALE, view.margin)) : 0;
    const width = Math.sqrt(Math.abs(m) / SCALE) * 50;
    const left = m >= 0 ? 50 : 50 - width;
    const themLabel = view.kind === 'crown' ? `${view.them.name}'s run set` : view.them.name;
    return `<div class="ar-live" role="group" aria-label="${e(view.title)}, live">
      <div class="ar-live-head"><strong>${e(view.title)}</strong><span>${view.kind === 'crown' ? 'each of the holder’s rounds opens when yours lands' : 'each of their rounds opens when yours lands'}</span></div>
      <div class="ar-tug-labels"><span>You${view.you.matchScore != null ? ` <b>${e(pct(view.you.matchScore))}</b>` : ''}</span><b class="${tone(view.margin)}">${Number.isFinite(view.margin) ? `${e(pct(view.margin))} over ${view.marginRounds}` : 'no round open yet'}</b><span>${e(themLabel)}${view.them.matchScore != null ? ` <b>${e(pct(view.them.matchScore))}</b>` : ''}</span></div>
      <div class="ar-tug" role="img" aria-label="${e(view.status)}"><i class="${m >= 0 ? 'ahead' : 'behind'}" style="left:${left}%;width:${width}%"></i></div>
      <div class="ar-lanes"><div class="ar-lanes-head"><span>Scenario</span><span>You</span><span>${view.kind === 'crown' ? 'Holder' : 'Them'}</span></div>${lanes}</div>
      <p class="ar-status">${e(view.status)}</p>
    </div>`;
  }

  /** The match panel gets its own slot while a race leg or Crown challenge is open. */
  function ensureMatchSlot() {
    const body = document.querySelector('#opponent .pbody');
    let slot = document.getElementById('arenaMatchLive');
    const wanted = activeMatch && live && live.matchId === activeMatch.matchId;
    if (!wanted) { slot?.remove(); return; }
    if (!slot && body) {
      slot = document.createElement('div');
      slot.id = 'arenaMatchLive';
      slot.setAttribute('data-arena-live', '');
      body.prepend(slot);
    }
  }

  function paintLive() {
    ensureMatchSlot();
    const show = live && (!activeMatch || live.matchId === activeMatch.matchId || live.verdict);
    for (const el of document.querySelectorAll('[data-arena-live]')) el.innerHTML = show ? liveHtml(live) : '';
  }

  // ---- the race panel --------------------------------------------------------------

  function categories() { return crowns?.categories || []; }
  function bands() { return crowns?.bands || []; }

  function invitationLine(r, verb) {
    return `<b>${e(r.opponent.name)}</b> ${verb} · ${e(r.category)} (${e(r.band)})`;
  }

  function panel() {
    const root = document.getElementById('raceRoot');
    if (!root) return;
    if (!bridge.races) {
      root.innerHTML = `<section class="panel rc-panel"><div class="phead"><h2>Race now</h2><span class="note">unrated</span></div><div class="pbody"><p class="rc-lede">Races need the desktop app and a signed-in account.</p></div></section>`;
      return;
    }
    if (!pick.category && categories().length) pick.category = categories()[0];
    if (pick.window == null && bands().length) pick.window = bands()[Math.min(1, bands().length - 1)].index;
    const t = Date.now();
    const incoming = (races?.incoming || []).map((r) => `<div class="rc-item incoming">
        <p>${invitationLine(r, 'wants to race you now')}</p>
        <small>${r.scenarios.map(e).join(' · ')}</small>
        <small>Answer within <span class="rc-clock" data-rc-until="${e(r.expiresAt)}">${mmss(Date.parse(r.expiresAt) - t)}</span></small>
        <div class="rc-actions"><button type="button" class="cr-btn primary" data-rc="accept" data-id="${e(r.id)}" ${busy || activeMatch ? 'disabled' : ''}>Accept and play</button><button type="button" class="cr-btn quiet" data-rc="decline" data-id="${e(r.id)}" ${busy ? 'disabled' : ''}>Decline</button></div>
        ${activeMatch ? '<small>Finish or abandon your current match to accept.</small>' : ''}
      </div>`).join('');
    const out = races?.outgoing;
    const outgoing = out ? `<div class="rc-item">
        <p>Waiting for ${invitationLine(out, 'to accept')}</p>
        <small>${out.scenarios.map(e).join(' · ')}</small>
        <small><span class="rc-clock" data-rc-until="${e(out.expiresAt)}">${mmss(Date.parse(out.expiresAt) - t)}</span> left</small>
        <div class="rc-actions"><button type="button" class="cr-btn quiet" data-rc="cancel" data-id="${e(out.id)}" ${busy ? 'disabled' : ''}>Take it back</button></div>
      </div>` : '';
    const lv = races?.live;
    const racing = lv ? `<div class="rc-item incoming"><p>Racing <b>${e(lv.opponent.name)}</b> now · ${e(lv.category)} (${e(lv.band)})</p>
        <div class="rc-actions"><button type="button" class="cr-btn primary" data-rc="go">Go to the match</button></div></div>` : '';
    const options = people.map((p) => `<option value="${e(p.playerId)}" ${p.playerId === pick.to ? 'selected' : ''}>${e(p.displayName)}${p.friend ? ' ★' : ''}</option>`).join('');
    const form = !out && !lv ? `
      <label class="rc-field">Who<select class="rc-input" data-rc-field="to"><option value="">${people.length ? 'Pick a player' : 'Nobody to race yet'}</option>${options}</select></label>
      <div class="rc-field">Category<div class="rc-seg">${categories().map((c) => `<button type="button" data-rc-cat="${e(c)}" aria-pressed="${c === pick.category}">${e(c)}</button>`).join('')}</div></div>
      <div class="rc-field">Band<div class="rc-seg">${bands().map((b) => `<button type="button" data-rc-band="${b.index}" aria-pressed="${b.index === pick.window}">${e(b.name)}</button>`).join('')}</div></div>
      <button type="button" class="cr-btn primary" data-rc="invite" ${busy || !pick.to || !pick.category || pick.window == null || activeMatch ? 'disabled' : ''}>Invite to race</button>` : '';
    const recent = (races?.recent || []).map((r) => `<li><span class="${r.verdict === 'win' ? 'rc-win' : r.verdict === 'loss' ? 'rc-loss' : ''}">${
      r.verdict === 'win' ? 'Won' : r.verdict === 'loss' ? 'Lost' : r.verdict === 'draw' ? 'Drew' : 'Void'}</span> against ${e(r.opponent.name)} · ${e(r.category)}${r.byForfeit ? ' · did not finish' : ''}</li>`).join('');
    root.innerHTML = `<section class="panel rc-panel" aria-labelledby="rcTitle">
      <div class="phead"><h2 id="rcTitle">${typeof window.mechanicIcon === 'function' ? window.mechanicIcon('race', { className: 'rc-mark' }) : ''}Race now</h2><span class="note">unrated</span></div>
      <div class="pbody">
        <div class="rc-col">
          <p class="rc-lede">You and a friend play the same three scenarios at the same time. Each of their rounds opens on your screen when your run on that scenario lands, so playing second tells you nothing. Invitations wait three minutes.</p>
          ${incoming}${racing}${outgoing}
          ${recent ? `<ul class="rc-recent">${recent}</ul>` : ''}
        </div>
        <div class="rc-col">
          ${form || '<p class="rc-lede">One invitation or race at a time.</p>'}
          ${message ? `<p class="cr-status ${message.startsWith('!') ? 'bad' : ''}" role="status">${e(message.replace(/^!/, ''))}</p>` : ''}
        </div>
      </div>
    </section>`;
  }

  function toast() {
    const inv = (races?.incoming || [])[0];
    let el = document.getElementById('raceToast');
    const onCrowns = document.body.dataset.screen === 'crowns';
    if (!inv || onCrowns) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'raceToast'; el.className = 'rc-toast'; el.setAttribute('role', 'alert'); document.body.append(el); }
    el.innerHTML = `<p><b>${e(inv.opponent.name)}</b> wants to race you now: ${e(inv.category)} (${e(inv.band)}).</p>
      <small>Answer within <span class="rc-clock" data-rc-until="${e(inv.expiresAt)}">${mmss(Date.parse(inv.expiresAt) - Date.now())}</span>. Unrated.</small>
      <div class="rc-actions"><button type="button" class="cr-btn primary" data-rc="accept" data-id="${e(inv.id)}" ${activeMatch ? 'disabled' : ''}>Accept and play</button><button type="button" class="cr-btn quiet" data-rc="decline" data-id="${e(inv.id)}">Decline</button><button type="button" class="cr-btn quiet" data-rc="view">View</button></div>`;
  }

  function render() { panel(); toast(); }

  async function act(what, id) {
    busy = true;
    message = '';
    render();
    try {
      let r;
      if (what === 'invite') r = await bridge.inviteRace(pick.to, pick.category, pick.window);
      else if (what === 'accept') r = await bridge.acceptRace(id);
      else if (what === 'decline') r = await bridge.declineRace(id);
      else if (what === 'cancel') r = await bridge.cancelRace(id);
      if (r?.error) message = `!${r.error}`;
      else if (what === 'invite') message = 'Invitation sent. The race starts when they accept.';
      else if (what === 'accept') { message = ''; go('queue'); }
    } finally {
      busy = false;
      render();
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-rc], [data-rc-cat], [data-rc-band]');
    if (!t || !(t.closest('#raceRoot') || t.closest('#raceToast'))) return;
    if (t.dataset.rcCat) { pick.category = t.dataset.rcCat; render(); return; }
    if (t.dataset.rcBand) { pick.window = Number(t.dataset.rcBand); render(); return; }
    const what = t.dataset.rc;
    if (what === 'go') go('queue');
    else if (what === 'view') go('crowns');
    else void act(what, t.dataset.id);
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target.closest('[data-rc-field="to"]');
    if (t) { pick.to = t.value; render(); }
  });

  // Countdowns between pushes. Main re-reads the list every half minute.
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-rc-until]')) el.textContent = mmss(Date.parse(el.dataset.rcUntil) - Date.now());
  }, 1000);
  // The toast belongs to every screen but the one that already shows the invitation.
  new MutationObserver(() => toast()).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });

  async function loadPeople() {
    if (!bridge.duels) return;
    const r = await bridge.duels();
    const board = r?.board;
    if (!board) return;
    const seen = new Set();
    people = [...(board.friends || []).map((p) => ({ ...p, friend: true })), ...(board.roster || [])]
      .filter((p) => (seen.has(p.playerId) ? false : (seen.add(p.playerId), true)));
    panel();
  }

  bridge.onRaces?.((b) => { races = b; render(); });
  bridge.onCrowns?.((b) => { crowns = b; panel(); });
  bridge.onLive?.((v) => { live = v; paintLive(); });
  bridge.onMatch?.((m) => {
    activeMatch = m;
    if (!m) { paintLive(); render(); return; }
    if (live && live.matchId !== m.matchId) live = null;
    paintLive();
    render();
  });
  bridge.onDuels?.(() => void loadPeople());

  (async () => {
    render();
    if (bridge.races) {
      const r = await bridge.races();
      if (r?.board) races = r.board;
    }
    if (bridge.raceLive) {
      const r = await bridge.raceLive();
      if (r?.view) { live = r.view; paintLive(); }
    }
    await loadPeople().catch(() => undefined);
    render();
  })();
})();
