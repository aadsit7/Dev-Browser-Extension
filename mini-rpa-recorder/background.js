/* Mini RPA Recorder - background service worker.
 *
 * MV3 service workers are shut down after roughly 30 seconds of inactivity, so
 * NOTHING important lives in a module variable. Mode, steps, playback position
 * and the repeat counter all live in chrome.storage, and every handler re-reads
 * what it needs before acting.
 */

var DELAY_FLOOR_MS = 500;      /* hard floor, protects against rate limits */
var MAX_REPEATS_CEILING = 100; /* hard ceiling on repeats */
var DEFAULT_MAX_REPEATS = 25;
var DEFAULT_DELAY_SECONDS = 2.0;
var GAP_MIN_MS = 250;
var GAP_MAX_MS = 3000;
var TAB_LOAD_TIMEOUT_MS = 20000;
var STALL_LIMIT = 3;           /* rounds with no progress before giving up */
var FOLLOWER_TIMEOUT_MS = 5000;  /* per follow-on step when misses are skipped */
var FOLLOWER_STRICT_MS = 10000; /* per follow-on step when a miss stops the run */
var SETTLE_TIMEOUT_MS = 8000;   /* wait for a dialog to clear between passes */
var RESCUE_LIMIT = 3;          /* scroll-to-load attempts per repeat step */
var PAGE_TURN_LIMIT = 20;      /* hard ceiling on next-page presses in one run */
var PAGE_LOAD_TIMEOUT_MS = 15000; /* wait for the next page to bring rows in */
var DEFAULT_GROUP_SIZE = 1;
var DISMISS_SAME_LIMIT = 5;    /* the same pop-up this many rows running is not about a row */

var MATCH_LEVEL_TEXT = {
  exact: 'same web address',
  page: 'same page, different search terms',
  site: 'same website',
  'new': 'opened a new tab'
};

/* Only this instance of the worker knows whether it is already driving a
 * playback. It is deliberately NOT persisted: a fresh worker means nobody is
 * driving, and the run resumes from the position saved in session storage. */
var driving = false;

/* ------------------------------------------------------------------- utils */

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function uid() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function errText(e) {
  var text = String((e && e.message) || e || 'unknown error');
  if (/Receiving end does not exist|Could not establish connection/i.test(text)) {
    return 'the page is not reachable (it may have navigated, closed, or blocked the extension)';
  }
  if (/QUOTA|quota/.test(text)) {
    return 'the extension\'s storage is full (Chrome allows about 10 MB) - delete a saved recording ' +
           'or some screenshot steps to make room';
  }
  return text;
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!isFinite(n)) n = lo;
  return Math.min(hi, Math.max(lo, n));
}

function parseUrl(u) {
  try { return new URL(u); } catch (e) { return null; }
}

function hostOf(u) {
  var p = parseUrl(u);
  return p ? p.hostname : (u || 'unknown page');
}

/* chrome:// pages, the Chrome Web Store and anything non-http are off limits:
 * Chrome refuses to run extension scripts there. */
function injectionBlockReason(url) {
  if (!url) return 'Chrome did not share this tab’s address';
  if (/^https?:\/\/chromewebstore\.google\.com/i.test(url)) return 'the Chrome Web Store blocks extensions';
  if (/^https?:\/\/chrome\.google\.com\/webstore/i.test(url)) return 'the Chrome Web Store blocks extensions';
  if (!/^https?:\/\//i.test(url)) return 'Chrome only allows extensions on http and https pages';
  return '';
}

function isInjectable(url) {
  return injectionBlockReason(url) === '';
}

/* ------------------------------------------------------------------ state */

function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

function getPlay() {
  return chrome.storage.session.get('play').then(function (d) { return d.play || null; });
}

function setPlay(patch) {
  return getPlay().then(function (cur) {
    var next = Object.assign({}, cur || {}, patch);
    return chrome.storage.session.set({ play: next }).then(function () { return next; });
  });
}

function notice(text, kind) {
  return chrome.storage.local.set({
    notice: { text: String(text), kind: kind || 'info', at: Date.now() }
  });
}

/* Several handlers do read-modify-write on the steps array. Chaining them
 * keeps a fast burst of recorded steps from clobbering each other. */
var writeQueue = Promise.resolve();

function serialize(job) {
  var run = writeQueue.then(job, job);
  writeQueue = run.then(function () { return null; }, function () { return null; });
  return run;
}

function saveSteps(steps) {
  return chrome.storage.local.set({ steps: steps }).catch(function (e) {
    return notice('Could not save the recording: ' + errText(e) + '.', 'error').then(function () {
      throw e;
    });
  });
}

function normalizeRepeat(repeat) {
  var r = repeat || {};
  var maxRepeats = Math.round(clamp(r.maxRepeats == null ? DEFAULT_MAX_REPEATS : r.maxRepeats, 1, MAX_REPEATS_CEILING));
  var seconds = r.delaySeconds == null ? DEFAULT_DELAY_SECONDS : Number(r.delaySeconds);
  var delayMs = clamp(Math.round(seconds * 1000), DELAY_FLOOR_MS, 600000);
  return {
    pattern: String(r.pattern || '').trim(),
    maxRepeats: maxRepeats,
    delayMs: delayMs,
    delaySeconds: delayMs / 1000,
    /* How many steps make up one pass: this step plus the ones after it, so a
     * pass can cover "click the row, accept in the dialog, press next". */
    groupSize: Math.round(clamp(r.groupSize == null ? DEFAULT_GROUP_SIZE : r.groupSize, 1, 50)),
    /* What to do when a step in the pass cannot be found. Stopping is the
     * default because a half-finished pass usually means the action never
     * completed - the invitation was never sent, the dialog is still up - and
     * carrying on from there quietly does the wrong thing to every row after. */
    onMissing: r.onMissing === 'skip' ? 'skip' : r.onMissing === 'dismiss' ? 'dismiss' : 'stop',
    /* An optional control to press when this page has nothing left - Next,
     * a chevron, "Load more". Recorded the same way any click is, so it is
     * found at playback by exactly the same rules. */
    nextPage: r.nextPage && r.nextPage.selector !== undefined ? r.nextPage : null,
    /* An optional recorded control for closing a pop-up that is not the one
     * the pass expects. Without one, Escape and then a Cancel or Close button
     * of the pop-up's own are tried. */
    dismiss: r.dismiss && r.dismiss.selector !== undefined ? r.dismiss : null
  };
}

/* How many steps an action set covers: the anchor plus the ones after it.
 * Grouping is deliberately separate from looping now - a set is useful on its
 * own for keeping a sequence together - so the size lives on step.set, with a
 * fallback to where it used to live so older recordings still play. */
function rawSetSize(step) {
  if (step && step.set && step.set.size > 0) return Math.round(step.set.size);
  if (step && step.repeat && step.repeat.groupSize > 0) return Math.round(step.repeat.groupSize);
  return 1;
}

function groupSizeFor(step, index, total) {
  var wanted = 1;
  if (step && step.set && step.set.size > 0) wanted = Math.round(step.set.size);
  else if (step && step.repeat && step.repeat.groupSize > 0) wanted = Math.round(step.repeat.groupSize);
  return Math.max(1, Math.min(wanted, total - index));
}

function isRepeatOn(step) {
  return !!(step && step.repeat && step.repeat.enabled && String(step.repeat.pattern || '').trim());
}

/* --------------------------------------------------------- side panel wiring */

function initPanelBehaviour() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
  }
}
initPanelBehaviour();

chrome.runtime.onInstalled.addListener(function () {
  initPanelBehaviour();
  getLocal(['mode', 'steps', 'library']).then(function (d) {
    var patch = {};
    if (d.mode !== 'recording' && d.mode !== 'playing') patch.mode = 'idle';
    if (!Array.isArray(d.steps)) patch.steps = [];
    if (!Array.isArray(d.library)) patch.library = [];
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
});

chrome.runtime.onStartup.addListener(function () {
  initPanelBehaviour();
  /* Tab ids from the previous session are meaningless now, and no content
   * script survived the restart, so never resume a run across a restart. */
  chrome.storage.local.set({ mode: 'idle' });
  chrome.storage.session.set({ play: null });
});

/* Fires only when openPanelOnActionClick could not be set. */
chrome.action.onClicked.addListener(function (tab) {
  if (chrome.sidePanel && chrome.sidePanel.open && tab) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(function () {});
  }
});

/* ------------------------------------------------------------ tab plumbing */

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function ensureContentScript(tabId) {
  return sendToTab(tabId, { cmd: 'ping' }).then(function (r) {
    if (r && r.ok) return true;
    throw new Error('no answer');
  }).catch(function () {
    return chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] })
      .then(function () { return sleep(120); })
      .then(function () { return true; })
      .catch(function (e) {
        throw new Error('Chrome would not let this extension run on that page (' + errText(e) + ')');
      });
  });
}

function focusTab(tabId, windowId) {
  return chrome.tabs.update(tabId, { active: true }).then(function () {
    if (windowId == null) return null;
    return chrome.windows.update(windowId, { focused: true }).catch(function () { return null; });
  });
}

function getActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
    if (tabs && tabs.length) return tabs[0];
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (t2) {
      return (t2 && t2.length) ? t2[0] : null;
    });
  });
}

function waitForTabLoad(tabId) {
  var end = Date.now() + TAB_LOAD_TIMEOUT_MS;
  return (function attempt() {
    return chrome.tabs.get(tabId).catch(function () {
      throw new Error('the new tab was closed before it finished loading');
    }).then(function (tab) {
      if (tab.status === 'complete') return sleep(400);
      if (Date.now() >= end) throw new Error('a new tab took too long to load');
      return sleep(250).then(attempt);
    });
  })();
}

