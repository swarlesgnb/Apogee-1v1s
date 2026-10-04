/* Apogee Daily: one seeded draw a day, the same three for everyone in a band.
 *
 * A pure view of what apogee:daily sends (src/app/dailyService.ts). Main decides the draw,
 * which run counts, every delta and glyph, the streak, the share text and the board. This
 * file draws that and sends actions; the one thing it computes is how the countdown reads
 * between two pushes.
 */
(() => {
  const root = document.getElementById('dailyRoot');
  const bridge = window.apogee;
  if (!root || !bridge?.daily) return;
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Number.isFinite(n) ? (Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n).toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 })) : '–');
  const pct = (v) => (Number.isFinite(v) ? `${v > 0.0005 ? '+' : v < -0.0005 ? '−' : ''}${Math.abs(v * 100).toFixed(1)}%` : '–');
  const tone = (v) => (!Number.isFinite(v) ? '' : v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : 'level');

  let screen = null;
  let received = 0;
  let note = '';
  let message = '';
  let busy = false;
  let layout = 'landscape';
  /** The share image, per layout, for the result on screen. */
  let images = {};
  let imageKey = '';
  let clock = null;
  let refreshedAt = 0;

  const MARK = '<svg class="dy-mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9h17M8 3v3M16 3v3"/><path d="m8 16.5 2.2-3.5 2.1 2.2 3.7-5"/></svg>';

  function remaining() {
    if (!screen) return 0;
    return Math.max(0, screen.nextInMs - (performance.now() - received));
  }
  function hm(ms) {
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;
  }
  function tick() {
    const el = root.querySelector('[data-dy-next]');
    if (el) el.textContent = hm(remaining());
    if (screen && remaining() <= 0 && performance.now() - refreshedAt > 5000) refresh();
  }

  // ---- pieces ------------------------------------------------------------------------

  function header() {
    const s = screen;
    const streak = s.streak || 0;
    return `<header class="dy-head">
      <div>
        <div class="dy-kicker">${MARK}<span>Apogee Daily · ${e(s.band.name)}</span></div>
        <h1>${s.number >= 1 ? `Daily #${s.number}` : 'Apogee Daily'}</h1>
        <p>Three scenarios, the same for everyone in ${e(s.band.name)} today: one Clicking, one Tracking, one Switching.
          Your first run on each counts, against your own baseline. Unrated.</p>
      </div>
      <div class="dy-side">
        <div class="dy-streak ${streak > 0 ? 'on' : ''}" title="Consecutive dailies played, in any band">
          <strong>${streak}</strong><span>day<br>streak</span>
        </div>
        <div class="dy-next" title="The draw changes at 08:00 UTC, at the same moment for everyone">
          <small>Next draw in</small><strong data-dy-next>${hm(remaining())}</strong>
        </div>
      </div>
    </header>`;
  }

  function bands() {
    const s = screen;
    return `<div class="dy-bands" role="group" aria-label="Band">
      ${s.bands.map((b) => `<button type="button" data-dy-band="${b.index}" aria-pressed="${b.index === s.band.index}">${e(b.name)}</button>`).join('')}
    </div>`;
  }

  function proposal() {
    const p = screen.proposedBand;
    if (!p) return '';
    return `<div class="dy-proposal" role="status">
      <span>The link you opened is for the <b>${e(p.name)}</b> daily. You are playing ${e(screen.band.name)}.</span>
      <button type="button" class="dy-primary" data-dy-band="${p.index}">Switch to ${e(p.name)}</button>
      <button type="button" class="dy-quiet" data-dy-do="dismissBand">Keep ${e(screen.band.name)}</button>
    </div>`;
  }

  function lane(r, i) {
    const played = r.score !== null;
    const figures = played
      ? `<div class="dy-figs">
          <span><small>Score</small><b>${num(r.score)}</b></span>
          <span><small>Baseline</small><b>${r.baseline === null ? '<i>none yet</i>' : num(r.baseline)}</b></span>
          <span><small>Delta</small><b class="${tone(r.delta)}">${r.delta === null ? '–' : pct(r.delta)}</b></span>
        </div>
        <div class="dy-why">${r.glyph === 'first'
          ? 'No run on it before today, so this one sets your baseline. Counted as played, not scored.'
          : r.provisional
            ? `Provisional: ${r.priorRuns} earlier ${r.priorRuns === 1 ? 'run' : 'runs'} behind the baseline; it settles at 5.`
            : `Baseline from your last ${Math.min(r.priorRuns, 50)} runs before today.`}</div>`
      : '<div class="dy-why">Your first run on it after 08:00 UTC counts. Later runs on it are practice.</div>';
    return `<li class="dy-lane ${played ? 'played' : 'pending'} g-${e(r.glyph)}">
      <div class="dy-glyph" aria-hidden="true">${e(r.char)}</div>
      <div class="dy-lane-body">
        <div class="dy-lane-top"><span class="dy-skill">${e(r.skill || `Round ${i + 1}`)}</span><span class="dy-word">${e(r.word)}</span></div>
        <strong class="dy-scen" title="${e(r.scenario)}">${e(r.scenario)}</strong>
        ${figures}
      </div>
      <div class="dy-lane-act">
        <button type="button" data-dy-launch="${i}" ${busy ? 'disabled' : ''}>${played ? 'Practise' : 'Play'}</button>
      </div>
    </li>`;
  }

  function result() {
    const s = screen;
    if (!s.complete) {
      const left = s.rounds.filter((r) => r.score === null).length;
      return `<div class="dy-progress">${left === 3 ? 'Play the three in any order. The result fills in from your stats folder as each run lands.'
        : `${3 - left} of 3 in. ${left} to go.`}</div>`;
    }
    const grid = s.rounds.map((r) => `<span class="g-${e(r.glyph)}" title="${e(r.word)}">${e(r.char)}</span>`).join('');
    return `<section class="dy-result" aria-label="Today's result">
      <div class="dy-result-top">
        <div class="dy-grid" aria-label="${e(s.rounds.map((r) => `${r.skill}: ${r.word}`).join('; '))}">${grid}</div>
        <div class="dy-mean">
          <small>Mean delta</small>
          <strong class="${tone(s.meanDelta)}">${s.meanDelta === null ? 'baselines set' : pct(s.meanDelta)}</strong>
          ${s.provisional ? '<span>provisional baselines</span>' : ''}
        </div>
      </div>
      <div class="dy-share">
        <div class="dy-share-text">
          <div class="dy-label">Share text <span>names no scenario, so it spoils nothing</span></div>
          <pre>${e(s.shareText || '')}</pre>
          <div class="dy-actions">
            <button type="button" class="dy-primary" data-dy-do="copy" ${busy ? 'disabled' : ''}>Copy text</button>
          </div>
        </div>
        ${imagePanel()}
      </div>
    </section>`;
  }

  function imagePanel() {
    const shot = images[layout];
    return `<div class="dy-share-image">
      <div class="dy-label">Share image</div>
      <div class="dy-frame ${layout}">${shot?.png ? `<img alt="Share image preview" src="${e(shot.png)}">` : `<div class="dy-frame-empty">${e(shot?.error || 'Drawing the image…')}</div>`}</div>
      <div class="dy-actions">
        <button type="button" data-dy-layout="landscape" aria-pressed="${layout === 'landscape'}">Landscape</button>
        <button type="button" data-dy-layout="portrait" aria-pressed="${layout === 'portrait'}">Story</button>
        <button type="button" data-dy-image="copy" ${shot?.png ? '' : 'disabled'}>Copy image</button>
        <button type="button" data-dy-image="save" ${shot?.png ? '' : 'disabled'}>Save PNG</button>
      </div>
    </div>`;
  }

  function board() {
    const b = screen.board;
    const band = e(screen.band.name);
    let body;
    if (b.board?.you) {
      const you = b.board.you;
      const place = you.percentile === null
        ? (you.meanDelta === null ? 'Your rounds all set baselines today, so you are counted and not placed.'
          : b.board.ranked <= 1 ? `You are the first in ${band} today. The board fills as others play.` : 'Placed.')
        : `Ahead of <b>${Math.round(you.percentile)}%</b> of today's players in ${band}.`;
      body = `<p class="dy-place">${place}</p>
        <div class="dy-board-figs">
          <span><small>Played today</small><b>${b.board.players}</b></span>
          <span><small>Your place</small><b>${you.rank ? `${you.rank} of ${b.board.ranked}` : '–'}</b></span>
          <span><small>Middle half</small><b>${b.board.quartiles ? `${pct(b.board.quartiles[0])} to ${pct(b.board.quartiles[2])}` : '–'}</b></span>
          <span><small>Board streak</small><b>${b.board.streak}</b></span>
        </div>`;
    } else if (b.board) {
      body = `<p class="dy-place">${b.board.players} ${b.board.players === 1 ? 'player has' : 'players have'} posted ${band} today.</p>`;
    } else body = '';
    const retry = b.state === 'error' || b.state === 'unavailable'
      ? '<button type="button" data-dy-do="post">Try again</button>' : '';
    return `<section class="dy-board" aria-label="Today's board">
      <div class="dy-label">Today's board · ${band} <span>a percentile among today's players, never a name</span></div>
      ${body}
      ${b.message ? `<p class="dy-board-msg ${e(b.state)}">${e(b.message)}</p>` : ''}
      ${retry}
    </section>`;
  }

  function foot() {
    return `<details class="dy-how"><summary>How the Daily works</summary>
      <ul>
        <li>One draw per band per day. The day changes at 08:00 UTC, at the same moment for everyone, so nobody plays tomorrow's draw while somebody else is still on today's.</li>
        <li>The first run on each scenario after the change counts. Practice before then raises the baseline you are measured against, so it does not buy a better day.</li>
        <li>A round is above or below your baseline by more than 1%, or near it. With no run on a scenario before today, the run sets your baseline instead (○).</li>
        <li>The share text and image name no scenario, so a post spoils nothing for anyone who has not played.</li>
        <li>Nothing here moves your rating. Signed in, a finished day goes to the board, which the server rebuilds from your runs.</li>
      </ul>
    </details>`;
  }

  function draw() {
    if (!screen) {
      root.innerHTML = '<div class="dy-empty">Reading today\'s draw…</div>';
      return;
    }
    if (screen.error && !screen.rounds.length) {
      root.innerHTML = `${screen.bands?.length ? header() : ''}<div class="dy-empty">${e(screen.error)}</div>`;
      return;
    }
    root.dataset.state = screen.complete ? 'complete' : 'open';
    root.innerHTML = `${header()}
      ${bands()}
      ${proposal()}
      ${!screen.hasFolder ? '<div class="dy-message">No stats folder yet. Choose it on the Play screen and the Daily reads your runs from it.</div>' : ''}
      ${message ? `<div class="dy-message" role="alert">${e(message)}</div>` : ''}
      ${note ? `<div class="dy-note" role="status">${e(note)}</div>` : ''}
      <ol class="dy-lanes">${screen.rounds.map(lane).join('')}</ol>
      ${result()}
      ${board()}
      ${foot()}`;
    if (screen.complete) previewImage();
  }

  // ---- the share image: main draws it with the shared card renderer -------------------

  async function previewImage() {
    const key = `${screen.number}|${screen.band.index}|${screen.shareText}`;
    if (key !== imageKey) {
      imageKey = key;
      images = {};
    }
    if (images[layout] || !bridge.shareCard) return;
    const want = layout;
    images[want] = { pending: true };
    const r = await bridge.shareCard('daily', want, 'preview').catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (imageKey !== key) return;
    images[want] = r?.ok ? { png: r.png } : { error: r?.error || 'The image could not be drawn.' };
    if (layout === want) {
      const frame = root.querySelector('.dy-share-image');
      if (frame) frame.outerHTML = imagePanel();
    }
  }

  // ---- actions -------------------------------------------------------------------------

  async function act(action) {
    busy = true;
    message = '';
    note = '';
    const r = await bridge.dailyAction(action).catch((err) => ({ error: String(err?.message || err) }));
    busy = false;
    if (r?.view) { screen = r.view; received = performance.now(); }
    if (r?.error) message = r.error;
    if (r?.note) note = r.note;
    draw();
  }

  root.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.dyBand !== undefined) return act({ type: 'band', index: Number(t.dataset.dyBand) });
    if (t.dataset.dyLaunch !== undefined) return act({ type: 'launch', round: Number(t.dataset.dyLaunch) });
    if (t.dataset.dyDo) return act({ type: t.dataset.dyDo });
    if (t.dataset.dyLayout) {
      layout = t.dataset.dyLayout;
      const frame = root.querySelector('.dy-share-image');
      if (frame) frame.outerHTML = imagePanel();
      previewImage();
      return;
    }
    if (t.dataset.dyImage) {
      const r = await bridge.shareCard('daily', layout, t.dataset.dyImage).catch((err) => ({ ok: false, error: String(err?.message || err) }));
      note = r?.ok && r.copied ? 'Image copied.' : r?.ok && r.savedTo ? `Saved to ${r.savedTo}` : '';
      message = r?.ok || r?.cancelled ? '' : (r?.error || 'That did not work.');
      draw();
    }
  });

  function refresh() {
    refreshedAt = performance.now();
    bridge.daily().then((s) => {
      if (!s || s.error && !s.bands) { message = s?.error || ''; draw(); return; }
      screen = s;
      received = performance.now();
      draw();
    }).catch(() => {});
  }

  bridge.onDaily?.((s) => {
    if (!s) return;
    screen = s;
    received = performance.now();
    // Redrawn only when the screen is showing or about to: a push behind another screen
    // costs a string build and nothing else.
    draw();
  });
  // Drawn on the way in, so a day that changed while the screen was hidden is current.
  document.querySelector('.tab[data-screen="daily"]')?.addEventListener('click', refresh);
  clock = setInterval(tick, 1000);
  void clock;
  refresh();
})();
