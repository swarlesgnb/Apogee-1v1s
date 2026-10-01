/* Share cards: "Every result, one image." A pure view over apogee:shareCard.
 *
 * Main draws the card from its own record of the result (src/app/shareCard.ts). This file
 * says which card (the ranked result or the ghost result), which shape, and whether to
 * preview, copy or save it; it never sends a number. One panel per result screen, mounted
 * beside the result the way ghost.js mounts its seeding callout, so neither screen's
 * script has to know this one exists.
 */
(() => {
  const bridge = window.apogee;
  if (!bridge?.shareCard) return;
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LAYOUT_KEY = 'apogee.share.layout';
  const storedLayout = () => {
    try { return localStorage.getItem(LAYOUT_KEY) === 'portrait' ? 'portrait' : 'landscape'; } catch { return 'landscape'; }
  };

  /**
   * One panel: its element, the result it is showing (a key main's pushes can be compared
   * against), and the preview for each layout once drawn.
   */
  function panel(source) {
    const el = document.createElement('section');
    el.className = 'share-card';
    el.dataset.share = source;
    el.setAttribute('aria-label', 'Share card');
    const state = { source, el, key: null, layout: storedLayout(), previews: {}, busy: false, status: '', tone: '' };

    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-share-do]');
      if (!b || b.disabled) return;
      const what = b.dataset.shareDo;
      if (what === 'landscape' || what === 'portrait') {
        state.layout = what;
        try { localStorage.setItem(LAYOUT_KEY, what); } catch { /* a remembered choice, nothing more */ }
        state.status = '';
        draw(state);
        preview(state);
        return;
      }
      act(state, what);
    });
    return state;
  }

  function draw(state) {
    const shot = state.previews[state.layout];
    const portrait = state.layout === 'portrait';
    state.el.dataset.layout = state.layout;
    state.el.innerHTML = `
      <div class="share-frame ${portrait ? 'portrait' : 'landscape'}">
        ${shot?.png ? `<img alt="Share card preview" src="${e(shot.png)}">`
          : `<div class="share-empty">${shot?.error ? e(shot.error) : 'Drawing the card…'}</div>`}
      </div>
      <div class="share-side">
        <div class="share-kicker">Share card</div>
        <p class="share-lede">${state.source === 'ghost'
          ? 'This race as one image: both sides of every round, raw scores and baselines, against your past self.'
          : 'This result as one image: every round with its raw score, baseline and delta, and what decides a round.'}</p>
        <div class="share-seg" role="group" aria-label="Card shape">
          <button type="button" data-share-do="landscape" aria-pressed="${!portrait}">Landscape <small>1200×675</small></button>
          <button type="button" data-share-do="portrait" aria-pressed="${portrait}">Story <small>1080×1920</small></button>
        </div>
        <div class="share-actions">
          <button type="button" class="share-go" data-share-do="copy" ${state.busy || !shot?.png ? 'disabled' : ''}>Copy image</button>
          <button type="button" data-share-do="save" ${state.busy || !shot?.png ? 'disabled' : ''}>Save PNG</button>
        </div>
        <div class="share-status ${e(state.tone)}" role="status">${e(state.status)}</div>
      </div>`;
  }

  async function preview(state) {
    if (state.previews[state.layout]?.png) return;
    const layout = state.layout;
    const key = state.key;
    const r = await bridge.shareCard(state.source, layout, 'preview').catch((err) => ({ ok: false, error: String(err?.message || err) }));
    // A newer result owns the panel now; this picture is of the one before it.
    if (state.key !== key) return;
    state.previews[layout] = r?.ok ? { png: r.png, fileName: r.fileName } : { error: r?.error || 'The card could not be drawn.' };
    if (state.layout === layout) draw(state);
  }

  async function act(state, action) {
    state.busy = true;
    state.status = action === 'copy' ? 'Copying…' : 'Saving…';
    state.tone = '';
    draw(state);
    const r = await bridge.shareCard(state.source, state.layout, action).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    state.busy = false;
    if (r?.ok && r.copied) { state.status = 'Copied. Paste it anywhere.'; state.tone = 'ok'; }
    else if (r?.ok && r.savedTo) { state.status = `Saved to ${r.savedTo}`; state.tone = 'ok'; }
    else if (r?.cancelled) { state.status = ''; }
    else { state.status = r?.error || 'That did not work.'; state.tone = 'bad'; }
    draw(state);
  }

  /** A new result: forget the old previews and draw the new one. */
  function show(state, key) {
    if (state.key === key) return;
    state.key = key;
    state.previews = {};
    state.status = '';
    state.tone = '';
    draw(state);
    preview(state);
  }

  // ---- the ranked result ------------------------------------------------------------

  const match = panel('match');
  bridge.onMatchSettled?.((s) => {
    const host = document.querySelector('#screen-result .panel');
    if (!host) return;
    // Void has no card: it did not count. Main refuses it too; not offering the button is
    // this side's half of the same decision.
    if (!s || s.verdict === 'void' || !Array.isArray(s.rounds) || s.rounds.length === 0) {
      match.el.remove();
      match.key = null;
      return;
    }
    if (!match.el.isConnected) host.append(match.el);
    show(match, `${s.matchId}`);
  });

  // ---- the ghost result -------------------------------------------------------------

  const ghostRoot = document.getElementById('ghostRoot');
  if (!ghostRoot) return;
  const ghost = panel('ghost');
  let ghostScreen = null;

  /** Which result the ghost screen shows, and whether post-ghost has minted its code yet. */
  const ghostKey = (screen) => {
    const a = screen?.active;
    if (!a?.result || a.kind === 'friend' || a.result.verdict === 'void') return null;
    return `${a.id}|${a.result.at}|${screen.share?.card?.code || ''}`;
  };

  // ghost.js redraws its root wholesale on every push, so the panel is put back after each
  // redraw rather than living inside markup this file does not own.
  const mount = () => {
    const result = ghostRoot.querySelector('.gh-result');
    const key = ghostKey(ghostScreen);
    if (!result || !key || ghostRoot.dataset.state !== 'result') {
      ghost.el.remove();
      return;
    }
    if (ghost.el.parentElement !== result) result.append(ghost.el);
    show(ghost, key);
  };
  new MutationObserver(mount).observe(ghostRoot, { childList: true });
  bridge.onGhost?.((screen) => { ghostScreen = screen; mount(); });
  bridge.ghost?.().then((screen) => { if (!ghostScreen) ghostScreen = screen; mount(); }).catch(() => {});
})();