/* Tab identity is stored as { url, title } - never a raw tab id, because tab
 * ids change every time Chrome restarts. Resolution walks from strict to loose
 * so a loose match can be reported back to the user. */
function resolveTab(url, title) {
  var target = parseUrl(url);
  return Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true }).catch(function () { return []; }),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(function () { return []; })
  ]).then(function (r) {
    var tabs = r[0];
    var rank = {};
    r[1].forEach(function (t) { rank[t.id] = 1; });
    r[2].forEach(function (t) { rank[t.id] = 2; });
    var usable = tabs.filter(function (t) { return typeof t.id === 'number' && t.id >= 0; });
    /* Among tabs that match equally well, the one in front is the one the
     * user means. Two search tabs on the same site match the same at the
     * "same page" level, and taking whichever Chrome lists first sent runs
     * to a tab the user was not even looking at. */
    usable = usable.map(function (t, i) { return { t: t, i: i, r: rank[t.id] || 0 }; })
      .sort(function (a, b) { return (b.r - a.r) || (a.i - b.i); })
      .map(function (x) { return x.t; });

    var tests = [
      ['exact', function (t) { return t.url === url; }],
      ['page', function (t) {
        var u = parseUrl(t.url);
        return !!(target && u && u.origin === target.origin && u.pathname === target.pathname);
      }],
      ['site', function (t) {
        var u = parseUrl(t.url);
        return !!(target && u && u.origin === target.origin);
      }]
    ];

    for (var i = 0; i < tests.length; i++) {
      var level = tests[i][0];
      var test = tests[i][1];
      for (var j = 0; j < usable.length; j++) {
        var hit = false;
        try { hit = test(usable[j]); } catch (e) { hit = false; }
        if (hit) {
          var tab = usable[j];
          return focusTab(tab.id, tab.windowId).then(function () {
            return { tabId: tab.id, level: level, created: false };
          });
        }
      }
    }

    if (!isInjectable(url)) {
      throw new Error('this step was recorded on "' + (title || url || 'an unknown page') +
                      '", which the extension cannot open or control (' + injectionBlockReason(url) + ')');
    }
    return chrome.tabs.create({ url: url, active: true }).then(function (created) {
      return waitForTabLoad(created.id)
        .then(function () { return ensureContentScript(created.id); })
        .then(function () { return focusTab(created.id, created.windowId); })
        .then(function () { return { tabId: created.id, level: 'new', created: true }; });
    });
  });
}

/* --------------------------------------------------------------- recording */

/* The "Raw" variants do not take the write lock, so they can be composed
 * inside a single serialize() job without deadlocking on it. */
function appendStepRaw(step, coalesceKey) {
  return getLocal('steps').then(function (d) {
    var steps = Array.isArray(d.steps) ? d.steps : [];
    var last = steps.length ? steps[steps.length - 1] : null;

    /* A burst of keystrokes (or scroll ticks) collapses into a single step. */
    if (coalesceKey && last && last.coalesceKey === coalesceKey &&
        last.type === step.type && last.url === step.url) {
      steps[steps.length - 1] = Object.assign({}, step, {
        id: last.id,
        timestamp: last.timestamp,
        repeat: last.repeat || null,
        coalesceKey: coalesceKey
      });
    } else {
      steps.push(Object.assign({}, step, { coalesceKey: coalesceKey || null }));
    }
    return saveSteps(steps);
  });
}

function appendStep(step, coalesceKey) {
  return serialize(function () { return appendStepRaw(step, coalesceKey); });
}

function switchStepFor(tab) {
  return {
    id: uid(),
    type: 'switchTab',
    selector: '', tagName: '', ariaLabel: '', fallbackText: '', value: '',
    attrs: {},
    url: tab.url,
    title: tab.title || hostOf(tab.url),
    timestamp: Date.now(),
    repeat: null
  };
}

/* Records a "switched to tab" step the first time anything happens in a tab
 * that is not the one already being recorded. Driven from three places, because
 * no single event covers every case: onActivated misses a brand new tab (it is
 * still about:blank when it becomes active), onUpdated misses a switch back to
 * an already-loaded tab, and a step arriving from an unexpected tab is the
 * backstop for both. */
function noteTabRaw(tab) {
  if (!tab || typeof tab.id !== 'number') return Promise.resolve(false);
  return chrome.storage.session.get('lastTabId').then(function (d) {
    if (d.lastTabId === tab.id) return false;
    var block = injectionBlockReason(tab.url);
    if (block) {
      /* Deliberately does NOT claim lastTabId: a brand new tab is about:blank
       * for a moment, and marking it recorded here would swallow the real
       * switch once it finishes loading. */
      return chrome.storage.session.get('lastBlockedTabId').then(function (b) {
        if (b.lastBlockedTabId === tab.id) return false;
        return chrome.storage.session.set({ lastBlockedTabId: tab.id }).then(function () {
          return notice('Switched to a tab the extension cannot use (' + block +
                        '), so that switch was not recorded.', 'warn');
        }).then(function () { return false; });
      });
    }
    return chrome.storage.session.set({ lastTabId: tab.id, lastBlockedTabId: null }).then(function () {
      return getLocal('steps');
    }).then(function (s) {
      var steps = Array.isArray(s.steps) ? s.steps : [];
      var last = steps.length ? steps[steps.length - 1] : null;
      if (last && last.type === 'switchTab' && last.url === tab.url) return false;
      return appendStepRaw(switchStepFor(tab), null).then(function () { return true; });
    });
  });
}

function noteTab(tab) {
  return serialize(function () { return noteTabRaw(tab); });
}

/* Puts the content script into every tab that will take it, and reports the
 * ones that will not. Shared by recording and by re-recording a single step,
 * because both need the same reach. */
function injectIntoAllTabs() {
  return chrome.tabs.query({}).then(function (tabs) {
    var skipped = [];
    var ready = 0;
    var chain = Promise.resolve();
    tabs.forEach(function (tab) {
      chain = chain.then(function () {
        var block = injectionBlockReason(tab.url);
        if (block) {
          skipped.push({ title: tab.title || tab.url || 'Untitled tab', reason: block });
          return null;
        }
        return chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
          .then(function () { ready += 1; })
          .catch(function (e) {
            skipped.push({ title: tab.title || tab.url, reason: errText(e) });
          });
      });
    });
    return chain.then(function () {
      return chrome.storage.local.set({ skipped: skipped })
        .then(function () { return { ready: ready, skipped: skipped }; });
    });
  });
}

function startRecording() {
  return chrome.storage.local.set({ mode: 'recording', skipped: [], redoStepId: null })
    .then(function () { return chrome.storage.session.set({ play: null }); })
    .then(getActiveTab)
    .then(function (active) {
      /* The tab in front when recording starts is the baseline, so the
       * recording does not open with a pointless "switched to" step. */
      return chrome.storage.session.set({ lastTabId: active ? active.id : null });
    })
    .then(injectIntoAllTabs)
    .then(function (r) {
      var msg = 'Recording. Ready on ' + r.ready + ' tab' + (r.ready === 1 ? '' : 's') + '.';
      if (r.skipped.length) {
        msg += ' ' + r.skipped.length + ' tab' + (r.skipped.length === 1 ? ' was' : 's were') +
               ' skipped (listed below).';
      }
      return notice(msg, r.skipped.length ? 'warn' : 'info');
    });
}

/* Re-record one step in place. The step keeps its identity, so whatever action
 * set it belongs to is untouched; only what it does changes. */
function startRedo(id) {
  return getLocal('steps').then(function (d) {
    var steps = Array.isArray(d.steps) ? d.steps : [];
    var at = -1;
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) { at = i; break; }
    if (at < 0) return { ok: false, error: 'That step is no longer in the recording.' };
    return chrome.storage.local.set({ mode: 'redo', redoStepId: id })
      .then(injectIntoAllTabs)
      .then(function () { return notice('', 'info'); })
      .then(function () { return { ok: true }; });
  });
}

/* A loop can carry two recorded controls besides its steps: the one that
 * brings up the next page, and the one that closes a pop-up that is not the
 * one the pass expects. Both are captured the same way a step is re-recorded
 * - the user goes and clicks the thing, and the next click is what gets kept -
 * because that is the only way to be sure it is the control they actually
 * mean. The mode name doubles as the capture kind. */
var CAPTURES = {
  nextpage: {
    key: 'nextPageForId',
    field: 'nextPage',
    needLoop: 'Turn Loop on first — the next-page control is what the loop presses when the ' +
              'page runs out.',
    saved: function (control) {
      return 'Saved. When the page runs out, the loop will click ' + shortLabel(control) +
             ' and carry on there.';
    },
    cancelled: 'Cancelled — the loop still stops when the page runs out.',
    removed: 'Next-page control removed — the loop now stops when the page runs out.'
  },
  dismiss: {
    key: 'dismissForId',
    field: 'dismiss',
    needLoop: 'Turn Loop on first — the close button is what the loop presses when a different ' +
              'pop-up comes up.',
    saved: function (control) {
      return 'Saved. When a different pop-up comes up, the loop will click ' + shortLabel(control) +
             ' to close it and move on.';
    },
    cancelled: 'Cancelled — a pop-up is still closed with Escape or a Cancel or Close button of its own.',
    removed: 'Recorded close button removed — a pop-up is closed with Escape or a Cancel or Close ' +
             'button of its own again.'
  }
};

