/* Mini RPA Recorder - content script.
 * Injected on demand by background.js (never declared in the manifest) so that
 * tabs the user already had open start working without a reload.
 *
 * Responsibilities:
 *   1. Record clicks / typing / keys / scrolling in the capture phase.
 *   2. Replay a single recorded step on request.
 *   3. Run a "repeat" step: re-query the live page every round, click the first
 *      match, wait, repeat - with a stall guard and lazy-load rescue.
 */

/* Guard against double-injection: if this page already ran the script, the
 * listeners below are already attached and must not be attached twice. */
if (window.__miniRpaLoaded) {
  /* already set up - nothing to do */
} else {
  window.__miniRpaLoaded = true;
  (function () {
    'use strict';

    var BADGE_ID = '__mini_rpa_rec_badge__';
    var HIGHLIGHT_MS = 400;
    var ELEMENT_TIMEOUT_MS = 10000;
    var POLL_MS = 200;
    var SCROLL_THROTTLE_MS = 600;
    var RESCUE_LIMIT = 3;
    var RESCUE_WAIT_MS = 2000;
    var KEEPALIVE_MS = 15000;

    var recording = false;
    var aborted = false;
    var lastScrollAt = 0;
    var lastKeepaliveAt = 0;

    /* ---------------------------------------------------------------- utils */

    function sleep(ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }

    /* Sleep in slices so Stop Playback halts a repeat loop within one cycle
     * instead of only between steps. Also pokes the service worker so it does
     * not go to sleep during a long delay. */
    function sleepInterruptible(ms) {
      var end = Date.now() + ms;
      return (function step() {
        if (aborted) return Promise.resolve();
        var left = end - Date.now();
        if (left <= 0) return Promise.resolve();
        if (Date.now() - lastKeepaliveAt > KEEPALIVE_MS) {
          lastKeepaliveAt = Date.now();
          send({ cmd: 'keepalive' });
        }
        return sleep(Math.min(250, left)).then(step);
      })();
    }

    function send(payload) {
      try {
        var p = chrome.runtime.sendMessage(payload);
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) { /* extension reloaded or context gone - ignore */ }
    }

    function cssEscape(value) {
      var s = String(value == null ? '' : value);
      if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
      return s.replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
    }

    function quote(value) {
      return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function attr(el, name) {
      if (!el || !el.getAttribute) return '';
      var v = el.getAttribute(name);
      return v && v.trim() ? v.trim() : '';
    }

    function squash(text) {
      return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    }

    function visibleText(el) {
      if (!el) return '';
      var t = squash(el.innerText || el.textContent || '');
      return t.length > 120 ? t.slice(0, 120) : t;
    }

    /* Many sites regenerate ids and class names on every deploy. Anything that
     * looks machine-generated is not trusted as a stable hook. */
    function looksGenerated(value) {
      var s = String(value == null ? '' : value);
      if (!s) return true;
      if (s.length > 40) return true;
      if (/^\d+$/.test(s)) return true;
      if (/\d{4,}/.test(s)) return true;
      if (/:r[0-9a-z]+:/i.test(s)) return true;
      if (/[0-9a-f]{8,}/i.test(s) && /\d/.test(s)) return true;
      return false;
    }

    function isOurBadge(el) {
      if (!el || !el.closest) return false;
      return el.id === BADGE_ID || !!el.closest('#' + BADGE_ID);
    }

    /* An open modal marks the page behind it aria-hidden or inert. Those
     * elements are still in the DOM and still match a selector, but clicking
     * one does nothing - which is exactly how a repeat loop ends up spinning
     * against a page that has a dialog sitting on top of it. */
    function isBehindModal(el) {
      try { return !!el.closest('[aria-hidden="true"], [inert]'); } catch (e) { return false; }
    }

    function isUsable(el) {
      if (!el || el.nodeType !== 1) return false;
      if (isOurBadge(el)) return false;
      if (el.disabled) return false;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
      if (isBehindModal(el)) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var style = window.getComputedStyle(el);
      if (!style) return true;
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      return true;
    }

    /* ------------------------------------------------- selector for one step */

    function uniqueSelector(sel) {
      try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
    }

    function cssPath(el) {
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && parts.length < 10) {
        var id = attr(node, 'id');
        if (id && !looksGenerated(id) && uniqueSelector('#' + cssEscape(id))) {
          parts.unshift('#' + cssEscape(id));
          break;
        }
        var part = node.tagName.toLowerCase();
        var parent = node.parentElement;
        if (parent) {
          var sameTag = Array.prototype.filter.call(parent.children, function (c) {
            return c.tagName === node.tagName;
          });
          if (sameTag.length > 1) {
            part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
          }
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    /* Preference order: id, data-testid, name, aria-label, then a CSS path. */
    function buildSelector(el) {
      if (!el || el.nodeType !== 1) return '';
      var tag = el.tagName.toLowerCase();

      var id = attr(el, 'id');
      if (id && !looksGenerated(id) && uniqueSelector('#' + cssEscape(id))) {
        return '#' + cssEscape(id);
      }
      var testId = attr(el, 'data-testid');
      if (testId && !looksGenerated(testId)) {
        var s1 = tag + '[data-testid="' + quote(testId) + '"]';
        if (uniqueSelector(s1)) return s1;
      }
      var name = attr(el, 'name');
      if (name && !looksGenerated(name)) {
        var s2 = tag + '[name="' + quote(name) + '"]';
        if (uniqueSelector(s2)) return s2;
      }
      var aria = attr(el, 'aria-label');
      if (aria) {
        var s3 = tag + '[aria-label="' + quote(aria) + '"]';
        if (uniqueSelector(s3)) return s3;
      }
      return cssPath(el);
    }

    /* The user usually clicks a span inside a button. Walk up a few levels to
     * find the thing that actually behaves like a control. */
    function interactiveTarget(node) {
      var el = node && node.nodeType === 3 ? node.parentElement : node;
      if (!el || el.nodeType !== 1) return null;
      var hops = 0;
      var walker = el;
      while (walker && hops < 4) {
        var tag = walker.tagName.toLowerCase();
        if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' ||
            tag === 'textarea' || tag === 'label' || tag === 'summary' ||
            walker.getAttribute('role') === 'button' ||
            walker.getAttribute('role') === 'link' ||
            walker.hasAttribute('onclick')) {
          return walker;
        }
        walker = walker.parentElement;
        hops++;
      }
      return el;
    }

    /* ------------------------------------------------------------- recording */

    function makeStep(type, el, extra) {
      var step = {
        type: type,
        selector: el ? buildSelector(el) : '',
        tagName: el ? el.tagName.toLowerCase() : '',
        ariaLabel: el ? attr(el, 'aria-label') : '',
        fallbackText: el ? visibleText(el) : '',
        value: '',
        attrs: {
          id: el ? attr(el, 'id') : '',
          testId: el ? attr(el, 'data-testid') : '',
          name: el ? attr(el, 'name') : '',
          type: el ? attr(el, 'type') : ''
        },
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
        repeat: null
      };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) step[k] = extra[k];
        }
      }
      return step;
    }

    function record(type, el, extra, coalesceKey) {
      send({ cmd: 'recordStep', step: makeStep(type, el, extra), coalesceKey: coalesceKey || null });
    }

    function isFormField(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
    }

    function fieldValue(el) {
      var tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        var type = (el.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return el.checked ? 'true' : 'false';
        if (type === 'password') return '';
        return el.value == null ? '' : String(el.value);
      }
      if (tag === 'select' || tag === 'textarea') return el.value == null ? '' : String(el.value);
      if (el.isContentEditable) return squash(el.innerText || '');
      return '';
    }

    function onClickCapture(e) {
      if (!recording || !e.isTrusted) return;
      var el = interactiveTarget(e.target);
      if (!el || isOurBadge(el)) return;
      record('click', el, {});
    }

    function onInputCapture(e) {
      if (!recording || !e.isTrusted) return;
      var el = e.target;
      if (!isFormField(el) || isOurBadge(el)) return;
      var type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return; /* handled by change */
      if (type === 'password') {
        record('input', el, { value: '', note: 'password field - value not recorded' }, 'input:' + buildSelector(el));
        return;
      }
      /* Coalesce a burst of keystrokes into one step per field. */
      record('input', el, { value: fieldValue(el) }, 'input:' + buildSelector(el));
    }

    function onChangeCapture(e) {
      if (!recording || !e.isTrusted) return;
      var el = e.target;
      if (!isFormField(el) || isOurBadge(el)) return;
      var tag = el.tagName.toLowerCase();
      var type = (el.type || '').toLowerCase();
      if (tag === 'select' || type === 'checkbox' || type === 'radio') {
        record('change', el, { value: fieldValue(el) });
      }
      /* Text fields already produced an input step; a change on blur would be
       * a duplicate, so it is ignored. */
    }

    function onKeydownCapture(e) {
      if (!recording || !e.isTrusted) return;
      if (e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'Escape') return;
      var el = e.target && e.target.nodeType === 1 ? e.target : document.body;
      if (isOurBadge(el)) return;
      record('key', el, { value: e.key });
    }

    function onScrollCapture() {
      if (!recording) return;
      var now = Date.now();
      if (now - lastScrollAt < SCROLL_THROTTLE_MS) return;
      lastScrollAt = now;
      record('scroll', null, { value: String(Math.round(window.scrollY || 0)) }, 'scroll:' + location.href);
    }

    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('input', onInputCapture, true);
    document.addEventListener('change', onChangeCapture, true);
    document.addEventListener('keydown', onKeydownCapture, true);
    document.addEventListener('scroll', onScrollCapture, { capture: true, passive: true });

    /* ----------------------------------------------------------- REC badge */

    function showBadge() {
      if (document.getElementById(BADGE_ID)) return;
      var host = document.body || document.documentElement;
      if (!host) return;
      var badge = document.createElement('div');
      badge.id = BADGE_ID;
      badge.textContent = '● REC';
      badge.setAttribute('aria-hidden', 'true');
      badge.style.cssText = [
        'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
        'background:#c0392b', 'color:#ffffff',
        'font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
        'padding:6px 10px', 'border-radius:14px', 'letter-spacing:.5px',
        'box-shadow:0 2px 8px rgba(0,0,0,.35)', 'pointer-events:none',
        'user-select:none', 'margin:0'
      ].join(';');
      host.appendChild(badge);
    }

    function hideBadge() {
      var badge = document.getElementById(BADGE_ID);
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    }

    function setRecording(on) {
      recording = !!on;
      if (recording) showBadge(); else hideBadge();
    }

    try {
      chrome.storage.local.get('mode').then(function (data) {
        setRecording(data && data.mode === 'recording');
      }).catch(function () {});
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.mode) setRecording(changes.mode.newValue === 'recording');
      });
    } catch (e) { /* storage unavailable - stay idle */ }

    /* --------------------------------------------------- element resolution */

    function findByText(step) {
      var tag = (step.tagName || '*').toLowerCase();
      var want = squash(step.fallbackText || step.ariaLabel || '').toLowerCase();
      if (!want) return null;
      var nodes;
      try { nodes = document.querySelectorAll(tag); } catch (e) { return null; }
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!isUsable(n)) continue;
        if (visibleText(n).toLowerCase() === want) return n;
        if (attr(n, 'aria-label').toLowerCase() === want) return n;
      }
      return null;
    }

    /* The topmost visible dialog, if the page has one open. */
    function openDialog() {
      var nodes;
      try {
        nodes = document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]');
      } catch (e) { return null; }
      for (var i = nodes.length - 1; i >= 0; i--) {
        var n = nodes[i];
        var rect = n.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return n;
      }
      return null;
    }

    function findWithin(root, step) {
      if (step.selector) {
        var hit = null;
        try { hit = root.querySelector(step.selector); } catch (e) { hit = null; }
        if (hit && isUsable(hit)) return hit;
      }
      var want = squash(step.fallbackText || step.ariaLabel || '').toLowerCase();
      if (!want) return null;
      var tag = (step.tagName || '*').toLowerCase();
      var nodes;
      try { nodes = root.querySelectorAll(tag); } catch (e) { return null; }
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!isUsable(n)) continue;
        if (visibleText(n).toLowerCase() === want) return n;
        if (attr(n, 'aria-label').toLowerCase() === want) return n;
      }
      return null;
    }

    function findOnce(step) {
      /* A dialog on top of the page owns the interaction while it is open, and
       * pages very often have a second "Next" or "Accept" underneath it. */
      var dialog = openDialog();
      if (dialog) {
        var inDialog = findWithin(dialog, step);
        if (inDialog) return inDialog;
      }
      if (step.selector) {
        var matches = null;
        try { matches = document.querySelectorAll(step.selector); } catch (e) { matches = null; }
        if (matches && matches.length) {
          for (var i = 0; i < matches.length; i++) {
            if (isUsable(matches[i])) return matches[i];
          }
          /* The element is on the page but not usable yet - hidden, or sitting
           * behind a dialog. Waiting for it is right; falling through to match
           * whatever else happens to share its wording is how a replay ends up
           * clicking a completely different button. */
          return null;
        }
      }
      return findByText(step);
    }

    function waitForElement(step, timeoutMs) {
      var end = Date.now() + timeoutMs;
      return (function attempt() {
        if (aborted) return Promise.resolve(null);
        var el = findOnce(step);
        if (el) return Promise.resolve(el);
        if (Date.now() >= end) return Promise.resolve(null);
        return sleep(POLL_MS).then(attempt);
      })();
    }

    function highlight(el) {
      var prevOutline = el.style.outline;
      var prevOffset = el.style.outlineOffset;
      el.style.outline = '3px solid #e67e22';
      el.style.outlineOffset = '2px';
      setTimeout(function () {
        try {
          el.style.outline = prevOutline;
          el.style.outlineOffset = prevOffset;
        } catch (e) { /* element may be gone */ }
      }, HIGHLIGHT_MS);
    }

    function bringIntoView(el) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
    }

    /* --------------------------------------------------------- interactions */

    function clickElement(el) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
      var base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
      function mouse(type, buttons) {
        var init = Object.assign({}, base, { buttons: buttons });
        try {
          if (window.PointerEvent && (type === 'pointerdown' || type === 'pointerup')) {
            return new PointerEvent(type, Object.assign({}, init, { pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
          }
        } catch (e) { /* fall through to MouseEvent */ }
        if (type === 'pointerdown' || type === 'pointerup') return null;
        return new MouseEvent(type, init);
      }
      var down = mouse('pointerdown', 1);
      if (down) el.dispatchEvent(down);
      el.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, base, { buttons: 1 })));
      var up = mouse('pointerup', 0);
      if (up) el.dispatchEvent(up);
      el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
      el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { buttons: 0 })));
    }

    /* Use the native value setter so React (and anything else that wraps the
     * value property) actually sees the change. */
    function setNativeValue(el, value) {
      var proto = window.HTMLInputElement.prototype;
      if (window.HTMLTextAreaElement && el instanceof window.HTMLTextAreaElement) proto = window.HTMLTextAreaElement.prototype;
      else if (window.HTMLSelectElement && el instanceof window.HTMLSelectElement) proto = window.HTMLSelectElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    }

    function fireInputAndChange(el) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function typeInto(el, value) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      if (el.isContentEditable) {
        el.textContent = value == null ? '' : String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      var type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        el.checked = String(value) === 'true';
        fireInputAndChange(el);
        return;
      }
      setNativeValue(el, value == null ? '' : String(value));
      fireInputAndChange(el);
    }

    function pressKey(el, key) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      var codes = { Enter: 13, Tab: 9, Escape: 27 };
      var legacy = codes[key] || 0;
      ['keydown', 'keyup'].forEach(function (type) {
        /* keyCode and which have to go through the constructor. Setting them as
         * expandos afterwards looks right from here but never reaches the page:
         * this script runs in an isolated world, and the page sees its own
         * wrapper of the event without any properties added on this side. Plenty
         * of sites still gate on keyCode === 13, so a 0 here means the Enter
         * simply does nothing. */
        el.dispatchEvent(new KeyboardEvent(type, {
          key: key, code: key, keyCode: legacy, which: legacy, charCode: 0,
          bubbles: true, cancelable: true, composed: true
        }));
      });
    }

    /* --------------------------------------------------- single-step replay */

    function describeTarget(step) {
      var bits = [];
      if (step.selector) bits.push('selector ' + step.selector);
      if (step.ariaLabel) bits.push('label "' + step.ariaLabel + '"');
      else if (step.fallbackText) bits.push('text "' + step.fallbackText + '"');
      if (!bits.length) bits.push('the ' + (step.tagName || 'element'));
      return bits.join(', ');
    }

    function playStep(step, timeoutMs) {
      var wait = timeoutMs > 0 ? timeoutMs : ELEMENT_TIMEOUT_MS;
      if (step.type === 'scroll') {
        var y = Number(step.value);
        window.scrollTo(0, isFinite(y) ? y : 0);
        return Promise.resolve({ ok: true });
      }
      return waitForElement(step, wait).then(function (el) {
        if (aborted) return { ok: true, stopped: true };
        if (!el) {
          return {
            ok: false,
            error: 'could not find ' + describeTarget(step) +
                   ' after waiting ' + Math.round(wait / 1000) + ' seconds'
          };
        }
        bringIntoView(el);
        highlight(el);
        var isPassword = (step.attrs && step.attrs.type === 'password') ||
                         String(el.type || '').toLowerCase() === 'password';
        if (step.type === 'input' && isPassword && !step.value) {
          /* The value was deliberately never recorded. Writing an empty string
           * here would wipe a password the browser had filled in, so the field
           * is only focused and the run reports that it needs the user. */
          try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
          return { ok: true, needsUser: 'password' };
        }
        try {
          if (step.type === 'click') clickElement(el);
          else if (step.type === 'input' || step.type === 'change') typeInto(el, step.value);
          else if (step.type === 'key') pressKey(el, step.value || 'Enter');
          else clickElement(el);
        } catch (e) {
          return { ok: false, error: 'the page rejected the action (' + (e && e.message ? e.message : e) + ')' };
        }
        return { ok: true };
      });
    }

    /* ------------------------------------------------------- repeat matching */

    function positionalError() {
      return new Error('Repeat patterns cannot use nth-of-type or nth-child, because the list shifts ' +
                       'after every click. Use an attribute or a :text("...") pattern instead.');
    }

    /* Pattern language: a plain CSS selector, optionally ending with
     * :text("exact visible text") which filters matches by trimmed text. */
    function parsePattern(pattern) {
      var raw = String(pattern == null ? '' : pattern).trim();
      var m = /:text\(\s*(["'])([\s\S]*?)\1\s*\)\s*$/.exec(raw);
      if (m) {
        return { css: raw.slice(0, m.index).trim() || '*', text: m[2] };
      }
      return { css: raw, text: null };
    }

    function queryPattern(pattern) {
      var parsed = parsePattern(pattern);
      if (!parsed.css) throw new Error('The match pattern is empty.');
      if (/:nth-(of-type|child|last-child|last-of-type)\b/i.test(parsed.css)) throw positionalError();
      var nodes;
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(parsed.css));
      } catch (e) {
        throw new Error('"' + parsed.css + '" is not a valid CSS selector.');
      }
      if (parsed.text !== null) {
        var want = squash(parsed.text).toLowerCase();
        nodes = nodes.filter(function (n) { return visibleText(n).toLowerCase() === want; });
      }
      return nodes.filter(isUsable);
    }

    /* ------------------------------------------------------ repeat execution */

    /* Identifies "this is the same element as last round" without holding a
     * reference across rounds, since the list re-renders after every action.
     *
     * Deliberately identity attributes only, never the visible text: acting on
     * a row is exactly what changes its text ("Connect" becomes "Pending"), so
     * a text-based fingerprint would stop matching the very element it was
     * meant to remember, and the row would be picked again next round. */
    function signatureOf(el) {
      var identity = attr(el, 'aria-label') || attr(el, 'id') ||
                     attr(el, 'data-testid') || attr(el, 'name');
      return identity || '';
    }

    function allSignaturesDistinct(nodes) {
      var seen = {};
      for (var i = 0; i < nodes.length; i++) {
        var sig = signatureOf(nodes[i]);
        /* No identity means the rounds cannot be told apart this way. */
        if (!sig) return false;
        if (seen[sig]) return false;
        seen[sig] = true;
      }
      return true;
    }

    function repeatProbe(pattern) {
      var nodes = queryPattern(pattern);
      return { ok: true, count: nodes.length, distinct: allSignaturesDistinct(nodes) };
    }

    /* Clicks one element and reports which one, so the caller can drive a
     * multi-step pass around it and know when to stop. */
    /* Everything about an element that a working click would be expected to
     * change. Compared round over round to tell "the click did nothing" apart
     * from "the row was handled and now looks different". */
    function stateOf(el) {
      return [
        visibleText(el),
        el.disabled ? '1' : '0',
        attr(el, 'aria-disabled'),
        attr(el, 'aria-pressed'),
        attr(el, 'aria-checked')
      ].join('\u0001');
    }

    function findBySignature(nodes, signature) {
      for (var i = 0; i < nodes.length; i++) {
        if (signatureOf(nodes[i]) === signature) return nodes[i];
      }
      return null;
    }

    function repeatClickNext(pattern, handled, useSignatures, previous) {
      var nodes = queryPattern(pattern);
      var countBefore = nodes.length;

      /* Did last round's click actually do anything? */
      var previousUnchanged = false;
      if (previous && previous.signature) {
        var was = findBySignature(nodes, previous.signature);
        previousUnchanged = !!(was && stateOf(was) === previous.state);
      }

      var target = null;
      if (useSignatures) {
        var done = {};
        for (var h = 0; h < (handled || []).length; h++) done[handled[h]] = true;
        for (var i = 0; i < nodes.length; i++) {
          if (!done[signatureOf(nodes[i])]) { target = nodes[i]; break; }
        }
      } else if (nodes.length) {
        target = nodes[0];
      }
      if (!target) {
        return { ok: true, clicked: false, countBefore: countBefore, previousUnchanged: previousUnchanged };
      }
      var signature = signatureOf(target);
      var state = stateOf(target);
      bringIntoView(target);
      highlight(target);
      clickElement(target);
      return {
        ok: true, clicked: true, signature: signature, state: state,
        countBefore: countBefore, previousUnchanged: previousUnchanged
      };
    }

    /* Lazy lists only reveal the next batch once you reach the bottom. */
    function repeatRescue(pattern) {
      try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* ignore */ }
      return sleepInterruptible(RESCUE_WAIT_MS).then(function () {
        var nodes;
        try { nodes = queryPattern(pattern); } catch (e) { return { ok: false, error: e.message }; }
        return { ok: true, count: nodes.length };
      });
    }

    /* ------------------------------------------------------------- messaging */

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.cmd) return;

      if (msg.cmd === 'ping') {
        sendResponse({ ok: true });
        return;
      }
      if (msg.cmd === 'abort') {
        aborted = true;
        sendResponse({ ok: true });
        return;
      }
      if (msg.cmd === 'countMatches') {
        try {
          sendResponse({ ok: true, count: queryPattern(msg.pattern).length });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }
      if (msg.cmd === 'playStep') {
        aborted = false;
        playStep(msg.step, msg.timeoutMs).then(sendResponse).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        });
        return true;
      }
      if (msg.cmd === 'repeatProbe') {
        try { sendResponse(repeatProbe(msg.pattern)); }
        catch (e) { sendResponse({ ok: false, error: e.message }); }
        return;
      }
      if (msg.cmd === 'repeatClickNext') {
        aborted = false;
        try { sendResponse(repeatClickNext(msg.pattern, msg.handled, msg.useSignatures, msg.previous)); }
        catch (e) { sendResponse({ ok: false, error: e.message }); }
        return;
      }
      if (msg.cmd === 'repeatRescue') {
        aborted = false;
        repeatRescue(msg.pattern).then(sendResponse).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        });
        return true;
      }
    });
  })();
}
