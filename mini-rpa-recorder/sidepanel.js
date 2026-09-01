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
    count: document.getElementById('stepCount'),
    selectBar: document.getElementById('selectBar'),
    redoBar: document.getElementById('redoBar')
  };

  var steps = [];
  var mode = 'idle';
  var play = null;
  var lastRenderKey = '';
  var clearArmed = false;
  var clearTimer = null;
  var countTimers = {};
  var selected = {};        /* step ids ticked for grouping */
  var undoSnapshot = null;  /* the whole list as it was before a delete */
  var redoingId = null;     /* the step currently being re-recorded */

  /* ------------------------------------------------------------ messaging */

  function ask(payload) {
    return chrome.runtime.sendMessage(payload).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
  }

  function showUndo() {
    if (!undoSnapshot) return;
    el.notice.hidden = false;
    el.notice.className = 'notice notice-info';
    el.notice.textContent = '';
    var msg = document.createElement('span');
    msg.textContent = 'Deleted “' + trunc(undoSnapshot.label, 44) + '”. ';
    el.notice.appendChild(msg);
    var undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'link-btn';
    undo.dataset.role = 'undo';
    undo.textContent = 'Undo';
    el.notice.appendChild(undo);
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
        /* Saying "Cleared" here would be a lie: the value was withheld on
         * purpose, and the user needs to know they must type it at playback. */
        if (a.type === 'password') return 'Password box ' + fieldName(step) + ' — value not saved, type it yourself';
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

  /* A pattern built from an attribute alone cannot tell a row that still needs
   * doing from one that has already been actioned - plenty of pages leave the
   * attribute untouched and change only the wording. So once a pattern exists,
   * it is checked against the live page and pinned to the recorded wording
   * when the evidence says that wording identifies a state rather than a
   * single row. Pinning needs at least two elements showing it: one alone
   * means the wording varies per row and pinning would trap the loop. */
  function refinePattern(stepId, basePattern, wantText) {
    var text = squash(wantText);
    if (!text || text.length > 60) return;
    if (/:text\(/.test(basePattern)) return;
    var prefix = stablePrefix(text);
    ask({ cmd: 'analyzePattern', pattern: basePattern, text: text, prefix: prefix })
      .then(function (res) {
      if (!res || res.ok === false) return;
      /* Exact wording first. Where the wording carries the row's own name, the
       * leading words still say which state it is in, so fall back to those.
       * Either way it takes two or more elements to be a state rather than a
       * single row - pinning to one would leave the loop with nothing to do. */
      var pin = null;
      if (res.withText >= 2) pin = ':text("' + quote(text) + '")';
      else if (prefix && prefix !== text && res.withPrefix >= 2) {
        pin = ':text^("' + quote(prefix) + '")';
      }
      if (!pin) return;
      var others = res.withText >= 2 ? res.others : res.othersPrefix;
      var shown = res.withText >= 2 ? text : prefix;
      var step = stepById(stepId);
      if (!step || !step.repeat || !step.repeat.enabled) return;
      if (squash(step.repeat.pattern) !== squash(basePattern)) return;   /* user edited it */
      var pinned = basePattern + pin;
      step.repeat = Object.assign({}, step.repeat, { pattern: pinned });
      saveRepeat(stepId, step.repeat);
      /* The box has to show what is actually going to run - a re-render is
       * skipped here because only a field value changed, so update it directly. */
      var box = el.list.querySelector('[data-fkey="' + stepId + ':pattern"]');
      if (box && box !== document.activeElement) box.value = pinned;
      refreshCount(stepId, pinned);
      if (others > 0) {
        showLocalNotice('Narrowed the match pattern for step "' + trunc(describe(step), 40) +
          '" to elements showing "' + shown + '". The page has ' + others +
          ' other element(s) with the same attribute in a different state, and clicking those ' +
          'would do something else entirely.', 'warn');
      }
    });
  }

  function defaultRepeat(step) {
    return {
      enabled: true,
      pattern: derivePattern(step),
      maxRepeats: DEFAULT_MAX_REPEATS,
      delaySeconds: DEFAULT_DELAY_SECONDS,
      onMissing: 'stop'
    };
  }

  function onMissingOf(step) {
    return (step.repeat && step.repeat.onMissing) === 'skip' ? 'skip' : 'stop';
  }

  function setSizeOf(step) {
    if (step && step.set && step.set.size > 0) return Math.round(step.set.size);
    if (step && step.repeat && step.repeat.groupSize > 0) return Math.round(step.repeat.groupSize);
    return 1;
  }

  function setNameOf(step, index) {
    if (step && step.set && squash(step.set.name)) return step.set.name;
    var size = Math.min(setSizeOf(step), steps.length - index);
    var last = steps[index + size - 1];
    var head = describe(step).replace(/^Clicked \w+ /, '').replace(/^'|'$/g, '');
    if (size < 2 || !last) return trunc(head, 30);
    var tail = describe(last).replace(/^Clicked \w+ /, '').replace(/^'|'$/g, '');
    return trunc(head, 22) + ' → ' + trunc(tail, 22);
  }

  /* A set is anchored on its first step; the ones it covers are drawn inside
   * it rather than as rows of their own. */
  function setMemberIds() {
    var inside = {};
    for (var i = 0; i < steps.length; i++) {
      var size = Math.min(setSizeOf(steps[i]), steps.length - i);
      if (size < 2) continue;
      for (var j = i + 1; j < i + size; j++) inside[steps[j].id] = steps[i].id;
      i += size - 1;
    }
    return inside;
  }

  function stepIndexById(id) {
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) return i;
    return -1;
  }

  /* ----------------------------------------------------------- status line */

  function renderStatus() {
    var cls = 'status status-' + mode;
    var detail = '';
    el.statusMode.textContent =
      mode === 'recording' ? 'Recording'
        : mode === 'playing' ? 'Playing'
        : mode === 'redo' ? 'Re-recording'
        : 'Idle';

    if (mode === 'redo') {
      var at = redoingId ? stepIndexById(redoingId) : -1;
      detail = at >= 0 ? 'replacing step ' + (at + 1) : 'replacing one step';
    } else if (mode === 'recording') {
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
    if (mode !== 'idle') { disarmClear(); selected = {}; }
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
    return (redoingId || '') + '#' + steps.map(function (s) {
      return s.id + ':' + s.type + ':' + (s.repeat && s.repeat.enabled ? '1' : '0') +
             ':' + setSizeOf(s) + ':' + (s.set && s.set.collapsed ? 'c' : 'o') +
             ':' + (selected[s.id] ? 's' : '');
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

  /* ---- one action set, drawn as a single card ------------------------- */

  function buildAdvanced(step) {
    var wrap = document.createElement('details');
    wrap.className = 'advanced';
    var sum = document.createElement('summary');
    sum.textContent = 'Match pattern and timing';
    wrap.appendChild(sum);

    var r = step.repeat || {};
    var pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.value = r.pattern || '';
    pattern.spellcheck = false;
    pattern.dataset.fkey = step.id + ':pattern';
    pattern.dataset.role = 'pattern';
    pattern.dataset.id = step.id;
    wrap.appendChild(makeField('Which elements to loop over', pattern));

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'A CSS selector. ';
    var code = document.createElement('code');
    code.textContent = ':text("exact words")';
    hint.appendChild(code);
    hint.appendChild(document.createTextNode(' matches by visible wording and '));
    var code2 = document.createElement('code');
    code2.textContent = ':text^("leading words")';
    hint.appendChild(code2);
    hint.appendChild(document.createTextNode(
      ' by the start of it — often what says whether a row still needs doing. ' +
      'Position-based patterns (nth-of-type, nth-child) are not allowed: the list ' +
      'shifts after every click.'));
    wrap.appendChild(hint);

    var twoUp = document.createElement('div');
    twoUp.className = 'two-up';

    var delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = String(DELAY_FLOOR_SECONDS);
    delayInput.step = '0.1';
    delayInput.value = String(r.delaySeconds == null ? DEFAULT_DELAY_SECONDS : r.delaySeconds);
    delayInput.dataset.fkey = step.id + ':delay';
    delayInput.dataset.role = 'delay';
    delayInput.dataset.id = step.id;
    twoUp.appendChild(makeField('Wait between loops (s)', delayInput));

    var missing = document.createElement('select');
    missing.dataset.fkey = step.id + ':missing';
    missing.dataset.role = 'missing';
    missing.dataset.id = step.id;
    [['stop', 'Stop and tell me'], ['skip', 'Skip it and carry on']].forEach(function (pair) {
      var opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (pair[0] === onMissingOf(step)) opt.selected = true;
      missing.appendChild(opt);
    });
    twoUp.appendChild(makeField('If a step is missing', missing));
    wrap.appendChild(twoUp);

    var limits = document.createElement('p');
    limits.className = 'hint';
    limits.textContent = 'Whatever you type, a loop never runs more than ' + MAX_REPEATS_CEILING +
      ' times or waits less than ' + DELAY_FLOOR_SECONDS + ' seconds between turns. Sites rate-limit ' +
      'rapid automated clicking and some restrict accounts for it.';
    wrap.appendChild(limits);
    return wrap;
  }

  function buildSetCard(step, index, size) {
    var li = document.createElement('li');
    var looping = !!(step.repeat && step.repeat.enabled);
    var collapsed = !!(step.set && step.set.collapsed);
    li.className = 'set' + (looping ? ' set-looping' : '') + (collapsed ? ' set-collapsed' : '');
    li.dataset.id = step.id;

    /* ---- header ---- */
    var head = document.createElement('div');
    head.className = 'set-head';

    var chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'chev';
    chev.dataset.role = 'collapse';
    chev.dataset.id = step.id;
    chev.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    chev.title = collapsed ? 'Show the steps in this set' : 'Hide the steps in this set';
    chev.textContent = collapsed ? '▸' : '▾';
    head.appendChild(chev);

    var title = document.createElement('span');
    title.className = 'set-title';
    title.textContent = setNameOf(step, index);
    head.appendChild(title);

    var count = document.createElement('span');
    count.className = 'set-count';
    count.textContent = size === 1 ? 'step ' + (index + 1)
                                   : size + ' steps · ' + (index + 1) + '–' + (index + size);
    head.appendChild(count);

    var loopBtn = document.createElement('button');
    loopBtn.type = 'button';
    loopBtn.className = 'loop-btn' + (looping ? ' on' : '');
    loopBtn.dataset.role = 'loop';
    loopBtn.dataset.id = step.id;
    loopBtn.setAttribute('aria-pressed', looping ? 'true' : 'false');
    loopBtn.textContent = looping ? '⟳ Looping' : '⟳ Loop';
    loopBtn.title = step.type === 'click'
      ? 'Run this set once for every matching element on the page'
      : 'Looping needs the set to start with a click';
    if (step.type !== 'click') loopBtn.disabled = true;
    head.appendChild(loopBtn);

    li.appendChild(head);

    /* ---- looping controls, right under the header where they belong ---- */
    if (looping) {
      var bar = document.createElement('div');
      bar.className = 'loop-bar';

      var label = document.createElement('span');
      label.textContent = 'Repeat up to';
      bar.appendChild(label);

      var times = document.createElement('input');
      times.type = 'number';
      times.min = '1';
      times.max = String(MAX_REPEATS_CEILING);
      times.step = '1';
      times.className = 'loop-times';
      times.value = String((step.repeat && step.repeat.maxRepeats) || DEFAULT_MAX_REPEATS);
      times.dataset.fkey = step.id + ':max';
      times.dataset.role = 'max';
      times.dataset.id = step.id;
      bar.appendChild(times);

      var suffix = document.createElement('span');
      suffix.textContent = 'times';
      bar.appendChild(suffix);

      var checkBtn = document.createElement('button');
      checkBtn.type = 'button';
      checkBtn.className = 'check-btn';
      checkBtn.dataset.role = 'check';
      checkBtn.dataset.id = step.id;
      checkBtn.textContent = 'Show me on the page';
      checkBtn.title = 'Outline every element this loop would act on, without clicking any of them';
      bar.appendChild(checkBtn);

      li.appendChild(bar);

      var readout = document.createElement('div');
      readout.className = 'readout';
      readout.dataset.readoutFor = step.id;
      readout.textContent = 'Checking the active tab…';
      li.appendChild(readout);
    }

    /* ---- the steps themselves ---- */
    if (!collapsed) {
      var body = document.createElement('ol');
      body.className = 'set-body';
      for (var i = index; i < index + size; i++) {
        body.appendChild(buildStepRow(steps[i], i, true));
      }
      li.appendChild(body);

      var foot = document.createElement('div');
      foot.className = 'set-foot';
      if (looping) foot.appendChild(buildAdvanced(step));

      /* A set built in the wrong order should be fixable in place, rather than
       * having to ungroup and start over - and a set of one that is already
       * looping has no tick box to group it with the next step. */
      var edit = document.createElement('div');
      edit.className = 'set-edit';
      if (index + size < steps.length) {
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'link-btn';
        add.dataset.role = 'grow';
        add.dataset.id = step.id;
        add.textContent = '+ Add step ' + (index + size + 1) + ' to this set';
        edit.appendChild(add);
      }
      if (size > 1) {
        var shrink = document.createElement('button');
        shrink.type = 'button';
        shrink.className = 'link-btn';
        shrink.dataset.role = 'shrink';
        shrink.dataset.id = step.id;
        shrink.textContent = '− Drop step ' + (index + size);
        edit.appendChild(shrink);

        var ungroup = document.createElement('button');
        ungroup.type = 'button';
        ungroup.className = 'link-btn';
        ungroup.dataset.role = 'ungroup';
        ungroup.dataset.id = step.id;
        ungroup.textContent = 'Ungroup';
        edit.appendChild(ungroup);
      }
      foot.appendChild(edit);
      li.appendChild(foot);
    }

    return li;
  }

  /* ---- one ordinary step row ------------------------------------------ */

  /* The tab is only worth naming when it changes: repeating the same chip down
   * every row is the single biggest source of clutter in a long recording. */
  function tabChanged(index) {
    if (index <= 0) return true;
    var prev = steps[index - 1];
    var here = steps[index];
    if (!prev || !here) return true;
    return (prev.title || prev.url) !== (here.title || here.url);
  }

  function buildStepRow(step, index, insideSet) {
    var li = document.createElement('li');
    li.className = 'step type-' + step.type + (insideSet ? ' in-set' : '');
    li.dataset.id = step.id;
    if (mode === 'playing' && play && play.index === index) li.className += ' step-current';
    if (mode === 'redo' && redoingId === step.id) li.className += ' step-redoing';

    var main = document.createElement('div');
    main.className = 'step-main';

    if (!insideSet && mode === 'idle') {
      var pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'pick';
      pick.checked = !!selected[step.id];
      pick.dataset.role = 'select';
      pick.dataset.id = step.id;
      pick.setAttribute('aria-label', 'Select step ' + (index + 1) + ' for grouping');
      main.appendChild(pick);
    }

    var idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = (index + 1) + '.';
    main.appendChild(idx);

    if (step.type !== 'switchTab' && tabChanged(index)) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = step.url || '';
      chip.textContent = tabName(step);
      main.appendChild(chip);
    }

    var full = describe(step);
    var desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = full;
    desc.title = full;                    /* the row is one line; nothing is lost */
    main.appendChild(desc);

    /* Looping a single step should not require grouping it with anything, so
     * a click step carries its own Loop button; pressing it promotes the row
     * to a set card of one. */
    if (!insideSet && step.type === 'click' && mode === 'idle') {
      var loop = document.createElement('button');
      loop.type = 'button';
      loop.className = 'loop-mini';
      loop.dataset.role = 'loop';
      loop.dataset.id = step.id;
      loop.setAttribute('aria-pressed', 'false');
      loop.title = 'Run this click once for every matching element on the page';
      loop.textContent = '⟳ Loop';
      main.appendChild(loop);
    }

    if (mode === 'idle') {
      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'redo-mini';
      again.dataset.role = 'redo';
      again.dataset.id = step.id;
      again.title = 'Do this one action again and replace this step with it';
      again.setAttribute('aria-label', 'Re-record step ' + (index + 1));
      again.textContent = '↻';
      main.appendChild(again);
    }

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
    return li;
  }

  /* ---- the selection bar ---------------------------------------------- */

  function renderRedoBar() {
    var bar = el.redoBar;
    if (mode !== 'redo') { bar.hidden = true; bar.textContent = ''; return; }
    bar.hidden = false;
    bar.textContent = '';
    var at = redoingId ? stepIndexById(redoingId) : -1;
    var msg = document.createElement('span');
    msg.className = 'redo-text';
    msg.textContent = at >= 0
      ? 'Re-recording step ' + (at + 1) + '. Go and do that one action — it replaces the step, ' +
        'and recording stops straight after.'
      : 'Re-recording one step. Do that action now.';
    bar.appendChild(msg);
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.dataset.role = 'cancelredo';
    cancel.textContent = 'Cancel';
    bar.appendChild(cancel);
  }

  el.redoBar.addEventListener('click', function (e) {
    if (e.target && e.target.dataset && e.target.dataset.role === 'cancelredo') {
      actAndReport({ cmd: 'cancelRedo' });
    }
  });

  /* After a step is re-recorded its loop still carries the old element's
   * pattern, which would quietly point at the wrong thing. Work it out again
   * from what was just recorded, and re-check it against the page. */
  function fulfilPendingPatterns() {
    if (mode !== 'idle') return;
    steps.forEach(function (step) {
      if (!step.needsPattern || !step.repeat || !step.repeat.enabled) return;
      if (step.type !== 'click') return;
      var fresh = derivePattern(step);
      var updated = Object.assign({}, step.repeat, { pattern: fresh });
      step.needsPattern = false;
      saveRepeat(step.id, updated).then(function () {
        refinePattern(step.id, fresh, step.fallbackText);
      });
    });
  }

  function renderSelectionBar() {
    var ids = Object.keys(selected).filter(function (id) { return selected[id]; });
    var bar = el.selectBar;
    if (!ids.length || mode !== 'idle') { bar.hidden = true; bar.textContent = ''; return; }
    bar.hidden = false;
    bar.textContent = '';

    var idxs = ids.map(stepIndexById).filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
    var contiguous = idxs.length > 1 && idxs[idxs.length - 1] - idxs[0] === idxs.length - 1;

    var text = document.createElement('span');
    text.className = 'sel-text';
    text.textContent = idxs.length + (idxs.length === 1 ? ' step selected' : ' steps selected');
    bar.appendChild(text);

    var group = document.createElement('button');
    group.type = 'button';
    group.className = 'btn btn-play sel-go';
    group.dataset.role = 'group';
    group.textContent = 'Group into an action set';
    group.disabled = !contiguous;
    bar.appendChild(group);

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'link-btn';
    clear.dataset.role = 'clearsel';
    clear.textContent = 'Clear';
    bar.appendChild(clear);

    if (!contiguous) {
      var why = document.createElement('p');
      why.className = 'hint';
      why.textContent = idxs.length < 2
        ? 'Tick at least two steps that sit next to each other.'
        : 'Those steps are not next to each other. A set runs as one unbroken sequence, ' +
          'so pick a run of steps with no gaps.';
      bar.appendChild(why);
    }
  }

  /* ---- the list ------------------------------------------------------- */

  function renderList(force) {
    /* Not a rendering concern, and it must not be skipped by the no-change
     * shortcut below: a re-recorded step keeps the same shape, so the key can
     * be identical while the loop is still waiting for a usable pattern. */
    fulfilPendingPatterns();

    var key = renderKey();
    if (!force && key === lastRenderKey) {
      highlightCurrent();
      return;
    }
    lastRenderKey = key;

    var snap = captureFocus();
    el.list.textContent = '';
    var inside = setMemberIds();
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (inside[step.id]) continue;                     /* drawn inside its set */
      var size = Math.min(setSizeOf(step), steps.length - i);
      var looping = !!(step.repeat && step.repeat.enabled);
      if (size > 1 || looping) {
        el.list.appendChild(buildSetCard(step, i, size));
        i += size - 1;
      } else {
        el.list.appendChild(buildStepRow(step, i, false));
      }
    }
    el.empty.hidden = steps.length > 0;
    el.count.textContent = String(steps.length);
    restoreFocus(snap);
    renderSelectionBar();
    renderRedoBar();

    /* While recording, the step that just happened is the one worth seeing;
     * otherwise the list quietly fills up out of sight. */
    if (mode === 'recording' && !snap) el.list.scrollTop = el.list.scrollHeight;

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

  function sentence(text) {
    var t = squash(text);
    return /[.!?]$/.test(t) ? t : t + '.';
  }

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
          setReadout(stepId, sentence('Cannot count right now — ' +
            ((res && res.error) || 'no answer from the page')), 'error');
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

  /* ------------------------------------------------- spotting a repeat */

  /* "Click Connect, then confirm in the pop-out" is almost never meant to
   * happen once - it is a process to run down a whole list. Rather than leave
   * the user to go and find the grouping controls, the panel works that out
   * the moment a recording ends: if the click they started with still matches
   * other elements on the page, the recorded steps are grouped and set to
   * loop, ready to play. One press of Looping turns it back off. */

  /* How much of the recording belongs to the process: from the first click up
   * to the point it moves to another tab. */
  function sameTabRun(list, from) {
    var end = list.length;
    for (var i = from + 1; i < list.length; i++) {
      var prev = list[i - 1];
      var here = list[i];
      if ((prev.title || prev.url) !== (here.title || here.url)) { end = i; break; }
    }
    /* A scroll recorded at the end was the user reaching the next row by hand.
     * The loop scrolls for itself when it runs out of matches, and replaying a
     * fixed scroll position every round would fight it. */
    while (end - 1 > from && list[end - 1].type === 'scroll') end -= 1;
    return end - from;
  }

  /* Anything the user has already arranged is left exactly as they left it. */
  function arranged(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].set) return true;
      if (list[i].repeat && list[i].repeat.enabled) return true;
    }
    return false;
  }

  /* What identifies the element the user actually clicked, in the same terms
   * the page is asked about - never its wording, which is the thing the action
   * changes. */
  function signatureOfStep(step) {
    var a = step.attrs || {};
    return squash(step.ariaLabel || a.id || a.testId || a.name || '');
  }

  function repeatSetUpNotice(size, count) {
    return 'This looks like a repeating process, so it is set up to loop: ' +
      (size === 1 ? 'that step runs' : 'those ' + size + ' steps run') +
      ' once for each match, and ' + count +
      (count === 1 ? ' element matches' : ' elements match') +
      ' on this page right now. Press Play to run it down the list — it scrolls ' +
      'to load more as it goes. Press Looping to turn it off.';
  }

  /* The click that leads the loop is the first one that turns out to have
   * company on the page - not simply the first click recorded. Somebody who
   * searches, filters, then works the results has clicked two things before
   * reaching the row that repeats, and anchoring on the search button would
   * loop the wrong thing and swallow the whole recording into one set.
   * Steps before the anchor stay outside the set and run once, which is what
   * a search before a loop should do.
   *
   * analyzePattern rather than previewPattern: this runs on its own, and
   * previewPattern scrolls the page and flashes an outline round every match,
   * which would be a jolt nobody asked for. */
  function firstRepeatable(list, from, budget) {
    for (var i = from; i < list.length; i++) {
      if (list[i].type !== 'click') continue;
      if (budget <= 0) break;
      var at = i;
      var step = list[i];
      var pattern = derivePattern(step);
      return ask({
        cmd: 'analyzePattern', pattern: pattern,
        text: step.fallbackText, prefix: stablePrefix(step.ariaLabel || ''),
        signature: signatureOfStep(step)
      }).then(function (look) {
        /* One match on its own proves nothing - it is as likely to be the
         * control just clicked, still sitting there, as another row. What
         * settles it is a match that is demonstrably a different element.
         * Where the page gives its elements nothing to tell them apart by,
         * several matches is the best evidence there is. */
        if (look && look.ok !== false && (look.elsewhere >= 1 || look.count >= 2)) {
          return { at: at, step: step, pattern: pattern, count: look.count };
        }
        return firstRepeatable(list, at + 1, budget - 1);
      });
    }
    return Promise.resolve(null);
  }

  function offerRepeat() {
    /* Read the recording back rather than trusting what is in hand: the mode
     * and the steps reach the panel as separate storage writes. */
    return ask({ cmd: 'getState' }).then(function (res) {
      var list = (res && res.ok && res.local && Array.isArray(res.local.steps)) ? res.local.steps : [];
      if (!list.length || arranged(list)) return;
      return firstRepeatable(list, 0, 6).then(function (found) {
        if (!found) return;
        var anchor = found.step;
        var size = sameTabRun(list, found.at);
        var repeat = {
          enabled: true,
          pattern: found.pattern,
          maxRepeats: DEFAULT_MAX_REPEATS,
          delaySeconds: DEFAULT_DELAY_SECONDS,
          onMissing: 'stop'
        };
        var write = size >= 2
          ? saveSet(anchor.id, { size: size, name: '', collapsed: false })
              .then(function () { return saveRepeat(anchor.id, repeat); })
          : saveRepeat(anchor.id, repeat);
        return write.then(function () {
          /* An attribute alone cannot tell a row that still needs doing from
           * one already actioned, so the wording gets pinned the same way it
           * would if the user had pressed Loop themselves. */
          refinePattern(anchor.id, found.pattern, anchor.fallbackText);
          showLocalNotice(repeatSetUpNotice(size, found.count), 'info');
        });
      });
    }).catch(function () { /* leave the recording exactly as it was */ });
  }

  /* --------------------------------------------------------- step editing */

  function stepById(id) {
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) return steps[i];
    return null;
  }

  function saveRepeat(id, repeat) {
    return actAndReport({ cmd: 'setRepeat', id: id, repeat: repeat });
  }

  function saveSet(id, set) {
    return actAndReport({ cmd: 'setGroup', id: id, set: set });
  }

  function clearSelection() {
    selected = {};
    renderList(true);
  }

  el.list.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.dataset || !target.dataset.role) return;
    var role = target.dataset.role;
    var id = target.dataset.id;

    if (role === 'redo') {
      undoSnapshot = null;
      actAndReport({ cmd: 'startRedo', id: id });
      return;
    }

    if (role === 'delete') {
      /* A recording is built by hand and the × has no confirm, so keep the
       * whole list as it was. Snapshotting everything rather than the one step
       * also restores any action set that shrank around it. */
      var doomed = stepById(id);
      undoSnapshot = { steps: steps.slice(), label: doomed ? describe(doomed) : 'that step' };
      actAndReport({ cmd: 'deleteStep', id: id }).then(function (res) {
        if (res && res.ok !== false) showUndo();
      });
      return;
    }

    if (role === 'collapse') {
      var s = stepById(id);
      if (!s) return;
      var next = Object.assign({}, s.set || { size: setSizeOf(s) }, { collapsed: !(s.set && s.set.collapsed) });
      saveSet(id, next);
      return;
    }

    if (role === 'ungroup') {
      saveSet(id, null);
      return;
    }

    if (role === 'grow' || role === 'shrink') {
      var owner = stepById(id);
      var at = stepIndexById(id);
      if (!owner || at < 0) return;
      var cur = Math.min(setSizeOf(owner), steps.length - at);
      var want = role === 'grow' ? cur + 1 : cur - 1;
      want = Math.max(1, Math.min(want, steps.length - at));
      saveSet(id, want < 2 && !(owner.repeat && owner.repeat.enabled)
        ? null
        : Object.assign({}, owner.set || {}, { size: want }));
      return;
    }

    if (role === 'loop') {
      var step = stepById(id);
      if (!step || step.type !== 'click') return;
      if (step.repeat && step.repeat.enabled) {
        saveRepeat(id, Object.assign({}, step.repeat, { enabled: false }));
      } else {
        var previous = step.repeat && squash(step.repeat.pattern) ? step.repeat : null;
        if (previous) {
          saveRepeat(id, Object.assign({}, previous, { enabled: true }));
        } else {
          var fresh = defaultRepeat(step);
          saveRepeat(id, fresh);
          refinePattern(id, fresh.pattern, step.fallbackText);
        }
      }
      return;
    }

    if (role === 'check') {
      var owner = stepById(id);
      if (!owner || !owner.repeat) return;
      setReadout(id, 'Looking on the active tab…');
      ask({ cmd: 'previewPattern', pattern: owner.repeat.pattern }).then(function (res) {
        if (!res || res.ok === false) {
          setReadout(id, sentence('Could not check — ' +
            ((res && res.error) || 'no answer from the page')), 'error');
          return;
        }
        var n = res.count;
        var text = n === 0
          ? 'Nothing on that page matches — the loop would do nothing.'
          : 'Outlined ' + n + ' element' + (n === 1 ? '' : 's') + ' on ' + trunc(res.tabTitle, 26) +
            '. Look at the page: those are exactly what the loop will act on' +
            (res.labels && res.labels.length ? ' (' + res.labels.slice(0, 3).join(', ') + (n > 3 ? ', …' : '') + ')' : '') + '.';
        setReadout(id, text, n === 0 ? 'none' : '');
      });
      return;
    }
  });

  el.notice.addEventListener('click', function (e) {
    if (!e.target || !e.target.dataset || e.target.dataset.role !== 'undo') return;
    if (!undoSnapshot) return;
    var restore = undoSnapshot.steps;
    undoSnapshot = null;
    actAndReport({ cmd: 'restoreSteps', steps: restore });
  });

  el.selectBar.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.dataset || !target.dataset.role) return;
    if (target.dataset.role === 'clearsel') { clearSelection(); return; }
    if (target.dataset.role === 'group') {
      var idxs = Object.keys(selected).filter(function (k) { return selected[k]; })
        .map(stepIndexById).filter(function (i) { return i >= 0; })
        .sort(function (a, b) { return a - b; });
      if (idxs.length < 2) return;
      if (idxs[idxs.length - 1] - idxs[0] !== idxs.length - 1) return;
      var anchor = steps[idxs[0]];
      selected = {};
      saveSet(anchor.id, { size: idxs.length, name: '', collapsed: false });
    }
  });

  el.list.addEventListener('change', function (e) {
    var target = e.target;
    if (!target || !target.dataset) return;
    if (target.dataset.role === 'missing') {
      var mStep = stepById(target.dataset.id);
      if (!mStep || !mStep.repeat) return;
      saveRepeat(mStep.id, Object.assign({}, mStep.repeat, {
        enabled: true, onMissing: target.value === 'skip' ? 'skip' : 'stop'
      }));
      return;
    }
    if (target.dataset.role === 'select') {
      selected[target.dataset.id] = target.checked;
      renderSelectionBar();
      return;
    }
    if (target.dataset.role !== 'toggle') return;
    var step = stepById(target.dataset.id);
    if (!step) return;
    if (target.checked) {
      /* Re-use what the user last tuned rather than re-deriving over the top
       * of it; only a step that has never had a pattern gets a fresh one. */
      var previous = step.repeat && String(step.repeat.pattern || '').trim() ? step.repeat : null;
      if (previous) {
        saveRepeat(step.id, {
          enabled: true, pattern: previous.pattern, maxRepeats: previous.maxRepeats,
          delaySeconds: previous.delaySeconds,
          groupSize: previous.groupSize == null ? 1 : previous.groupSize,
          onMissing: previous.onMissing === 'skip' ? 'skip' : 'stop'
        });
      } else {
        var fresh = defaultRepeat(step);
        saveRepeat(step.id, fresh);
        refinePattern(step.id, fresh.pattern, step.fallbackText);
      }
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
      delaySeconds: current.delaySeconds,
      onMissing: current.onMissing === 'skip' ? 'skip' : 'stop'
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
    if (role === 'max') target.value = String(step.repeat.maxRepeats);
    else target.value = String(step.repeat.delaySeconds);
  }, true);

  /* ------------------------------------------------------- main controls */

  function disarmClear() {
    clearArmed = false;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    el.btnClear.textContent = 'Clear';
  }

  el.btnStart.addEventListener('click', function () {
    undoSnapshot = null;
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

  /* Recording ending is the one moment there is something to look at and the
   * user has not started arranging it. Both paths that change mode come
   * through here so the offer is made exactly once. */
  var lastMode = 'idle';

  function noteMode() {
    var was = lastMode;
    lastMode = mode;
    if (was === 'recording' && mode === 'idle') offerRepeat();
  }

  function applyState(local, playState) {
    mode = (local && local.mode) || 'idle';
    redoingId = (local && local.redoStepId) || null;
    steps = Array.isArray(local && local.steps) ? local.steps : [];
    play = playState || null;
    renderStatus();
    renderButtons();
    renderNotice(local && local.notice);
    renderSkipped(local && local.skipped);
    renderSize();
    renderList(false);
    noteMode();
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
      if (changes.redoStepId) redoingId = changes.redoStepId.newValue || null;
      if (changes.steps) steps = Array.isArray(changes.steps.newValue) ? changes.steps.newValue : [];
      if (changes.notice) renderNotice(changes.notice.newValue);
      if (changes.skipped) renderSkipped(changes.skipped.newValue);
      if (changes.mode || changes.steps || changes.redoStepId) {
        renderStatus();
        renderButtons();
        renderSize();
        renderList(false);
      }
      if (changes.mode) noteMode();
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
