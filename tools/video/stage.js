/**
 * Stage directions for the video pipeline, injected at the top of the preview's <head>.
 *
 * The preview is the real renderer on a real snapshot (tools/buildUiPreview.ts), so what
 * is filmed is the client rather than a mock-up of it. This file only does what a camera
 * operator would: hides the preview's own disclaimers, draws captions and a pointer, eases
 * the scroll, and plays the renderer's own state changes in order. It never computes a
 * score; the match the video shows is demo data from shots.json, labelled as such on screen.
 *
 * Runs in the page, so it is plain script rather than a module: it has to exist before
 * renderer.js, which calls render() the moment it loads.
 */
(() => {
  "use strict";

  // An offscreen window never has focus, and both the presentation layer and the star
  // chart pause themselves when the document does not: the first test render was a
  // perfectly still app. Pretending to be focused is what a person watching would see.
  document.hasFocus = () => true;

  const css = `
    /* Preview-only furniture: disclaimers written for someone opening the HTML file. */
    #previewNote, #tnPreviewNote, #footnote, #tnLive { display: none !important; }
    /* A scrollbar is the browser, not the product, and it jitters as the camera pans. */
    * { scrollbar-width: none !important; }
    *::-webkit-scrollbar { display: none !important; }
    /* Room to scroll the last panel clear of the caption band. In portrait the match list
       is the last thing on the page and could only reach the bottom third, under the band. */
    .scroll::after { content: ""; display: block; height: 36vh; }
    /* Hover states would otherwise stick to wherever the pointer last was. */
    html.video-stage { cursor: none !important; }

    /* Opaque over everything the caption's text can sit on, then a short fade. The first
       cut was a gradient that was already 10% see-through at the text's height, and the
       sidebar's rank, rating and streak read through behind "03" in the result shot. */
    .vs-caption { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; pointer-events: none;
      padding: 0 var(--vs-pad) var(--vs-pad); display: flex; align-items: flex-end;
      background: linear-gradient(to top, rgb(6,8,12) 0, rgb(6,8,12) 64%, rgba(6,8,12,.86) 76%, rgba(6,8,12,0) 100%);
      height: var(--vs-band); opacity: 0; transition: opacity .45s cubic-bezier(.2,.7,.2,1); }
    .vs-caption.on { opacity: 1; }
    .vs-caption .vs-inner { display: flex; gap: var(--vs-gap); align-items: baseline;
      transform: translateY(1.6vmin); transition: transform .7s cubic-bezier(.16,1,.3,1); }
    .vs-caption.on .vs-inner { transform: none; }
    /* The brand kit's faces (record.cjs inlines them), as on the title cards, rather than
       the app's Bahnschrift: the captions are the video's voice, not the app's UI. */
    .vs-caption .vs-index { font: 600 var(--vs-index-size) 'Apogee Mono', var(--mono, monospace); letter-spacing: .18em;
      color: var(--brand, #e5edb0); }
    .vs-caption .vs-text { font: 600 var(--vs-text-size)/1.04 'Apogee Display', var(--display, "Bahnschrift", sans-serif);
      letter-spacing: -.02em; color: var(--ink, #f2f0e8); }
    .vs-caption .vs-sub { display: block; margin-top: .9vmin; font: 400 var(--vs-sub-size)/1.3 'Apogee Display', var(--font, sans-serif);
      letter-spacing: 0; color: var(--ink-dim, #a4b2c4); }
    .vs-caption .vs-rule { display: block; height: 2px; width: 0; margin-top: 1.6vmin; background: var(--brand, #e5edb0);
      transition: width 1.1s cubic-bezier(.16,1,.3,1) .15s; }
    .vs-caption.on .vs-rule { width: var(--vs-rule); }

    .vs-pointer { position: fixed; left: 0; top: 0; z-index: 2147483001; pointer-events: none;
      width: var(--vs-pointer); height: var(--vs-pointer); opacity: 0;
      transition: opacity .3s, transform var(--vs-move, .8s) cubic-bezier(.65,0,.35,1); will-change: transform; }
    .vs-pointer.on { opacity: 1; }
    .vs-pointer svg { width: 100%; height: 100%; filter: drop-shadow(0 .3vmin .8vmin rgba(0,0,0,.6)); }
    .vs-ripple { position: fixed; z-index: 2147483000; pointer-events: none; border-radius: 50%;
      border: 2px solid var(--brand, #e5edb0); width: 1vmin; height: 1vmin; margin: -.5vmin 0 0 -.5vmin;
      animation: vs-ripple .7s cubic-bezier(.2,.7,.2,1) forwards; }
    @keyframes vs-ripple { to { width: 9vmin; height: 9vmin; margin: -4.5vmin 0 0 -4.5vmin; opacity: 0; } }
  `;

  const sizes = (portrait) => portrait
    ? `--vs-pad:6vmin;--vs-band:34vh;--vs-gap:3vmin;--vs-index-size:3.2vmin;--vs-text-size:7.4vmin;--vs-sub-size:3.3vmin;--vs-rule:16vmin;--vs-pointer:5.5vmin;`
    : `--vs-pad:4.4vmin;--vs-band:30vh;--vs-gap:2.4vmin;--vs-index-size:2.2vmin;--vs-text-size:6.2vmin;--vs-sub-size:2.4vmin;--vs-rule:12vmin;--vs-pointer:3.6vmin;`;

  let caption, pointer;
  let pointerAt = null;

  function mount() {
    document.documentElement.classList.add("video-stage");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    document.documentElement.style.cssText += sizes(innerHeight > innerWidth);
    caption = document.createElement("div");
    caption.className = "vs-caption";
    caption.innerHTML = '<div class="vs-inner"><span class="vs-index"></span><span class="vs-text"></span></div>';
    pointer = document.createElement("div");
    pointer.className = "vs-pointer";
    // The app's own pointer shape is the operating system's; a plain arrow in the brand ink
    // reads as "a person is doing this" without pretending to be a screen recording.
    pointer.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2.5 19.5 12l-7 1.6L9 20.5Z" fill="#f2f0e8" stroke="#090c12" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.append(caption, pointer);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** The element to act on: a selector, optionally narrowed to the one whose text matches. */
  function find(step) {
    const all = [...document.querySelectorAll(step.selector || "button")];
    const hit = step.text ? all.find((el) => el.textContent.includes(step.text) && el.getClientRects().length) : all.find((el) => el.getClientRects().length);
    if (!hit) throw new Error("stage: nothing matches " + JSON.stringify(step));
    return hit;
  }

  function scroller(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement;
  }

  /**
   * Scroll by tween rather than `behavior: smooth`, whose speed is the browser's and far
   * too quick to read on video. A camera move should take as long as the shot says.
   */
  async function tweenScroll(box, to, ms) {
    const from = box.scrollTop;
    to = Math.max(0, Math.min(to, box.scrollHeight - box.clientHeight));
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      box.scrollTop = from + (to - from) * ease(t);
      if (t >= 1) return;
      await new Promise(requestAnimationFrame);
    }
  }

  async function movePointer(el, ms) {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width * 0.5, 120), y = r.top + r.height * 0.55;
    pointer.style.setProperty("--vs-move", (pointerAt ? ms : 0) + "ms");
    if (!pointerAt) {
      // Enter from below-right of the target, as if the hand was already on the mouse.
      pointer.style.transform = `translate(${x + innerWidth * 0.12}px, ${y + innerHeight * 0.18}px)`;
      void pointer.offsetWidth;
      pointer.style.setProperty("--vs-move", ms + "ms");
    }
    pointer.classList.add("on");
    pointer.style.transform = `translate(${x}px, ${y}px)`;
    pointerAt = { x, y };
    await sleep(ms);
    return { x, y };
  }

  function ripple({ x, y }) {
    const r = document.createElement("div");
    r.className = "vs-ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    document.body.append(r);
    setTimeout(() => r.remove(), 800);
  }

  /* ------------------------------------------------ demo: the renderer's own states */

  // Declared in renderer.js at the top level of a classic script, so reachable by name.
  const R = (name) => {
    // eslint-disable-next-line no-new-func
    try { return Function("return typeof " + name + " === 'undefined' ? undefined : " + name)(); } catch { return undefined; }
  };

  // renderMatchReadiness() appends "example set" in the preview host, which is the
  // preview's disclaimer rather than the app's copy; the video carries its own label.
  const tidyReadiness = () => {
    const m = document.getElementById("matchReadiness");
    if (m) m.textContent = m.textContent.replace(/ · example set$/, "");
  };

  let searchTimer = 0;
  const demos = {
    /** The button's searching state, with its orb and ticking clock, as the app draws it. */
    search({ category }) {
      const setCommit = R("setCommit");
      const started = performance.now();
      const tick = () => {
        const s = Math.floor((performance.now() - started) / 1000);
        setCommit("working", "Searching", "matching on rating · " + category, "0:" + String(s).padStart(2, "0"));
      };
      tick();
      searchTimer = setInterval(tick, 250);
    },
    /** A match arriving: the renderer's own opponent card, list and held button. */
    found({ note }) {
      clearInterval(searchTimer);
      const current = R("current");
      R("showOpponent")(current);
      R("setCommit")("held", "Match in progress", "Play the 3 below in KovaaK’s", "");
      document.getElementById("oppAge").textContent = note || "demo opponent";
      document.getElementById("matchActions").hidden = false;
      tidyReadiness();
      document.getElementById("matchHint").textContent = "First run on each scenario counts. Scores are read automatically.";
      try { R("startMatchClock")(new Date(Date.now() + 44 * 60e3 + 12e3).toISOString()); } catch {}
    },
    /** One run read from the stats folder, as the list shows it when it lands. */
    land({ index, tier }) {
      const list = R("pendingScenarios");
      if (!list || !list[index]) return;
      list[index].done = true;
      list[index].justDone = true;
      list[index].tier = tier || "verified";
      R("renderTodo")(false);
      if (list.every((s) => s.done)) R("markAllIn")();
      tidyReadiness();
    },
    /** Replay the result screen's entrance on the demo match, then label it honestly. */
    result({ provenance }) {
      const current = R("current");
      R("renderResult")(current);
      if (provenance) document.getElementById("debriefProvenance").textContent = provenance;
    },
    /**
     * Ghost Mode's next screen from tools/video/ghost.json, pushed the way main pushes
     * apogee:ghost when a run lands. ghost.js plays the lane's 3-2-1 reveal itself.
     */
    ghost({ screen }) {
      window.__ghostPush(screen);
    },
    promotion({ from, to }) {
      R("showCelebration")({ promotion: { from, to } });
    },
    dismiss() {
      const b = document.getElementById("celebrateClose");
      if (b && !document.getElementById("celebrate").hidden) b.click();
    },
  };

  /* ------------------------------------------------------------------ steps */

  async function run(step) {
    switch (step.do) {
      case "screen": {
        document.querySelector(`.tab[data-screen="${step.screen}"]`).click();
        const box = document.querySelector(".scroll");
        if (box && step.top !== false) box.scrollTop = 0;
        return;
      }
      case "click": {
        const el = find(step);
        if (step.pointer !== false) {
          const at = await movePointer(el, step.ms ?? 700);
          await sleep(120);
          ripple(at);
        }
        // press:false shows the press without sending it, for a button whose preview
        // behaviour is not the app's (Find opponent jumps straight to the example match
        // there); a `demo` step then plays what the app would do instead.
        if (step.press !== false) el.click();
        return;
      }
      case "point":
        await movePointer(find(step), step.ms ?? 700);
        return;
      case "hidePointer":
        pointer.classList.remove("on");
        pointerAt = null;
        return;
      case "scroll": {
        const el = find(step);
        const box = scroller(el);
        const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
        const offset = (step.offset ?? 0.08) * box.clientHeight;
        await tweenScroll(box, top - offset, step.ms ?? 1200);
        return;
      }
      case "scrollBy": {
        const box = document.querySelector(step.selector || ".scroll");
        await tweenScroll(box, box.scrollTop + step.by * box.clientHeight, step.ms ?? 1200);
        return;
      }
      case "caption": {
        if (step.hide) { caption.classList.remove("on"); return; }
        caption.querySelector(".vs-index").textContent = step.index || "";
        caption.querySelector(".vs-text").innerHTML =
          esc(step.text) + (step.sub ? '<span class="vs-sub">' + esc(step.sub) + "</span>" : "") + '<span class="vs-rule"></span>';
        caption.classList.remove("on");
        void caption.offsetWidth;
        caption.classList.add("on");
        return;
      }
      case "demo":
        return demos[step.name](step);
      default:
        throw new Error("stage: unknown step " + step.do);
    }
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  window.__stage = { run };
})();
