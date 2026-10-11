/* Shadows and Flags on the queue and result screens. A pure view of what the server says.
 *
 * The server decides every number here (supabase/functions/_shared/queue.ts): which Shadow a
 * player meets, how a Shadow match went, what a Flag is doing. This file draws four things
 * from it and computes none of them:
 *
 *   the plan     under the queue button, what queueing will do, before the player commits
 *   the match    the "Your match" card for a Shadow match, or for an answer to a Flag
 *   the result   the "Last match" screen for a Shadow result, with the Flag it planted
 *   the news     a toast when a Flag was answered while the player was away, and the
 *                Flags panel that keeps the record after the toast has gone
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
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const nth = (n) => { const v = Math.round(n), t = v % 100; return `${v}${t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] ?? 'th'}`; };
  const day = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : ''; };

  // Placeholder marks until the brand kit's Shadow and Flag glyphs land: a figure drawn
  // in outline (somebody who is not there) and a pennant on a pole.
  const SHADOW = '<svg class="qb-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="3.6"/><path d="M4.5 20.5c.8-4.3 3.9-7 7.5-7s6.7 2.7 7.5 7"/></svg>';
  const FLAG = '<svg class="qb-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V3.5"/><path d="M6 4h11l-2.6 3.8L17 11.6H6"/></svg>';

  /** Read the renderer's own state without depending on it existing (the preview, tests). */
  const read = (name) => { try { return name === 'category' ? (selectedCategory || 'Any') : name === 'pool' ? current?.benchmark?.matchPool ?? null : name === 'match' ? activeMatch : null; } catch { return null; } };

  let board = null;
  let preview = null;
  let previewKey = '';
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
    const m = p.measured || { full: 0, some: 0, total: 0 };
    const thin = m.full < Math.min(3, m.total);
    plan.innerHTML = `
      <span class="qb-glyph shadow">${SHADOW}</span>
      <div class="qb-plan-body">
        <strong>No one in your band right now.</strong>
        <p>You'll face a Shadow now: <b>${e(p.shadow?.label)}</b>, a synthetic opponent. It moves no rating.</p>
        <p class="qb-flagline">${FLAG}<span>Your run set stays planted as a Flag in ${e(p.band)} · ${e(p.category)}. It settles rated for both of you when someone answers it (up to ${e(p.flag?.ttlDays ?? 7)} days).</span></p>
        ${thin ? `<p class="qb-thin">Baselines on ${m.full} of ${m.total} scenarios here. A round with no earlier runs reads 0% for both sides, so a few runs on these first make the Shadow a real contest.</p>` : ''}
        <details class="qb-what"><summary>What is a Shadow?</summary>
          <p>Not a player. A Shadow scores a day at a stated percentile of genuine three-scenario match scores, each measured against its own baselines the way your rounds are. ${e(p.shadow?.label ? p.shadow.label[0].toUpperCase() + p.shadow.label.slice(1) : 'A day')} beats ${e(p.shadow?.percentile ?? 50)} genuine days in 100. Beat it and the next Shadow is a rung harder; lose and it is a rung easier.</p>
        </details>
      </div>`;
  }

  let asking = null;
  async function ask(why) {
    if (!bridge?.queueBoard) return;
    const pool = read('pool');
    const category = read('category');
    if (!pool || typeof pool.window !== 'number') return;
    const key = `${category}|${pool.window}`;
    clearTimeout(asking);
    asking = setTimeout(async () => {
      try {
        const res = await bridge.queueBoard({ category, pool });
        if (res?.board) {
          previewKey = key;
          accept(res.board, true);
        }
      } catch { /* the board is a convenience; the queue still works without it */ }
    }, why === 'category' ? 250 : 0);
  }

  // ---- the board: flags, ladder, news ---------------------------------------------------
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
    const parts = [`Next Shadow: <b>${e(s.next.label)}</b>`];
    if (s.streak > 0) parts.push(`Shadow streak <b>${s.streak}</b>`);
    parts.push(s.placement
      ? `Placement: <b>about the ${e(nth(s.placement.estimate))} percentile</b> from ${s.placement.decided} Shadows`
      : 'Placement shows after 3 Shadow results');
    return parts.join('<i aria-hidden="true">·</i>');
  }

  function flagRow(f) {
    const status = f.status === 'open'
      ? `<span class="qb-chip open">Open · ${f.daysLeft} ${f.daysLeft === 1 ? 'day' : 'days'} left</span>`
      : f.status === 'answered'
        ? `<span class="qb-chip ${f.verdict === 'win' ? 'up' : f.verdict === 'loss' ? 'down' : ''}">${f.verdict === 'win' ? 'Won' : f.verdict === 'loss' ? 'Lost' : 'Drew'} vs ${e(f.answeredBy)}${Number.isFinite(f.ratingChange) ? ` · ${f.ratingChange >= 0 ? '+' : '−'}${Math.abs(f.ratingChange)}` : ''}</span>`
        : '<span class="qb-chip">Expired unanswered</span>';
    return `<li class="qb-flag ${e(f.status)}${f.seen ? '' : ' new'}">
      <span class="qb-glyph flag">${FLAG}</span>
      <span class="qb-flag-what"><b>${e(f.category)}</b><small>${e(f.band)} band · planted ${e(day(f.plantedAt))}</small></span>
      ${status}
    </li>`;
  }

  function drawPanel() {
    const s = board?.shadow;
    const flags = board?.flags ?? [];
    if (!board || (flags.length === 0 && !(s?.played > 0))) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const open = flags.filter((f) => f.status === 'open').length;
    panel.innerHTML = `
      <div class="phead"><h2>Flags and Shadows</h2><span class="note">${open ? `${open} open` : 'none open'} · rated when answered</span></div>
      <div class="pbody">
        <p class="qb-ladder">${SHADOW}<span>${ladderLine(s)}</span></p>
        ${flags.length ? `<ul class="qb-flags">${flags.slice(0, 6).map(flagRow).join('')}</ul>` : ''}
        <p class="qb-foot">A Flag is your run set from a Shadow match, offered to the next player in its band. The first one to answer it inside a week settles a rated match for both of you.</p>
      </div>`;
  }

  async function announce() {
    const fresh = (board?.news ?? []).filter((id) => !announced.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => announced.add(id));
    const flags = fresh.map((id) => board.flags.find((f) => f.id === id)).filter(Boolean);
    if (flags.length === 0) return;
    const first = flags[0];
    toast.hidden = false;
    toast.className = `qb-toast ${first.verdict === 'win' ? 'up' : first.verdict === 'loss' ? 'down' : ''}`;
    toast.innerHTML = `
      <span class="qb-glyph flag">${FLAG}</span>
      <div><strong>Your Flag was answered</strong><p>${e(first.line)}${flags.length > 1 ? ` And ${flags.length - 1} more.` : ''}</p></div>
      <button type="button" data-qb="view">View</button>
      <button type="button" class="qb-x" data-qb="close" aria-label="Dismiss">×</button>`;
    clearTimeout(announce.timer);
    announce.timer = setTimeout(() => { toast.hidden = true; }, 15000);
    // Said once: the server marks it seen, so the next launch does not say it again.
    try { await bridge?.queueBoard?.({ ack: fresh }); } catch { /* shown here either way */ }
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
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    if (match?.shadow && !match.tournament && !match.duel) {
      const s = match.shadow;
      const typical = 100 - s.percentile;
      const badge = $('oppBadge');
      if (badge) badge.innerHTML = `<span class="opponent-monogram qb-shadow-badge">${SHADOW}</span>`;
      set('oppName', 'Shadow');
      set('oppTier', `${s.label} · synthetic`);
      const tier = $('oppTier');
      if (tier) tier.style.color = '';
      set('oppAge', 'no rating change · your run set becomes a Flag');
      const bar = $('oddsBar');
      if (bar) bar.innerHTML = `<div class="qb-odds-you" style="flex:${typical}"></div><div class="qb-odds-them" style="flex:${s.percentile}"></div>`;
      set('oddsYou', `a typical day wins ${typical}%`);
      set('oddsThem', 'Shadow');
      // The button and the bar that never scrolls both said "Seeding the pool".
      set('queueVerb', 'Shadow match');
      set('queueLiveText', 'Shadow match');
      const hint = $('matchHint');
      if (hint && !/scenarios? left|Your earlier runs already count/.test(hint.textContent)) {
        hint.textContent = `Unrated. You face ${s.label}. When you finish, your three are planted as a Flag for the next player in this band. First run on each scenario counts.`;
      }
    } else if (match?.flag?.answering) {
      const age = $('oppAge');
      if (age && !age.textContent.includes('Flag')) age.textContent += ' · answering their Flag';
      const hint = $('matchHint');
      if (hint) hint.textContent = `${match.flag.line} First run on each scenario counts.`;
    }
  }

  // ---- the result -----------------------------------------------------------------------
  const resultCard = document.createElement('div');
  resultCard.id = 'queueResult';
  resultCard.className = 'qb-result';
  resultCard.hidden = true;
  $('explain')?.after(resultCard);

  function drawResultCard(s) {
    const flag = s.flag && !s.flag.answered ? s.flag : null;
    const ladder = board?.shadow;
    resultCard.hidden = false;
    resultCard.innerHTML = `
      ${flag ? `<div class="qb-card flag"><span class="qb-glyph flag">${FLAG}</span><div><strong>Flag planted</strong><p>${e(String(flag.line).replace(/^Flag planted: /, ''))}</p></div></div>` : ''}
      <div class="qb-card shadow"><span class="qb-glyph shadow">${SHADOW}</span><div><strong>Shadow ladder</strong><p>${ladder ? ladderLine(ladder) : `This was ${e(s.shadow.label)}, the Shadow's rung ${e(s.shadow.rung + 1)} of 7.`}</p></div></div>`;
  }

  function paintSettled(s) {
    lastSettled = s;
    const headers = document.querySelectorAll('#screen-result table.rounds thead th');
    if (!s?.shadow) {
      resultCard.hidden = true;
      if (headers[4]) headers[4].textContent = 'Δ';
      if (headers[3]) headers[3].textContent = 'Their score';
      if (s?.flag?.answered) {
        resultCard.hidden = false;
        resultCard.innerHTML = `<div class="qb-card flag"><span class="qb-glyph flag">${FLAG}</span><div><strong>Flag answered</strong><p>${e(s.flag.line)}</p></div></div>`;
      }
      return;
    }
    const sh = s.shadow;
    const verdict = sh.verdict;
    const big = $('verdictBig');
    if (big) {
      big.textContent = verdict === 'win' ? 'Shadow beaten' : verdict === 'loss' ? 'Shadow wins' : verdict === 'draw' ? 'Level with the Shadow' : 'No result';
      big.style.color = verdict === 'win' ? 'var(--up)' : verdict === 'loss' ? 'var(--down)' : 'var(--ink)';
    }
    const scores = $('verdictScores');
    if (scores) scores.textContent = verdict === 'void'
      ? 'the Shadow match could not be judged'
      : `${pct(sh.yourScore)} vs ${pct(sh.shadowScore)} against baselines · Shadow: ${sh.label}`;
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
    if (headers[4]) headers[4].textContent = 'Shadow Δ';
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
    if (!window.confirm(`Abandon this Shadow match?\n\nIt counts as a loss to ${m.shadow.label}. Nothing is rated and no Flag is planted.`)) {
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
