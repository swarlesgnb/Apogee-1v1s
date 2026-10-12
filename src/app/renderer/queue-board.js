/* Shadows and Flags on the queue and result screens. A pure view of what the server says.
 *
 * The server decides every number here (supabase/functions/_shared/queue.ts): which Shadow a
 * player meets, its score on each scenario, how the rounds went, who played whose banked
 * rounds. This file draws four things from it and computes none of them:
 *
 *   the plan     under the queue button, what queueing will do, before the player commits
 *   the match    the "Your match" card for a Shadow match
 *   the result   the "Last match" screen for a Shadow result: rounds, the bank, the ladder
 *   the news     a toast when somebody played your banked rounds while you were away, and
 *                the panel that keeps the last week of it
 *
 * The renderer calls window.apogeeQueueHooks.paintMatch / paintSettled after drawing its own
 * version of those screens, so this file only replaces what it owns. Anything synthetic is
 * called a Shadow wherever it appears.
 */
(() => {
  const bridge = window.apogee;
  const $ = (id) => document.getElementById(id);
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%` : '—');
  const nth = (n) => { const v = Math.round(n), t = v % 100; return `${v}${t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] ?? 'th'}`; };
  const tally = (t) => (t ? `${t.won}–${t.lost}${t.tied ? `, ${t.tied} tied` : ''}` : '');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : ''; };

  // Placeholder marks until the brand kit's Shadow and Flag glyphs are wired here: a figure
  // drawn in outline (somebody who is not there) and a pennant on a pole.
  const SHADOW = '<svg class="qb-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="3.6"/><path d="M4.5 20.5c.8-4.3 3.9-7 7.5-7s6.7 2.7 7.5 7"/></svg>';
  const FLAG = '<svg class="qb-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V3.5"/><path d="M6 4h11l-2.6 3.8L17 11.6H6"/></svg>';

  /** Read the renderer's own state without depending on it existing (the preview, tests). */
  const read = (name) => { try { return name === 'category' ? (selectedCategory || 'Any') : name === 'pool' ? current?.benchmark?.matchPool ?? null : name === 'match' ? activeMatch : null; } catch { return null; } };

  let board = null;
  let preview = null;
  let lastSettled = null;
  const announced = new Set();

  // ---- mount points ------------------------------------------------------------------
  const plan = document.createElement('div');
  plan.id = 'queuePlan';
  plan.className = 'qb-plan';
  plan.hidden = true;
  plan.setAttribute('role', 'status');
  $('poolNote')?.after(plan);

  const panel = document.createElement('section');
  panel.id = 'queueFlags';
  panel.className = 'panel qb-panel';
  panel.hidden = true;
  const duels = $('duels');
  if (duels) duels.before(panel);
  else $('opponent')?.after(panel);

  const toast = document.createElement('div');
  toast.id = 'queueToast';
  toast.className = 'qb-toast';
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  document.body.append(toast);

  // ---- the plan, before the player commits ----------------------------------------------
  function drawPlan() {
    const p = preview;
    if (!p || read('match') || p.outcome === 'live' || p.outcome === 'ineligible' || p.category !== read('category')) {
      plan.hidden = true;
      return;
    }
    plan.hidden = false;
    plan.className = `qb-plan ${p.outcome}`;
    if (p.outcome === 'opponent') {
      plan.innerHTML = `<div class="qb-plan-body"><strong>${e(p.line)}</strong></div>`;
      return;
    }
    const label = p.shadow?.label ?? '';
    const head = p.outcome === 'plant'
      ? 'The banked rounds near your rating are mostly scenarios you just played, so this is three fresh ones.'
      : 'No one in your band right now.';
    plan.innerHTML = `
      <span class="qb-glyph shadow">${SHADOW}</span>
      <div class="qb-plan-body">
        <strong>${e(head)}</strong>
        <p>You'll face a Shadow now: <b>${e(label)}</b>, a synthetic opponent decided like ranked, best of three on raw score. It moves no rating.</p>
        <p class="qb-flagline">${FLAG}<span>Your three runs join the bank: whoever draws them later plays you, and you'll hear how it went.</span></p>
        ${p.scored < p.total ? `<p class="qb-thin">The Shadow has a committed score on ${p.scored} of ${p.total} scenarios here. A round without one is not contested.</p>` : ''}
        <details class="qb-what"><summary>What is a Shadow?</summary>
          <p>Not a player. On each of the three scenarios the Shadow scores what Season 1's own thresholds put at that percentile of the scenario's board: ${e(label.replace(/ on each$/, ''))} beats ${e(p.shadow?.percentile ?? 50)} of every 100 scores on it. Beat it and the next Shadow is a rung harder; lose and it is a rung easier.</p>
        </details>
      </div>`;
  }

  let asking = null;
  function ask(why) {
    if (!bridge?.queueBoard) return;
    const pool = read('pool');
    const category = read('category');
    if (!pool || typeof pool.window !== 'number') return;
    clearTimeout(asking);
    asking = setTimeout(async () => {
      try {
        const res = await bridge.queueBoard({ category, pool });
        if (res?.board) accept(res.board, true);
      } catch { /* the board is a convenience; the queue still works without it */ }
    }, why === 'category' ? 250 : 0);
  }

  // ---- the board: ladder, bank news ---------------------------------------------------
  function accept(next, withPreview) {
    board = next;
    if (withPreview) preview = next.preview;
    drawPlan();
    drawPanel();
    announce();
    if (lastSettled?.shadow) drawResultCard(lastSettled);
    const m = read('match');
    if (m && next.activeShadow && next.activeShadow.matchId === m.matchId && !m.shadow) {
      m.shadow = next.activeShadow;
      paintMatch(m);
    }
  }

  function ladderLine(s) {
    if (!s) return '';
    const st = s.standing || {};
    const parts = [`Next Shadow: <b>${e(s.next.label)}</b>`];
    if (st.highestBeaten != null) parts.push(`beaten up to the <b>${e(nth(st.highestBeaten))}</b>`);
    if (st.lostAbove != null) parts.push(`lost at the ${e(nth(st.lostAbove))}`);
    if (st.roundsContested > 0) parts.push(`rounds ${st.roundsWon} of ${st.roundsContested}`);
    if (st.streak > 0) parts.push(`streak <b>${st.streak}</b>`);
    return parts.join('<i aria-hidden="true">·</i>');
  }

  function newsRow(n, unread) {
    const t = n.tally;
    // From the owner's side: did the banked rounds hold?
    const r = t ? (t.theirs > t.yours ? 'win' : t.theirs < t.yours ? 'loss' : 'draw') : n.theirResult;
    const chip = `<span class="qb-chip ${r === 'win' ? 'down' : r === 'loss' ? 'up' : ''}">${r === 'win' ? 'they took it' : r === 'loss' ? 'your rounds held' : 'drawn'}</span>`;
    return `<li class="qb-flag${unread ? ' new' : ''}">
      <span class="qb-glyph flag">${FLAG}</span>
      <span class="qb-flag-what"><b>${e(n.line)}</b><small>${e(n.category)} · ${e(day(n.settledAt))} · unrated for you</small></span>
      ${chip}
    </li>`;
  }

  function drawPanel() {
    const s = board?.shadow;
    const recent = board?.recentBank ?? [];
    if (!board || (recent.length === 0 && !(s?.standing?.played > 0))) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const unread = new Set((board.news ?? []).map((n) => n.matchId));
    panel.innerHTML = `
      <div class="phead"><h2>Shadows and your banked rounds</h2><span class="note">${recent.length ? `${recent.length} played this week` : 'none played this week'}</span></div>
      <div class="pbody">
        <p class="qb-ladder">${SHADOW}<span>${ladderLine(s)}</span></p>
        ${recent.length ? `<ul class="qb-flags">${recent.slice(0, 6).map((n) => newsRow(n, unread.has(n.matchId))).join('')}</ul>` : ''}
        <p class="qb-foot">Every match you finish, a Shadow match included, puts your three runs in the bank. When somebody's queue draws them you are told here; ranked rates the player who played, so nothing here moves your rating.</p>
      </div>`;
  }

  async function announce() {
    const fresh = (board?.news ?? []).filter((n) => !announced.has(n.matchId));
    if (fresh.length === 0) return;
    fresh.forEach((n) => announced.add(n.matchId));
    const first = fresh[0];
    const t = first.tally;
    toast.hidden = false;
    toast.className = `qb-toast ${t ? (t.theirs > t.yours ? 'down' : t.theirs < t.yours ? 'up' : '') : ''}`;
    toast.innerHTML = `
      <span class="qb-glyph flag">${FLAG}</span>
      <div><strong>Your banked rounds were played</strong><p>${e(first.line)}${fresh.length > 1 ? ` And ${fresh.length - 1} more.` : ''} Unrated for you.</p></div>
      <button type="button" data-qb="view">View</button>
      <button type="button" class="qb-x" data-qb="close" aria-label="Dismiss">×</button>`;
    clearTimeout(announce.timer);
    announce.timer = setTimeout(() => { toast.hidden = true; }, 15000);
    // Said once: the server marks it read, so the next launch does not say it again.
    try { if (board.newsThrough) await bridge?.queueBoard?.({ ack: board.newsThrough }); } catch { /* shown here either way */ }
  }
  toast.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-qb]');
    if (!b) return;
    toast.hidden = true;
    if (b.dataset.qb === 'view') {
      document.querySelector('.tab[data-screen="queue"]')?.click();
      setTimeout(() => panel.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    }
  });

  // ---- the match card -------------------------------------------------------------------
  function paintMatch(match) {
    drawPlan();
    if (!match?.shadow || match.tournament || match.duel) return;
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const s = match.shadow;
    const badge = $('oppBadge');
    if (badge) badge.innerHTML = `<span class="opponent-monogram qb-shadow-badge">${SHADOW}</span>`;
    set('oppName', 'Shadow');
    set('oppTier', `${s.label} · synthetic`);
    const tier = $('oppTier');
    if (tier) tier.style.color = '';
    set('oppAge', 'no rating change · your runs join the bank');
    const bar = $('oddsBar');
    if (bar) bar.innerHTML = '<div class="qb-odds-them" style="flex:1"></div>';
    set('oddsYou', 'unrated');
    set('oddsThem', 'best of three on raw score');
    // The button and the bar that never scrolls both said "Seeding the pool".
    set('queueVerb', 'Shadow match');
    set('queueLiveText', 'Shadow match');
    const hint = $('matchHint');
    if (hint && !/scenarios? left|Your earlier runs already count/.test(hint.textContent)) {
      hint.textContent = `Unrated. You face ${s.label}: beat its score on two of the three. First run on each scenario counts.`;
    }
  }

  // ---- the result -----------------------------------------------------------------------
  const resultCard = document.createElement('div');
  resultCard.id = 'queueResult';
  resultCard.className = 'qb-result';
  resultCard.hidden = true;
  $('explain')?.after(resultCard);

  function drawResultCard(s) {
    const banked = (s.countedRounds ?? 0) === (s.rounds?.length ?? -1);
    resultCard.hidden = false;
    resultCard.innerHTML = `
      ${banked ? `<div class="qb-card flag"><span class="qb-glyph flag">${FLAG}</span><div><strong>In the bank</strong><p>Your three runs are now banked rounds. Whoever draws them plays you, and you'll hear how it went. Unrated for you.</p></div></div>` : ''}
      <div class="qb-card shadow"><span class="qb-glyph shadow">${SHADOW}</span><div><strong>Shadow ladder</strong><p>${board?.shadow ? ladderLine(board.shadow) : `This was ${e(s.shadow.label)}, rung ${e(s.shadow.rung + 1)} of 7.`}</p></div></div>`;
  }

  function paintSettled(s) {
    lastSettled = s;
    const headers = document.querySelectorAll('#screen-result table.rounds thead th');
    if (!s?.shadow) {
      resultCard.hidden = true;
      if (headers[3]) headers[3].textContent = 'Their score';
      return;
    }
    const sh = s.shadow;
    const big = $('verdictBig');
    if (big) {
      big.textContent = sh.verdict === 'win' ? 'Shadow beaten' : sh.verdict === 'loss' ? 'Shadow wins' : sh.verdict === 'draw' ? 'Level with the Shadow' : 'No result';
      big.style.color = sh.verdict === 'win' ? 'var(--up)' : sh.verdict === 'loss' ? 'var(--down)' : 'var(--ink)';
    }
    const scores = $('verdictScores');
    if (scores) scores.textContent = sh.verdict === 'void'
      ? 'the Shadow match could not be judged'
      : `${tally(sh.tally)} on rounds · Shadow: ${sh.label}` + (Number.isFinite(s.yourMatchScore) ? `   ·   you ${pct(s.yourMatchScore)} against your usual` : '');
    const move = $('ratingMove');
    if (move) {
      move.innerHTML = 'no change<span class="after">Shadow · unrated</span>';
      move.style.color = 'var(--ink-dim)';
    }
    const prov = $('debriefProvenance');
    if (prov) prov.textContent = 'Shadow match · synthetic opponent · unrated';
    document.querySelectorAll('#debriefRounds .debrief-comparison small').forEach((el) => {
      if (el.textContent === 'Opponent') el.textContent = 'Shadow';
    });
    if (headers[3]) headers[3].textContent = 'Shadow';
    // A round with no committed Shadow score was not contested; the renderer would call it
    // "recorded", which says less than the truth.
    const rows = $('roundsBody')?.children ?? [];
    (s.rounds || []).forEach((r, i) => {
      if (r.counted && !r.result && r.excludedReason && rows[i]?.lastElementChild) rows[i].lastElementChild.textContent = 'not contested';
    });
    drawResultCard(s);
  }

  window.apogeeQueueHooks = { paintMatch, paintSettled };

  // ---- the cost of leaving -------------------------------------------------------------
  // Abandoning a Shadow match counts as losing it (it is otherwise the free way to keep a
  // streak), so it asks first, the way forfeiting a rated match does.
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('#cancelMatchBtn');
    const m = read('match');
    if (!btn || btn.dataset.settle === '1' || !m?.shadow) return;
    if (!window.confirm(`Abandon this Shadow match?\n\nIt counts as a loss to ${m.shadow.label}. Nothing is rated and nothing goes into the bank.`)) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);

  // ---- when to ask ---------------------------------------------------------------------
  $('cats')?.addEventListener('click', () => setTimeout(() => { drawPlan(); ask('category'); }, 0));
  bridge?.onQueueBoard?.((next) => accept(next, false));
  bridge?.onMatch?.((m) => { if (!m) setTimeout(() => ask('match ended'), 0); else drawPlan(); });
  bridge?.onMatchSettled?.(() => setTimeout(() => ask('settled'), 0));
  bridge?.onSession?.((session) => { if (session) ask('signed in'); else { board = null; preview = null; drawPlan(); drawPanel(); } });
  // The snapshot (and so the pool) arrives after this script runs; ask once it has.
  let tries = 0;
  const firstAsk = setInterval(() => {
    if (read('pool') || ++tries > 40) { clearInterval(firstAsk); ask('launch'); }
  }, 250);
})();
