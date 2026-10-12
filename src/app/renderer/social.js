/* Social: challenge-link confirmation, the "Links & Discord" menu, and open challenges.
 *
 * A pure view, like ghost.js and share.js. Main parses every link against the grammar in
 * src/core/social/deepLinks.ts and proposes it (src/app/social.ts); this draws the
 * proposal and sends back "confirm" or "dismiss" with the proposal's id and nothing else,
 * so nothing typed or clicked here can change what a link does. Link text is never put
 * into the page unescaped: everything drawn is main's parsed values.
 */
(() => {
  const bridge = window.apogee;
  if (!bridge?.linkAction) return;
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tab = (name) => document.querySelector(`.tab[data-screen="${name}"]`);
  let signedIn = false;

  // ---- 1. the link prompt ---------------------------------------------------------------

  const overlay = document.createElement('div');
  overlay.className = 'sl-overlay';
  overlay.hidden = true;
  document.body.append(overlay);
  let proposal = null;
  let working = false;
  let opener = null;

  const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';

  function drawPrompt() {
    const p = proposal;
    if (!p || p.state === 'done') {
      overlay.hidden = true;
      overlay.innerHTML = '';
      if (opener && document.contains(opener)) opener.focus();
      opener = null;
      return;
    }
    const checking = p.state === 'checking';
    overlay.innerHTML = `<div class="sl-dialog" role="dialog" aria-modal="true" aria-labelledby="slTitle">
      <div class="sl-kicker">${LINK_ICON}<span>${p.kind === 'duel' ? 'Challenge link' : 'Ghost link'}</span></div>
      <h2 id="slTitle">${e(p.title)}</h2>
      <ul class="sl-lines">${(p.lines || []).map((l) => `<li>${e(l)}</li>`).join('')}</ul>
      ${checking ? '<p class="sl-wait">Looking the code up…</p>' : ''}
      ${p.error ? `<p class="sl-error" role="alert">${e(p.error)}</p>` : ''}
      <p class="sl-fine">Opened from a link. Nothing happens unless you confirm.</p>
      <div class="sl-actions">
        ${p.state === 'signed-out' ? '<button type="button" class="sl-primary" data-sl="signin">Sign in with Steam</button>' : ''}
        ${p.confirm ? `<button type="button" class="sl-primary" data-sl="confirm" ${working ? 'disabled' : ''}>${working ? 'Working…' : e(p.confirm)}</button>` : ''}
        <button type="button" data-sl="dismiss">${p.confirm ? 'Not now' : 'Close'}</button>
      </div>
    </div>`;
    const wasHidden = overlay.hidden;
    overlay.hidden = false;
    if (wasHidden) opener = document.activeElement;
    (overlay.querySelector('[data-sl="confirm"]') || overlay.querySelector('[data-sl="dismiss"]'))?.focus();
  }

  function show(p) {
    proposal = p;
    working = false;
    if (p && p.state === 'done') {
      // Navigation only (a daily link): go there, and there is nothing to confirm.
      if (p.navigate) tab(p.navigate)?.click();
      bridge.linkAction({ type: 'dismiss', id: p.id }).catch(() => {});
      proposal = null;
    }
    drawPrompt();
  }

  overlay.addEventListener('click', async (ev) => {
    if (ev.target === overlay) return; // a stray click outside is not a decision either way
    const b = ev.target.closest('[data-sl]');
    if (!b || b.disabled || !proposal) return;
    const what = b.dataset.sl;
    if (what === 'dismiss') {
      await bridge.linkAction({ type: 'dismiss', id: proposal.id }).catch(() => {});
      proposal = null;
      drawPrompt();
      return;
    }
    if (what === 'signin') {
      bridge.signIn?.();
      return;
    }
    if (what === 'confirm') {
      working = true;
      drawPrompt();
      const id = proposal.id;
      const r = await bridge.linkAction({ type: 'confirm', id }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
      working = false;
      if (r?.ok) {
        proposal = null;
        drawPrompt();
        if (r.navigate) tab(r.navigate)?.click();
      } else if (proposal && proposal.id === id) {
        proposal = { ...proposal, error: r?.error || 'That did not work.' };
        drawPrompt();
      }
    }
  });
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && proposal) {
      ev.preventDefault();
      overlay.querySelector('[data-sl="dismiss"]')?.click();
    }
    if (ev.key === 'Tab') {
      // Keep focus inside the prompt while it is open.
      const items = [...overlay.querySelectorAll('button:not([disabled])')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
      ev.preventDefault();
      items[next].focus();
    }
  });

  bridge.onLink?.((p) => show(p));
  bridge.pendingLink?.().then((p) => { if (p && !proposal) show(p); }).catch(() => {});

  // ---- 2. the "Links & Discord" menu ----------------------------------------------------

  const right = document.querySelector('.topbar-right');
  const menu = document.createElement('details');
  menu.className = 'sound-studio sl-menu';
  menu.id = 'socialMenu';
  menu.innerHTML = `<summary class="sound-toggle" aria-label="Links and Discord" title="Links and Discord">${LINK_ICON}</summary>
    <div class="status-menu sl-menu-body">
      <strong>Links &amp; Discord</strong>
      <form class="sl-paste" autocomplete="off">
        <label for="slPaste">Open a challenge link</label>
        <div class="sl-paste-row">
          <input id="slPaste" type="text" maxlength="200" spellcheck="false" placeholder="apogee://… or the https link from a post">
          <button type="submit">Open</button>
        </div>
        <p class="sl-paste-msg" role="status"></p>
      </form>
      <label class="sl-toggle"><input type="checkbox" id="slDiscord"> <span>Show what I'm playing on Discord</span></label>
      <p class="sl-discord-note" id="slDiscordNote"></p>
    </div>`;
  if (right) right.insertBefore(menu, right.querySelector('#theme') || right.firstChild);

  const discordBox = menu.querySelector('#slDiscord');
  const discordNote = menu.querySelector('#slDiscordNote');
  function drawSettings(s) {
    if (!s) return;
    discordBox.checked = !!s.discord;
    discordBox.disabled = !s.discordAvailable;
    discordNote.textContent = !s.discordAvailable
      ? 'This build has no Discord application id, so Discord presence is off. See SETUP.md.'
      : 'Off by default. Discord friends see what you are playing (a ranked match, a ghost race, the Daily), its category or daily number, and for how long. Never a score, rating or opponent.';
  }
  bridge.socialSettings?.().then(drawSettings).catch(() => {});
  discordBox.addEventListener('change', async () => {
    drawSettings(await bridge.setSocialSettings({ discord: discordBox.checked }).catch(() => null));
  });
  menu.querySelector('.sl-paste').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = menu.querySelector('#slPaste');
    const msg = menu.querySelector('.sl-paste-msg');
    const r = await bridge.linkAction({ type: 'paste', text: input.value }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    msg.textContent = r?.ok ? '' : (r?.error || 'That link could not be opened.');
    if (r?.ok) {
      input.value = '';
      menu.open = false;
    }
  });

  // ---- 3. open challenges, beside the duel inbox -----------------------------------------

  const panel = document.createElement('div');
  panel.className = 'panel sl-open';
  panel.id = 'openChallenge';
  panel.hidden = true;
  let categories = [];
  let category = null;
  let mine = [];
  let status = '';
  let tone = '';
  let busy = false;
  /** The open challenge this session posted, so its result can carry the link. */
  let posted = null;

  function drawPanel() {
    if (!signedIn) { panel.hidden = true; return; }
    panel.hidden = false;
    if (!category || !categories.includes(category)) category = categories[0] || null;
    panel.innerHTML = `<div class="phead"><h2>Open challenge</h2><span class="note">unrated · anyone with the link</span></div>
      <div class="pbody">
        <p class="sl-lede">Play three in a category, then post the link anywhere. Anyone who has it can answer, and each answer is its own match against your three. Unrated both ways, because a public link can be answered by anybody's second account.</p>
        <div class="cats sl-cats">${categories.map((c) => `<button type="button" class="cat" data-sl-cat="${e(c)}" aria-pressed="${c === category}">${e(c)}</button>`).join('')}</div>
        <div class="sl-open-actions">
          <button type="button" class="sl-go" data-sl-do="create" ${busy || !category ? 'disabled' : ''}>Post an open challenge</button>
          <span class="sl-status ${e(tone)}" role="status">${e(status)}</span>
        </div>
        ${mine.length ? `<ul class="sl-mine">${mine.map(row).join('')}</ul>` : ''}
      </div>`;
  }

  function row(c) {
    const results = c.answers
      ? `${c.answers} answered · ${c.youBeat} you beat · ${c.beatYou} beat you${c.drawn ? ` · ${c.drawn} drawn` : ''}`
      : c.played ? 'No answers yet' : 'Play your three first; nobody can answer until you have';
    const open = c.status === 'open';
    return `<li class="sl-mine-row">
      <div><b>${e(c.code)}</b> <span>${e(c.category)} · ${e(c.band)} · ${e(open ? 'open' : c.status)}</span><small>${e(results)}</small></div>
      <div class="sl-mine-act">
        ${open ? `<button type="button" data-sl-copy="${e(c.code)}">Copy link</button>` : ''}
        ${open ? `<button type="button" data-sl-cancel="${e(c.code)}">Take back</button>` : ''}
      </div>
    </li>`;
  }

  async function loadMine() {
    if (!signedIn) return;
    const r = await bridge.openChallenge({ action: 'mine' }).catch(() => null);
    mine = Array.isArray(r?.challenges) ? r.challenges : [];
    drawPanel();
  }

  panel.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.slCat) { category = b.dataset.slCat; drawPanel(); return; }
    if (b.dataset.slDo === 'create') {
      busy = true; status = 'Posting…'; tone = ''; drawPanel();
      const r = await bridge.openChallenge({ action: 'create', category }).catch((err) => ({ error: String(err?.message || err) }));
      busy = false;
      if (r?.match) {
        posted = { matchId: r.match.matchId, code: r.match.duel?.code || null };
        status = `Posted as ${posted.code}. Play your three; the link is ready to share once they are in.`;
        tone = 'ok';
        loadMine();
      } else { status = r?.error || 'That did not work.'; tone = 'bad'; }
      drawPanel();
      return;
    }
    if (b.dataset.slCopy) {
      const r = await bridge.openChallenge({ action: 'copy', code: b.dataset.slCopy }).catch(() => null);
      status = r?.ok ? 'Link copied. Paste it anywhere.' : (r?.error || 'Could not copy.'); tone = r?.ok ? 'ok' : 'bad';
      drawPanel();
      return;
    }
    if (b.dataset.slCancel) {
      const r = await bridge.openChallenge({ action: 'cancel', code: b.dataset.slCancel }).catch(() => null);
      status = r?.ok ? 'Taken back.' : (r?.error || 'Could not take it back.'); tone = r?.ok ? 'ok' : 'bad';
      loadMine();
    }
  });

  const duels = document.getElementById('duels');
  if (duels?.parentElement) duels.parentElement.insertBefore(panel, duels.nextSibling);

  function readCategories(snapshot) {
    const names = (snapshot?.categories || []).map((c) => c && c.name).filter((n) => typeof n === 'string' && n);
    if (names.length) categories = names;
  }

  // ---- 4. the challenge link on your own settled result -------------------------------------

  const resultRow = document.createElement('div');
  resultRow.className = 'sl-result-link';
  bridge.onMatchSettled?.((s) => {
    resultRow.remove();
    if (!posted || !s || s.matchId !== posted.matchId || !posted.code || s.verdict === 'void') return;
    const host = document.querySelector('#screen-result .panel');
    if (!host) return;
    resultRow.innerHTML = `<div><b>Your challenge is live.</b> Anyone with the link plays the same three against your run, unrated. Code <code>${e(posted.code)}</code></div>
      <button type="button" data-sl-copy-result="${e(posted.code)}">Copy challenge link</button>`;
    host.prepend(resultRow);
  });
  resultRow.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-sl-copy-result]');
    if (!b) return;
    const r = await bridge.openChallenge({ action: 'copy', code: b.dataset.slCopyResult }).catch(() => null);
    b.textContent = r?.ok ? 'Copied' : 'Could not copy';
  });

  // ---- session and snapshot --------------------------------------------------------------

  function setSession(session) {
    const was = signedIn;
    signedIn = !!session;
    drawPanel();
    if (signedIn && !was) {
      loadMine();
      // A link that arrived before the saved session came back said "sign in"; look again.
      if (proposal && proposal.state === 'signed-out') bridge.linkAction({ type: 'recheck', id: proposal.id }).catch(() => {});
    }
  }
  bridge.getState?.().then((s) => { readCategories(s?.snapshot); setSession(s?.session); }).catch(() => {});
  bridge.onSession?.((s) => setSession(s));
  bridge.onSnapshot?.((snap) => { readCategories(snap); drawPanel(); });
  bridge.onDuels?.(() => { if (signedIn) loadMine(); });
})();
