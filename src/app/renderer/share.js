/* Share cards: "Every result, one image." A pure view over apogee:shareCard.
 *
 * Main draws the card from its own record of the result (src/app/shareCard.ts). This file
 * says which card, which shape, and whether to preview, copy or save it; it never sends a
 * number. One panel implementation serves every place a result appears:
 *
 *   the result screen   the ranked result's card, with the Shadow card beside it for a
 *                       Shadow match and the Crown card for a Crown just taken
 *   the ghost result    mounted into ghost.js's result, the way it mounts its callout
 *   anywhere else       window.apogeeShare.panel([...cards]) for the scripts that own a
 *                       result screen of their own: the Flags panel (queue-board.js) and
 *                       a Crown defence notice (crowns.js)
 *
 * Which Shadow, Flag and Crown result main holds a card for arrives as apogee:shareRecords
 * keys (src/app/shareRecords.ts). A screen offers Share beside the result whose key main
 * holds, and a panel showing a card whose record changed draws it again.
 */
(() => {
  const bridge = window.apogee;
  if (!bridge?.shareCard) return;
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LAYOUT_KEY = 'apogee.share.layout';
  const storedLayout = () => {
    try { return localStorage.getItem(LAYOUT_KEY) === 'portrait' ? 'portrait' : 'landscape'; } catch { return 'landscape'; }
  };

  // What each card is, in the panel's words, and its name on the card switch.
  const LEDE = {
    match: 'This result as one image: every round with its raw score, baseline and delta, and what decides a round.',
    ghost: 'This race as one image: both sides of every round, raw scores and baselines, against your past self.',
    shadow: 'This Shadow match as one image: the percentile day you played, your recent Shadows and the placement read-out. It says synthetic and unrated on it.',
    crown: 'This Crown as one image: the Crown and band, both match scores, and the rounds when the server sent them.',
    flag: 'This Flag as one image: your planted set against the answer, both match scores, and the rating it settled.',
  };
  const NAME = { match: 'Rounds', ghost: 'Race', shadow: 'Shadow', crown: 'Crown', flag: 'Flag' };

  // The record main holds for each mechanic card, by key. Fetched once, then pushed.
  let keys = { crown: null, flag: null, shadow: null };
  const keyListeners = [];
  const panels = new Set();

  /**
   * One panel: its element, the cards it can show (the first is the default), the result it
   * is showing, and the previews drawn for it, by card and shape.
   */
  function panel(sources) {
    const el = document.createElement('section');
    el.className = 'share-card';
    el.setAttribute('aria-label', 'Share card');
    const state = { sources: [...sources], source: sources[0], el, key: null, layout: storedLayout(), previews: {}, busy: false, status: '', tone: '' };
    el.dataset.share = state.source;

    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-share-do], [data-share-card]');
      if (!b || b.disabled) return;
      if (b.dataset.shareCard) {
        if (!state.sources.includes(b.dataset.shareCard)) return;
        state.source = b.dataset.shareCard;
        state.status = '';
        draw(state);
        preview(state);
        return;
      }
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
    panels.add(state);
    return state;
  }

  const slot = (state) => `${state.source}|${state.layout}`;

  function draw(state) {
    const shot = state.previews[slot(state)];
    const portrait = state.layout === 'portrait';
    state.el.dataset.share = state.source;
    state.el.dataset.layout = state.layout;
    const cards = state.sources.length > 1
      ? `<div class="share-seg share-cards" role="group" aria-label="Card">${state.sources.map((s) =>
        `<button type="button" data-share-card="${e(s)}" aria-pressed="${s === state.source}">${e(NAME[s] || s)}</button>`).join('')}</div>`
      : '';
    state.el.innerHTML = `
      <div class="share-frame ${portrait ? 'portrait' : 'landscape'}">
        ${shot?.png ? `<img alt="Share card preview" src="${e(shot.png)}">`
          : `<div class="share-empty">${shot?.error ? e(shot.error) : 'Drawing the card…'}</div>`}
      </div>
      <div class="share-side">
        <div class="share-kicker">Share card</div>
        <p class="share-lede">${e(LEDE[state.source] || LEDE.match)}</p>
        ${cards}
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
    const at = slot(state);
    if (state.previews[at]?.png || state.previews[at]?.pending) return;
    const { source, layout, key } = state;
    state.previews[at] = { pending: true };
    const r = await bridge.shareCard(source, layout, 'preview').catch((err) => ({ ok: false, error: String(err?.message || err) }));
    // A newer result owns the panel now, or main's record moved on; this picture is stale.
    if (state.key !== key || state.previews[at]?.pending !== true) return;
    state.previews[at] = r?.ok ? { png: r.png, fileName: r.fileName } : { error: r?.error || 'The card could not be drawn.' };
    if (slot(state) === at) draw(state);
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

  /** A new result, or new cards for it: forget the old previews and draw the new one. */
  function show(state, key, sources) {
    const next = sources && sources.length ? sources : state.sources;
    const same = next.length === state.sources.length && next.every((s, i) => s === state.sources[i]);
    if (state.key === key && same) return;
    state.key = key;
    state.sources = [...next];
    if (!state.sources.includes(state.source) || !same) state.source = state.sources[0];
    state.previews = {};
    state.status = '';
    state.tone = '';
    draw(state);
    preview(state);
  }

  /** Main's record for a mechanic card changed: a panel showing that card draws it again. */
  function recordsChanged(next) {
    const before = keys;
    keys = { crown: next?.crown ?? null, flag: next?.flag ?? null, shadow: next?.shadow ?? null };
    for (const state of panels) {
      for (const kind of ['crown', 'flag', 'shadow']) {
        if (before[kind] === keys[kind] || !state.sources.includes(kind)) continue;
        delete state.previews[`${kind}|landscape`];
        delete state.previews[`${kind}|portrait`];
        if (state.el.isConnected && state.source === kind) { draw(state); preview(state); }
      }
    }
    keyListeners.forEach((fn) => { try { fn({ ...keys }); } catch { /* one listener cannot stop the rest */ } });
  }
  bridge.onShareRecords?.(recordsChanged);
  bridge.shareRecords?.().then((k) => { if (k) recordsChanged(k); }).catch(() => {});

  /**
   * For the scripts that own a result of their own. `panel(cards)` gives a handle:
   * `show(host, key)` mounts it in `host` (or keeps it there) for the result `key`,
   * `hide()` takes it out. `keys()` and `onKeys(fn)` say which result main holds a card for.
   */
  window.apogeeShare = {
    keys: () => ({ ...keys }),
    onKeys: (fn) => { if (typeof fn === 'function') keyListeners.push(fn); },
    panel: (sources) => {
      const state = panel(sources);
      return {
        el: state.el,
        show(host, key) {
          if (!host) return;
          if (state.el.parentElement !== host) host.append(state.el);
          show(state, key);
        },
        hide() { state.el.remove(); state.key = null; },
        get shown() { return state.el.isConnected ? state.key : null; },
      };
    },
  };

  // ---- the ranked result ------------------------------------------------------------

  const match = panel(['match']);
  let lastSettled = null;

  /**
   * The cards a result offers: the mechanic's own first when main holds its record for
   * this match (a Shadow result, a Crown just taken), then the rounds.
   */
  const resultCards = (s) => {
    const own = (kind) => typeof keys[kind] === 'string' && keys[kind].replace(/^crown:taken:/, '').split(':')[0] === s.matchId;
    if (s.shadow && own('shadow')) return ['shadow', 'match'];
    if (s.arena?.crown?.outcome === 'took' && own('crown') && keys.crown.startsWith('crown:taken:')) return ['crown', 'match'];
    return ['match'];
  };

  function mountResult(s) {
    const host = document.querySelector('#screen-result .panel');
    if (!host) return;
    // Void has no card: it did not count. Main refuses it too; not offering the button is
    // this side's half of the same decision.
    if (!s || s.verdict === 'void' || !Array.isArray(s.rounds) || s.rounds.length === 0) {
      match.el.remove();
      match.key = null;
      lastSettled = null;
      return;
    }
    lastSettled = s;
    if (!match.el.isConnected) host.append(match.el);
    show(match, `${s.matchId}`, resultCards(s));
  }
  bridge.onMatchSettled?.(mountResult);
  // A Shadow's ladder or a Crown record can land after the result: offer its card then.
  keyListeners.push(() => { if (lastSettled && match.el.isConnected) show(match, `${lastSettled.matchId}`, resultCards(lastSettled)); });

  // ---- the ghost result -------------------------------------------------------------

  const ghostRoot = document.getElementById('ghostRoot');
  if (!ghostRoot) return;
  const ghost = panel(['ghost']);
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
