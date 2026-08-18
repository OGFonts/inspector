(() => {
  try {
    window.__ogfontsInspector?.destroy?.();
  } catch {
    // previous instance may already be dead after an extension reload
  }
  document.querySelectorAll('ogfonts-inspector-root').forEach((node) => {
    try { node.remove(); } catch { /* ignore */ }
  });
  window.__ogfontsInspectorLoaded = true;

  const HOST_TAG = 'ogfonts-inspector-root';
  const IS_TOP = window === window.top;
  const PANGRAM = 'The quick brown fox jumps over the lazy dog';
  const OT_FEATURES = ['liga', 'kern', 'smcp', 'tnum', 'zero', 'onum', 'ss01', 'ss02'];
  const WEIGHTS = {
    100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium',
    600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black', normal: 'Regular', bold: 'Bold',
  };
  const TW_SIZE = { 12: 'text-xs', 14: 'text-sm', 16: 'text-base', 18: 'text-lg', 20: 'text-xl', 24: 'text-2xl', 30: 'text-3xl', 36: 'text-4xl', 48: 'text-5xl', 60: 'text-6xl' };
  const TW_WEIGHT = {
    100: 'font-thin', 200: 'font-extralight', 300: 'font-light', 400: 'font-normal',
    500: 'font-medium', 600: 'font-semibold', 700: 'font-bold', 800: 'font-extrabold', 900: 'font-black',
  };

  let active = false;
  let pinned = false;
  let tab = 'inspect';
  let exportFormat = 'css';
  let highlighting = false;
  let showPangram = false;
  let otOn = new Set();
  let currentEl = null;
  let currentSnapshot = null;
  let lockedEl = null;
  let lockedSnapshot = null;
  let peeking = false;
  let compareA = null;
  let compareB = null;
  let inventory = null;
  let matchEls = [];
  let drag = null;
  let resize = null;
  let toastTimer = 0;
  let hoverCueAt = 0;
  let theme = 'dark';
  let soundOn = true;
  let host = null;
  let shadow = null;
  let destroyed = false;
  let hoverRaf = 0;
  let hoverPoint = null;
  let scrollRaf = 0;
  let lastInspectKey = '';
  let lastHighlightBox = '';
  let lastLockBox = '';
  let faceIndex = null;
  let hasGoogleFonts = null;
  let panelCssText = '';
  const snapCache = new WeakMap();
  const detectCache = new Map();
  const DETECT_CACHE_MAX = 240;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD',
    'BR', 'HR', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IFRAME', 'PATH',
  ]);
  const PASSIVE_CAPTURE = { capture: true, passive: true };
  const CAPTURE = { capture: true };
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const refs = {};

  function extAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function isExtGone(err) {
    const msg = String(err?.message || err?.reason || err || '');
    return /extension context invalidated|context invalidated/i.test(msg);
  }

  function settle(value, onFail) {
    try {
      Promise.resolve(value).then(() => {}, (err) => {
        if (typeof onFail === 'function') onFail(err);
      });
    } catch (err) {
      if (typeof onFail === 'function') onFail(err);
    }
  }

  function onUnhandledRejection(event) {
    if (!isExtGone(event.reason)) return;
    event.preventDefault();
    teardown();
  }

  window.addEventListener('unhandledrejection', onUnhandledRejection);

  function guardExt() {
    if (destroyed) return false;
    if (extAlive()) return true;
    teardown();
    return false;
  }

  function sendRuntime(message) {
    if (destroyed) return;
    try {
      if (!chrome.runtime?.id) {
        teardown();
        return;
      }
      settle(chrome.runtime.sendMessage(message), (err) => {
        if (isExtGone(err)) teardown();
      });
    } catch {
      teardown();
    }
  }

  function storeSet(value) {
    if (destroyed) return;
    try {
      if (!chrome.runtime?.id) return;
      settle(chrome.storage.local.set(value));
    } catch {
      // storage is gone after an extension reload
    }
  }

  function extUrl(path) {
    if (!guardExt()) return '';
    try {
      return chrome.runtime.getURL(path);
    } catch (err) {
      if (isExtGone(err)) teardown();
      return '';
    }
  }

  function teardown() {
    if (destroyed) return;
    destroyed = true;
    active = false;
    cancelScheduled();
    try { bindPage(false); } catch { /* ignore */ }
    try { unmount(); } catch { /* ignore */ }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* ignore */ }
    try { window.removeEventListener('unhandledrejection', onUnhandledRejection); } catch { /* ignore */ }
    window.__ogfontsInspectorLoaded = false;
    window.__ogfontsInspector = null;
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!guardExt()) return false;
    if (message?.type === 'OGFONTS_TOGGLE') {
      const run = setActive(!active);
      if (!IS_TOP) return false;
      run.then(() => {
        try { sendResponse({ active }); } catch { /* context gone */ }
      }).catch(() => {});
      return true;
    }
    if (message?.type === 'OGFONTS_PING') {
      if (!IS_TOP) return false;
      sendResponse({ active });
      return true;
    }
    if (message?.type === 'OGFONTS_FRAME_DATA' && IS_TOP) {
      if (!active || drag || resize) return false;
      const snap = message.snapshot;
      showInspect(null, snap, !!(lockedEl && lockedSnapshot));
      return false;
    }
    return false;
  }

  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    window.__ogfontsInspectorLoaded = false;
    return;
  }

  window.__ogfontsInspector = { destroy: teardown };

  async function setActive(next) {
    if (!guardExt()) return;
    active = next;
    pinned = false;
    lockedEl = null;
    lockedSnapshot = null;
    peeking = false;
    highlighting = false;
    matchEls = [];
    if (IS_TOP) sendRuntime({ type: 'OGFONTS_STATE', active });

    if (active) {
      if (IS_TOP) {
        await mount();
        if (!active) return;
        inspectInitial();
      }
      bindPage(true);
    } else {
      cancelScheduled();
      bindPage(false);
      if (IS_TOP) unmount();
    }
  }

  function cancelScheduled() {
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    hoverRaf = 0;
    scrollRaf = 0;
    hoverPoint = null;
  }

  function bindPage(on) {
    const fn = on ? 'addEventListener' : 'removeEventListener';
    document[fn]('pointermove', onPointerMove, PASSIVE_CAPTURE);
    document[fn]('pointerdown', onPagePointerDown, CAPTURE);
    document[fn]('click', onPageClick, CAPTURE);
    document[fn]('keydown', onKeyDown, CAPTURE);
    document[fn]('scroll', onScroll, PASSIVE_CAPTURE);
    window[fn]('resize', onScroll, PASSIVE_CAPTURE);
  }

  async function mount() {
    if (host) return;
    if (!guardExt()) return;
    let cssText = panelCssText;
    if (!cssText) {
      const cssUrl = extUrl('panel.css');
      try {
        cssText = cssUrl ? await fetch(cssUrl).then((r) => r.text()) : '';
        panelCssText = cssText;
      } catch {
        cssText = '';
      }
    }
    if (!active || host || !guardExt()) return;

    host = document.createElement(HOST_TAG);
    host.style.pointerEvents = 'none';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    const regular = extUrl('fonts/FiraCode-Regular.woff2');
    const semibold = extUrl('fonts/FiraCode-SemiBold.woff2');
    style.textContent = `
      @font-face {
        font-family: "Fira Code";
        src: url("${regular}") format("woff2");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "Fira Code";
        src: url("${semibold}") format("woff2");
        font-weight: 600;
        font-style: normal;
        font-display: swap;
      }
    ` + cssText;
    shadow.innerHTML = `
      <div class="root">
        <div class="highlight"></div>
        <div class="lock-mark"></div>
        <div class="matches"></div>
        <div class="panel">
          <div class="header">
            <div class="mark" aria-hidden="true"><i></i><i></i></div>
            <div class="wordmark">OG<span>Fonts</span></div>
            <div class="actions">
              <button class="icon-btn theme" type="button" title="Toggle light / dark">Dark</button>
              <button class="icon-btn sound is-on" type="button" title="Toggle sound">Sound</button>
              <button class="icon-btn pin" type="button" title="Lock this type (click text or press P)">Lock</button>
              <button class="icon-btn close" type="button" title="Close (Esc)">✕</button>
            </div>
          </div>
          <div class="tabs">
            <button class="tab is-on" data-action="tab" data-tab="inspect" type="button">Inspect</button>
            <button class="tab" data-action="tab" data-tab="page" type="button">Page</button>
            <button class="tab" data-action="tab" data-tab="compare" type="button">Compare</button>
          </div>
          <div class="hint">Hover to preview · click to lock · hover still peeks after lock</div>
          <div class="body"></div>
          <div class="footer">
            <select class="select" data-action="format" title="Export format">
              <option value="css">CSS</option>
              <option value="tokens">Tokens</option>
              <option value="tailwind">Tailwind</option>
              <option value="json">JSON</option>
            </select>
            <button class="btn btn-primary" data-action="copy" type="button">Copy</button>
            <button class="btn btn-ghost" data-action="highlight" type="button">Highlight</button>
          </div>
          <div class="toast">Copied</div>
          <div class="resize resize-n" data-resize="n"></div>
          <div class="resize resize-s" data-resize="s"></div>
          <div class="resize resize-w" data-resize="w"></div>
          <div class="resize resize-e" data-resize="e"></div>
          <div class="resize resize-nw" data-resize="nw"></div>
          <div class="resize resize-se" data-resize="se"></div>
        </div>
      </div>
    `;
    shadow.prepend(style);

    refs.root = shadow.querySelector('.root');
    refs.highlight = shadow.querySelector('.highlight');
    refs.lockMark = shadow.querySelector('.lock-mark');
    refs.matches = shadow.querySelector('.matches');
    refs.panel = shadow.querySelector('.panel');
    refs.header = shadow.querySelector('.header');
    refs.body = shadow.querySelector('.body');
    refs.pin = shadow.querySelector('.pin');
    refs.theme = shadow.querySelector('.theme');
    refs.sound = shadow.querySelector('.sound');
    refs.close = shadow.querySelector('.close');
    refs.toast = shadow.querySelector('.toast');
    refs.format = shadow.querySelector('.select');

    refs.close.addEventListener('click', () => {
      cue('droplet');
      setActive(false);
    });
    refs.pin.addEventListener('click', togglePin);
    refs.theme.addEventListener('click', toggleTheme);
    refs.sound.addEventListener('click', toggleSound);
    refs.header.addEventListener('pointerdown', onDragStart);
    refs.panel.addEventListener('click', onPanelClick);
    refs.panel.addEventListener('pointerdown', onResizeStart);
    refs.format.addEventListener('change', () => {
      exportFormat = refs.format.value;
      if (tab === 'inspect' && currentSnapshot) render();
    });

    restorePrefs();
    document.documentElement.appendChild(host);
  }

  function unmount() {
    host?.remove();
    host = null;
    shadow = null;
    currentEl = null;
    currentSnapshot = null;
    lockedEl = null;
    lockedSnapshot = null;
    peeking = false;
    inventory = null;
    compareA = null;
    compareB = null;
    matchEls = [];
    drag = null;
    resize = null;
    lastInspectKey = '';
    lastHighlightBox = '';
    lastLockBox = '';
    faceIndex = null;
    hasGoogleFonts = null;
    detectCache.clear();
    if (refs.matches) refs.matches.textContent = '';
  }

  function inspectInitial() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (el instanceof Element && !isInspectorNode(el)) {
        lockElement(el);
        return;
      }
    }
    const el = pickElFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    if (el) inspect(el);
  }

  function isInspectorNode(el) {
    if (!el) return false;
    if (el === host || host?.contains(el)) return true;
    return String(el.tagName || '').toLowerCase() === HOST_TAG;
  }

  function isOurNode(node) {
    if (!IS_TOP || !host || !node) return false;
    if (node === host) return true;
    if (node instanceof Element && String(node.tagName || '').toLowerCase() === HOST_TAG) return true;
    return typeof node.getRootNode === 'function' && node.getRootNode() === shadow;
  }

  function isOurEvent(event) {
    return isOurNode(event.target);
  }

  function pickElFromPoint(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (let i = 0; i < stack.length; i++) {
      const el = stack[i];
      if (!(el instanceof Element) || isInspectorNode(el)) continue;
      return el;
    }
    return null;
  }

  function pickEl(event) {
    const t = event.target;
    if (t instanceof Element && !isInspectorNode(t) && !isOurNode(t)) return t;
    return pickElFromPoint(event.clientX, event.clientY);
  }

  function onPointerMove(event) {
    if (!active || drag || resize || destroyed) return;
    hoverPoint = { x: event.clientX, y: event.clientY, target: event.target };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(flushHover);
  }

  function flushHover() {
    hoverRaf = 0;
    const point = hoverPoint;
    hoverPoint = null;
    if (!point || !guardExt() || !active || drag || resize) return;
    if (isOurNode(point.target)) {
      restoreLocked();
      return;
    }
    let el = null;
    const t = point.target;
    if (t instanceof Element && !isInspectorNode(t) && !isOurNode(t)) el = t;
    else el = pickElFromPoint(point.x, point.y);
    if (!el) {
      restoreLocked();
      return;
    }
    const peek = !!(lockedEl && el !== lockedEl);
    if (el === currentEl && peeking === peek) {
      positionHighlight(el);
      return;
    }
    cueHover();
    showInspect(el, snapshot(el), peek);
  }

  function onPagePointerDown(event) {
    if (!guardExt() || !active || event.button !== 0 || drag || resize) return;
    if (isOurEvent(event)) return;
    const el = pickEl(event) || currentEl;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    lockElement(el);
  }

  function onPageClick(event) {
    if (!guardExt() || !active) return;
    if (isOurEvent(event)) return;
    if (!(event.target instanceof Element) || isInspectorNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function lockElement(el) {
    const snap = snapshot(el);
    lockedEl = el;
    lockedSnapshot = snap;
    pinned = true;
    showInspect(el, snap, false);
    updatePin();
    cue('press');
    toast('Locked');
  }

  function restoreLocked() {
    if (!lockedSnapshot || !peeking) return;
    showInspect(lockedEl, lockedSnapshot, false);
  }

  function showInspect(el, snap, peek) {
    currentEl = el;
    currentSnapshot = snap;
    peeking = !!peek;
    if (!IS_TOP) {
      sendRuntime({ type: 'OGFONTS_FROM_FRAME', snapshot: snap });
      return;
    }
    positionHighlight(el);
    positionLockMark();
    updatePeekChrome();
    if (tab === 'inspect') {
      const key = inspectKey(snap);
      if (key !== lastInspectKey) {
        lastInspectKey = key;
        refs.body.innerHTML = snap ? renderInspect(snap) : inspectEmpty();
      }
    }
  }

  function inspectEmpty() {
    return `<div class="empty"><strong>Hover any text</strong>Click to pin. Open Page to audit every type style on this site.</div>`;
  }

  function inspectKey(s) {
    if (!s) return `empty|${peeking}|${pinned}|${exportFormat}|${showPangram}`;
    return [
      s.selector, s.family, s.size, s.weight, s.color, s.background, s.preview,
      s.file, peeking, pinned, exportFormat, showPangram, [...otOn].join(','),
    ].join('\0');
  }

  function onScroll() {
    if (!active || destroyed) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(flushScroll);
  }

  function flushScroll() {
    scrollRaf = 0;
    if (!guardExt() || !active) return;
    lastHighlightBox = '';
    lastLockBox = '';
    if (currentEl) positionHighlight(currentEl);
    positionLockMark();
    if (highlighting) drawMatches();
  }

  function onKeyDown(event) {
    if (!guardExt() || !active) return;
    const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]');
    if (event.key === 'Escape') {
      event.preventDefault();
      if (highlighting) {
        highlighting = false;
        matchEls = [];
        drawMatches();
        return;
      }
      if (pinned) {
        pinned = false;
        lockedEl = null;
        lockedSnapshot = null;
        peeking = false;
        updatePin();
        updatePeekChrome();
        return;
      }
      setActive(false);
      return;
    }
    if (typing || !IS_TOP) return;
    const key = event.key.toLowerCase();
    if (key === 'p') {
      event.preventDefault();
      togglePin();
    } else if (key === 'h') {
      event.preventDefault();
      toggleHighlight();
    } else if (key === 'c' && (event.metaKey || event.ctrlKey)) {
      return;
    } else if (key === 'c') {
      event.preventDefault();
      copyExport();
    } else if (event.key === '[') {
      event.preventDefault();
      walkParent();
    } else if (event.key === ']') {
      event.preventDefault();
      walkChild();
    } else if (key === '1') setTab('inspect');
    else if (key === '2') setTab('page');
    else if (key === '3') setTab('compare');
  }

  function onPanelClick(event) {
    const actionEl = event.target.closest('[data-action]');
    const copyEl = event.target.closest('[data-copy]');
    if (actionEl) {
      const action = actionEl.getAttribute('data-action');
      if (action === 'tab') setTab(actionEl.getAttribute('data-tab'));
      else if (action === 'copy') copyExport();
      else if (action === 'highlight') toggleHighlight();
      else if (action === 'parent') walkParent();
      else if (action === 'child') walkChild();
      else if (action === 'pangram') {
        showPangram = !showPangram;
        render();
      } else if (action === 'ot') {
        const feat = actionEl.getAttribute('data-feat');
        if (otOn.has(feat)) otOn.delete(feat);
        else otOn.add(feat);
        render();
      } else if (action === 'set-a' && currentSnapshot) {
        compareA = currentSnapshot;
        setTab('compare');
      } else if (action === 'set-b' && currentSnapshot) {
        compareB = currentSnapshot;
        setTab('compare');
      } else if (action === 'scan') {
        faceIndex = null;
        hasGoogleFonts = null;
        inventory = scanPage();
        render();
      } else if (action === 'copy-page') {
        if (!inventory) inventory = scanPage();
        copyText(pageTokens(inventory));
      } else if (action === 'inv') {
        const key = actionEl.getAttribute('data-key');
        const row = inventory?.styles.find((s) => s.key === key);
        if (row?.el) {
          lockElement(row.el);
          highlighting = true;
          matchEls = findMatches(row.family, row.size, row.weight);
          drawMatches();
          setTab('inspect');
        }
      }
      return;
    }
    if (copyEl) copyText(copyEl.getAttribute('data-copy') || '');
  }

  function setTab(next) {
    tab = next;
    if (!IS_TOP || !shadow) return;
    shadow.querySelectorAll('.tab').forEach((btn) => {
      btn.classList.toggle('is-on', btn.getAttribute('data-tab') === tab);
    });
    if (tab === 'page' && !inventory) inventory = scanPage();
    cue('page');
    render();
  }

  function togglePin() {
    if (pinned) {
      pinned = false;
      lockedEl = null;
      lockedSnapshot = null;
      peeking = false;
      updatePin();
      updatePeekChrome();
      return;
    }
    if (currentEl) lockElement(currentEl);
    else {
      pinned = true;
      updatePin();
    }
  }

  function updatePin() {
    if (!refs.pin) return;
    refs.pin.classList.toggle('is-on', pinned);
    refs.pin.textContent = pinned ? 'Locked' : 'Lock';
    refs.panel?.classList.toggle('is-locked', pinned);
    const hint = shadow?.querySelector('.hint');
    if (hint) {
      hint.textContent = pinned
        ? 'Locked stays. Hover anything else to peek, then it returns.'
        : 'Hover to preview · click to lock · hover still peeks after lock';
    }
  }

  function updatePeekChrome() {
    refs.panel?.classList.toggle('is-peek', peeking);
    refs.highlight?.classList.toggle('is-peek', peeking);
  }

  function inspect(el) {
    showInspect(el, snapshot(el), !!(lockedEl && el !== lockedEl));
  }

  function positionHighlight(el) {
    if (!IS_TOP || !refs.highlight) return;
    if (!el?.isConnected) {
      refs.highlight.style.display = 'none';
      lastHighlightBox = '';
      return;
    }
    const r = el.getBoundingClientRect();
    const css = `${Math.round(r.top)}|${Math.round(r.left)}|${Math.round(r.width)}|${Math.round(r.height)}|${peeking}`;
    if (css === lastHighlightBox) return;
    lastHighlightBox = css;
    refs.highlight.style.display = 'block';
    refs.highlight.style.top = `${Math.round(r.top) - 2}px`;
    refs.highlight.style.left = `${Math.round(r.left) - 2}px`;
    refs.highlight.style.width = `${Math.round(r.width) + 4}px`;
    refs.highlight.style.height = `${Math.round(r.height) + 4}px`;
    refs.highlight.classList.toggle('is-peek', peeking);
  }

  function positionLockMark() {
    if (!IS_TOP || !refs.lockMark) return;
    if (!peeking || !lockedEl?.isConnected) {
      if (lastLockBox) {
        refs.lockMark.style.display = 'none';
        lastLockBox = '';
      }
      return;
    }
    const r = lockedEl.getBoundingClientRect();
    const css = `${Math.round(r.top)}|${Math.round(r.left)}|${Math.round(r.width)}|${Math.round(r.height)}`;
    if (css === lastLockBox) return;
    lastLockBox = css;
    refs.lockMark.style.display = 'block';
    refs.lockMark.style.top = `${Math.round(r.top) - 2}px`;
    refs.lockMark.style.left = `${Math.round(r.left) - 2}px`;
    refs.lockMark.style.width = `${Math.round(r.width) + 4}px`;
    refs.lockMark.style.height = `${Math.round(r.height) + 4}px`;
  }

  function walkParent() {
    if (!currentEl?.parentElement || currentEl.parentElement === document.documentElement) return;
    lockElement(currentEl.parentElement);
  }

  function walkChild() {
    if (!currentEl) return;
    const child = [...currentEl.children].find((n) => hasOwnText(n) || sampleText(n));
    if (!child) return;
    lockElement(child);
  }

  function snapshot(el) {
    const style = getComputedStyle(el);
    const preview = sampleText(el) || 'Ag';
    const sig = [
      style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.fontStretch,
      style.lineHeight, style.letterSpacing, style.wordSpacing, style.color,
      style.fontFeatureSettings, style.fontVariationSettings, style.textTransform,
      style.textAlign, preview,
    ].join('\0');
    const hit = snapCache.get(el);
    if (hit && hit.sig === sig) return hit.snap;

    const families = splitFamilies(style.fontFamily);
    const rendered = detectRenderedFont(families, style, preview);
    const faces = findFontFaces(rendered || families[0]);
    const file = firstFontFile(faces);
    const source = classifySource(rendered, faces);
    const bg = nearestBackground(el);
    const color = style.color;
    const size = style.fontSize;
    const metrics = glyphMetrics(rendered, style.fontWeight, parseFloat(size), el);
    const contrastInfo = contrastMessage(color, bg, size, style.fontWeight);
    const css = toCss(style, rendered);
    const exports = toExports(style, rendered, css);
    const snap = {
      selector: shortSelector(el),
      preview,
      family: rendered,
      stack: families,
      weight: style.fontWeight,
      weightLabel: weightLabel(style.fontWeight),
      style: style.fontStyle,
      stretch: style.fontStretch,
      size,
      lineHeight: style.lineHeight,
      lineHeightUnitless: unitlessLineHeight(size, style.lineHeight),
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
      transform: style.textTransform,
      decoration: style.textDecorationLine,
      align: style.textAlign,
      variants: style.fontVariant,
      featureSettings: style.fontFeatureSettings,
      variationSettings: style.fontVariationSettings,
      kerning: style.fontKerning,
      opticalSizing: style.fontOpticalSizing,
      color,
      colorHex: toHex(color),
      background: bg,
      backgroundHex: toHex(bg),
      contrast: contrastInfo,
      source,
      file: file || (faces.length ? '' : 'n/a (system / CORS)'),
      faces: faces.map((f) => ({ src: f.file, weight: f.weight, style: f.style })),
      css,
      exports,
      metrics,
      element: el.tagName.toLowerCase(),
    };
    snapCache.set(el, { sig, snap });
    return snap;
  }

  function render() {
    if (!IS_TOP || !refs.body) return;
    if (tab === 'page') {
      lastInspectKey = '';
      refs.body.innerHTML = renderPage();
      return;
    }
    if (tab === 'compare') {
      lastInspectKey = '';
      refs.body.innerHTML = renderCompare();
      return;
    }
    if (!currentSnapshot) {
      lastInspectKey = inspectKey(null);
      refs.body.innerHTML = inspectEmpty();
      return;
    }
    lastInspectKey = inspectKey(currentSnapshot);
    refs.body.innerHTML = renderInspect(currentSnapshot);
  }

  function renderInspect(s) {
    const preview = showPangram ? PANGRAM : s.preview;
    const otCss = otOn.size
      ? `font-feature-settings:${[...otOn].map((f) => `"${f}" 1`).join(',')};`
      : '';
    const exported = exportText(s);
    return `
      <div class="tagline">
        <code>${escapeHtml(s.selector)}</code>
        <span>${peeking ? 'Peek' : pinned ? 'Locked' : escapeHtml(s.source)}</span>
      </div>
      <div class="toolbar">
        <button class="mini" data-action="parent" type="button">Parent [</button>
        <button class="mini" data-action="child" type="button">Child ]</button>
        <button class="mini${showPangram ? ' is-on' : ''}" data-action="pangram" type="button">Pangram</button>
        <button class="mini" data-action="set-a" type="button">Set A</button>
        <button class="mini" data-action="set-b" type="button">Set B</button>
      </div>
      <div class="specimen">
        <div class="specimen-lg" style="${specimenStyle(s)};${otCss}">${escapeHtml(preview)}</div>
        <div class="specimen-sm">${escapeHtml(s.family)} · ${escapeHtml(s.weightLabel)}</div>
      </div>
      <div class="kpis">
        ${kpi('Size', s.size)}
        ${kpi('Line', lineDisplay(s))}
        ${kpi('CPL', s.metrics.cpl)}
      </div>
      <div class="section">
        <div class="section-title">Type</div>
        ${row('Rendered', s.family)}
        <div class="row" data-copy="${escapeAttr(s.stack.join(', '))}">
          <div class="k">Stack</div>
          <div class="v"><div class="stack">${s.stack.map((f) =>
            `<span class="chip${f === s.family ? ' is-live' : ''}">${escapeHtml(f)}</span>`
          ).join('')}</div></div>
        </div>
        ${row('Weight', s.weightLabel)}
        ${row('Style', `${s.style} · ${s.stretch}`)}
        ${row('File', s.file || 'blocked by CORS')}
        ${s.faces.length ? row('Faces', `${s.faces.length} @font-face`) : ''}
      </div>
      <div class="section">
        <div class="section-title">Metrics</div>
        ${row('Letter', s.letterSpacing)}
        ${row('Word', s.wordSpacing)}
        ${row('x-height', s.metrics.xHeight)}
        ${row('Cap height', s.metrics.capHeight)}
        ${row('Align', s.align)}
        ${row('Transform', s.transform)}
        ${row('Line length', s.metrics.lineAdvice)}
      </div>
      <div class="section">
        <div class="section-title">Color &amp; a11y</div>
        <div class="colors">
          ${swatch('Text', s.colorHex || s.color, s.colorHex || s.color)}
          ${swatch('Background', s.backgroundHex || s.background, s.backgroundHex || s.background)}
          <div class="swatch-row" data-copy="${escapeAttr(s.contrast.message)}">
            <div class="swatch-meta">
              <div class="name">Contrast</div>
              <div class="hex">${escapeHtml(s.contrast.ratio)}</div>
            </div>
            <span class="badge badge-${s.contrast.level}">${escapeHtml(s.contrast.levelLabel)}</span>
          </div>
        </div>
        ${row('Min size', s.metrics.sizeAdvice)}
      </div>
      <div class="section">
        <div class="section-title">OpenType playground</div>
        <div class="ot">${OT_FEATURES.map((f) =>
          `<button class="ot-btn${otOn.has(f) ? ' is-on' : ''}" data-action="ot" data-feat="${f}" type="button">${f}</button>`
        ).join('')}</div>
        ${row('Computed', s.featureSettings)}
        ${row('Axes', s.variationSettings)}
      </div>
      <div class="section">
        <div class="section-title">Export (${exportFormat})</div>
        <pre class="css-box" data-copy="${escapeAttr(exported)}">${escapeHtml(exported)}</pre>
      </div>
    `;
  }

  function renderPage() {
    const data = inventory || scanPage();
    inventory = data;
    const maxSize = Math.max(...data.scale.map((s) => s.px), 1);
    return `
      <div class="toolbar">
        <button class="mini" data-action="scan" type="button">Rescan</button>
        <button class="mini" data-action="copy-page" type="button">Copy page tokens</button>
      </div>
      <div class="kpis">
        ${kpi('Families', String(data.families.length))}
        ${kpi('Styles', String(data.styles.length))}
        ${kpi('Loaded', String(data.loaded.length))}
      </div>
      <div class="section">
        <div class="section-title">Type scale</div>
        ${data.scale.map((s) => `
          <div class="scale" data-action="inv" data-key="${escapeAttr(s.key)}">
            <div class="n">${escapeHtml(String(s.px))}px</div>
            <div class="bar" style="width:${Math.max(8, (s.px / maxSize) * 120)}px"></div>
            <div class="sample" style="font-family:${escapeAttr(s.family)};font-size:${s.px}px;font-weight:${escapeAttr(s.weight)}">${escapeHtml(s.family)}</div>
          </div>
        `).join('') || '<div class="empty">No text found</div>'}
      </div>
      <div class="section">
        <div class="section-title">Every style on this page</div>
        ${data.styles.map((s) => `
          <div class="inv" data-action="inv" data-key="${escapeAttr(s.key)}">
            <div class="name">${escapeHtml(s.family)}</div>
            <div class="count">${s.count}</div>
            <div class="meta">${escapeHtml(s.size)} · ${escapeHtml(weightLabel(s.weight))} · ${escapeHtml(s.source)}</div>
          </div>
        `).join('')}
      </div>
      <div class="section">
        <div class="section-title">Loaded faces</div>
        ${data.loaded.map((f) => row(f.family, `${f.weight} ${f.style} · ${f.status}`)).join('') || row('None', 'No FontFace entries')}
      </div>
    `;
  }

  function renderCompare() {
    return `
      <div class="toolbar">
        <button class="mini" data-action="set-a" type="button">Capture A</button>
        <button class="mini" data-action="set-b" type="button">Capture B</button>
      </div>
      <div class="compare">
        ${slot('A', compareA)}
        ${slot('B', compareB)}
      </div>
      <div class="section">
        <div class="section-title">Diff</div>
        ${compareA && compareB ? diffRows(compareA, compareB) : '<div class="empty">Pin two elements, then Capture A and B.</div>'}
      </div>
    `;
  }

  function slot(label, snap) {
    if (!snap) return `<div class="slot"><h4>${label}</h4><div class="empty">Empty</div></div>`;
    return `<div class="slot"><h4>${label}</h4><div class="name">${escapeHtml(snap.family)}</div>
      <div class="meta">${escapeHtml(snap.size)} · ${escapeHtml(snap.weightLabel)}</div></div>`;
  }

  function diffRows(a, b) {
    const keys = [
      ['family', 'Family'], ['size', 'Size'], ['weightLabel', 'Weight'], ['lineHeight', 'Line'],
      ['letterSpacing', 'Letter'], ['colorHex', 'Color'], ['contrast.ratio', 'Contrast'],
    ];
    return keys.map(([path, label]) => {
      const va = getPath(a, path);
      const vb = getPath(b, path);
      const changed = String(va) !== String(vb);
      return `<div class="row${changed ? ' diff' : ''}" data-copy="${escapeAttr(`${va} → ${vb}`)}">
        <div class="k">${escapeHtml(label)}</div>
        <div class="v">${escapeHtml(String(va))} → ${escapeHtml(String(vb))}</div>
      </div>`;
    }).join('');
  }

  function getPath(obj, path) {
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
  }

  function kpi(label, value) {
    return `<div class="kpi"><div class="label">${escapeHtml(label)}</div><div class="value" data-copy="${escapeAttr(value)}">${escapeHtml(value)}</div></div>`;
  }

  function row(label, value) {
    return `<div class="row" data-copy="${escapeAttr(value)}"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value)}</div></div>`;
  }

  function swatch(name, hex, raw) {
    return `<div class="swatch-row" data-copy="${escapeAttr(hex)}">
      <div class="swatch"><span style="background:${escapeAttr(raw)}"></span></div>
      <div class="swatch-meta"><div class="name">${escapeHtml(name)}</div><div class="hex">${escapeHtml(hex)}</div></div>
    </div>`;
  }

  function specimenStyle(s) {
    return [
      `font-family:${cssQuote(s.family)}, ${s.stack.map(cssQuote).join(', ')}`,
      `font-weight:${s.weight}`,
      `font-style:${s.style}`,
      `letter-spacing:${s.letterSpacing}`,
      `color:${s.colorHex || s.color}`,
    ].join(';');
  }

  function lineDisplay(s) {
    return s.lineHeightUnitless ? `${s.lineHeight} (${s.lineHeightUnitless})` : s.lineHeight;
  }

  function exportText(s) {
    if (exportFormat === 'json') {
      return JSON.stringify({ ...s, exports: undefined }, null, 2);
    }
    return s.exports[exportFormat] || s.css;
  }

  function scanPage() {
    const styles = new Map();
    const families = new Map();
    getFaceIndex();
    pageHasGoogleFonts();
    const root = document.body;
    if (!root) {
      return { families: [], styles: [], scale: [], loaded: [] };
    }
    const nodes = root.getElementsByTagName('*');
    const limit = Math.min(nodes.length, 5000);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      if (SKIP_TAGS.has(el.tagName) || el.closest(HOST_TAG)) continue;
      if (!hasOwnText(el)) continue;
      const text = sampleText(el);
      if (!text) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const family = detectRenderedFont(splitFamilies(st.fontFamily), st, text);
      const px = Math.round(parseFloat(st.fontSize));
      const key = `${family}|${px}|${st.fontWeight}|${st.fontStyle}`;
      const prev = styles.get(key);
      if (prev) prev.count += 1;
      else {
        styles.set(key, {
          key, family, size: st.fontSize, px, weight: st.fontWeight, style: st.fontStyle,
          count: 1, el, source: classifySource(family, findFontFaces(family)),
        });
      }
      families.set(family, (families.get(family) || 0) + 1);
    }
    const styleList = [...styles.values()].sort((a, b) => b.count - a.count);
    const scaleMap = new Map();
    for (let i = 0; i < styleList.length; i++) {
      const s = styleList[i];
      if (!scaleMap.has(s.px) || scaleMap.get(s.px).count < s.count) scaleMap.set(s.px, s);
    }
    const scale = [...scaleMap.values()].sort((a, b) => b.px - a.px);
    const loaded = [];
    try {
      for (const face of document.fonts) {
        loaded.push({
          family: face.family,
          weight: String(face.weight),
          style: face.style,
          status: face.status,
        });
      }
    } catch {
      // ignore
    }
    return {
      families: [...families.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      styles: styleList,
      scale,
      loaded,
    };
  }

  function findMatches(family, size, weight) {
    const out = [];
    const px = Math.round(parseFloat(size));
    const root = document.body;
    if (!root) return out;
    const nodes = root.getElementsByTagName('*');
    const limit = Math.min(nodes.length, 5000);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      if (SKIP_TAGS.has(el.tagName) || el.closest(HOST_TAG) || !hasOwnText(el)) continue;
      const text = sampleText(el);
      if (!text) continue;
      const st = getComputedStyle(el);
      if (Math.round(parseFloat(st.fontSize)) !== px || String(st.fontWeight) !== String(weight)) continue;
      if (detectRenderedFont(splitFamilies(st.fontFamily), st, text) === family) out.push(el);
      if (out.length >= 80) break;
    }
    return out;
  }

  function toggleHighlight() {
    highlighting = !highlighting;
    if (highlighting && currentSnapshot) {
      matchEls = findMatches(currentSnapshot.family, currentSnapshot.size, currentSnapshot.weight);
    } else {
      matchEls = [];
    }
    drawMatches();
    toast(highlighting ? `${matchEls.length} matches` : 'Highlight off');
  }

  function drawMatches() {
    if (!refs.matches) return;
    const root = refs.matches;
    if (!highlighting) {
      if (root.firstChild) root.textContent = '';
      return;
    }
    let i = 0;
    for (let n = 0; n < matchEls.length; n++) {
      const el = matchEls[n];
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      let box = root.children[i];
      if (!box) {
        box = document.createElement('div');
        box.className = 'match';
        root.appendChild(box);
      }
      box.style.top = `${Math.round(r.top)}px`;
      box.style.left = `${Math.round(r.left)}px`;
      box.style.width = `${Math.round(r.width)}px`;
      box.style.height = `${Math.round(r.height)}px`;
      i += 1;
    }
    while (root.children.length > i) root.lastChild.remove();
  }

  function pageTokens(data) {
    const lines = [':root {'];
    data.families.forEach((f, i) => {
      lines.push(`  --og-font-${i + 1}: ${cssQuote(f.name)};`);
    });
    data.scale.forEach((s) => {
      lines.push(`  --og-size-${s.px}: ${s.px}px;`);
    });
    lines.push('}');
    return lines.join('\n');
  }

  function toExports(style, rendered, css) {
    const px = Math.round(parseFloat(style.fontSize));
    const nearest = Object.keys(TW_SIZE).reduce((best, n) =>
      Math.abs(Number(n) - px) < Math.abs(Number(best) - px) ? n : best
    );
    const w = TW_WEIGHT[style.fontWeight] || TW_WEIGHT[parseInt(style.fontWeight, 10)] || 'font-normal';
    const hex = toHex(style.color);
    const family = rendered
      ? `${cssQuote(rendered)}, ${splitFamilies(style.fontFamily).filter((f) => f !== rendered).map(cssQuote).join(', ')}`
      : style.fontFamily;
    const tokens = [
      ':root {',
      `  --og-font-family: ${family};`,
      `  --og-font-size: ${style.fontSize};`,
      `  --og-font-weight: ${style.fontWeight};`,
      `  --og-line-height: ${unitlessLineHeight(style.fontSize, style.lineHeight) || style.lineHeight};`,
      `  --og-letter-spacing: ${style.letterSpacing};`,
      `  --og-color: ${hex};`,
      '}',
    ].join('\n');
    const tailwind = [
      TW_SIZE[nearest] || `text-[${style.fontSize}]`,
      w,
      style.fontStyle === 'italic' ? 'italic' : '',
      `tracking-[${style.letterSpacing}]`,
      `leading-[${unitlessLineHeight(style.fontSize, style.lineHeight) || style.lineHeight}]`,
      hex.startsWith('#') ? `text-[${hex}]` : '',
      `font-[${rendered || 'sans'}]`,
    ].filter(Boolean).join(' ');
    return { css, tokens, tailwind, json: '' };
  }

  function copyExport() {
    if (tab === 'page') {
      if (!inventory) inventory = scanPage();
      copyText(pageTokens(inventory));
      return;
    }
    if (!currentSnapshot) return;
    copyText(exportText(currentSnapshot));
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied');
    cue('success');
  }

  function toast(label) {
    if (!refs.toast) return;
    refs.toast.textContent = label;
    refs.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => refs.toast.classList.remove('is-on'), 900);
  }

  function splitFamilies(fontFamily) {
    return fontFamily.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }

  function detectRenderedFont(families, style, text) {
    if (!measureCtx || !families.length) return families[0] || '';
    const sample = (text && text.trim().slice(0, 24)) || 'mmmmmmmmmmlliWw@';
    const cacheKey = `${families.join('|')}|${style.fontWeight}|${style.fontStyle}|${sample}`;
    const cached = detectCache.get(cacheKey);
    if (cached) return cached;
    const size = '72px';
    const widthOf = (font) => {
      measureCtx.font = `${style.fontStyle} ${style.fontWeight} ${size} ${font}`;
      return measureCtx.measureText(sample).width;
    };
    const bases = {
      monospace: widthOf('monospace'),
      serif: widthOf('serif'),
      'sans-serif': widthOf('sans-serif'),
    };
    let result = families[0];
    for (let i = 0; i < families.length; i++) {
      const family = families[i];
      const quoted = `'${family.replace(/'/g, "\\'")}'`;
      if (
        Math.abs(widthOf(`${quoted}, monospace`) - bases.monospace) > 0.5
        || Math.abs(widthOf(`${quoted}, serif`) - bases.serif) > 0.5
        || Math.abs(widthOf(`${quoted}, sans-serif`) - bases['sans-serif']) > 0.5
      ) {
        result = family;
        break;
      }
    }
    if (detectCache.size >= DETECT_CACHE_MAX) detectCache.clear();
    detectCache.set(cacheKey, result);
    return result;
  }

  function getFaceIndex() {
    if (faceIndex) return faceIndex;
    faceIndex = new Map();
    const sheets = document.styleSheets;
    for (let i = 0; i < sheets.length; i++) {
      let rules;
      try { rules = sheets[i].cssRules; } catch { continue; }
      if (!rules) continue;
      for (let r = 0; r < rules.length; r++) {
        const rule = rules[r];
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const ff = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim().toLowerCase();
        if (!ff) continue;
        let list = faceIndex.get(ff);
        if (!list) {
          list = [];
          faceIndex.set(ff, list);
        }
        const src = rule.style.getPropertyValue('src');
        list.push({
          src,
          file: parseFirstUrl(src),
          weight: rule.style.getPropertyValue('font-weight') || 'normal',
          style: rule.style.getPropertyValue('font-style') || 'normal',
          href: sheets[i].href || '',
        });
      }
    }
    return faceIndex;
  }

  function findFontFaces(family) {
    const target = (family || '').toLowerCase();
    if (!target) return [];
    return getFaceIndex().get(target) || [];
  }

  function parseFirstUrl(src) {
    const match = /url\((['"]?)([^'")]+)\1\)/.exec(src || '');
    if (!match) return '';
    try {
      return new URL(match[2], location.href).pathname.split('/').pop() || match[2];
    } catch {
      return match[2];
    }
  }

  function firstFontFile(faces) {
    return faces.find((f) => f.file)?.file || '';
  }

  function pageHasGoogleFonts() {
    if (hasGoogleFonts != null) return hasGoogleFonts;
    hasGoogleFonts = Boolean(document.querySelector('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]'));
    return hasGoogleFonts;
  }

  function classifySource(family, faces) {
    if (pageHasGoogleFonts()) return 'Google Fonts';
    const blob = `${family} ${faces.map((f) => `${f.src} ${f.href}`).join(' ')}`.toLowerCase();
    if (blob.includes('fonts.googleapis.com') || blob.includes('fonts.gstatic.com')) return 'Google Fonts';
    if (faces.length) return 'Web font';
    return 'System / local';
  }

  function nearestBackground(el) {
    let node = el;
    while (node && node instanceof Element) {
      const bg = getComputedStyle(node).backgroundColor;
      if (!isTransparent(bg)) return bg;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255, 255, 255)';
  }

  function isTransparent(color) {
    if (!color || color === 'transparent') return true;
    const parts = parseColor(color);
    return !parts || parts[3] === 0;
  }

  function parseColor(value) {
    if (!value) return null;
    const hex = value.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      let h = hex[1];
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ];
    }
    const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i);
    if (rgb) {
      const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number(rgb[4]) / 100 : Number(rgb[4]);
      return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), a];
    }
    try {
      const ctx = parseColor._ctx || (parseColor._ctx = document.createElement('canvas').getContext('2d'));
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      const out = ctx.fillStyle;
      if (out && out !== value) return parseColor(out);
    } catch {
      // ignore
    }
    return null;
  }

  function toHex(value) {
    const parts = parseColor(value);
    if (!parts) return value;
    const [r, g, b, a] = parts;
    const hex = `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
    return a < 1 ? `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}` : hex;
  }

  function luminance(r, g, b) {
    const a = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  }

  function contrastRatio(c1, c2) {
    const a = parseColor(c1);
    const b = parseColor(c2);
    if (!a || !b) return null;
    const l1 = luminance(a[0], a[1], a[2]);
    const l2 = luminance(b[0], b[1], b[2]);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function contrastMessage(color, background, size, weight) {
    const ratio = contrastRatio(color, background);
    if (!ratio) return { ratio: '–', level: 'fail', levelLabel: 'n/a', message: '–' };
    const rounded = Math.round(ratio * 100) / 100;
    const px = parseFloat(size);
    const numericWeight = Number.parseInt(weight, 10) || (weight === 'bold' ? 700 : 400);
    const large = px >= 24 || (px >= 18.66 && numericWeight >= 700);
    const aaa = large ? 4.5 : 7;
    const aa = large ? 3 : 4.5;
    let level = 'fail';
    let levelLabel = 'Fail';
    if (rounded >= aaa) { level = 'aaa'; levelLabel = 'AAA'; }
    else if (rounded >= aa) { level = 'aa'; levelLabel = 'AA'; }
    return { ratio: String(rounded), level, levelLabel, message: `${rounded} ${levelLabel}` };
  }

  function glyphMetrics(family, weight, sizePx, el) {
    const empty = { xHeight: '–', capHeight: '–', cpl: '–', lineAdvice: '–', sizeAdvice: '–' };
    if (!measureCtx) return empty;
    measureCtx.font = `${weight} ${sizePx}px ${cssQuote(family)}`;
    const x = measureCtx.measureText('x');
    const H = measureCtx.measureText('H');
    const xHeight = x.actualBoundingBoxAscent
      ? `${Math.round(x.actualBoundingBoxAscent * 10) / 10}px`
      : '–';
    const capHeight = H.actualBoundingBoxAscent
      ? `${Math.round(H.actualBoundingBoxAscent * 10) / 10}px`
      : '–';
    const alphabet = measureCtx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26;
    const width = el.getBoundingClientRect().width;
    const cpl = alphabet ? Math.round(width / alphabet) : 0;
    let lineAdvice = `${cpl} ch`;
    if (cpl && (cpl < 45 || cpl > 75)) lineAdvice += cpl < 45 ? ' (short)' : ' (long)';
    else if (cpl) lineAdvice += ' (good)';
    const sizeAdvice = sizePx < 16 ? `${sizePx}px — below 16px body` : `${sizePx}px`;
    return { xHeight, capHeight, cpl: cpl ? String(cpl) : '–', lineAdvice, sizeAdvice };
  }

  function unitlessLineHeight(size, lineHeight) {
    if (!lineHeight || lineHeight === 'normal') return '';
    const a = parseFloat(size);
    const b = parseFloat(lineHeight);
    if (!a || !b) return '';
    return String(Math.round((b / a) * 1000) / 1000);
  }

  function weightLabel(weight) {
    return WEIGHTS[weight] ? `${weight} ${WEIGHTS[weight]}` : String(weight);
  }

  function toCss(style, rendered) {
    const family = rendered
      ? `${cssQuote(rendered)}, ${splitFamilies(style.fontFamily).filter((f) => f !== rendered).map(cssQuote).join(', ')}`
      : style.fontFamily;
    const lines = [
      `font-family: ${family};`,
      `font-size: ${style.fontSize};`,
      `font-weight: ${style.fontWeight};`,
      `font-style: ${style.fontStyle};`,
      `line-height: ${unitlessLineHeight(style.fontSize, style.lineHeight) || style.lineHeight};`,
      `letter-spacing: ${style.letterSpacing};`,
      `color: ${toHex(style.color)};`,
    ];
    if (style.fontVariationSettings && style.fontVariationSettings !== 'normal') {
      lines.push(`font-variation-settings: ${style.fontVariationSettings};`);
    }
    if (style.fontFeatureSettings && style.fontFeatureSettings !== 'normal') {
      lines.push(`font-feature-settings: ${style.fontFeatureSettings};`);
    }
    return lines.join('\n');
  }

  function cssQuote(name) {
    if (!name) return '';
    return /[^a-zA-Z0-9-]/.test(name) ? `'${name.replace(/'/g, "\\'")}'` : name;
  }

  function shortSelector(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 64);
  }

  function hasOwnText(el) {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3 && n.data.trim()) return true;
    }
    return false;
  }

  function sampleText(el) {
    const raw = el.textContent || '';
    if (!raw) return '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  async function restorePrefs() {
    try {
      if (!guardExt()) return;
      const stored = await Promise.resolve(
        chrome.storage.local.get(['ogfontsPanel', 'ogfontsTheme', 'ogfontsSound'])
      ).catch(() => ({})) || {};
      const { ogfontsPanel } = stored;
      if (stored.ogfontsTheme === 'light' || stored.ogfontsTheme === 'dark') {
        theme = stored.ogfontsTheme;
      }
      if (typeof stored.ogfontsSound === 'boolean') soundOn = stored.ogfontsSound;
      applyTheme();
      applySound();
      if (!ogfontsPanel || !refs.panel) return;
      if (ogfontsPanel.left != null && ogfontsPanel.top != null) {
        refs.panel.style.left = `${ogfontsPanel.left}px`;
        refs.panel.style.top = `${ogfontsPanel.top}px`;
        refs.panel.style.right = 'auto';
        refs.panel.style.bottom = 'auto';
      }
      if (ogfontsPanel.width) refs.panel.style.width = `${ogfontsPanel.width}px`;
      if (ogfontsPanel.height) refs.panel.style.height = `${ogfontsPanel.height}px`;
    } catch {
      applyTheme();
      applySound();
    }
  }

  function applyTheme() {
    refs.root?.setAttribute('data-theme', theme);
    if (refs.theme) {
      refs.theme.textContent = theme === 'light' ? 'Light' : 'Dark';
      refs.theme.classList.toggle('is-on', theme === 'light');
    }
  }

  function applySound() {
    if (globalThis.Cuelume) {
      globalThis.Cuelume.setEnabled(soundOn);
      globalThis.Cuelume.setVolume(0.55);
    }
    if (refs.sound) {
      refs.sound.textContent = soundOn ? 'Sound' : 'Mute';
      refs.sound.classList.toggle('is-on', soundOn);
    }
  }

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    storeSet({ ogfontsTheme: theme });
    cue('toggle');
  }

  function toggleSound() {
    if (soundOn) {
      cue('tick');
      soundOn = false;
      applySound();
    } else {
      soundOn = true;
      applySound();
      cue('tick');
    }
    storeSet({ ogfontsSound: soundOn });
  }

  function cue(name, volume) {
    if (!soundOn || !globalThis.Cuelume?.play) return;
    try {
      globalThis.Cuelume.play(name, { volume: volume ?? 0.7 });
    } catch {
      // ignore
    }
  }

  function cueHover() {
    const now = Date.now();
    if (now - hoverCueAt < 160) return;
    hoverCueAt = now;
    cue('tick', 0.28);
  }

  async function restorePosition() {
    return restorePrefs();
  }

  function savePanelBox() {
    const rect = refs.panel.getBoundingClientRect();
    storeSet({
      ogfontsPanel: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  function onDragStart(event) {
    if (event.target.closest('button') || event.target.closest('[data-resize]')) return;
    const rect = refs.panel.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    refs.panel.style.left = `${rect.left}px`;
    refs.panel.style.top = `${rect.top}px`;
    refs.panel.style.right = 'auto';
    refs.panel.style.bottom = 'auto';
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
  }

  function onDragMove(event) {
    if (!drag) return;
    const x = Math.min(window.innerWidth - 80, Math.max(8, event.clientX - drag.dx));
    const y = Math.min(window.innerHeight - 40, Math.max(8, event.clientY - drag.dy));
    refs.panel.style.left = `${x}px`;
    refs.panel.style.top = `${y}px`;
  }

  function onDragEnd() {
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    savePanelBox();
  }

  function onResizeStart(event) {
    const edge = event.target.getAttribute?.('data-resize');
    if (!edge) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = refs.panel.getBoundingClientRect();
    refs.panel.style.left = `${rect.left}px`;
    refs.panel.style.top = `${rect.top}px`;
    refs.panel.style.right = 'auto';
    refs.panel.style.bottom = 'auto';
    refs.panel.style.width = `${rect.width}px`;
    refs.panel.style.height = `${rect.height}px`;
    resize = {
      edge,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd, { once: true });
  }

  function onResizeMove(event) {
    if (!resize) return;
    const dx = event.clientX - resize.x;
    const dy = event.clientY - resize.y;
    const minW = 320;
    const minH = 280;
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;
    let { left, top, width, height, edge } = resize;
    if (edge.includes('e')) width = Math.min(maxW, Math.max(minW, resize.width + dx));
    if (edge.includes('s')) height = Math.min(maxH, Math.max(minH, resize.height + dy));
    if (edge.includes('w')) {
      width = Math.min(maxW, Math.max(minW, resize.width - dx));
      left = resize.left + (resize.width - width);
    }
    if (edge.includes('n')) {
      height = Math.min(maxH, Math.max(minH, resize.height - dy));
      top = resize.top + (resize.height - height);
    }
    refs.panel.style.left = `${left}px`;
    refs.panel.style.top = `${top}px`;
    refs.panel.style.width = `${width}px`;
    refs.panel.style.height = `${height}px`;
  }

  function onResizeEnd() {
    resize = null;
    window.removeEventListener('pointermove', onResizeMove);
    savePanelBox();
  }
})();
