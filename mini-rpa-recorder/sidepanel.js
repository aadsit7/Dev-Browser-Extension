/* Mini RPA Recorder - side panel logic.
 * Manifest V3 forbids inline JavaScript, so every control on sidepanel.html is
 * wired up here with addEventListener.
 *
 * The panel is a flow canvas. Each recorded step is a card; a group of steps
 * that runs as one thing is a block drawn round its cards; and everything a
 * card or block can be told lives in a drawer that slides up when it is
 * clicked. Cards are arranged by dragging them - onto one another to make a
 * block, into and out of blocks, up and down the flow - and every arrangement
 * can be undone. */

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
    flow: document.getElementById('flow'),
    flowHint: document.getElementById('flowHint'),
    empty: document.getElementById('emptyMsg'),
    guide: document.getElementById('guide'),
    count: document.getElementById('stepCount'),
    redoBar: document.getElementById('redoBar'),
    drawer: document.getElementById('drawer'),
    libraryBox: document.getElementById('libraryBox'),
    libraryCount: document.getElementById('libraryCount'),
    libraryLoaded: document.getElementById('libraryLoaded'),
    saveName: document.getElementById('saveName'),
    btnSave: document.getElementById('btnSave'),
    libraryEmpty: document.getElementById('libraryEmpty'),
    libraryList: document.getElementById('libraryList'),
    btnImport: document.getElementById('btnImport'),
    btnExportCurrent: document.getElementById('btnExportCurrent'),
    importFile: document.getElementById('importFile'),
    storageUse: document.getElementById('storageUse')
  };

  var steps = [];
  var mode = 'idle';
  var play = null;
  var lastRenderKey = '';
  var clearArmed = false;
  var clearTimer = null;
  var countTimers = {};
  var readouts = {};          /* last "matches N" result per looping block */
  var undoSnapshot = null;    /* the whole list as it was before a delete or a move */
  var redoingId = null;       /* the step currently being re-recorded */
  var selection = null;       /* { id, view: 'step' | 'block' } - what the drawer shows */
  var drag = null;            /* { kind: 'step' | 'block', id } while a card is in the air */

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
    msg.textContent = undoSnapshot.text + ' ';
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
    return (step.tagName || 'field') + " '" + trunc(name, 30) + "'";
  }

  /* What a card says, in the present tense a flow reads in: the action first,
   * the thing it acts on underneath. */
  function titleOf(step) {
    var a = step.attrs || {};
    switch (step.type) {
      case 'click':
        /* Visible text first: "Click 'Accept'" reads better than the full
         * aria-label, which usually carries a name that varies per row. */
        return "Click '" + trunc(step.fallbackText || step.ariaLabel || a.name || step.selector ||
                                  step.tagName || 'element', 40) + "'";
      case 'input':
        /* Saying "Clear" here would be a lie: the value was withheld on
         * purpose, and the user needs to know they must type it at playback. */
        if (a.type === 'password') return 'Type the password yourself';
        if (!step.value) return 'Clear ' + fieldName(step);
        return 'Type "' + trunc(step.value, 30) + '"';
      case 'change':
        if (step.value === 'true') return 'Tick ' + fieldName(step);
        if (step.value === 'false') return 'Untick ' + fieldName(step);
        return 'Set ' + fieldName(step) + ' to "' + trunc(step.value, 24) + '"';
      case 'key':
        return 'Press ' + (step.value || 'a key');
      case 'scroll':
        return 'Scroll the page';
      case 'switchTab':
        return 'Go to tab "' + trunc(step.title || hostOf(step.url), 34) + '"';
      case 'screenshot':
        return 'Take a picture';
      default:
        return step.type;
    }
  }

  function detailOf(step) {
    var a = step.attrs || {};
    switch (step.type) {
      case 'click':
        return step.tagName || '';
      case 'input':
        if (a.type === 'password') return 'password box ' + fieldName(step) + ' — never saved';
        return step.value ? 'into ' + fieldName(step) : '';
      case 'key': {
        var name = squash(step.ariaLabel || a.name || (step.tagName !== 'body' ? step.fallbackText : ''));
        if (name) return 'in ' + (step.tagName || 'field') + " '" + trunc(name, 30) + "'";
        return step.tagName && step.tagName !== 'body' ? 'in ' + step.tagName : '';
      }
      case 'scroll':
        return 'to ' + (step.value || '0') + ' px down';
      case 'switchTab':
        return hostOf(step.url);
      case 'screenshot':
        return 'of ' + trunc(step.title || hostOf(step.url), 34);
      default:
        return '';
    }
  }

  /* Plain-English description of one recorded step, for notices. */
  function describe(step) {
    var d = detailOf(step);
    return titleOf(step) + (d ? ' ' + d : '');
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
      var box = el.drawer.querySelector('[data-fkey="' + stepId + ':pattern"]');
      if (box && box !== document.activeElement) box.value = pinned;
      refreshCount(stepId, pinned);
      if (others > 0) {
        showLocalNotice('Narrowed the match pattern for "' + trunc(titleOf(step), 40) +
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
    var v = step.repeat && step.repeat.onMissing;
    return v === 'skip' || v === 'dismiss' ? v : 'stop';
  }

  function isLooping(step) {
    return !!(step && step.repeat && step.repeat.enabled);
  }

  function setSizeOf(step) {
    if (step && step.set && step.set.size > 0) return Math.round(step.set.size);
    if (step && step.repeat && step.repeat.groupSize > 0) return Math.round(step.repeat.groupSize);
    return 1;
  }

  function shortTitle(step) {
    return titleOf(step).replace(/^(Click|Press|Type|Tick|Untick|Set|Clear) /, '').replace(/^["']|["']$/g, '');
  }

  function setNameOf(unit) {
    var first = unit.steps[0];
    if (first.set && squash(first.set.name)) return first.set.name;
    if (unit.steps.length < 2) return trunc(shortTitle(first), 30);
    var last = unit.steps[unit.steps.length - 1];
    return trunc(shortTitle(first), 20) + ' → ' + trunc(shortTitle(last), 20);
  }

  function stepById(id) {
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) return steps[i];
    return null;
  }

  function stepIndexById(id) {
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) return i;
    return -1;
  }

  /* -------------------------------------------------------- the flow model */

  /* The flow as the canvas draws it: a list of units, each a single step or
   * a block (a set, or a lone looping click). Every rearrangement is made on
   * this shape and flattened back, so a set's size can never drift from what
   * is on screen. */
  function toUnits(list) {
    var units = [];
    for (var i = 0; i < list.length; i++) {
      var step = list[i];
      var size = Math.min(setSizeOf(step), list.length - i);
      if (size > 1 || isLooping(step)) {
        units.push({ block: true, steps: list.slice(i, i + size) });
        i += size - 1;
      } else {
        units.push({ block: false, steps: [step] });
      }
    }
    return units;
  }

  /* Back to the stored shape. The first step of a block carries the set; the
   * others carry none, and a loop on one of them is switched off, because a
   * block cannot repeat inside another. */
  function flatten(units) {
    var out = [];
    units.forEach(function (u) {
      var n = u.steps.length;
      u.steps.forEach(function (s, k) {
        var copy = Object.assign({}, s);
        if (k === 0) {
          copy.set = n >= 2 ? Object.assign({ name: '', collapsed: false }, s.set || {}, { size: n }) : null;
          if (copy.repeat && copy.repeat.groupSize != null) {
            copy.repeat = Object.assign({}, copy.repeat, { groupSize: n });
          }
        } else {
          copy.set = null;
          if (isLooping(copy)) copy.repeat = Object.assign({}, copy.repeat, { enabled: false });
        }
        out.push(copy);
      });
    });
    return out;
  }

  function locate(units, id) {
    for (var u = 0; u < units.length; u++) {
      for (var k = 0; k < units[u].steps.length; k++) {
        if (units[u].steps[k].id === id) return { u: u, k: k, unit: units[u] };
      }
    }
    return null;
  }

  function cloneUnits(units) {
    return units.map(function (x) { return { block: x.block, steps: x.steps.slice() }; });
  }

  /* Lift a step, or a whole block, out of the flow. Says which unit went
   * away (if one did) and where the step came from, so a drop target that
   * was worked out before the lift can be adjusted after it. */
  function detach(units, d) {
    var loc = locate(units, d.id);
    if (!loc) return null;
    var copy = cloneUnits(units);
    var unit = copy[loc.u];
    var moved;
    var removedUnit = -1;
    if (d.kind === 'block') {
      moved = unit.steps.slice();
      copy.splice(loc.u, 1);
      removedUnit = loc.u;
    } else {
      moved = unit.steps.splice(loc.k, 1);
      if (!unit.steps.length) {
        copy.splice(loc.u, 1);
        removedUnit = loc.u;
      } else if (unit.steps.length === 1 && !isLooping(unit.steps[0])) {
        unit.block = false;
      }
    }
    return { units: copy, moved: moved, removedUnit: removedUnit, from: { u: loc.u, k: loc.k } };
  }

  function adjustTarget(target, det) {
    var t = { kind: target.kind, u: target.u, k: target.k };
    if (det.removedUnit >= 0) {
      if (t.u > det.removedUnit) t.u -= 1;
      else if (t.u === det.removedUnit && t.kind !== 'gap') return null;   /* onto itself */
    } else if (t.u === det.from.u && t.kind !== 'gap' && t.k >= 0 && t.k > det.from.k) {
      t.k -= 1;
    }
    return t;
  }

  /* Put lifted steps down: in a gap between units, inside a block at a
   * position, or onto a card (which makes a block of the two). */
  function insertMoved(units, moved, t) {
    if (t.kind === 'gap') {
      var at = Math.max(0, Math.min(t.u, units.length));
      units.splice(at, 0, { block: moved.length > 1 || isLooping(moved[0]), steps: moved });
      return units;
    }
    var unit = units[t.u];
    if (!unit) return null;
    if (moved.length > 1) return null;                 /* a block never nests */
    if (t.kind === 'in') {
      unit.block = true;
      var pos = t.k < 0 || t.k > unit.steps.length ? unit.steps.length : t.k;
      unit.steps.splice(pos, 0, moved[0]);
      return units;
    }
    /* onto a card */
    if (unit.block) {
      unit.steps.splice(Math.min(t.k, unit.steps.length - 1) + 1, 0, moved[0]);
    } else {
      units[t.u] = { block: true, steps: [unit.steps[0], moved[0]] };
    }
    return units;
  }

  function sameFlow(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
      if (setSizeOf(a[i]) !== setSizeOf(b[i])) return false;
      if (isLooping(a[i]) !== isLooping(b[i])) return false;
    }
    return true;
  }

  /* One whole-list write for any rearrangement, with an Undo. */
  function commitSteps(next, text) {
    if (sameFlow(next, steps)) return Promise.resolve(null);
    var switchedOff = next.filter(function (s) {
      var was = stepById(s.id);
      return was && isLooping(was) && !isLooping(s);
    });
    if (switchedOff.length) {
      text += ' The repeat on “' + trunc(titleOf(switchedOff[0]), 30) +
              '” was switched off: a block cannot repeat inside another, and a repeat block ' +
              'has to start with the step that repeats.';
    }
    undoSnapshot = {
      steps: steps.slice(),
      loadedFrom: loadedFrom,
      text: text,
      undoNote: 'Put the steps back as they were.'
    };
    /* The background writes no notice for this; the one with the Undo on it
     * is put up here once the write has landed. */
    return actAndReport({ cmd: 'setSteps', steps: next }).then(function (res) {
      if (res && res.ok !== false) showUndo();
      else undoSnapshot = null;
      return res;
    });
  }

  function moveText(d, target, det) {
    var what = d.kind === 'block' ? 'the block' : '“' + trunc(titleOf(det.moved[0]), 36) + '”';
    if (target.kind === 'onto') return 'Put ' + what + ' together with another step in a block.';
    if (target.kind === 'in') return 'Moved ' + what + ' into the block.';
    if (d.kind !== 'block' && det.from && units0Block(det, d)) return 'Took ' + what + ' out of the block.';
    return 'Moved ' + what + '.';
  }

  function units0Block(det, d) {
    var before = toUnits(steps);
    var loc = locate(before, d.id);
    return !!(loc && loc.unit.block && loc.unit.steps.length > 1);
  }

  /* The one path every drag and every "move" button goes through. */
  function performMove(d, target) {
    if (mode !== 'idle') return;
    var units = toUnits(steps);
    var det = detach(units, d);
    if (!det) return;
    if (d.kind === 'block' && target.kind !== 'gap') {
      showLocalNotice('A block cannot go inside another block. Drop it between steps instead.', 'warn');
      return;
    }
    var t = adjustTarget(target, det);
    if (!t) return;
    var out = insertMoved(det.units, det.moved, t);
    if (!out) return;
    commitSteps(flatten(out), moveText(d, target, det));
  }

  /* ----------------------------------------------------------- status line */

  function renderStatus() {
    var detail = '';
    el.statusMode.textContent =
      mode === 'recording' ? 'Recording'
        : mode === 'playing' ? 'Playing'
        : mode === 'redo' ? 'Re-recording'
        : mode === 'nextpage' ? 'Next page'
        : mode === 'dismiss' ? 'Close button'
        : 'Idle';

    if (mode === 'nextpage') {
      detail = 'Waiting for you to click the next-page button.';
    } else if (mode === 'dismiss') {
      detail = 'Waiting for you to click the button that closes the pop-up.';
    } else if (mode === 'redo') {
      var at = redoingId ? stepIndexById(redoingId) : -1;
      detail = at >= 0 ? 'Replacing step ' + (at + 1) + '.' : 'Replacing one step.';
    } else if (mode === 'recording') {
      detail = steps.length + ' step' + (steps.length === 1 ? '' : 's') + ' captured so far.';
    } else if (mode === 'playing' && play) {
      detail = 'Step ' + ((play.index || 0) + 1) + ' of ' + (play.total || steps.length);
      if (play.label) detail += ' — ' + play.label;
      if (play.matchLevel) detail += ' (' + play.matchLevel + ')';
    } else {
      detail = steps.length ? steps.length + ' step' + (steps.length === 1 ? '' : 's') + ' in the flow.' : 'Nothing recorded yet.';
    }
    el.statusDetail.textContent = detail;
    el.statusLine.className = 'status status-' + mode;

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

  /* Only the buttons that can actually be pressed right now are on screen. */
  function renderButtons() {
    var idle = mode === 'idle';
    var recording = mode === 'recording';
    var playing = mode === 'playing';
    var have = steps.length > 0;

    el.btnStart.disabled = !idle;
    el.btnStopRec.disabled = !recording;
    el.btnShot.disabled = !recording;
    el.btnPlay.disabled = !idle || !have;
    el.btnStopPlay.disabled = !playing;
    el.btnClear.disabled = !idle || !have;

    el.btnStart.hidden = !idle;
    el.btnStopRec.hidden = !recording;
    el.btnShot.hidden = !recording;
    el.btnPlay.hidden = !idle || !have;
    el.btnStopPlay.hidden = !playing;
    el.btnClear.hidden = !idle || !have;

    if (mode !== 'idle') disarmClear();
    renderGuide();
  }

  /* One line saying what to do next, rather than a block of description to
   * read before anything happens. */
  function renderGuide() {
    var g = el.guide;
    g.textContent = '';
    var looping = steps.some(isLooping);
    if (mode === 'playing' || mode === 'redo' || mode === 'nextpage' || mode === 'dismiss') {
      return;                 /* the status header, or the yellow bar, says it */
    }
    if (mode === 'recording') {
      g.textContent = 'Recording. Go and do the job once on the page, then press "Stop recording".';
    } else if (!steps.length) {
      ['Press Record.', 'Do the job once on the page.', 'Press "Stop recording".']
        .forEach(function (line, i) {
          var row = document.createElement('span');
          row.className = 'guide-step';
          var num = document.createElement('b');
          num.className = 'guide-num';
          num.textContent = String(i + 1);
          row.appendChild(num);
          row.appendChild(document.createTextNode(line));
          g.appendChild(row);
        });
    } else if (looping) {
      g.textContent = 'Ready. Press Play — the repeat block runs on every match on the page.';
    } else {
      g.textContent = 'Ready. Press Play to run these steps once.';
    }
  }

  function renderFlowHint() {
    var show = mode === 'idle' && steps.length >= 2;
    el.flowHint.hidden = !show;
    if (!show) return;
    var hasBlock = toUnits(steps).some(function (u) { return u.block && u.steps.length > 1; });
    el.flowHint.textContent = hasBlock
      ? 'Click a card or a block to change it. Drag cards to reorder them, into a block, or out of one.'
      : 'Click a card to change it. Drag a card to reorder it, or drop it onto another card to make a ' +
        'block that runs as one thing.';
  }

  /* --------------------------------------------------------------- notices */

  function renderNotice(n) {
    if (!n || !n.text) { el.notice.hidden = true; return; }
    el.notice.hidden = false;
    el.notice.className = 'notice notice-' + (n.kind || 'info');
    el.notice.textContent = n.text;
  }

  var skippedTabs = null;

  function renderSkipped(list) {
    if (list !== undefined) skippedTabs = list;
    list = skippedTabs;
    if (!list || !list.length || mode === 'playing') { el.skipped.hidden = true; return; }
    el.skipped.hidden = false;
    el.skipped.className = 'notice notice-warn';
    el.skipped.textContent = '';
    var head = document.createElement('strong');
    head.textContent = list.length + ' tab' + (list.length === 1 ? ' was' : 's were') +
                       ' left out. Recording only works on ordinary web pages:';
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

  /* The quota is shared by the current steps and every saved recording, so
   * the warning is about the total once Chrome can say what it is; the
   * estimate from the steps in hand stands in until then. */
  function renderSize() {
    var bytes = 0;
    try { bytes = new Blob([JSON.stringify(steps)]).size; } catch (e) { bytes = 0; }
    showSizeWarning(bytes, null);
    var area = chrome.storage && chrome.storage.local;
    if (!area || typeof area.getBytesInUse !== 'function') return;
    area.getBytesInUse(null).then(function (used) {
      showSizeWarning(bytes, used);
      renderStorageUse(used);
    }).catch(function () { /* the estimate above will do */ });
  }

  function showSizeWarning(recordingBytes, totalBytes) {
    var total = totalBytes == null ? recordingBytes : Math.max(totalBytes, recordingBytes);
    if (total <= SIZE_WARN_BYTES) { el.sizeWarn.hidden = true; return; }
    el.sizeWarn.hidden = false;
    el.sizeWarn.className = 'notice notice-warn';
    var savedShare = totalBytes != null && totalBytes - recordingBytes > 512 * 1024;
    el.sizeWarn.textContent = savedShare
      ? 'The saved recordings and the current flow take about ' + megabytes(total) + ' together, ' +
        'mostly pictures. Chrome limits extension storage to roughly 10 MB, so delete a saved ' +
        'recording or some picture steps before saving more, or the next save may fail.'
      : 'This flow is about ' + megabytes(recordingBytes) + ', mostly pictures. ' +
        'Chrome limits extension storage to roughly 10 MB, so delete some picture steps ' +
        'before adding more or the flow may fail to save.';
  }

  function renderStorageUse(used) {
    var quota = (chrome.storage.local && chrome.storage.local.QUOTA_BYTES) || 10 * 1024 * 1024;
    el.storageUse.textContent = megabytes(used) + ' of ' + Math.round(quota / (1024 * 1024)) + ' MB used';
  }

  function megabytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* ----------------------------------------------------------------- icons */

  var ICONS = {
    click: '<path d="M5 3l14 8-6 2-3 6z"/>',
    input: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h1M11 11h1M15 11h1M8 14h8"/>',
    change: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
    key: '<path d="M20 5v6a2 2 0 0 1-2 2H6"/><path d="M9 9l-4 4 4 4"/>',
    scroll: '<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>',
    switchTab: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 7h.01"/>',
    screenshot: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    group: '<path d="M4 7h16M4 12h16M4 17h10"/>'
  };

  function tile(kind) {
    var t = document.createElement('span');
    t.className = 'tile tile-' + kind;
    t.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = ICONS[kind] || ICONS.click;
    t.appendChild(svg);
    return t;
  }

  /* -------------------------------------------------------------- the flow */

  function renderKey() {
    return (redoingId || '') + '#' + steps.map(function (s) {
      return s.id + ':' + s.type + ':' + (isLooping(s) ? '1' : '0') +
             ':' + setSizeOf(s) + ':' + (s.set && s.set.collapsed ? 'c' : 'o') +
             ':' + (s.repeat && s.repeat.nextPage ? 'n' : '') +
             ':' + (s.repeat ? String(s.repeat.onMissing || '') : '') +
             ':' + (s.repeat && s.repeat.dismiss ? 'd' : '') +
             ':' + (s.type === 'screenshot' && s.dataUrl ? 'p' : '');
    }).join('|') + '#' + mode;
  }

  /* The tab is only worth naming when it changes: repeating it on every card
   * is the single biggest source of clutter in a long recording. */
  function tabChanged(index) {
    if (index <= 0) return true;
    var prev = steps[index - 1];
    var here = steps[index];
    if (!prev || !here) return true;
    return (prev.title || prev.url) !== (here.title || here.url);
  }

  function pageMark(step) {
    var mark = document.createElement('div');
    mark.className = 'page-mark';
    var text = document.createElement('span');
    text.textContent = 'on ' + tabName(step);
    text.title = step.url || '';
    mark.appendChild(text);
    return mark;
  }

  function gap(attrs, cls) {
    var g = document.createElement('div');
    g.className = 'gap' + (cls ? ' ' + cls : '');
    Object.keys(attrs).forEach(function (k) { g.dataset[k] = String(attrs[k]); });
    return g;
  }

  function buildCard(step, index, u, k, inBlock) {
    var card = document.createElement('div');
    card.className = 'card type-' + step.type;
    card.dataset.id = step.id;
    card.dataset.index = String(index);
    card.dataset.unit = String(u);
    card.dataset.k = String(k);
    card.dataset.dragKind = 'step';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', 'Step ' + (index + 1) + ': ' + describe(step));
    if (mode === 'idle') card.draggable = true;
    if (mode === 'playing' && play && play.index === index) card.classList.add('current');
    if (mode === 'redo' && redoingId === step.id) card.classList.add('redoing');
    if (selection && selection.id === step.id && (selection.view === 'step' || !inBlock)) card.classList.add('selected');

    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(index + 1);
    card.appendChild(num);

    card.appendChild(tile(step.type));

    var text = document.createElement('span');
    text.className = 'card-text';
    var title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = titleOf(step);
    title.title = describe(step);
    text.appendChild(title);
    var sub = document.createElement('span');
    sub.className = 'card-sub';
    sub.textContent = detailOf(step);
    text.appendChild(sub);
    card.appendChild(text);

    if (mode === 'idle') {
      var more = document.createElement('span');
      more.className = 'card-more';
      more.setAttribute('aria-hidden', 'true');
      more.textContent = '›';
      card.appendChild(more);
      var grip = document.createElement('span');
      grip.className = 'grip';
      grip.title = 'Drag to move this step';
      grip.setAttribute('aria-hidden', 'true');
      grip.textContent = '⋮⋮';
      card.appendChild(grip);
    }

    if (step.type === 'screenshot' && step.dataUrl) {
      card.classList.add('card-shot');
      var wrap = document.createElement('span');
      wrap.className = 'thumb-wrap';
      var img = document.createElement('img');
      img.className = 'thumb';
      img.src = step.dataUrl;
      img.alt = 'Picture taken on ' + tabName(step);
      wrap.appendChild(img);
      card.appendChild(wrap);
    }
    return card;
  }

  function buildBlock(unit, u, startIndex) {
    var anchor = unit.steps[0];
    var looping = isLooping(anchor);
    var size = unit.steps.length;
    var collapsed = size >= 2 && !!(anchor.set && anchor.set.collapsed);
    var lastId = unit.steps[size - 1].id;

    var block = document.createElement('div');
    block.className = 'block' + (looping ? ' looping' : '');
    block.dataset.id = anchor.id;
    block.dataset.unit = String(u);
    if (selection && selection.id === anchor.id && selection.view === 'block') block.classList.add('selected');

    var head = document.createElement('div');
    head.className = 'block-head';
    head.dataset.id = anchor.id;
    head.dataset.unit = String(u);
    head.dataset.last = lastId;
    head.dataset.dragKind = 'block';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    if (mode === 'idle') head.draggable = true;

    head.appendChild(tile(looping ? 'repeat' : 'group'));

    var text = document.createElement('span');
    text.className = 'card-text';
    var title = document.createElement('span');
    title.className = 'block-title';
    title.textContent = looping ? 'Repeat for each match' : 'Group';
    text.appendChild(title);
    var sub = document.createElement('span');
    sub.className = 'card-sub';
    sub.textContent = setNameOf(unit) + ' · ' + size + ' step' + (size === 1 ? '' : 's');
    text.appendChild(sub);
    head.appendChild(text);

    if (looping) {
      var chip = document.createElement('span');
      chip.className = 'count-chip';
      chip.dataset.countFor = anchor.id;
      var known = readouts[anchor.id];
      chip.textContent = known ? known.chip : '…';
      if (known && known.kind) chip.classList.add(known.kind);
      chip.title = 'How many elements the repeat would act on, on the page in the active tab';
      head.appendChild(chip);
    }

    if (size >= 2) {
      var chev = document.createElement('button');
      chev.type = 'button';
      chev.className = 'chev';
      chev.dataset.role = 'collapse';
      chev.dataset.id = anchor.id;
      chev.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      chev.title = collapsed ? 'Show the steps in this block' : 'Hide the steps in this block';
      chev.textContent = collapsed ? '▸' : '▾';
      head.appendChild(chev);
    }

    if (mode === 'idle') {
      var grip = document.createElement('span');
      grip.className = 'grip';
      grip.title = 'Drag to move the whole block';
      grip.setAttribute('aria-hidden', 'true');
      grip.textContent = '⋮⋮';
      head.appendChild(grip);
    }
    block.appendChild(head);

    if (collapsed) {
      var note = document.createElement('div');
      note.className = 'block-collapsed-note';
      note.textContent = size + ' steps hidden — press ▸ to show them.';
      block.appendChild(note);
    } else {
      var body = document.createElement('div');
      body.className = 'block-body';
      unit.steps.forEach(function (s, k) {
        body.appendChild(gap({ blockUnit: u, k: k }, k === 0 ? 'gap-first' : ''));
        body.appendChild(buildCard(s, startIndex + k, u, k, true));
      });
      body.appendChild(gap({ blockUnit: u, k: size }, 'gap-last'));
      block.appendChild(body);
    }

    var drop = document.createElement('div');
    drop.className = 'block-drop';
    drop.dataset.unit = String(u);
    drop.textContent = 'Drop a step here to add it to this block';
    block.appendChild(drop);
    return block;
  }

  function renderFlow(force) {
    /* Not a rendering concern, and it must not be skipped by the no-change
     * shortcut below: a re-recorded step keeps the same shape, so the key can
     * be identical while the loop is still waiting for a usable pattern. */
    fulfilPendingPatterns();

    var key = renderKey();
    if (!force && key === lastRenderKey) {
      highlightCurrent();
      markSelected();
      renderDrawer();
      return;
    }
    lastRenderKey = key;

    el.flow.textContent = '';
    var units = toUnits(steps);
    var index = 0;
    units.forEach(function (unit, u) {
      el.flow.appendChild(gap({ gap: u }, u === 0 ? 'gap-first' : ''));
      if (tabChanged(index) && unit.steps[0].type !== 'switchTab') el.flow.appendChild(pageMark(unit.steps[0]));
      if (unit.block) el.flow.appendChild(buildBlock(unit, u, index));
      else el.flow.appendChild(buildCard(unit.steps[0], index, u, 0, false));
      index += unit.steps.length;
    });
    if (units.length) el.flow.appendChild(gap({ gap: units.length }, 'gap-last'));

    el.empty.hidden = steps.length > 0;
    el.count.textContent = String(steps.length);
    renderFlowHint();
    renderRedoBar();
    renderDrawer();

    /* While recording, the step that just happened is the one worth seeing;
     * otherwise the list quietly fills up out of sight. */
    if (mode === 'recording') {
      var cards = el.flow.querySelectorAll('.card');
      if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'nearest' });
    }

    if (mode !== 'playing') {
      steps.forEach(function (step) {
        if (isLooping(step)) refreshCount(step.id, step.repeat.pattern);
      });
    }
  }

  function highlightCurrent() {
    var cards = el.flow.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var idx = Number(cards[i].dataset.index);
      cards[i].classList.toggle('current', mode === 'playing' && !!play && play.index === idx);
    }
    el.count.textContent = String(steps.length);
  }

  function markSelected() {
    var nodes = el.flow.querySelectorAll('.card, .block');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var isBlock = n.classList.contains('block');
      var on = !!selection && selection.id === n.dataset.id &&
               (isBlock ? selection.view === 'block'
                        : (selection.view === 'step' || !n.closest('.block')));
      n.classList.toggle('selected', on);
    }
  }

  /* ------------------------------------------------- live "matches N" line */

  function sentence(text) {
    var t = squash(text);
    return /[.!?]$/.test(t) ? t : t + '.';
  }

  function setReadout(stepId, text, kind, chipText) {
    readouts[stepId] = { text: text, kind: kind || '', chip: chipText || '…' };
    var node = el.drawer.querySelector('[data-readout-for="' + stepId + '"]');
    if (node) {
      node.className = 'readout' + (kind ? ' readout-' + kind : '');
      node.textContent = text;
    }
    var chip = el.flow.querySelector('[data-count-for="' + stepId + '"]');
    if (chip) {
      chip.className = 'count-chip' + (kind ? ' ' + kind : '');
      chip.textContent = chipText || '…';
    }
  }

  function refreshCount(stepId, pattern) {
    if (countTimers[stepId]) clearTimeout(countTimers[stepId]);
    countTimers[stepId] = setTimeout(function () {
      delete countTimers[stepId];
      if (!String(pattern || '').trim()) {
        setReadout(stepId, 'Enter a match pattern to see how many elements it finds.', 'error', 'no pattern');
        return;
      }
      ask({ cmd: 'countMatches', pattern: pattern }).then(function (res) {
        if (!res || res.ok === false) {
          setReadout(stepId, sentence('Cannot count right now — ' +
            ((res && res.error) || 'no answer from the page')), 'error', 'no page');
          return;
        }
        var n = res.count;
        setReadout(
          stepId,
          'Found ' + n + ' match' + (n === 1 ? '' : 'es') + ' on this page' +
            (res.tabTitle ? ' (' + trunc(res.tabTitle, 30) + ')' : '') + '.',
          n === 0 ? 'none' : '',
          n + ' match' + (n === 1 ? '' : 'es')
        );
      });
    }, COUNT_DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------- drawer */

  function openDrawer(id, view) {
    if (mode !== 'idle') return;
    selection = { id: id, view: view };
    markSelected();
    renderDrawer();
    var node = el.flow.querySelector(view === 'block' ? '.block[data-id="' + id + '"]' : '.card[data-id="' + id + '"]');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  function closeDrawer() {
    selection = null;
    el.drawer.hidden = true;
    el.drawer.textContent = '';
    document.body.classList.remove('drawer-open');
    markSelected();
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
    var target = el.drawer.querySelector('[data-fkey="' + snap.key.replace(/"/g, '\\"') + '"]');
    if (!target) return;
    target.focus();
    if (snap.start != null) {
      try { target.setSelectionRange(snap.start, snap.end); } catch (e) { /* not supported */ }
    }
  }

  function renderDrawer() {
    if (!selection || mode !== 'idle') {
      if (!el.drawer.hidden) closeDrawer();
      return;
    }
    var units = toUnits(steps);
    var loc = locate(units, selection.id);
    if (!loc) { closeDrawer(); return; }
    /* A step that stopped being a block, or became one, changes which view
     * makes sense; follow it rather than show an empty drawer. */
    var view = selection.view;
    if (view === 'block' && !(loc.unit.block && loc.k === 0)) view = 'step';
    selection.view = view;

    var snap = captureFocus();
    var scrollTop = el.drawer.scrollTop;
    el.drawer.hidden = false;
    document.body.classList.add('drawer-open');
    el.drawer.textContent = '';
    if (view === 'block') buildBlockDrawer(loc, units);
    else buildStepDrawer(loc, units);
    el.drawer.scrollTop = scrollTop;
    restoreFocus(snap);
  }

  function drawerHead(kind, title, sub) {
    var head = document.createElement('div');
    head.className = 'drawer-head';
    head.appendChild(tile(kind));
    var text = document.createElement('div');
    text.className = 'drawer-text';
    var t = document.createElement('div');
    t.className = 'drawer-title';
    t.textContent = title;
    t.title = title;
    text.appendChild(t);
    var s = document.createElement('div');
    s.className = 'drawer-sub';
    s.textContent = sub;
    text.appendChild(s);
    head.appendChild(text);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'drawer-close';
    close.dataset.role = 'close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    head.appendChild(close);
    return head;
  }

  function section(labelText) {
    var s = document.createElement('div');
    s.className = 'drawer-section';
    if (labelText) {
      var label = document.createElement('p');
      label.className = 'drawer-label';
      label.textContent = labelText;
      s.appendChild(label);
    }
    return s;
  }

  function actionButton(role, id, glyph, text, opts) {
    opts = opts || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-btn' + (opts.wide ? ' wide' : '') + (opts.danger ? ' danger' : '');
    b.dataset.role = role;
    if (id) b.dataset.id = id;
    if (opts.extra) Object.keys(opts.extra).forEach(function (k) { b.dataset[k] = opts.extra[k]; });
    if (opts.title) b.title = opts.title;
    if (opts.disabled) b.disabled = true;
    var g = document.createElement('span');
    g.className = 'glyph';
    g.setAttribute('aria-hidden', 'true');
    g.textContent = glyph;
    b.appendChild(g);
    b.appendChild(document.createTextNode(text));
    return b;
  }

  function miniButton(role, id, text, title, danger) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini-btn' + (danger ? ' danger' : '');
    b.dataset.role = role;
    b.dataset.id = id;
    b.textContent = text;
    if (title) b.title = title;
    return b;
  }

  function switchRow(role, id, on, title, subtitle, disabled) {
    var row = document.createElement('div');
    row.className = 'switch-row';
    var text = document.createElement('div');
    text.className = 'switch-text';
    var b = document.createElement('b');
    b.textContent = title;
    text.appendChild(b);
    var s = document.createElement('span');
    s.textContent = subtitle;
    text.appendChild(s);
    row.appendChild(text);
    var sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'switch';
    sw.dataset.role = role;
    sw.dataset.id = id;
    sw.setAttribute('aria-pressed', on ? 'true' : 'false');
    sw.setAttribute('aria-label', title);
    if (disabled) sw.disabled = true;
    row.appendChild(sw);
    return row;
  }

  function facts(pairs) {
    var dl = document.createElement('dl');
    dl.className = 'facts';
    pairs.forEach(function (p) {
      if (!p[1]) return;
      var dt = document.createElement('dt');
      dt.textContent = p[0];
      var dd = document.createElement('dd');
      if (p[2] === 'code') {
        var code = document.createElement('code');
        code.textContent = p[1];
        dd.appendChild(code);
      } else dd.textContent = p[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    return dl;
  }

  /* ---- the drawer for one step ---------------------------------------- */

  function buildStepDrawer(loc, units) {
    var step = loc.unit.steps[loc.k];
    var index = stepIndexById(step.id);
    var inBlock = loc.unit.block && loc.unit.steps.length > 1;
    var d = el.drawer;

    d.appendChild(drawerHead(step.type, titleOf(step),
      'Step ' + (index + 1) + ' of ' + steps.length + (inBlock ? ' · in a block' : '')));

    var about = section('About this step');
    var a = step.attrs || {};
    var pairs = [
      ['Page', tabName(step)],
      ['Element', step.type === 'switchTab' || step.type === 'screenshot' || step.type === 'scroll' ? '' :
        (step.tagName || '') + (step.ariaLabel ? ' labelled "' + trunc(step.ariaLabel, 40) + '"'
          : step.fallbackText ? ' "' + trunc(step.fallbackText, 40) + '"'
          : a.name ? ' named "' + trunc(a.name, 30) + '"' : '')],
      ['Found by', step.selector, 'code'],
      ['Typed', step.type === 'input' && step.value ? trunc(step.value, 80) : ''],
      ['Note', step.note || (a.type === 'password' ? 'The password is never saved. At playback the box is focused for you to type it.' : '')]
    ];
    about.appendChild(facts(pairs));
    if (step.type === 'screenshot' && step.dataUrl) {
      var img = document.createElement('img');
      img.className = 'thumb';
      img.src = step.dataUrl;
      img.alt = 'Picture taken on ' + tabName(step);
      about.appendChild(img);
    }
    d.appendChild(about);

    /* Looping a single click should not require grouping it with anything. */
    if (step.type === 'click' && !inBlock) {
      var rep = section('');
      rep.appendChild(switchRow('loop', step.id, isLooping(step), 'Repeat for each match',
        'Run this click once for every element like it on the page, scrolling for more as it goes.'));
      d.appendChild(rep);
    }

    var arrange = section('Arrange');
    var grid = document.createElement('div');
    grid.className = 'action-grid';
    var u = loc.u;
    var k = loc.k;
    var atTop = inBlock ? (k === 0 && u === 0) : u === 0;
    var atBottom = inBlock ? (k === loc.unit.steps.length - 1 && u === units.length - 1) : u === units.length - 1;
    grid.appendChild(actionButton('moveup', step.id, '↑', 'Move up', { disabled: atTop }));
    grid.appendChild(actionButton('movedown', step.id, '↓', 'Move down', { disabled: atBottom }));
    if (inBlock) {
      grid.appendChild(actionButton('takeout', step.id, '⇱', 'Take out of the block', { wide: true }));
    } else {
      var above = u > 0 ? units[u - 1] : null;
      var below = u < units.length - 1 ? units[u + 1] : null;
      grid.appendChild(actionButton('groupabove', step.id, '⤴',
        above && above.block ? 'Add to the block above' : 'Group with the step above',
        { disabled: !above }));
      grid.appendChild(actionButton('groupbelow', step.id, '⤵',
        below && below.block ? 'Add to the block below' : 'Group with the step below',
        { disabled: !below }));
    }
    arrange.appendChild(grid);
    d.appendChild(arrange);

    var acts = section('');
    var grid2 = document.createElement('div');
    grid2.className = 'action-grid';
    grid2.appendChild(actionButton('redo', step.id, '↻', 'Re-record this step',
      { title: 'Do this one action again on the page and replace this step with it' }));
    grid2.appendChild(actionButton('delete', step.id, '×', 'Delete this step', { danger: true }));
    acts.appendChild(grid2);
    d.appendChild(acts);
  }

  /* ---- the drawer for a block ----------------------------------------- */

  function buildBlockDrawer(loc, units) {
    var unit = loc.unit;
    var anchor = unit.steps[0];
    var looping = isLooping(anchor);
    var size = unit.steps.length;
    var first = stepIndexById(anchor.id);
    var d = el.drawer;
    var r = anchor.repeat || {};

    d.appendChild(drawerHead(looping ? 'repeat' : 'group',
      looping ? 'Repeat for each match' : 'Group of ' + size + ' step' + (size === 1 ? '' : 's'),
      setNameOf(unit) + ' · step' + (size === 1 ? ' ' + (first + 1) : 's ' + (first + 1) + '–' + (first + size))));

    var rep = section('');
    rep.appendChild(switchRow('loop', anchor.id, looping, 'Repeat for each match',
      anchor.type === 'click'
        ? 'Run these steps once for every element like the first one on the page, scrolling for more as it goes.'
        : 'Repeating needs the block to start with a click - the thing that is on every row.',
      anchor.type !== 'click'));
    d.appendChild(rep);

    if (looping) {
      var how = section('How it repeats');

      var count = document.createElement('div');
      count.className = 'row';
      count.appendChild(labelSpan('Repeat up to'));
      var times = document.createElement('input');
      times.type = 'number';
      times.min = '1';
      times.max = String(MAX_REPEATS_CEILING);
      times.step = '1';
      times.className = 'field-inline';
      times.value = String(r.maxRepeats || DEFAULT_MAX_REPEATS);
      times.dataset.fkey = anchor.id + ':max';
      times.dataset.role = 'max';
      times.dataset.id = anchor.id;
      times.setAttribute('aria-label', 'Repeat up to this many times');
      count.appendChild(times);
      count.appendChild(labelSpan('times'));
      var actions = document.createElement('span');
      actions.className = 'row-actions';
      actions.appendChild(miniButton('check', anchor.id, 'Show me on the page',
        'Outline every element this repeat would act on, without clicking any of them'));
      count.appendChild(actions);
      var readout = document.createElement('span');
      readout.className = 'readout';
      readout.dataset.readoutFor = anchor.id;
      var known = readouts[anchor.id];
      if (known) {
        readout.textContent = known.text;
        if (known.kind) readout.className += ' readout-' + known.kind;
      } else readout.textContent = 'Checking the active tab…';
      count.appendChild(readout);
      how.appendChild(count);

      how.appendChild(buildNextPageRow(anchor));
      how.appendChild(buildMissingRow(anchor));
      how.appendChild(buildAdvanced(anchor));
      d.appendChild(how);
    }

    var members = section('Steps in this block');
    var grid = document.createElement('div');
    grid.className = 'action-grid';
    var u = loc.u;
    var below = u < units.length - 1 ? units[u + 1] : null;
    grid.appendChild(actionButton('moveup', anchor.id, '↑', 'Move up', { disabled: u === 0, extra: { kind: 'block' } }));
    grid.appendChild(actionButton('movedown', anchor.id, '↓', 'Move down', { disabled: u === units.length - 1, extra: { kind: 'block' } }));
    grid.appendChild(actionButton('grow', anchor.id, '+', 'Add the step below', {
      disabled: !below || below.block,
      title: below && below.block ? 'The step below is a block of its own - split it first' : 'Bring the next step into this block'
    }));
    grid.appendChild(actionButton('shrink', anchor.id, '−', 'Take the last step out', { disabled: size < 2 }));
    if (size >= 2) {
      grid.appendChild(actionButton('collapse', anchor.id, anchor.set && anchor.set.collapsed ? '▾' : '▸',
        anchor.set && anchor.set.collapsed ? 'Show the steps' : 'Hide the steps'));
      grid.appendChild(actionButton('ungroup', anchor.id, '⇲', 'Split into single steps'));
    }
    grid.appendChild(actionButton('deleteblock', anchor.id, '×',
      'Delete ' + (size === 1 ? 'this step' : 'these ' + size + ' steps'), { danger: true, wide: true }));
    members.appendChild(grid);
    d.appendChild(members);
  }

  function labelSpan(text) {
    var s = document.createElement('span');
    s.className = 'row-label';
    s.textContent = text;
    return s;
  }

  function describeControl(control) {
    var name = squash(control.fallbackText || control.ariaLabel ||
                      (control.attrs && control.attrs.name) || control.selector || 'it');
    return "'" + trunc(name, 30) + "'";
  }

  /* What to do when this page has nothing left. */
  function buildNextPageRow(step) {
    var row = document.createElement('div');
    row.className = 'row';
    row.appendChild(labelSpan('At the end of the page:'));
    var control = step.repeat && step.repeat.nextPage;
    var actions = document.createElement('span');
    actions.className = 'row-actions';
    if (control) {
      var what = document.createElement('span');
      what.className = 'row-what';
      what.textContent = 'go to the next page (clicks ' + describeControl(control) + ')';
      row.appendChild(what);
      actions.appendChild(miniButton('nextpage', step.id, 'Change',
        'Record a different control to press when the page runs out'));
      actions.appendChild(miniButton('clearnextpage', step.id, 'Remove',
        'Stop when the page runs out, instead of going on', true));
    } else {
      var stops = document.createElement('span');
      stops.className = 'row-none';
      stops.textContent = 'it stops.';
      row.appendChild(stops);
      actions.appendChild(miniButton('nextpage', step.id, 'Go to the next page instead',
        'Record the button that shows the next page, and keep going there'));
    }
    row.appendChild(actions);
    return row;
  }

  /* What to do when a step in the pass cannot be found - which, on a list,
   * usually means the click brought up a pop-up other than the one recorded. */
  var MISSING_CHOICES = [
    ['stop', 'stop and tell me'],
    ['dismiss', 'close the pop-up and move on to the next one'],
    ['skip', 'skip that step and carry on with the rest']
  ];

  function buildMissingRow(step) {
    var row = document.createElement('div');
    row.className = 'row';
    row.appendChild(labelSpan('If a step is missing:'));

    var select = document.createElement('select');
    select.className = 'select-inline';
    select.dataset.fkey = step.id + ':missing';
    select.dataset.role = 'missing';
    select.dataset.id = step.id;
    select.setAttribute('aria-label', 'What to do when a step in the pass cannot be found');
    MISSING_CHOICES.forEach(function (pair) {
      var opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (pair[0] === onMissingOf(step)) opt.selected = true;
      select.appendChild(opt);
    });
    row.appendChild(select);

    if (onMissingOf(step) === 'dismiss') {
      var control = step.repeat && step.repeat.dismiss;
      var how = document.createElement('span');
      how.className = 'row-hint';
      how.textContent = control
        ? 'Closes it by clicking ' + describeControl(control) + ', then Escape or its own Cancel or Close if that fails.'
        : 'Closes it with Escape, or a Cancel, Close or Dismiss button of its own.';
      row.appendChild(how);
      var actions = document.createElement('span');
      actions.className = 'row-actions';
      actions.appendChild(miniButton('dismissrec', step.id, control ? 'Change' : 'Record the button to press',
        'Bring the pop-up up on the page and click the button that closes it; the next click is what gets saved'));
      if (control) {
        actions.appendChild(miniButton('cleardismiss', step.id, 'Remove',
          'Go back to Escape and the pop-up\'s own Cancel or Close button', true));
      }
      row.appendChild(actions);
    }
    return row;
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

  function buildAdvanced(step) {
    var wrap = document.createElement('details');
    wrap.className = 'advanced';
    var sum = document.createElement('summary');
    sum.textContent = 'Advanced settings — most people never need these';
    wrap.appendChild(sum);

    var r = step.repeat || {};
    var pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.value = r.pattern || '';
    pattern.spellcheck = false;
    pattern.dataset.fkey = step.id + ':pattern';
    pattern.dataset.role = 'pattern';
    pattern.dataset.id = step.id;
    wrap.appendChild(makeField('Which things to repeat on', pattern));

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

    var delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = String(DELAY_FLOOR_SECONDS);
    delayInput.step = '0.1';
    delayInput.value = String(r.delaySeconds == null ? DEFAULT_DELAY_SECONDS : r.delaySeconds);
    delayInput.dataset.fkey = step.id + ':delay';
    delayInput.dataset.role = 'delay';
    delayInput.dataset.id = step.id;
    wrap.appendChild(makeField('Seconds to wait between clicks', delayInput));

    var limits = document.createElement('p');
    limits.className = 'hint';
    limits.textContent = 'Whatever you type, a repeat never runs more than ' + MAX_REPEATS_CEILING +
      ' times or waits less than ' + DELAY_FLOOR_SECONDS + ' seconds between turns. Sites rate-limit ' +
      'rapid automated clicking and some restrict accounts for it.';
    wrap.appendChild(limits);
    return wrap;
  }

  /* ---- what the drawer's controls do ----------------------------------- */

  el.drawer.addEventListener('click', function (e) {
    var target = e.target.closest ? e.target.closest('[data-role]') : null;
    if (!target || !el.drawer.contains(target)) return;
    var role = target.dataset.role;
    var id = target.dataset.id;

    if (role === 'close') { closeDrawer(); return; }

    if (role === 'redo') {
      undoSnapshot = null;
      closeDrawer();
      actAndReport({ cmd: 'startRedo', id: id });
      return;
    }

    if (role === 'nextpage') {
      undoSnapshot = null;
      actAndReport({ cmd: 'startNextPage', id: id });
      return;
    }

    if (role === 'clearnextpage') { actAndReport({ cmd: 'clearNextPage', id: id }); return; }

    if (role === 'dismissrec') {
      undoSnapshot = null;
      actAndReport({ cmd: 'startDismiss', id: id });
      return;
    }

    if (role === 'cleardismiss') { actAndReport({ cmd: 'clearDismiss', id: id }); return; }

    if (role === 'delete') {
      /* The flow is built by hand and the button has no confirm, so keep the
       * whole list as it was. Snapshotting everything rather than the one step
       * also restores any block that shrank around it. */
      var doomed = stepById(id);
      undoSnapshot = {
        steps: steps.slice(),
        loadedFrom: loadedFrom,
        text: 'Deleted “' + trunc(doomed ? titleOf(doomed) : 'that step', 40) + '”.'
      };
      closeDrawer();
      actAndReport({ cmd: 'deleteStep', id: id }).then(function (res) {
        if (res && res.ok !== false) showUndo();
      });
      return;
    }

    if (role === 'deleteblock') {
      var units = toUnits(steps);
      var loc = locate(units, id);
      if (!loc) return;
      var gone = {};
      loc.unit.steps.forEach(function (s) { gone[s.id] = true; });
      var kept = steps.filter(function (s) { return !gone[s.id]; });
      closeDrawer();
      commitSteps(kept, 'Deleted the block (' + loc.unit.steps.length + ' step' +
                        (loc.unit.steps.length === 1 ? '' : 's') + ').');
      return;
    }

    if (role === 'collapse') {
      var s = stepById(id);
      if (!s) return;
      saveSet(id, Object.assign({}, s.set || { size: setSizeOf(s) }, { collapsed: !(s.set && s.set.collapsed) }));
      return;
    }

    if (role === 'ungroup') {
      /* The first step keeps its repeat, so it goes on as a block of one. */
      saveSet(id, null);
      return;
    }

    if (role === 'grow') {
      var gu = toUnits(steps);
      var gl = locate(gu, id);
      var next = gl && gl.u < gu.length - 1 ? gu[gl.u + 1] : null;
      if (!next || next.block) return;
      performMove({ kind: 'step', id: next.steps[0].id }, { kind: 'in', u: gl.u, k: -1 });
      return;
    }

    if (role === 'shrink') {
      var su = toUnits(steps);
      var sl = locate(su, id);
      if (!sl || sl.unit.steps.length < 2) return;
      performMove({ kind: 'step', id: sl.unit.steps[sl.unit.steps.length - 1].id }, { kind: 'gap', u: sl.u + 1 });
      return;
    }

    if (role === 'takeout') {
      var tu = toUnits(steps);
      var tl = locate(tu, id);
      if (!tl) return;
      performMove({ kind: 'step', id: id }, { kind: 'gap', u: tl.u + 1 });
      return;
    }

    if (role === 'moveup' || role === 'movedown') {
      moveBy(id, target.dataset.kind === 'block' ? 'block' : 'step', role === 'moveup' ? -1 : 1);
      return;
    }

    if (role === 'groupabove' || role === 'groupbelow') {
      groupWithNeighbour(id, role === 'groupabove' ? -1 : 1);
      return;
    }

    if (role === 'loop') {
      var step = stepById(id);
      if (!step || step.type !== 'click') return;
      if (isLooping(step)) {
        saveRepeat(id, Object.assign({}, step.repeat, { enabled: false }));
        if (setSizeOf(step) < 2) selection = { id: id, view: 'step' };
      } else {
        var previous = step.repeat && squash(step.repeat.pattern) ? step.repeat : null;
        if (previous) {
          saveRepeat(id, Object.assign({}, previous, { enabled: true }));
        } else {
          var fresh = defaultRepeat(step);
          saveRepeat(id, fresh);
          refinePattern(id, fresh.pattern, step.fallbackText);
        }
        selection = { id: id, view: 'block' };
      }
      return;
    }

    if (role === 'check') {
      var owner = stepById(id);
      if (!owner || !owner.repeat) return;
      setReadout(id, 'Looking on the active tab…', '', readouts[id] ? readouts[id].chip : '…');
      ask({ cmd: 'previewPattern', pattern: owner.repeat.pattern }).then(function (res) {
        if (!res || res.ok === false) {
          setReadout(id, sentence('Could not check — ' +
            ((res && res.error) || 'no answer from the page')), 'error', 'no page');
          return;
        }
        var n = res.count;
        var text = n === 0
          ? 'Nothing on that page matches — the repeat would do nothing.'
          : 'Outlined ' + n + ' element' + (n === 1 ? '' : 's') + ' on ' + trunc(res.tabTitle, 26) +
            '. Look at the page: those are exactly what the repeat will act on' +
            (res.labels && res.labels.length ? ' (' + res.labels.slice(0, 3).join(', ') + (n > 3 ? ', …' : '') + ')' : '') + '.';
        setReadout(id, text, n === 0 ? 'none' : '', n + ' match' + (n === 1 ? '' : 'es'));
      });
      return;
    }
  });

  function moveBy(id, kind, dir) {
    var units = toUnits(steps);
    var loc = locate(units, id);
    if (!loc) return;
    var target;
    if (kind === 'block' || !(loc.unit.block && loc.unit.steps.length > 1)) {
      target = { kind: 'gap', u: dir < 0 ? loc.u - 1 : loc.u + 2 };
      if (target.u < 0) return;
    } else if (dir < 0) {
      target = loc.k > 0 ? { kind: 'in', u: loc.u, k: loc.k - 1 } : { kind: 'gap', u: loc.u };
    } else {
      target = loc.k < loc.unit.steps.length - 1 ? { kind: 'in', u: loc.u, k: loc.k + 2 } : { kind: 'gap', u: loc.u + 1 };
    }
    performMove({ kind: kind, id: id }, target);
  }

  function groupWithNeighbour(id, dir) {
    var units = toUnits(steps);
    var loc = locate(units, id);
    if (!loc) return;
    var nu = loc.u + dir;
    if (nu < 0 || nu >= units.length) return;
    var other = units[nu];
    if (other.block) {
      performMove({ kind: 'step', id: id }, { kind: 'in', u: nu, k: dir < 0 ? -1 : 0 });
    } else if (dir < 0) {
      performMove({ kind: 'step', id: id }, { kind: 'onto', u: nu, k: 0 });
    } else {
      performMove({ kind: 'step', id: other.steps[0].id }, { kind: 'onto', u: loc.u, k: 0 });
    }
  }

  el.drawer.addEventListener('change', function (e) {
    var target = e.target;
    if (!target || !target.dataset || target.dataset.role !== 'missing') return;
    var mStep = stepById(target.dataset.id);
    if (!mStep || !mStep.repeat) return;
    var choice = target.value === 'skip' || target.value === 'dismiss' ? target.value : 'stop';
    saveRepeat(mStep.id, Object.assign({}, mStep.repeat, { enabled: true, onMissing: choice }));
  });

  el.drawer.addEventListener('input', function (e) {
    var target = e.target;
    if (!target || !target.dataset || !target.dataset.role) return;
    var role = target.dataset.role;
    if (role !== 'pattern' && role !== 'max' && role !== 'delay') return;

    var step = stepById(target.dataset.id);
    if (!step) return;
    var current = step.repeat || defaultRepeat(step);
    /* Built on what is there, not from a fixed list of fields: a next-page
     * control or a close button recorded before this edit has to survive it. */
    var updated = Object.assign({}, current, { enabled: true });

    if (role === 'pattern') {
      updated.pattern = target.value;
      refreshCount(step.id, updated.pattern);
    } else if (role === 'max') {
      var m = parseInt(target.value, 10);
      updated.maxRepeats = isNaN(m) ? DEFAULT_MAX_REPEATS : Math.min(MAX_REPEATS_CEILING, Math.max(1, m));
    } else {
      var dv = parseFloat(target.value);
      updated.delaySeconds = isNaN(dv) ? DEFAULT_DELAY_SECONDS : Math.max(DELAY_FLOOR_SECONDS, dv);
    }
    step.repeat = updated;
    saveRepeat(step.id, updated);
  });

  /* Clamp the visible value once the user leaves the box, so the field always
   * shows the number that will actually be used. */
  el.drawer.addEventListener('blur', function (e) {
    var target = e.target;
    if (!target || !target.dataset) return;
    var role = target.dataset.role;
    if (role !== 'max' && role !== 'delay') return;
    var step = stepById(target.dataset.id);
    if (!step || !step.repeat) return;
    if (role === 'max') target.value = String(step.repeat.maxRepeats);
    else target.value = String(step.repeat.delaySeconds);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && selection && !e.defaultPrevented) {
      var active = document.activeElement;
      if (active && el.drawer.contains(active) && active.tagName === 'INPUT') return;
      closeDrawer();
    }
  });

  /* --------------------------------------------------- clicks on the flow */

  el.flow.addEventListener('click', function (e) {
    var target = e.target;
    if (mode !== 'idle') return;
    var roleEl = target.closest ? target.closest('[data-role]') : null;
    if (roleEl && roleEl.dataset.role === 'collapse') {
      var s = stepById(roleEl.dataset.id);
      if (s) saveSet(s.id, Object.assign({}, s.set || { size: setSizeOf(s) }, { collapsed: !(s.set && s.set.collapsed) }));
      return;
    }
    if (target.closest && target.closest('.grip')) return;
    var head = target.closest ? target.closest('.block-head') : null;
    if (head) { openDrawer(head.dataset.id, 'block'); return; }
    var card = target.closest ? target.closest('.card') : null;
    if (card) {
      if (selection && selection.id === card.dataset.id && selection.view === 'step') closeDrawer();
      else openDrawer(card.dataset.id, 'step');
    }
  });

  el.flow.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (!t || !t.classList) return;
    if (t.classList.contains('card')) { e.preventDefault(); openDrawer(t.dataset.id, 'step'); }
    else if (t.classList.contains('block-head')) { e.preventDefault(); openDrawer(t.dataset.id, 'block'); }
  });

  /* ---------------------------------------------------------- drag and drop */

  function dropTargetAt(node) {
    var z = node && node.closest ? node.closest('.gap, .block-drop, .card, .block-head') : null;
    if (!z || !el.flow.contains(z)) return null;
    if (z.classList.contains('gap')) {
      if (z.dataset.blockUnit != null) return { kind: 'in', u: Number(z.dataset.blockUnit), k: Number(z.dataset.k), el: z };
      return { kind: 'gap', u: Number(z.dataset.gap), el: z };
    }
    if (z.classList.contains('block-drop')) return { kind: 'in', u: Number(z.dataset.unit), k: -1, el: z };
    if (z.classList.contains('block-head')) return { kind: 'in', u: Number(z.dataset.unit), k: -1, el: z.parentNode };
    return { kind: 'onto', u: Number(z.dataset.unit), k: Number(z.dataset.k), el: z };
  }

  function allowed(target) {
    if (!drag || !target) return false;
    if (drag.kind === 'block' && target.kind !== 'gap') return false;
    if (target.kind === 'onto' && target.el.dataset.id === drag.id) return false;
    return true;
  }

  var overEl = null;

  function markOver(node) {
    if (overEl === node) return;
    if (overEl) overEl.classList.remove('over');
    overEl = node;
    if (overEl) overEl.classList.add('over');
  }

  function endDrag() {
    drag = null;
    markOver(null);
    document.body.classList.remove('dragging');
    var src = el.flow.querySelector('.dragging-src');
    if (src) src.classList.remove('dragging-src');
  }

  el.flow.addEventListener('dragstart', function (e) {
    var handle = e.target.closest ? e.target.closest('[draggable="true"]') : null;
    if (!handle || mode !== 'idle') { e.preventDefault(); return; }
    drag = { kind: handle.dataset.dragKind === 'block' ? 'block' : 'step', id: handle.dataset.id };
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.id);
    } catch (err) { /* some browsers refuse; the drag still works */ }
    document.body.classList.add('dragging');
    (drag.kind === 'block' ? handle.parentNode : handle).classList.add('dragging-src');
  });

  el.flow.addEventListener('dragover', function (e) {
    if (!drag) return;
    var target = dropTargetAt(e.target);
    if (!allowed(target)) { markOver(null); return; }
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
    markOver(target.el);
  });

  el.flow.addEventListener('dragleave', function (e) {
    if (!drag) return;
    if (!e.relatedTarget || !el.flow.contains(e.relatedTarget)) markOver(null);
  });

  el.flow.addEventListener('drop', function (e) {
    if (!drag) return;
    e.preventDefault();
    var target = dropTargetAt(e.target);
    var d = drag;
    var ok = allowed(target);
    endDrag();
    if (!ok) return;
    performMove(d, { kind: target.kind, u: target.u, k: target.k });
  });

  el.flow.addEventListener('dragend', endDrag);

  /* ------------------------------------------------------- capture modes */

  /* All three capture modes put the same bar up: go and do one thing on the
   * page, or cancel. Only the wording and what the click is kept for differ. */
  function renderRedoBar() {
    var bar = el.redoBar;
    if (mode !== 'redo' && mode !== 'nextpage' && mode !== 'dismiss') {
      bar.hidden = true;
      bar.textContent = '';
      return;
    }
    bar.hidden = false;
    bar.textContent = '';
    var msg = document.createElement('span');
    msg.className = 'redo-text';
    if (mode === 'nextpage') {
      msg.textContent = 'Go to the page and click the control that brings up the next page — ' +
                        'Next, a chevron, "Load more". Scrolling to reach it is fine; the next ' +
                        'thing you click is what gets saved.';
    } else if (mode === 'dismiss') {
      msg.textContent = 'Bring that pop-up up on the page and click the button that closes it — ' +
                        'Cancel, Dismiss, the × in its corner. Scrolling to reach it is fine; the ' +
                        'next thing you click is what gets saved.';
    } else {
      var at = redoingId ? stepIndexById(redoingId) : -1;
      msg.textContent = at >= 0
        ? 'Re-recording step ' + (at + 1) + '. Go and do that one action — it replaces the step, ' +
          'and recording stops straight after.'
        : 'Re-recording one step. Do that action now.';
    }
    bar.appendChild(msg);
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.dataset.role = mode === 'nextpage' ? 'cancelnextpage'
      : mode === 'dismiss' ? 'canceldismiss' : 'cancelredo';
    cancel.textContent = 'Cancel';
    bar.appendChild(cancel);
  }

  el.redoBar.addEventListener('click', function (e) {
    var role = e.target && e.target.dataset && e.target.dataset.role;
    if (role === 'cancelredo') actAndReport({ cmd: 'cancelRedo' });
    if (role === 'cancelnextpage') actAndReport({ cmd: 'cancelNextPage' });
    if (role === 'canceldismiss') actAndReport({ cmd: 'cancelDismiss' });
  });

  /* After a step is re-recorded its loop still carries the old element's
   * pattern, which would quietly point at the wrong thing. Work it out again
   * from what was just recorded, and re-check it against the page. */
  function fulfilPendingPatterns() {
    if (mode !== 'idle') return;
    steps.forEach(function (step) {
      if (!step.needsPattern || !isLooping(step)) return;
      if (step.type !== 'click') return;
      var fresh = derivePattern(step);
      var updated = Object.assign({}, step.repeat, { pattern: fresh });
      step.needsPattern = false;
      saveRepeat(step.id, updated).then(function () {
        refinePattern(step.id, fresh, step.fallbackText);
      });
    });
  }

  /* ------------------------------------------------- spotting a repeat */

  /* "Click Connect, then confirm in the pop-out" is almost never meant to
   * happen once - it is a process to run down a whole list. Rather than leave
   * the user to build the block, the panel works that out the moment a
   * recording ends: if the click they started with still matches other
   * elements on the page, the recorded steps are put in a block and set to
   * repeat, ready to play. The switch in the block's drawer turns it back off. */

  function sameTabRun(list, from) {
    var end = list.length;
    for (var i = from + 1; i < list.length; i++) {
      var prev = list[i - 1];
      var here = list[i];
      if ((prev.title || prev.url) !== (here.title || here.url)) { end = i; break; }
    }
    while (end - 1 > from && list[end - 1].type === 'scroll') end -= 1;
    return end - from;
  }

  function arranged(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].set) return true;
      if (isLooping(list[i])) return true;
    }
    return false;
  }

  function signatureOfStep(step) {
    var a = step.attrs || {};
    return squash(step.ariaLabel || a.id || a.testId || a.name || '');
  }

  function repeatSetUpNotice(size) {
    return 'Set to repeat: ' + (size === 1 ? 'that step' : 'those ' + size + ' steps are in a block that') +
      ' will run on every match found, scrolling down for more as it goes. Click the block to change ' +
      'that or turn it off.';
  }

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
        if (look && look.ok !== false && (look.elsewhere >= 1 || look.count >= 2)) {
          return { at: at, step: step, pattern: pattern, count: look.count };
        }
        return firstRepeatable(list, at + 1, budget - 1);
      });
    }
    return Promise.resolve(null);
  }

  function offerRepeat() {
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
          refinePattern(anchor.id, found.pattern, anchor.fallbackText);
          showLocalNotice(repeatSetUpNotice(size), 'info');
        });
      });
    }).catch(function () { /* leave the recording exactly as it was */ });
  }

  /* --------------------------------------------------------- step editing */

  function saveRepeat(id, repeat) {
    return actAndReport({ cmd: 'setRepeat', id: id, repeat: repeat });
  }

  function saveSet(id, set) {
    return actAndReport({ cmd: 'setGroup', id: id, set: set });
  }

  el.notice.addEventListener('click', function (e) {
    if (!e.target || !e.target.dataset || e.target.dataset.role !== 'undo') return;
    if (!undoSnapshot) return;
    var restore = undoSnapshot;
    undoSnapshot = null;
    actAndReport({
      cmd: 'restoreSteps',
      steps: restore.steps,
      loadedFrom: restore.loadedFrom || null,
      note: restore.undoNote || 'Step restored.'
    });
  });

  /* ------------------------------------------------------- main controls */

  function disarmClear() {
    clearArmed = false;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    el.btnClear.textContent = 'Clear all';
    el.btnClear.classList.remove('armed');
  }

  el.btnStart.addEventListener('click', function () {
    undoSnapshot = null;
    closeDrawer();
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
    closeDrawer();
    actAndReport({ cmd: 'play' });
  });

  el.btnStopPlay.addEventListener('click', function () {
    actAndReport({ cmd: 'stopPlayback' });
  });

  el.btnClear.addEventListener('click', function () {
    if (!clearArmed) {
      clearArmed = true;
      el.btnClear.textContent = 'Press again to delete every step';
      el.btnClear.classList.add('armed');
      clearTimer = setTimeout(disarmClear, 4000);
      return;
    }
    disarmClear();
    closeDrawer();
    actAndReport({ cmd: 'clear' });
  });

  /* ------------------------------------------------------ saved recordings */

  /* The working recording is one slot. Saving keeps a named copy of it, so a
   * second job can be recorded without losing the first, and Load brings a
   * copy back into the slot. The list is drawn from the index the background
   * keeps; a saved recording's steps are only fetched when it is loaded or
   * exported, so a library full of pictures costs nothing to look at. */

  var library = [];          /* { id, name, savedAt, stepCount, loops, bytes } */
  var loadedFrom = null;     /* which saved recording the working steps came from */
  var shownLoadedId = null;  /* the name box follows this, and nothing else */
  var shownLoadedName = '';
  var renamingId = null;     /* the entry whose name is an input box right now */
  var armedDelete = null;    /* { id, timer } - first press asks, second deletes */
  var armedReplace = null;   /* { name, timer } - same, for saving over another entry */
  var libraryOpenDecided = false;
  var libraryNudged = false;
  var ARM_MS = 4000;

  function sameName(a, b) {
    return squash(a).toLowerCase() === squash(b).toLowerCase();
  }

  function entryById(id) {
    for (var i = 0; i < library.length; i++) if (library[i].id === id) return library[i];
    return null;
  }

  function entryByName(name) {
    for (var i = 0; i < library.length; i++) if (sameName(library[i].name, name)) return library[i];
    return null;
  }

  function whenText(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    try { return d.toLocaleDateString(undefined, opts); } catch (e) { return d.toDateString(); }
  }

  function disarmLibrary() {
    if (armedDelete) { clearTimeout(armedDelete.timer); armedDelete = null; }
    if (armedReplace) { clearTimeout(armedReplace.timer); armedReplace = null; }
  }

  function decideLibraryOpen() {
    if (libraryOpenDecided) return;
    libraryOpenDecided = true;
    el.libraryBox.open = library.length > 0 || steps.length > 0;
  }

  function renderLibrary() {
    decideLibraryOpen();
    var idle = mode === 'idle';
    if (!idle) disarmLibrary();
    el.libraryCount.textContent = String(library.length);

    var loadedId = loadedFrom ? loadedFrom.id : null;
    var loadedName = loadedFrom ? loadedFrom.name : '';
    if (loadedFrom && (loadedId !== shownLoadedId ||
        (loadedName !== shownLoadedName && sameName(el.saveName.value, shownLoadedName)))) {
      el.saveName.value = loadedName;
    }
    shownLoadedId = loadedId;
    shownLoadedName = loadedName;

    var name = squash(el.saveName.value);
    var clash = name ? entryByName(name) : null;
    var updating = !!(clash && loadedFrom && clash.id === loadedFrom.id);
    if (clash && !updating && armedReplace && armedReplace.name === name) {
      el.btnSave.textContent = 'Press again to replace';
    } else {
      el.btnSave.textContent = updating ? 'Save changes' : 'Save';
    }
    el.btnSave.disabled = !idle || !steps.length;
    el.saveName.disabled = !idle;
    el.btnImport.disabled = !idle;
    el.btnExportCurrent.disabled = !steps.length;

    if (loadedFrom) {
      el.libraryLoaded.hidden = false;
      el.libraryLoaded.textContent = 'working on “' + trunc(loadedFrom.name, 22) + '”';
      el.libraryLoaded.title = 'The flow above was loaded from “' + loadedFrom.name + '”';
    } else {
      el.libraryLoaded.hidden = true;
      el.libraryLoaded.textContent = '';
    }

    el.libraryEmpty.hidden = library.length > 0;
    el.libraryList.textContent = '';
    var sorted = library.slice().sort(function (a, b) {
      return squash(a.name).toLowerCase().localeCompare(squash(b.name).toLowerCase());
    });
    sorted.forEach(function (entry) {
      el.libraryList.appendChild(buildLibraryRow(entry, idle));
    });
    var box = el.libraryList.querySelector('.rec-rename');
    if (box) { box.focus(); box.select(); }
  }

  function buildLibraryRow(entry, idle) {
    var li = document.createElement('li');
    var current = !!(loadedFrom && loadedFrom.id === entry.id);
    li.className = 'rec' + (current ? ' rec-current' : '');
    li.dataset.id = entry.id;

    var main = document.createElement('div');
    main.className = 'rec-main';
    if (renamingId === entry.id) {
      var box = document.createElement('input');
      box.type = 'text';
      box.className = 'rec-rename';
      box.value = entry.name;
      box.maxLength = 80;
      box.spellcheck = false;
      box.dataset.role = 'renamebox';
      box.dataset.id = entry.id;
      box.setAttribute('aria-label', 'New name for ' + entry.name);
      main.appendChild(box);
    } else {
      var name = document.createElement('span');
      name.className = 'rec-name';
      name.textContent = entry.name;
      name.title = entry.name;
      main.appendChild(name);
    }
    var meta = document.createElement('span');
    meta.className = 'rec-meta';
    var bits = [entry.stepCount + ' step' + (entry.stepCount === 1 ? '' : 's')];
    if (entry.loops) bits.push('repeats');
    if (entry.bytes > 200 * 1024) bits.push(megabytes(entry.bytes));
    if (entry.savedAt) bits.push(whenText(entry.savedAt));
    if (current) bits.push('loaded');
    meta.textContent = bits.join(' · ');
    main.appendChild(meta);
    li.appendChild(main);

    var actions = document.createElement('div');
    actions.className = 'rec-actions';
    function action(role, text, title, enabled, danger) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn' + (danger ? ' link-danger' : '');
      b.dataset.role = role;
      b.dataset.id = entry.id;
      b.textContent = text;
      b.title = title;
      b.disabled = !enabled;
      actions.appendChild(b);
    }
    action('load', 'Load', 'Put a copy of this flow in the canvas above, ready to play', idle, false);
    action('rename', 'Rename', 'Call this saved recording something else', idle, false);
    action('export', 'Export', 'Download this recording as a file you can keep or share', true, false);
    action('libdelete', armedDelete && armedDelete.id === entry.id ? 'Really delete?' : 'Delete',
           'Delete this saved recording', idle, true);
    li.appendChild(actions);
    return li;
  }

  function loadFromLibrary(entry) {
    disarmLibrary();
    closeDrawer();
    var had = steps.length;
    var snapshot = had ? {
      steps: steps.slice(),
      loadedFrom: loadedFrom,
      text: 'Loaded “' + trunc(entry.name, 36) + '” in place of the ' + had +
            ' step' + (had === 1 ? '' : 's') + ' you had.',
      undoNote: 'Put your previous steps back.'
    } : null;
    actAndReport({ cmd: 'libraryLoad', id: entry.id }).then(function (res) {
      if (!res || res.ok === false) return;
      if (snapshot) {
        undoSnapshot = snapshot;
        showUndo();
      } else {
        showLocalNotice('Loaded “' + trunc(entry.name, 36) + '” — ' + res.count + ' step' +
                        (res.count === 1 ? '' : 's') + '. Press Play to run it.', 'info');
      }
    });
  }

  function exportFileName(name) {
    var slug = squash(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return 'mini-rpa-' + (slug || 'recording') + '.json';
  }

  function exportText(name, savedAt, list) {
    return JSON.stringify({
      format: 'mini-rpa-recording',
      version: 1,
      name: name,
      savedAt: savedAt || null,
      exportedAt: new Date().toISOString(),
      steps: list
    }, null, 2);
  }

  function download(filename, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function importFile(file) {
    var fallback = String(file.name || '').replace(/\.json$/i, '');
    return file.text().then(function (text) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) {
        showLocalNotice('That file is not valid JSON, so it cannot be a recording.', 'error');
        return null;
      }
      var list = Array.isArray(parsed) ? parsed
        : (parsed && Array.isArray(parsed.steps)) ? parsed.steps : null;
      if (!list) {
        showLocalNotice('That file does not look like a Mini RPA recording — it has no list of steps.', 'error');
        return null;
      }
      var name = (parsed && !Array.isArray(parsed) && parsed.name) ? String(parsed.name) : fallback;
      return actAndReport({ cmd: 'libraryImport', name: name, steps: list });
    }).catch(function (e) {
      showLocalNotice('Could not read that file: ' + ((e && e.message) || e), 'error');
    });
  }

  el.btnSave.addEventListener('click', function () {
    var name = squash(el.saveName.value);
    if (!name) {
      el.saveName.focus();
      showLocalNotice('Give the recording a name first.', 'warn');
      return;
    }
    var clash = entryByName(name);
    var updating = !!(clash && loadedFrom && clash.id === loadedFrom.id);
    if (clash && !updating && !(armedReplace && armedReplace.name === name)) {
      disarmLibrary();
      armedReplace = {
        name: name,
        timer: setTimeout(function () { armedReplace = null; renderLibrary(); }, ARM_MS)
      };
      renderLibrary();
      return;
    }
    disarmLibrary();
    actAndReport({ cmd: 'librarySave', name: name, id: clash ? clash.id : null }).then(function () {
      renderLibrary();
    });
  });

  el.saveName.addEventListener('input', function () {
    if (armedReplace) disarmLibrary();
    renderLibrary();
  });

  el.saveName.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!el.btnSave.disabled) el.btnSave.click();
  });

  el.btnExportCurrent.addEventListener('click', function () {
    if (!steps.length) return;
    var name = squash(el.saveName.value) || (loadedFrom && loadedFrom.name) || 'recording';
    download(exportFileName(name), exportText(name, null, steps));
  });

  el.btnImport.addEventListener('click', function () {
    el.importFile.value = '';
    el.importFile.click();
  });

  el.importFile.addEventListener('change', function () {
    var file = el.importFile.files && el.importFile.files[0];
    if (!file) return;
    importFile(file);
  });

  el.libraryList.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.dataset || !target.dataset.role) return;
    var role = target.dataset.role;
    var entry = entryById(target.dataset.id);
    if (!entry) return;

    if (role === 'load') { loadFromLibrary(entry); return; }

    if (role === 'rename') {
      disarmLibrary();
      renamingId = entry.id;
      renderLibrary();
      return;
    }

    if (role === 'export') {
      ask({ cmd: 'libraryExport', id: entry.id }).then(function (res) {
        if (!res || res.ok === false) {
          showLocalNotice((res && res.error) || 'Could not export that recording.', 'error');
          return;
        }
        download(exportFileName(res.name), exportText(res.name, res.savedAt, res.steps));
      });
      return;
    }

    if (role === 'libdelete') {
      if (!armedDelete || armedDelete.id !== entry.id) {
        disarmLibrary();
        armedDelete = {
          id: entry.id,
          timer: setTimeout(function () { armedDelete = null; renderLibrary(); }, ARM_MS)
        };
        renderLibrary();
        return;
      }
      disarmLibrary();
      actAndReport({ cmd: 'libraryDelete', id: entry.id });
    }
  });

  function commitRename(box) {
    var id = box.dataset.id;
    if (renamingId !== id) return;
    renamingId = null;
    var entry = entryById(id);
    var name = squash(box.value);
    if (!entry || !name || name === entry.name) { renderLibrary(); return; }
    actAndReport({ cmd: 'libraryRename', id: id, name: name }).then(function (res) {
      if (!res || res.ok === false) renderLibrary();
    });
  }

  el.libraryList.addEventListener('keydown', function (e) {
    var target = e.target;
    if (!target || !target.dataset || target.dataset.role !== 'renamebox') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      renamingId = null;
      renderLibrary();
    }
  });

  el.libraryList.addEventListener('focusout', function (e) {
    var target = e.target;
    if (!target || !target.dataset || target.dataset.role !== 'renamebox') return;
    commitRename(target);
  });

  /* ------------------------------------------------------------ state sync */

  var lastMode = 'idle';

  function noteMode() {
    var was = lastMode;
    lastMode = mode;
    if (was === 'recording' && mode === 'idle') {
      offerRepeat();
      if (!libraryNudged && steps.length && !el.libraryBox.open) {
        libraryNudged = true;
        el.libraryBox.open = true;
      }
    }
  }

  function applyState(local, playState) {
    mode = (local && local.mode) || 'idle';
    redoingId = (local && local.redoStepId) || null;
    steps = Array.isArray(local && local.steps) ? local.steps : [];
    library = Array.isArray(local && local.library) ? local.library : [];
    loadedFrom = (local && local.loadedFrom) || null;
    play = playState || null;
    renderStatus();
    renderButtons();
    renderNotice(local && local.notice);
    renderSkipped(local && local.skipped);
    renderSize();
    renderFlow(false);
    renderLibrary();
    noteMode();
  }

  function loadState() {
    return ask({ cmd: 'getState' }).then(function (res) {
      if (res && res.ok) {
        applyState(res.local, res.play);
        return;
      }
      return Promise.all([
        chrome.storage.local.get(['mode', 'steps', 'notice', 'skipped', 'library', 'loadedFrom']),
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
      if (changes.library) library = Array.isArray(changes.library.newValue) ? changes.library.newValue : [];
      if (changes.loadedFrom) loadedFrom = changes.loadedFrom.newValue || null;
      if (changes.notice) renderNotice(changes.notice.newValue);
      if (changes.skipped) renderSkipped(changes.skipped.newValue);
      if (changes.mode || changes.steps || changes.redoStepId || changes.nextPageForId || changes.dismissForId) {
        renderStatus();
        renderButtons();
        renderSize();
        renderSkipped();
        renderFlow(false);
      }
      if (changes.library && !changes.steps) renderSize();
      if (changes.mode || changes.steps || changes.library || changes.loadedFrom) renderLibrary();
      if (changes.mode) noteMode();
    } else if (area === 'session') {
      if (changes.play) {
        play = changes.play.newValue || null;
        renderStatus();
        highlightCurrent();
      }
      if (changes.activeTabStamp && mode !== 'playing') {
        steps.forEach(function (step) {
          if (isLooping(step)) refreshCount(step.id, step.repeat.pattern);
        });
      }
    }
  });

  loadState();
})();
