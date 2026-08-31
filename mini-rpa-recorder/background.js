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
var DEFAULT_GROUP_SIZE = 1;

var MATCH_LEVEL_TEXT = {
  exact: 'exact URL match',
  page: 'same page (query string ignored)',
  site: 'same site only',
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
    return 'the recording is too big to save - delete some screenshot steps or press Clear';
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
    onMissing: r.onMissing === 'skip' ? 'skip' : 'stop'
  };
}

/* How many steps an action set covers: the anchor plus the ones after it.
 * Grouping is deliberately separate from looping now - a set is useful on its
 * own for keeping a sequence together - so the size lives on step.set, with a
 * fallback to where it used to live so older recordings still play. */
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
  getLocal(['mode', 'steps']).then(function (d) {
    var patch = {};
    if (d.mode !== 'recording' && d.mode !== 'playing') patch.mode = 'idle';
    if (!Array.isArray(d.steps)) patch.steps = [];
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
  return chrome.tabs.query({}).then(function (tabs) {
    var usable = tabs.filter(function (t) { return typeof t.id === 'number' && t.id >= 0; });

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

function startRecording() {
  return chrome.storage.local.set({ mode: 'recording', skipped: [] })
    .then(function () { return chrome.storage.session.set({ play: null }); })
    .then(getActiveTab)
    .then(function (active) {
      /* The tab in front when recording starts is the baseline, so the
       * recording does not open with a pointless "switched to" step. */
      return chrome.storage.session.set({ lastTabId: active ? active.id : null });
    })
    .then(function () { return chrome.tabs.query({}); })
    .then(function (tabs) {
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
        return chrome.storage.local.set({ skipped: skipped }).then(function () {
          var msg = 'Recording. Ready on ' + ready + ' tab' + (ready === 1 ? '' : 's') + '.';
          if (skipped.length) {
            msg += ' ' + skipped.length + ' tab' + (skipped.length === 1 ? ' was' : 's were') +
                   ' skipped (listed below).';
          }
          return notice(msg, skipped.length ? 'warn' : 'info');
        });
      });
    });
}

function stopRecording() {
  return getLocal('steps').then(function (d) {
    var n = Array.isArray(d.steps) ? d.steps.length : 0;
    return chrome.storage.local.set({ mode: 'idle' }).then(function () {
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
      return /not having an effect|No more matching|Stopped by you|same site only|opened a new tab|password/.test(n);
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

  function finish(reason) {
    var text = 'Step ' + (index + 1) + ' (repeat): ' + reason;
    if (skippedFollowers) {
      text += ' ' + skippedFollowers + ' follow-on step(s) were skipped because the element ' +
              'was not on the page that round.';
    }
    return addRunNote(text)
      .then(function () { return notice(text, 'info'); })
      .then(function () { return { ok: true }; });
  }

  function stillRunning() {
    return getPlay().then(function (p) { return !!(p && p.running); });
  }

  function ask(message) {
    return sendToTab(tabId, message).catch(function (e) {
      return { ok: false, error: errText(e) };
    });
  }

  /* Whether the matches can be told apart decides how the loop knows it is
   * making progress: distinguishable elements are tracked individually, and
   * anything else falls back to watching the pool shrink. */
  function probe() {
    return ask({ cmd: 'repeatProbe', pattern: cfg.pattern }).then(function (out) {
      if (!out || out.ok === false) {
        return { ok: false, error: (out && out.error) || 'the page did not answer' };
      }
      useSignatures = !!out.distinct;
      return { ok: true };
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
        if (res.ok === false || res.stopped) return res;
        return runFollowers(i + 1).then(function (rest) {
          return { ok: rest.ok, missedStep: rest.missedStep, error: rest.error,
                   stopped: rest.stopped, missed: res.missed || rest.missed };
        });
      });
    });
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
          if (out.previousUnchanged) noEffect += 1;
          else noEffect = 0;
          if (noEffect >= STALL_LIMIT) {
            return finish('Clicks are not having an effect — stopped after ' + rounds + ' rounds.');
          }
        }

        if (!out.clicked) {
          if (rescues >= RESCUE_LIMIT) {
            return finish('No more matching elements (after ' + rescues +
                          ' scroll-to-load attempts) - stopped after ' + rounds + ' pass(es).');
          }
          rescues += 1;
          return setPlay({
            repeatNote: 'nothing left in view - scrolling down to load more (attempt ' +
                        rescues + ' of ' + RESCUE_LIMIT + ')'
          }).then(function () {
            return ask({ cmd: 'repeatRescue', pattern: cfg.pattern });
          }).then(function () {
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
          if (stall >= STALL_LIMIT) {
            return finish('Clicks are not having an effect — stopped after ' + rounds + ' rounds.');
          }
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
                          'missing" to skip it if it is genuinely optional.');
          }
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
          /* Only move on once whatever this pass opened has gone away again. */
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
      .then(function () { return notice('Playing ' + steps.length + ' steps...', 'info'); })
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

/* --------------------------------------------------------------- messaging */

function analyzePattern(pattern, text, prefix) {
  if (!String(pattern || '').trim()) {
    return Promise.resolve({ ok: false, error: 'No pattern to analyse.' });
  }
  return getActiveTab().then(function (tab) {
    if (!tab || injectionBlockReason(tab.url)) {
      return { ok: false, error: 'No usable page in the active tab.' };
    }
    return ensureContentScript(tab.id).then(function () {
      return sendToTab(tab.id, { cmd: 'analyzePattern', pattern: pattern, text: text, prefix: prefix });
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
        return { ok: true, count: out.count, labels: out.labels, tabTitle: tab.title || hostOf(tab.url) };
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
      return { ok: true, count: out.count, tabTitle: tab.title || hostOf(tab.url) };
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
        getLocal(['mode', 'steps', 'notice', 'skipped']),
        getPlay()
      ]).then(function (r) {
        return { ok: true, local: r[0], play: r[1] };
      });

    case 'startRecording':
      return startRecording().then(function () { return { ok: true }; });

    case 'stopRecording':
      return stopRecording().then(function () { return { ok: true }; });

    case 'screenshot':
      return takeScreenshot();

    case 'play':
      return startPlayback();

    case 'stopPlayback':
      return stopPlayback().then(function () { return { ok: true }; });

    case 'clear':
      return chrome.storage.local.set({ steps: [], skipped: [] })
        .then(function () { return notice('Recording cleared.', 'info'); })
        .then(function () { return { ok: true }; });

    case 'deleteStep':
      return serialize(function () {
        return getLocal('steps').then(function (d) {
          var steps = (Array.isArray(d.steps) ? d.steps : []).filter(function (s) { return s.id !== msg.id; });
          return saveSteps(steps).then(function () { return { ok: true }; });
        });
      });

    case 'setRepeat':
      return updateStep(msg.id, { repeat: msg.repeat || null });

    case 'setGroup':
      return updateStep(msg.id, { set: msg.set || null });

    case 'countMatches':
      return countMatches(msg.pattern);

    case 'analyzePattern':
      return analyzePattern(msg.pattern, msg.text, msg.prefix);

    case 'previewPattern':
      return previewPattern(msg.pattern);

    case 'recordStep':
      return getLocal('mode').then(function (d) {
        if (d.mode !== 'recording') return { ok: false, error: 'not recording' };
        var step = msg.step || {};
        step.id = uid();
        /* Tab identity is url + title, tagged here from the real sender. */
        step.url = (sender && sender.tab && sender.tab.url) || step.url || '';
        step.title = (sender && sender.tab && sender.tab.title) || step.title || hostOf(step.url);
        if (!step.repeat) step.repeat = null;
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
