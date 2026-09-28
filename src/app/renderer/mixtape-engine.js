/* Pure local practice planning. These receipts never award ranked results or XP. */
(() => {
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const text = s => typeof s === 'string' && s.length > 0 && s.length <= 300;
  const moods = ['balance','push','discover'];
  function random(seed) {
    let n = seed >>> 0;
    return () => { n += 0x6D2B79F5; let t = n; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function plan(rows, { mood = 'balance', band = 0, count = 6, seed = 1 } = {}) {
    if (!moods.includes(mood) || ![3,6,9].includes(count) || !Number.isInteger(band)) return [];
    const rng = random(seed);
    const seen = new Set();
    let pool = (Array.isArray(rows) ? rows : []).filter(r => {
      if (!r || r.window !== band || !text(r.scenario) || !text(r.category) || seen.has(r.scenario)) return false;
      seen.add(r.scenario); return true;
    }).map(r => ({ ...r, tie:rng() }));
    const distance = r => finite(r.best) && finite(r.nextRankScore) && r.nextRankScore > r.best ? (r.nextRankScore - r.best) / Math.max(1,r.nextRankScore) : Infinity;
    pool.sort((a,b) => mood === 'push' ? distance(a)-distance(b) || a.tie-b.tie : mood === 'discover' ? (a.runs || 0)-(b.runs || 0) || a.tie-b.tie : a.tie-b.tie);
    const picked = [], categories = new Map(), families = new Set();
    while (pool.length && picked.length < count) {
      let available = pool.filter(r => !families.has(r.family || r.scenario));
      if (!available.length) available = pool;
      let next = available[0];
      if (mood === 'balance') next = available.reduce((a,b) => (categories.get(b.category)||0) < (categories.get(a.category)||0) ? b : a);
      pool = pool.filter(r => r !== next);
      categories.set(next.category,(categories.get(next.category)||0)+1);
      families.add(next.family || next.scenario);
      picked.push({ ...track(next), target:mood === 'push' ? threshold(next) : null });
    }
    return picked;
  }
  // What a track freezes when it is planned. The best and the upcoming threshold ride along
  // so a run can be judged against them when it lands, whatever the pool says by then.
  const threshold = r => finite(r.nextRankScore) && (!finite(r.best) || r.nextRankScore > r.best) ? r.nextRankScore : null;
  function track(r) {
    return { scenario:r.scenario, label:r.label || r.scenario, category:r.category,
      reference:finite(r.last) ? r.last : finite(r.best) ? r.best : null,
      referenceLabel:finite(r.last) ? 'Last run' : finite(r.best) ? 'Personal best' : 'First look',
      best:finite(r.best) ? r.best : null, threshold:threshold(r),
      thresholdIndex:threshold(r) !== null && Number.isInteger(r.nextRankIndex) ? r.nextRankIndex : null,
      target:null, runs:finite(r.runs) ? r.runs : 0, status:'pending', score:null };
  }
  /** The same scenarios in the same order, with references from the current pool. Scenarios
   *  that left the pool are dropped rather than replayed into a launch that fails. */
  function replay(rows, session) {
    if (!session || !Array.isArray(rows)) return [];
    return session.tracks.map(t => {
      const r = rows.find(row => row && row.scenario === t.scenario);
      return r && text(r.category) ? { ...track(r), target:t.target === null ? null : threshold(r) } : null;
    }).filter(Boolean);
  }
  function create(tracks, mood, band, now = Date.now()) {
    if (!tracks.length || tracks.length > 9 || !moods.includes(mood)) return null;
    return { version:1, id:String(now), mood, band, startedAt:now, armedAt:now, endedAt:null, index:0, tracks:tracks.map(t => ({...t,status:'pending',score:null})), receipts:[] };
  }
  function receive(session, run, now = Date.now()) {
    if (!session || session.endedAt || !run || !finite(run.score)) return null;
    const track = session.tracks[session.index], at = typeof run.playedAt === 'string' ? Date.parse(run.playedAt) : NaN;
    if (!track || run.scenario !== track.scenario || !Number.isFinite(at) || at < session.armedAt || at > now + 300000) return null;
    const receipt = typeof run.file === 'string' && run.file ? run.file : `${run.scenario}|${run.playedAt}|${run.score}`;
    if (session.receipts.includes(receipt)) return null;
    const next = structuredClone(session);
    // A personal best by the watcher's own history when it knows, else by the frozen best.
    const pb = !!run.localPersonalBest || (finite(track.best) && run.score > track.best);
    Object.assign(next.tracks[next.index],{status:'played',score:run.score,at,pb});
    next.receipts.push(receipt); next.index++; next.armedAt = Math.max(now,at);
    if (next.index === next.tracks.length) next.endedAt = now;
    return next;
  }
  function skip(session, now = Date.now()) {
    if (!session || session.endedAt) return null;
    const next = structuredClone(session);
    next.tracks[next.index].status = 'skipped'; next.index++; next.armedAt = now;
    if (next.index === next.tracks.length) next.endedAt = now;
    return next;
  }
  function summary(s) {
    const played = s.tracks.filter(t => t.status === 'played');
    return { played:played.length, skipped:s.tracks.filter(t => t.status === 'skipped').length,
      improved:played.filter(t => finite(t.reference) && t.score > t.reference).length,
      compared:played.filter(t => finite(t.reference)).length,
      bests:played.filter(t => t.pb).length,
      thresholds:played.filter(t => finite(t.threshold) && t.score >= t.threshold).length,
      categories:new Set(played.map(t => t.category)).size };
  }
  function valid(s) {
    return !!s && s.version === 1 && text(s.id) && moods.includes(s.mood) && Number.isInteger(s.band) && s.band >= 0 && s.band < 4 &&
      finite(s.startedAt) && finite(s.armedAt) && s.armedAt >= s.startedAt && (s.endedAt === null || finite(s.endedAt)) &&
      Array.isArray(s.tracks) && s.tracks.length > 0 && s.tracks.length <= 9 && Number.isInteger(s.index) && s.index >= 0 && s.index <= s.tracks.length &&
      (s.endedAt !== null || s.index < s.tracks.length) && Array.isArray(s.receipts) && s.receipts.length <= 9 && s.receipts.every(text) &&
      s.tracks.every((t,i) => t && text(t.scenario) && text(t.label) && text(t.category) && text(t.referenceLabel) &&
        (t.reference === null || finite(t.reference)) && (t.target === null || finite(t.target)) &&
        (i < s.index ? ['played','skipped'].includes(t.status) : t.status === 'pending') && (t.status === 'played' ? finite(t.score) : t.score === null));
  }
  globalThis.ApogeeMixtape = Object.freeze({plan,replay,create,receive,skip,summary,valid});
})();
