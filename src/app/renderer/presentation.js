/* Presentation only: no training state, timers, scores or network requests. */
(() => {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const indicator = document.createElement('span');
  indicator.className = 'nav-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  nav.append(indicator);
  const entrances = new Set();
  const tokens = getComputedStyle(document.documentElement);
  const duration = parseFloat(tokens.getPropertyValue('--motion-enter')) || 240;
  const easing = tokens.getPropertyValue('--motion-ease').trim() || 'ease-out';
  let lastScreen = null;
  let frame = 0;
  // A little depth on display cards. Never attach pointer effects to score tables.
  let tilted = null, pointerFrame = 0;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  function resetTilt() {
    cancelAnimationFrame(pointerFrame);
    if (tilted) { tilted.style.removeProperty('--tilt-x'); tilted.style.removeProperty('--tilt-y'); tilted.classList.remove('tactile-surface'); tilted=null; }
  }
  document.addEventListener('pointermove',event=>{
    if(reduced.matches || !finePointer.matches) return;
    const card=event.target.closest?.('.exp-home,.mix-history-card');
    if(card!==tilted) { resetTilt(); tilted=card; }
    if(!card) return;
    cancelAnimationFrame(pointerFrame);
    pointerFrame=requestAnimationFrame(()=>{
      const r=card.getBoundingClientRect(),x=Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y=Math.max(0,Math.min(1,(event.clientY-r.top)/r.height));
      card.classList.add('tactile-surface');card.style.setProperty('--tilt-x',`${(0.5-y)*5}deg`);card.style.setProperty('--tilt-y',`${(x-0.5)*5}deg`);
      card.style.setProperty('--pointer-x',`${x*100}%`);card.style.setProperty('--pointer-y',`${y*100}%`);
    });
  },{passive:true});
  document.documentElement.addEventListener('pointerleave',resetTilt);
  function pausePresentation() {
    document.body.toggleAttribute('data-presentation-paused',document.hidden || !document.hasFocus());
    if(document.hidden || !document.hasFocus()) resetTilt();
  }
  window.addEventListener('blur',pausePresentation);window.addEventListener('focus',pausePresentation);

  for (const name of ['ranks','profile','quests','scenarios','consistency','result','seasonview']) {
    const heading = document.querySelector(`#screen-${name} > .screen-head`);
    if (heading && heading.children.length === 2) heading.classList.add('editorial-heading');
  }

  function positionMarker() {
    const active = nav.querySelector('.tab[aria-selected="true"]:not([hidden]), .tab.active-parent');
    const hidden = !active || !active.getClientRects().length;
    if (indicator.hidden !== hidden) indicator.hidden = hidden;
    if (indicator.hidden) return;
    const rect = active.getBoundingClientRect();
    const parent = nav.getBoundingClientRect();
    indicator.style.height = `${rect.height}px`;
    indicator.style.transform = `translateY(${rect.top - parent.top + nav.scrollTop}px)`;
  }
  function scheduleMarker() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(positionMarker);
  }
  function cancelEntrances() {
    for (const animation of entrances) animation.cancel();
    entrances.clear();
  }
  function enterScreen() {
    scheduleMarker();
    const screen = document.querySelector('.screen.active');
    if (!screen || screen === lastScreen) return;
    lastScreen = screen;
    cancelEntrances();
    if (reduced.matches || document.hidden) return;
    // Animate the reading order, with only a small offset between visible blocks.
    const blocks = [...screen.children].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width && rect.height && rect.top < innerHeight && rect.bottom > 0;
    }).slice(0, 6);
    blocks.forEach((el, index) => {
      const animation = el.animate([
        { opacity:0, transform:'translateY(8px)' },
        { opacity:1, transform:'translateY(0)' },
      ], { duration, delay:index * 24, easing, fill:'backwards' });
      animation.id = 'apogee-entrance';
      entrances.add(animation);
      animation.onfinish = animation.oncancel = () => entrances.delete(animation);
    });
  }
  new MutationObserver(enterScreen).observe(document.body, { attributes:true, attributeFilter:['data-screen'] });
  new MutationObserver(scheduleMarker).observe(nav, { subtree:true, childList:true, attributes:true, attributeFilter:['hidden'] });
  new ResizeObserver(scheduleMarker).observe(nav);
  window.addEventListener('resize', scheduleMarker, { passive:true });
  reduced.addEventListener('change', () => { cancelEntrances(); resetTilt(); scheduleMarker(); });
  document.addEventListener('visibilitychange', () => { pausePresentation(); if (document.hidden) cancelEntrances(); else scheduleMarker(); });
  document.body.dataset.presentationReady = 'true';
  positionMarker();
  enterScreen();
  pausePresentation();
})();