function startCapture(id, kind) {
  var cap = CAPTURES[kind];
  return getLocal('steps').then(function (d) {
    var steps = Array.isArray(d.steps) ? d.steps : [];
    var at = -1;
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) { at = i; break; }
    if (at < 0) return { ok: false, error: 'That step is no longer in the recording.' };
    if (!(steps[at].repeat && steps[at].repeat.enabled)) return { ok: false, error: cap.needLoop };
    var patch = { mode: kind };
    patch[cap.key] = id;
    return chrome.storage.local.set(patch)
      .then(injectIntoAllTabs)
      .then(function () { return notice('', 'info'); })
      .then(function () { return { ok: true }; });
  });
}

function cancelCapture(kind) {
  var cap = CAPTURES[kind];
  var patch = { mode: 'idle' };
  patch[cap.key] = null;
  return chrome.storage.local.set(patch)
    .then(function () { return notice(cap.cancelled, 'info'); })
    .then(function () { return { ok: true }; });
}

function clearCapture(id, kind) {
  var cap = CAPTURES[kind];
  return serialize(function () {
    return getLocal('steps').then(function (d) {
      var steps = Array.isArray(d.steps) ? d.steps.slice() : [];
      var at = -1;
      for (var i = 0; i < steps.length; i++) if (steps[i].id === id) { at = i; break; }
      if (at < 0) return { ok: false, error: 'That step is no longer in the recording.' };
      if (!steps[at].repeat) return { ok: true };
      var repeat = Object.assign({}, steps[at].repeat);
      repeat[cap.field] = null;
      steps[at] = Object.assign({}, steps[at], { repeat: repeat });
      return saveSteps(steps)
        .then(function () { return notice(cap.removed, 'info'); })
        .then(function () { return { ok: true }; });
    });
  });
}

/* Only a click can be one of these controls, and getting to the button often
 * means scrolling first, so anything else recorded here is ignored rather than
 * taken as the answer. */
function applyCapture(step, kind) {
  var cap = CAPTURES[kind];
  return serialize(function () {
    return getLocal(['mode', cap.key, 'steps']).then(function (s) {
      if (s.mode !== kind || !s[cap.key]) return { ok: false, error: 'not capturing' };
      if (step.type !== 'click') return { ok: true };
      var steps = Array.isArray(s.steps) ? s.steps.slice() : [];
      var at = -1;
      for (var i = 0; i < steps.length; i++) if (steps[i].id === s[cap.key]) { at = i; break; }
      var reset = { mode: 'idle' };
      reset[cap.key] = null;
      if (at < 0) {
        return chrome.storage.local.set(reset)
          .then(function () { return { ok: false, error: 'that step has gone' }; });
      }
      var owner = steps[at];
      var control = {
        type: 'click',
        selector: step.selector || '',
        tagName: step.tagName || '',
        ariaLabel: step.ariaLabel || '',
        fallbackText: step.fallbackText || '',
        value: '',
        attrs: step.attrs || {}
      };
      var repeat = Object.assign({}, owner.repeat || {});
      repeat[cap.field] = control;
      steps[at] = Object.assign({}, owner, { repeat: repeat });
      return chrome.storage.local.set(reset)
        .then(function () { return saveSteps(steps); })
        .then(function () { return notice(cap.saved(control), 'ok'); })
        .then(function () { return { ok: true }; });
    });
  });
}

function cancelRedo() {
  return chrome.storage.local.set({ mode: 'idle', redoStepId: null })
    .then(function () { return notice('Re-recording cancelled — the step is unchanged.', 'info'); })
    .then(function () { return { ok: true }; });
}

/* Swaps the newly recorded action into the slot, keeping the step's id and its
 * place in any action set. A loop on the old step referred to the old element,
 * so its pattern is cleared and flagged to be worked out again rather than
 * left pointing at something that is no longer there. */
function applyRedo(step) {
  return serialize(function () {
    /* Re-read under the lock: only the first action of the redo may land, even
     * if two events were already in flight. */
    return getLocal(['mode', 'redoStepId', 'steps']).then(function (s) {
      if (s.mode !== 'redo' || !s.redoStepId) return { ok: false, error: 'not re-recording' };
      var steps = Array.isArray(s.steps) ? s.steps.slice() : [];
      var at = -1;
      for (var i = 0; i < steps.length; i++) if (steps[i].id === s.redoStepId) { at = i; break; }
      if (at < 0) {
        return chrome.storage.local.set({ mode: 'idle', redoStepId: null })
          .then(function () { return { ok: false, error: 'that step has gone' }; });
      }
      var old = steps[at];
      var next = Object.assign({}, step, {
        id: old.id,
        set: old.set || null,
        repeat: null,
        coalesceKey: null
      });
      var note = 'Step ' + (at + 1) + ' replaced with: ' + shortLabel(next) + '.';
      if (old.repeat && old.repeat.enabled) {
        if (next.type === 'click') {
          next.repeat = Object.assign({}, old.repeat, { pattern: '' });
          next.needsPattern = true;
          note += ' Its loop is kept, and the match pattern is being worked out again from the ' +
                  'new element — check the count before playing.';
        } else {
          note += ' Its loop was switched off, because what replaced it is not a click.';
        }
      }
      steps[at] = next;
      return chrome.storage.local.set({ mode: 'idle', redoStepId: null })
        .then(function () { return saveSteps(steps); })
        .then(function () { return notice(note, 'ok'); })
        .then(function () { return { ok: true }; });
    });
  });
}

function stopRecording() {
  return getLocal('steps').then(function (d) {
    var n = Array.isArray(d.steps) ? d.steps.length : 0;
    return chrome.storage.local.set({ mode: 'idle', redoStepId: null }).then(function () {
      return notice('Recording stopped. ' + n + ' step' + (n === 1 ? '' : 's') + ' saved.', 'info');
    });
  });
}

function stampActiveTab() {
  return chrome.storage.session.set({ activeTabStamp: Date.now() }).catch(function () { return null; });
}

chrome.tabs.onActivated.addListener(function (info) {
  stampActiveTab();
  getLocal('mode').then(function (d) {
    if (d.mode !== 'recording') return null;
    return chrome.tabs.get(info.tabId).then(noteTab).catch(function () { return null; });
  }).catch(function () {});
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') return;
  if (tab.active) stampActiveTab();
  getLocal('mode').then(function (d) {
    if (d.mode !== 'recording') return null;
    if (!isInjectable(tab.url)) return null;
    return chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] })
      .then(function () {
        /* A tab that was still about:blank when it became active only reveals
         * its real address now. */
        if (tab.active) return noteTab(tab);
        return null;
      })
      .catch(function (e) {
        return notice('Could not start recording on "' + (tab.title || hostOf(tab.url)) +
                      '": ' + errText(e) + '.', 'warn');
      });
  }).catch(function () {});
});

/* --------------------------------------------------------------- playback */

