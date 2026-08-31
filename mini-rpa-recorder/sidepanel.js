/* Mini RPA Recorder - side panel logic.
 * Manifest V3 forbids inline JavaScript, so every control on sidepanel.html is
 * wired up here with addEventListener. */

(function () {
  'use strict';

  var DEFAULT_MAX_REPEATS = 25;
  var DEFAULT_DELAY_SECONDS = 2.0;
  var DELAY_FLOOR_SECONDS = 0.5;
  var MAX_REPEATS_CEILING = 100;
  var SIZE_WARN_BYTES = 8 * 1024 * 1024;
  var COUNT_DEBOUNCE_MS = 350;

  var el = {
    statusLine: document.getElementById('statusLine'),
    statusMode: document.getElementById('statusMode'),
    statusDetail: document.getElementById('statusDetail'),
    repeatLine: document.getElementById('repeatLine'),
    btnStart: document.getElementById('btnStart'),
    btnStopRec: document.getElementById('btnStopRec'),
    btnShot: document.getElementById('btnShot'),
    btnClear: document.getElementById('btnClear'),
    btnPlay: document.getElementById('btnPlay'),
    btnStopPlay: document.getElementById('btnStopPlay'),
    notice: document.getElementById('notice'),
    skipped: document.getElementById('skipped'),
    sizeWarn: document.getElementById('sizeWarn'),
    list: document.getElementById('stepList'),
    empty: document.getElementById('emptyMsg'),
    count: document.getElementById('stepCount')
  };

  var steps = [];
  var mode = 'idle';
  var play = null;
  var lastRenderKey = '';
  var clearArmed = false;
  var clearTimer = null;
  var countTimers = {};

  /* ------------------------------------------------------------ messaging */

  function ask(payload) {
    return chrome.runtime.sendMessage(payload).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
  }

  function showLocalNotice(text, kind) {
    el.notice.hidden = false;
    el.notice.className = 'notice notice-' + (kind || 'info');
    el.notice.textContent = text;
  }

  function actAndReport(payload) {
    return ask(payload).then(function (res) {
      if (res && res.ok === false && res.error) showLocalNotice(res.error, 'error');
      return res;
    });
  }

  /* ------------------------------------------------------------- text bits */

  function squash(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function trunc(text, max) {
    var t = squash(text);
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return url || 'unknown page'; }
  }

  function tabName(step) {
    return trunc(step.title || hostOf(step.url) || 'tab', 40);
  }

  function fieldName(step) {
    var a = step.attrs || {};
    var name = step.ariaLabel || a.name || step.fallbackText || step.selector || step.tagName || 'field';
    return (step.tagName || 'field') + " '" + trunc(name, 34) + "'";
  }

  /* Plain-English description of one recorded step. */
  function describe(step) {
    var a = step.attrs || {};
    var label = step.ariaLabel || step.fallbackText || a.name || step.selector || step.tagName || 'element';
    switch (step.type) {
      case 'click':
        /* Visible text first: "Clicked button 'Accept'" reads better than the
         * full aria-label, which usually carries a name that varies per row. */
        return 'Clicked ' + (step.tagName || 'element') + " '" +
               trunc(step.fallbackText || step.ariaLabel || label, 46) + "'";
      case 'input':
        if (!step.value) return 'Cleared ' + fieldName(step);
        return 'Typed "' + trunc(step.value, 34) + '" into ' + fieldName(step);
      case 'change':
        if (step.value === 'true') return 'Ticked ' + fieldName(step);
        if (step.value === 'false') return 'Unticked ' + fieldName(step);
        return 'Set ' + fieldName(step) + ' to "' + trunc(step.value, 30) + '"';
      case 'key':
        return 'Pressed ' + (step.value || 'a key');
      case 'scroll':
        return 'Scrolled the page to ' + (step.value || '0') + 'px';
      case 'switchTab':
        return 'Switched to tab: ' + trunc(step.title || hostOf(step.url), 46);
      case 'screenshot':
        return 'Screenshot of ' + trunc(step.title || hostOf(step.url), 40);
      default:
        return step.type;
    }
  }

  /* --------------------------------------------------- repeat pattern logic */

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

  function quote(value) {
    return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  var TRAILING_FILLER = {
    by: 1, to: 1, for: 1, from: 1, with: 1, of: 1, on: 1, in: 1, at: 1,
    the: 1, a: 1, an: 1, and: 1, s: 1
  };

  /* "Accept Jane Smith's invitation" -> "Accept".
   * Keeps the leading words and drops the variable tail: a capitalised word
   * (usually a person or company name) or anything containing digits ends it. */
  function stablePrefix(text) {
    var tokens = squash(text).split(' ').filter(Boolean);
    if (!tokens.length) return '';
    var kept = [tokens[0]];
    for (var i = 1; i < tokens.length && kept.length < 5; i++) {
      var t = tokens[i];
      if (/\d/.test(t)) break;
      if (/^[A-Z]/.test(t)) break;
      kept.push(t);
    }
    while (kept.length > 1) {
      var tail = kept[kept.length - 1].toLowerCase().replace(/[^a-z]/g, '');
      if (!TRAILING_FILLER[tail]) break;
      kept.pop();
    }
    return kept.join(' ');
  }

  /* Never reuse the single-click selector here: nth-of-type / nth-child break
   * the moment the list shifts after the first click. Build a generic pattern
   * from a stable label, a stable attribute, or the visible text instead. */
  function derivePattern(step) {
    var tag = (step.tagName || 'button').toLowerCase();
    var a = step.attrs || {};

    var aria = squash(step.ariaLabel);
    if (aria) {
      var prefix = stablePrefix(aria);
      if (prefix && prefix.length < aria.length) return tag + '[aria-label^="' + quote(prefix) + '"]';
      if (prefix) return tag + '[aria-label="' + quote(aria) + '"]';
    }
    if (a.testId && !looksGenerated(a.testId)) return tag + '[data-testid="' + quote(a.testId) + '"]';
    if (a.name && !looksGenerated(a.name)) return tag + '[name="' + quote(a.name) + '"]';

    var text = squash(step.fallbackText);
    if (text) return tag + ':text("' + quote(trunc(text, 60)) + '")';
    return tag;
  }

  function defaultRepeat(step) {
    return {
      enabled: true,
      pattern: derivePattern(step),
      maxRepeats: DEFAULT_MAX_REPEATS,
      delaySeconds: DEFAULT_DELAY_SECONDS
    };
  }

  /* ----------------------------------------------------------- status line */

  function renderStatus() {
    var cls = 'status status-' + mode;
    var detail = '';
    el.statusMode.textContent =
      mode === 'recording' ? 'Recording' : (mode === 'playing' ? 'Playing' : 'Idle');

    if (mode === 'recording') {
      detail = steps.length + ' step' + (steps.length === 1 ? '' : 's') + ' captured';
    } else if (mode === 'playing' && play) {
      detail = 'Step ' + ((play.index || 0) + 1) + ' of ' + (play.total || steps.length);
      if (play.label) detail += ' — ' + play.label;
      if (play.matchLevel) detail += ' (' + play.matchLevel + ')';
    } else {
      detail = steps.length ? steps.length + ' step' + (steps.length === 1 ? '' : 's') + ' ready' : 'Nothing recorded';
    }
    el.statusDetail.textContent = detail;
    el.statusLine.className = cls;

    if (mode === 'playing' && play && play.repeatMax) {
      var line = 'Repeat ' + (play.repeatCount || 0) + ' of up to ' + play.repeatMax;
      if (play.repeatNote) line += ' — ' + play.repeatNote;
      else if (typeof play.repeatRemaining === 'number') {
        line += ' — ' + play.repeatRemaining + ' element(s) still matching';
      }
      el.repeatLine.textContent = line;
      el.repeatLine.hidden = false;
    } else {
      el.repeatLine.hidden = true;
    }
  }

  function renderButtons() {
    el.btnStart.disabled = mode !== 'idle';
    el.btnStopRec.disabled = mode !== 'recording';
    el.btnShot.disabled = mode !== 'recording';
    el.btnPlay.disabled = mode !== 'idle' || steps.length === 0;
    el.btnStopPlay.disabled = mode !== 'playing';
    el.btnClear.disabled = mode !== 'idle' || steps.length === 0;
    if (mode !== 'idle') disarmClear();
  }

  /* --------------------------------------------------------------- notices */

  function renderNotice(n) {
    if (!n || !n.text) { el.notice.hidden = true; return; }
    el.notice.hidden = false;
    el.notice.className = 'notice notice-' + (n.kind || 'info');
    el.notice.textContent = n.text;
  }

  function renderSkipped(list) {
    if (!list || !list.length) { el.skipped.hidden = true; return; }
    el.skipped.hidden = false;
    el.skipped.className = 'notice notice-warn';
    el.skipped.textContent = '';
    var head = document.createElement('strong');
    head.textContent = 'Skipped ' + list.length + ' tab' + (list.length === 1 ? '' : 's') +
                       ' (recording will not work there):';
    el.skipped.appendChild(head);
    var ul = document.createElement('ul');
    list.slice(0, 8).forEach(function (item) {
      var li = document.createElement('li');
      li.textContent = trunc(item.title, 48) + ' — ' + item.reason;
      ul.appendChild(li);
    });
    if (list.length > 8) {
      var more = document.createElement('li');
      more.textContent = '… and ' + (list.length - 8) + ' more.';
      ul.appendChild(more);
    }
    el.skipped.appendChild(ul);
  }

  function renderSize() {
    var bytes = 0;
    try { bytes = new Blob([JSON.stringify(steps)]).size; } catch (e) { bytes = 0; }
    if (bytes > SIZE_WARN_BYTES) {
      el.sizeWarn.hidden = false;
      el.sizeWarn.className = 'notice notice-warn';
      el.sizeWarn.textContent =
        'This recording is about ' + (bytes / (1024 * 1024)).toFixed(1) + ' MB, mostly screenshots. ' +
        'Chrome limits extension storage to roughly 10 MB, so delete some screenshot steps ' +
        'before adding more or the recording may fail to save.';
    } else {
      el.sizeWarn.hidden = true;
    }
  }

  /* ------------------------------------------------------------ step list */

  function renderKey() {
    return steps.map(function (s) {
      return s.id + ':' + s.type + ':' + (s.repeat && s.repeat.enabled ? '1' : '0');
    }).join('|') + '#' + mode;
  }

  function captureFocus() {
    var active = document.activeElement;
    if (!active || !active.dataset || !active.dataset.fkey) return null;
    var snap = { key: active.dataset.fkey, start: null, end: null };
    try { snap.start = active.selectionStart; snap.end = active.selectionEnd; } catch (e) { /* number inputs */ }
    return snap;
  }

  function restoreFocus(snap) {
    if (!snap) return;
    var target = el.list.querySelector('[data-fkey="' + snap.key.replace(/"/g, '\\"') + '"]');
    if (!target) return;
    target.focus();
    if (snap.start != null) {
      try { target.setSelectionRange(snap.start, snap.end); } catch (e) { /* not supported */ }
    }
  }

  function makeField(labelText, input) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function buildRepeatBox(step) {
    var box = document.createElement('div');
    box.className = 'repeat-box';
    var r = step.repeat || {};

    var pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.value = r.pattern || '';
    pattern.spellcheck = false;
    pattern.dataset.fkey = step.id + ':pattern';
    pattern.dataset.role = 'pattern';
    pattern.dataset.id = step.id;
    box.appendChild(makeField('Match pattern', pattern));

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'A CSS selector. ';
    var code = document.createElement('code');
    code.textContent = 'tag:text("exact words")';
    hint.appendChild(code);
    hint.appendChild(document.createTextNode(
      ' matches by visible text instead. Position-based patterns (nth-of-type, nth-child) ' +
      'are not allowed here — the list shifts after every click.'));
    box.appendChild(hint);

    var twoUp = document.createElement('div');
    twoUp.className = 'two-up';

    var maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.min = '1';
    maxInput.max = String(MAX_REPEATS_CEILING);
    maxInput.step = '1';
    maxInput.value = String(r.maxRepeats == null ? DEFAULT_MAX_REPEATS : r.maxRepeats);
    maxInput.dataset.fkey = step.id + ':max';
    maxInput.dataset.role = 'max';
    maxInput.dataset.id = step.id;
    twoUp.appendChild(makeField('Max repeats', maxInput));

    var delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = String(DELAY_FLOOR_SECONDS);
    delayInput.step = '0.1';
    delayInput.value = String(r.delaySeconds == null ? DEFAULT_DELAY_SECONDS : r.delaySeconds);
    delayInput.dataset.fkey = step.id + ':delay';
    delayInput.dataset.role = 'delay';
    delayInput.dataset.id = step.id;
    twoUp.appendChild(makeField('Delay (seconds)', delayInput));

    box.appendChild(twoUp);

    var limits = document.createElement('p');
    limits.className = 'hint';
    limits.textContent = 'Capped at ' + MAX_REPEATS_CEILING + ' repeats and a ' + DELAY_FLOOR_SECONDS +
      ' second minimum delay, whatever you type. Sites rate-limit rapid automated clicking and some ' +
      'restrict accounts for it, so these limits stay in force.';
    box.appendChild(limits);

    var readout = document.createElement('div');
    readout.className = 'readout';
    readout.dataset.readoutFor = step.id;
    readout.textContent = 'Checking the active tab…';
    box.appendChild(readout);

    return box;
  }

  function buildStep(step, index) {
    var li = document.createElement('li');
    li.className = 'step type-' + step.type;
    li.dataset.id = step.id;
    if (mode === 'playing' && play && play.index === index) li.className += ' step-current';

    var main = document.createElement('div');
    main.className = 'step-main';

    var idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = (index + 1) + '.';
    main.appendChild(idx);

    /* Tab switches read as a sentence of their own; everything else carries a
     * chip naming the page it belongs to. */
    if (step.type !== 'switchTab') {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = step.url || '';
      chip.textContent = '[' + tabName(step) + ']';
      main.appendChild(chip);
    }

    var desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = describe(step);
    main.appendChild(desc);

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.dataset.role = 'delete';
    x.dataset.id = step.id;
    x.title = 'Delete this step';
    x.setAttribute('aria-label', 'Delete step ' + (index + 1));
    x.textContent = '×';
    main.appendChild(x);

    li.appendChild(main);

    if (step.type === 'screenshot' && step.dataUrl) {
      var img = document.createElement('img');
      img.className = 'thumb';
      img.src = step.dataUrl;
      img.alt = 'Screenshot taken on ' + tabName(step);
      li.appendChild(img);
    }

    if (step.type === 'click') {
      var on = !!(step.repeat && step.repeat.enabled);
      var toggle = document.createElement('label');
      toggle.className = 'repeat-toggle' + (on ? ' on' : '');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.dataset.role = 'toggle';
      cb.dataset.id = step.id;
      toggle.appendChild(cb);
      toggle.appendChild(document.createTextNode('Repeat on every matching element'));
      li.appendChild(toggle);
      if (on) li.appendChild(buildRepeatBox(step));
    }

    return li;
  }

  function renderList(force) {
    var key = renderKey();
    if (!force && key === lastRenderKey) {
      /* Only repeat-field values changed, and the inputs already show them.
       * Re-rendering here would fight the user's cursor. */
      highlightCurrent();
      return;
    }
    lastRenderKey = key;

    var snap = captureFocus();
    el.list.textContent = '';
    steps.forEach(function (step, i) {
      el.list.appendChild(buildStep(step, i));
    });
    el.empty.hidden = steps.length > 0;
    el.count.textContent = String(steps.length);
    restoreFocus(snap);

    /* The read-out is a design-time helper; during a run the page is busy and
     * the live counter in the status bar is the thing to watch. */
    if (mode !== 'playing') {
      steps.forEach(function (step) {
        if (step.repeat && step.repeat.enabled) refreshCount(step.id, step.repeat.pattern);
      });
    }
  }

  function highlightCurrent() {
    var items = el.list.querySelectorAll('.step');
    for (var i = 0; i < items.length; i++) {
      var isCurrent = mode === 'playing' && play && play.index === i;
      items[i].classList.toggle('step-current', !!isCurrent);
    }
    el.count.textContent = String(steps.length);
  }

  /* ------------------------------------------------- live "matches N" line */

  function setReadout(stepId, text, kind) {
    var node = el.list.querySelector('[data-readout-for="' + stepId + '"]');
    if (!node) return;
    node.className = 'readout' + (kind ? ' readout-' + kind : '');
    node.textContent = text;
  }

  function refreshCount(stepId, pattern) {
    if (countTimers[stepId]) clearTimeout(countTimers[stepId]);
    countTimers[stepId] = setTimeout(function () {
      delete countTimers[stepId];
      if (!String(pattern || '').trim()) {
        setReadout(stepId, 'Enter a match pattern to see how many elements it finds.', 'error');
        return;
      }
      setReadout(stepId, 'Checking the active tab…');
      ask({ cmd: 'countMatches', pattern: pattern }).then(function (res) {
        if (!res || res.ok === false) {
          setReadout(stepId, 'Cannot count right now: ' + ((res && res.error) || 'no answer from the page') + '.', 'error');
          return;
        }
        var n = res.count;
        setReadout(
          stepId,
          'Currently matches ' + n + ' element' + (n === 1 ? '' : 's') + ' on the active tab' +
            (res.tabTitle ? ' (' + trunc(res.tabTitle, 30) + ')' : '') + '.',
          n === 0 ? 'none' : ''
        );
      });
    }, COUNT_DEBOUNCE_MS);
  }

  /* --------------------------------------------------------- step editing */

  function stepById(id) {
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) return steps[i];
    return null;
  }

  function saveRepeat(id, repeat) {
    return actAndReport({ cmd: 'setRepeat', id: id, repeat: repeat });
  }

  el.list.addEventListener('click', function (e) {
    var target = e.target;
    if (target && target.dataset && target.dataset.role === 'delete') {
      actAndReport({ cmd: 'deleteStep', id: target.dataset.id });
    }
  });

  el.list.addEventListener('change', function (e) {
    var target = e.target;
    if (!target || !target.dataset) return;
    if (target.dataset.role !== 'toggle') return;
    var step = stepById(target.dataset.id);
    if (!step) return;
    if (target.checked) {
      /* Re-use what the user last tuned rather than re-deriving over the top
       * of it; only a step that has never had a pattern gets a fresh one. */
      var previous = step.repeat && String(step.repeat.pattern || '').trim() ? step.repeat : null;
      saveRepeat(step.id, previous
        ? { enabled: true, pattern: previous.pattern, maxRepeats: previous.maxRepeats, delaySeconds: previous.delaySeconds }
        : defaultRepeat(step));
    } else if (step.repeat) {
      /* Kept, not discarded: switching the toggle back on should not cost the
       * user the pattern they hand-tuned. Disabled config never runs. */
      saveRepeat(step.id, Object.assign({}, step.repeat, { enabled: false }));
    }
  });

  el.list.addEventListener('input', function (e) {
    var target = e.target;
    if (!target || !target.dataset || !target.dataset.role) return;
    var role = target.dataset.role;
    if (role !== 'pattern' && role !== 'max' && role !== 'delay') return;

    var step = stepById(target.dataset.id);
    if (!step) return;
    var current = step.repeat || defaultRepeat(step);
    var updated = {
      enabled: true,
      pattern: current.pattern,
      maxRepeats: current.maxRepeats,
      delaySeconds: current.delaySeconds
    };

    if (role === 'pattern') {
      updated.pattern = target.value;
      refreshCount(step.id, updated.pattern);
    } else if (role === 'max') {
      var m = parseInt(target.value, 10);
      updated.maxRepeats = isNaN(m) ? DEFAULT_MAX_REPEATS : Math.min(MAX_REPEATS_CEILING, Math.max(1, m));
    } else {
      var d = parseFloat(target.value);
      updated.delaySeconds = isNaN(d) ? DEFAULT_DELAY_SECONDS : Math.max(DELAY_FLOOR_SECONDS, d);
    }
    step.repeat = updated;
    saveRepeat(step.id, updated);
  });

  /* Clamp the visible value once the user leaves the box, so the field always
   * shows the number that will actually be used. */
  el.list.addEventListener('blur', function (e) {
    var target = e.target;
    if (!target || !target.dataset) return;
    var role = target.dataset.role;
    if (role !== 'max' && role !== 'delay') return;
    var step = stepById(target.dataset.id);
    if (!step || !step.repeat) return;
    target.value = String(role === 'max' ? step.repeat.maxRepeats : step.repeat.delaySeconds);
  }, true);

  /* ------------------------------------------------------- main controls */

  function disarmClear() {
    clearArmed = false;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    el.btnClear.textContent = 'Clear';
  }

  el.btnStart.addEventListener('click', function () {
    showLocalNotice('Starting recording…', 'info');
    actAndReport({ cmd: 'startRecording' });
  });

  el.btnStopRec.addEventListener('click', function () {
    actAndReport({ cmd: 'stopRecording' });
  });

  el.btnShot.addEventListener('click', function () {
    actAndReport({ cmd: 'screenshot' });
  });

  el.btnPlay.addEventListener('click', function () {
    actAndReport({ cmd: 'play' });
  });

  el.btnStopPlay.addEventListener('click', function () {
    actAndReport({ cmd: 'stopPlayback' });
  });

  el.btnClear.addEventListener('click', function () {
    if (!clearArmed) {
      clearArmed = true;
      el.btnClear.textContent = 'Click again to wipe';
      clearTimer = setTimeout(disarmClear, 4000);
      return;
    }
    disarmClear();
    actAndReport({ cmd: 'clear' });
  });

  /* ------------------------------------------------------------ state sync */

  function applyState(local, playState) {
    mode = (local && local.mode) || 'idle';
    steps = Array.isArray(local && local.steps) ? local.steps : [];
    play = playState || null;
    renderStatus();
    renderButtons();
    renderNotice(local && local.notice);
    renderSkipped(local && local.skipped);
    renderSize();
    renderList(false);
  }

  function loadState() {
    return ask({ cmd: 'getState' }).then(function (res) {
      if (res && res.ok) {
        applyState(res.local, res.play);
        return;
      }
      /* The service worker may still be waking up - read storage directly. */
      return Promise.all([
        chrome.storage.local.get(['mode', 'steps', 'notice', 'skipped']),
        chrome.storage.session.get('play')
      ]).then(function (r) {
        applyState(r[0], r[1] && r[1].play);
      }).catch(function (e) {
        showLocalNotice('Could not read the saved recording: ' + ((e && e.message) || e), 'error');
      });
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local') {
      if (changes.mode) mode = changes.mode.newValue || 'idle';
      if (changes.steps) steps = Array.isArray(changes.steps.newValue) ? changes.steps.newValue : [];
      if (changes.notice) renderNotice(changes.notice.newValue);
      if (changes.skipped) renderSkipped(changes.skipped.newValue);
      if (changes.mode || changes.steps) {
        renderStatus();
        renderButtons();
        renderSize();
        renderList(false);
      }
    } else if (area === 'session') {
      if (changes.play) {
        play = changes.play.newValue || null;
        renderStatus();
        highlightCurrent();
      }
      /* The active tab changed or finished loading, so every "matches N"
       * read-out is now about a different page. */
      if (changes.activeTabStamp && mode !== 'playing') {
        steps.forEach(function (step) {
          if (step.repeat && step.repeat.enabled) refreshCount(step.id, step.repeat.pattern);
        });
      }
    }
  });

  loadState();
})();
