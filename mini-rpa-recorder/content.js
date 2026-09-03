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

    /* Ids a framework hands out at render time - ember782, mat-input-4,
     * react-select-2-input - are the same on the next load only by luck, and
     * a selector built on one clicks whatever holds that id now. An id that
     * ends in digits, or carries a purely numeric segment, is treated as one
     * of those and never used as a hook. */
    function looksGeneratedId(value) {
      var s = String(value == null ? '' : value);
      if (looksGenerated(s)) return true;
      if (/[a-z_-]\d+$/i.test(s)) return true;
      if (/(^|[-_:.])\d+([-_:.]|$)/.test(s)) return true;
      return false;
    }

    /* A recorded selector that leans on such an id, or on a counted position,
     * is a weak hook. At playback the wording is tried first and the hook only
     * as a fallback - and even then what it lands on has to look like what was
     * recorded, or it is not taken. Recordings made before this was known are
     * covered as much as new ones. */
    function weakSelector(selector) {
      var sel = String(selector == null ? '' : selector);
      if (/:nth-(of-type|child|last-child|last-of-type)\b/i.test(sel)) return true;
      var re = /#((?:\\.|[\w-])+)/g;
      var m;
      while ((m = re.exec(sel))) {
        if (looksGeneratedId(m[1].replace(/\\(.)/g, '$1'))) return true;
      }
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

    /* Every dialog showing on the page, in document order. Declared before
     * isBehindModal because that has to know what the dialog contains. */
    function visibleDialogs() {
      var nodes;
      try {
        nodes = deepQueryAll('[role="dialog"], [aria-modal="true"], dialog[open]');
      } catch (e) { return []; }
      return nodes.filter(function (n) {
        var rect = n.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    }

    /* The topmost dialog on the page, if one is open. */
    function openDialog() {
      var open = visibleDialogs();
      return open.length ? open[open.length - 1] : null;
    }

    /* Dialogs that were already up when a pass clicked its row - a chat
     * bubble, a cookie notice, a help panel - are part of the page, not
     * something the click brought up. Only a dialog that has appeared since
     * counts as the pass's own, whether that is where its next step is looked
     * for or what "close the pop-up" closes. */
    var dialogsBefore = [];

    function noteDialogs() {
      dialogsBefore = visibleDialogs();
    }

    function newDialog() {
      var open = visibleDialogs();
      for (var i = open.length - 1; i >= 0; i--) {
        if (dialogsBefore.indexOf(open[i]) === -1) return open[i];
      }
      return null;
    }

    /* A dialog that takes over the page: everything outside it is unreachable
     * until it closes. A plain role="dialog" with no modal flag is treated as
     * an ordinary panel, because plenty of them do not block anything. */
    function isModal(dlg) {
      if (dlg.hasAttribute('aria-modal') && dlg.getAttribute('aria-modal') !== 'false') return true;
      return dlg.tagName === 'DIALOG' && dlg.hasAttribute('open');
    }

    /* The topmost modal, wherever it sits in the tree. A chat panel that
     * happens to come later in the document is not on top of it. */
    function modalDialog() {
      var open = visibleDialogs();
      for (var i = open.length - 1; i >= 0; i--) if (isModal(open[i])) return open[i];
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
        /* A modal covers everything outside it and nothing inside it - and
         * that holds whether or not it is the last dialog in the document. */
        var modal = modalDialog();
        if (modal) return !containsDeep(modal, el);
        var dlg = openDialog();
        if (dlg && containsDeep(dlg, el)) return false;
        return !!closestDeep(el, '[aria-hidden="true"], [inert]');
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
        if (id && !looksGeneratedId(id) && uniqueSelector('#' + cssEscape(id), root)) {
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
      if (id && !looksGeneratedId(id) && uniqueSelector('#' + cssEscape(id), root)) {
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

    /* Every mode in which a click on the page is being listened for, and what
     * the badge says while it is. */
    var LISTENING = {
      recording: '● REC',
      redo: '● REDO',
      nextpage: '● NEXT PAGE',
      dismiss: '● CLOSE BUTTON'
    };

    function setRecording(on, mode) {
      recording = !!on;
      if (recording) showBadge(LISTENING[mode] || '● REC');
      else hideBadge();
    }

    function listensIn(mode) {
      return Object.prototype.hasOwnProperty.call(LISTENING, String(mode));
    }

    try {
      chrome.storage.local.get('mode').then(function (data) {
        var m = data && data.mode;
        setRecording(listensIn(m), m);
      }).catch(function () {});
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.mode) {
          var m = changes.mode.newValue;
          setRecording(listensIn(m), m);
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

    /* A form field's name outlives any id a framework gave it, so a typing
     * step recorded against such an id can still find its field. */
    function findByName(step, root) {
      var name = step.attrs && step.attrs.name;
      if (!name) return null;
      var tag = (step.tagName || '*').toLowerCase();
      var nodes;
      try { nodes = deepQueryAll(tag + '[name="' + cssEscape(name) + '"]', root); } catch (e) { return null; }
      for (var i = 0; i < nodes.length; i++) if (isUsable(nodes[i])) return nodes[i];
      return null;
    }

    /* Whether an element a weak hook landed on is plausibly the one that was
     * recorded: the same kind of element, and where the recording had
     * wording or a label, the same wording or label. A hook that leads
     * somewhere else is a hook to ignore, not to click. */
    function looksLikeRecorded(el, step) {
      if (!el || !step) return false;
      var tag = String(step.tagName || '').toLowerCase();
      if (tag && tag !== '*' && el.tagName.toLowerCase() !== tag) return false;
      var a = step.attrs || {};
      if (a.name && attr(el, 'name') && attr(el, 'name') !== a.name) return false;
      if (step.type === 'input' || step.type === 'change' || step.type === 'key') return true;
      var wantText = squash(step.fallbackText).toLowerCase();
      var wantAria = squash(step.ariaLabel).toLowerCase();
      if (!wantText && !wantAria) return true;
      var text = visibleText(el).toLowerCase();
      var aria = attr(el, 'aria-label').toLowerCase();
      return (!!wantText && (text === wantText || aria === wantText)) ||
             (!!wantAria && (aria === wantAria || text === wantAria));
    }

    function findWithin(root, step) {
      if (step.selector) {
        /* The search is already scoped to this container, so only the part of
         * the selector describing the element itself is wanted - the route to
         * whatever root it was recorded in leads somewhere above here. */
        var weak = weakSelector(step.selector);
        var hits = [];
        try { hits = deepQueryAll(lastHop(step.selector), root); } catch (e) { hits = []; }
        for (var h = 0; h < hits.length; h++) {
          if (isUsable(hits[h]) && (!weak || looksLikeRecorded(hits[h], step))) return hits[h];
        }
        if (weak) {
          var named = findByName(step, root);
          if (named) return named;
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
       * pages very often have a second "Next" or "Accept" underneath it. The
       * one the pass just brought up comes first; a panel that was open all
       * along only afterwards. */
      var dialog = newDialog() || openDialog();
      if (dialog) {
        var inDialog = findWithin(dialog, step);
        if (inDialog) return inDialog;
      }
      /* A path counted through the tree, or a framework's numbered id, is the
       * weakest thing we record. Dialog markup in particular is rebuilt each
       * time it opens and rarely lands at the same index or id twice, so where
       * the element had recognisable wording, that is tried first and the hook
       * is only the fallback. */
      var weak = weakSelector(step.selector || '');
      if (weak) {
        var byName = findByName(step);
        if (byName) return byName;
        var byText = findByText(step);
        if (byText) return byText;
      }

      if (step.selector) {
        var matches = null;
        try { matches = deepQueryAll(step.selector); } catch (e) { matches = null; }
        if (matches && matches.length) {
          for (var i = 0; i < matches.length; i++) {
            if (isUsable(matches[i]) && (!weak || looksLikeRecorded(matches[i], step))) return matches[i];
          }
          /* The element is on the page but not usable yet - hidden, or sitting
           * behind a dialog. Waiting for it is right; falling through to match
           * whatever else happens to share its wording is how a replay ends up
           * clicking a completely different button. */
          if (!weak) return null;
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

    /* The kinds of box in which an Enter means "submit this form". The browser
     * submits a form that has no submit button only when the form holds
     * exactly one of these, which is the rule followed below. */
    var ENTER_SUBMITS = {
      text: 1, search: 1, url: 1, tel: 1, email: 1, password: 1, number: 1,
      date: 1, month: 1, week: 1, time: 1, 'datetime-local': 1
    };

    /* What the browser does of its own accord after an Enter that nobody
     * cancelled. A synthetic key event carries no default action, so without
     * this an Enter recorded in a search box replays as nothing at all on a
     * page that leaves the submitting to the browser.
     *
     * Only the button-less form is handled here, on purpose. Where the form has
     * a submit button, a real Enter clicks that button and the browser marks
     * that click as trusted - so it was recorded as a click step of its own,
     * and that step does the submitting at playback. Doing it here as well
     * would submit twice. */
    function enterDefault(el) {
      if (!el || (el.tagName || '').toLowerCase() !== 'input') return;
      if (!ENTER_SUBMITS[String(el.type || 'text').toLowerCase()]) return;
      var form = el.form || closestDeep(el, 'form');
      if (!form || !form.elements) return;
      var controls = form.elements;
      var fields = 0;
      for (var i = 0; i < controls.length; i++) {
        var c = controls[i];
        var tag = (c.tagName || '').toLowerCase();
        var type = String(c.type || '').toLowerCase();
        if ((tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image'))) {
          return;                /* the button's own click step covers this */
        }
        if (tag === 'input' && ENTER_SUBMITS[type]) fields += 1;
      }
      if (fields !== 1) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    }

    function pressKey(el, key) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      var codes = { Enter: 13, Tab: 9, Escape: 27 };
      var legacy = codes[key] || 0;
      function fire(type, charCode) {
        /* keyCode and which have to go through the constructor. Setting them as
         * expandos afterwards looks right from here but never reaches the page:
         * this script runs in an isolated world, and the page sees its own
         * wrapper of the event without any properties added on this side. Plenty
         * of sites still gate on keyCode === 13, so a 0 here means the Enter
         * simply does nothing. */
        return el.dispatchEvent(new KeyboardEvent(type, {
          key: key, code: key, keyCode: legacy, which: legacy, charCode: charCode || 0,
          bubbles: true, cancelable: true, composed: true
        }));
      }
      /* dispatchEvent answers false when a handler called preventDefault -
       * the page saying it has dealt with the key itself - and only then is
       * the browser's own follow-through left out, just as for a real key.
       * Enter is also the one of these keys that produces a keypress, and a
       * fair few older pages listen for that rather than keydown. */
      var allowed = fire('keydown');
      if (key === 'Enter' && allowed) allowed = fire('keypress', legacy);
      if (key === 'Enter' && allowed) {
        try { enterDefault(el); } catch (e) { /* the page can refuse; the key was still pressed */ }
      }
      fire('keyup');
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

    /* The pattern as written, and failing that the same idea one notch
     * looser: the same attributes or wording on any kind of control. A site
     * that serves a row's button as <a> one week and <button> the next should
     * not stop a loop that plainly still has rows to do - the attributes and
     * the wording are what identify a row, not the tag. Only the tag is ever
     * loosened; an attribute or a pinned wording is never dropped. */
    var CONTROLS = ':is(button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"])';

    function relaxedPattern(pattern) {
      var parsed = parsePattern(pattern);
      var css = parsed.css;
      if (/[\s>+~]/.test(css)) return '';                  /* only a single compound selector */
      var m = /^([a-z][a-z0-9-]*)(.*)$/i.exec(css);
      if (!m) return '';                                    /* no tag to loosen */
      var text = parsed.text !== null ? ':text("' + quote(parsed.text) + '")'
               : parsed.textPrefix !== null ? ':text^("' + quote(parsed.textPrefix) + '")' : '';
      if (!m[2] && !text) return '';                        /* a bare tag says nothing about a row */
      return CONTROLS + m[2] + text;
    }

    function queryPatternHealed(pattern) {
      var nodes = queryPattern(pattern);
      if (nodes.length) return { nodes: nodes, used: '' };
      var alt = relaxedPattern(pattern);
      if (!alt) return { nodes: nodes, used: '' };
      var more;
      try { more = queryPattern(alt); } catch (e) { return { nodes: nodes, used: '' }; }
      return more.length ? { nodes: more, used: alt } : { nodes: nodes, used: '' };
    }

    /* Everything the panel needs to say why a count is what it is: how many
     * elements the selector finds before any filtering, how many of those
     * show the wording it is pinned to, how many of the rest are hidden,
     * disabled or behind a pop-up, what the others say instead, and whether
     * the same hook lands on another kind of control. */
    function diagnosePattern(pattern) {
      var parsed = parsePattern(pattern);
      if (!parsed.css) throw new Error('The match pattern is empty.');
      if (/:nth-(of-type|child|last-child|last-of-type)\b/i.test(parsed.css)) throw positionalError();
      var raw;
      try { raw = deepQueryAll(parsed.css); } catch (e) {
        throw new Error('"' + parsed.css + '" is not a valid CSS selector.');
      }
      var want = parsed.text !== null ? squash(parsed.text).toLowerCase() : null;
      var head = parsed.textPrefix !== null ? squash(parsed.textPrefix).toLowerCase() : null;
      var worded = raw.filter(function (n) {
        var t = visibleText(n).toLowerCase();
        if (want !== null) return t === want;
        if (head !== null) return t.indexOf(head) === 0;
        return true;
      });
      var usable = worded.filter(isUsable);
      var hidden = 0;
      var disabled = 0;
      var behind = 0;
      worded.forEach(function (n) {
        if (isUsable(n)) return;
        if (n.disabled || attr(n, 'aria-disabled') === 'true') disabled += 1;
        else if (isBehindModal(n)) behind += 1;
        else hidden += 1;
      });
      var samples = [];
      if (!worded.length) {
        raw.forEach(function (n) {
          if (samples.length >= 3) return;
          var t = squash(visibleText(n) || attr(n, 'aria-label')).slice(0, 30);
          if (t && samples.indexOf(t) === -1) samples.push(t);
        });
      }
      var healed = queryPatternHealed(pattern);
      var blocker = behind ? (modalDialog() || openDialog()) : null;
      return {
        ok: true,
        count: usable.length,
        raw: raw.length,
        worded: worded.length,
        hidden: hidden,
        disabled: disabled,
        behind: behind,
        blocker: blocker ? dialogHeading(blocker) : '',
        samples: samples,
        healed: healed.used,
        healedCount: healed.used ? healed.nodes.length : 0,
        healedTag: healed.used && healed.nodes.length ? healed.nodes[0].tagName.toLowerCase() : ''
      };
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
      var found = queryPatternHealed(pattern);
      var nodes = found.nodes;
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
      return { ok: true, count: nodes.length, labels: labels, healed: found.used };
    }

    function repeatProbe(pattern) {
      /* A pass is starting: whatever is open now is part of the page. */
      noteDialogs();
      var found = queryPatternHealed(pattern);
      return { ok: true, count: found.nodes.length, distinct: allSignaturesDistinct(found.nodes), healed: found.used };
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
      var found = queryPatternHealed(pattern);
      var nodes = found.nodes;
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
        return { ok: true, clicked: false, countBefore: countBefore, previousUnchanged: previousUnchanged,
                 healed: found.used };
      }
      var signature = signatureOf(target);
      var state = stateOf(target);
      var label = buttonLabel(target);
      /* Whatever is open now was there before this click. */
      noteDialogs();
      bringIntoView(target);
      highlight(target);
      clickElement(target);
      return {
        ok: true, clicked: true, signature: signature, state: state, label: label,
        countBefore: countBefore, previousUnchanged: previousUnchanged, healed: found.used
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
      if (!newDialog()) return true;
      try { return queryPatternHealed(pattern).nodes.length > 0; } catch (e) { return true; }
    }

    function repeatSettle(pattern, timeoutMs) {
      var end = Date.now() + (timeoutMs > 0 ? timeoutMs : 8000);
      return (function attempt() {
        if (aborted) return Promise.resolve({ ok: true, settled: true, aborted: true });
        if (isSettled(pattern)) return Promise.resolve({ ok: true, settled: true });
        if (Date.now() >= end) {
          return Promise.resolve({ ok: true, settled: false, dialogOpen: !!newDialog() });
        }
        return sleep(200).then(attempt);
      })();
    }

    /* --------------------------------------------------- closing a pop-up */

    /* Controls that close a pop-up without doing anything else, in the order
     * they are tried: an × marked Close or Dismiss, then the ways of saying
     * no, then plain acknowledgements. Anything that would act - Send,
     * Connect, Submit, Delete - is never on these lists; a pop-up that
     * offers nothing else is left alone and reported rather than guessed at. */
    var CLOSE_ARIA = /^(close|dismiss|cancel)(\b|$)/i;
    var CANCEL_TEXT = {
      'cancel': 1, 'not now': 1, 'no thanks': 1, 'no, thanks': 1, 'no': 1, 'dismiss': 1,
      'close': 1, 'skip': 1, 'skip for now': 1, 'maybe later': 1, 'later': 1,
      'never mind': 1, 'nevermind': 1, 'discard': 1, '×': 1, '✕': 1, '✖': 1, 'x': 1
    };
    var ACK_TEXT = { 'got it': 1, 'ok': 1, 'okay': 1, 'understood': 1, 'i understand': 1 };

    /* For the summary: an × button is better named by its label than its glyph. */
    function buttonLabel(el) {
      var text = squash(visibleText(el));
      if (!/[a-z0-9]/i.test(text)) text = '';
      return squash(text || attr(el, 'aria-label') || attr(el, 'title') || el.value || visibleText(el) || '');
    }

    function closeCandidates(dlg) {
      var nodes;
      try { nodes = deepQueryAll('button, [role="button"], input[type="button"]', dlg); }
      catch (e) { return []; }
      var byAria = [];
      var byCancel = [];
      var byAck = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!isUsable(n)) continue;
        var text = squash(visibleText(n) || n.value || '').toLowerCase();
        var aria = attr(n, 'aria-label').toLowerCase();
        var title = attr(n, 'title').toLowerCase();
        if (CLOSE_ARIA.test(aria) || CLOSE_ARIA.test(title)) byAria.push(n);
        else if (CANCEL_TEXT[text]) byCancel.push(n);
        else if (ACK_TEXT[text]) byAck.push(n);
      }
      return byAria.concat(byCancel, byAck).slice(0, 3);
    }

    /* What a pop-up calls itself, for the run summary: its labelled heading,
     * its first heading, its label, or failing all of those its opening words. */
    function dialogHeading(dlg) {
      var el = null;
      var by = attr(dlg, 'aria-labelledby').split(/\s+/)[0];
      if (by) {
        var root = rootOf(dlg);
        try { el = root.getElementById ? root.getElementById(by) : null; } catch (e) { el = null; }
        if (!el) { try { el = document.getElementById(by); } catch (e2) { el = null; } }
      }
      if (!el) {
        try { el = dlg.querySelector('h1, h2, h3, h4, [role="heading"]'); } catch (e3) { el = null; }
      }
      var text = el ? visibleText(el) : '';
      if (!text) text = attr(dlg, 'aria-label');
      if (!text) text = visibleText(dlg);
      return squash(text).slice(0, 80);
    }

    function dialogGone(dlg) {
      if (!dlg.isConnected) return true;
      if (dlg.tagName === 'DIALOG' && !dlg.hasAttribute('open')) return true;
      var rect = dlg.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return true;
      /* Judged on its own showing, not on whether it is the topmost one: a
       * chat bubble later in the page must not make a pop-up look closed. */
      return visibleDialogs().indexOf(dlg) === -1;
    }

    function waitDialogGone(dlg, timeoutMs) {
      var end = Date.now() + timeoutMs;
      return (function attempt() {
        if (dialogGone(dlg)) return Promise.resolve(true);
        if (aborted || Date.now() >= end) return Promise.resolve(false);
        return sleep(100).then(attempt);
      })();
    }

    /* On some pages the list itself lives in a pop-up. That one is never in
     * the way, whatever else is. */
    function holdsMatches(dlg, pattern) {
      var nodes;
      try { nodes = queryPatternHealed(pattern).nodes; } catch (e) { return false; }
      for (var i = 0; i < nodes.length; i++) if (containsDeep(dlg, nodes[i])) return true;
      return false;
    }

    /* The ways of closing a pop-up, tried in turn and each checked before the
     * next: a control the user recorded for it, Escape, a Close or Cancel
     * button of its own, then a native dialog's own close. Answers how it was
     * closed, or nothing if it is still there. */
    function tryClose(dlg, control) {
      function attempt(act) {
        var how = act();
        if (!how) return Promise.resolve('');
        return waitDialogGone(dlg, 1500).then(function (gone) { return gone ? how : ''; });
      }
      var plans = [];
      if (control && control.selector !== undefined) {
        plans.push(function () {
          return attempt(function () {
            var el = findWithin(dlg, control);
            if (!el) return '';
            bringIntoView(el);
            clickElement(el);
            return "clicked '" + squash(control.fallbackText || control.ariaLabel || buttonLabel(el)).slice(0, 30) + "'";
          });
        });
      }
      plans.push(function () {
        return attempt(function () {
          var active = document.activeElement;
          pressKey(active && containsDeep(dlg, active) ? active : dlg, 'Escape');
          return 'pressed Escape';
        });
      });
      plans.push(function () {
        var buttons = closeCandidates(dlg);
        var k = 0;
        function nextButton() {
          if (k >= buttons.length) return Promise.resolve('');
          var btn = buttons[k++];
          return attempt(function () {
            if (!isUsable(btn)) return '';
            bringIntoView(btn);
            clickElement(btn);
            return "clicked '" + buttonLabel(btn).slice(0, 30) + "'";
          }).then(function (how) { return how || nextButton(); });
        }
        return nextButton();
      });
      if (dlg.tagName === 'DIALOG' && typeof dlg.close === 'function') {
        plans.push(function () {
          return attempt(function () {
            try { dlg.close(); } catch (e) { return ''; }
            return 'closed the dialog';
          });
        });
      }
      var i = 0;
      function next() {
        if (aborted || i >= plans.length) return Promise.resolve('');
        return plans[i++]().then(function (how) { return how || next(); });
      }
      return next();
    }

    /* A pop-up other than the one the pass expects is in the way. Close it,
     * and whatever comes up in its wake - a "discard?" confirm, say - until
     * the page is clear or nothing works. Reports what it was and how it went. */
    function repeatDismiss(pattern, control) {
      var attempts = 0;
      var first = null;
      function result(clear) {
        return {
          ok: true,
          hadDialog: !!first,
          dismissed: !!first && clear,
          heading: first ? first.heading : '',
          how: first ? first.how : ''
        };
      }
      function cycle() {
        /* Only what the pass itself brought up is in the way; a panel that
         * was open before the row was clicked is left exactly as it was. */
        var dlg = newDialog();
        if (!dlg || holdsMatches(dlg, pattern)) return Promise.resolve(result(true));
        if (aborted || attempts >= 3) return Promise.resolve(result(false));
        attempts += 1;
        if (!first) first = { heading: dialogHeading(dlg), how: '' };
        return tryClose(dlg, control).then(function (how) {
          if (!how) return result(false);
          if (!first.how) first.how = how;
          return sleep(300).then(cycle);
        });
      }
      return cycle();
    }

    /* Lazy lists only reveal the next batch once you reach the bottom. */
    function repeatRescue(pattern) {
      try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* ignore */ }
      return sleepInterruptible(RESCUE_WAIT_MS).then(function () {
        var found;
        try { found = queryPatternHealed(pattern); } catch (e) { return { ok: false, error: e.message }; }
        return { ok: true, count: found.nodes.length, healed: found.used };
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
        try { sendResponse(diagnosePattern(msg.pattern)); }
        catch (e) { sendResponse({ ok: false, error: e.message }); }
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
      if (msg.cmd === 'repeatDismiss') {
        aborted = false;
        repeatDismiss(msg.pattern, msg.control || null).then(sendResponse).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        });
        return true;
      }
    });
  })();
}