function clip(text, max) {
  var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

function shortLabel(step) {
  var name = step.ariaLabel || step.fallbackText || step.selector || step.tagName || 'element';
  if (name.length > 48) name = name.slice(0, 45) + '...';
  switch (step.type) {
    case 'click': return 'click ' + (step.tagName || 'element') + ' "' + name + '"';
    case 'input': return 'type into "' + name + '"';
    case 'change': return 'set "' + name + '"';
    case 'key': return 'press ' + step.value;
    case 'scroll': return 'scroll';
    case 'switchTab': return 'switch to ' + (step.title || hostOf(step.url));
    case 'screenshot': return 'screenshot (skipped)';
    default: return step.type;
  }
}

function broadcastAbort() {
  return chrome.tabs.query({}).then(function (tabs) {
    return Promise.all(tabs.map(function (t) {
      return sendToTab(t.id, { cmd: 'abort' }).catch(function () { return null; });
    }));
  }).catch(function () { return null; });
}

/* Why a repeat step stopped is the most useful thing the run produces, so the
 * reasons are collected and folded into the closing message instead of being
 * overwritten by it. */
function addRunNote(text) {
  return chrome.storage.session.get('runNotes').then(function (d) {
    var notes = Array.isArray(d.runNotes) ? d.runNotes : [];
    notes.push(text);
    return chrome.storage.session.set({ runNotes: notes.slice(-8) });
  }).catch(function () { return null; });
}

function endPlayback(text, kind) {
  return chrome.storage.session.get('runNotes').then(function (d) {
    var notes = Array.isArray(d.runNotes) ? d.runNotes : [];
    var full = notes.length ? text + '\n' + notes.join('\n') : text;
    var level = kind || 'info';
    if (level !== 'error' && notes.some(function (n) {
      return /not having an effect|No more matching|Stopped by you|same site only|opened a new tab|password|passed over|pop-up/.test(n);
    })) {
      level = 'warn';
    }
    return chrome.storage.session.set({ play: null, runNotes: [] })
      .then(function () { return chrome.storage.local.set({ mode: 'idle' }); })
      .then(function () { return notice(full, level); });
  });
}

function sleepInterruptible(ms) {
  var end = Date.now() + ms;
  return (function step() {
    var left = end - Date.now();
    if (left <= 0) return Promise.resolve(true);
    return sleep(Math.min(250, left)).then(function () {
      return getPlay().then(function (p) {
        if (!p || !p.running) return false;
        return step();
      });
    });
  })();
}

/* A loose tab match is exactly the kind of thing that quietly makes a replay do
 * the wrong thing, so it is recorded for the closing summary rather than only
 * flashing past in the status line. Once per tab and level, not once per step. */
function noteMatchLevel(step, index, level) {
  if (level === 'exact') return Promise.resolve(null);
  var key = level + '|' + step.url;
  return chrome.storage.session.get('notedTabs').then(function (d) {
    var noted = d.notedTabs || {};
    if (noted[key]) return null;
    noted[key] = true;
    return chrome.storage.session.set({ notedTabs: noted }).then(function () {
      return addRunNote('Step ' + (index + 1) + ': tab matched by ' +
                        (MATCH_LEVEL_TEXT[level] || level) + ' — "' +
                        (step.title || hostOf(step.url)) + '".');
    });
  }).catch(function () { return null; });
}

function runOneStep(step, index) {
  return resolveTab(step.url, step.title).then(function (resolved) {
    return noteMatchLevel(step, index, resolved.level).then(function () {
      return setPlay({ matchLevel: MATCH_LEVEL_TEXT[resolved.level] || resolved.level });
    }).then(function () {
      if (step.type === 'switchTab') return { ok: true };
      return ensureContentScript(resolved.tabId).then(function () {
        return sendToTab(resolved.tabId, {
          cmd: 'playStep', step: step,
          timeoutMs: step.__passFollower === 'strict' ? FOLLOWER_STRICT_MS
                   : step.__passFollower === 'lenient' ? FOLLOWER_TIMEOUT_MS : 0
        }).then(function (out) {
          if (!out) return { ok: false, error: 'the page did not answer' };
          if (out.ok === false) return { ok: false, error: out.error };
          if (out.needsUser === 'password') {
            return addRunNote('Step ' + (index + 1) + ': the password box was focused but not filled in - ' +
                              'passwords are never saved into a recording, so type it yourself.')
              .then(function () { return { ok: true }; });
          }
          return { ok: true };
        }).catch(function (e) {
          return { ok: false, error: errText(e) };
        });
      });
    });
  });
}

/* One step of a repeat pass, run the ordinary way but with any repeat setting
 * stripped so a pass can never nest inside itself. */
function runFollowerStep(step, index, strict) {
  if (step.type === 'screenshot') return Promise.resolve({ ok: true, skipped: true });
  return runOneStep(Object.assign({}, step, {
    repeat: null,
    __passFollower: strict ? 'strict' : 'lenient'
  }), index).catch(function (e) { return { ok: false, error: errText(e) }; });
}

/* Repeat mode drives from here rather than from the page, because a pass can
 * span several recorded steps - click a row, accept in the dialog it opens,
 * press next - and only this side knows what those steps are. The page is
 * asked for one thing at a time: which element to click next, and whether
 * scrolling revealed any more. Element references are never held across
 * rounds; every round re-queries the live page. */
function runRepeatPass(step, index, steps, tabId) {
  var cfg = normalizeRepeat(step.repeat);
  var groupSize = groupSizeFor(step, index, steps.length);
  var followers = steps.slice(index + 1, index + groupSize);

  var rounds = 0;
  var rescues = 0;
  var stall = 0;
  var lastCount = -1;
  var handled = [];
  var useSignatures = false;
  var previous = null;      /* what was clicked last round, and how it looked */
  var noEffect = 0;
  var missedPasses = 0;
  var skippedFollowers = 0;
  var pageTurns = 0;
  var passedOver = [];      /* rows given up on because a step was not there */
  var sameRun = 0;          /* how many rows running the same pop-up has come up on */
  var lastPopup = null;
  var previousPassedOver = false;
  var tabTitle = '';        /* which tab the pass is running on, for the summary */
  var lastLabel = '';       /* what the last round clicked, for the summary */
  var healedUsed = '';      /* the widened pattern, when the recorded one found nothing */
  /* Scrolling to load more is the right first guess on an endless list, but
   * where a next-page control was recorded the page is paged, not endless -
   * one scroll that reveals nothing settles it, and the rest would be six
   * seconds of nothing on every page. A scroll that does reveal rows still
   * resets the count, so an endless list inside a paged one keeps working. */
  var scrollBudget = cfg.nextPage ? 1 : RESCUE_LIMIT;

  function finish(reason) {
    var text = 'Step ' + (index + 1) + ' (repeat): ' + reason;
    if (skippedFollowers) {
      text += ' ' + skippedFollowers + ' follow-on step(s) were skipped because the element ' +
              'was not on the page that round.';
    }
    if (passedOver.length) text += ' ' + passedOverText();
    return addRunNote(text)
      .then(function () { return notice(text, 'info'); })
      .then(function () { return { ok: true }; });
  }

  /* Which pop-up this was, for telling one from another: its heading with the
   * numbers taken out, so "3 invitations left" and "2 invitations left" count
   * as the same box. */
  function popupKey(heading) {
    return String(heading == null ? '' : heading).toLowerCase().replace(/\d+/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  /* Which rows were given up on, and why, is the part of the summary that
   * tells the user what their list is actually like. */
  function passedOverText() {
    var groups = {};
    var order = [];
    var plain = 0;
    passedOver.forEach(function (p) {
      if (!p.hadDialog) { plain += 1; return; }
      var k = popupKey(p.heading);
      if (!groups[k]) {
        groups[k] = { heading: p.heading || 'an untitled pop-up', how: p.how, n: 0 };
        order.push(k);
      }
      groups[k].n += 1;
    });
    var bits = [];
    if (order.length) {
      var parts = order.slice(0, 3).map(function (k) {
        var g = groups[k];
        return '"' + clip(g.heading, 60) + '"' + (g.n > 1 ? ' x' + g.n : '') +
               (g.how ? ' (' + g.how + ')' : '');
      });
      if (order.length > 3) parts.push('and ' + (order.length - 3) + ' more');
      bits.push((passedOver.length - plain) + ' row(s) were passed over because a different ' +
                'pop-up came up and was closed: ' + parts.join(', ') + '.');
    }
    if (plain) bits.push(plain + ' row(s) were passed over because a step was simply not there.');
    return bits.join(' ');
  }

  function stillRunning() {
    return getPlay().then(function (p) { return !!(p && p.running); });
  }

  function ask(message) {
    return sendToTab(tabId, message).catch(function (e) {
      return { ok: false, error: errText(e) };
    });
  }

  /* "Clicks are not having an effect" is the message people see most when a
   * run goes wrong, so it says what was clicked, where, and what that usually
   * means, rather than leaving them to guess. */
  function stallText() {
    var what = lastLabel ? '"' + clip(lastLabel, 40) + '"' : 'the matching element';
    var text = 'Clicks are not having an effect — stopped after ' + rounds + ' rounds. Each round clicked ' +
               what + (tabTitle ? ' on the tab "' + clip(tabTitle, 40) + '"' : '') +
               (followers.length
                 ? ' and then ran the ' + followers.length + ' step' + (followers.length === 1 ? '' : 's') +
                   ' after it'
                 : '') +
               ', and the element looked exactly the same afterwards. That happens when the page ignores ' +
               'simulated clicks, when the pop-up the next step needs did not open, or when the run is on ' +
               'a different tab from the one you are looking at.';
    if (healedUsed) {
      text += ' The match pattern found nothing as written and was widened to ' + healedUsed + '.';
    }
    return text;
  }

  /* The recorded pattern found nothing, but the same identity on another
   * kind of control did: say so once, because the page has changed since the
   * recording and the user should know to re-record the step. */
  function noteHealed(used) {
    if (!used || healedUsed) return Promise.resolve(null);
    healedUsed = used;
    return addRunNote('Step ' + (index + 1) + ': the match pattern found nothing as written (' + cfg.pattern +
                      '), but the same identity on other controls did (' + used + '), so the run used that. ' +
                      'The page has changed since this was recorded - re-record the first step of the block ' +
                      'to make the pattern exact again.');
  }

  /* Whether the matches can be told apart decides how the loop knows it is
   * making progress: distinguishable elements are tracked individually, and
   * anything else falls back to watching the pool shrink. */
  function probe() {
    return chrome.tabs.get(tabId).then(function (t) {
      tabTitle = (t && (t.title || hostOf(t.url))) || '';
    }).catch(function () { tabTitle = ''; }).then(function () {
      return ask({ cmd: 'repeatProbe', pattern: cfg.pattern });
    }).then(function (out) {
      if (!out || out.ok === false) {
        return { ok: false, error: (out && out.error) || 'the page did not answer' };
      }
      useSignatures = !!out.distinct;
      return noteHealed(out.healed).then(function () { return { ok: true }; });
    });
  }

  function runFollowers(i) {
    if (i >= followers.length) return Promise.resolve({ ok: true });
    return stillRunning().then(function (running) {
      if (!running) return { ok: true, stopped: true };
      var follower = followers[i];
      var strict = cfg.onMissing === 'stop';
      return runFollowerStep(follower, index + 1 + i, strict).then(function (res) {
        if (res && res.ok === false) {
          if (cfg.onMissing === 'dismiss') return giveUpOnRow(index + 2 + i);
          if (strict) {
            /* The pass did not finish, so the action it was doing did not
             * happen either. Moving to the next element from here would leave
             * this one half-done and, if a dialog is still up, click the next
             * rows into a covered page. */
            return { ok: false, missedStep: index + 2 + i, error: res.error };
          }
          skippedFollowers += 1;
          return { ok: true, missed: true };
        }
        return { ok: true, missed: false };
      }).then(function (res) {
        if (res.ok === false || res.stopped || res.passedOver) return res;
        return runFollowers(i + 1).then(function (rest) {
          return Object.assign({}, rest, { missed: res.missed || rest.missed });
        });
      });
    });
  }

  /* The step is not there. On a list that usually means the click brought up
   * something other than the pop-up the pass was recorded against - a box
   * that insists on a note, a notice that a limit was reached - so close
   * whatever is in the way and give this one row up rather than the run. */
  function giveUpOnRow(stepNumber) {
    return ask({ cmd: 'repeatDismiss', pattern: cfg.pattern, control: cfg.dismiss }).then(function (d) {
      if (!d || d.ok === false) {
        return { ok: false, missedStep: stepNumber, error: (d && d.error) || 'the page did not answer' };
      }
      if (d.hadDialog && !d.dismissed) {
        return { ok: false, missedStep: stepNumber,
                 error: 'was not there, and the pop-up in the way ("' + clip(d.heading, 60) +
                        '") could not be closed' };
      }
      return { ok: true, passedOver: true, hadDialog: !!d.hadDialog,
               heading: d.hadDialog ? String(d.heading || '') : '',
               how: d.hadDialog ? String(d.how || '') : '' };
    });
  }

  /* This row was given up on. Note what came up, watch for the same thing
   * coming up on every row, and make sure the loop can actually get past it. */
  function rowGivenUp(res, countBefore) {
    passedOver.push({ hadDialog: res.hadDialog, heading: res.heading, how: res.how });
    previousPassedOver = true;
    var key = res.hadDialog ? popupKey(res.heading) : null;
    if (key !== null && key === lastPopup) sameRun += 1;
    else sameRun = key !== null ? 1 : 0;
    lastPopup = key;
    if (key !== null && sameRun >= DISMISS_SAME_LIMIT) {
      return finish('The same pop-up ("' + clip(res.heading, 60) + '") came up on ' + sameRun +
                    ' rows in a row, so it is about the page or the account rather than any one ' +
                    'row - stopped after ' + rounds + ' pass(es).');
    }
    var note = res.hadDialog
      ? 'a different pop-up came up ("' + clip(res.heading, 40) + '") - closed it, moving on'
      : 'a step was not there on this row - moving on';
    return setPlay({ repeatNote: note }).then(function () {
      if (useSignatures) return afterPass();
      /* Without a way to tell the rows apart, this row is still the first
       * match, and the next round would click it again and get the same
       * pop-up, round after round. Only carry on if it has gone. */
      return ask({ cmd: 'repeatProbe', pattern: cfg.pattern }).then(function (p) {
        if (p && p.ok !== false && typeof p.count === 'number' && p.count < countBefore) return afterPass();
        return finish('A row was given up on, but the matches on this page cannot be told apart ' +
                      '(no aria-label, id or name), so the loop cannot move past it - stopped ' +
                      'after ' + rounds + ' pass(es).');
      });
    });
  }

  /* Only move on once whatever this pass opened has gone away again. */
  function afterPass() {
    return ask({ cmd: 'repeatSettle', pattern: cfg.pattern, timeoutMs: SETTLE_TIMEOUT_MS })
      .then(function (s) {
        if (s && s.ok !== false && s.settled === false) {
          return finish('A dialog was still open ' + Math.round(SETTLE_TIMEOUT_MS / 1000) +
                        ' seconds after pass ' + rounds + ' finished, so the next one would ' +
                        'have clicked into a covered page. Stopped after ' + rounds + ' pass(es).');
        }
        return sleepInterruptible(cfg.delayMs).then(function (running2) {
          if (!running2) return finish('Stopped by you after ' + rounds + ' pass(es).');
          return round();
        });
      });
  }

  /* The list on this page is finished. With a next-page control recorded, press
   * it and carry on there; without one, this is the end of the run. The round
   * count and the delay between clicks keep applying across pages, so the
   * safety limits still bound the whole thing. */
  function turnPage() {
    if (!cfg.nextPage) {
      return finish('No more matching elements (after ' + rescues +
                    ' scroll-to-load attempts) - stopped after ' + rounds + ' pass(es).');
    }
    if (pageTurns >= PAGE_TURN_LIMIT) {
      return finish('Reached the limit of ' + PAGE_TURN_LIMIT + ' page turns - stopped after ' +
                    rounds + ' pass(es).');
    }
    pageTurns += 1;
    return setPlay({ repeatNote: 'this page is done - going to the next one (turn ' + pageTurns + ')' })
      .then(function () {
        return ask({ cmd: 'playStep', step: cfg.nextPage, timeoutMs: FOLLOWER_STRICT_MS });
      })
      .then(function (res) {
        if (!res || res.ok === false) {
          return finish('This page is done and the next-page control could not be used (' +
                        ((res && res.error) || 'no answer from the page') +
                        ') - stopped after ' + rounds + ' pass(es).');
        }
        return awaitNextPage();
      });
  }

  /* A page turn is not instant and the new rows arrive when they arrive, so
   * wait for the pattern to find something rather than guessing at a delay. */
  function awaitNextPage() {
    var end = Date.now() + PAGE_LOAD_TIMEOUT_MS;
    function look() {
      return stillRunning().then(function (running) {
        if (!running) return finish('Stopped by you after ' + rounds + ' pass(es).');
        return ask({ cmd: 'repeatProbe', pattern: cfg.pattern }).then(function (probe) {
          if (probe && probe.ok !== false && probe.count > 0) {
            /* Everything the counters know is about the page just left. */
            rescues = 0;
            stall = 0;
            lastCount = -1;
            noEffect = 0;
            return round();
          }
          if (Date.now() >= end) {
            return finish('Turned the page ' + pageTurns + ' time(s), and nothing matching turned ' +
                          'up on the last one - stopped after ' + rounds + ' pass(es).');
          }
          return sleep(400).then(look);
        });
      });
    }
    return look();
  }

  function round() {
    return stillRunning().then(function (running) {
      if (!running) return finish('Stopped by you after ' + rounds + ' pass(es).');
      if (rounds >= cfg.maxRepeats) {
        return finish('Reached the limit of ' + cfg.maxRepeats + ' repeats.');
      }

      return ask({
        cmd: 'repeatClickNext', pattern: cfg.pattern,
        handled: handled, useSignatures: useSignatures, previous: previous
      }).then(function (out) {
        if (!out || out.ok === false) {
          return { ok: false, error: (out && out.error) || 'the page did not answer' };
        }

        /* Two ways to notice that the page is simply ignoring the clicks.
         * With distinguishable elements the pool legitimately stays the same
         * size (a handled row is still there, just changed), so the signal is
         * that the element clicked last round has not changed one bit. This is
         * checked before the "nothing left" branch, because having clicked
         * every match and changed none of them is a page ignoring clicks, not
         * a list that ran out. */
        if (useSignatures) {
          /* A pop-up that had to be closed is proof the click did something,
           * even though the row it was on looks exactly as it did. */
          if (out.previousUnchanged && !previousPassedOver) noEffect += 1;
          else noEffect = 0;
          if (noEffect >= STALL_LIMIT) return finish(stallText());
        }
        if (out.label) lastLabel = out.label;
        if (out.healed && !healedUsed) noteHealed(out.healed);

        if (!out.clicked) {
          if (rescues >= scrollBudget) return turnPage();
          rescues += 1;
          var before = out.countBefore;
          return setPlay({
            repeatNote: 'nothing left in view - scrolling down to load more (attempt ' +
                        rescues + ' of ' + scrollBudget + ')'
          }).then(function () {
            return ask({ cmd: 'repeatRescue', pattern: cfg.pattern });
          }).then(function (res) {
            /* A scroll that actually pulled in more rows is progress, not an
             * attempt against the limit. The limit is there to stop fruitless
             * scrolling at the end of a list; a long list can legitimately
             * need loading many times over, and counting those would cut the
             * run short in the middle of a list that is still growing. */
            if (res && res.ok !== false && typeof res.count === 'number' &&
                res.count > before) {
              rescues = 0;
            }
            lastCount = -1;
            stall = 0;
            return round();
          });
        }

        /* Without distinguishable elements, a pool that never shrinks is the
         * only evidence available. */
        if (!useSignatures) {
          if (lastCount >= 0 && out.countBefore >= lastCount) stall += 1;
          else stall = 0;
          lastCount = out.countBefore;
          if (stall >= STALL_LIMIT) return finish(stallText());
        }

        rounds += 1;
        if (out.signature) handled.push(out.signature);
        previous = out.signature ? { signature: out.signature, state: out.state } : null;

        return setPlay({
          repeatCount: rounds, repeatMax: cfg.maxRepeats,
          repeatRemaining: Math.max(0, out.countBefore - 1), repeatNote: ''
        }).then(function () {
          return runFollowers(0);
        }).then(function (res) {
          if (res.stopped) return finish('Stopped by you after ' + rounds + ' pass(es).');
          if (res.ok === false) {
            return finish('Pass ' + rounds + ' could not finish - step ' + res.missedStep +
                          ' (' + shortLabel(steps[res.missedStep - 1] || {}) + ') ' + res.error +
                          '. Stopped rather than leaving that one half-done and carrying on. ' +
                          'Give the page longer, check that step\'s target, or set "If a step is ' +
                          'missing" to close the pop-up and move on if the click sometimes brings ' +
                          'up something else.');
          }
          if (res.passedOver) return rowGivenUp(res, out.countBefore);
          previousPassedOver = false;
          sameRun = 0;
          lastPopup = null;
          if (followers.length) {
            /* Every follow-on step missing, pass after pass, means the flow has
             * broken rather than that one row was unusual. */
            if (res.missed && skippedFollowers >= followers.length * STALL_LIMIT) missedPasses += 1;
            else if (!res.missed) missedPasses = 0;
            if (missedPasses >= STALL_LIMIT) {
              return finish('The follow-on steps stopped being found — the page is no longer ' +
                            'behaving the way it did when you recorded. Stopped after ' + rounds + ' passes.');
            }
          }
          return afterPass();
        });
      });
    });
  }

  return setPlay({ repeatMax: cfg.maxRepeats, repeatCount: 0, repeatNote: '' })
    .then(probe)
    .then(function (p) {
      if (p.ok === false) return p;
      return round();
    });
}

function playLoop() {
  return getLocal('steps').then(function (d) {
    var steps = Array.isArray(d.steps) ? d.steps : [];

    function next() {
      return getPlay().then(function (play) {
        if (!play || !play.running) {
          return endPlayback('Playback stopped.', 'info');
        }
        var i = (typeof play.doneIndex === 'number' ? play.doneIndex : -1) + 1;
        if (i >= steps.length) {
          return endPlayback('Playback finished - all ' + steps.length + ' steps done.', 'ok');
        }
        var step = steps[i];

        return setPlay({
          index: i,
          total: steps.length,
          label: shortLabel(step),
          repeatCount: 0,
          repeatMax: 0,
          repeatNote: '',
          matchLevel: ''
        }).then(function () {
          /* Screenshots are reference images, not actions. */
          if (step.type === 'screenshot') return { ok: true, skipped: true };
          if (isRepeatOn(step)) {
            /* The pass owns this step and the ones it loops over, so it brings
             * the tab forward itself and then drives the whole group. */
            return resolveTab(step.url, step.title).then(function (resolved) {
              return noteMatchLevel(step, i, resolved.level)
                .then(function () {
                  return setPlay({ matchLevel: MATCH_LEVEL_TEXT[resolved.level] || resolved.level });
                })
                .then(function () { return ensureContentScript(resolved.tabId); })
                .then(function () { return runRepeatPass(step, i, steps, resolved.tabId); });
            }).catch(function (e) {
              return { ok: false, error: errText(e) };
            });
          }
          return runOneStep(step, i).catch(function (e) {
            return { ok: false, error: errText(e) };
          });
        }).then(function (result) {
          if (result && result.ok === false) {
            return endPlayback(
              'Stopped at step ' + (i + 1) + ' of ' + steps.length + ' (' + shortLabel(step) + ') on tab "' +
              (step.title || hostOf(step.url)) + '": ' + result.error + '.', 'error');
          }
          /* A repeat pass consumes the steps it loops over, so they must not
           * then run again on their own afterwards. */
          var last = isRepeatOn(step) ? i + groupSizeFor(step, i, steps.length) - 1 : i;
          return setPlay({ doneIndex: last }).then(function () {
            var following = steps[last + 1];
            if (!following) return next();
            var from = steps[last] || step;
            var gap = clamp((following.timestamp || 0) - (from.timestamp || 0), GAP_MIN_MS, GAP_MAX_MS);
            return sleepInterruptible(gap).then(function (stillRunning) {
              if (!stillRunning) return endPlayback('Playback stopped.', 'info');
              return next();
            });
          });
        });
      });
    }

    return next();
  });
}

function drive() {
  if (driving) return Promise.resolve();
  driving = true;
  return playLoop().catch(function (e) {
    return endPlayback('Playback failed: ' + errText(e) + '.', 'error');
  }).then(function () {
    driving = false;
  }, function () {
    driving = false;
  });
}

function startPlayback() {
  return getLocal('steps').then(function (d) {
    var steps = Array.isArray(d.steps) ? d.steps : [];
    if (!steps.length) {
      return notice('Nothing to play yet - record some steps first.', 'warn')
        .then(function () { return { ok: false, error: 'The recording is empty.' }; });
    }
    var bad = null;
    steps.forEach(function (s, i) {
      if (bad || !s.repeat || !s.repeat.enabled) return;
      var pattern = String(s.repeat.pattern || '').trim();
      /* Without this the step would quietly fall through to a single ordinary
       * click, which is not what a switched-on Repeat toggle promises. */
      if (!pattern) {
        bad = 'Step ' + (i + 1) + ' has Repeat switched on but no match pattern. ' +
              'Type a pattern in that step\'s "Match pattern" box, or switch Repeat off ' +
              'to click just the one element.';
        return;
      }
      if (/:nth-(of-type|child|last-child|last-of-type)\b/i.test(pattern)) {
        bad = 'Step ' + (i + 1) + ' uses a position-based match pattern (nth-of-type / nth-child). ' +
              'Those cannot be used for repeats because the list shifts after every click - ' +
              'edit the pattern to use an attribute or :text("...") instead.';
        return;
      }
      /* Two overlapping passes would mean one loop running inside another,
       * which is not something this tool does. */
      var last = i + groupSizeFor(s, i, steps.length) - 1;
      for (var j = i + 1; j <= last; j++) {
        if (steps[j] && steps[j].repeat && steps[j].repeat.enabled) {
          bad = 'Step ' + (i + 1) + ' repeats a pass that runs through step ' + (last + 1) +
                ', but step ' + (j + 1) + ' has Repeat switched on too. Switch Repeat off on ' +
                'step ' + (j + 1) + ', or shorten the pass on step ' + (i + 1) + '.';
          return;
        }
      }
    });
    if (bad) {
      return notice(bad, 'error').then(function () { return { ok: false, error: bad }; });
    }
    return chrome.storage.local.set({ mode: 'playing' })
      .then(function () {
        return chrome.storage.session.set({
          runNotes: [],
          notedTabs: {},
          play: {
            running: true, index: 0, doneIndex: -1, total: steps.length,
            label: 'Starting...', repeatCount: 0, repeatMax: 0, repeatNote: '', matchLevel: ''
          }
        });
      })
      .then(function () { return notice('', 'info'); })
      .then(function () {
        drive();
        return { ok: true };
      });
  });
}

function stopPlayback() {
  return setPlay({ running: false })
    .then(broadcastAbort)
    .then(function () { return chrome.storage.local.set({ mode: 'idle' }); })
    .then(function () { return notice('Playback stopped.', 'info'); });
}

/* If the worker was shut down mid-run, waking it up continues from the last
 * completed step rather than repeating one that already ran. */
getPlay().then(function (play) {
  if (!play || !play.running) return null;
  return getLocal('mode').then(function (d) {
    if (d.mode !== 'playing') return null;
    return drive();
  });
}).catch(function () {});

/* ------------------------------------------------------------- screenshots */

function takeScreenshot() {
  return getLocal('mode').then(function (d) {
    if (d.mode !== 'recording') {
      return { ok: false, error: 'Screenshots can only be added while recording.' };
    }
    return getActiveTab().then(function (tab) {
      if (!tab) return { ok: false, error: 'No active tab to capture.' };
      var block = injectionBlockReason(tab.url);
      if (block) return { ok: false, error: 'Chrome will not let this page be captured (' + block + ').' };
      return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 })
        .then(function (dataUrl) {
          return appendStep({
            id: uid(),
            type: 'screenshot',
            selector: '', tagName: '', ariaLabel: '', fallbackText: '', value: '',
            attrs: {},
            dataUrl: dataUrl,
            url: tab.url,
            title: tab.title || hostOf(tab.url),
            timestamp: Date.now(),
            repeat: null
          }, null).then(function () { return { ok: true }; });
        })
        .catch(function (e) {
          return { ok: false, error: 'Could not take the screenshot: ' + errText(e) + '.' };
        });
    });
  });
}

/* ----------------------------------------------------------------- library */

/* Saved recordings. The working recording stays in `steps`, exactly as it
 * always has; a saved one is a snapshot of it kept under a name, so a second
 * job can be recorded without losing the first. The index under `library`
 * holds only what the list needs to draw itself - name, size, when - and each
 * body lives under its own `rec:<id>` key, so opening the panel never has to
 * read every screenshot ever saved just to show the names. `loadedFrom` says
 * which saved recording the working steps came from, if any. */

var STEP_TYPES = { click: 1, input: 1, change: 1, key: 1, scroll: 1, switchTab: 1, screenshot: 1 };
var LIBRARY_NAME_MAX = 80;
var IMPORT_STEP_LIMIT = 500;

function libraryKey(id) {
  return 'rec:' + id;
}

function getLibrary() {
  return getLocal('library').then(function (d) {
    return Array.isArray(d.library) ? d.library : [];
  });
}

function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, LIBRARY_NAME_MAX);
}

