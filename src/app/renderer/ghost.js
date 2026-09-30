/* Ghost Mode: race your own past runs. A pure view of what apogee:ghost sends.
 *
 * Main decides everything here: the draw, the frozen ghosts, which run counts, the clock,
 * the verdict and the margin (src/app/ghostService.ts). This file draws that and sends
 * actions back. The one thing it computes is presentation: which lane just landed, so its
 * reveal can play once, and how the countdown reads between two pushes from main.
 */
(() => {
  const root = document.getElementById('ghostRoot');
  if (!root) return;
  const bridge = window.apogee;
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–');
  const pct = (v, digits = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v * 100).toFixed(digits)}%` : '–');
  const tone = (v) => (!Number.isFinite(v) ? '' : v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : 'level');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (key) => {
    if (!key) return '–';
    const [, m, d] = key.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  };

  let screen = null;
  let received = 0;
  let selected = null;
  let lastDefault;
  let busy = false;
  let message = '';
  let confirmAbandon = false;
  /**
   * A result that arrived with the last lane. The board holds on the live view long enough
   * for that lane's reveal to play, because the last round flipping is the moment the
   * whole match builds to, and cutting straight to the verdict skips it.
   */
  let holdResult = null;
  const REVEAL_MS = 2600;
  let marginHold = null;
  /** Lanes already revealed, per match, so a redraw does not replay the reveal. */
  const revealed = new Map();
  let clock = null;

  const ICON = {
    month_ago: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>',
    last_week: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2-5"/><path d="M4 4v4h4"/></svg>',
    last_week_best: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7Z"/></svg>',
  };
  const GHOST_MARK = '<svg class="gh-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 28V14a9 9 0 0 1 18 0v14l-3-2.5-3 2.5-3-2.5-3 2.5-3-2.5Z"/><circle cx="12.5" cy="14" r="1.6"/><circle cx="19.5" cy="14" r="1.6"/></svg>';

  function remaining() {
    const a = screen?.active;
    if (!a?.deadline || a.result) return null;
    const now = screen.now + (performance.now() - received);
    return Math.max(0, a.deadline - now);
  }
  const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

  function tickClock() {
    const el = root.querySelector('[data-gh-clock]');
    const ms = remaining();
    if (el && ms !== null) {
      el.textContent = mmss(ms);
      el.classList.toggle('low', ms < 60000);
    }
  }

  // ---- screens -------------------------------------------------------------------

  function header(kicker, title, lede) {
    const streak = screen?.streak ?? 0;
    return `<header class="gh-head">
      <div>
        <div class="gh-kicker">${GHOST_MARK}<span>${e(kicker)}</span></div>
        <h1>${title}</h1>
        ${lede ? `<p>${lede}</p>` : ''}
      </div>
      <div class="gh-streak ${streak > 0 ? 'on' : ''}" title="Consecutive days with a ghost win">
        <strong>${streak}</strong><span>day${streak === 1 ? '' : 's'}<br>ghost streak</span>
      </div>
    </header>`;
  }

  function chooser() {
    const kinds = screen.kinds || [];
    // The player's pick stands until main's default changes under it (the first race
    // finished, or last week's ghost ran out), then the new default is what is selected.
    if (lastDefault !== screen.defaultKind || !kinds.some((k) => k.kind === selected && k.available)) selected = screen.defaultKind;
    lastDefault = screen.defaultKind;
    const none = !kinds.some((k) => k.available);
    const cards = kinds.map((k) => {
      const isDefault = k.kind === screen.defaultKind;
      const first = isDefault && k.kind === 'month_ago' && (screen.record?.played ?? 0) === 0;
      return `<button type="button" class="gh-card ${k.kind === selected ? 'selected' : ''}" data-gh="pick" data-kind="${e(k.kind)}" ${k.available ? '' : 'disabled'} aria-pressed="${k.kind === selected}">
        <span class="gh-card-top"><span class="gh-card-icon">${ICON[k.kind] || ''}</span>${isDefault ? `<span class="gh-badge">${first ? 'First race' : 'Default'}</span>` : ''}</span>
        <strong>${e(k.name.charAt(0).toUpperCase() + k.name.slice(1))}</strong>
        <em>${e(k.question)}</em>
        ${k.available
          ? `<span class="gh-card-when">vs. you on <b>${e(day(k.sessionDay))}</b></span>
             <span class="gh-odds"><span class="gh-pips">${Array.from({ length: 10 }, (_, i) => `<i class="${i < k.inTen ? 'on' : ''}"></i>`).join('')}</span>About ${k.inTen} in 10 won this in testing</span>`
          : `<span class="gh-card-why">${e(k.reason)}</span>`}
      </button>`;
    }).join('');
    const last = screen.last;
    return `${header('Ghost Mode · local', 'Race your past self.', 'Three scenarios from your own KovaaK’s library, the ranked format, against how you played before. Nobody else needed. Nothing is rated: a win moves a quest and your streak.')}
      ${!screen.hasFolder ? `<div class="gh-empty">Choose your KovaaK’s stats folder first. The ghost is built from the runs in it.</div>` : ''}
      <div class="gh-cards" role="group" aria-label="Which past self">${cards}</div>
      <div class="gh-actions">
        <button type="button" class="gh-primary" data-gh="draw" ${none || !selected || busy ? 'disabled' : ''}>Race ${e(kinds.find((k) => k.kind === selected)?.name || 'your ghost')} <span aria-hidden="true">→</span></button>
        <span class="gh-note">You pick the ghost. The three scenarios are drawn for you, the same three all day.</span>
      </div>
      ${last ? `<div class="gh-lastline">Last race: <b class="${e(tone(last.margin))}">${e(verdictWord(last))}</b> ${Number.isFinite(last.margin) ? pct(last.margin) : ''} · record ${screen.record.wins}–${screen.record.losses}</div>` : ''}`;
  }

  function verdictWord(r) {
    if (r.verdict === 'void') return 'No result';
    if (r.verdict === 'draw') return 'Dead level';
    if (r.end === 'abandoned') return 'Abandoned';
    if (r.end === 'expired') return 'Out of time';
    return r.verdict === 'win' ? 'Won' : 'Lost';
  }

  function lane(r, i, a) {
    const landed = r.live !== null;
    const isNext = !landed && a.started && a.next === r.scenario;
    const key = `${a.id}:${i}`;
    const fresh = landed && !revealed.has(key);
    const gap = r.gap;
    const verdict = r.abandoned ? 'Left early · does not count' : landed ? `${pct(gap)} vs ${e(a.kindName)}` : isNext ? 'Listening for your run' : a.started ? 'Waiting' : 'Not started';
    return `<li class="gh-lane ${landed ? 'landed' : ''} ${isNext ? 'listening' : ''} ${fresh ? 'fresh' : ''} ${landed ? tone(gap) : ''}" data-lane="${i}" style="--ghost:${(r.ghostBar * 100).toFixed(2)}%;--live:${((r.liveBar ?? 0) * 100).toFixed(2)}%">
      <div class="gh-lane-head">
        <span class="gh-round">${i + 1}</span>
        <strong>${e(r.scenario)}</strong>
        <span class="gh-lane-verdict">${verdict}</span>
      </div>
      <div class="gh-bars">
        <div class="gh-bar ghost"><i></i><span>${GHOST_MARK}${num(r.ghost)}</span></div>
        <div class="gh-bar live"><i></i><span>${landed ? num(r.live) : ''}</span></div>
        <div class="gh-baseline" title="Your baseline: the middle of every bar"></div>
      </div>
      <div class="gh-lane-foot"><span>ghost: ${e(day(r.sessionDay))}, ${r.sessionRuns === 1 ? 'one run' : `median of ${r.sessionRuns}`}${a.kind === 'last_week_best' ? ' · best' : ''}</span><span>baseline ${num(r.baseline)} · best ${num(r.pb)}</span></div>
      ${fresh && !reduced.matches ? '<div class="gh-count" aria-hidden="true"><b>3</b><b>2</b><b>1</b></div>' : ''}
    </li>`;
  }

  function match() {
    const a = screen.active;
    const started = a.started;
    const lede = started
      ? 'First run on each scenario counts, in any order. The clock is the ranked one.'
      : `Frozen at midnight: each ghost, and the baseline both sides are measured against. Start opens scenario 1 in KovaaK’s and starts the clock: 8 minutes for the first run, then 3 between runs.`;
    // While a lane is revealing, the margin still reads what it did before that run: the
    // number moving first would give away what the 3-2-1 is about to show.
    const hold = marginHold && marginHold.id === a.id ? marginHold : null;
    const running = hold ? hold.margin : a.runningMargin;
    const landedShown = hold ? hold.landed : a.landed;
    return `${header(`Ghost Mode · ${a.kindName}`, started ? `You vs. <span class="gh-them">${e(a.kindName)}</span>` : 'The ghost is waiting.', lede)}
      <div class="gh-board ${started ? 'started' : ''}">
        <div class="gh-scorebar">
          <div class="gh-running"><small>Running margin</small><strong class="${tone(running)}">${running === null ? '±0.0%' : pct(running)}</strong><span>${landedShown} of 3 landed</span></div>
          <div class="gh-legend" aria-hidden="true"><span><i class="you"></i>you</span><span><i class="ghost"></i>ghost</span><span><i class="base"></i>baseline</span></div>
          ${started && !a.result ? `<div class="gh-clock"><small>Next run must start within</small><strong data-gh-clock>–</strong></div>` : ''}
        </div>
        <ol class="gh-lanes">${a.rounds.map((r, i) => lane(r, i, a)).join('')}</ol>
      </div>
      ${screen.notice ? `<div class="gh-notice" role="status">${e(screen.notice)}</div>` : ''}
      <div class="gh-actions">
        ${a.result ? '' : started
          ? `<button type="button" class="gh-primary" data-gh="launch" ${busy || !a.next ? 'disabled' : ''}>Open ${e(a.next || 'next')} <span aria-hidden="true">↗</span></button>
             ${confirmAbandon
               ? `<span class="gh-confirm">Abandoning is a loss. <button type="button" class="gh-danger" data-gh="abandon">Abandon</button><button type="button" data-gh="keep">Keep racing</button></span>`
               : `<button type="button" class="gh-quiet" data-gh="ask-abandon">Abandon</button>`}`
          : `<button type="button" class="gh-primary" data-gh="start" ${busy ? 'disabled' : ''}>Start · open ${e(a.rounds[0].scenario)} <span aria-hidden="true">↗</span></button>
             <button type="button" class="gh-quiet" data-gh="dismiss">Choose another ghost</button>`}
      </div>`;
  }

  function result() {
    const a = screen.active;
    const r = a.result;
    const kind = a.kindName;
    const headline = r.verdict === 'void' ? 'No result'
      : r.end === 'abandoned' ? `Abandoned`
      : r.end === 'expired' ? 'Out of time'
      : r.verdict === 'draw' ? `Dead level with ${kind}`
      : r.verdict === 'win' ? `Beat ${kind}` : `Lost to ${kind}`;
    const best = r.rounds.filter((x) => Number.isFinite(x.live)).sort((x, y) => (y.gap ?? -9) - (x.gap ?? -9))[0];
    const pbGap = best && best.pb > 0 ? (best.live - best.pb) / best.pb : null;
    const share = screen.share || {};
    const card = share.card;
    const streak = screen.streak ?? 0;
    // Class names are prefixed: the app already styles a bare `.win`, and a verdict class
    // named after it turned the whole result into its type.
    return `<div class="gh-result gh-v-${e(r.verdict)} gh-end-${e(r.end)}">
      <div class="gh-kicker">${GHOST_MARK}<span>Ghost Mode · ${e(kind)}</span></div>
      <div class="gh-verdict">
        <div class="gh-verdict-mark">${GHOST_MARK}</div>
        <div>
          <small>${r.verdict === 'win' ? 'Victory · unrated' : r.verdict === 'void' ? 'Void · unrated' : r.verdict === 'draw' ? 'Draw · unrated' : 'Defeat · unrated'}</small>
          <h1>${e(headline)}</h1>
          <p>${e(r.explanation)}</p>
        </div>
        <div class="gh-margin ${tone(r.margin)}"><strong>${r.margin === null ? '–' : pct(r.margin)}</strong><span>margin</span></div>
      </div>
      <table class="gh-rounds">
        <thead><tr><th>Scenario</th><th>You</th><th>Ghost</th><th>Baseline</th><th>You vs base</th><th>Ghost vs base</th><th>Round</th></tr></thead>
        <tbody>${r.rounds.map((x) => `<tr>
          <td><strong>${e(x.scenario)}</strong><small>ghost from ${e(day(x.sessionDay))}</small></td>
          <td class="num">${x.live === null ? '<span class="dim">not played</span>' : num(x.live)}${x.abandoned ? '<small>left early</small>' : ''}</td>
          <td class="num">${num(x.ghost)}</td>
          <td class="num dim">${num(x.baseline)}</td>
          <td class="num ${tone(x.delta)}">${pct(x.delta)}</td>
          <td class="num ${tone(x.ghostDelta)}">${pct(x.ghostDelta)}</td>
          <td class="num"><b class="gh-chip ${tone(x.gap)}">${x.gap === null ? '–' : pct(x.gap)}</b></td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="gh-after">
        <div class="gh-stat"><strong>${streak}</strong><span>day ghost streak${r.verdict === 'win' ? ' · today counts' : ''}</span></div>
        <div class="gh-stat"><strong>${screen.record.wins}–${screen.record.losses}</strong><span>ghost record</span></div>
        ${pbGap !== null ? `<div class="gh-stat small"><strong>${pbGap >= 0 ? 'New best' : `${Math.abs(pbGap * 100).toFixed(1)}% off`}</strong><span>your best on ${e(best.scenario)}</span></div>` : ''}
        <div class="gh-stat small"><strong>No rating change</strong><span>ghost matches never touch the ladder</span></div>
      </div>
      ${card ? `<div class="gh-card-share"><small>Share code</small><strong>${e(card.code)}</strong><span>Rebuilt by the server from your verified runs · ${e(card.liveTier)}</span></div>` : ''}
      <div class="gh-actions">
        <button type="button" class="gh-primary" data-gh="rematch" ${busy ? 'disabled' : ''}>Rematch <span aria-hidden="true">↻</span></button>
        <button type="button" data-gh="dismiss">New ghost</button>
        <button type="button" data-gh="share" ${share.enabled && !share.busy ? '' : 'disabled'} title="${e(share.reason || '')}">${share.busy ? 'Sharing…' : card ? 'Shared' : 'Share'}</button>
        ${share.reason && !card ? `<span class="gh-note">${e(share.reason)}</span>` : ''}
      </div>
    </div>`;
  }

  function render() {
    if (!screen) {
      root.innerHTML = `${'<header class="gh-head"><div><div class="gh-kicker">'}${GHOST_MARK}<span>Ghost Mode</span></div><h1>Race your past self.</h1><p>Ghost Mode runs in the desktop app, against your own KovaaK’s history.</p></div></header>`;
      return;
    }
    const a = screen.active;
    root.dataset.state = !a ? 'choose' : a.result ? 'result' : a.started ? 'live' : 'ready';
    const holding = a?.result && holdResult === a.id;
    if (holding) root.dataset.state = 'live';
    root.innerHTML = (!a ? chooser() : a.result && !holding ? result() : match()) +
      (message ? `<div class="gh-message" role="alert">${e(message)}</div>` : '');
    // Mark the lanes that just revealed as seen once their animation has had its moment.
    if (a) a.rounds.forEach((r, i) => { if (r.live !== null) revealed.set(`${a.id}:${i}`, true); });
    tickClock();
    if (clock) clearInterval(clock);
    clock = a && a.started && !a.result ? setInterval(tickClock, 1000) : null;
  }

  function accept(next) {
    if (!next || next.error) {
      if (next?.error) message = next.error;
      render();
      return;
    }
    const before = screen?.active;
    const after = next.active;
    if (after?.result && before && before.id === after.id && !before.result && !reduced.matches &&
        after.rounds.some((r, i) => r.live !== null && !revealed.has(`${after.id}:${i}`))) {
      holdResult = after.id;
      setTimeout(() => { if (holdResult === after.id) { holdResult = null; render(); } }, REVEAL_MS);
    }
    if (after && before && before.id === after.id && !reduced.matches && after.landed > before.landed) {
      const hold = { id: after.id, margin: before.runningMargin, landed: before.landed };
      marginHold = hold;
      setTimeout(() => { if (marginHold === hold) { marginHold = null; render(); } }, REVEAL_MS - 300);
    }
    screen = next;
    received = performance.now();
    render();
  }

  async function act(action) {
    if (!bridge?.ghostAction || busy) return;
    busy = true;
    message = '';
    render();
    try {
      const res = await bridge.ghostAction(action);
      busy = false;
      if (res?.error) message = res.error;
      else if (res?.note) message = '';
      if (res?.view) accept(res.view);
      else render();
    } catch (err) {
      busy = false;
      message = String(err?.message || err);
      render();
    }
  }

  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-gh]');
    if (!b || b.disabled) return;
    const what = b.dataset.gh;
    if (what === 'pick') { selected = b.dataset.kind; render(); return; }
    if (what === 'ask-abandon') { confirmAbandon = true; render(); return; }
    if (what === 'keep') { confirmAbandon = false; render(); return; }
    if (what === 'abandon') confirmAbandon = false;
    if (what === 'draw') return act({ type: 'draw', kind: selected });
    act({ type: what });
  });

  async function refresh() {
    if (!bridge?.ghost) return render();
    try { accept(await bridge.ghost()); } catch { render(); }
  }

  bridge?.onGhost?.((next) => accept(next));
  // The tab refreshes on the way in: availability moves with every run, and the window may
  // have been open across midnight.
  document.querySelector('.tab[data-screen="ghost"]')?.addEventListener('click', refresh);
  document.querySelectorAll('[data-ghost-route]').forEach((b) => b.addEventListener('click', () => {
    document.querySelector('.tab[data-screen="ghost"]')?.click();
  }));

  // The empty ladder's answer: a seeding match ends with nobody to beat, so the result
  // screen offers somebody who is always there.
  bridge?.onMatchSettled?.((s) => {
    const panel = document.querySelector('#screen-result .panel');
    if (!panel) return;
    let callout = document.getElementById('ghostSeedCallout');
    const seeding = s && (s.seeding || s.verdict == null) && !s.tournament;
    if (!seeding) { callout?.remove(); return; }
    if (!callout) {
      callout = document.createElement('div');
      callout.id = 'ghostSeedCallout';
      callout.className = 'gh-callout';
      panel.insertBefore(callout, panel.children[1] || null);
    }
    callout.innerHTML = `${GHOST_MARK}<div><strong>Nobody in the pool yet.</strong><span>Race last week’s you while it fills: three scenarios from your own library, the same format, nothing rated.</span></div><button type="button">Race your ghost <span aria-hidden="true">→</span></button>`;
    callout.querySelector('button').addEventListener('click', () => document.querySelector('.tab[data-screen="ghost"]')?.click());
  });

  refresh();
})();
