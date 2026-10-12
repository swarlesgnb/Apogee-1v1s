/* Local practice choices shared by the library and session builder. */
(() => {
  const key = 'apogee.practice.preferences.v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  const state = {
    difficulty: typeof saved.difficulty === 'string' ? saved.difficulty : null,
    favorites: Array.isArray(saved.favorites) ? saved.favorites.filter(x => typeof x === 'string').slice(0, 1000) : [],
    mood: ['balance', 'push', 'discover'].includes(saved.mood) ? saved.mood : 'balance',
    count: [3, 6, 9].includes(saved.count) ? saved.count : 6,
    category: typeof saved.category === 'string' ? saved.category : '',
  };
  function set(patch) {
    Object.assign(state, patch);
    let persisted = true;
    try { localStorage.setItem(key, JSON.stringify(state)); } catch { persisted = false; }
    window.dispatchEvent(new CustomEvent('apogee:practice-preferences', { detail: { ...patch, persisted } }));
    return persisted;
  }
  function band(windows, fallback) {
    const preferred = windows.indexOf(state.difficulty);
    if (preferred >= 0) return preferred;
    if (Number.isInteger(fallback) && fallback >= 0 && fallback < windows.length) return fallback;
    const inferred = windows.indexOf(fallback);
    return inferred >= 0 ? inferred : 0;
  }
  function favorite(name) {
    const favorites = new Set(state.favorites);
    if (favorites.has(name)) favorites.delete(name); else favorites.add(name);
    return set({ favorites: [...favorites] });
  }
  window.ApogeePracticePrefs = { state, set, band, favorite };
})();