function sameName(a, b) {
  return cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
}

function libraryIndexOf(library, id) {
  for (var i = 0; i < library.length; i++) if (library[i].id === id) return i;
  return -1;
}

function roughBytes(value) {
  try { return JSON.stringify(value).length; } catch (e) { return 0; }
}

function indexEntry(body) {
  return {
    id: body.id,
    name: body.name,
    savedAt: body.savedAt,
    stepCount: body.steps.length,
    loops: body.steps.some(function (s) { return !!(s && s.repeat && s.repeat.enabled); }),
    bytes: roughBytes(body.steps)
  };
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/* Save the working recording under a name. With an id, that entry is replaced
 * whatever it was called; without one, a name already in use replaces that
 * entry (the panel asks for a second press before sending such a save) and a
 * new name makes a new entry. */
function librarySave(name, id) {
  var clean = cleanName(name);
  if (!clean) return Promise.resolve({ ok: false, error: 'Give the recording a name first.' });
  return serialize(function () {
    return Promise.all([getLocal(['mode', 'steps']), getLibrary()]).then(function (r) {
      if (r[0].mode !== 'idle') return { ok: false, error: 'Stop recording or playback before saving.' };
      var steps = Array.isArray(r[0].steps) ? r[0].steps : [];
      if (!steps.length) return { ok: false, error: 'There is nothing to save yet - record some steps first.' };
      var library = r[1];
      var at = id ? libraryIndexOf(library, id) : -1;
      if (at < 0) {
        for (var j = 0; j < library.length; j++) if (sameName(library[j].name, clean)) { at = j; break; }
      }
      var entryId = at >= 0 ? library[at].id : uid();
      var body = { id: entryId, name: clean, savedAt: Date.now(), steps: steps };
      var next = library.slice();
      if (at >= 0) next[at] = indexEntry(body); else next.push(indexEntry(body));
      var patch = { library: next, loadedFrom: { id: entryId, name: clean } };
      patch[libraryKey(entryId)] = body;
      return chrome.storage.local.set(patch).then(function () {
        return notice((at >= 0 ? 'Updated' : 'Saved') + ' "' + clean + '" (' + plural(steps.length, 'step') + ').', 'ok');
      }).then(function () {
        return { ok: true, id: entryId, replaced: at >= 0 };
      }).catch(function (e) {
        return { ok: false, error: 'Could not save "' + clean + '": ' + errText(e) + '.' };
      });
    });
  });
}

/* Put a saved recording into the working slot. The panel keeps what was there
 * and offers an Undo, the same way it does for a deleted step. */
function libraryLoad(id) {
  return serialize(function () {
    return getLocal(['mode', libraryKey(id)]).then(function (d) {
      if (d.mode !== 'idle') return { ok: false, error: 'Stop recording or playback before loading a recording.' };
      var body = d[libraryKey(id)];
      if (!body || !Array.isArray(body.steps)) {
        return { ok: false, error: 'That saved recording is missing - it may have been deleted.' };
      }
      return chrome.storage.local.set({
        steps: body.steps,
        skipped: [],
        loadedFrom: { id: body.id, name: body.name }
      }).then(function () {
        return { ok: true, name: body.name, count: body.steps.length };
      }).catch(function (e) {
        return { ok: false, error: 'Could not load "' + body.name + '": ' + errText(e) + '.' };
      });
    });
  });
}

function libraryDelete(id) {
  return serialize(function () {
    return Promise.all([getLibrary(), getLocal('loadedFrom')]).then(function (r) {
      var library = r[0];
      var at = libraryIndexOf(library, id);
      if (at < 0) return { ok: true };
      var gone = library[at];
      var next = library.slice();
      next.splice(at, 1);
      var patch = { library: next };
      /* The working steps stay as they are; they just no longer belong to a
       * saved recording. */
      if (r[1].loadedFrom && r[1].loadedFrom.id === id) patch.loadedFrom = null;
      return chrome.storage.local.set(patch)
        .then(function () { return chrome.storage.local.remove(libraryKey(id)); })
        .then(function () { return notice('Deleted "' + gone.name + '" from the saved recordings.', 'info'); })
        .then(function () { return { ok: true }; });
    });
  });
}

function libraryRename(id, name) {
  var clean = cleanName(name);
  if (!clean) return Promise.resolve({ ok: false, error: 'A saved recording needs a name.' });
  return serialize(function () {
    return Promise.all([getLibrary(), getLocal([libraryKey(id), 'loadedFrom'])]).then(function (r) {
      var library = r[0];
      var at = libraryIndexOf(library, id);
      var body = r[1][libraryKey(id)];
      if (at < 0 || !body) return { ok: false, error: 'That saved recording is missing - it may have been deleted.' };
      for (var k = 0; k < library.length; k++) {
        if (k !== at && sameName(library[k].name, clean)) {
          return { ok: false, error: 'There is already a saved recording called "' + library[k].name + '".' };
        }
      }
      var next = library.slice();
      next[at] = Object.assign({}, next[at], { name: clean });
      var patch = { library: next };
      patch[libraryKey(id)] = Object.assign({}, body, { name: clean });
      if (r[1].loadedFrom && r[1].loadedFrom.id === id) patch.loadedFrom = { id: id, name: clean };
      return chrome.storage.local.set(patch).then(function () { return { ok: true, name: clean }; });
    });
  });
}

function libraryExport(id) {
  return getLocal(libraryKey(id)).then(function (d) {
    var body = d[libraryKey(id)];
    if (!body || !Array.isArray(body.steps)) {
      return { ok: false, error: 'That saved recording is missing - it may have been deleted.' };
    }
    return { ok: true, name: body.name, savedAt: body.savedAt, steps: body.steps };
  });
}

/* ---- import: a file is not to be trusted the way the extension's own
 *      storage is, so only the fields the player knows are kept, every one
 *      of them coerced to the shape it expects. */

function cleanText(value, max) {
  var s = typeof value === 'string' ? value : (value == null ? '' : String(value));
  return max && s.length > max ? s.slice(0, max) : s;
}

function cleanAttrs(a) {
  a = a && typeof a === 'object' ? a : {};
  return {
    id: cleanText(a.id, 200),
    testId: cleanText(a.testId, 200),
    name: cleanText(a.name, 200),
    type: cleanText(a.type, 40)
  };
}

function cleanControl(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    type: 'click',
    selector: cleanText(c.selector, 2000),
    tagName: cleanText(c.tagName, 40).toLowerCase(),
    ariaLabel: cleanText(c.ariaLabel, 500),
    fallbackText: cleanText(c.fallbackText, 500),
    value: '',
    attrs: cleanAttrs(c.attrs)
  };
}

function cleanRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  var out = {
    enabled: !!r.enabled,
    pattern: cleanText(r.pattern, 2000),
    maxRepeats: Math.round(clamp(r.maxRepeats == null ? DEFAULT_MAX_REPEATS : r.maxRepeats, 1, MAX_REPEATS_CEILING)),
    delaySeconds: clamp(r.delaySeconds == null ? DEFAULT_DELAY_SECONDS : r.delaySeconds, DELAY_FLOOR_MS / 1000, 600),
    onMissing: r.onMissing === 'skip' ? 'skip' : r.onMissing === 'dismiss' ? 'dismiss' : 'stop',
    nextPage: cleanControl(r.nextPage),
    dismiss: cleanControl(r.dismiss)
  };
  if (r.groupSize > 0) out.groupSize = Math.round(clamp(r.groupSize, 1, 50));
  return out;
}

function sanitizeSteps(raw) {
  var list = Array.isArray(raw) ? raw : [];
  var out = [];
  for (var i = 0; i < list.length && out.length < IMPORT_STEP_LIMIT; i++) {
    var s = list[i];
    if (!s || typeof s !== 'object' || !STEP_TYPES[s.type]) continue;
    var step = {
      id: uid(),
      type: s.type,
      selector: cleanText(s.selector, 2000),
      tagName: cleanText(s.tagName, 40).toLowerCase(),
      ariaLabel: cleanText(s.ariaLabel, 500),
      fallbackText: cleanText(s.fallbackText, 500),
      value: cleanText(s.value, 20000),
      attrs: cleanAttrs(s.attrs),
      url: cleanText(s.url, 4000),
      title: cleanText(s.title, 500),
      timestamp: isFinite(Number(s.timestamp)) ? Number(s.timestamp) : 0,
      repeat: cleanRepeat(s.repeat),
      coalesceKey: null
    };
    /* Passwords are never stored by this extension, and a file is no place
     * to smuggle one in either. */
    if (step.attrs.type === 'password') step.value = '';
    if (s.set && typeof s.set === 'object' && s.set.size > 0) {
      step.set = {
        size: Math.round(clamp(s.set.size, 1, 50)),
        name: cleanText(s.set.name, 100),
        collapsed: !!s.set.collapsed
      };
    }
    if (typeof s.note === 'string') step.note = cleanText(s.note, 200);
    if (s.type === 'screenshot') {
      if (typeof s.dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(s.dataUrl)) continue;
      step.dataUrl = s.dataUrl;
    }
    out.push(step);
  }
  return out;
}

