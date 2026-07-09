      'use strict';

      /* ================================================================
       * CONFIG — models, endpoints, tuning constants
       * ================================================================ */

      // Model routing. The coverage classifier favors reasoning quality
      // (Sonnet) — it runs against every finalized utterance during a live
      // call, and a wrongly ticked box is worse than a slightly slower check.
      // The planner writes hidden per-item coverage rubrics in the background
      // (when items are added/edited) — strong reasoning, never on the live path.
      const MODELS = {
        classifier: 'claude-sonnet-4-6',
        planner:    'claude-sonnet-4-6'
      };

      // Checklist-coverage tuning.
      const ASSIST = {
        DEBOUNCE_MS: 1400,        // silence gap before a buffered utterance is checked
        MIN_CHARS: 6,             // ignore fragments shorter than this
        MIN_WORDS: 2,             // ...or with fewer words than this
        // Classifier confidence needed to auto-check an item. Deliberately
        // HIGH: an item is only ticked when the model is confident it was
        // genuinely discussed/completed — never on a passing mention. When
        // unsure, nothing happens and the item stays unchecked.
        CONF_THRESHOLD: 0.8,
        DEDUPE_MS: 8000,          // ignore near-identical utterances inside this window
        CONTEXT_LEN: 12,          // recent utterances kept as the conversation window for the classifier
        DECISIONS_KEEP: 8,        // ring buffer for the status UI
        MAX_BUFFER_CHARS: 420,    // cap the join buffer so run-on speech still flushes
        MAX_DEFERRALS: 4,         // holds while interim speech is still flowing
        // Utterances heard while the classifier is busy are queued, not
        // dropped. Cap the queue so a long monologue can't pile up
        // unboundedly; on overflow the oldest is dropped silently (it still
        // sits in the context window, so nothing is lost for the next check).
        MAX_QUEUE: 5,
        INTERIM_FRESH_MS: 1500,   // interim words newer than this mean speech is still flowing
        INTERIM_RECHECK_MS: 700,  // re-check cadence while waiting for a sentence to finish
        // Reliability ceilings. A hung network call must never leave the
        // pipeline frozen: every call is bounded so it always settles, and a
        // self-healing watchdog un-sticks anything that slips through. The
        // wedge limit sits ABOVE the worst-case call duration so the in-call
        // timeout fires first and the watchdog is only ever a backstop.
        CLASSIFY_TIMEOUT_MS: 15000,  // hard ceiling on the classifier round-trip
        ANSWER_TIMEOUT_MS: 45000,    // default ceiling on any other proxy call (shared plumbing)
        WATCHDOG_MS: 4000,           // how often the self-healing watchdog checks
        PENDING_WEDGE_MS: 22000,     // pending longer than this ⇒ classifier wedged (> CLASSIFY_TIMEOUT_MS)
        PROXY_WARM_MS: 240000        // keep-warm ping cadence while listening (< Apps Script idle spindown)
      };

      /* ================================================================
       * PROMPTS — checklist-coverage classifier
       * ================================================================ */

      // Coverage classifier for the live call.
      //
      // Its ONE job: given the recent window of conversation and the checklist
      // items that are still unchecked, decide whether any single item has NOW
      // been genuinely covered. It is deliberately CONSERVATIVE — the opposite
      // of a "when in doubt, act" gate. A passing mention is NOT coverage; the
      // item must actually have been discussed/completed in the conversation.
      // When unsure, it does nothing. It can only ever CHECK an item off —
      // nothing in this tool ever automatically unchecks one.
      const COVERAGE_SYSTEM = [
        'You are the coverage judge for a sales assistant listening to a live sales call. The seller has a checklist of things they want to cover on this call. You are given the checklist items that are STILL UNCHECKED and the RECENT WINDOW of the conversation (transcribed speech, oldest line first).',
        '',
        'Decide whether exactly ONE of the unchecked items has JUST BEEN GENUINELY COVERED in the conversation. Never report more than one item per pass — if two items both seem covered, pick the one with the clearest evidence; the other will be caught on a later pass.',
        '',
        'The distinction that matters: a topic RAISED AND MEANINGFULLY ADDRESSED (explained, answered, agreed, demonstrated, or resolved) is covered; a topic merely MENTIONED is not. An item is NOT covered when it was:',
        '- Mentioned in passing ("we can get to pricing later", "budget is on my list for today").',
        '- Promised for later or announced as an intention ("next I want to walk through the timeline").',
        '- Asked about but not yet answered — a question opens a topic; only an answer can close it.',
        '- Only vaguely adjacent (talking about money in general does not cover a specific "agree pricing" item).',
        '',
        'Some items include a rubric (Done when / Counts if / Might sound like / Does NOT count). When a rubric is present, treat it as the authoritative definition of coverage for that item; judge strictly against it.',
        '',
        'Reason over the WHOLE window before deciding, never a single line in isolation. Coverage often spans several utterances — a question early in the window may be answered later in it — and a line that looks decisive on its own may be walked back, deferred, or left hanging a few lines later. Judge what the window as a whole establishes.',
        '',
        'Be CONSERVATIVE. Only report an item as covered when you are highly confident it was genuinely discussed or completed within this window. A wrongly ticked box misleads the seller mid-call and is far worse than waiting — the same item will be checked on a later pass once it truly has been covered. When you are unsure, or several items are only partially touched, report covered=false and do nothing.',
        '',
        'Speech-to-text may garble words; interpret charitably — a mangled word inside an otherwise clear exchange should not block an obvious match — but never invent coverage that is not clearly supported by what was actually said.',
        '',
        'Respond with ONLY a JSON object — no prose, no code fences:',
        '- covered: true only when one unchecked item was genuinely covered in this window.',
        '- item_id: the exact id of that item, copied from the list; empty string when covered is false.',
        '- confidence: your 0-to-1 certainty that the item was genuinely covered. Below 0.8 means do not act.',
        '- evidence: one short line (under 20 words) quoting or paraphrasing what was said that covered the item — it must specifically justify THAT item, not the conversation in general; empty string when covered is false.'
      ].join('\n');

      // JSON schema enforced via structured outputs — the classifier reply is
      // guaranteed to parse. (Numeric ranges go in descriptions; the API's
      // schema subset doesn't allow minimum/maximum.)
      const COVERAGE_SCHEMA = {
        type: 'object',
        properties: {
          covered:    { type: 'boolean', description: 'True only when one still-unchecked checklist item has just been genuinely discussed/completed in the recent conversation window — never for a passing mention.' },
          item_id:    { type: 'string',  description: 'The exact id of the covered item, copied from the unchecked list; empty string when covered is false.' },
          confidence: { type: 'number',  description: 'Certainty from 0 to 1 that the item was genuinely covered. Below 0.8 means do not act.' },
          evidence:   { type: 'string',  description: 'One short line (under 20 words) of what was said that covered the item; empty string when covered is false.' }
        },
        required: ['covered', 'item_id', 'confidence', 'evidence'],
        additionalProperties: false
      };

      /* ================================================================
       * PROMPTS — hidden per-item coverage rubric ("spec") generator
       *
       * When a checklist item is added or its text edited, a background
       * enricher (see the checklist section) asks the planner model to write
       * a private rubric for that item. The rubric is stored on the item and
       * folded into the live judge's prompt, sharpening covered/not-covered
       * decisions. Entirely invisible: no UI, and never on the live path.
       * ================================================================ */

      const SPEC_VERSION = 1;          // bump to force-regenerate every stored spec
      const SPEC_TIMEOUT_MS = 20000;   // rubric-call ceiling — separate from the live classify timeout
      const SPEC_DEBOUNCE_MS = 800;    // settle time after the last edit before enrichment fires

      const SPEC_SYSTEM = [
        'You write a private scoring rubric that a live sales-call coverage judge will use to decide when a checklist item has been GENUINELY covered on the call — raised AND meaningfully addressed (explained, answered, agreed, demonstrated, or resolved), never merely mentioned, promised for later, or asked about without an answer.',
        '',
        'You are given ONE checklist item plus the other items on the same list. Make this rubric DISTINCT from its siblings and avoid overlap: a signal that would equally indicate coverage of a sibling item belongs in the sibling\'s rubric, not this one. Be concrete and specific to this item — name the topics, artifacts, or commitments involved rather than using generic sales language.',
        '',
        'The judge reads imperfect speech-to-text, so example phrases should be short, natural things a seller or buyer would actually say out loud.',
        '',
        'Output ONLY a JSON object matching the schema — no prose, no code fences:',
        '- definition_of_done: one crisp sentence stating what must be true in the conversation for this item to count as covered.',
        '- covers: 2-5 concrete signals or sub-points that indicate genuine coverage.',
        '- example_phrases: 2-5 short phrases a seller or buyer might say while covering it.',
        '- not_covered: 2-4 near-misses that must NOT count (passing mentions, deferrals, unanswered questions, sibling-item overlap).'
      ].join('\n');

      // Structured-output schema for the rubric. Same json_schema mechanism the
      // live classifier uses. Array-length bounds live in the descriptions —
      // the API's schema subset doesn't allow minItems/maxItems — and the
      // prompt keeps the arrays short so the live judge's prompt stays compact.
      const SPEC_SCHEMA = {
        type: 'object',
        properties: {
          definition_of_done: { type: 'string', description: 'One crisp sentence: what must be true in the conversation for this item to count as genuinely covered.' },
          covers:          { type: 'array', items: { type: 'string' }, description: '2 to 5 concrete signals or sub-points that indicate genuine coverage. Keep each one short.' },
          example_phrases: { type: 'array', items: { type: 'string' }, description: '2 to 5 short phrases a seller or buyer might plausibly say while covering this item (helps match imperfect speech-to-text).' },
          not_covered:     { type: 'array', items: { type: 'string' }, description: '2 to 4 near-misses that must NOT count as coverage (passing mentions, deferrals, unanswered questions, overlap with sibling items).' }
        },
        required: ['definition_of_done', 'covers', 'example_phrases', 'not_covered'],
        additionalProperties: false
      };

      // Light cleanup for transcripts shown in the live band and folded into
      // the classifier's conversation window. (The old product-name garble
      // lexicon belonged to the question-answering tool; a general sales call
      // needs no fixed vocabulary.)
      function correctTranscript(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
      }

      /* ================================================================
       * ENDPOINT + STORAGE KEYS
       * ================================================================ */

      // Apps Script proxy URL. The proxy holds the Anthropic API key and
      // forwards model requests to Anthropic. It is the single source of truth
      // for every machine — not shown in Settings and cannot be overridden
      // per-browser. The checklist tool calls it for exactly one thing: the
      // coverage classifier. If you redeploy the Apps Script, update this
      // constant.
      const GSHEET_WEBHOOK = 'https://script.google.com/macros/s/AKfycbyMAaYqBSgYr4JAwhvJhg_GmwhRgS7IL6Nxs72XmLYU52obMydNjZNM55bKfZ50xZjcnw/exec';

      // Streaming answer proxy from the original tool. The checklist assistant
      // never streams answers, so nothing calls this endpoint anymore — the
      // constant is retained untouched so the backend wiring stays documented.
      const STREAM_WEBHOOK = 'https://randy-stream.aadsit7.workers.dev';

      // Classifier calls are grouped by session id on the proxy side.
      function genSessionId() {
        return 'S-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
      }
      let SESSION_ID = genSessionId();

      const SETTINGS_KEY = 'vsa_settings';
      // Legacy key from when history was cached on disk. Never written
      // anymore — kept only so startup can clear stale data from old builds.
      const HISTORY_KEY  = 'recast_chat_history';

      /* ================================================================
       * IDENTITY — anonymous install id + one-time name capture
       *
       * On first run we mint a random anonymous id (crypto.randomUUID) and store
       * it in chrome.storage.local under "anon_user_id"; every later run reads
       * the same id back, so one install keeps one id forever. The first time the
       * panel opens we also ask once for the user's first/last name and store it
       * under "user_name"; after that the name screen never appears again.
       *
       * chrome.storage is async, so loadIdentity() runs at boot and the rest of
       * the panel waits on it — the anon id is always in hand BEFORE the first
       * API call goes out. Only the opaque id is ever sent to the model
       * (metadata.user_id); the name travels only to the usage sheet, never to
       * the API.
       * ================================================================ */
      const ANON_ID_KEY   = 'anon_user_id';
      const USER_NAME_KEY = 'user_name';
      const IDENTITY = { anonId: null, userName: null, loaded: false };

      // Promise wrappers over chrome.storage.local. Guarded so the panel still
      // runs if it's ever opened outside an extension context (storage no-ops).
      function storageGet(keys) {
        return new Promise(resolve => {
          try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve({});
            chrome.storage.local.get(keys, res => resolve(res || {}));
          } catch { resolve({}); }
        });
      }
      function storageSet(obj) {
        return new Promise(resolve => {
          try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve();
            chrome.storage.local.set(obj, () => resolve());
          } catch { resolve(); }
        });
      }

      function newAnonId() {
        try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch {}
        // Fallback for the (vanishingly rare) case randomUUID is unavailable.
        return 'anon-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }

      // Synchronous (localStorage) mirror of "has this install finished
      // onboarding?". chrome.storage.local is async, so without this hint every
      // reload would have to wait on it before knowing whether to show the tool —
      // flashing a frame and delaying the mic auto-start each time. The hint lets
      // an already-onboarded install render the normal tool and start listening
      // INSTANTLY; chrome.storage stays the source of truth for the real id +
      // name (loaded in the background, always ready before any API call).
      // localStorage is synchronous and available on extension pages.
      const ONBOARDED_HINT_KEY = 'vsa_onboarded';
      function readOnboardedHint() {
        try { return localStorage.getItem(ONBOARDED_HINT_KEY) === '1'; } catch { return false; }
      }
      function writeOnboardedHint(done) {
        try {
          if (done) localStorage.setItem(ONBOARDED_HINT_KEY, '1');
          else localStorage.removeItem(ONBOARDED_HINT_KEY);
        } catch {}
      }

      // loadIdentity runs exactly once; everything awaits this shared promise so
      // the anon id is guaranteed present before the first API call.
      let _identityPromise = null;
      function ensureIdentity() {
        if (!_identityPromise) _identityPromise = loadIdentity();
        return _identityPromise;
      }

      // Load the anon id (minting + persisting it once on first run) and any
      // saved name. Always resolves with IDENTITY populated and loaded=true.
      async function loadIdentity() {
        const res = await storageGet([ANON_ID_KEY, USER_NAME_KEY]);
        let anonId = res[ANON_ID_KEY];
        if (!anonId || typeof anonId !== 'string') {
          anonId = newAnonId();
          await storageSet({ [ANON_ID_KEY]: anonId });
        }
        IDENTITY.anonId = anonId;
        const nm = res[USER_NAME_KEY];
        if (nm && typeof nm === 'object' && nm.firstName && nm.lastName) {
          IDENTITY.userName = { firstName: String(nm.firstName), lastName: String(nm.lastName) };
        }
        IDENTITY.loaded = true;
        // Keep the synchronous fast-path hint in step with the source of truth.
        writeOnboardedHint(!!IDENTITY.userName);
        return IDENTITY;
      }

      function onboardingComplete() {
        return !!(IDENTITY.userName && IDENTITY.userName.firstName && IDENTITY.userName.lastName);
      }
      function identityFullName() {
        const n = IDENTITY.userName;
        return n ? (n.firstName + ' ' + n.lastName).trim() : '';
      }

      // Whether to show the normal tool right now. True once onboarding is
      // confirmed, OR — before the async identity load finishes — when the
      // synchronous hint says this install already onboarded. That second clause
      // is what keeps reloads instant and flash-free.
      function shouldShowApp() {
        return onboardingComplete() || (!IDENTITY.loaded && readOnboardedHint());
      }

      // Persist the one-time name and guarantee the anon id exists, then let the
      // normal tool take over. Returns false if either field is blank.
      async function saveUserName(firstName, lastName) {
        firstName = String(firstName || '').trim();
        lastName  = String(lastName  || '').trim();
        if (!firstName || !lastName) return false;
        if (!IDENTITY.anonId) {
          IDENTITY.anonId = newAnonId();
          await storageSet({ [ANON_ID_KEY]: IDENTITY.anonId });
        }
        IDENTITY.userName = { firstName, lastName };
        await storageSet({ [USER_NAME_KEY]: IDENTITY.userName });
        writeOnboardedHint(true);
        return true;
      }

      /* ================================================================
       * CHECKLIST — the seller's call checklist (the main feature)
       *
       * items: [{ id, text, checked, checkedBy: 'auto'|'you'|null,
       *           evidence, checkedAt, noAuto }]
       *
       * Persisted in chrome.storage.local (the same storage the identity keys
       * already use) so the list and its checked/unchecked state survive the
       * panel closing mid-call. A separate reusable DEFAULT list — edited in
       * Settings — is what new calls start from.
       * ================================================================ */
      const CHECKLIST_KEY = 'vsa_checklist';
      const DEFAULT_CHECKLIST_KEY = 'vsa_default_checklist';

      const CHECKLIST = {
        items: [],
        defaults: [],   // reusable default checklist (array of item texts)
        loaded: false
      };

      function newChecklistItemId() {
        return 'ci-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      }

      function makeChecklistItem(text) {
        return {
          id: newChecklistItemId(),
          text: String(text || '').trim(),
          checked: false,
          checkedBy: null,   // 'auto' (classifier) | 'you' (manual tap)
          evidence: '',      // what was said that covered it (auto checks only)
          checkedAt: 0,
          noAuto: false,     // manual uncheck vetoes future auto-checks (human override wins)
          spec: null,        // hidden coverage rubric, generated in the background
          specText: '',      // the exact item text the spec was built for
          specVersion: 0     // SPEC_VERSION the spec was built under
        };
      }

      // Validate a stored/generated rubric. Anything malformed — wrong shape,
      // wrong types, missing definition — collapses to null (item behaves as
      // if it has no spec yet). Must never throw.
      function sanitizeItemSpec(raw) {
        try {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
          const strList = v => Array.isArray(v)
            ? v.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
            : [];
          const spec = {
            definition_of_done: typeof raw.definition_of_done === 'string' ? raw.definition_of_done.trim() : '',
            covers: strList(raw.covers),
            example_phrases: strList(raw.example_phrases),
            not_covered: strList(raw.not_covered)
          };
          return spec.definition_of_done ? spec : null;
        } catch {
          return null;
        }
      }

      // Validate whatever came back from storage — a malformed record must
      // never be able to break the panel.
      function sanitizeChecklistItems(raw) {
        if (!Array.isArray(raw)) return [];
        return raw
          .filter(x => x && typeof x === 'object' && typeof x.text === 'string' && x.text.trim())
          .map(x => ({
            id: (typeof x.id === 'string' && x.id) ? x.id : newChecklistItemId(),
            text: x.text.trim(),
            checked: !!x.checked,
            checkedBy: (x.checkedBy === 'auto' || x.checkedBy === 'you') ? x.checkedBy : (x.checked ? 'you' : null),
            evidence: typeof x.evidence === 'string' ? x.evidence : '',
            checkedAt: Number(x.checkedAt) || 0,
            noAuto: !!x.noAuto,
            spec: sanitizeItemSpec(x.spec),
            specText: typeof x.specText === 'string' ? x.specText : '',
            specVersion: Number(x.specVersion) || 0
          }));
      }

      function saveChecklist() { storageSet({ [CHECKLIST_KEY]: CHECKLIST.items }); }
      function saveDefaultChecklist() { storageSet({ [DEFAULT_CHECKLIST_KEY]: CHECKLIST.defaults }); }

      async function loadChecklist() {
        const res = await storageGet([CHECKLIST_KEY, DEFAULT_CHECKLIST_KEY]);
        if (Array.isArray(res[DEFAULT_CHECKLIST_KEY])) {
          CHECKLIST.defaults = res[DEFAULT_CHECKLIST_KEY]
            .filter(x => typeof x === 'string' && x.trim())
            .map(x => x.trim());
        }
        const stored = sanitizeChecklistItems(res[CHECKLIST_KEY]);
        if (stored.length) {
          CHECKLIST.items = stored;
        } else if (res[CHECKLIST_KEY] === undefined && CHECKLIST.defaults.length) {
          // Nothing stored yet (fresh state, not a deliberately emptied list):
          // start this call from the saved default checklist.
          CHECKLIST.items = CHECKLIST.defaults.map(makeChecklistItem);
          saveChecklist();
        }
        CHECKLIST.loaded = true;
        enqueueEnrichment();   // backfill: enrich any item missing a current rubric
        return CHECKLIST;
      }

      function addChecklistItem(text) {
        const t = String(text || '').trim();
        if (!t) return;
        CHECKLIST.items.push(makeChecklistItem(t));
        saveChecklist();
        enqueueEnrichment();
      }

      function updateChecklistItemText(id, text) {
        const it = CHECKLIST.items.find(x => x.id === id);
        const t = String(text || '').trim();
        if (!it || !t) return;
        it.text = t;
        saveChecklist();
        enqueueEnrichment();
      }

      function removeChecklistItem(id) {
        const before = CHECKLIST.items.length;
        CHECKLIST.items = CHECKLIST.items.filter(x => x.id !== id);
        if (CHECKLIST.items.length !== before) { saveChecklist(); render(); }
      }

      function moveChecklistItem(id, dir) {
        const i = CHECKLIST.items.findIndex(x => x.id === id);
        const j = i + (dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= CHECKLIST.items.length) return;
        const [it] = CHECKLIST.items.splice(i, 1);
        CHECKLIST.items.splice(j, 0, it);
        saveChecklist();
        render();
      }

      // Manual tap — the human override, and it always wins. A manual uncheck
      // also takes the item out of the auto-checker's reach (noAuto) so the
      // classifier can never fight the seller by re-checking it; a manual
      // re-check or a reset clears that veto.
      function toggleChecklistItem(id) {
        const it = CHECKLIST.items.find(x => x.id === id);
        if (!it) return;
        if (it.checked) {
          it.checked = false;
          it.checkedBy = null;
          it.evidence = '';
          it.checkedAt = 0;
          it.noAuto = true;
        } else {
          it.checked = true;
          it.checkedBy = 'you';
          it.evidence = '';
          it.checkedAt = Date.now();
          it.noAuto = false;
          postLogItem(it);
        }
        saveChecklist();
        render();
      }

      // The ONLY path by which the classifier ticks a box. It can never
      // uncheck anything, never touches an item the seller manually unchecked,
      // and no-ops if the item was checked some other way in the meantime.
      function autoCheckChecklistItem(id, evidence, confidence) {
        const it = CHECKLIST.items.find(x => x.id === id);
        if (!it || it.checked || it.noAuto) return;
        it.checked = true;
        it.checkedBy = 'auto';
        it.evidence = String(evidence || '').trim();
        it.checkedAt = Date.now();
        postLogItem(it, confidence);
        saveChecklist();
        TECH.answered++;   // "items auto-checked" counter for the status line
        showToast('Covered ✓ ' + truncate(it.text, 60));
        render();
      }

      // "Reset checklist" — uncheck everything for the next call. Items,
      // order and text are kept; only the checked state (and the manual-veto
      // flags) are cleared.
      function resetChecklist() {
        if (!CHECKLIST.items.length) return;
        CHECKLIST.items.forEach(it => {
          it.checked = false;
          it.checkedBy = null;
          it.evidence = '';
          it.checkedAt = 0;
          it.noAuto = false;
        });
        saveChecklist();
        showToast('Checklist reset — everything unchecked for the next call');
        render();
      }

      // Replace the current checklist with the saved default (all unchecked).
      function applyDefaultChecklist() {
        CHECKLIST.items = CHECKLIST.defaults.map(makeChecklistItem);
        saveChecklist();
        enqueueEnrichment();   // fresh items start bare — build their rubrics
      }

      // Items the classifier is allowed to consider: still unchecked, and not
      // manually vetoed by the seller.
      function classifiableItems() {
        return CHECKLIST.items.filter(i => !i.checked && !i.noAuto);
      }

      /* ================================================================
       * BACKGROUND RUBRIC ENRICHMENT
       *
       * The only caller of generateItemSpec. Runs entirely off the live
       * listening path: debounced behind edits, one generation call in
       * flight at a time, best-effort (a failure just leaves the item on
       * its bare text — the live judge never waits for it). Invisible by
       * design: it never calls render() and shows no status.
       * ================================================================ */

      const ENRICH = { timer: 0, running: false, rerun: false };

      // True when the item has no rubric for its CURRENT text under the
      // CURRENT schema version. Check/uncheck/reorder never flip this —
      // only a text change or a SPEC_VERSION bump does.
      function needsSpec(item) {
        return !item.spec || item.specText !== item.text || item.specVersion !== SPEC_VERSION;
      }

      // Debounced entry point — call after any path that lands new item text.
      // Rapid edits / pastes collapse into one run.
      function enqueueEnrichment() {
        clearTimeout(ENRICH.timer);
        ENRICH.timer = setTimeout(runEnrichment, SPEC_DEBOUNCE_MS);
      }

      async function runEnrichment() {
        if (ENRICH.running) { ENRICH.rerun = true; return; }  // drain in progress — run again after it
        ENRICH.running = true;
        try {
          // Snapshot the ids that need work; process strictly one at a time.
          const pending = CHECKLIST.items.filter(needsSpec).map(i => i.id);
          for (const id of pending) {
            const item = CHECKLIST.items.find(i => i.id === id);
            if (!item || !needsSpec(item)) continue;          // removed or already current
            const textAtCall = item.text;
            const spec = await generateItemSpec(item, CHECKLIST.items.map(i => i.text));
            if (!spec) continue;  // best-effort: item keeps its bare text; retried on a later edit/load
            const live = CHECKLIST.items.find(i => i.id === id);
            if (!live || live.text !== textAtCall) continue;  // edited/removed mid-flight — rubric is stale
            live.spec = spec;
            live.specText = live.text;
            live.specVersion = SPEC_VERSION;
            saveChecklist();  // persist as each spec lands; nothing visible changes, so no render()
          }
        } finally {
          ENRICH.running = false;
          if (ENRICH.rerun) { ENRICH.rerun = false; enqueueEnrichment(); }
        }
      }

      // One rubric generation call. Same proxy and structured-output plumbing
      // as the live classifier, but its own model, prompt and (longer) timeout
      // — the live classify timeout is never shared. Returns a sanitized spec
      // object, or null on any failure; never throws.
      async function generateItemSpec(item, siblingTexts) {
        if (!GSHEET_WEBHOOK) return null;
        try {
          const siblings = (siblingTexts || []).filter(t => t && t !== item.text);
          const userContent =
            'Checklist item to write the rubric for:\n' + item.text + '\n\n' +
            'Other items on the same checklist (keep this rubric distinct from them):\n' +
            (siblings.length ? siblings.map(t => '- ' + t).join('\n') : '(none)');
          const data = await postChat({
            model: MODELS.planner,
            max_tokens: 500,
            system: SPEC_SYSTEM,
            messages: [{ role: 'user', content: userContent }],
            output_config: { format: { type: 'json_schema', schema: SPEC_SCHEMA } },
            save: false // keep enrichment churn out of the usage sheet
          }, null, SPEC_TIMEOUT_MS);
          const m = String(data.reply || '').match(/\{[\s\S]*\}/);
          if (!m) return null;
          return sanitizeItemSpec(JSON.parse(m[0]));
        } catch {
          return null;
        }
      }

      /* ================================================================
       * STATE
       * ================================================================ */

      function makeSlot() {
        return {
          label: 'Sales Assistant',
          // The one big switch. When on, the assistant passively hears the
          // microphone and the computer's sound together and checks checklist
          // items off as they're genuinely covered — no wake word. Always
          // starts off; turning it on needs a click (the mic permission
          // requires one).
          listenOn: false,
          // How the assistant captures audio when switched on; the last
          // choice is remembered.
          //   'two-way' — microphone + the computer's own audio. The
          //               screen/tab-share picker pops out so the call is
          //               captured digitally, and the mic runs with echo
          //               cancellation OFF so it overhears the speakers too.
          //   'one-way' — microphone only, with echo cancellation / noise
          //               suppression / auto-gain ON so only the user's own
          //               voice is picked up, not the call audio coming
          //               from the speakers. No picker pops out.
          audioMode: 'two-way',
          isListening: false
        };
      }

      const STATE = {
        activeTab: 'home',
        editingSlot: 0,
        historyOpen: false,
        historyConfirmDeleteId: null,
        historyQuery: '',
        // This visit's archived conversations, newest first (memory only —
        // kept for the sidebar's structure).
        sessionHistory: [],
        // The audio-mode chooser shown when turning listening on.
        audioChooserOpen: false,
        // While the Settings sheet is open we pause listening (see
        // pauseListenForSettings); this remembers the capture mode to resume
        // in when Settings closes. false = nothing to resume.
        settingsResumeListen: false,
        // Checklist UI state. Drafts live here so background re-renders
        // (toasts, live status) never wipe what the seller is typing.
        editingItemId: null,   // item currently in inline text-edit mode
        editItemText: '',      // draft in the inline editor
        newItemText: '',       // draft in the "add an item" box
        slots: [makeSlot()]
      };

      let HISTORY_VIEW = { open: null };

      const VOICE = {
        srSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
        ttsSupported: !!window.speechSynthesis,
        recognition: null,        // shared SpeechRecognition instance
        wantRunning: false,       // should the recognizer be running?
        permissionDenied: false,
        toastTimeoutId: null,
        toastMessage: '',
        interimText: '',          // live partial transcript
        interimSlot: null,
        interimAt: 0,             // when the interim transcript last changed
        lastTtsEndAt: 0,          // for the post-playback echo grace window (inert — nothing speaks)
        ttsPaused: false,         // legacy guard flag; always false (no TTS in this tool)
        recentTtsText: '',        // rolling buffer for echo matching (inert — nothing speaks)
        srRunning: false,         // recognizer actually running (onstart..onend)
        srStartStrikes: 0,        // consecutive watchdog ticks that found the
                                  // recognizer stopped despite trying to start —
                                  // enough strikes means rebuild it outright
        watchdogId: null,         // background-tab restart watchdog interval
        lastSrEventAt: 0,         // last recognizer activity (wedge detection)
        micStream: null,          // held open (echo cancellation OFF) so the
                                  // mic hears the computer's speakers — see
                                  // startListening()
        // Legacy guard flag read by the recognizer's restart paths; always
        // false now that push-to-talk dictation is gone.
        dictationPaused: false
      };

      // Best-effort operating-system detection so the audio-setup guidance can
      // speak to each platform accurately. It's advisory only — never a gate on
      // capability — because two facts differ by OS:
      //   1. macOS Chrome can share a browser TAB's audio but not whole-system
      //      audio; Windows Chrome can share system audio as well as a tab.
      //   2. The exact place to change the default input device differs.
      // We read the modern navigator.userAgentData.platform first (present in
      // Chromium) and fall back to navigator.platform / userAgent.
      const PLATFORM = (() => {
        let hint = '';
        try { hint = (navigator.userAgentData && navigator.userAgentData.platform) || ''; } catch {}
        if (!hint) { try { hint = navigator.platform || ''; } catch {} }
        let ua = '';
        try { ua = navigator.userAgent || ''; } catch {}
        const s = (hint + ' ' + ua).toLowerCase();
        if (/mac|iphone|ipad|ipod/.test(s)) return 'mac';
        if (/win/.test(s)) return 'win';
        return 'other';
      })();

      // Where the user changes their default microphone, per OS. Chrome's live
      // speech recognizer always captures the OS default input (it can't be
      // pointed at a specific device from JavaScript), so this is the setting
      // that actually decides what gets heard.
      function osDefaultMicPath() {
        if (PLATFORM === 'mac') return 'System Settings → Sound → Input';
        if (PLATFORM === 'win') return 'Settings → System → Sound → Input';
        return "your operating system’s sound settings";
      }

      // The exact "share audio" wording the screen-share picker shows, per OS.
      function osShareAudioHint() {
        if (PLATFORM === 'mac') return 'pick the call’s browser tab and tick “Share tab audio” (macOS Chrome can’t share whole-system audio)';
        if (PLATFORM === 'win') return 'tick “Share system audio” (or share the call’s tab and tick “Share tab audio”)';
        return 'tick “Share tab/system audio”';
      }

      // Which microphone gets opened. '' = the system default device
      // (recommended — and the device Chrome's live speech recognizer always
      // uses); a specific deviceId pins the capture to that input so the user
      // can switch hardware in Settings if the default device misbehaves. The
      // device list fills in lazily: browsers hide input labels until mic
      // permission has been granted at least once.
      const MIC = {
        deviceId: '',             // '' = system default, else a specific deviceId
        devices: []               // cached [{deviceId, label}] of audioinput devices
      };

      // One-tap microphone check in Settings. Opens a SHORT-LIVED capture on
      // the currently selected device and paints a live input-level meter so
      // the user can confirm their mic is actually being picked up before a
      // call. It is a completely SEPARATE, temporary stream — it never touches
      // VOICE.micStream or the recognizer — and its animation loop stops itself
      // the instant the meter leaves the screen, so no navigation path can
      // leave a test capture running.
      const MICTEST = {
        active: false,
        starting: false,   // getUserMedia in flight — ignore re-clicks
        stream: null,
        audioCtx: null,
        analyser: null,
        rafId: 0,
        data: null,
        sawSound: false    // has real sound crossed the bar this run?
      };

      // Re-read the available microphones. Safe to call any time; labels only
      // appear once capture permission has been granted. Drops a pinned device
      // that has been unplugged so listening falls back to the system default.
      async function refreshMicDevices() {
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
          const list = await navigator.mediaDevices.enumerateDevices();
          MIC.devices = list
            .filter(d => d.kind === 'audioinput')
            .map(d => ({ deviceId: d.deviceId, label: d.label || '' }));
          // Only prune a pinned device we can trust is really gone. Before mic
          // permission has been granted this session, enumerateDevices() returns
          // entries with blank deviceIds/labels; pruning the pin against that
          // placeholder list would wrongly forget a valid saved device. Require
          // at least one real (non-blank) deviceId before deciding it's missing.
          const haveRealIds = MIC.devices.some(d => d.deviceId);
          if (MIC.deviceId && haveRealIds && !MIC.devices.some(d => d.deviceId === MIC.deviceId)) {
            MIC.deviceId = '';
            try { saveSettings(); } catch {}
          }
          if (STATE.activeTab === 'settings') render();
        } catch {}
      }

      // Keep the device list fresh when mics are plugged in or removed.
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
          navigator.mediaDevices.addEventListener('devicechange', () => { try { refreshMicDevices(); } catch {} });
        }
      } catch {}

      // Open the held keep-alive mic capture on the chosen device, with the
      // audio-processing constraints each listening mode needs. A pinned device
      // that's gone is forgotten and retried on the system default before giving
      // up, so an unplugged mic can never strand listening. Returns 'ok' or a
      // failure code ('denied' | 'no-device' | 'transient'); the caller toasts.
      async function acquireMicStream(twoWay) {
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return 'ok';
        const proc = twoWay
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        const open = (device) => navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: device }, proc) });
        const codeFor = (err) => {
          const name = err && err.name ? err.name : '';
          if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
          if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no-device';
          return 'transient';
        };
        try {
          VOICE.micStream = await open(MIC.deviceId ? { exact: MIC.deviceId } : { ideal: 'default' });
        } catch (err) {
          const code = codeFor(err);
          if (code === 'no-device' && MIC.deviceId) {
            // The pinned mic is unavailable — drop the pin and fall back to the
            // system default before reporting a hard failure.
            MIC.deviceId = '';
            try { saveSettings(); } catch {}
            try { VOICE.micStream = await open({ ideal: 'default' }); }
            catch (e2) { return codeFor(e2); }
          } else {
            return code;
          }
        }
        VOICE.micStream.getTracks().forEach(t => { t.onended = () => { VOICE.micStream = null; }; });
        // Capture is granted now, so device labels are finally readable.
        refreshMicDevices();
        return 'ok';
      }

      // The label of the device Chrome's speech recognizer actually
      // transcribes — the OS default input. enumerateDevices exposes it as the
      // 'default' pseudo-device on most platforms; we strip the "Default - "
      // prefix browsers add. Returns '' when the OS default can't be named
      // (e.g. before permission, or on platforms without the pseudo-device).
      function osDefaultMicLabel() {
        const def = MIC.devices.find(d => d.deviceId === 'default' && d.label);
        if (def) return def.label.replace(/^Default\s*[-–—]\s*/i, '').trim();
        return '';
      }

      // Start the Settings mic check. Opens its OWN capture on the selected
      // device (processing left on — we only need to show sound is arriving)
      // and kicks off the level-meter loop. Fully independent of listening.
      async function startMicTest() {
        if (MICTEST.active || MICTEST.starting) return;
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
          showToast('This browser can’t open the microphone for a test.');
          return;
        }
        MICTEST.starting = true;
        MICTEST.sawSound = false;
        let stream;
        try {
          const dev = MIC.deviceId ? { exact: MIC.deviceId } : { ideal: 'default' };
          stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev } });
        } catch (err) {
          MICTEST.starting = false;
          const name = (err && err.name) || '';
          if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') showToast('Allow microphone access to run the test.');
          else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') showToast('That microphone isn’t available — pick another and try again.');
          else showToast('Couldn’t start the microphone test — try again.');
          return;
        }
        // Labels become readable once capture is granted.
        try { refreshMicDevices(); } catch {}
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          MICTEST.audioCtx = new Ctx();
          if (MICTEST.audioCtx.state === 'suspended') { try { await MICTEST.audioCtx.resume(); } catch {} }
          const src = MICTEST.audioCtx.createMediaStreamSource(stream);
          const an = MICTEST.audioCtx.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);
          MICTEST.analyser = an;
          MICTEST.data = new Uint8Array(an.fftSize);
        } catch (err) {
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          if (MICTEST.audioCtx) { try { MICTEST.audioCtx.close(); } catch {} MICTEST.audioCtx = null; }
          MICTEST.starting = false;
          showToast('Couldn’t start the microphone test — try again.');
          return;
        }
        MICTEST.stream = stream;
        MICTEST.active = true;
        MICTEST.starting = false;
        render();          // draw the meter shell
        micTestTick();     // begin the animation loop
      }

      // Self-terminating level-meter loop. Reads the input peak each frame and
      // paints the bar/status by id. If the meter element has left the DOM
      // (user navigated away from Settings, panel closing, a full re-render
      // without the meter), it stops the whole test — so a capture can never
      // outlive the meter that owns it.
      function micTestTick() {
        if (!MICTEST.active || !MICTEST.analyser) return;
        const bar = document.getElementById('mic-test-bar');
        if (!bar) { stopMicTest(); return; }
        MICTEST.analyser.getByteTimeDomainData(MICTEST.data);
        let peak = 0;
        for (let i = 0; i < MICTEST.data.length; i++) {
          const dev = Math.abs(MICTEST.data[i] - 128);
          if (dev > peak) peak = dev;
        }
        const level = Math.min(1, (peak / 128) * 1.6);   // 0..1, lightly boosted for visibility
        bar.style.width = Math.round(level * 100) + '%';
        bar.style.background = level > 0.02 ? '#0F7A3F' : '#cbd5e1';
        if (level > 0.05) MICTEST.sawSound = true;
        const status = document.getElementById('mic-test-status');
        if (status) {
          status.textContent = MICTEST.sawSound
            ? 'Picking up sound ✓ — this microphone is working.'
            : 'Listening… speak now and watch the bar move.';
          status.style.color = MICTEST.sawSound ? '#0F7A3F' : '#64748b';
        }
        MICTEST.rafId = requestAnimationFrame(micTestTick);
      }

      function stopMicTest() {
        const wasActive = MICTEST.active;
        MICTEST.active = false;
        if (MICTEST.rafId) { try { cancelAnimationFrame(MICTEST.rafId); } catch {} MICTEST.rafId = 0; }
        if (MICTEST.stream) { try { MICTEST.stream.getTracks().forEach(t => t.stop()); } catch {} MICTEST.stream = null; }
        if (MICTEST.audioCtx) { try { MICTEST.audioCtx.close(); } catch {} MICTEST.audioCtx = null; }
        MICTEST.analyser = null;
        MICTEST.data = null;
        if (wasActive && STATE.activeTab === 'settings') render();
      }

      // Listening runtime state. The assistant hears on two channels: (1) the
      // microphone via the Web Speech recognizer — which also overhears the
      // call on the speakers, but only with echo cancellation / noise
      // suppression / auto-gain disabled (see startListening), and only when
      // the user isn't on headphones; and (2) the computer's audio captured
      // digitally through the share picker and transcribed locally by an
      // in-browser Whisper model (see DESKTOP / startDesktopCapture), which
      // works on headphones too. Both channels feed the same coverage pipeline.
      const TECH = {
        lastErrorToastAt: 0,      // throttle pipeline-failure toasts
        buffer: '',               // join buffer for ASR fragments
        bufferTimerId: null,
        deferrals: 0,
        pending: false,           // coverage-classifier call in flight
        pendingSince: 0,          // when the check started (wedge detection)
        classifyController: null, // aborts a wedged classifier round-trip
        classifyGen: 0,           // epoch — a stale classify resolution is ignored
        watchdogId: null,         // self-healing pipeline watchdog interval
        activeText: '',           // utterance currently being checked (for the live band)
        questionQueue: [],        // FIFO of utterances heard while the classifier was busy
        context: [],              // recent utterances — the conversation window
        lastSubmitted: '',
        lastSubmittedAt: 0,
        decisions: [],            // ring buffer {text, accepted, confidence, topic, ts}
        heard: 0,                 // utterances run through the coverage check
        answered: 0               // items auto-checked this listening session
      };

      function listeningOn() { return STATE.slots[0].listenOn; }

      // Desktop/computer-audio capture + fully in-browser transcription.
      //
      // The mic path above can only hear computer sound acoustically (the mic
      // overhearing the speakers), which fails the moment the user wears
      // headphones. This path taps the computer's audio DIGITALLY via the
      // screen/tab-share picker (getDisplayMedia) and transcribes it with a
      // Whisper model that runs locally in the browser (WebGPU, WASM
      // fallback) — no audio ever leaves the machine, no API key, and it
      // works identically on speakers or headphones. Its transcripts feed the
      // exact same answer pipeline the microphone uses (handleVoiceTranscript
      // / updateInterim). Optional: if the user dismisses the picker, listening
      // falls back to mic-only just like before.
      const DESKTOP = {
        supported: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia &&
                      typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined'),
        on: false,                // is digital computer-audio capture running?
        stream: null,             // getDisplayMedia stream (audio + a stopped video track)
        audioCtx: null,           // 16 kHz context that feeds the transcriber
        sourceNode: null,
        procNode: null,           // ScriptProcessor pulling raw PCM
        worker: null,             // Whisper inference worker (Blob module)
        workerReady: false,
        modelLoading: false,
        device: '',               // 'webgpu' | 'wasm' once known
        statusText: '',           // shown in the live strip
        // Voice-activity segmentation over the incoming PCM.
        seg: [],                  // Float32 chunks of the current utterance
        segLen: 0,                // samples buffered in seg
        speaking: false,
        silenceRun: 0,            // consecutive silent samples
        voicedRun: 0,             // consecutive voiced samples in the open segment
        noiseFloor: 0.002,        // adaptive ambient-noise estimate (EMA while idle)
        preRoll: [],              // ring of recent silent frames (onset pre-roll)
        preRollLen: 0,            // samples buffered in preRoll
        reqId: 0,                 // monotonic id for inference requests
        inFlight: 0,              // outstanding worker jobs (single-flight gate)
        lastInterimAt: 0          // throttle for live partial transcriptions
      };

      // Whisper sample rate, plus VAD/segmentation tuning. Chosen so a normal
      // spoken question finalizes ~0.7 s after the speaker stops, while a long
      // monologue still flushes periodically instead of growing unbounded.
      //
      // Voice activity uses an ADAPTIVE dual-threshold detector (see
      // processDesktopBlock): a noise floor is tracked while the line is quiet
      // and the open/close thresholds ride a little above it. In a silent room
      // the open threshold stays pinned to SILENCE_RMS (so behaviour matches the
      // old fixed detector), but in a noisy room — fans, HVAC, a hot mic on the
      // call — the bar rises so steady background hum no longer trips Whisper
      // into transcribing (and hallucinating over) non-speech. The lower close
      // threshold adds hysteresis so a brief dip mid-word doesn't split one
      // sentence into two, and a short pre-roll keeps the audio just BEFORE the
      // onset so the first word isn't clipped (Whisper mis-reads clipped onsets).
      const ASR = {
        SAMPLE_RATE: 16000,
        SILENCE_RMS: 0.006,       // absolute floor for the OPEN threshold (quiet-room default)
        CLOSE_FLOOR: 0.004,       // absolute floor for the CLOSE threshold (< open ⇒ hysteresis)
        NOISE_OPEN_FACTOR: 1.8,   // open a segment when rms ≥ noiseFloor × this
        NOISE_CLOSE_FACTOR: 1.3,  // keep it open while rms ≥ noiseFloor × this
        NOISE_FLOOR_MAX: 0.012,   // clamp so loud rooms can't raise the bar past real speech
        NOISE_FLOOR_INIT: 0.002,  // starting noise estimate before any audio arrives
        PREROLL_MS: 300,          // audio kept before the onset so the first word survives
        SILENCE_MS: 700,          // trailing silence that ends an utterance
        MIN_VOICED_MS: 250,       // ignore blips shorter than this
        MAX_SEG_MS: 18000,        // hard flush so long talk still transcribes live
        INTERIM_MS: 1400,         // how often to refresh the live partial
        MAX_TAIL_S: 24            // cap the audio sent per inference (seconds)
      };

      /* ================================================================
       * SETTINGS PERSISTENCE
       * ================================================================ */

      function saveSettings() {
        const data = STATE.slots.map(s => ({
          label: s.label,
          audioMode: s.audioMode === 'one-way' ? 'one-way' : 'two-way',
          micDeviceId: MIC.deviceId || ''
        }));
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch {}
      }

      function loadSettings() {
        try {
          const raw = localStorage.getItem(SETTINGS_KEY);
          if (!raw) return;
          const data = JSON.parse(raw);
          data.forEach((d, i) => {
            const s = STATE.slots[i];
            if (!s) return;
            if (d.label && typeof d.label === 'string') s.label = d.label;
            if (d.audioMode === 'one-way' || d.audioMode === 'two-way') s.audioMode = d.audioMode;
          });
          // The chosen microphone is global, not per-slot — read it off the
          // first record. Validated against the live device list once labels
          // load (refreshMicDevices), so a stale id can't strand listening.
          if (data[0] && typeof data[0].micDeviceId === 'string') MIC.deviceId = data[0].micDeviceId;
        } catch {}
        // Listening always starts OFF — the screen-share picker needs a click.
      }

      /* ================================================================
       * HISTORY (memory-only, this visit only)
       *
       * STATE.sessionHistory is the sole source for the side panel. Nothing
       * is ever fetched back from the sheet and nothing is persisted to
       * disk, so each device/session only ever sees its own conversations
       * and a refresh or tab close starts clean. Q&As still flow UP to the
       * sheet (postChat / postSaveToSheet) as a silent per-session log.
       * ================================================================ */

      // One-time cleanup: older builds cached synced history on disk under
      // HISTORY_KEY. Clear it so returning devices don't keep stale chats.
      try { localStorage.removeItem(HISTORY_KEY); } catch {}

      function entryMs(entry) {
        let ts = Number(entry && entry.timestamp) || 0;
        if (!ts && entry && entry.date) {
          const parsed = Date.parse(entry.date);
          if (!isNaN(parsed)) ts = parsed;
        }
        return ts;
      }

      function formatHistoryDate(entry) {
        const ts = entryMs(entry);
        if (!ts) return entry && entry.date ? String(entry.date) : '';
        const d = new Date(ts);
        const now = new Date();
        const sod = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((sod(now) - sod(d)) / 86400000);
        const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (diff === 0) return 'Today, ' + time;
        if (diff === 1) return 'Yesterday, ' + time;
        if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ', ' + time;
        if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }

      // Compact stamp for the list items: the group header already says
      // "Today"/"Yesterday", so inside those buckets the time alone is enough.
      function formatHistoryTime(entry) {
        const ts = entryMs(entry);
        if (!ts) return entry && entry.date ? String(entry.date) : '';
        const d = new Date(ts);
        const now = new Date();
        const sod = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((sod(now) - sod(d)) / 86400000);
        const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (diff <= 1) return time;
        if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ', ' + time;
        if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }

      function filterHistory(history, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return history;
        return history.filter(h =>
          (h.preview || '').toLowerCase().includes(q) ||
          h.pairs.some(p =>
            p.question.toLowerCase().includes(q) ||
            p.answer.toLowerCase().includes(q)));
      }

      function historyBucket(entry) {
        const ts = entryMs(entry);
        if (!ts) return 'Earlier';
        const d = new Date(ts);
        const now = new Date();
        const sod = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((sod(now) - sod(d)) / 86400000);
        if (diff <= 0) return 'Today';
        if (diff === 1) return 'Yesterday';
        if (diff < 7) return 'Earlier this week';
        if (diff < 30) return 'Earlier this month';
        if (d.getFullYear() === now.getFullYear()) return 'Earlier this year';
        return 'Older';
      }

      const HISTORY_BUCKET_ORDER = ['Today', 'Yesterday', 'Earlier this week', 'Earlier this month', 'Earlier this year', 'Older'];

      function groupHistoryByBucket(history) {
        const groups = {};
        for (const h of history) {
          const k = historyBucket(h);
          (groups[k] = groups[k] || []).push(h);
        }
        return HISTORY_BUCKET_ORDER
          .filter(k => groups[k] && groups[k].length)
          .map(k => ({ label: k, items: groups[k] }));
      }

      // Newest first; capped so a marathon visit can't grow memory unbounded.
      function addSessionHistoryEntry(entry) {
        STATE.sessionHistory.unshift(entry);
        if (STATE.sessionHistory.length > 50) STATE.sessionHistory.length = 50;
      }

      // Local-only: removes the entry from this visit's panel.
      function deleteHistoryEntry(id) {
        STATE.sessionHistory = STATE.sessionHistory.filter(h => h.id !== id);
      }

      /* ================================================================
       * PROXY HEALTH
       * ================================================================ */

      const PROXY = { ready: false, hasKey: false, error: null };

      async function loadRemoteConfig() {
        if (!GSHEET_WEBHOOK) return;
        try {
          const resp = await fetch(GSHEET_WEBHOOK + (GSHEET_WEBHOOK.includes('?') ? '&' : '?') + 'action=ping');
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const info = await resp.json();
          PROXY.ready = !!info.ok;
          PROXY.hasKey = !!info.has_api_key;
          PROXY.error = info.ok ? null : (info.error || 'Proxy returned an error');
        } catch (err) {
          PROXY.ready = false;
          PROXY.error = err && err.message ? err.message : 'Proxy unreachable';
          console.warn('Proxy ping failed:', err);
        }
      }

      // Keep the Apps Script proxy warm while listening is on. Apps Script
      // spins its instance down after a few idle minutes; the next request then
      // pays a 0.5–2 s cold start — and on a live call that tax lands on the
      // FIRST overheard question, exactly when it's most noticeable. A cheap
      // periodic GET to the lightweight ping endpoint keeps the instance warm so
      // the first real answer doesn't eat it. Fire-and-forget: it never mutates
      // PROXY readiness state, so a transient blip can't flip the UI.
      let proxyWarmId = null;
      function pingProxyWarm() {
        if (!GSHEET_WEBHOOK) return;
        const url = GSHEET_WEBHOOK + (GSHEET_WEBHOOK.includes('?') ? '&' : '?') + 'action=ping';
        fetch(url, { method: 'GET' }).catch(() => {});
      }
      function startProxyWarmup() {
        if (proxyWarmId || !GSHEET_WEBHOOK) return;
        pingProxyWarm(); // warm immediately, then on a cadence below the spindown window
        proxyWarmId = setInterval(pingProxyWarm, ASSIST.PROXY_WARM_MS);
      }
      function stopProxyWarmup() {
        if (proxyWarmId) { clearInterval(proxyWarmId); proxyWarmId = null; }
      }

      loadSettings();

      /* ================================================================
       * TEXT HELPERS + SAFE MARKDOWN RENDERER
       * ================================================================ */

      function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }
      function truncate(s, n) {
        s = String(s || '');
        return s.length > n ? s.substring(0, n - 1) + '…' : s;
      }

      // Minimal, safe markdown → HTML for assist answers. All input is
      // HTML-escaped first; only a small whitelist of constructs is then
      // re-introduced (bold, inline code, http(s) links, bullet/numbered
      // lists, mini headers). No raw HTML ever passes through.
      function mdInline(escaped) {
        return escaped
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      }

      function mdToHtml(raw) {
        const lines = String(raw || '').split('\n');
        const out = [];
        let list = null; // 'ul' | 'ol' | null
        const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
        for (const lineRaw of lines) {
          const line = lineRaw.trim();
          if (!line) { closeList(); continue; }
          const esc = mdInline(escHtml(line.replace(/^#{1,4}\s+(.*)$/, '$1')));
          const bullet = line.match(/^[-*•]\s+(.*)$/);
          const num = line.match(/^\d+[.)]\s+(.*)$/);
          if (bullet) {
            if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
            out.push('<li>' + mdInline(escHtml(bullet[1])) + '</li>');
          } else if (num) {
            if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
            out.push('<li>' + mdInline(escHtml(num[1])) + '</li>');
          } else if (/^#{1,4}\s+/.test(line)) {
            closeList();
            out.push('<div class="md-h">' + esc + '</div>');
          } else {
            closeList();
            out.push('<p>' + esc + '</p>');
          }
        }
        closeList();
        return out.join('');
      }

      // Copy text to the clipboard with a toast + brief "copied" state on btn.
      function copyTextToClipboard(text, btn) {
        const done = () => {
          showToast('Copied');
          if (btn) {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1200);
          }
        };
        const fail = () => showToast('Copy failed');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fail);
        } else {
          try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
            done();
          } catch { fail(); }
        }
      }

      /* ================================================================
       * TOAST
       * ================================================================ */

      function showToast(msg) {
        VOICE.toastMessage = msg;
        render();
        if (VOICE.toastTimeoutId) clearTimeout(VOICE.toastTimeoutId);
        VOICE.toastTimeoutId = setTimeout(() => {
          VOICE.toastMessage = '';
          render();
        }, 3500);
      }


      /* ================================================================
       * TTS ECHO GUARDS — retained from the original listening pipeline
       * ================================================================ */


      // True while audio is being spoken OR within the tail window after speech
      // ends — the speaker keeps producing audio briefly after onend fires.
      const TTS_ECHO_GRACE_MS = 1200;
      // Echo text-matching only applies while the tool's audio is playing or
      // shortly after it stops (speaker → mic → ASR adds a few seconds of
      // lag). Beyond that, overlap with shared vocabulary — product names
      // come up in every question — must not swallow genuine speech.
      const TTS_ECHO_TEXT_WINDOW_MS = 8000;
      // The fuzzy word-overlap echo test only runs while the tool's audio is
      // playing or just stopped. On a technical call the NEXT question
      // naturally reuses the vocabulary that was just spoken, so a
      // long fuzzy window makes him deaf to follow-ups — exactly the
      // "doesn't hear the question" failure. Exact-substring matches keep
      // the full TTS_ECHO_TEXT_WINDOW_MS (real echo lags a few seconds).
      const TTS_ECHO_FUZZY_WINDOW_MS = 2500;
      function ttsEchoActive() {
        if (STATE.slots.some(s => s.isSpeaking)) return true;
        if (VOICE.ttsPaused) return true;
        return (Date.now() - VOICE.lastTtsEndAt) < TTS_ECHO_GRACE_MS;
      }
      function markTtsEnded() { VOICE.lastTtsEndAt = Date.now(); }

      function normalizeForEcho(text) {
        return String(text || '').toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function appendRecentTts(text) {
        const n = normalizeForEcho(text);
        if (!n) return;
        VOICE.recentTtsText = (VOICE.recentTtsText + ' ' + n).slice(-2000);
      }

      // True if `text` looks like an echo of something the tool just spoke.
      function isLikelyEcho(text) {
        const n = normalizeForEcho(text);
        if (!n || n.length < 4) return false;
        if (!VOICE.recentTtsText) return false;
        if (!ttsEchoActive() && (Date.now() - VOICE.lastTtsEndAt) > TTS_ECHO_TEXT_WINDOW_MS) return false;
        if (VOICE.recentTtsText.indexOf(n) !== -1) return true;
        // Shared-vocabulary (fuzzy) matching is only trustworthy while the
        // audio is actually playing — past that, treat it as real speech.
        if (!ttsEchoActive() && (Date.now() - VOICE.lastTtsEndAt) > TTS_ECHO_FUZZY_WINDOW_MS) return false;
        const words = n.split(' ').filter(w => w.length >= 3);
        if (words.length < 2) return false;
        const ttsWords = new Set(VOICE.recentTtsText.split(' '));
        let matches = 0;
        for (const w of words) if (ttsWords.has(w)) matches++;
        return (matches / words.length) >= 0.7;
      }

      // The recognizer stays live at all times while listening is on. The
      // echo guards above are retained from the original tool (they are
      // inert now that nothing is ever spoken aloud) so the listening
      // pipeline that calls them is unchanged.

      /* ================================================================
       * SPEECH RECOGNITION — one engine, default microphone only
       * (the recognizer can't accept a custom stream; computer/desktop
       *  sound reaches it acoustically via the un-processed mic capture)
       * ================================================================ */

      function recognitionWanted() { return listeningOn(); }

      function ensureRecognition() {
        if (!VOICE.srSupported) return null;
        if (VOICE.recognition) return VOICE.recognition;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const r = new SR();
        r.continuous = true;
        r.interimResults = true;
        r.lang = 'en-US';
        // Note: no phrase biasing here on purpose. Chrome only supports it
        // for on-device recognition; on cloud recognition it can error the
        // recognizer into a silent restart loop ("phrases-not-supported").
        r.onresult = (e) => {
          VOICE.lastSrEventAt = Date.now();
          let interim = '';
          let finalChunk = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            const t = res[0] && res[0].transcript ? res[0].transcript : '';
            if (res.isFinal) finalChunk += t + ' ';
            else interim += t;
          }
          if (finalChunk) {
            clearInterim();
            handleVoiceTranscript(finalChunk);
          } else if (interim) {
            updateInterim(interim);
          }
        };
        r.onerror = (e) => {
          VOICE.lastSrEventAt = Date.now();
          if (e.error === 'not-allowed') {
            VOICE.permissionDenied = true;
            stopListening({ silent: true });
            showToast('Microphone access is needed — allow the mic and try again');
            return;
          }
          if (e.error === 'service-not-allowed') {
            // Usually a transient hiccup in Chrome's cloud speech service (a
            // network blip, another tab grabbing the recognizer) — NOT a real,
            // permanent block. Killing listening here is what left the tool frozen
            // after a momentary glitch. Rebuild the recognizer and keep going.
            if (VOICE.wantRunning && recognitionWanted()) {
              setTimeout(() => { try { hardResetRecognition(); } catch {} }, 400);
            }
            return;
          }
          if (e.error === 'phrases-not-supported') {
            try { r.phrases = []; } catch {}
            return; // onend restarts cleanly
          }
          if (e.error === 'audio-capture') {
            stopListening({ silent: true });
            showToast("Couldn't use the microphone — check that one is plugged in");
            return;
          }
          // Transient errors (no-speech, aborted, network) fall through to
          // onend, which restarts as needed.
        };
        r.onstart = () => { VOICE.srRunning = true; VOICE.srStartStrikes = 0; VOICE.lastSrEventAt = Date.now(); };
        r.onend = () => {
          VOICE.srRunning = false;
          VOICE.lastSrEventAt = Date.now();
          if (VOICE.ttsPaused || VOICE.dictationPaused) return;
          if (!VOICE.wantRunning || !recognitionWanted()) return;
          // start() can throw InvalidStateError while the previous session is
          // still shutting down — retry with backoff.
          const tryStart = (attempt) => {
            if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
            try { startRecognitionNow(); }
            catch (err) {
              if (attempt < 4) setTimeout(() => tryStart(attempt + 1), 250 * (attempt + 1));
            }
          };
          tryStart(0);
        };
        VOICE.recognition = r;
        return r;
      }

      // Low-level start. Throws on InvalidStateError (caller handles retry).
      function startRecognitionNow() {
        const r = ensureRecognition();
        if (!r) return;
        r.start();
      }

      function startRecognition() {
        const r = ensureRecognition();
        if (!r) return;
        VOICE.wantRunning = true;
        try { startRecognitionNow(); }
        catch (e) { /* already started — ignore */ }
        startRecognitionWatchdog();
      }

      // Last-resort recovery for a hard-wedged recognizer. A SpeechRecognition
      // instance can get stuck so badly that it stops firing events, abort()
      // no longer triggers onend, and start() is a silent no-op — the soft
      // restart path can never revive it, and the listener stays frozen. The
      // only reliable escape is to throw the instance away and build a new one.
      // The dead instance's handlers are detached first so a late event from it
      // can't fight the replacement (its onend would otherwise try to spin up a
      // second recognizer).
      function hardResetRecognition() {
        const old = VOICE.recognition;
        VOICE.recognition = null;
        VOICE.srRunning = false;
        VOICE.srStartStrikes = 0;
        if (old) {
          try { old.onresult = old.onerror = old.onstart = old.onend = null; } catch {}
          try { old.abort(); } catch {}
          try { old.stop(); } catch {}
        }
        if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
        const tryStart = (attempt) => {
          if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
          if (VOICE.srRunning) return;   // a fresh instance already came up
          try { startRecognitionNow(); }
          catch (err) {
            if (attempt < 5) setTimeout(() => tryStart(attempt + 1), 200 * (attempt + 1));
          }
        };
        tryStart(0);
      }

      // How long the recognizer may sit "running" with zero events before
      // it's presumed wedged. Chrome's cloud recognizer occasionally stops
      // delivering results without firing onend during long sessions; an
      // abort() + restart costs under a second and un-sticks it.
      const SR_STALL_MS = 15000;

      // Background-tab insurance. Chrome throttles timers in hidden tabs
      // (e.g. while the user works beside the pop-out chat), so the onend
      // retry chain can run out of attempts and strand the recognizer in a
      // dead state after a long silence. This notices "should be listening
      // but isn't" and kicks it. The mic stream held by startListening()
      // keeps the tab exempt from intensive throttling, so the interval
      // still fires while hidden. It also catches a recognizer that is
      // nominally running but silently wedged (no events for SR_STALL_MS).
      function startRecognitionWatchdog() {
        if (VOICE.watchdogId) return;
        VOICE.watchdogId = setInterval(() => {
          if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
          if (!VOICE.srRunning) {
            // Should be running but isn't. Try the cheap restart, but if the
            // instance keeps refusing to come up (onstart never fires) across a
            // few ticks, it's wedged shut — rebuild it from scratch.
            VOICE.srStartStrikes = (VOICE.srStartStrikes || 0) + 1;
            if (VOICE.srStartStrikes >= 3) { hardResetRecognition(); return; }
            try { startRecognitionNow(); } catch {}
            return;
          }
          VOICE.srStartStrikes = 0;
          if (Date.now() - VOICE.lastSrEventAt > SR_STALL_MS) {
            // Running but silent for too long. First try the cheap path —
            // abort() should fire onend, which restarts cleanly. But a hard
            // wedge ignores abort() and never fires onend, so if the SAME
            // instance is still "running" and still silent shortly after,
            // rebuild it outright instead of aborting a corpse forever.
            const wedged = VOICE.recognition;
            try { wedged && wedged.abort(); } catch {}
            setTimeout(() => {
              if (VOICE.wantRunning && recognitionWanted() && !VOICE.ttsPaused && !VOICE.dictationPaused &&
                  VOICE.recognition === wedged && VOICE.srRunning &&
                  Date.now() - VOICE.lastSrEventAt > SR_STALL_MS) {
                hardResetRecognition();
              }
            }, 1500);
          }
        }, 5000);
      }

      function stopRecognitionWatchdog() {
        if (VOICE.watchdogId) { clearInterval(VOICE.watchdogId); VOICE.watchdogId = null; }
      }

      // Coming back to the foreground is a free chance to revive a
      // recognizer that died while the tab was throttled in the background.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (VOICE.wantRunning && recognitionWanted() && !VOICE.ttsPaused && !VOICE.dictationPaused && !VOICE.srRunning) {
          try { startRecognitionNow(); } catch {}
        }
        // Also a free chance to un-stick a pipeline that wedged while the tab
        // was throttled in the background, so a heard question isn't left
        // frozen on "Analyzing"/"Researching" after the user returns.
        if (listeningOn()) { try { assistWatchdogTick(); } catch {} }
      });

      // Force a clean recognizer restart. abort() triggers onend, which
      // restarts a fresh recognition session.
      function restartRecognition() {
        VOICE.wantRunning = true;
        const r = ensureRecognition();
        if (!r) return;
        try { r.abort(); } catch {}
        // If onend doesn't fire (recognizer was idle), kick it directly.
        setTimeout(() => {
          if (VOICE.wantRunning && recognitionWanted() && !VOICE.ttsPaused && !VOICE.dictationPaused) {
            try { startRecognitionNow(); } catch {}
          }
        }, 150);
      }

      function stopRecognition() {
        VOICE.wantRunning = false;
        stopRecognitionWatchdog();
        if (VOICE.recognition) {
          try { VOICE.recognition.stop(); } catch {}
        }
        VOICE.ttsPaused = false;
        VOICE.interimText = '';
        VOICE.interimSlot = null;
        VOICE.recentTtsText = '';
        STATE.slots.forEach(s => { s.isListening = false; });
      }

      /* ================================================================
       * PASSIVE LISTENING TEARDOWN
       * ================================================================ */

      // Reset transient listening UI state. Called by stopListening().
      function abortActiveReply() {
        STATE.slots.forEach(s => { s.isListening = false; });
        clearInterim();
      }

      // One passive path. Once listening is on, every finalized utterance goes
      // straight to the checklist-coverage pipeline — no wake word, no
      // conversation mode, no turn-taking. The echo guard is retained from the
      // original tool (inert now that nothing is spoken aloud).
      function handleVoiceTranscript(raw) {
        const text = String(raw).trim();
        if (!text) return;
        // Drop re-transcriptions of the tool's own audio (inert — nothing speaks).
        if (isLikelyEcho(text)) return;
        // Two transcribers can hear the same words — the mic (Web Speech) and
        // the digital computer-audio tap (Whisper). On speakers especially,
        // the mic also overhears the call, so the same utterance can arrive
        // from both. Collapse those so a question isn't answered twice.
        if (isDuplicateUtterance(text)) return;
        if (listeningOn()) assistIngest(text);
      }

      // Cross-source de-dupe for finalized utterances. Holds a short rolling
      // window of recent finals (from either transcriber) and rejects a new
      // one that repeats it — exact match, containment, or high token overlap
      // (ASR wording varies slightly between the two engines).
      const RECENT_FINALS = [];
      function isDuplicateUtterance(text) {
        const norm = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!norm) return false;
        const now = Date.now();
        while (RECENT_FINALS.length && now - RECENT_FINALS[0].at > 8000) RECENT_FINALS.shift();
        const tokens = new Set(norm.split(' '));
        for (const e of RECENT_FINALS) {
          if (e.norm === norm) { e.at = now; return true; }
          const shorter = e.norm.length <= norm.length ? e.norm : norm;
          const longer  = e.norm.length <= norm.length ? norm : e.norm;
          if (shorter.length >= 12 && longer.indexOf(shorter) !== -1) { e.at = now; return true; }
          let inter = 0; e.tokens.forEach(w => { if (tokens.has(w)) inter++; });
          const uni = new Set([...e.tokens, ...tokens]).size;
          if (uni > 0 && inter / uni >= 0.8 && Math.min(e.tokens.size, tokens.size) >= 3) { e.at = now; return true; }
        }
        RECENT_FINALS.push({ norm, tokens, at: now });
        return false;
      }

      /* ================================================================
       * INTERIM TRANSCRIPT (live "Hearing live" panel on the voice stage)
       * ================================================================ */

      function interimTargetSlot() {
        return listeningOn() ? 0 : null;
      }

      // Patch the stage panel's transcript text in place when it's mounted;
      // fall back to a render only when it isn't (e.g. listening just turned
      // on). Returns true when the cheap path worked.
      function patchLiveTranscript(text) {
        const wrap = document.getElementById('live-transcript');
        const span = document.getElementById('live-transcript-text');
        if (!wrap || !span) return false;
        span.textContent = text;
        wrap.classList.toggle('hearing', !!text);
        // Teleprompter: as the transcript grows, keep the latest words in view
        // by pinning the scroll position to the bottom of the column.
        wrap.scrollTop = wrap.scrollHeight;
        return true;
      }

      function updateInterim(text) {
        const trimmed = String(text || '').trim();
        if (trimmed.length < 2) { clearInterim(); return; }
        // Don't flash the tool's own audio back onscreen (inert — nothing speaks).
        if (isLikelyEcho(trimmed)) { clearInterim(); return; }
        const target = interimTargetSlot();
        if (target === null) { clearInterim(); return; }

        // Show the corrected wording in the live band so product names read
        // right as they stream ("Intune", not "in tune"). Echo/dedupe above and
        // the answer pipeline still run on the raw transcript — this is a
        // display-only polish on the partial.
        const display = correctTranscript(trimmed) || trimmed;

        const prevText = VOICE.interimText;
        const prevSlot = VOICE.interimSlot;
        VOICE.interimText = display;
        VOICE.interimSlot = target;
        VOICE.interimAt = Date.now();

        if (patchLiveTranscript(display)) return;
        // One render to mount the node — but never while the user is typing,
        // since render() rebuilds the DOM and would steal composer focus.
        if (prevText !== display || prevSlot !== target) {
          if (!isComposerFocused()) render();
        }
      }

      function isComposerFocused() {
        const el = document.activeElement;
        if (!el || !el.id) return false;
        return el.id === 'ck-new-input' || el.id === 'ck-edit-input' || el.id === 'history-search';
      }

      function clearInterim() {
        if (!VOICE.interimText && VOICE.interimSlot === null) return;
        VOICE.interimText = '';
        VOICE.interimSlot = null;
        if (patchLiveTranscript('')) return;
        if (!isComposerFocused()) render();
      }



      /* ================================================================
       * LISTENING — one switch: mic + optional digital computer-audio tap
       * ================================================================ */

      // The big mic button. OFF→ON: start listening in the saved capture
      // mode — one-way (microphone only) or two-way (microphone + the
      // computer's audio via the share picker, exactly as before).
      // ON→OFF: stop.
      async function toggleListening() {
        const slot = STATE.slots[0];
        if (!VOICE.srSupported) { showToast('Listening needs Chrome or Edge'); return; }
        if (slot.listenOn) { stopListening(); return; }
        // No chooser — start with the saved capture mode. One-way (mic only)
        // can auto-start; two-way's screen-share picker rides this click's user
        // activation. The mode is chosen in Settings.
        startListening(slot.audioMode === 'two-way' ? 'two-way' : 'one-way');
      }

      // render() rebuilds #app wholesale, so focus has to be reapplied once the
      // new DOM exists (mirrors the composer-focus pattern elsewhere).
      function focusAfterRender(sel) {
        setTimeout(() => { try { document.querySelector(sel)?.focus(); } catch {} }, 40);
      }

      // One polite live region kept OUTSIDE #app (so render() never wipes it)
      // lets screen readers hear the selected mode and its description as the
      // slider moves — the full-rebuild render can't announce in place.
      function announceLive(msg) {
        let el = document.getElementById('randy-live');
        if (!el) {
          el = document.createElement('div');
          el.id = 'randy-live';
          el.className = 'sr-only';
          el.setAttribute('aria-live', 'polite');
          el.setAttribute('aria-atomic', 'true');
          document.body.appendChild(el);
        }
        // Clear first so re-selecting the same value still re-announces.
        el.textContent = '';
        setTimeout(() => { el.textContent = msg; }, 30);
      }

      // Open the audio-mode slider. Pre-selects the last mode
      // and moves focus into the dialog for keyboard / screen-reader users.
      function openAudioChooser() {
        const slot = STATE.slots[0];
        if (!VOICE.srSupported) { showToast('Listening needs Chrome or Edge'); return; }
        if (slot.listenOn) return;
        if (slot.audioMode !== 'one-way' && slot.audioMode !== 'two-way') slot.audioMode = 'two-way';
        STATE.audioChooserOpen = true;
        render();
        focusAfterRender('.ac-modal');
      }

      // Close the chooser without starting (X / backdrop / Escape) and return
      // focus to the voice control that opened it.
      function closeAudioChooser() {
        if (!STATE.audioChooserOpen) return;
        STATE.audioChooserOpen = false;
        render();
        focusAfterRender('.vp');
      }

      async function startListening(mode, { auto = false } = {}) {
        const slot = STATE.slots[0];
        if (slot.listenOn) return 'ok';
        const r = ensureRecognition();
        if (!r) { if (!auto) showToast('Listening needs Chrome or Edge'); return 'unsupported'; }

        // Resolve the capture mode chosen in the audio-mode
        // slider, falling back to the remembered preference, then two-way.
        const audioMode = (mode === 'one-way' || mode === 'two-way') ? mode
          : (slot.audioMode === 'one-way' ? 'one-way' : 'two-way');
        // Persist the mode only for an explicit user choice. The auto-start path
        // ALWAYS runs one-way (its screen-share picker can't open without a
        // click), so it must not overwrite a saved two-way preference — on disk
        // or in memory — or every panel open would silently downgrade a two-way
        // user to one-way and their next manual toggle would start one-way too.
        if (!auto) {
          slot.audioMode = audioMode;
          saveSettings();
        }
        const twoWay = audioMode === 'two-way';

        // TWO-WAY ONLY: offer the digital computer-audio tap FIRST, while the
        // click's transient activation is still fresh — getDisplayMedia
        // requires it, and the mic getUserMedia await below would otherwise
        // consume it. This resolves whether or not the user actually shares
        // audio; if they dismiss the picker we continue mic-only.
        // One-way mode never taps the computer's audio at all.
        if (twoWay && DESKTOP.supported) {
          try { await startDesktopCapture(); } catch {}
        }

        // Ask for the mic up front so a denial fails loudly here, with a
        // clear message, instead of dying quietly inside the recognizer.
        // The stream is HELD for the whole listening session, not stopped:
        // an active capture exempts the tab from Chrome's intensive timer
        // throttling, which is what keeps the restart watchdog alive while
        // the user works beside the docked pop-out with this tab hidden.
        //
        // Mic capture. This held stream is the keep-alive capture (it exempts
        // the tab from background timer throttling so the watchdog keeps
        // firing) AND the mic-permission gate. The Web Speech recognizer opens
        // its OWN capture on the system default device, so these constraints
        // shape the held stream — and, on machines where both share the default
        // device, influence what the recognizer overhears acoustically.
        //
        //   TWO-WAY — audio processing is turned OFF on purpose. The tool must
        //     transcribe BOTH the user's voice and the call playing on the
        //     speakers, and the only source the recognizer can use is the
        //     system default microphone, so the computer's sound reaches it
        //     acoustically: the mic physically hears the speakers.
        //       echoCancellation subtracts your own speaker output from the
        //         mic — but that output IS the call audio we want — so it's
        //         OFF. Its aggressiveness varies by machine/OS/driver, which is
        //         why acoustic capture worked on one computer (weak AEC) but
        //         not another (strong AEC stripped the computer sound).
        //       noiseSuppression treats the steady call audio as background and
        //         attenuates it — OFF.
        //       autoGainControl rides toward the loudest source (the local
        //         speaker), ducking everything else — OFF.
        //     All three off so desktop/call sound survives to the recognizer
        //     the same way on every machine. (TTS self-echo is handled in
        //     software via VOICE.recentTtsText matching.)
        //
        //   ONE-WAY — the exact opposite. The user asked to pick up ONLY
        //     their own voice and NOT what anyone else is saying, so the
        //     standard processing is turned ON: echo cancellation removes the
        //     call audio leaking from the speakers, while noise suppression and
        //     auto-gain keep the focus on the person at the mic. Combined with
        //     never starting the computer-audio tap above, this keeps the
        //     "only what you're saying" promise honest.
        // The device is MIC.deviceId when the user pinned one in Settings,
        // otherwise the system default ('default' as a soft `ideal` so it never
        // OverconstrainedErrors on browsers without a virtual "default" device).
        // acquireMicStream handles a pinned-but-unplugged device by falling back
        // to the default, so a stale choice can never strand listening.
        const micStatus = await acquireMicStream(twoWay);
        if (micStatus !== 'ok') {
          if (micStatus === 'denied') {
            // A genuine denial — stop auto-retrying and tell the user how to
            // fix it. A later open starts a fresh context and tries again.
            VOICE.permissionDenied = true;
            showToast('The microphone is needed. Click Allow and try again.');
          } else if (micStatus === 'no-device') {
            if (!auto) showToast("Couldn't find a microphone — check that one is connected.");
          } else {
            // Transient: the device is momentarily busy or the capture stack is
            // still warming up in the instant the panel opens. Stay quiet on the
            // auto path so the retry loop can recover without toast spam; the
            // manual path keeps its original feedback.
            if (!auto) showToast('The microphone is needed. Click Allow and try again.');
          }
          // Two-way opened the computer-audio share BEFORE this mic prompt (the
          // share picker needs the click's fresh activation). A mic failure here
          // leaves slot.listenOn false, so no listening session exists and
          // nothing will ever call stopListening() — that would strand the live
          // screen/tab share, its AudioContext, and the Whisper worker running
          // invisibly until the panel closes. Tear the tap down now.
          if (twoWay) stopDesktopCapture();
          render();
          return micStatus;
        }

        slot.listenOn = true;
        TECH.heard = 0;
        TECH.answered = 0;
        TECH.decisions = [];
        startRecognition();
        startAssistWatchdog();
        startProxyWarmup();   // keep the proxy hot so the first coverage check skips the cold start
        // Warn right away if the AI service is unreachable, so "hears but
        // never checks anything off" can't happen silently.
        loadRemoteConfig().then(() => {
          if (!PROXY.ready) showToast('⚠ The AI service is unreachable — items cannot be auto-checked');
          else if (!PROXY.hasKey) showToast('⚠ The AI service has no API key — items cannot be auto-checked');
        });
        showToast(twoWay ? 'Listening — your mic and computer audio' : 'Listening to your microphone');
        render();
        return 'ok';
      }

      // Reliable auto-start. The side panel reloads into a fresh context on
      // every open, and the mic capture can transiently fail in the instant the
      // panel appears (device momentarily busy, capture stack still warming up).
      // A single attempt that quit on that error would leave listening off until
      // the user taps the orb — so keep retrying with backoff until listening
      // actually sticks, stopping only on success, a real mic denial, an
      // unsupported browser, or no microphone present.
      function autoStartListening(attempt = 0) {
        if (STATE.slots[0].listenOn) return;                       // already listening
        if (!VOICE.srSupported || VOICE.permissionDenied) return;  // can't / user said no
        const retry = () => {
          if (STATE.slots[0].listenOn || VOICE.permissionDenied) return;
          if (attempt < 12) setTimeout(() => autoStartListening(attempt + 1), Math.min(2000, 300 + attempt * 250));
        };
        Promise.resolve()
          .then(() => startListening('one-way', { auto: true }))
          .then((status) => {
            if (STATE.slots[0].listenOn) return;                   // it stuck — done
            // Terminal outcomes don't get retried; everything else (transient
            // capture failures) does.
            if (status === 'denied' || status === 'unsupported' || status === 'no-device') return;
            retry();
          })
          .catch(retry);
      }

      function stopListening({ silent = false } = {}) {
        const slot = STATE.slots[0];
        const wasOn = slot.listenOn;
        slot.listenOn = false;
        if (VOICE.micStream) {
          try { VOICE.micStream.getTracks().forEach(t => t.stop()); } catch {}
          VOICE.micStream = null;
        }
        clearAssistBuffer();
        stopAssistWatchdog();
        stopProxyWarmup();
        // Cancel any in-flight classifier round-trip and bump the epoch so a
        // late resolution after teardown is ignored.
        TECH.classifyGen++;
        if (TECH.classifyController) { try { TECH.classifyController.abort(); } catch {} TECH.classifyController = null; }
        TECH.pending = false;
        TECH.pendingSince = 0;
        abortActiveReply();   // clears transient listening UI state
        stopRecognition();
        stopDesktopCapture();
        if (!silent && wasOn) showToast('Stopped listening');
        render();
      }

      // Opening Settings while listening used to glitch the sheet: the
      // live-transcript pipeline calls render() constantly, and render()
      // rebuilds the Settings sheet (it lives inside #app), so inputs lost
      // focus and the page jumped. Pause listening on the way in and remember
      // the mode so we can resume it on the way out. No-op when listening is
      // already off — which is exactly why the glitch never happened from the
      // already-off state. Silent so the user doesn't get a "stopped
      // listening" toast just for opening Settings.
      function pauseListenForSettings() {
        const slot = STATE.slots[0];
        if (!slot.listenOn) { STATE.settingsResumeListen = false; return; }
        STATE.settingsResumeListen = slot.audioMode === 'two-way' ? 'two-way' : 'one-way';
        stopListening({ silent: true });
      }

      // Leaving Settings — resume the listening paused on the way in, in the
      // same mode. Runs inside the closing click so two-way's screen-share
      // picker still has the user activation it needs. No-op if we weren't
      // listening when Settings opened.
      function resumeListenAfterSettings() {
        const mode = STATE.settingsResumeListen;
        STATE.settingsResumeListen = false;
        if (mode) startListening(mode);
      }

      /* ================================================================
       * DESKTOP / COMPUTER AUDIO — digital tap + in-browser Whisper
       *
       * getDisplayMedia (the tab/screen-share picker, "share audio" ticked)
       * gives us the call's real audio, even on headphones. We can't hand
       * that stream to the Web Speech recognizer, so we transcribe it locally
       * with a Whisper model running in a Web Worker (WebGPU, WASM fallback).
       * Nothing is uploaded; the audio never leaves the browser. Finalized
       * utterances go to handleVoiceTranscript() — the same pipeline the mic
       * feeds — so answers happen the same way regardless of source.
       * ================================================================ */

      // PCM tap that runs OFF the main thread. The old ScriptProcessorNode
      // fired its callback on the main thread, so every audio block competed
      // with rendering and made the page lag while computer-audio capture was
      // running. This AudioWorklet does the same job on the audio thread and
      // batches samples into 4096-frame blocks so the main-thread VAD math in
      // processDesktopBlock() stays identical. Loaded from a Blob URL to keep
      // the app single-file. NOTE: keep this free of ${...} — it's a template.
      const PCM_WORKLET_SRC = `
        class RandyPCM extends AudioWorkletProcessor {
          constructor() { super(); this._buf = new Float32Array(4096); this._n = 0; }
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (ch) {
              for (let i = 0; i < ch.length; i++) {
                this._buf[this._n++] = ch[i];
                if (this._n === this._buf.length) {
                  this.port.postMessage(this._buf.slice(0));
                  this._n = 0;
                }
              }
            }
            return true;
          }
        }
        registerProcessor('randy-pcm', RandyPCM);
      `;

      // The transcription worker now lives in its own bundled file,
      // whisper-worker.js, which imports the vendored Transformers.js + ONNX
      // Runtime locally (no CDN) so it runs under the MV3 CSP. See
      // startWhisperWorker() below and the header comment in that file. Only the
      // model weights download at runtime; audio never leaves the machine.

      // Reflect capture state in the live strip without a full re-render.
      function setDesktopStatus(text) {
        DESKTOP.statusText = text || '';
        const el = document.getElementById('desktop-status');
        if (el) { el.textContent = DESKTOP.statusText; el.classList.toggle('on', !!DESKTOP.statusText); }
      }

      async function startDesktopCapture() {
        if (DESKTOP.on || !DESKTOP.supported) return;
        let stream;
        try {
          // We only ever want the AUDIO from this share — the video track is
          // stopped immediately below. Requesting a full-res/full-framerate
          // screen capture just to discard it is what makes the UI freeze the
          // moment you pick a surface in the picker, so constrain the video to
          // a tiny 1 fps stream: the capture pipeline becomes nearly free while
          // the picker still offers the same "share tab/system audio" choices.
          // The picker hints keep surface-switching available and stop the
          // captured audio from being echoed back out of the local speakers.
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 1, max: 1 }, width: { max: 640 }, height: { max: 360 } },
            audio: true,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'include',
            systemAudio: 'include',
            suppressLocalAudioPlayback: false
          });
        } catch (err) {
          // Picker dismissed or permission denied — continue mic-only.
          return;
        }
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
          // Shared a window/screen but didn't tick "share audio". The video is
          // useless to us, so drop the whole share and stay on the mic.
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          showToast('No computer audio shared — re-share and ' + osShareAudioHint() + '. Using mic only.');
          return;
        }
        // Audio only — stop the video track so we aren't grabbing the screen.
        stream.getVideoTracks().forEach(t => { try { t.stop(); } catch {} });

        DESKTOP.stream = stream;
        DESKTOP.on = true;
        // If the user clicks Chrome's "Stop sharing", tear this path down.
        audioTracks[0].addEventListener('ended', () => { stopDesktopCapture(); render(); });

        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          DESKTOP.audioCtx = new Ctx({ sampleRate: ASR.SAMPLE_RATE });
          if (DESKTOP.audioCtx.state === 'suspended') { try { await DESKTOP.audioCtx.resume(); } catch {} }
          DESKTOP.sourceNode = DESKTOP.audioCtx.createMediaStreamSource(new MediaStream([audioTracks[0]]));

          // A silent gain → destination "pulls" the graph so the tap keeps
          // running without echoing the captured audio back to the speakers.
          const sink = DESKTOP.audioCtx.createGain();
          sink.gain.value = 0;
          sink.connect(DESKTOP.audioCtx.destination);

          // Prefer the AudioWorklet (off the main thread → no UI lag). Fall
          // back to the deprecated ScriptProcessor only where it's missing.
          let usingWorklet = false;
          if (DESKTOP.audioCtx.audioWorklet) {
            try {
              if (!DESKTOP.workletUrl) {
                DESKTOP.workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SRC], { type: 'text/javascript' }));
              }
              await DESKTOP.audioCtx.audioWorklet.addModule(DESKTOP.workletUrl);
              const node = new AudioWorkletNode(DESKTOP.audioCtx, 'randy-pcm');
              node.port.onmessage = (e) => processDesktopBlock(e.data);
              DESKTOP.sourceNode.connect(node);
              node.connect(sink);
              DESKTOP.procNode = node;
              usingWorklet = true;
            } catch (e) {
              console.warn('AudioWorklet unavailable — using ScriptProcessor fallback:', (e && e.message) || e);
            }
          }
          if (!usingWorklet) {
            const proc = DESKTOP.audioCtx.createScriptProcessor(4096, 1, 1);
            proc.onaudioprocess = (e) => { processDesktopBlock(e.inputBuffer.getChannelData(0)); };
            DESKTOP.sourceNode.connect(proc);
            proc.connect(sink);
            DESKTOP.procNode = proc;
          }
        } catch (err) {
          showToast('Could not set up computer-audio capture — using mic only.');
          stopDesktopCapture();
          return;
        }

        startWhisperWorker();
        setDesktopStatus('Computer audio: loading transcriber…');
        showToast('Capturing computer audio');
      }

      function startWhisperWorker() {
        if (DESKTOP.worker) return;
        try {
          // The transcriber is a REAL bundled file (whisper-worker.js) that
          // imports the vendored Transformers.js + ONNX Runtime locally — no
          // CDN, so the MV3 CSP (script-src 'self') permits it. Resolve its URL
          // through chrome.runtime so it's the extension origin; fall back to a
          // relative path only when that API is somehow absent.
          const workerUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
            ? chrome.runtime.getURL('whisper-worker.js')
            : 'whisper-worker.js';
          DESKTOP.worker = new Worker(workerUrl, { type: 'module' });
          DESKTOP.modelLoading = true;
          DESKTOP.worker.onmessage = onWhisperMessage;
          DESKTOP.worker.onerror = (e) => {
            // Graceful, silent fallback: the mic path still works, so don't
            // show an alarming banner/toast. Tear down the now-useless capture
            // graph (share + AudioContext + worker) instead of just clearing
            // the status — otherwise a headless computer-audio tap keeps running
            // idle for the rest of the session.
            console.warn('desktop transcriber failed to load — using mic only:', (e && e.message) || '');
            stopDesktopCapture();
          };
          DESKTOP.worker.postMessage({ type: 'init' });
        } catch (err) {
          // Browser can't spin up the module worker — listening stays on the mic.
          // Silent fallback, no confusing notification.
          console.warn('in-page transcriber unavailable — using mic only:', (err && err.message) || err);
          setDesktopStatus('');
        }
      }

      // Whisper invents canned phrases when it's fed near-silence, music, or
      // room tone — "Thank you.", "you", "Thanks for watching" — and Web Speech
      // never produces these, so they're a reliable tell for a non-speech
      // segment. It also occasionally loops a word or short clause. Both corrupt
      // the question pipeline (a hallucinated "Thank you." can debounce-flush as
      // a real utterance), so scrub them before a transcript is treated as
      // speech. Only ever drops an output that is ENTIRELY a known hallucination
      // — real questions containing these words pass through untouched.
      const ASR_HALLUCINATIONS = new Set([
        'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching',
        'thank you for watching', 'thanks for listening', 'please subscribe',
        'like and subscribe', 'subscribe', 'bye', 'goodbye', 'okay', 'ok', 'so',
        'the end', 'music', 'applause', 'silence', 'foreign', 'yeah', 'mm', 'mhm',
        'uh', 'um', 'huh', 'hmm'
      ]);

      function sanitizeAsrText(text) {
        let t = String(text || '').trim();
        if (!t) return '';
        // Collapse an immediately repeated word: "the the the call" → "the call".
        t = t.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
        // Collapse a short clause looped 3+ times ("no clean way no clean way
        // no clean way" → one copy) — Whisper's other repetition shape.
        t = t.replace(/\b(\w+(?:\s+\w+){0,3})(?:\s+\1\b){2,}/gi, '$1');
        t = t.replace(/\s+/g, ' ').trim();
        // Drop if what's left is nothing but a known silence hallucination.
        const norm = t.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
        if (!norm || ASR_HALLUCINATIONS.has(norm)) return '';
        return t;
      }

      function onWhisperMessage(ev) {
        const d = ev.data || {};
        if (d.type === 'ready') {
          DESKTOP.workerReady = true;
          DESKTOP.modelLoading = false;
          DESKTOP.device = d.device || '';
          setDesktopStatus('Computer audio: on' + (d.device === 'wasm' ? ' (CPU)' : ''));
          return;
        }
        if (d.type === 'error') {
          DESKTOP.modelLoading = false;
          // The in-browser transcriber couldn't start (WebGPU/WASM/model load).
          // The mic keeps working, so this is not something the
          // user needs to see or act on — surfacing "transcriber unavailable"
          // only confuses people. Fall back to mic-only silently; the detail is
          // left in the console for debugging.
          console.warn('desktop transcriber unavailable — using mic only:', d.error || '');
          // The transcriber can't run, so the computer-audio tap can never
          // produce text — tear the whole graph down rather than leave the
          // share/AudioContext/worker running idle for the rest of the session.
          stopDesktopCapture();
          return;
        }
        if (d.type === 'result') {
          DESKTOP.inFlight = Math.max(0, DESKTOP.inFlight - 1);
          const text = sanitizeAsrText(d.text);
          if (!text) return;
          if (d.final) handleVoiceTranscript(text);
          else updateInterim(text);
        }
      }

      // Adaptive voice-activity segmentation over the 16 kHz PCM. Builds up one
      // utterance, finalizes it after a trailing pause (or a hard length cap),
      // and refreshes a live partial in between.
      //
      // Dual-threshold + adaptive noise floor: while the line is quiet the noise
      // floor tracks the ambient level, and a segment OPENS only when the block
      // clearly exceeds it (or the fixed SILENCE_RMS floor, whichever is higher)
      // and stays open until it drops below a lower CLOSE threshold. The gap
      // between the two gives hysteresis (a brief dip mid-word won't split the
      // sentence), and a short pre-roll of pre-onset audio is prepended so the
      // first word isn't clipped — both directly improve what Whisper hears.
      function processDesktopBlock(frame) {
        if (!DESKTOP.on) return;
        const n = frame.length;
        const blockMs = (n / ASR.SAMPLE_RATE) * 1000;
        let sum = 0;
        for (let i = 0; i < n; i++) { const s = frame[i]; sum += s * s; }
        const rms = Math.sqrt(sum / n);

        const nf = DESKTOP.noiseFloor;
        const openThr = Math.max(ASR.SILENCE_RMS, nf * ASR.NOISE_OPEN_FACTOR);
        const closeThr = Math.max(ASR.CLOSE_FLOOR, nf * ASR.NOISE_CLOSE_FACTOR);

        if (!DESKTOP.speaking) {
          // Idle: let the ambient estimate drift toward the current level so the
          // bar rises in a noisy room and relaxes again when it goes quiet.
          DESKTOP.noiseFloor = Math.min(
            ASR.NOISE_FLOOR_MAX,
            Math.max(0.0005, nf * 0.97 + rms * 0.03)
          );
          if (rms >= openThr) {
            DESKTOP.speaking = true;
            DESKTOP.silenceRun = 0;
            DESKTOP.voicedRun = blockMs;
            seedSegFromPreRoll();   // recover the word onset captured before this block
            appendSeg(frame);
          } else {
            pushPreRoll(frame);     // keep rolling silent context for the next onset
          }
        } else {
          appendSeg(frame); // keep trailing audio for a clean cutoff
          if (rms >= closeThr) {
            DESKTOP.silenceRun = 0;
            DESKTOP.voicedRun += blockMs;
          } else {
            DESKTOP.silenceRun += blockMs;
            if (DESKTOP.silenceRun >= ASR.SILENCE_MS) { flushSegment(); return; }
          }
          if ((DESKTOP.segLen / ASR.SAMPLE_RATE) * 1000 >= ASR.MAX_SEG_MS) {
            flushSegment();
            return;
          }
        }
        maybeInterim();
      }

      // Rolling buffer of recent silent frames so the audio just BEFORE a word's
      // onset can be prepended to the segment (Whisper mis-reads clipped starts).
      function pushPreRoll(frame) {
        DESKTOP.preRoll.push(new Float32Array(frame));
        DESKTOP.preRollLen += frame.length;
        const cap = Math.round((ASR.PREROLL_MS / 1000) * ASR.SAMPLE_RATE);
        // Keep at least one prior block regardless of cap (one block already
        // carries ~0.25 s of onset context).
        while (DESKTOP.preRoll.length > 1 && DESKTOP.preRollLen - DESKTOP.preRoll[0].length >= cap) {
          DESKTOP.preRollLen -= DESKTOP.preRoll.shift().length;
        }
      }

      // Move the buffered pre-roll into the front of the open segment. The
      // frames are already owned copies, so no re-copy is needed.
      function seedSegFromPreRoll() {
        for (const c of DESKTOP.preRoll) { DESKTOP.seg.push(c); DESKTOP.segLen += c.length; }
        DESKTOP.preRoll = [];
        DESKTOP.preRollLen = 0;
      }

      function appendSeg(frame) {
        DESKTOP.seg.push(new Float32Array(frame)); // ScriptProcessor reuses its buffer — copy
        DESKTOP.segLen += frame.length;
        const cap = ASR.MAX_TAIL_S * ASR.SAMPLE_RATE;
        while (DESKTOP.segLen > cap && DESKTOP.seg.length > 1) {
          DESKTOP.segLen -= DESKTOP.seg.shift().length;
        }
      }

      function concatSeg() {
        const out = new Float32Array(DESKTOP.segLen);
        let off = 0;
        for (const c of DESKTOP.seg) { out.set(c, off); off += c.length; }
        return out;
      }

      function flushSegment() {
        const voiced = DESKTOP.voicedRun;
        const audio = DESKTOP.segLen ? concatSeg() : null;
        DESKTOP.seg = [];
        DESKTOP.segLen = 0;
        DESKTOP.speaking = false;
        DESKTOP.silenceRun = 0;
        DESKTOP.voicedRun = 0;
        if (!audio || voiced < ASR.MIN_VOICED_MS) return; // too short — likely a noise blip
        if (!DESKTOP.workerReady || !DESKTOP.worker) return;
        DESKTOP.reqId++;
        DESKTOP.inFlight++;
        DESKTOP.worker.postMessage({ type: 'transcribe', id: DESKTOP.reqId, final: true, audio }, [audio.buffer]);
      }

      // Throttled live partial: transcribe the open segment so the strip shows
      // words as they're spoken. Single-flight so inference can't pile up.
      function maybeInterim() {
        if (!DESKTOP.workerReady || !DESKTOP.worker || !DESKTOP.speaking) return;
        if (DESKTOP.inFlight > 0) return;
        if (DESKTOP.voicedRun < 400) return;
        const now = Date.now();
        if (now - DESKTOP.lastInterimAt < ASR.INTERIM_MS) return;
        DESKTOP.lastInterimAt = now;
        const audio = concatSeg();
        DESKTOP.reqId++;
        DESKTOP.inFlight++;
        DESKTOP.worker.postMessage({ type: 'transcribe', id: DESKTOP.reqId, final: false, audio }, [audio.buffer]);
      }

      function stopDesktopCapture() {
        if (DESKTOP.procNode) {
          try {
            DESKTOP.procNode.disconnect();
            if (DESKTOP.procNode.port) DESKTOP.procNode.port.onmessage = null; // AudioWorkletNode
            DESKTOP.procNode.onaudioprocess = null;                            // ScriptProcessorNode
          } catch {}
          DESKTOP.procNode = null;
        }
        if (DESKTOP.sourceNode) { try { DESKTOP.sourceNode.disconnect(); } catch {} DESKTOP.sourceNode = null; }
        if (DESKTOP.audioCtx) { try { DESKTOP.audioCtx.close(); } catch {} DESKTOP.audioCtx = null; }
        if (DESKTOP.stream) { try { DESKTOP.stream.getTracks().forEach(t => t.stop()); } catch {} DESKTOP.stream = null; }
        if (DESKTOP.worker) { try { DESKTOP.worker.terminate(); } catch {} DESKTOP.worker = null; }
        if (DESKTOP.workerUrl) { try { URL.revokeObjectURL(DESKTOP.workerUrl); } catch {} DESKTOP.workerUrl = null; }
        if (DESKTOP.workletUrl) { try { URL.revokeObjectURL(DESKTOP.workletUrl); } catch {} DESKTOP.workletUrl = null; }
        DESKTOP.on = false;
        DESKTOP.workerReady = false;
        DESKTOP.modelLoading = false;
        DESKTOP.seg = [];
        DESKTOP.segLen = 0;
        DESKTOP.speaking = false;
        DESKTOP.silenceRun = 0;
        DESKTOP.voicedRun = 0;
        DESKTOP.noiseFloor = ASR.NOISE_FLOOR_INIT;
        DESKTOP.preRoll = [];
        DESKTOP.preRollLen = 0;
        DESKTOP.inFlight = 0;
        DESKTOP.device = '';
        setDesktopStatus('');
      }

      /* ---------- utterance buffering + coverage classification ---------- */

      function clearAssistBuffer() {
        TECH.buffer = '';
        TECH.deferrals = 0;
        TECH.questionQueue = [];
        if (TECH.bufferTimerId) { clearTimeout(TECH.bufferTimerId); TECH.bufferTimerId = null; }
      }

      // ASR finalizes mid-sentence constantly. Join fragments and run the
      // coverage check only after a quiet gap, so "so let's talk about" +
      // "the rollout timeline" lands as one utterance.
      function assistIngest(text) {
        const t = String(text || '').trim();
        if (!t) return;
        TECH.buffer = (TECH.buffer + ' ' + t).trim().slice(-ASSIST.MAX_BUFFER_CHARS);
        if (TECH.bufferTimerId) clearTimeout(TECH.bufferTimerId);
        TECH.bufferTimerId = setTimeout(flushAssistBuffer, ASSIST.DEBOUNCE_MS);
      }

      function flushAssistBuffer() {
        TECH.bufferTimerId = null;
        const slot = STATE.slots[0];
        if (!slot.listenOn) { clearAssistBuffer(); return; }
        const candidate = TECH.buffer.trim();

        // The speaker is still mid-sentence (fresh interim words are
        // arriving) — hold the flush so the utterance isn't cut off halfway.
        // The final transcript re-arms the timer when it lands; bounded so
        // a stale interim can't stall the pipeline.
        if (VOICE.interimText &&
            Date.now() - VOICE.interimAt < ASSIST.INTERIM_FRESH_MS &&
            TECH.deferrals < ASSIST.MAX_DEFERRALS) {
          TECH.deferrals++;
          TECH.bufferTimerId = setTimeout(flushAssistBuffer, ASSIST.INTERIM_RECHECK_MS);
          return;
        }

        // Reset the join buffer now so any new speech accumulates separately,
        // whether this candidate is checked immediately or queued.
        TECH.buffer = '';
        TECH.deferrals = 0;
        if (!candidate) return;

        // A previous coverage check is still in flight — queue the finalized
        // utterance so it's folded into the window and checked in turn instead
        // of being merged into the next utterance or silently dropped.
        if (TECH.pending) {
          enqueueUtterance(candidate);
          return;
        }

        processAssistCandidate(candidate);
      }

      // Push an utterance onto the FIFO queue, dropping the oldest if the
      // queue is over its cap. Dropping is safe here: the utterance stays in
      // the conversation window, so the next check still sees it.
      function enqueueUtterance(candidate) {
        TECH.questionQueue.push(candidate);
        if (TECH.questionQueue.length > ASSIST.MAX_QUEUE) TECH.questionQueue.shift();
        renderAssistStatus();
      }

      // The classifier just freed up: process the next queued utterance, if
      // any, through the same path as a fresh one.
      function drainUtteranceQueue() {
        if (TECH.pending) return;
        const slot = STATE.slots[0];
        if (!slot.listenOn) { TECH.questionQueue = []; return; }
        if (!TECH.questionQueue.length) return;
        const next = TECH.questionQueue.shift();
        renderAssistStatus();
        processAssistCandidate(next);
      }

      // Self-healing watchdog — the backstop behind the per-call timeout. It
      // mirrors the recognizer's startRecognitionWatchdog: every few seconds
      // it looks for a coverage check that has been busy far longer than its
      // own timeout should ever allow and un-sticks it. The mic stream held by
      // startListening keeps this interval firing even in a background tab. In
      // normal operation it never acts — the per-call timeout settles
      // everything first; this only earns its keep if something slips past it.
      function startAssistWatchdog() {
        if (TECH.watchdogId) return;
        TECH.watchdogId = setInterval(assistWatchdogTick, ASSIST.WATCHDOG_MS);
      }

      function stopAssistWatchdog() {
        if (TECH.watchdogId) { clearInterval(TECH.watchdogId); TECH.watchdogId = null; }
      }

      function assistWatchdogTick() {
        const slot = STATE.slots[0];
        if (!slot || !slot.listenOn) return;
        const now = Date.now();

        // Classifier wedged: the coverage check has been in flight far longer
        // than its timeout permits. Bump the epoch so the original promise
        // can't double-fire if it ever wakes, abort the round-trip, and move
        // on. Recovery is conservative by design: nothing gets checked off.
        if (TECH.pending && TECH.pendingSince && now - TECH.pendingSince > ASSIST.PENDING_WEDGE_MS) {
          console.warn('coverage watchdog: classifier wedged — recovering');
          TECH.classifyGen++;
          if (TECH.classifyController) { try { TECH.classifyController.abort(); } catch {} }
          TECH.classifyController = null;
          TECH.pending = false;
          TECH.pendingSince = 0;
          TECH.activeText = '';
          renderAssistStatus();
          drainUtteranceQueue();
        }
      }

      // Run the coverage check for a finalized utterance: fold it into the
      // rolling conversation window, then ask the classifier whether any
      // still-unchecked checklist item has now been genuinely covered.
      // CONSERVATIVE by design — every uncertain or failed path does nothing
      // and leaves the checklist exactly as it was. Auto-UNchecking does not
      // exist anywhere in this pipeline.
      function processAssistCandidate(candidate) {
        const words = candidate.split(/\s+/).filter(Boolean);
        if (candidate.length < ASSIST.MIN_CHARS || words.length < ASSIST.MIN_WORDS) {
          drainUtteranceQueue();
          return;
        }
        const corrected = correctTranscript(candidate);

        // Two transcribers can surface the same words twice — skip a repeat.
        const now = Date.now();
        if (TECH.lastSubmitted && now - TECH.lastSubmittedAt < ASSIST.DEDUPE_MS && fuzzyEqual(corrected, TECH.lastSubmitted)) {
          drainUtteranceQueue();
          return;
        }
        TECH.lastSubmitted = corrected;
        TECH.lastSubmittedAt = now;

        pushAssistContext(corrected);

        // Nothing left for the classifier to check (everything is covered, or
        // the remaining unchecked items were manually vetoed) — skip the call.
        const unchecked = classifiableItems();
        if (!unchecked.length) { renderAssistStatus(); drainUtteranceQueue(); return; }

        TECH.pending = true;
        TECH.pendingSince = Date.now();
        TECH.activeText = corrected;   // surfaced in the live "Checking the list" band
        // New classify cycle. The epoch lets a late resolution be ignored if
        // the watchdog already gave up on this one, so a stale verdict can
        // never tick a box. The controller lets the watchdog abort a wedged
        // round-trip.
        const gen = ++TECH.classifyGen;
        const classifyCtl = new AbortController();
        TECH.classifyController = classifyCtl;
        renderAssistStatus();
        classifyCoverage(TECH.context.slice(), unchecked, classifyCtl.signal)
          .then(decision => {
            if (gen !== TECH.classifyGen) return;   // superseded by the watchdog — ignore
            TECH.pending = false;
            TECH.pendingSince = 0;
            TECH.classifyController = null;
            TECH.activeText = '';
            // A reply we couldn't read as a verdict (proxy didn't forward
            // structured output, or returned prose/empty) is treated exactly
            // like "not covered": conservative, nothing changes.
            if (decision.parsed !== false) {
              const conf = typeof decision.confidence === 'number' ? decision.confidence : 0;
              const item = (decision.covered === true && decision.item_id)
                ? unchecked.find(i => i.id === decision.item_id)
                : null;
              // The gate: the classifier must (1) say covered, (2) name a real
              // still-unchecked item, and (3) clear the HIGH confidence bar.
              const accepted = !!item && conf >= ASSIST.CONF_THRESHOLD;
              recordAssistDecision(corrected, accepted, conf, item ? item.text : '');
              if (accepted) autoCheckChecklistItem(item.id, decision.evidence || '', conf);
            }
            renderAssistStatus();
            drainUtteranceQueue();
          })
          .catch(err => {
            if (gen !== TECH.classifyGen) return;   // superseded by the watchdog — ignore
            TECH.pending = false;
            TECH.pendingSince = 0;
            TECH.classifyController = null;
            TECH.activeText = '';
            console.error('coverage classifier failed:', err);
            toastPipelineError("Couldn't check the conversation against the list", err);
            // Conservative failure mode: nothing is checked off; the utterance
            // stays in the window for the next check.
            renderAssistStatus();
            drainUtteranceQueue();
          });
      }

      function pushAssistContext(text) {
        TECH.context.push(text);
        while (TECH.context.length > ASSIST.CONTEXT_LEN) TECH.context.shift();
      }

      function recordAssistDecision(text, accepted, confidence, topic) {
        TECH.heard++;
        TECH.decisions.push({ text, accepted: !!accepted, confidence: Number(confidence) || 0, topic: topic || '', ts: Date.now() });
        while (TECH.decisions.length > ASSIST.DECISIONS_KEEP) TECH.decisions.shift();
      }

      // One pipeline-failure toast per 30s — loud, but not spammy.
      function toastPipelineError(prefix, err) {
        const now = Date.now();
        if (now - TECH.lastErrorToastAt < 30000) return;
        TECH.lastErrorToastAt = now;
        showToast(prefix + ' — ' + (err && err.message ? err.message : err));
      }

      function fuzzyEqual(a, b) {
        const n = s => String(s).toLowerCase().replace(/[^\w]+/g, ' ').trim();
        return n(a) === n(b);
      }

      // Status-only refresh that respects input focus (a full render would
      // steal the caret mid-typing; in that case skip — the next natural
      // render catches up).
      function renderAssistStatus() {
        if (!isComposerFocused()) render();
      }

      // One coverage check. Same plumbing as the original classifier — the
      // same proxy, the same postChat call shape, the same structured-output
      // mechanism — only the prompt, schema and inputs changed.
      async function classifyCoverage(contextArr, uncheckedItemsArr, signal) {
        if (!GSHEET_WEBHOOK) return { covered: false, confidence: 0, parsed: true };
        // Each unchecked item goes in as "- id: text"; when the item carries a
        // current rubric (built in the background for exactly this text), it is
        // appended compactly so the judge scores against it. An item without a
        // rubric — or whose rubric is stale after an edit — just uses its bare
        // text. Purely a prompt-assembly concern: never blocks, never waits.
        const itemLines = (uncheckedItemsArr || []).map(i => {
          let line = '- ' + i.id + ': ' + i.text;
          const s = i.spec;
          if (s && i.specText === i.text) {
            if (s.definition_of_done)                                line += '\n    Done when: ' + s.definition_of_done;
            if (Array.isArray(s.covers) && s.covers.length)          line += '\n    Counts if: ' + s.covers.join('; ');
            if (Array.isArray(s.example_phrases) && s.example_phrases.length) line += '\n    Might sound like: ' + s.example_phrases.join('; ');
            if (Array.isArray(s.not_covered) && s.not_covered.length) line += '\n    Does NOT count: ' + s.not_covered.join('; ');
          }
          return line;
        }).join('\n');
        const ctxLines = (contextArr || []).map((u, i) => (i + 1) + '. ' + u).join('\n');
        const userContent =
          'Checklist items still unchecked:\n' + itemLines + '\n\n' +
          'Recent conversation window (oldest first):\n' + ctxLines;
        const data = await postChat({
          model: MODELS.classifier,
          max_tokens: 200,
          system: COVERAGE_SYSTEM,
          messages: [{ role: 'user', content: userContent }],
          output_config: { format: { type: 'json_schema', schema: COVERAGE_SCHEMA } },
          save: false // keep classifier churn out of the usage sheet
        }, signal, ASSIST.CLASSIFY_TIMEOUT_MS);
        return parseCoverageReply(String(data.reply || ''));
      }

      // Structured outputs guarantee valid JSON, but parse defensively anyway
      // (older proxy deployments may not forward output_config). parsed:false
      // flags a reply we could not read as a verdict — the caller treats it
      // conservatively and checks nothing off.
      function parseCoverageReply(reply) {
        const m = reply.match(/\{[\s\S]*\}/);
        if (!m) return { covered: false, confidence: 0, parsed: false };
        try {
          const j = JSON.parse(m[0]);
          return {
            covered: j.covered === true,
            item_id: typeof j.item_id === 'string' ? j.item_id.trim() : '',
            confidence: typeof j.confidence === 'number' ? j.confidence : 0,
            evidence: typeof j.evidence === 'string' ? j.evidence.trim() : '',
            parsed: true
          };
        } catch {
          return { covered: false, confidence: 0, parsed: false };
        }
      }

      /* ================================================================
       * API LAYER
       * ================================================================ */

      // One POST to the Apps Script proxy. text/plain avoids the CORS
      // preflight Apps Script can't answer.
      //
      // Every call is bounded by a hard timeout. A fetch with no timeout can
      // hang indefinitely — a slow Apps Script cold-start, a connection that
      // stalls without ever erroring, the tab being backgrounded mid-request.
      // Left unbounded, a hung classifier call would freeze the whole assist
      // pipeline forever (its promise never settles, so TECH.pending never
      // clears and no further question is ever answered). The timeout aborts
      // the request so the promise ALWAYS settles; it composes with any
      // caller-supplied signal so user-initiated cancel still works. A timeout
      // surfaces as a TimeoutError (not AbortError), so callers treat it as a
      // real failure to retry/fall back rather than a silent user cancel.
      async function postChat(body, signal, timeoutMs) {
        if (!GSHEET_WEBHOOK) {
          throw new Error('Answer service is not configured.');
        }
        // Make sure the anon id is loaded before attaching metadata.user_id. It
        // resolves long before any real call, so this never adds latency.
        try { await ensureIdentity(); } catch {}
        const payload = Object.assign({ action: 'chat', session_id: SESSION_ID }, body);
        // Tag the model call with the opaque anonymous install id (metadata
        // .user_id) — never the name or any other personal info. The proxy
        // forwards this through to the Anthropic request.
        if (IDENTITY.anonId) {
          payload.metadata = Object.assign({}, payload.metadata, { user_id: IDENTITY.anonId });
        }
        const timer = new AbortController();
        const ms = timeoutMs || ASSIST.ANSWER_TIMEOUT_MS;
        const timeoutId = setTimeout(
          () => { try { timer.abort(new DOMException('Request timed out', 'TimeoutError')); } catch { timer.abort(); } },
          ms
        );
        const onAbort = () => { try { timer.abort(signal.reason); } catch { timer.abort(); } };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          const resp = await fetch(GSHEET_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            signal: timer.signal
          });
          if (!resp.ok) throw new Error('Proxy HTTP ' + resp.status);
          const data = await resp.json();
          if (!data || data.ok === false) {
            throw new Error((data && data.error) || 'Proxy returned an error');
          }
          return data;
        } finally {
          clearTimeout(timeoutId);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      }

      // Fire-and-forget write-back of one checked-off item to the Apps Script
      // backend ("action":"log_item" → the sheet's "Checklist Log" tab). Called
      // the moment an item is ticked — by the classifier (covered_by:"auto",
      // with the evidence + confidence that cleared the bar) or by a manual
      // tap (covered_by:"you"). Unchecks and resets are never logged: the
      // sheet is an append-only record of what was covered and when, not a
      // mirror of the checkbox state. Failures only warn — a logging hiccup
      // must never disturb the call in progress.
      function postLogItem(it, confidence) {
        if (!GSHEET_WEBHOOK || !it) return Promise.resolve();
        const total = CHECKLIST.items.length;
        const done = CHECKLIST.items.filter(x => x.checked || x === it).length;
        return fetch(GSHEET_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'log_item',
            session_id: SESSION_ID,
            item_text: it.text || '',
            covered_by: it.checkedBy || '',
            evidence: it.evidence || '',
            confidence: (typeof confidence === 'number') ? confidence : '',
            progress: done + ' of ' + total,
            // Usage log only (NOT a model call): pair the event with the
            // anonymous id AND the captured name so rows in the sheet can be
            // traced back to a user.
            user_id: IDENTITY.anonId || '',
            user_name: identityFullName(),
            first_name: IDENTITY.userName ? IDENTITY.userName.firstName : '',
            last_name: IDENTITY.userName ? IDENTITY.userName.lastName : ''
          })
        }).catch(err => console.warn('Checklist log failed:', err));
      }

      // Fire-and-forget save (the proxy's legacy save action). The checklist
      // tool answers no questions, so nothing calls this anymore — it is
      // retained untouched as documentation of the proxy's save channel.
      function postSaveToSheet({ question, answer, sources, model, sessionId }) {
        if (!GSHEET_WEBHOOK || !question || !answer) return Promise.resolve();
        return fetch(GSHEET_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            question: question,
            answer: answer,
            sources: Array.isArray(sources) ? sources.join(', ') : String(sources || ''),
            model: model || '',
            session_id: sessionId || '',
            // Usage log only (NOT the model call): pair each inquiry with the
            // anonymous id AND the captured name so rows in the sheet can be
            // traced back to a user. (The API request above gets the id alone.)
            user_id: IDENTITY.anonId || '',
            user_name: identityFullName(),
            first_name: IDENTITY.userName ? IDENTITY.userName.firstName : '',
            last_name: IDENTITY.userName ? IDENTITY.userName.lastName : ''
          })
        }).catch(err => console.warn('Background save failed:', err));
      }

      /* ================================================================
       * RENDER
       * ================================================================ */

      // render() rebuilds the whole DOM, which would reset every scroll
      // container to the top. Capture positions first and restore after:
      // if the user was at (or near) the bottom, stick to the bottom so the
      // newest answer stays in view; otherwise put them back where they were.
      const SCROLL_IDS = ['home-scroll-0'];

      function captureScroll() {
        const state = {};
        for (const id of SCROLL_IDS) {
          const el = document.getElementById(id);
          if (!el) continue;
          state[id] = {
            top: el.scrollTop,
            atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 48
          };
        }
        return state;
      }

      function restoreScroll(state) {
        for (const id in state) {
          const el = document.getElementById(id);
          if (!el) continue;
          el.scrollTop = (state[id].atBottom && id !== 'home-scroll-0')
            ? el.scrollHeight
            : Math.min(state[id].top, el.scrollHeight);
        }
      }

      // render() rebuilds #app wholesale, which drops focus from whatever field
      // the user was typing in. Background renders fire constantly during a call
      // (an overheard answer landing, a toast, a live-status refresh), so without
      // this a user typing in the composer — or searching History — loses the
      // caret every few seconds. Capture the focused input/textarea and its caret
      // before the rebuild and restore both after. Only same-page fields with a
      // stable id qualify; if nothing is focused it's a no-op.
      function captureFocus() {
        const el = document.activeElement;
        if (!el || !el.id) return null;
        if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return null;
        let start = null, end = null;
        try { start = el.selectionStart; end = el.selectionEnd; } catch {}
        return { id: el.id, start, end };
      }

      function restoreFocus(state) {
        if (!state) return;
        const el = document.getElementById(state.id);
        if (!el || el === document.activeElement) return;
        try {
          el.focus();
          if (state.start != null && el.setSelectionRange) {
            el.setSelectionRange(state.start, state.end);
          }
        } catch {}
      }

      // One-time onboarding screen: ask for first + last name, then hand off to
      // the normal tool. Reuses the global click/keydown handlers (the Save
      // button is data-action="save-onboarding"). The name is read straight off
      // the inputs on Save, so no per-keystroke render steals the caret.
      function renderOnboarding(root) {
        if (!IDENTITY.loaded) {
          // Identity still loading and no fast-path hint — paint a blank panel in
          // the app's own background colour (no card, no text) so the few-ms wait
          // is invisible instead of a flash of UI.
          root.innerHTML = '<div class="onb-blank"></div>';
          return;
        }
        const f = IDENTITY.userName ? escAttr(IDENTITY.userName.firstName) : '';
        const l = IDENTITY.userName ? escAttr(IDENTITY.userName.lastName) : '';
        root.innerHTML = `
          <div class="onb-wrap">
            <div class="onb-card" role="dialog" aria-label="Welcome to the Virtual Sales Assistant">
              <div class="onb-logo"><i data-lucide="sparkles" class="w-6 h-6"></i></div>
              <h1 class="onb-title">Welcome</h1>
              <p class="onb-sub">Before we start, what should we call you? We only ask this once.</p>
              <label class="onb-label" for="onb-first">First name</label>
              <input id="onb-first" class="onb-input" type="text" autocomplete="given-name" placeholder="First name" value="${f}" />
              <label class="onb-label" for="onb-last">Last name</label>
              <input id="onb-last" class="onb-input" type="text" autocomplete="family-name" placeholder="Last name" value="${l}" />
              <div id="onb-error" class="onb-error" role="alert" aria-live="polite"></div>
              <button class="onb-save" data-action="save-onboarding">Save &amp; continue</button>
            </div>
          </div>`;
        if (window.lucide?.createIcons) try { window.lucide.createIcons(); } catch {}
        bindEvents();
        setTimeout(() => { try { document.getElementById('onb-first')?.focus(); } catch {} }, 30);
      }

      function render() {
        const root = document.getElementById('app');
        if (!root) return;
        // Identity gate: until a name is saved for this install, the panel shows
        // ONLY the one-time onboarding screen — never the normal tool. Once a
        // name exists (this install, ever) this branch is skipped for good. The
        // synchronous hint inside shouldShowApp() keeps reloads instant.
        if (!shouldShowApp()) {
          renderOnboarding(root);
          return;
        }
        const scroll = captureScroll();
        const focus = captureFocus();
        root.innerHTML = `
          <div class="app-frame">
            ${renderSidebar()}
            <div class="sidebar-scrim ${STATE.historyOpen ? 'show' : ''}" data-action="toggle-history"></div>
            <main class="main-col" data-screen-label="${STATE.activeTab === 'settings' ? 'Settings' : (HISTORY_VIEW.open ? 'Saved conversation' : 'Checklist')}">
              ${renderMain()}
            </main>
          </div>
          ${STATE.activeTab === 'settings' ? renderSettingsSheet() : ''}
          ${renderAudioChooser()}
          ${renderToast()}
        `;
        if (window.lucide?.createIcons) try { window.lucide.createIcons(); } catch {}
        restoreScroll(scroll);
        restoreFocus(focus);
        bindEvents();
      }

      /* ---------- voice state machine (drives the mic orb) ---------- */

      function voiceModel(slot, idx) {
        const on = !!slot.listenOn;
        const sr = VOICE.srSupported;

        if (!sr) return {
          orbClass: 'off', orbInner: '<i data-lucide="mic-off" class="w-8 h-8"></i>',
          action: 'noop', title: 'Listening needs Chrome or Edge', disabled: true, live: false
        };
        if (on) return {
          orbClass: 'monitor', orbInner: '<i data-lucide="mic" class="w-8 h-8"></i>',
          action: 'toggle-listen', title: 'Listening is on — click to turn it off', disabled: false, live: true
        };
        return {
          orbClass: 'off', orbInner: '<i data-lucide="mic" class="w-8 h-8"></i>',
          action: 'toggle-listen', title: 'Click to start listening', disabled: false, live: false
        };
      }

      /* ---------- sidebar ---------- */

      function renderSidebarItem(h) {
        const confirming = STATE.historyConfirmDeleteId === h.id;
        const active = HISTORY_VIEW.open === h.id;
        return `
          <div class="sb-item ${active ? 'active' : ''}${confirming ? ' confirming' : ''}" role="button" tabindex="0" data-action="${confirming ? 'noop' : 'view-history'}" data-id="${escAttr(h.id)}" title="Open saved conversation">
            <div class="sb-item-body">
              <div class="sb-item-title">${escHtml(h.preview || 'Untitled conversation')}</div>
              <div class="sb-item-meta">${escHtml(formatHistoryTime(h))}${h.pairs.length > 1 ? ' · ' + h.pairs.length + ' Q&amp;As' : ''}</div>
              ${confirming ? `
                <div class="sb-confirm">
                  <span>Delete this conversation?</span>
                  <button class="no" data-action="cancel-delete-history" data-id="${escAttr(h.id)}">Cancel</button>
                  <button class="ok" data-action="confirm-delete-history-yes" data-id="${escAttr(h.id)}">Delete</button>
                </div>
              ` : ''}
            </div>
            ${confirming ? '' : `
              <div class="sb-item-actions">
                <button class="danger" data-action="confirm-delete-history" data-id="${escAttr(h.id)}" title="Delete" aria-label="Delete">
                  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
              </div>
            `}
          </div>`;
      }

      function renderSidebar() {
        const history = STATE.sessionHistory;
        const filtered = filterHistory(history, STATE.historyQuery);
        return `
          <aside class="sidebar ${STATE.historyOpen ? 'open' : ''}" data-screen-label="Sidebar">
            <div class="sb-brand">
              <span class="sb-logo"><span class="lg-re">Sales</span> Assistant</span>
              <span class="sb-tagline">Call checklist</span>
              <button class="sb-close" data-action="toggle-history" title="Close menu" aria-label="Close menu">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
            <div class="sb-controls">
              <div class="sb-label">Options</div>
              <button class="sb-ctl" data-action="reset-checklist" title="Uncheck every checklist item for the next call">
                <i data-lucide="rotate-ccw" class="w-4 h-4"></i>
                <span class="sb-ctl-label">Reset checklist</span>
              </button>
            </div>
            <div class="sb-divider"></div>
            ${history.length > 0 ? `
              <div class="sb-search">
                <i data-lucide="search" class="sb-search-ic w-3.5 h-3.5"></i>
                <input type="text" id="history-search" placeholder="Search conversations" value="${escAttr(STATE.historyQuery)}" autocomplete="off" aria-label="Search saved conversations" />
                ${STATE.historyQuery ? `
                  <button class="sb-search-clear" data-action="clear-history-search" title="Clear search" aria-label="Clear search">
                    <i data-lucide="x" class="w-3 h-3"></i>
                  </button>
                ` : ''}
              </div>
            ` : ''}
            <div class="sb-label">Conversations</div>
            <div class="sb-list history-panel-open">
              ${history.length === 0 ? `
                <div class="sb-empty">Nothing saved from this visit.<br>History clears when the panel closes.</div>
              ` : filtered.length === 0 ? `
                <div class="sb-empty">No conversations match &ldquo;${escHtml(truncate(STATE.historyQuery.trim(), 30))}&rdquo;.</div>
              ` : groupHistoryByBucket(filtered).map(g => `
                <div class="sb-group">
                  <div class="sb-group-head">${escHtml(g.label)}</div>
                  ${g.items.map(h => renderSidebarItem(h)).join('')}
                </div>
              `).join('')}
            </div>
          </aside>`;
      }

      /* ---------- main column ---------- */

      function renderMain() {
        if (HISTORY_VIEW.open) {
          const entry = STATE.sessionHistory.find(h => h.id === HISTORY_VIEW.open);
          if (entry) return renderSavedView(entry);
        }
        return renderHome(STATE.slots[0], 0);
      }

      function renderChatHeader(slot, idx, vm) {
        const on = !!slot.listenOn;
        const sub = TECH.pending ? 'Checking the list\u2026'
          : on ? 'Listening to your call'
          : 'Online \u00b7 call checklist';
        return `
          <header class="chat-head">
            <button class="icon-btn sb-toggle" data-action="toggle-history" title="Menu" aria-label="Open menu">
              <i data-lucide="panel-left" class="w-5 h-5"></i>
            </button>
            <div class="chat-avatar ${on ? '' : 'muted'}">${escHtml(slot.label.charAt(0))}<span class="status-dot"></span></div>
            <div class="head-titles">
              <div class="conv-title">${escHtml(slot.label)}</div>
              <div class="conv-sub">${sub}</div>
            </div>
            <div class="head-actions">
              <button class="icon-btn" data-action="switch-tab" data-tab="settings" title="Settings" aria-label="Settings">
                <i data-lucide="more-horizontal" class="w-5 h-5"></i>
              </button>
            </div>
          </header>`;
      }

      // What is the assistant doing right now? One model drives the console's
      // stage badge and the big live text.
      function consoleModel(slot) {
        if (!VOICE.srSupported) return { stageKey: 'off', label: 'Voice needs Chrome or Edge', mode: 'prompt', text: 'The assistant listens through the browser\u2019s speech engine, which runs in Chrome or Edge.' };
        if (TECH.pending) return { stageKey: 'analyzing', label: 'Checking the list', mode: 'question', text: TECH.activeText || VOICE.interimText || '' };
        if (slot.listenOn) return { stageKey: 'listening', label: 'Listening to the call', mode: 'transcript', text: VOICE.interimText || '' };
        return { stageKey: 'off', label: 'Not listening', mode: 'prompt', text: '' };
      }

      // The main stage: status title, the mic (on/off), and live voice-to-text.
      function renderConsole(slot, idx, vm) {
        const cm = consoleModel(slot);

        // The live transcript node carries the patchable id ONLY while the
        // assistant is actively hearing the call, so the in-place interim
        // patch never clobbers the settled utterance shown mid-check.
        const liveNode = slot.listenOn && cm.stageKey === 'listening';
        let body;
        if (liveNode) {
          body = `<div class="cl-transcript ac-live ${VOICE.interimText ? 'hearing' : ''}" id="live-transcript"><span id="live-transcript-text">${escHtml(VOICE.interimText || '')}</span><span class="interim-caret">\u258a</span></div>`;
        } else if (cm.mode === 'question') {
          body = cm.text ? `<div class="cl-transcript">${escHtml(cm.text)}</div>` : `<div class="cl-transcript cl-tr-muted">Working on it\u2026</div>`;
        } else {
          body = `<div class="cl-transcript cl-tr-muted">Tap the mic to start listening \u2014 items below are checked off automatically as you genuinely cover them on the call.</div>`;
        }

        return `
          <div class="console stage-${cm.stageKey}">
            <div class="console-inner">
              <div class="cl-status">${escHtml(cm.label)}</div>
              <div class="console-orb">
                <div class="orb-wrap ${vm.live ? 'live' : ''}">
                  <span class="orb-ring"></span>
                  <span class="orb-ring d"></span>
                  <button class="voice-orb ${vm.orbClass}" title="${escAttr(vm.title)}" aria-label="${escAttr(vm.title)}" data-action="${vm.action}" data-idx="${idx}" ${vm.disabled ? 'disabled' : ''}>
                    ${vm.orbInner}
                  </button>
                </div>
              </div>
              ${body}
              ${DESKTOP.on ? `<div class="cl-desktop ${DESKTOP.statusText ? 'on' : ''}" id="desktop-status">${escHtml(DESKTOP.statusText)}</div>` : ''}
            </div>
          </div>`;
      }

      /* ---------- home screen: listening console + the checklist ---------- */

      function renderHome(slot, idx) {
        const vm = voiceModel(slot, idx);
        return `
          ${renderChatHeader(slot, idx, vm)}
          <div class="split-row">
            <div class="top-stage">
              ${renderConsole(slot, idx, vm)}
            </div>
            <div class="right-col">
              <div id="home-scroll-${idx}" class="msg-scroll">
                ${renderChecklist()}
              </div>
            </div>
          </div>`;
      }

      // The visual checklist — the tool's main feature. Unchecked items look
      // plain; covered items get a checkmark and struck-through/greyed text.
      // The seller can add, edit, reorder and remove items before and during
      // a call, and can always tap an item to check/uncheck it manually.
      function renderChecklist() {
        const items = CHECKLIST.items;
        const done = items.filter(i => i.checked).length;
        return `
          <div class="ck-panel" data-screen-label="Checklist">
            <div class="ck-head">
              <div class="ck-title"><i data-lucide="list-checks" class="w-4 h-4"></i>Call checklist</div>
              <span class="ck-count">${items.length ? done + ' of ' + items.length + ' covered' : 'No items yet'}</span>
              <button class="ck-reset" data-action="reset-checklist" ${items.length ? '' : 'disabled'} title="Uncheck everything for the next call">
                <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i>Reset
              </button>
            </div>
            <div class="ck-list">
              ${items.length
                ? items.map((it, i) => renderChecklistItem(it, i, items.length)).join('')
                : `<div class="ck-empty">Add the things you want to cover on this call.<br>They\u2019re checked off automatically as the conversation genuinely covers them \u2014 or tap any item to check it yourself. A reusable default list lives in Settings.</div>`}
            </div>
            <div class="ck-add">
              <input type="text" id="ck-new-input" placeholder="Add something to cover\u2026" value="${escAttr(STATE.newItemText)}" autocomplete="off" aria-label="Add a checklist item" />
              <button class="ck-add-btn" data-action="add-check-item" title="Add item" aria-label="Add item" ${STATE.newItemText.trim() ? '' : 'disabled'}>
                <i data-lucide="plus" class="w-4 h-4"></i>
              </button>
            </div>
          </div>`;
      }

      function renderChecklistItem(it, i, total) {
        if (STATE.editingItemId === it.id) {
          return `
            <div class="ck-item editing">
              <input type="text" id="ck-edit-input" value="${escAttr(STATE.editItemText)}" autocomplete="off" aria-label="Edit item text" />
              <button class="ck-icon ok" data-action="save-edit-item" data-id="${escAttr(it.id)}" title="Save" aria-label="Save"><i data-lucide="check" class="w-4 h-4"></i></button>
              <button class="ck-icon" data-action="cancel-edit-item" title="Cancel" aria-label="Cancel"><i data-lucide="x" class="w-4 h-4"></i></button>
            </div>`;
        }
        const checked = !!it.checked;
        const fresh = checked && it.checkedAt && (Date.now() - it.checkedAt < 5000);
        const evidence = checked && it.checkedBy === 'auto' && it.evidence
          ? `<div class="ck-evidence"><i data-lucide="ear" class="w-3 h-3"></i><span>${escHtml(truncate(it.evidence, 90))}</span></div>`
          : (checked && it.checkedBy === 'you' ? `<div class="ck-evidence you">Checked by you</div>` : '');
        return `
          <div class="ck-item ${checked ? 'done' : ''}${fresh ? ' fresh' : ''}">
            <button class="ck-box ${checked ? 'on' : ''}" role="checkbox" aria-checked="${checked}" data-action="toggle-check-item" data-id="${escAttr(it.id)}" title="${checked ? 'Uncheck' : 'Check off'}" aria-label="${checked ? 'Uncheck' : 'Check off'}: ${escAttr(it.text)}">
              ${checked ? '<i data-lucide="check" class="w-3.5 h-3.5"></i>' : ''}
            </button>
            <div class="ck-body" data-action="toggle-check-item" data-id="${escAttr(it.id)}" role="button" tabindex="0" title="${checked ? 'Tap to uncheck' : 'Tap to check off'}">
              <div class="ck-text">${escHtml(it.text)}</div>
              ${evidence}
            </div>
            <div class="ck-actions">
              <button class="ck-icon" data-action="move-check-item" data-id="${escAttr(it.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up"><i data-lucide="chevron-up" class="w-4 h-4"></i></button>
              <button class="ck-icon" data-action="move-check-item" data-id="${escAttr(it.id)}" data-dir="1" ${i === total - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down"><i data-lucide="chevron-down" class="w-4 h-4"></i></button>
              <button class="ck-icon" data-action="edit-check-item" data-id="${escAttr(it.id)}" title="Edit" aria-label="Edit"><i data-lucide="pencil" class="w-4 h-4"></i></button>
              <button class="ck-icon danger" data-action="delete-check-item" data-id="${escAttr(it.id)}" title="Remove" aria-label="Remove"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>
          </div>`;
      }

      /* ---------- saved conversation (read-only, opens in place) ---------- */

      function renderSavedView(entry) {
        const confirming = STATE.historyConfirmDeleteId === entry.id;
        const pairCount = entry.pairs.length;
        return `
          <div class="saved-view history-popout">
            <header class="chat-head">
              <button class="icon-btn sb-toggle" data-action="toggle-history" title="Conversations" aria-label="Open conversations">
                <i data-lucide="panel-left" class="w-5 h-5"></i>
              </button>
              <button class="icon-btn" data-action="close-history" title="Back to current chat" aria-label="Back to current chat">
                <i data-lucide="arrow-left" class="w-5 h-5"></i>
              </button>
              <div class="head-titles">
                <div class="conv-title">${escHtml(entry.preview || 'Saved conversation')}</div>
                <div class="conv-sub">Saved · ${escHtml(formatHistoryDate(entry))} · ${pairCount === 1 ? '1 Q&amp;A' : pairCount + ' Q&amp;As'}</div>
              </div>
              <div class="head-actions">
                ${confirming ? `
                  <span class="confirm-label">Delete this conversation?</span>
                  <button class="btn-ghost" data-action="cancel-delete-history" data-id="${escAttr(entry.id)}">Cancel</button>
                  <button class="btn-danger-solid" data-action="confirm-delete-history-popout" data-id="${escAttr(entry.id)}">Delete</button>
                ` : `
                  <button class="icon-btn danger" data-action="confirm-delete-history" data-id="${escAttr(entry.id)}" title="Delete conversation" aria-label="Delete conversation">
                    <i data-lucide="trash-2" class="w-5 h-5"></i>
                  </button>
                `}
              </div>
            </header>
            <div class="msg-scroll">
              <div class="msg-col">
                <div class="saved-note"><i data-lucide="archive" class="w-3.5 h-3.5"></i>Read-only copy</div>
                ${entry.pairs.map((p, i) => `
                  <div class="msg-row me"><div class="chat-bubble chat-user">${escHtml(p.question)}</div></div>
                  <div class="msg-row">
                    <div class="msg-av">A</div>
                    <div class="popout-answer">
                      <div class="chat-bubble chat-bot chat-md" style="white-space:normal">${mdToHtml(p.answer)}</div>
                      <button class="popout-copy" data-action="copy-answer" data-id="${escAttr(entry.id)}" data-pair="${i}" title="Copy answer" aria-label="Copy answer">
                        <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                      </button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>`;
      }

      /* ---------- settings shell ---------- */

      function renderSettingsSheet() {
        return `
          <div class="sheet-scrim" data-action="close-settings-bg">
            <div class="sheet" role="dialog" aria-label="Settings">
              <div class="sheet-grab"></div>
              <div class="sheet-head">
                <div class="sheet-title">Settings</div>
                <button class="sheet-x" data-action="switch-tab" data-tab="home" title="Close" aria-label="Close"><i data-lucide="x" class="w-5 h-5"></i></button>
              </div>
              <div class="sheet-body">${renderSettings()}</div>
            </div>
          </div>`;
      }

      // Single source of truth for the chooser's per-mode copy, reused by the
      // rendered card and the screen-reader announcement so they never drift.
      function audioModeInfo(mode) {
        return mode === 'one-way'
          ? { label: 'One-way audio', icon: 'mic', sub: 'Microphone only', line: "This will only pick up what you're saying and not what anyone else is saying." }
          : { label: 'Two-way audio', icon: 'volume-2', sub: 'Microphone + computer audio', line: 'This will pick up your audio and whatever audio is on your computer — the way to hear the other side of the call.' };
      }

      // Audio-mode chooser. The slider picks the capture mode; the confirm
      // button's click is the user gesture that startListening() needs for
      // the mic / screen-share prompts.
      function renderAudioChooser() {
        if (!STATE.audioChooserOpen) return '';
        const oneWay = STATE.slots[0].audioMode === 'one-way';
        const desc = audioModeInfo(oneWay ? 'one-way' : 'two-way');
        return `
          <div class="ac-scrim" data-action="close-audio-chooser-bg">
            <div class="ac-modal" role="dialog" aria-modal="true" aria-label="How should the assistant listen?" aria-describedby="ac-desc-text" tabindex="-1">
              <button class="ac-x" data-action="close-audio-chooser" title="Cancel" aria-label="Cancel"><i data-lucide="x" class="w-4 h-4"></i></button>
              <div class="ac-title">How should it listen?</div>
              <p class="ac-sub">Choose how audio is captured while listening is on.</p>
              <div class="ac-seg ${oneWay ? 'left' : 'right'}" role="tablist" aria-label="Audio mode">
                <span class="ac-seg-thumb" aria-hidden="true"></span>
                <button class="ac-seg-opt ${oneWay ? 'on' : ''}" role="tab" aria-selected="${oneWay}" data-action="set-audio-mode" data-mode="one-way">One-way audio</button>
                <button class="ac-seg-opt ${oneWay ? '' : 'on'}" role="tab" aria-selected="${!oneWay}" data-action="set-audio-mode" data-mode="two-way">Two-way audio</button>
              </div>
              <div class="ac-desc">
                <div class="ac-desc-ic"><i data-lucide="${desc.icon}" class="w-5 h-5"></i></div>
                <div class="ac-desc-body" id="ac-desc-text">
                  <div class="ac-desc-sub">${desc.sub}</div>
                  <p class="ac-desc-line">${desc.line}</p>
                </div>
              </div>
              <button class="ac-go" data-action="confirm-audio-mode">
                <i data-lucide="mic" class="w-4 h-4"></i>Start listening
              </button>
            </div>
          </div>`;
      }

      function renderToast() {
        if (!VOICE.toastMessage) return '';
        return `<div class="voice-toast">${escHtml(VOICE.toastMessage)}</div>`;
      }

      /* ---------- settings ---------- */

      function renderSettings() {
        const es = STATE.editingSlot;
        const slot = STATE.slots[es];
        const mode = slot.audioMode === 'two-way' ? 'two-way' : 'one-way';
        return `
          <div class="space-y-4">
            <div class="settings-section settings-grid">
              <div class="full flex items-center gap-3">
                <div class="w-9 h-9 rounded-full grid place-items-center text-white font-bold" style="background:var(--primary)">${escHtml(slot.label.charAt(0))}</div>
                <h3 class="text-lg font-semibold" style="color:var(--navy)">${escHtml(slot.label)} — Configuration</h3>
              </div>

              <div class="full set-listen">
                <div class="set-h"><i data-lucide="headphones" class="w-4 h-4"></i>How it listens</div>
                <div class="seg2 ${mode === 'two-way' ? 'right' : 'left'}">
                  <span class="seg2-thumb"></span>
                  <button class="seg2-opt ${mode === 'one-way' ? 'on' : ''}" data-action="pick-audio-mode" data-mode="one-way"><i data-lucide="mic" class="w-3.5 h-3.5"></i>One-way</button>
                  <button class="seg2-opt ${mode === 'two-way' ? 'on' : ''}" data-action="pick-audio-mode" data-mode="two-way"><i data-lucide="volume-2" class="w-3.5 h-3.5"></i>Two-way</button>
                </div>
                <p class="set-note">${mode === 'two-way'
                  ? 'Mic <strong>plus your computer&rsquo;s audio</strong> &mdash; the way to hear the other side of the call on <strong>headphones</strong>. A screen-share prompt appears; ' + osShareAudioHint() + '. When the capture succeeds you&rsquo;ll see &ldquo;Computer audio connected&rdquo; below.'
                  : 'Your <strong>microphone only</strong> &mdash; just what you say, not the call audio on your speakers. Best when you&rsquo;re on <strong>speakers</strong> and only want your own voice picked up.'}</p>
                ${mode === 'two-way' ? `
                  <button class="set-share" data-action="share-computer-audio"><i data-lucide="monitor-speaker" class="w-4 h-4"></i>${DESKTOP.on ? 'Re-share computer audio&hellip;' : 'Share computer audio&hellip;'}</button>
                  ${DESKTOP.on ? `<div class="set-ok"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i>Computer audio connected</div>` : ''}
                ` : ''}
              </div>

              <div>
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Display Name</label>
                <input type="text" id="setting-label" value="${escAttr(slot.label)}" placeholder="Assistant name..." />
              </div>

              <div class="full">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  <i data-lucide="table" class="w-3 h-3 inline mr-1"></i>AI Service
                </label>
                <div class="flex items-center gap-2 text-[11px] font-medium">
                  ${PROXY.ready
                    ? (PROXY.hasKey
                        ? `<span style="color:#0F7A3F"><i data-lucide="check-circle-2" class="w-3 h-3 inline mr-1"></i>Connected</span>`
                        : `<span style="color:#b45309"><i data-lucide="alert-triangle" class="w-3 h-3 inline mr-1"></i>Reachable but no Anthropic key — add it to the Config tab</span>`)
                    : `<span style="color:#dc2626"><i data-lucide="x-circle" class="w-3 h-3 inline mr-1"></i>Not reachable${PROXY.error ? ' (' + escHtml(PROXY.error) + ')' : ''}</span>`}
                </div>
                <p class="text-[11px] text-slate-400 mt-1">
                  The service that decides when a checklist item has genuinely been covered. Built in — nothing to configure here.
                </p>
              </div>

              <div class="full">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  <i data-lucide="list-checks" class="w-3 h-3 inline mr-1"></i>Default Checklist (what new calls start from)
                </label>
                <textarea id="setting-default-checklist" rows="8" placeholder="Introductions&#10;Understand their current process&#10;Demo the product&#10;Discuss pricing&#10;Agree next steps">${escHtml(CHECKLIST.defaults.join('\n'))}</textarea>
                <p class="text-[11px] text-slate-400 mt-1">One item per line. Saved with &ldquo;Save Configuration&rdquo; and reused as the starting checklist. &ldquo;Use this list now&rdquo; replaces the current checklist with these items, all unchecked.</p>
                <button class="btn-outline" style="font-size:11px;padding:5px 12px;margin-top:8px" data-action="apply-default-checklist">
                  <i data-lucide="list-restart" class="w-3 h-3 inline mr-1"></i> Use this list now
                </button>
              </div>

              <div class="full" style="border-top:1px dashed #e2e8f0;padding-top:16px">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                  <i data-lucide="mic" class="w-3 h-3 inline mr-1"></i>Voice${VOICE.srSupported ? '' : ' — needs Chrome or Edge'}
                </label>

                ${VOICE.srSupported ? `
                  <div style="margin-bottom:16px">
                    <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Microphone</label>
                    <select id="setting-mic" style="width:100%;padding:10px 14px;border:2px solid #e2e8f0;border-radius:10px;font-size:14px">
                      <option value=""${MIC.deviceId ? '' : ' selected'}>System default microphone (recommended)</option>
                      ${MIC.devices
                        .filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
                        .map((d, i) => `<option value="${escAttr(d.deviceId)}"${MIC.deviceId === d.deviceId ? ' selected' : ''}>${escHtml(d.label || ('Microphone ' + (i + 1)))}</option>`)
                        .join('')}
                    </select>
                    <p class="text-[11px] text-slate-400 mt-1">The microphone opened while listening. If the default device isn&rsquo;t picking you up, switch here.</p>
                    <p class="text-[11px] text-slate-400 mt-1"><strong>Important:</strong> Chrome&rsquo;s live transcription always listens to your computer&rsquo;s <strong>default</strong> microphone &mdash; it can&rsquo;t be pointed at a specific device from here. To transcribe a particular mic, set it as your default input in <strong>${escHtml(osDefaultMicPath())}</strong>.</p>
                    ${MIC.deviceId ? `<div class="text-[11px] mt-2" style="color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px"><i data-lucide="alert-triangle" class="w-3 h-3 inline mr-1"></i>You&rsquo;ve pinned a specific microphone. It is captured for keep-alive, but live transcription still follows your OS default input &mdash; set the same device as default in <strong>${escHtml(osDefaultMicPath())}</strong> so what gets heard matches your choice.</div>` : ''}
                    <div class="flex flex-wrap items-center gap-2" style="margin-top:8px">
                      <button class="btn-outline" style="font-size:11px;padding:5px 12px" data-action="refresh-mics">
                        <i data-lucide="refresh-cw" class="w-3 h-3 inline mr-1"></i> Refresh device list
                      </button>
                      <button class="btn-outline" style="font-size:11px;padding:5px 12px" data-action="${MICTEST.active ? 'stop-mic-test' : 'test-mic'}">
                        <i data-lucide="${MICTEST.active ? 'square' : 'activity'}" class="w-3 h-3 inline mr-1"></i> ${MICTEST.active ? 'Stop test' : 'Test microphone'}
                      </button>
                    </div>
                    ${MICTEST.active ? `
                      <div style="margin-top:10px">
                        <div style="height:10px;background:#e2e8f0;border-radius:999px;overflow:hidden">
                          <div id="mic-test-bar" style="height:100%;width:0%;background:#cbd5e1;border-radius:999px;transition:width .05s linear"></div>
                        </div>
                        <p id="mic-test-status" class="text-[11px] mt-1" style="color:#64748b">Listening… speak now and watch the bar move.</p>
                      </div>
                    ` : ''}
                    ${osDefaultMicLabel() ? `<p class="text-[11px] text-slate-400 mt-2">Your computer&rsquo;s current default input &mdash; what Chrome actually transcribes &mdash; is <strong>${escHtml(osDefaultMicLabel())}</strong>.</p>` : ''}
                  </div>
                ` : ''}
              </div>

              <div class="full flex flex-wrap gap-2 pt-1">
                <button class="btn-primary" data-action="save-settings">
                  <i data-lucide="save" class="w-4 h-4 inline mr-1"></i> Save Configuration
                </button>
                <button class="btn-outline" data-action="reset-slot" data-idx="${es}">
                  <i data-lucide="rotate-ccw" class="w-4 h-4 inline mr-1"></i> Reset Defaults
                </button>
              </div>
            </div>
          </div>`;
      }

      /* ================================================================
       * EVENTS
       * ================================================================ */

      let _bound = false;
      function bindEvents() {
        if (_bound) return;
        _bound = true;

        // The microphone picker in Settings. Changing it re-opens the held
        // capture on the chosen device right away (no need to toggle listening
        // off and on). The screen-share picker is NOT re-triggered — only the
        // mic stream is swapped — so two-way users aren't re-prompted.
        document.addEventListener('change', e => {
          const el = e.target;
          if (!el || el.id !== 'setting-mic') return;
          MIC.deviceId = el.value || '';
          saveSettings();
          if (STATE.slots[0].listenOn) {
            const twoWay = STATE.slots[0].audioMode === 'two-way';
            if (VOICE.micStream) {
              try { VOICE.micStream.getTracks().forEach(t => t.stop()); } catch {}
              VOICE.micStream = null;
            }
            acquireMicStream(twoWay).then((status) => {
              if (status === 'ok') restartRecognition();
            });
          }
          showToast(MIC.deviceId ? 'Microphone switched' : 'Using the system default microphone');
          render();
        });

        document.addEventListener('click', e => {
          const act = e.target.closest('[data-action]');
          // Cancel the inline delete-confirm when clicking elsewhere.
          if (STATE.historyConfirmDeleteId) {
            const insidePanel = !!e.target.closest('.history-panel-open');
            const insidePopout = !!HISTORY_VIEW.open && !!e.target.closest('.history-popout');
            const protect = act && /^(confirm-delete-history|cancel-delete-history|confirm-delete-history-yes|confirm-delete-history-popout|copy-answer|noop)$/.test(act.dataset.action);
            if ((!insidePanel && !insidePopout) || (act && !protect)) {
              STATE.historyConfirmDeleteId = null;
              if (!act) { render(); return; }
            }
          }
          if (!act) return;
          const action = act.dataset.action;
          const idx = act.dataset.idx !== undefined ? parseInt(act.dataset.idx) : null;

          switch (action) {
            case 'save-onboarding': {
              const fn = document.getElementById('onb-first');
              const ln = document.getElementById('onb-last');
              const first = fn ? fn.value : '';
              const last  = ln ? ln.value : '';
              const errEl = document.getElementById('onb-error');
              if (!first.trim() || !last.trim()) {
                if (errEl) errEl.textContent = 'Please enter both your first and last name.';
                if (!first.trim() && fn) fn.focus(); else if (ln) ln.focus();
                break;
              }
              if (act.dataset.busy === '1') break;   // guard against double-submit
              act.dataset.busy = '1';
              saveUserName(first, last).then(ok => {
                if (!ok) {
                  act.dataset.busy = '';
                  if (errEl) errEl.textContent = 'Please enter both your first and last name.';
                  return;
                }
                render();         // gate now passes → the normal tool renders
                startMainApp();   // run the boot side-effects deferred during onboarding
              });
              break;
            }
            case 'switch-tab': {
              const enteringSettings = STATE.activeTab !== 'settings' && act.dataset.tab === 'settings';
              const leavingSettings = STATE.activeTab === 'settings' && act.dataset.tab !== 'settings';
              // Leaving Settings ends any running mic test (the meter loop also
              // self-terminates, but stop it up front so the capture closes the
              // instant the user navigates).
              if (act.dataset.tab !== 'settings' && MICTEST.active) stopMicTest();
              // Pause listening while Settings is open so its constant
              // re-renders can't glitch the sheet; resume on the way out.
              if (enteringSettings) pauseListenForSettings();
              STATE.activeTab = act.dataset.tab;
              render();
              // Opening Settings is a good moment to refresh the mic list so
              // the picker shows current devices (labels appear once granted).
              if (act.dataset.tab === 'settings') { try { refreshMicDevices(); } catch {} }
              if (leavingSettings) resumeListenAfterSettings();
              break;
            }
            case 'close-settings-bg': {
              if (!e.target.hasAttribute('data-action')) break;
              if (MICTEST.active) stopMicTest();
              STATE.activeTab = 'home';
              render();
              // Resume the listening paused when Settings opened.
              resumeListenAfterSettings();
              break;
            }
            case 'toggle-history': {
              STATE.historyOpen = !STATE.historyOpen;
              if (!STATE.historyOpen) STATE.historyQuery = ''; // a hidden filter would silently hide entries next time
              render();
              break;
            }
            case 'clear-history-search': {
              STATE.historyQuery = '';
              render();
              const si = document.getElementById('history-search');
              if (si) si.focus();
              break;
            }
            case 'toggle-listen': toggleListening(); break;
            case 'pick-audio-mode': {
              const m = act.dataset.mode === 'two-way' ? 'two-way' : 'one-way';
              const s = STATE.slots[0];
              if (s.audioMode === m && (m === 'one-way' || DESKTOP.on)) { break; }
              s.audioMode = m;
              saveSettings();
              // Listening is only paused because Settings is open — don't spin
              // up a live capture inside the sheet (that's the glitch we're
              // avoiding). Just record the new mode so we resume in it when
              // Settings closes.
              if (STATE.settingsResumeListen) { STATE.settingsResumeListen = m; render(); break; }
              // Apply immediately. Two-way's screen-share picker rides this
              // click's user activation. Restart so the mic's echo-cancellation
              // matches the mode (off for two-way, on for one-way).
              if (s.listenOn) { stopListening({ silent: true }); }
              startListening(m);
              render();
              break;
            }
            case 'share-computer-audio': {
              const s = STATE.slots[0];
              s.audioMode = 'two-way';
              saveSettings();
              if (s.listenOn) { stopListening({ silent: true }); }
              startListening('two-way');
              render();
              break;
            }
            case 'refresh-mics': {
              // Labels stay blank until mic permission has been granted once;
              // a throwaway capture unlocks them, then we re-enumerate.
              (async () => {
                try {
                  if (!MIC.devices.some(d => d.label) && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
                    s.getTracks().forEach(t => t.stop());
                  }
                } catch {}
                refreshMicDevices();
              })();
              break;
            }
            case 'test-mic': { startMicTest(); break; }
            case 'stop-mic-test': { stopMicTest(); break; }
            case 'set-audio-mode': {
              const m = act.dataset.mode === 'one-way' ? 'one-way' : 'two-way';
              STATE.slots[0].audioMode = m;
              render();
              // Keep keyboard focus on the slider, and announce the new choice.
              focusAfterRender('.ac-seg-opt[data-mode="' + m + '"]');
              const info = audioModeInfo(m);
              announceLive(info.label + '. ' + info.sub + '. ' + info.line);
              break;
            }
            case 'confirm-audio-mode': {
              STATE.audioChooserOpen = false;
              const m = STATE.slots[0].audioMode === 'one-way' ? 'one-way' : 'two-way';
              // Start capture synchronously inside this click so the mic /
              // screen-share prompts keep the user activation they require,
              // then re-render to dismiss the chooser.
              startListening(m);
              render();
              break;
            }
            case 'close-audio-chooser':
            case 'close-audio-chooser-bg': {
              // Background only closes on a direct click: a click on the
              // modal's own content has no data-action.
              if (action === 'close-audio-chooser-bg' && !e.target.hasAttribute('data-action')) break;
              closeAudioChooser();
              break;
            }

            /* ---- checklist actions ---- */
            case 'add-check-item': {
              const inp = document.getElementById('ck-new-input');
              const text = (inp ? inp.value : STATE.newItemText).trim();
              if (!text) break;
              addChecklistItem(text);
              STATE.newItemText = '';
              render();
              focusAfterRender('#ck-new-input');
              break;
            }
            case 'toggle-check-item': toggleChecklistItem(act.dataset.id); break;
            case 'edit-check-item': {
              const it = CHECKLIST.items.find(x => x.id === act.dataset.id);
              if (!it) break;
              STATE.editingItemId = it.id;
              STATE.editItemText = it.text;
              render();
              focusAfterRender('#ck-edit-input');
              break;
            }
            case 'save-edit-item': {
              const inp = document.getElementById('ck-edit-input');
              const text = (inp ? inp.value : STATE.editItemText).trim();
              if (text) updateChecklistItemText(act.dataset.id, text);
              STATE.editingItemId = null;
              STATE.editItemText = '';
              render();
              break;
            }
            case 'cancel-edit-item': {
              STATE.editingItemId = null;
              STATE.editItemText = '';
              render();
              break;
            }
            case 'delete-check-item': {
              if (STATE.editingItemId === act.dataset.id) { STATE.editingItemId = null; STATE.editItemText = ''; }
              removeChecklistItem(act.dataset.id);
              break;
            }
            case 'move-check-item': moveChecklistItem(act.dataset.id, parseInt(act.dataset.dir, 10) || 0); break;
            case 'reset-checklist': resetChecklist(); break;
            case 'apply-default-checklist': {
              // Capture any unsaved edits in the default-list textarea first,
              // then swap the current checklist for the default (all unchecked).
              readFields();
              saveSettings();
              applyDefaultChecklist();
              showToast('Checklist replaced with your saved default');
              render();
              break;
            }

            case 'save-settings': {
              readFields();
              saveSettings();
              showToast('Settings saved');
              render();
              break;
            }
            case 'view-history': {
              HISTORY_VIEW.open = act.dataset.id;
              STATE.historyConfirmDeleteId = null;
              STATE.activeTab = 'home';
              STATE.historyOpen = false;
              render();
              break;
            }
            case 'close-history':
            case 'close-history-bg': {
              if (act.dataset.action === 'close-history-bg' && !e.target.hasAttribute('data-action')) break;
              HISTORY_VIEW.open = null;
              render();
              break;
            }
            case 'confirm-delete-history': {
              STATE.historyConfirmDeleteId = act.dataset.id;
              render();
              break;
            }
            case 'cancel-delete-history': {
              STATE.historyConfirmDeleteId = null;
              render();
              break;
            }
            case 'confirm-delete-history-yes': {
              deleteHistoryEntry(act.dataset.id);
              STATE.historyConfirmDeleteId = null;
              render();
              break;
            }
            case 'confirm-delete-history-popout': {
              deleteHistoryEntry(act.dataset.id);
              STATE.historyConfirmDeleteId = null;
              HISTORY_VIEW.open = null;
              render();
              showToast('Conversation deleted');
              break;
            }
            case 'copy-answer': {
              const h = STATE.sessionHistory.find(x => x.id === act.dataset.id);
              const pi = parseInt(act.dataset.pair, 10);
              if (!h || !h.pairs[pi]) break;
              copyTextToClipboard(h.pairs[pi].answer || '', act);
              break;
            }
            case 'noop': break;
            case 'reset-slot': {
              const s = STATE.slots[idx !== null ? idx : 0];
              s.label = 'Sales Assistant';
              saveSettings(); render(); break;
            }
          }
        });

        // Keep STATE in sync with the checklist inputs so background renders
        // (toasts, live status) never wipe a draft; patch the add button's
        // disabled state live (a re-render per keystroke would steal focus).
        document.addEventListener('input', e => {
          if (e.target.id === 'ck-new-input') {
            STATE.newItemText = e.target.value;
            const btn = document.querySelector('[data-action="add-check-item"]');
            if (btn) {
              const dis = !e.target.value.trim();
              if (btn.disabled !== dis) btn.disabled = dis;
            }
          } else if (e.target.id === 'ck-edit-input') {
            STATE.editItemText = e.target.value;
          } else if (e.target.id === 'history-search') {
            // Filter as you type. render() rebuilds the DOM, so put the
            // focus and caret back where they were.
            STATE.historyQuery = e.target.value;
            const caret = e.target.selectionStart;
            render();
            const si = document.getElementById('history-search');
            if (si) { si.focus(); try { si.setSelectionRange(caret, caret); } catch {} }
          }
        });

        document.addEventListener('keydown', e => {
          // Enter in either onboarding field submits the one-time name screen.
          if (e.key === 'Enter' && (e.target.id === 'onb-first' || e.target.id === 'onb-last')) {
            e.preventDefault();
            document.querySelector('[data-action="save-onboarding"]')?.click();
            return;
          }
          // Enter in the add box adds the item; Enter in the editor saves it.
          if (e.key === 'Enter' && e.target.id === 'ck-new-input') {
            e.preventDefault();
            STATE.newItemText = e.target.value;
            document.querySelector('[data-action="add-check-item"]')?.click();
            return;
          }
          if (e.key === 'Enter' && e.target.id === 'ck-edit-input') {
            e.preventDefault();
            STATE.editItemText = e.target.value;
            document.querySelector('[data-action="save-edit-item"]')?.click();
            return;
          }
          if (e.key === 'Escape' && STATE.editingItemId) {
            STATE.editingItemId = null;
            STATE.editItemText = '';
            render();
            return;
          }
          // Space/Enter activate the toggle switches (they're divs with role=switch).
          if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('role') === 'switch') {
            e.preventDefault();
            e.target.click();
            return;
          }
          // ...and the div-based buttons (checklist rows, saved-conversation items).
          if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute &&
              e.target.getAttribute('role') === 'button' && e.target.dataset && e.target.dataset.action) {
            e.preventDefault();
            e.target.click();
            return;
          }
          if (e.key === 'Escape' && STATE.audioChooserOpen) {
            closeAudioChooser();
            return;
          }
          if (e.key === 'Escape' && e.target.id === 'history-search') {
            STATE.historyQuery = '';
            render();
            return;
          }
          if (e.key === 'Escape' && HISTORY_VIEW.open) {
            HISTORY_VIEW.open = null; render();
          }
        });
      }

      function readFields() {
        const i = STATE.editingSlot;
        const s = STATE.slots[i];
        const l = document.getElementById('setting-label');
        const dc = document.getElementById('setting-default-checklist');
        if (l) s.label = l.value.trim() || s.label;
        if (dc) {
          CHECKLIST.defaults = dc.value.split('\n').map(x => x.trim()).filter(Boolean);
          saveDefaultChecklist();
        }
      }

      /* ================================================================
       * BOOT
       * ================================================================ */

      // The normal-tool boot side-effects. Deferred until onboarding is complete
      // so the mic and the first API call never fire behind the name screen.
      // Runs exactly once per panel open.
      let _mainStarted = false;
      function startMainApp() {
        if (_mainStarted) return;
        _mainStarted = true;
        loadRemoteConfig().then(render);
        // Auto-launch the mic on open. One-way (mic only) needs no screen-share
        // prompt, so listening starts the moment the panel opens — the user
        // never picks a mic. Two-way / computer-audio capture stays opt-in from
        // Settings (its share picker needs a click). autoStartListening() retries
        // through the transient capture failures that can happen right as the
        // panel appears, so listening reliably comes up on every open.
        if (VOICE.srSupported) {
          setTimeout(() => { try { autoStartListening(); } catch {} }, 250);
        }
      }

      function boot() {
        // Load the persisted checklist (and the saved default list) right
        // away — the panel renders it as soon as chrome.storage answers.
        loadChecklist().then(() => render());
        // Fast path: a synchronous localStorage hint says this install already
        // finished onboarding, so render the normal tool and start listening
        // IMMEDIATELY — identical to the original boot, with no wait on the async
        // chrome.storage read. (That wait was the reload glitch: a flashed frame
        // and a delayed mic auto-start every time.)
        if (readOnboardedHint()) {
          render();
          startMainApp();
        } else {
          render(); // blank panel until identity resolves, then onboarding/tool
        }
        // Always load the real id + name (the source of truth). On the fast path
        // the id lands in the background, well before any API call; on a first
        // run this decides whether we show onboarding or the tool. If the hint
        // was stale (id/name actually gone), this corrects the view. startMainApp
        // is guarded so it never runs twice.
        ensureIdentity().then(() => {
          render();
          if (onboardingComplete()) startMainApp();
        });
      }

      // Run boot once the DOM is ready. The script is the last element in the
      // body, so DOMContentLoaded normally hasn't fired yet — but if this ever
      // executes after the DOM is already parsed, addEventListener would never
      // fire and the panel would never come up. Guard on readyState so boot always
      // runs exactly once, on every open.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
