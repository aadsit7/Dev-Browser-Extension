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

    /* ------------------------------------------------ shadow-aware querying */

    /* A shadow root is a self-contained mini-document a page can hang off any
     * element, and plenty of sites build their pop-outs inside one. Nothing
     * inside it answers document.querySelectorAll, and a click that happens in
     * there is reported against the element holding it rather than the button
     * that was pressed - so both halves of this tool have to know they exist,
     * or the pop-out records as its container and replays as a click on
     * nothing.
     *
     * Recorded selectors cross a boundary with " >>> ": the route to the
     * element hosting the root, then the path inside it. */

    var PIERCE = ' >>> ';

    function rootOf(el) {
      var root = el && el.getRootNode ? el.getRootNode() : null;
      return root || document;
    }

    /* A root and every open shadow root nested below it. Capped so a page that
     * builds thousands of them cannot stall a lookup. */
    function collectRoots(root, out) {
      if (out.length >= 400) return out;
      out.push(root);
      var nodes;
      try { nodes = root.querySelectorAll('*'); } catch (e) { return out; }
      for (var i = 0; i < nodes.length; i++) {
        if (out.length >= 400) break;
        if (nodes[i].shadowRoot) collectRoots(nodes[i].shadowRoot, out);
      }
      return out;
    }

    /* Split a selector at its boundary markers, ignoring any that happen to sit
     * inside a quoted attribute value - a button labelled "Skip >>>" would
     * otherwise be torn in half and silently match nothing. */
    function pierceHops(selector) {
      var sel = String(selector == null ? '' : selector);
      var hops = [];
      var buf = '';
      var quoted = '';
      for (var i = 0; i < sel.length; i++) {
        var c = sel.charAt(i);
        if (quoted) {
          if (c === '\\') { buf += c + sel.charAt(i + 1); i++; continue; }
          if (c === quoted) quoted = '';
          buf += c;
          continue;
        }
        if (c === '"' || c === "'") { quoted = c; buf += c; continue; }
        if (c === '>' && sel.substr(i, 3) === '>>>') { hops.push(buf.trim()); buf = ''; i += 2; continue; }
        buf += c;
      }
      hops.push(buf.trim());
      return hops;
    }

    /* Everything matching a selector, shadow roots included. Throws on an
     * invalid selector so the caller can say so in plain English. */
    function deepQueryAll(selector, within) {
      var sel = String(selector == null ? '' : selector).trim();
      if (!sel) return [];
      var roots = [within || document];
      var hops = pierceHops(sel);
      var i, r, k;
      /* Walk the recorded route: each hop names a host, and we drop into the
       * root it carries. */
      for (i = 0; i < hops.length - 1; i++) {
        var part = hops[i];
        if (!part) return [];
        var next = [];
        for (r = 0; r < roots.length; r++) {
          var hosts = roots[r].querySelectorAll(part);
          for (k = 0; k < hosts.length; k++) {
            if (hosts[k].shadowRoot) next.push(hosts[k].shadowRoot);
          }
        }
        roots = next;
        if (!roots.length) return [];
      }
      var last = hops[hops.length - 1] || '*';
      var scan = [];
      for (r = 0; r < roots.length; r++) collectRoots(roots[r], scan);
      /* Pages with no shadow roots at all are the common case and should cost
       * exactly one ordinary query. */
      if (scan.length === 1) return Array.prototype.slice.call(scan[0].querySelectorAll(last));
      var out = [];
      for (r = 0; r < scan.length; r++) {
        var hit = scan[r].querySelectorAll(last);
        for (k = 0; k < hit.length; k++) {
          if (out.indexOf(hit[k]) === -1) out.push(hit[k]);
        }
      }
      return out;
    }

    /* The part of a recorded selector that describes the element itself, with
     * the route to its root dropped - used when the search is already scoped
     * to a container such as an open dialog. */
    function lastHop(selector) {
      var hops = pierceHops(selector);
      return hops[hops.length - 1];
    }

    /* contains() and closest() both stop dead at a shadow boundary, so these
     * step out through the hosting elements to finish the job. */
    function containsDeep(container, el) {
      if (!container || !el) return false;
      var node = el;
      while (node) {
        if (node === container) return true;
        if (node.nodeType === 1 && container.contains && container.contains(node)) return true;
        var root = node.getRootNode ? node.getRootNode() : null;
        node = root && root.host ? root.host : null;
      }
      return false;
    }

    function closestDeep(el, selector) {
      var node = el;
      while (node) {
        var hit = null;
        try { hit = node.closest ? node.closest(selector) : null; } catch (e) { hit = null; }
        if (hit) return hit;
        var root = node.getRootNode ? node.getRootNode() : null;
        node = root && root.host ? root.host : null;
      }
      return null;
    }

    /* The element the pointer was actually over. Inside a shadow root an
     * event's own target is reported as the element hosting that root, so
     * taking e.target at face value records the container. */
    function eventTarget(e) {
      var path = null;
      try { path = e.composedPath ? e.composedPath() : null; } catch (err) { path = null; }
      if (path) {
        for (var i = 0; i < path.length; i++) {
          if (path[i] && path[i].nodeType === 1) return path[i];
        }
      }
      return e.target;
    }

    function isOurBadge(el) {
      if (!el || !el.closest) return false;
      return el.id === BADGE_ID || !!el.closest('#' + BADGE_ID);
    }

    /* The topmost dialog on the page, if one is open. Declared before
     * isBehindModal because that has to know what the dialog contains. */
    function openDialog() {
      var nodes;
      try {
        nodes = deepQueryAll('[role="dialog"], [aria-modal="true"], dialog[open]');
      } catch (e) { return null; }
      for (var i = nodes.length - 1; i >= 0; i--) {
        var n = nodes[i];
        var rect = n.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return n;
      }
      return null;
    }

    /* A dialog that takes over the page: everything outside it is unreachable
     * until it closes. A plain role="dialog" with no modal flag is treated as
     * an ordinary panel, because plenty of them do not block anything. */
    function modalDialog() {
      var dlg = openDialog();
      if (!dlg) return null;
      if (dlg.hasAttribute('aria-modal') && dlg.getAttribute('aria-modal') !== 'false') return dlg;
      if (dlg.tagName === 'DIALOG' && dlg.hasAttribute('open')) return dlg;
      return null;
    }

    /* An open modal leaves the page behind it in the DOM and still matching
     * selectors, though clicking any of it does nothing - which is how a loop
     * ends up spinning against a covered page.
     *
     * The catch is where the dialog itself is rendered. Plenty of sites put it
     * inside the very container they then mark aria-hidden, so "is it inside
     * something hidden" on its own throws away the dialog's own buttons and the
     * confirm step can never be found. Whatever the topmost dialog contains is
     * reachable, wherever it happens to sit in the tree. */
    function isBehindModal(el) {
      try {
        var dlg = openDialog();
        if (dlg && containsDeep(dlg, el)) return false;
        if (closestDeep(el, '[aria-hidden="true"], [inert]')) return true;
        /* No aria-hidden, but a modal is up: everything outside it is covered. */
        return !!modalDialog();
      } catch (e) { return false; }
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

    function uniqueSelector(sel, root) {
      try { return (root || document).querySelectorAll(sel).length === 1; } catch (e) { return false; }
    }

    function cssPath(el) {
      var parts = [];
      var node = el;
      var root = rootOf(el);
      while (node && node.nodeType === 1 && parts.length < 10) {
        var id = attr(node, 'id');
        if (id && !looksGenerated(id) && uniqueSelector('#' + cssEscape(id), root)) {
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
      var path = parts.join(' > ');
      /* The walk stops at the top of the shadow root the element lives in;
       * the route to the element hosting that root goes in front of it. */
      var host = root && root.host;
      return host ? buildSelector(host) + PIERCE + path : path;
    }

    /* Preference order: id, data-testid, name, aria-label, then a CSS path. */
    function buildSelector(el) {
      if (!el || el.nodeType !== 1) return '';
      var tag = el.tagName.toLowerCase();
      /* Uniqueness is judged inside the root the element actually lives in: an
       * id only has to be one of a kind within its own shadow root, and the
       * route to that root is what carries the lookup back to it. */
      var root = rootOf(el);
      var host = root && root.host;
      var lead = host ? buildSelector(host) + PIERCE : '';

      var id = attr(el, 'id');
      if (id && !looksGenerated(id) && uniqueSelector('#' + cssEscape(id), root)) {
        return lead + '#' + cssEscape(id);
      }
      var testId = attr(el, 'data-testid');
      if (testId && !looksGenerated(testId)) {
        var s1 = tag + '[data-testid="' + quote(testId) + '"]';
        if (uniqueSelector(s1, root)) return lead + s1;
      }
      var name = attr(el, 'name');
      if (name && !looksGenerated(name)) {
        var s2 = tag + '[name="' + quote(name) + '"]';
        if (uniqueSelector(s2, root)) return lead + s2;
      }
      var aria = attr(el, 'aria-label');
      if (aria) {
        var s3 = tag + '[aria-label="' + quote(aria) + '"]';
        if (uniqueSelector(s3, root)) return lead + s3;
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
        var up = walker.parentElement;
        if (!up) {
          /* Top of a shadow root - the control may be the element hosting it. */
          var owner = walker.getRootNode ? walker.getRootNode() : null;
          up = owner && owner.host ? owner.host : null;
        }
        walker = up;
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
      var el = interactiveTarget(eventTarget(e));
      if (!el || isOurBadge(el)) return;
      record('click', el, {});
    }

    function onInputCapture(e) {
      if (!recording || !e.isTrusted) return;
      var el = eventTarget(e);
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
      var el = eventTarget(e);
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
      var focused = eventTarget(e);
      var el = focused && focused.nodeType === 1 ? focused : document.body;
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

    function showBadge(label) {
      var existing = document.getElementById(BADGE_ID);
      if (existing) { existing.textContent = label || '● REC'; return; }
      var host = document.body || document.documentElement;
      if (!host) return;
      var badge = document.createElement('div');
      badge.id = BADGE_ID;
      badge.textContent = label || '● REC';
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

    function setRecording(on, mode) {
      recording = !!on;
      if (recording) {
        showBadge(mode === 'redo' ? '● REDO' : mode === 'nextpage' ? '● NEXT PAGE' : '● REC');
      } else hideBadge();
    }

    try {
      chrome.storage.local.get('mode').then(function (data) {
        setRecording(data && (data.mode === 'recording' || data.mode === 'redo' ||
                              data.mode === 'nextpage'), data && data.mode);
      }).catch(function () {});
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.mode) {
          var m = changes.mode.newValue;
          setRecording(m === 'recording' || m === 'redo' || m === 'nextpage', m);
        }
      });
    } catch (e) { /* storage unavailable - stay idle */ }

    /* --------------------------------------------------- element resolution */

    function findByText(step) {
      var tag = (step.tagName || '*').toLowerCase();
      var want = squash(step.fallbackText || step.ariaLabel || '').toLowerCase();
      if (!want) return null;
      var nodes;
      try { nodes = deepQueryAll(tag); } catch (e) { return null; }
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!isUsable(n)) continue;
        if (visibleText(n).toLowerCase() === want) return n;
        if (attr(n, 'aria-label').toLowerCase() === want) return n;
      }
      return null;
    }

    function findWithin(root, step) {
      if (step.selector) {
        /* The search is already scoped to this container, so only the part of
         * the selector describing the element itself is wanted - the route to
         * whatever root it was recorded in leads somewhere above here. */
        var hits = [];
        try { hits = deepQueryAll(lastHop(step.selector), root); } catch (e) { hits = []; }
        for (var h = 0; h < hits.length; h++) {
          if (isUsable(hits[h])) return hits[h];
        }
      }
      var want = squash(step.fallbackText || step.ariaLabel || '').toLowerCase();
      if (!want) return null;
      var tag = (step.tagName || '*').toLowerCase();
      var nodes;
      try { nodes = deepQueryAll(tag, root); } catch (e) { return null; }
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
      /* A path counted through the tree is the weakest thing we record. Dialog
       * markup in particular is rebuilt each time it opens and rarely lands at
       * the same index twice, so where the element had recognisable wording,
       * that is tried first and the path is only the fallback. */
      var positional = /:nth-(of-type|child|last-child|last-of-type)\b/i.test(step.selector || '');
      if (positional) {
        var byText = findByText(step);
        if (byText) return byText;
      }

      if (step.selector) {
        var matches = null;
        try { matches = deepQueryAll(step.selector); } catch (e) { matches = null; }
        if (matches && matches.length) {
          for (var i = 0; i < matches.length; i++) {
            if (isUsable(matches[i])) return matches[i];
          }
          /* The element is on the page but not usable yet - hidden, or sitting
           * behind a dialog. Waiting for it is right; falling through to match
           * whatever else happens to share its wording is how a replay ends up
           * clicking a completely different button. */
          if (!positional) return null;
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
          var frames = document.querySelectorAll('iframe, frame').length;
          return {
            ok: false,
            error: 'could not find ' + describeTarget(step) +
                   ' after waiting ' + Math.round(wait / 1000) + ' seconds' +
                   /* Otherwise this failure is a mystery on a page that keeps
                    * its controls in an embedded frame. */
                   (frames ? ' — note this page has ' + frames + ' embedded frame' +
                             (frames === 1 ? '' : 's') + ', and the recorder only reaches the ' +
                             'main page, so a control inside one cannot be found' : '')
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
     *   :text("exact visible text")   - matches that wording exactly
     *   :text^("leading words")       - matches wording that starts with it
     * Both exist because the wording is often what says whether a row still
     * needs doing, and some pages put the row's own name in it. */
    function parsePattern(pattern) {
      var raw = String(pattern == null ? '' : pattern).trim();
      var m = /:text(\^)?\(\s*(["'])([\s\S]*?)\2\s*\)\s*$/.exec(raw);
      if (m) {
        var css = raw.slice(0, m.index).trim() || '*';
        if (m[1]) return { css: css, text: null, textPrefix: m[3] };
        return { css: css, text: m[3], textPrefix: null };
      }
      return { css: raw, text: null, textPrefix: null };
    }

    function queryPattern(pattern) {
      var parsed = parsePattern(pattern);
      if (!parsed.css) throw new Error('The match pattern is empty.');
      if (/:nth-(of-type|child|last-child|last-of-type)\b/i.test(parsed.css)) throw positionalError();
      var nodes;
      try {
        nodes = deepQueryAll(parsed.css);
      } catch (e) {
        throw new Error('"' + parsed.css + '" is not a valid CSS selector.');
      }
      if (parsed.text !== null) {
        var want = squash(parsed.text).toLowerCase();
        nodes = nodes.filter(function (n) { return visibleText(n).toLowerCase() === want; });
      } else if (parsed.textPrefix !== null) {
        var head = squash(parsed.textPrefix).toLowerCase();
        nodes = nodes.filter(function (n) {
          return visibleText(n).toLowerCase().indexOf(head) === 0;
        });
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

    /* How a candidate pattern actually lands on the live page: how many it
     * matches, and how many of those are showing the same wording as the
     * element that was recorded. A list part-way through a job holds rows in
     * more than one state - some still to do, some already actioned - and an
     * attribute hook alone does not tell them apart. */
    function analyzePattern(pattern, text, prefix, signature) {
      var nodes = queryPattern(pattern);
      var want = squash(text).toLowerCase();
      var head = squash(prefix || '').toLowerCase();
      var mine = squash(signature || '');
      var withText = 0;
      var withPrefix = 0;
      var elsewhere = 0;
      for (var i = 0; i < nodes.length; i++) {
        var t = visibleText(nodes[i]).toLowerCase();
        if (t === want) withText += 1;
        if (head && t.indexOf(head) === 0) withPrefix += 1;
        /* Matches that are demonstrably a different element from the one that
         * was recorded. Counting matches alone cannot tell "another row this
         * applies to" from "the control I just clicked, still sitting there",
         * and a list that has only loaded its first couple of rows shows just
         * one of each. */
        if (mine && signatureOf(nodes[i]) && signatureOf(nodes[i]) !== mine) elsewhere += 1;
      }
      return {
        ok: true, count: nodes.length,
        withText: withText, withPrefix: withPrefix,
        others: nodes.length - withText,
        othersPrefix: nodes.length - withPrefix,
        elsewhere: elsewhere
      };
    }

    /* Shows the user exactly which elements a loop would act on, by outlining
     * them on the page without touching them. Guessing from a count alone is
     * how a pattern that looks right turns out to be picking up the wrong
     * rows. */
    function previewPattern(pattern) {
      var nodes = queryPattern(pattern);
      var labels = [];
      for (var i = 0; i < nodes.length; i++) {
        if (i === 0) bringIntoView(nodes[i]);
        var el = nodes[i];
        var prevOutline = el.style.outline;
        var prevOffset = el.style.outlineOffset;
        el.style.outline = '3px solid #1f6feb';
        el.style.outlineOffset = '2px';
        (function (node, o, f) {
          setTimeout(function () {
            try { node.style.outline = o; node.style.outlineOffset = f; } catch (e) { /* gone */ }
          }, 2500);
        })(el, prevOutline, prevOffset);
        if (labels.length < 6) {
          labels.push(squash(visibleText(el) || attr(el, 'aria-label')).slice(0, 40));
        }
      }
      return { ok: true, count: nodes.length, labels: labels };
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

    /* A pass is only finished when whatever it opened has gone away again.
     * Starting the next one while a dialog is still up means clicking into a
     * covered page: the click lands on nothing, and by the time the dialog does
     * appear it belongs to the wrong row.
     *
     * "Settled" is: no modal dialog is open, or the pattern still has usable
     * matches anyway - which covers the case where the dialog IS the list. */
    function isSettled(pattern) {
      if (!openDialog()) return true;
      try { return queryPattern(pattern).length > 0; } catch (e) { return true; }
    }

    function repeatSettle(pattern, timeoutMs) {
      var end = Date.now() + (timeoutMs > 0 ? timeoutMs : 8000);
      return (function attempt() {
        if (aborted) return Promise.resolve({ ok: true, settled: true, aborted: true });
        if (isSettled(pattern)) return Promise.resolve({ ok: true, settled: true });
        if (Date.now() >= end) {
          return Promise.resolve({ ok: true, settled: false, dialogOpen: !!openDialog() });
        }
        return sleep(200).then(attempt);
      })();
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
      if (msg.cmd === 'previewPattern') {
        try { sendResponse(previewPattern(msg.pattern)); }
        catch (e) { sendResponse({ ok: false, error: e.message }); }
        return;
      }
      if (msg.cmd === 'analyzePattern') {
        try { sendResponse(analyzePattern(msg.pattern, msg.text, msg.prefix, msg.signature)); }
        catch (e) { sendResponse({ ok: false, error: e.message }); }
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
      if (msg.cmd === 'repeatSettle') {
        repeatSettle(msg.pattern, msg.timeoutMs).then(sendResponse).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        });
        return true;
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