/* A file becomes a new saved recording, never the working steps, so importing
 * can never cost the user what they have in front of them. */
function libraryImport(name, rawSteps) {
  var steps = sanitizeSteps(rawSteps);
  if (!steps.length) {
    return Promise.resolve({ ok: false, error: 'That file does not contain any steps this extension understands.' });
  }
  return serialize(function () {
    return getLibrary().then(function (library) {
      var base = cleanName(name) || 'Imported recording';
      var clean = base;
      var n = 2;
      while (library.some(function (e) { return sameName(e.name, clean); })) {
        clean = cleanName(base.slice(0, LIBRARY_NAME_MAX - 6) + ' (' + n + ')');
        n += 1;
      }
      var body = { id: uid(), name: clean, savedAt: Date.now(), steps: steps };
      var patch = { library: library.concat([indexEntry(body)]) };
      patch[libraryKey(body.id)] = body;
      return chrome.storage.local.set(patch).then(function () {
        return notice('Imported "' + clean + '" (' + plural(steps.length, 'step') + ') into the saved recordings.', 'ok');
      }).then(function () {
        return { ok: true, id: body.id, name: clean, count: steps.length };
      }).catch(function (e) {
        return { ok: false, error: 'Could not import "' + clean + '": ' + errText(e) + '.' };
      });
    });
  });
}

/* --------------------------------------------------------------- messaging */

function analyzePattern(pattern, text, prefix, signature) {
  if (!String(pattern || '').trim()) {
    return Promise.resolve({ ok: false, error: 'No pattern to analyse.' });
  }
  return getActiveTab().then(function (tab) {
    if (!tab || injectionBlockReason(tab.url)) {
      return { ok: false, error: 'No usable page in the active tab.' };
    }
    return ensureContentScript(tab.id).then(function () {
      return sendToTab(tab.id, { cmd: 'analyzePattern', pattern: pattern, text: text,
                                 prefix: prefix, signature: signature });
    }).then(function (out) {
      return out || { ok: false, error: 'The page did not answer.' };
    }).catch(function (e) {
      return { ok: false, error: errText(e) };
    });
  });
}

function previewPattern(pattern) {
  if (!String(pattern || '').trim()) {
    return Promise.resolve({ ok: false, error: 'Enter a match pattern first.' });
  }
  return getActiveTab().then(function (tab) {
    if (!tab) return { ok: false, error: 'No active tab to check against.' };
    var block = injectionBlockReason(tab.url);
    if (block) return { ok: false, error: 'Open the page you want to check in the active tab (' + block + ').' };
    return ensureContentScript(tab.id)
      .then(function () { return focusTab(tab.id, tab.windowId); })
      .then(function () { return sendToTab(tab.id, { cmd: 'previewPattern', pattern: pattern }); })
      .then(function (out) {
        if (!out) return { ok: false, error: 'The page did not answer.' };
        if (out.ok === false) return out;
        return { ok: true, count: out.count, labels: out.labels, healed: out.healed || '',
                 tabTitle: tab.title || hostOf(tab.url) };
      })
      .catch(function (e) { return { ok: false, error: errText(e) }; });
  });
}

function countMatches(pattern) {
  if (!String(pattern || '').trim()) {
    return Promise.resolve({ ok: false, error: 'Enter a match pattern first.' });
  }
  return getActiveTab().then(function (tab) {
    if (!tab) return { ok: false, error: 'No active tab to test against.' };
    var block = injectionBlockReason(tab.url);
    if (block) {
      return { ok: false, error: 'Open a normal web page in the active tab to test this (' + block + ').' };
    }
    return ensureContentScript(tab.id).then(function () {
      return sendToTab(tab.id, { cmd: 'countMatches', pattern: pattern });
    }).then(function (out) {
      if (!out) return { ok: false, error: 'The page did not answer.' };
      if (out.ok === false) return out;
      /* Everything the page could say about the count goes through, so the
       * panel can explain a zero rather than just show one. */
      return Object.assign({}, out, { ok: true, tabTitle: tab.title || hostOf(tab.url) });
    }).catch(function (e) {
      return { ok: false, error: errText(e) };
    });
  });
}

function updateStep(id, patch) {
  return serialize(function () {
    return getLocal('steps').then(function (d) {
      var steps = Array.isArray(d.steps) ? d.steps : [];
      var found = false;
      steps = steps.map(function (s) {
        if (s.id !== id) return s;
        found = true;
        return Object.assign({}, s, patch);
      });
      if (!found) return { ok: false, error: 'That step is no longer in the recording.' };
      return saveSteps(steps).then(function () { return { ok: true }; });
    });
  });
}

function handleMessage(msg, sender) {
  switch (msg && msg.cmd) {
    case 'getState':
      return Promise.all([
        getLocal(['mode', 'steps', 'notice', 'skipped', 'library', 'loadedFrom']),
        getPlay()
      ]).then(function (r) {
        return { ok: true, local: r[0], play: r[1] };
      });

    case 'startRecording':
      return startRecording().then(function () { return { ok: true }; });

    case 'stopRecording':
      return stopRecording().then(function () { return { ok: true }; });

    case 'startRedo':
      return startRedo(msg.id);

    case 'startNextPage':
      return startCapture(msg.id, 'nextpage');

    case 'cancelNextPage':
      return cancelCapture('nextpage');

    case 'clearNextPage':
      return clearCapture(msg.id, 'nextpage');

    case 'startDismiss':
      return startCapture(msg.id, 'dismiss');

    case 'cancelDismiss':
      return cancelCapture('dismiss');

    case 'clearDismiss':
      return clearCapture(msg.id, 'dismiss');

    case 'cancelRedo':
      return cancelRedo();

    case 'screenshot':
      return takeScreenshot();

    case 'play':
      return startPlayback();

    case 'stopPlayback':
      return stopPlayback().then(function () { return { ok: true }; });

    case 'clear':
      /* Only the working steps go; a saved copy in the library is untouched,
       * which is the whole point of having saved it. */
      return chrome.storage.local.set({ steps: [], skipped: [], loadedFrom: null })
        .then(function () { return notice('Recording cleared.', 'info'); })
        .then(function () { return { ok: true }; });

    case 'deleteStep':
      return serialize(function () {
        return getLocal('steps').then(function (d) {
          var steps = Array.isArray(d.steps) ? d.steps.slice() : [];
          var gone = -1;
          for (var k = 0; k < steps.length; k++) if (steps[k].id === msg.id) { gone = k; break; }
          if (gone < 0) return { ok: true };

          /* A set that covered the deleted step has to shrink with it.
           * Leaving the size alone would silently pull in whatever step slid
           * up into the gap - on a looping set, an extra action on every
           * single pass. */
          for (var i = 0; i < steps.length; i++) {
            if (i === gone) continue;
            var size = rawSetSize(steps[i]);
            if (size < 2) continue;
            if (gone > i && gone < i + size) {
              var shrunk = size - 1;
              var stillLoops = !!(steps[i].repeat && steps[i].repeat.enabled);
              steps[i] = Object.assign({}, steps[i], {
                set: (shrunk < 2 && !stillLoops)
                  ? null
                  : Object.assign({}, steps[i].set || {}, { size: shrunk })
              });
            }
          }
          steps.splice(gone, 1);
          return saveSteps(steps).then(function () { return { ok: true }; });
        });
      });

    case 'setRepeat':
      return updateStep(msg.id, { repeat: msg.repeat || null, needsPattern: false });

    /* The panel rearranges steps - a drag, a move, a block built or taken
     * apart - as one whole-list write, so a set can never be left half
     * updated; it keeps an Undo of its own the same way it does for a delete. */
    case 'setSteps':
      return serialize(function () {
        var arranged = Array.isArray(msg.steps) ? msg.steps : [];
        return saveSteps(arranged)
          /* No notice unless one is asked for: the panel puts up its own,
           * with the Undo on it, and a second one arriving a moment later
           * would paint over it. */
          .then(function () { return msg.note ? notice(msg.note, 'info') : null; })
          .then(function () { return { ok: true }; });
      });

    case 'restoreSteps':
      return serialize(function () {
        var steps = Array.isArray(msg.steps) ? msg.steps : [];
        return saveSteps(steps)
          .then(function () {
            /* Undoing a load puts back which saved recording the steps came
             * from, as well as the steps themselves. */
            if (msg.loadedFrom === undefined) return null;
            return chrome.storage.local.set({ loadedFrom: msg.loadedFrom || null });
          })
          .then(function () { return notice(msg.note || 'Step restored.', 'info'); })
          .then(function () { return { ok: true }; });
      });

    case 'setGroup':
      return updateStep(msg.id, { set: msg.set || null });

    case 'librarySave':
      return librarySave(msg.name, msg.id);

    case 'libraryLoad':
      return libraryLoad(msg.id);

    case 'libraryDelete':
      return libraryDelete(msg.id);

    case 'libraryRename':
      return libraryRename(msg.id, msg.name);

    case 'libraryExport':
      return libraryExport(msg.id);

    case 'libraryImport':
      return libraryImport(msg.name, msg.steps);

    case 'countMatches':
      return countMatches(msg.pattern);

    case 'analyzePattern':
      return analyzePattern(msg.pattern, msg.text, msg.prefix, msg.signature);

    case 'previewPattern':
      return previewPattern(msg.pattern);

    case 'recordStep':
      return getLocal('mode').then(function (d) {
        if (d.mode !== 'recording' && d.mode !== 'redo' && !CAPTURES[d.mode]) {
          return { ok: false, error: 'not recording' };
        }
        var step = msg.step || {};
        step.id = uid();
        /* Tab identity is url + title, tagged here from the real sender. */
        step.url = (sender && sender.tab && sender.tab.url) || step.url || '';
        step.title = (sender && sender.tab && sender.tab.title) || step.title || hostOf(step.url);
        if (!step.repeat) step.repeat = null;
        if (d.mode === 'redo') return applyRedo(step);
        if (CAPTURES[d.mode]) return applyCapture(step, d.mode);
        var key = msg.coalesceKey ? msg.coalesceKey + '@' + step.url : null;
        /* One serialized job, so the "switched to tab" step can never land
         * after the action that provoked it. */
        return serialize(function () {
          return noteTabRaw(sender && sender.tab)
            .then(function () { return appendStepRaw(step, key); });
        }).then(function () { return { ok: true }; });
      });

    case 'repeatProgress':
      return setPlay({
        repeatCount: msg.count,
        repeatMax: msg.max,
        repeatRemaining: msg.remaining,
        repeatNote: msg.note || ''
      }).then(function () { return { ok: true }; });

    case 'keepalive':
      return Promise.resolve({ ok: true });

    default:
      return Promise.resolve({ ok: false, error: 'Unknown request: ' + (msg && msg.cmd) });
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  handleMessage(msg, sender).then(function (r) {
    sendResponse(r || { ok: true });
  }).catch(function (e) {
    sendResponse({ ok: false, error: errText(e) });
  });
  return true;
});
