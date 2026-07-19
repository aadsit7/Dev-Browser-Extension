// AI Projects Assistant — component logic.
// Extracted verbatim from the original <script type="text/x-dc"> block and
// wrapped in a real function so it runs without eval/new Function, which
// Manifest V3's content-security-policy forbids. dc-runtime's evalDcLogic
// has been patched to call this factory instead of compiling the source.
window.__dcComponentFactory = function (DCLogic, StreamableLogic, React) {

class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.PER_PAGE = 16;
    this.STALL_MS = 5000;          // recognition is considered stalled after this many ms with no events
    this._opened = [];             // window references we opened by voice/tap (for "close tabs")
    this.LS_B = 'bookmarksBuddy.sidepanel.bookmarks.v1';
    this.LS_L = 'bookmarksBuddy.sidepanel.layout.v1';
    this.LS_S = 'bookmarksBuddy.sidepanel.settings.v1';
    this.LS_USE = 'bookmarksBuddy.sidepanel.usage.v1';   // local-only open counts (voice-match tie-breaker)
    this.STARTERS = [
      { name: 'ChatGPT', url: 'chatgpt.com' }, { name: 'Claude', url: 'claude.ai' },
      { name: 'Gemini', url: 'gemini.google.com' }, { name: 'Perplexity', url: 'perplexity.ai' },
      { name: 'Copilot', url: 'copilot.microsoft.com' }, { name: 'NotebookLM', url: 'notebooklm.google.com' },
      { name: 'Midjourney', url: 'midjourney.com' }, { name: 'Hugging Face', url: 'huggingface.co' },
      { name: 'Cursor', url: 'cursor.com' }, { name: 'v0', url: 'v0.dev' },
      { name: 'ElevenLabs', url: 'elevenlabs.io' }, { name: 'Suno', url: 'suno.com' }
    ];
    this.state = {
      bookmarks: [], pages: [], pageNames: [], currentPage: 0,
      view: 'grid',                  // springboard style: 'grid' (tiles) or 'list' (A→Z App Library)
      search: '', adding: false, settingsOpen: false, pagesOpen: false, folderOpen: null, folderEdit: false,
      editMode: false, voiceOpen: false, listening: false, interim: '', heard: '',
      draftName: '', draftUrl: '', draftIcon: '', draftDesc: '', dark: false, speak: false,
      editing: null, editName: '', editUrl: '', editIcon: '', editNotes: '', editDesc: '', editConfirmDelete: false,
      detail: null, detailDesc: '', detailNotes: '',
      choosing: null, choiceQuery: '',
      toast: '', toastIcon: '', srSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition)
    };
    this.loadData();
    this._attached = false;
    this._toastT = null;
  }

  /* ---------- persistence ---------- */
  loadData() {
    let bms = null, layout = null, settings = null;
    try { const v = JSON.parse(localStorage.getItem(this.LS_B) || 'null'); if (Array.isArray(v)) bms = v; } catch {}
    if (!bms) {
      try { const v = JSON.parse(localStorage.getItem('bookmarksBuddy.bookmarks.v1') || 'null'); if (Array.isArray(v) && v.length) bms = v; } catch {}
    }
    if (!bms || !bms.length) bms = this.STARTERS.map((s, i) => ({ id: 'b' + i, name: s.name, url: s.url }));
    // A project needs a name OR a link to be renderable — the URL alone is optional now.
    bms = bms.filter(x => x && (x.url || x.name)).map(x => ({ id: x.id || this.uid(), name: x.name || '', url: x.url || '', notes: x.notes || '', icon: x.icon || '', description: x.description || '' }));
    this.state.bookmarks = bms;

    try { layout = JSON.parse(localStorage.getItem(this.LS_L) || 'null'); } catch {}
    if (!layout) layout = this.deriveExternalLayout(bms);
    this.applyLayout(layout, bms);

    try { settings = JSON.parse(localStorage.getItem(this.LS_S) || 'null'); } catch {}
    if (settings && typeof settings === 'object') {
      this.state.dark = !!settings.dark; this.state.speak = !!settings.speak;
      if (settings.view === 'list' || settings.view === 'grid') this.state.view = settings.view;
    }
  }
  // Try to honor the user's existing springboard organization from the live app.
  deriveExternalLayout(bms) {
    try {
      const l = JSON.parse(localStorage.getItem('bookmarksBuddy.layout.v1') || 'null');
      if (!l || !Array.isArray(l.pages)) return null;
      const ids = new Set(bms.map(b => b.id));
      const pages = l.pages.map(pg => (pg || []).map(c => {
        if (!c) return null;
        if (c.type === 'folder') {
          const items = (c.items || []).map(it => it && it.id).filter(id => ids.has(id));
          return items.length ? { type: 'folder', name: c.name || 'Folder', items } : null;
        }
        return ids.has(c.id) ? { type: 'app', id: c.id } : null;
      }).filter(Boolean)).filter(pg => pg.length);
      if (!pages.length) return null;
      return { pages, pageNames: Array.isArray(l.pageNames) ? l.pageNames : [] };
    } catch { return null; }
  }
  applyLayout(layout, bms) {
    const placed = new Set();
    let pages = [];
    if (layout && Array.isArray(layout.pages)) {
      pages = layout.pages.map(pg => pg.map(c => {
        if (c.type === 'folder') { c.items.forEach(id => placed.add(id)); return { type: 'folder', name: c.name, items: c.items.slice() }; }
        placed.add(c.id); return { type: 'app', id: c.id };
      }));
      this.state.pageNames = (layout.pageNames || []).slice();
    }
    // paginate any unplaced bookmarks
    const rest = bms.filter(b => !placed.has(b.id));
    if (!pages.length) {
      for (let i = 0; i < rest.length; i += this.PER_PAGE) pages.push(rest.slice(i, i + this.PER_PAGE).map(b => ({ type: 'app', id: b.id })));
    } else if (rest.length) {
      const last = pages[pages.length - 1];
      rest.forEach(b => { if (last.length < this.PER_PAGE) last.push({ type: 'app', id: b.id }); else pages.push([{ type: 'app', id: b.id }]); });
    }
    if (!pages.length) pages = [[]];
    this.state.pages = pages;
  }
  save() {
    try { localStorage.setItem(this.LS_B, JSON.stringify(this.state.bookmarks)); } catch {}
    try { localStorage.setItem(this.LS_L, JSON.stringify({ pages: this.state.pages, pageNames: this.state.pageNames })); } catch {}
    // Mirror every change up to the Google Sheet (no-op until the first pull
    // has baselined us, and a no-op when no token is configured).
    try { this.sheetSync(); } catch {}
  }
  saveSettings() { try { localStorage.setItem(this.LS_S, JSON.stringify({ dark: this.state.dark, speak: this.state.speak, view: this.state.view })); } catch {} }

  /* ================================================================
   * Google Sheet backend — ported from the web app (index_26) so the
   * extension loads the same bookmarks/apps from your Google Sheet,
   * keeps the springboard arrangement (pages, folders, order) in the
   * sheet's Folder/Page/Position columns, and writes changes back.
   * localStorage stays on as an instant, offline mirror. With no token
   * the whole layer is dormant and the app is localStorage-only.
   * ================================================================ */
  sheetBoot() {
    if (this._sheet) return;
    const C = {
      url: 'https://script.google.com/macros/s/AKfycbwL1eUGzD57DTFp45bE6FCBLbP4r57ivR4Q39e_zOYaiX0_bjxCEO6TEV1ONfXLBhX3sg/exec',
      // The new backend needs no token by default (set APP_TOKEN in the Apps
      // Script's Script Properties to require one; then bbSetToken('...') here).
      embedded: '',
      LS_TOKEN: 'bookmarksBuddy.sidepanel.appToken',
      LS_OUTBOX: 'bookmarksBuddy.sidepanel.outbox.v1',
      LS_SYNCED: 'bookmarksBuddy.sidepanel.synced.v1'
    };
    this._sheet = Object.assign({}, C, {
      token: this.sheetResolveToken(C),
      online: true, snapshot: Object.create(null), flushing: false, ready: false, seq: Date.now(),
      // Durable record of the user's own changes that the sheet has not yet
      // confirmed via a pull. Unlike the outbox (which is emptied the instant a
      // write flushes), this survives the flush, so a pull that was already in
      // flight when the write landed can't quietly drop the change from the UI.
      // Cleared per-id only once a pull actually reflects it.
      inflight: Object.create(null)
    });
    // Baseline the snapshot from whatever is already in local state BEFORE the
    // first pull lands. This lets sheetSync() queue a user's own add/edit/delete
    // immediately (diffed against this baseline) without re-queuing the whole
    // existing list, so no change is ever gated behind the initial pull.
    this.sheetBaselineFromLocal();
    // Console helper, same name/behaviour as the web app.
    try {
      window.bbSetToken = (t) => {
        this._sheet.token = String(t || '').trim();
        try { if (this._sheet.token) localStorage.setItem(C.LS_TOKEN, this._sheet.token); else localStorage.removeItem(C.LS_TOKEN); } catch {}
        if (this.sheetEnabled()) this.syncFromSheet();
        return this._sheet.token ? 'app_token set — syncing with your sheet' : 'app_token cleared';
      };
    } catch {}
    // Re-flush the outbox whenever connectivity or attention returns, so writes
    // that failed while offline/hidden get resent without waiting for a reload.
    this.sheetAttachConnectivity();
    if (this.sheetEnabled()) this.syncFromSheet();
  }
  // Snapshot the current local bookmarks as the "last-known sheet state" so the
  // diff in sheetSync() only ever surfaces genuine user changes.
  sheetBaselineFromLocal() {
    const pl = this.sheetPlacements();
    this._sheet.snapshot = Object.create(null);
    for (const bm of this.state.bookmarks) this._sheet.snapshot[bm.id] = JSON.stringify(this.sheetRow(bm, pl[bm.id]));
  }
  sheetAttachConnectivity() {
    if (this._sheetConnAttached) return; this._sheetConnAttached = true;
    const tryFlush = () => { if (this.sheetEnabled()) { this._sheet.online = true; this.sheetFlush(); } };
    this._sheetOnlineH = () => tryFlush();
    this._sheetVisH = () => { if (!document.hidden) tryFlush(); };
    this._sheetFocusH = () => tryFlush();
    try {
      window.addEventListener('online', this._sheetOnlineH);
      document.addEventListener('visibilitychange', this._sheetVisH);
      window.addEventListener('focus', this._sheetFocusH);
    } catch {}
  }
  sheetDetachConnectivity() {
    if (!this._sheetConnAttached) return; this._sheetConnAttached = false;
    try {
      if (this._sheetOnlineH) window.removeEventListener('online', this._sheetOnlineH);
      if (this._sheetVisH) document.removeEventListener('visibilitychange', this._sheetVisH);
      if (this._sheetFocusH) window.removeEventListener('focus', this._sheetFocusH);
    } catch {}
  }
  sheetResolveToken(C) {
    try {
      const here = new URL(location.href);
      const q = here.searchParams.get('token') || new URLSearchParams((location.hash || '').replace(/^#/, '')).get('token');
      if (q) { try { localStorage.setItem(C.LS_TOKEN, q); } catch {} return q; }
    } catch {}
    try { const saved = localStorage.getItem(C.LS_TOKEN); if (saved) return saved; } catch {}
    return C.embedded;
  }
  // A token is optional: the sync layer runs whenever a web-app URL is set.
  sheetEnabled() { return !!(this._sheet && this._sheet.url); }
  async sheetPost(payload) {
    // text/plain keeps it a "simple" request (no CORS preflight Apps Script can't answer).
    const res = await fetch(this._sheet.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: this._sheet.token }, payload))
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let data = {}; try { data = await res.json(); } catch {}
    if (data && data.ok === false) throw new Error(data.error || 'sheet rejected the write');
    return data;
  }
  sheetDelay(ms) { return new Promise(r => setTimeout(r, ms)); }
  // Retry a failed POST a few times with short backoff before giving up for now
  // (the item stays in the persistent outbox and is retried later regardless).
  async sheetPostWithRetry(payload, tries) {
    tries = tries || 3; let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await this.sheetPost(payload); }
      catch (e) { lastErr = e; if (i < tries - 1) await this.sheetDelay(400 * Math.pow(2, i)); }
    }
    throw lastErr;
  }
  async sheetGet() {
    const u = new URL(this._sheet.url);
    u.searchParams.set('action', 'getBookmarks');
    u.searchParams.set('token', this._sheet.token);
    const res = await fetch(u.toString(), { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.ok || !Array.isArray(data.bookmarks)) throw new Error('unexpected getBookmarks response');
    return data.bookmarks;
  }
  /* offline write queue */
  sheetLoadOutbox() { try { const o = JSON.parse(localStorage.getItem(this._sheet.LS_OUTBOX) || '[]'); return Array.isArray(o) ? o : []; } catch { return []; } }
  sheetSaveOutbox(q) { try { localStorage.setItem(this._sheet.LS_OUTBOX, JSON.stringify(q)); } catch {} }
  sheetEnqueue(item) {
    const q = this.sheetLoadOutbox();
    if (item.action === 'saveBookmark' || item.action === 'deleteBookmark') {
      const id = item.action === 'saveBookmark' ? item.bookmark['Bookmark ID'] : item.id;
      for (let i = q.length - 1; i >= 0; i--) {
        const it = q[i];
        const itId = it.action === 'saveBookmark' ? (it.bookmark && it.bookmark['Bookmark ID']) : it.action === 'deleteBookmark' ? it.id : undefined;
        if (itId !== undefined && itId === id) q.splice(i, 1);
      }
    }
    item.seq = ++this._sheet.seq; q.push(item); this.sheetSaveOutbox(q);
    // Remember this change as in-flight until a pull confirms it (see sheetBoot).
    if (this._sheet.inflight) {
      if (item.action === 'saveBookmark') { const id = item.bookmark['Bookmark ID']; const bm = this.state.bookmarks.find(b => b.id === id); this._sheet.inflight[id] = { action: 'save', bm: bm ? Object.assign({}, bm) : null }; }
      else if (item.action === 'deleteBookmark') { this._sheet.inflight[item.id] = { action: 'delete' }; }
    }
    if (this._sheet.online) this.sheetFlush();
  }
  async sheetFlush() {
    if (this._sheet.flushing || !this.sheetEnabled()) return;
    this._sheet.flushing = true;
    try {
      while (true) {
        const q = this.sheetLoadOutbox();
        if (!q.length) { this._sheet.online = true; break; }
        const item = q[0];
        const itemId = item.action === 'saveBookmark' ? (item.bookmark && item.bookmark['Bookmark ID']) : item.id;
        try { const { seq, ...body } = item; await this.sheetPostWithRetry(body); }
        catch { this._sheet.online = false; this.sheetNotify(itemId, false); break; }
        this._sheet.online = true;
        this.sheetSaveOutbox(this.sheetLoadOutbox().filter(x => x.seq !== item.seq));
        this.sheetNotify(itemId, true);
      }
    } finally { this._sheet.flushing = false; }
  }
  // The ids of changes still pending in the outbox right now.
  sheetPendingIds() {
    const q = this.sheetLoadOutbox();
    const saves = new Set(), deletes = new Set();
    for (const it of q) {
      if (it.action === 'saveBookmark' && it.bookmark) saves.add(it.bookmark['Bookmark ID']);
      else if (it.action === 'deleteBookmark') deletes.add(it.id);
    }
    return { saves, deletes };
  }
  // Honest save feedback: resolve a queued user change to a real success/failure
  // toast once the sheet actually confirms (or refuses to accept) the write.
  sheetNotify(id, ok) {
    const n = this._pendingNote;
    if (!n || n.id !== id) return;
    if (ok) { this.toastReplace(n.successMsg, n.successIcon); this._pendingNote = null; }
    else { this.toastReplace('Couldn’t reach the sheet — will retry', 'cloud-off'); }
  }
  // Tell the user a change was made. When the sheet is active we only *queued*
  // the write, so we show a "Saving…" state and let sheetNotify() upgrade it to
  // success (or a retry notice) when the write is actually confirmed. With no
  // sheet configured (localStorage-only) we show the plain success toast as before.
  sheetAnnounce(id, msg, icon) {
    if (this.sheetEnabled()) { this._pendingNote = { id, successMsg: msg, successIcon: icon }; this.toast('Saving…', 'refresh-cw'); }
    else this.toast(msg, icon);
  }
  // Force the toast to remount before showing a new message. lucide rewrites the
  // toast's <i> into an <svg> outside React's control, so swapping data-lucide on
  // a still-mounted toast would leave a stale icon; clearing first avoids that.
  toastReplace(msg, icon) {
    if (this._toastT) clearTimeout(this._toastT);
    this.setState({ toast: '' });
    setTimeout(() => this.toast(msg, icon), 40);
  }
  /* springboard arrangement <-> sheet columns (same encoding as the web app) */
  sheetPlacements() {
    const map = Object.create(null); const placed = new Set();
    const pages = this.state.pages || [], names = this.state.pageNames || [];
    for (let p = 0; p < pages.length; p++) {
      const nm = names[p] && String(names[p]).trim();
      const pageField = nm ? ((p + 1) + '|' + nm) : String(p + 1);
      const page = pages[p] || [];
      for (let s = 0; s < page.length; s++) {
        const it = page[s]; if (!it) continue;
        if (it.type === 'app') { map[it.id] = { folder: '', page: pageField, position: s }; placed.add(it.id); }
        else if (it.type === 'folder') { for (let k = 0; k < it.items.length; k++) { const id = it.items[k]; map[id] = { folder: it.name || 'Folder', page: pageField, position: 'F' + s + ':' + k }; placed.add(id); } }
      }
    }
    for (const b of this.state.bookmarks) if (!placed.has(b.id)) map[b.id] = { folder: '', page: '', position: '' };
    return map;
  }
  sheetRow(bm, pl) {
    pl = pl || { folder: '', page: '', position: '' };
    if (!bm._dateAdded) bm._dateAdded = new Date().toISOString();
    const cell = v => (v == null || v === '' ? '' : String(v));
    return {
      'Bookmark ID': bm.id, 'Name': bm.name || '', 'URL': bm.url || '',
      'Folder': pl.folder != null ? pl.folder : '', 'Page': cell(pl.page), 'Position': cell(pl.position),
      'Owner (Profile ID)': bm._owner != null ? bm._owner : '',
      'Date Added': bm._dateAdded, 'Last Opened': bm._lastOpened != null ? bm._lastOpened : '', 'Times Opened': bm._timesOpened != null ? bm._timesOpened : '',
      'Notes': bm.notes != null ? bm.notes : '',
      'Icon': String(bm.icon || '').trim(),
      'Description': bm.description != null ? bm.description : ''
    };
  }
  // Diff the current list against the last-known sheet state; queue only changes.
  sheetSync() {
    // No _sheet.ready gate here: a user's own add/edit/delete must reach the
    // outbox even before (or if) the initial pull lands. The snapshot baseline
    // (set at boot in sheetBaselineFromLocal and re-set after every pull) is the
    // tool that prevents echoing the sheet's own rows back — not this gate.
    if (!this.sheetEnabled()) return;
    const pl = this.sheetPlacements(); const seen = new Set();
    for (const bm of this.state.bookmarks) {
      seen.add(bm.id);
      const json = JSON.stringify(this.sheetRow(bm, pl[bm.id]));
      if (this._sheet.snapshot[bm.id] !== json) { this._sheet.snapshot[bm.id] = json; this.sheetEnqueue({ action: 'saveBookmark', bookmark: JSON.parse(json) }); }
    }
    for (const id of Object.keys(this._sheet.snapshot)) if (!seen.has(id)) { delete this._sheet.snapshot[id]; this.sheetEnqueue({ action: 'deleteBookmark', id }); }
  }
  // Decode the sheet rows' Folder/Page/Position into a springboard layout.
  sheetBuildLayout(items) {
    const pagesMap = []; const names = [];
    for (const b of items) {
      const ps = String(b.page == null ? '' : b.page);
      const pm = ps.match(/^\s*(\d+)\s*(?:\|([\s\S]*))?$/);
      const p = pm ? parseInt(pm[1], 10) : parseInt(ps, 10);
      const pname = pm && pm[2] != null ? pm[2].trim() : '';
      if (Number.isInteger(p) && p >= 1 && pname && !names[p - 1]) names[p - 1] = pname;
      const pos = String(b.position == null ? '' : b.position).trim();
      if (!Number.isInteger(p) || p < 1 || pos === '') continue;
      const pi = p - 1; if (!pagesMap[pi]) pagesMap[pi] = Object.create(null);
      const fm = pos.match(/^F(\d+):(\d+)$/);
      if (fm) {
        const slot = parseInt(fm[1], 10), idx = parseInt(fm[2], 10);
        let c = pagesMap[pi][slot];
        if (!c || c.type !== 'folder') { c = { type: 'folder', name: String(b.folder || 'Folder'), items: Object.create(null) }; pagesMap[pi][slot] = c; }
        c.items[idx] = b.id;
      } else {
        const slot = parseInt(pos, 10); if (!Number.isInteger(slot)) continue;
        if (pagesMap[pi][slot]) continue;
        pagesMap[pi][slot] = { type: 'app', id: b.id };
      }
    }
    const pages = [], pageNames = [];
    const maxP = Math.max(pagesMap.length, names.length, 0);
    for (let pi = 0; pi < maxP; pi++) {
      const slotsObj = pagesMap[pi]; const cells = [];
      if (slotsObj) {
        const slots = Object.keys(slotsObj).map(Number).sort((a, b) => a - b);
        for (const s of slots) {
          const c = slotsObj[s];
          if (c.type === 'folder') { const ids = Object.keys(c.items).map(Number).sort((a, b) => a - b).map(k => c.items[k]); if (ids.length) cells.push({ type: 'folder', name: c.name, items: ids }); }
          else cells.push({ type: 'app', id: c.id });
        }
      }
      pages.push(cells); pageNames.push(names[pi] || '');
    }
    return { pages, pageNames };
  }
  async syncFromSheet() {
    if (!this.sheetEnabled()) return;
    let rows;
    try { rows = await this.sheetGet(); }
    catch (e) {
      this._sheet.online = false;
      console.warn('AI Projects Assistant: could not reach the sheet — using local data.', e);
      // The pull failed, but the session must NOT get stuck never queuing. Queuing
      // no longer depends on the pull (the gate is gone), so just keep the local
      // baseline and try to drain whatever is already queued; it will retry on the
      // next online/focus/visibility event or relaunch.
      this._sheet.ready = true;
      this.sheetFlush();
      return;
    }
    this._sheet.online = true;
    const str = v => (v == null ? '' : String(v));
    const remote = rows.map(r => ({
      id: str(r['Bookmark ID']).trim() || this.uid(),
      name: str(r['Name']).trim(),
      url: str(r['URL']).trim(),
      notes: r['Notes'] != null ? String(r['Notes']) : '',
      icon: r['Icon'] != null ? String(r['Icon']) : '',
      description: r['Description'] != null ? String(r['Description']) : '',
      folder: r['Folder'] != null ? r['Folder'] : '', page: r['Page'] != null ? r['Page'] : '', position: r['Position'] != null ? r['Position'] : '',
      _owner: r['Owner (Profile ID)'] != null ? r['Owner (Profile ID)'] : '',
      _dateAdded: r['Date Added'] != null ? String(r['Date Added']) : '',
      _lastOpened: r['Last Opened'] != null ? r['Last Opened'] : '',
      _timesOpened: r['Times Opened'] != null ? r['Times Opened'] : ''
    })).filter(b => b.name || b.url);
    // The sheet is authoritative for ordering/layout, but the pull must NOT drop a
    // user's change the sheet hasn't confirmed yet. Reconcile: drop bookmarks the
    // user deleted locally (delete unconfirmed), and re-apply locally-pending
    // adds/edits on top of the remote rows so a just-added bookmark survives this
    // pull — even if it already flushed and is gone from the outbox. The pending
    // set is the durable inflight map unioned with any leftover outbox items
    // (e.g. restored from a previous session); local copies come from the inflight
    // record or current state (still intact before we overwrite it below).
    const inflight = this._sheet.inflight || Object.create(null);
    const pend = { saves: new Set(), deletes: new Set(), localById: Object.create(null) };
    for (const id of Object.keys(inflight)) {
      const rec = inflight[id];
      if (rec.action === 'delete') pend.deletes.add(id);
      else { pend.saves.add(id); if (rec.bm) pend.localById[id] = rec.bm; }
    }
    const ob = this.sheetPendingIds();
    ob.saves.forEach(id => pend.saves.add(id));
    ob.deletes.forEach(id => pend.deletes.add(id));
    for (const bm of this.state.bookmarks) if (pend.saves.has(bm.id)) pend.localById[bm.id] = bm;
    let merged = remote
      .map(b => ({ id: b.id, name: b.name, url: b.url, notes: b.notes, icon: b.icon, description: b.description, _owner: b._owner, _dateAdded: b._dateAdded, _lastOpened: b._lastOpened, _timesOpened: b._timesOpened }))
      .filter(b => !pend.deletes.has(b.id));
    for (const id of pend.saves) {
      const local = pend.localById[id]; if (!local) continue;
      const keep = { id: local.id, name: local.name, url: local.url, notes: local.notes || '', icon: local.icon || '', description: local.description || '', _owner: local._owner, _dateAdded: local._dateAdded, _lastOpened: local._lastOpened, _timesOpened: local._timesOpened };
      const idx = merged.findIndex(b => b.id === id);
      if (idx >= 0) merged[idx] = keep; else merged.push(keep);
    }
    this.state.bookmarks = merged;
    // Build the layout from the remote rows, but strip any locally-deleted ids and
    // let applyLayout() auto-place locally-added bookmarks the sheet doesn't know yet.
    const layout = this.sheetBuildLayout(remote);
    if (pend.deletes.size) {
      layout.pages = layout.pages.map(pg => pg.map(c => {
        if (c.type === 'folder') { const items = c.items.filter(x => !pend.deletes.has(x)); return items.length ? { type: 'folder', name: c.name, items } : null; }
        return pend.deletes.has(c.id) ? null : c;
      }).filter(Boolean));
    }
    this.applyLayout(layout, this.state.bookmarks);
    // Retire inflight intents the sheet has now confirmed: a save that shows up in
    // this pull, or a delete whose row is now gone. Anything not yet reflected
    // stays inflight so the next pull keeps preserving it until it lands.
    const remoteIds = new Set(remote.map(b => b.id));
    for (const id of Object.keys(inflight)) {
      const rec = inflight[id];
      if (rec.action === 'save' && remoteIds.has(id)) delete inflight[id];
      else if (rec.action === 'delete' && !remoteIds.has(id)) delete inflight[id];
    }
    try { localStorage.setItem(this._sheet.LS_SYNCED, '1'); } catch {}
    try { localStorage.setItem(this.LS_B, JSON.stringify(this.state.bookmarks)); } catch {}
    try { localStorage.setItem(this.LS_L, JSON.stringify({ pages: this.state.pages, pageNames: this.state.pageNames })); } catch {}
    // Baseline the snapshot to what we just loaded so save() won't echo it back.
    const pl = this.sheetPlacements(); this._sheet.snapshot = Object.create(null);
    for (const bm of this.state.bookmarks) this._sheet.snapshot[bm.id] = JSON.stringify(this.sheetRow(bm, pl[bm.id]));
    this._sheet.ready = true;
    let cur = this.state.currentPage; if (cur >= this.state.pages.length) cur = Math.max(0, this.state.pages.length - 1);
    this.setState({ bookmarks: this.state.bookmarks, pages: this.state.pages, pageNames: this.state.pageNames, currentPage: cur });
    this.sheetFlush();
  }
  // Launch the microphone listener on open (as requested).
  autoStartMic() {
    if (this._autoMic) return; this._autoMic = true;
    setTimeout(() => { try { if (!this.state.listening) this.startListen(); } catch {} }, 350);
  }
  uid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------- url / matching helpers (ported) ---------- */
  ensureScheme(u) { u = String(u || '').trim(); if (!u) return ''; if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(mailto:|tel:)/i.test(u)) return u; return 'https://' + u.replace(/^\/+/, ''); }
  looksLikeUrl(u) { u = String(u || '').trim(); if (!u) return false; if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return true; return /^[^\s.]+\.[^\s.]{2,}/.test(u); }
  hostOf(u) { try { return new URL(this.ensureScheme(u)).hostname.replace(/^www\./, ''); } catch { return ''; } }
  hostCore(u) { const h = this.hostOf(u); if (!h) return ''; const p = h.split('.').filter(Boolean); if (p.length <= 1) return h; const t2 = p.slice(-2).join('.'); const multi = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(t2); return (multi ? p[p.length - 3] : p[p.length - 2]) || p[0]; }
  favicon(u) { const h = this.hostOf(u); return h ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(h) + '&sz=64' : ''; }
  iconFor(bm) { return String(bm && bm.icon || '').trim() || this.favicon(bm ? bm.url : ''); }
  letterOf(bm) { const n = (bm.name || this.hostCore(bm.url) || '?').trim(); return (n[0] || '?').toUpperCase(); }
  grad(seed) { const s = String(seed || '?'); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } const hue = (h >>> 0) % 360; return 'linear-gradient(135deg,hsl(' + hue + ',72%,60%),hsl(' + ((hue + 42) % 360) + ',70%,47%))'; }
  normalize(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
  lev(a, b) { a = a || ''; b = b || ''; if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length; let prev = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let cur = [i]; for (let j = 1; j <= b.length; j++) { const c = a[i - 1] === b[j - 1] ? 0 : 1; cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c); } prev = cur; } return prev[b.length]; }
  sim(a, b) { a = a || ''; b = b || ''; if (!a || !b) return 0; const m = Math.max(a.length, b.length); return m ? 1 - this.lev(a, b) / m : 0; }
  // ---- speech-robust matching helpers ----
  // Common ways the speech engine mangles popular site names. These are SAFE
  // spelling/spacing fixes ("g mail" -> "gmail"): they're added as extra query
  // variants, never used to rename what the user actually said, so they can only
  // help a correct match and never cause a wrong one.
  aliasMap() {
    return this._aliasMap || (this._aliasMap = {
      'g mail': 'gmail', 'google mail': 'gmail',
      'you tube': 'youtube', 'u tube': 'youtube', 'utube': 'youtube',
      'linked in': 'linkedin', 'fig ma': 'figma',
      'chat gpt': 'chatgpt', 'chat g p t': 'chatgpt', 'chatgbt': 'chatgpt', 'chat gbt': 'chatgpt',
      'google drive': 'drive', 'g drive': 'drive',
      'google calendar': 'calendar', 'g calendar': 'calendar', 'g cal': 'calendar',
      'google docs': 'docs', 'google sheets': 'sheets', 'google slides': 'slides',
      'sales force': 'salesforce', 'git hub': 'github', 'face book': 'facebook',
      'whats app': 'whatsapp', 'what s app': 'whatsapp', 'insta': 'instagram', 'the gram': 'instagram',
      'note ion': 'notion', 'no shun': 'notion', 'note shun': 'notion', 'red it': 'reddit',
      'red dit': 'reddit', 'micro soft': 'microsoft', 'out look': 'outlook',
      'drop box': 'dropbox', 'sound cloud': 'soundcloud',
      'google sheets': 'sheets', 'g sheets': 'sheets', 'g docs': 'docs', 'g slides': 'slides',
      'open ai': 'openai', 'open a i': 'openai', 'chat g b t': 'chatgpt',
      'tik tok': 'tiktok', 'tick tock': 'tiktok', 'snap chat': 'snapchat',
      'pinter est': 'pinterest', 'spot if i': 'spotify', 'spot a fi': 'spotify',
      'pay pal': 'paypal', 'venn mo': 'venmo', 'air bnb': 'airbnb', 'air b n b': 'airbnb',
      'word press': 'wordpress', 'stack overflow': 'stackoverflow', 'cloud flare': 'cloudflare',
      'note book lm': 'notebooklm', 'cal andar': 'calendar'
    });
  }
  // Concept → site synonyms. Lets a request phrased by *purpose* ("open my
  // email", "the repo", "music") find a bookmark by what it IS, not just by a
  // literal name/host match. Each key is a spoken/generic word; the values are
  // tokens that, when present in a bookmark's name / host / url / notes, mean
  // that bookmark satisfies the concept. Curated, on-device — no network.
  conceptMap() {
    return this._conceptMap || (this._conceptMap = {
      email: ['gmail', 'outlook', 'proton', 'protonmail', 'yahoo', 'hotmail', 'icloud', 'fastmail', 'mail'],
      mail: ['gmail', 'outlook', 'proton', 'yahoo', 'hotmail', 'icloud', 'mail'],
      inbox: ['gmail', 'outlook', 'mail'],
      video: ['youtube', 'vimeo', 'twitch'], videos: ['youtube', 'vimeo', 'twitch'],
      movies: ['netflix', 'hulu', 'disney', 'primevideo', 'max', 'youtube'],
      tv: ['netflix', 'hulu', 'disney', 'max', 'youtube'],
      streaming: ['netflix', 'hulu', 'disney', 'youtube', 'twitch', 'spotify'],
      music: ['spotify', 'soundcloud', 'applemusic', 'pandora', 'tidal', 'youtubemusic'],
      songs: ['spotify', 'soundcloud', 'applemusic', 'tidal'],
      code: ['github', 'gitlab', 'bitbucket'], repo: ['github', 'gitlab', 'bitbucket'],
      repository: ['github', 'gitlab', 'bitbucket'], git: ['github', 'gitlab', 'bitbucket'],
      docs: ['docs', 'notion', 'word', 'onedrive', 'confluence'],
      document: ['docs', 'notion', 'word', 'onedrive'], documents: ['docs', 'notion', 'word', 'onedrive'],
      spreadsheet: ['sheets', 'excel', 'airtable'], spreadsheets: ['sheets', 'excel', 'airtable'],
      sheet: ['sheets', 'excel', 'airtable'],
      slides: ['slides', 'powerpoint', 'keynote'], presentation: ['slides', 'powerpoint', 'keynote'],
      calendar: ['calendar', 'cal', 'calendly'], schedule: ['calendar', 'calendly'],
      chat: ['chatgpt', 'claude', 'gemini', 'copilot', 'slack', 'discord'],
      ai: ['chatgpt', 'claude', 'gemini', 'copilot', 'openai', 'bard', 'perplexity'],
      assistant: ['chatgpt', 'claude', 'gemini', 'copilot'],
      gpt: ['chatgpt', 'openai'], chatbot: ['chatgpt', 'claude', 'gemini'],
      shopping: ['amazon', 'ebay', 'etsy', 'walmart', 'target'], shop: ['amazon', 'ebay', 'etsy'],
      buy: ['amazon', 'ebay', 'etsy', 'walmart'],
      social: ['facebook', 'instagram', 'twitter', 'threads', 'tiktok', 'linkedin', 'reddit'],
      photos: ['photos', 'flickr', 'instagram', 'imgur', 'pinterest'], pictures: ['photos', 'flickr', 'imgur'],
      images: ['photos', 'flickr', 'imgur', 'pinterest'],
      maps: ['maps', 'googlemaps', 'waze'], directions: ['maps', 'waze'], navigation: ['maps', 'waze'],
      design: ['figma', 'canva', 'sketch', 'adobe', 'dribbble'],
      storage: ['drive', 'dropbox', 'box', 'onedrive', 'icloud'],
      files: ['drive', 'dropbox', 'box', 'onedrive'], cloud: ['drive', 'dropbox', 'onedrive', 'icloud'],
      meeting: ['zoom', 'meet', 'teams', 'webex', 'skype'], meet: ['zoom', 'meet', 'teams'],
      call: ['zoom', 'meet', 'teams', 'webex', 'skype'], zoom: ['zoom'],
      notes: ['notion', 'evernote', 'keep', 'onenote', 'obsidian', 'bear'],
      note: ['notion', 'evernote', 'keep', 'onenote', 'obsidian'],
      todo: ['todoist', 'notion', 'asana', 'trello'], tasks: ['todoist', 'asana', 'trello', 'jira', 'linear'],
      project: ['jira', 'asana', 'trello', 'linear', 'monday', 'clickup', 'notion'],
      tracker: ['jira', 'asana', 'trello', 'linear', 'monday'], tickets: ['jira', 'zendesk', 'linear'],
      work: ['slack', 'jira', 'asana', 'salesforce', 'notion'],
      crm: ['salesforce', 'hubspot'], bank: ['chase', 'wellsfargo', 'bankofamerica', 'paypal'],
      banking: ['chase', 'wellsfargo', 'bankofamerica'], money: ['paypal', 'venmo', 'mint', 'stripe'],
      pay: ['paypal', 'venmo', 'stripe'], payment: ['paypal', 'venmo', 'stripe'],
      news: ['news', 'cnn', 'bbc', 'nytimes', 'reuters', 'guardian'],
      weather: ['weather', 'accuweather', 'wunderground'],
      search: ['google', 'bing', 'duckduckgo'], maps2: ['maps'],
      gaming: ['steam', 'twitch', 'epicgames', 'xbox', 'playstation'], games: ['steam', 'epicgames', 'twitch']
    });
  }
  // Words that carry no matching signal — dropped before concept analysis.
  conceptStops() {
    return this._conceptStops || (this._conceptStops = new Set(
      ('a an the my our your to up on in of for me us please go goto open show get find launch ' +
       'pull bring load start visit head and or it that this these those page site website web app ' +
       'com www http https new tab window thing stuff some any my').split(' ')));
  }
  // The searchable text for one bookmark: name + spoken host + core domain +
  // url path tokens + notes/description. Returned as a blob string and a word
  // set so the concept scorer can analyse title, URL, and description together.
  bmKeywords(bm) {
    const name = this.normalize(bm.name);
    const host = this.normalize(this.hostOf(bm.url).replace(/\./g, ' '));
    const core = this.normalize(this.hostCore(bm.url));
    const urlToks = this.normalize(String(bm.url || '').replace(/[\/._\-?=&#]+/g, ' '));
    const notes = this.normalize(bm.notes);
    const blob = [name, host, core, urlToks, notes].filter(Boolean).join(' ');
    return { blob, words: new Set(blob.split(' ').filter(Boolean)) };
  }
  // Score a bookmark by how well the request's meaningful words are covered by
  // its title / URL / description — directly, via concept synonyms, or fuzzily.
  // Full coverage yields a confident score (can auto-open when it's the clear
  // winner); partial coverage only ever surfaces the bookmark as an option.
  conceptScore(prep, bm) {
    const toks = (prep && prep.tokens) || [];
    if (!toks.length) return 0;
    const { blob, words } = this.bmKeywords(bm);
    if (!blob) return 0;
    const cmap = this.conceptMap();
    let sum = 0, covered = 0;
    for (const t of toks) {
      let tScore = 0;
      if (words.has(t) || (t.length >= 3 && blob.includes(t))) {
        tScore = 1; // literal hit in name / host / url / notes
      } else if (cmap[t]) {
        for (const g of cmap[t]) { if (words.has(g) || blob.includes(g)) { tScore = 0.92; break; } } // concept synonym
      }
      if (!tScore && t.length >= 4) {
        let bestSim = 0;
        for (const w of words) { if (w.length >= 4) { const sm = this.sim(t, w); if (sm > bestSim) bestSim = sm; } }
        if (bestSim >= 0.84) tScore = 0.85 * bestSim; // fuzzy / misheard
      }
      if (tScore > 0) covered++;
      sum += tScore;
    }
    const coverage = covered / toks.length, avg = sum / toks.length;
    return coverage >= 1 ? 0.78 + 0.14 * avg : 0.5 * avg;
  }
  // A compact Soundex-style key, used only as a last-resort tie-breaker for
  // consonant-preserving mis-hears (e.g. "figma" vs "fig mah").
  phon(s) {
    s = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return '';
    const map = { b: '1', f: '1', p: '1', v: '1', c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2', d: '3', t: '3', l: '4', m: '5', n: '5', r: '6' };
    const first = s[0]; let code = ''; let prev = map[first] || '';
    for (let i = 1; i < s.length; i++) { const ch = s[i]; const c = map[ch]; if (c && c !== prev) code += c; if (ch !== 'h' && ch !== 'w') prev = c || ''; }
    return (first + code).slice(0, 6);
  }
  // Build the set of query strings we'll try when matching: the normalized form,
  // a de-spaced form ("g mail" -> "gmail"), plus alias-expanded variants.
  prepQuery(query, extra) {
    const base = this.normalize(query);
    const variants = new Set();
    const add = v => { v = (v || '').trim(); if (v) variants.add(v); };
    // Fold one phrase into the candidate set: its normalized form, a de-spaced
    // form ("g mail" -> "gmail"), plus alias-expanded variants of each.
    const fold = phrase => {
      const b = this.normalize(phrase); if (!b) return;
      add(b); add(b.replace(/\s+/g, ''));
      let aliased = b;
      for (const k in this.aliasMap()) if (aliased.includes(k)) aliased = aliased.split(k).join(this.aliasMap()[k]);
      add(aliased); add(aliased.replace(/\s+/g, ''));
    };
    fold(base);
    // Extra phrases come from the engine's alternative hypotheses; they enrich
    // matching but the primary phrase still drives phon/raw (and variants[0]).
    if (Array.isArray(extra)) for (const p of extra) fold(p);
    // Meaningful words (stopwords removed) drive concept/coverage analysis.
    const stops = this.conceptStops();
    const tokens = base.split(' ').filter(w => w.length >= 2 && !stops.has(w));
    return { variants: [...variants], phon: this.phon(base.replace(/\s+/g, '')), raw: base, tokens };
  }
  scoreBookmark(prep, bm) {
    // Accept a raw string for backward-compatibility.
    if (typeof prep === 'string') prep = this.prepQuery(prep);
    const variants = prep.variants || []; if (!variants.length) return 0;
    const name = this.normalize(bm.name), core = this.normalize(this.hostCore(bm.url)), host = this.normalize(this.hostOf(bm.url).replace(/\./g, ' '));
    const nameFlat = name.replace(/\s+/g, '');
    let best = 0;
    for (const q of variants) {
      if (!q) continue;
      for (const c of [name, nameFlat, core]) { if (!c) continue; if (c === q) return 1; best = Math.max(best, this.sim(q, c)); }
      for (const c of [name, nameFlat, core, host]) { if (!c) continue; if (c.includes(q) || q.includes(c)) { const r = Math.min(q.length, c.length) / Math.max(q.length, c.length); best = Math.max(best, 0.78 + 0.2 * r); } }
      const qt = q.split(' ').filter(Boolean); const hay = (name + ' ' + host + ' ' + core).trim();
      if (qt.length && qt.every(w => hay.includes(w))) best = Math.max(best, 0.9);
      const hw = hay.split(' ').filter(Boolean);
      for (const w of qt) for (const h of hw) if (w.length >= 3 && h.length >= 3) best = Math.max(best, 0.7 * this.sim(w, h));
      const notes = this.normalize(bm.notes);
      if (notes && q.length >= 3 && notes.includes(q)) { const r = Math.min(q.length, notes.length) / Math.max(q.length, notes.length); best = Math.max(best, 0.6 + 0.18 * r); }
    }
    // Phonetic last resort — only a mild boost, never enough to beat a real match.
    if (best < 0.86 && prep.phon) { for (const c of [nameFlat, core]) { if (c && this.phon(c) === prep.phon) { best = Math.max(best, 0.85); break; } } }
    // Concept / coverage analysis over title + URL + description. Only raises the
    // score (recall), never lowers it, so exact-match behaviour is preserved.
    const cs = this.conceptScore(prep, bm);
    if (cs > best) best = cs;
    return best;
  }
  /* ---------- on-device usage signal (voice-match tie-breaker) ----------
   * A small, LOCAL-ONLY tally of how often / how recently each bookmark is
   * opened. It is used purely to break ties between equally-scored matches so
   * the site the user actually reaches for wins (e.g. "google" -> the Google
   * app they open daily, not a stale one). It never changes a clear winner and
   * never touches the Google Sheet — it only personalises ordering. */
  loadUsage() {
    if (this._usage) return this._usage;
    let m = null; try { m = JSON.parse(localStorage.getItem(this.LS_USE) || 'null'); } catch {}
    this._usage = (m && typeof m === 'object') ? m : Object.create(null);
    return this._usage;
  }
  // A single comparable number: open-count dominates, recency (0–90, higher =
  // more recent) breaks equal counts. Unopened bookmarks score 0.
  usageScore(id) {
    const u = this.loadUsage()[id]; if (!u) return 0;
    const n = +u.n || 0, t = +u.t || 0;
    return n * 1000 + (t ? Math.max(0, 90 - Math.min(90, (Date.now() - t) / 86400000)) : 0);
  }
  bumpUsage(id) {
    if (!id) return;
    try { const m = this.loadUsage(); const u = m[id] || { n: 0, t: 0 }; m[id] = { n: (+u.n || 0) + 1, t: Date.now() }; localStorage.setItem(this.LS_USE, JSON.stringify(m)); }
    catch {}
  }
  // Rank every bookmark for a prepared query, best first. Ties (identical
  // scores) fall back to the on-device usage signal so the more-used site wins.
  rankBookmarks(prep) {
    return this.state.bookmarks.map(bm => ({ bm, s: this.scoreBookmark(prep, bm) })).filter(x => x.s > 0)
      .sort((a, b) => (b.s - a.s) || (this.usageScore(b.bm.id) - this.usageScore(a.bm.id)));
  }
  matchBookmark(q, th) { const prep = typeof q === 'string' ? this.prepQuery(q) : q; let best = null; for (const bm of this.state.bookmarks) { const s = this.scoreBookmark(prep, bm); if (s >= th && (!best || s > best.s)) best = { bm, s }; } return best; }
  allFolders() { const out = []; for (const pg of this.state.pages) for (const c of pg) if (c && c.type === 'folder') out.push(c); return out; }
  scoreFolder(q, f) { q = this.normalize(q).replace(/\b(folder|group)\b/g, ' ').replace(/\s+/g, ' ').trim(); const n = this.normalize(f.name); if (!q || !n) return 0; if (n === q) return 1; let best = this.sim(q, n); if (n.includes(q) || q.includes(n)) { const r = Math.min(q.length, n.length) / Math.max(q.length, n.length); best = Math.max(best, 0.78 + 0.2 * r); } const qt = q.split(' ').filter(Boolean); if (qt.length && qt.every(w => n.includes(w))) best = Math.max(best, 0.9); return best; }
  matchFolder(q, th) { let best = null; for (const f of this.allFolders()) { const s = this.scoreFolder(q, f); if (s >= th && (!best || s > best.s)) best = { f, s }; } return best; }

  /* ---------- voice command grammar (ported, trimmed) ---------- */
  parsePageNav(raw) {
    const t = this.normalize(raw); if (!t) return null;
    if (/\b(next|forward)\s+page\b/.test(t) || /\bpage\s+(forward|right|over)\b/.test(t)) return { to: this.state.currentPage + 1, rel: true };
    if (/\b(previous|prev|last|back|backward)\s+page\b/.test(t) || /\bgo\s+back\s+(a\s+)?page\b/.test(t) || /\bpage\s+(back|left|before)\b/.test(t)) return { to: this.state.currentPage - 1, rel: true };
    const hasPage = /\bpage\b/.test(t);
    const NUM = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10 };
    if (hasPage) { const dm = t.match(/\b(\d{1,2})\b/); let n = dm ? parseInt(dm[1], 10) : null; if (n == null) for (const w in NUM) if (new RegExp('\\b' + w + '\\b').test(t)) n = NUM[w]; if (n != null) return { to: n - 1 }; }
    const strong = /\b(go to|goto|switch to|jump to|take me to|navigate to)\b/.test(t);
    if (hasPage || strong) { const q = t.replace(/\b(go to|goto|switch to|jump to|take me to|navigate to|open|show|the)\b/g, ' ').replace(/\bpage\b/g, ' ').replace(/\s+/g, ' ').trim(); if (q) for (let i = 0; i < this.state.pages.length; i++) if (q === this.normalize(this.pageName(i))) return { to: i }; }
    return null;
  }
  parseCommand(raw) {
    const t = ' ' + this.normalize(raw) + ' ';
    if (/\b(stop listening|quit listening|turn (it |yourself )?off|go to sleep|stop now)\b/.test(t)) return { kind: 'stop' };
    if (/\bclose\b/.test(t) && /\b(tabs?|windows?|them|those|these|everything|all|it|that)\b/.test(t)) return { kind: 'close' };
    if (/\b(what can you do|help me out|show help|list (my )?(bookmarks|projects)|what (bookmarks|projects))\b/.test(t)) return { kind: 'help' };
    // Adding a bookmark must be asked for EXPLICITLY: an add-intent verb tied
    // directly to the word "bookmark" ("add bookmark", "add a new bookmark",
    // "save this bookmark", "new bookmark for …"). Bare "add" / "save" /
    // "remember" / a stray "bookmark" no longer trigger an add, so ordinary
    // speech ("save me a seat", "remember to call mum", "that's a good
    // bookmark") can never accidentally create a site.
    const cleaned = ' ' + String(raw).toLowerCase().replace(/[^a-z0-9\s.\-]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    const addM = cleaned.match(/\b(?:add|save|create|make|store|new)\s+(?:(?:a|an|the|another|new|this)\s+){0,2}(?:bookmarks?|projects?)\b(?:\s+(?:for|of|to|called|named|as)\b)?/);
    if (addM) { const rawQ = cleaned.slice(addM.index + addM[0].length).replace(/\b(a|an|the|my|please|for me|to my (bookmarks|favorites))\b/g, ' ').replace(/\s+/g, ' ').trim(); return { kind: 'add', query: this.normalize(rawQ), rawQuery: rawQ }; }
    const m = t.match(/\b(open up|open|launch|go to|goto|pull up|bring up|navigate to|take me to|show me|load up|load|start up|start|fire up|jump to|switch to|visit|head to|get me)\b/);
    let query, explicit;
    if (m) { query = t.slice(m.index + m[0].length); explicit = true; } else { query = t; explicit = false; }
    query = ' ' + query + ' ';
    query = query.replace(/\b(in|on)\s+(a\s+)?(new\s+)?(tab|window|browser)\b/g, ' ').replace(/\b(please|for me|right now|now|real quick|hey|ok|okay|can you|could you|i want to|i need to)\b/g, ' ').replace(/\b(website|web site|the site|site|the page|page|the app|dot com|dot org|dot net)\b/g, ' ').replace(/\b(my|the|a|an|to|up|new|tab|window)\b/g, ' ').replace(/\s+/g, ' ').trim();
    return { kind: explicit ? 'open' : 'maybe', query };
  }
  // Decide exactly which bookmark/folder a spoken phrase means. The guiding rule
  // is accuracy over eagerness: open immediately only when there is a clear,
  // unambiguous winner; when two sites are plausibly close, return the short list
  // so the user can confirm (via the chooser) rather than risk opening the wrong
  // one.
  resolveTarget(query, extraQueries) {
    const prep = this.prepQuery(query, extraQueries); if (!prep.variants.length) return null;
    const q = prep.variants[0];
    const wantsFolder = /\b(folder|group)\b/.test(q);
    const ranked = this.rankBookmarks(prep);
    const fm = this.matchFolder(q, wantsFolder ? 0.34 : 0.52);
    const best = ranked[0] || null, second = ranked[1] || null;

    if (wantsFolder && fm && (!best || fm.s >= best.s)) return { kind: 'folder', folder: fm.f, confident: true };

    const FLOOR = 0.42, STRONG = 0.86, GAP = 0.12;
    if (best && best.s >= FLOOR) {
      // A folder that clearly beats the best bookmark wins.
      if (fm && fm.s > best.s + GAP) return { kind: 'folder', folder: fm.f, confident: true };
      // Exact hit, or a strong winner that's well clear of the runner-up → open.
      const clearWinner = best.s >= 0.999 || (best.s >= STRONG && (!second || best.s - second.s >= GAP));
      if (clearWinner) return { kind: 'bookmark', bm: best.bm, confident: true };
      // Otherwise it's ambiguous: offer the close candidates for a one-tap or one-word confirm.
      const choices = ranked.filter(x => x.s >= 0.5).slice(0, 4).map(x => x.bm);
      if (choices.length > 1) return { kind: 'choose', choices };
      return { kind: 'bookmark', bm: best.bm, confident: false };
    }
    if (fm) return { kind: 'folder', folder: fm.f, confident: true };
    return null;
  }
  handleTranscript(raw, alts) {
    const text = String(raw).trim(); if (!text) return;
    // Dictation: while a text field is focused, type the spoken words into it
    // instead of running commands — but still honour "stop listening".
    const field = this.activeField();
    if (field) {
      const c0 = this.parseCommand(text);
      if (c0.kind === 'stop') { this.stopListen(); return; }
      this.dictate(field, text); return;
    }
    // Lower-ranked engine hypotheses, each reduced to just its target phrase.
    // These only widen what a target name can match — they never change which
    // command (open / add / nav / stop) we decide to run.
    const altQueries = (Array.isArray(alts) ? alts : [])
      .map(a => { try { return this.parseCommand(a).query; } catch { return ''; } })
      .filter(Boolean);
    // If a disambiguation chooser is open, let the spoken words pick from it
    // ("the second one", "Gmail", "cancel") before anything else.
    if (this.state.choosing) { if (this.pickFromChoices(text, altQueries)) return; }
    const nav = this.parsePageNav(text);
    if (nav) { this.applyNav(nav); return; }
    const cmd = this.parseCommand(text);
    if (cmd.kind === 'stop') { this.stopListen(); return; }
    if (cmd.kind === 'close') { this.closeOpened(); return; }
    if (cmd.kind === 'help') { this.toast('Say “open” + a project, “next page”, or “add project Claude”', 'sparkles'); return; }
    if (cmd.kind === 'add') { if (cmd.rawQuery) this.addByVoice(cmd.rawQuery); else this.toast('Say “add project” + a name, e.g. “add project Claude”', 'mic'); return; }
    if (cmd.kind === 'maybe') {
      // No explicit "open" verb — this may just be ambient speech, so only act on
      // a near-perfect, unambiguous match (never guess from a bare phrase).
      const prep = this.prepQuery(cmd.query);
      const ranked = this.rankBookmarks(prep);
      const top = ranked[0], second = ranked[1];
      if (top && top.s >= 0.97 && (!second || top.s - second.s >= 0.1)) { this.openBookmark(top.bm, true); return; }
      const f = this.allFolders().find(f => this.normalize(f.name) === prep.variants[0]);
      if (f) this.openFolderVoice(f);
      return;
    }
    if (!cmd.query) { this.toast('Say “open” and a project name', 'mic'); return; }
    const tg = this.resolveTarget(cmd.query, altQueries);
    if (!tg) { this.toast('No project matches “' + cmd.query + '”', 'search-x'); return; }
    if (tg.kind === 'choose') { this.offerChoices(tg.choices, cmd.query); return; }
    if (tg.kind === 'bookmark') this.openBookmark(tg.bm, true);
    else this.openFolderVoice(tg.folder);
  }
  // Present the close candidates and wait for a tap or a spoken pick. Listening
  // stays on so the user can simply say the number or the clearer name.
  offerChoices(choices, query) {
    this.setState({ choosing: (choices || []).slice(0, 4), choiceQuery: query || '' });
    this.toast('Which one? Tap it or say the number', 'sparkles');
    this.speakIf('Which one did you mean?');
  }
  // Resolve a spoken phrase against an open chooser. Returns true if it consumed
  // the phrase (picked, or cancelled); false to let normal handling try instead.
  pickFromChoices(text, extraQueries) {
    const list = this.state.choosing; if (!list || !list.length) return false;
    const t = this.normalize(text);
    if (/\b(cancel|never mind|nevermind|none|forget it|no thanks)\b/.test(t)) { this.setState({ choosing: null, choiceQuery: '' }); return true; }
    // Pick the EARLIEST number word in the phrase so "the second one" reads as
    // 2 (not the trailing pronoun "one"). Ordinals win ties at the same index.
    const NUM = { first: 1, second: 2, third: 3, fourth: 4, one: 1, two: 2, three: 3, four: 4, '1': 1, '2': 2, '3': 3, '4': 4 };
    let n = null, at = Infinity, ord = false;
    for (const w in NUM) {
      const m = t.match(new RegExp('\\b' + w + '\\b'));
      if (!m) continue;
      const isOrd = /first|second|third|fourth/.test(w);
      if (m.index < at || (m.index === at && isOrd && !ord)) { at = m.index; n = NUM[w]; ord = isOrd; }
    }
    if (n != null && n >= 1 && n <= list.length) { const bm = list[n - 1]; this.setState({ choosing: null, choiceQuery: '' }); this.openBookmark(bm, true); return true; }
    // Try the spoken name (and the engine's alternative hearings) against just
    // the offered candidates.
    const prep = this.prepQuery(text, extraQueries);
    let best = null; for (const bm of list) { const s = this.scoreBookmark(prep, bm); if (!best || s > best.s) best = { bm, s }; }
    if (best && best.s >= 0.7) { this.setState({ choosing: null, choiceQuery: '' }); this.openBookmark(best.bm, true); return true; }
    return false;
  }
  // The focused text field within our app, if any (used for dictation).
  activeField() {
    const el = document.activeElement;
    if (!el) return null;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;
    if (tag === 'INPUT' && !/^(text|search|url|email|tel|number|password|)$/i.test(el.type || 'text')) return null;
    if (!el.closest || !el.closest('.bb-root')) return null;
    // The search box invites spoken commands ("or say open…"), so it stays a
    // command target rather than a dictation sink.
    if (el.hasAttribute('data-no-dictate')) return null;
    return el;
  }
  // Append dictated words to a (React-controlled) field and notify React so its
  // state updates exactly as if the user had typed.
  dictate(el, text) {
    const cur = el.value || '';
    const sep = cur && !/\s$/.test(cur) ? ' ' : '';
    const next = cur + sep + text.trim();
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this.setState({ heard: text.trim() });
  }
  // Briefly pulse the matched tile on the springboard so the user sees the hit.
  highlightTile(id) {
    this._hitId = id;
    if (this._hitT) { clearTimeout(this._hitT); this._hitT = null; }
    this.applyHit();
    this._hitT = setTimeout(() => { this._hitId = null; this.applyHit(); this._hitT = null; }, 1300);
  }
  applyHit() {
    const root = document.querySelector('.bb-root'); if (!root) return;
    root.querySelectorAll('.bb-tile.bb-hit').forEach(t => t.classList.remove('bb-hit'));
    if (!this._hitId) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(this._hitId) : String(this._hitId).replace(/"/g, '\\"');
    const cell = root.querySelector('.bb-cell[data-id="' + sel + '"]');
    const tile = cell && cell.querySelector('.bb-tile');
    if (tile) tile.classList.add('bb-hit');
  }
  // Tuck the big voice overlay away without stopping the session's listener.
  hideVoiceOverlay() { if (this.state.voiceOpen) this.setState({ voiceOpen: false }); }
  applyNav(nav) {
    const n = this.state.pages.length, to = nav.to;
    if (to < 0 || to >= n) { this.toast(nav.rel ? (to < 0 ? 'First page' : 'Last page') : 'No such page', 'panel-left'); return; }
    this.setState({ currentPage: to, search: '' });
    this.toast(this.pageName(to), 'panel-left');
    this.speakIf('Showing ' + this.pageName(to));
  }
  pageName(i) { return (this.state.pageNames[i] || '').trim() || ('Page ' + (i + 1)); }

  /* ---------- actions ---------- */
  // Open a URL the same way the rest of the app does (window.open from the
  // panel), but keep the returned window reference so "close tabs" can shut the
  // ones voice opened and so the tile can be tracked.
  openUrl(url) {
    url = this.ensureScheme(url); if (!url) return null;
    let w = null;
    try { w = window.open(url, '_blank'); if (w) w.opener = null; } catch {}
    if (w) { this._opened = this._opened.filter(x => x && !x.closed); this._opened.push(w); }
    return w;
  }
  // Close every tab/window we opened this session.
  closeOpened() {
    const live = (this._opened || []).filter(x => x && !x.closed);
    let n = 0;
    live.forEach(w => { try { w.close(); n++; } catch {} });
    this._opened = [];
    this.toast(n ? ('Closed ' + n + (n === 1 ? ' tab' : ' tabs')) : 'Nothing to close', 'x');
    this.speakIf(n ? ('Closed ' + n + (n === 1 ? ' tab' : ' tabs')) : 'Nothing to close');
  }
  // "Opening" a project now means showing its detail view (name, description,
  // editable notes) — never a browser tab. The detail view's own "Open" button
  // is the only thing that navigates to the project's optional link.
  openBookmark(bm, viaVoice) {
    if (!bm) return;
    if (this.state.choosing) this.setState({ choosing: null, choiceQuery: '' });
    this.bumpUsage(bm.id);   // remember this open to sharpen future voice matches
    this.openDetail(bm.id);
    if (viaVoice) {
      const nm = bm.name || this.hostCore(bm.url);
      this.toast('Opening ' + nm, 'folder-open');
      this.speakIf('Opening ' + nm);
      this.highlightTile(bm.id);
      // Keep listening for the whole session — only clear the heard label and,
      // if the big voice overlay happens to be open, tuck it away.
      this.setState({ heard: nm });
      setTimeout(() => { this.hideVoiceOverlay(); this.setState({ heard: '' }); }, 1400);
    }
  }
  /* ---------- project detail view ----------
   * Tapping a tile (or saying "open <project>") lands here. Description and
   * Notes are edited in place; closing the view auto-saves any change through
   * the existing save() -> sheetSync() outbox path, so edits get the offline
   * queue, retries, and the "Saving…" toast for free. */
  openDetail(id) {
    const bm = this.state.bookmarks.find(b => b.id === id); if (!bm) return;
    this.setState({ detail: id, detailDesc: bm.description || '', detailNotes: bm.notes || '', voiceOpen: false, search: '' });
  }
  // Close the detail view, writing Description/Notes back if they changed.
  closeDetail() {
    const id = this.state.detail; if (!id) return;
    const bm = this.state.bookmarks.find(b => b.id === id);
    const desc = String(this.state.detailDesc || ''), notes = String(this.state.detailNotes || '');
    if (bm && ((bm.description || '') !== desc || (bm.notes || '') !== notes)) {
      const bms = this.state.bookmarks.map(b => b.id === id ? { ...b, description: desc, notes } : b);
      this.setState({ bookmarks: bms, detail: null }, () => this.save());
      this.sheetAnnounce(id, 'Saved', 'check');
    } else {
      this.setState({ detail: null });
    }
  }
  // The optional link: open it in a new tab from inside the detail view.
  openDetailUrl() {
    const bm = this.state.bookmarks.find(b => b.id === this.state.detail);
    if (!bm || !bm.url) return;
    this.openUrl(bm.url);
    this.toast('Opening ' + (bm.name || this.hostCore(bm.url)), 'external-link');
  }
  // Jump from the detail view to the full editor (name, link, icon, delete).
  editFromDetail() {
    const id = this.state.detail; if (!id) return;
    this.closeDetail();
    this.openEdit(id);
  }
  openFolderModal(f, edit) { this.setState({ folderOpen: f, folderEdit: !!edit, voiceOpen: false }); this.stopRec(); }
  // Voice "open <folder>" opens the folder view (a folder groups projects now —
  // it no longer fans out into a pile of browser tabs), keeping the listener alive.
  openFolderVoice(f) {
    if (!f) return;
    this.setState({ folderOpen: f, folderEdit: false, voiceOpen: false });
    this.toast('Opening ' + (f.name || 'Folder'), 'folder-open');
    this.speakIf('Opening ' + f.name);
    this.setState({ heard: f.name });
    setTimeout(() => { this.hideVoiceOverlay(); this.setState({ heard: '' }); }, 1400);
  }
  addBookmark(name, url, icon, description, silent) {
    url = String(url || '').trim(); name = String(name || '').trim();
    icon = String(icon || '').trim(); description = String(description || '').trim();
    if (!name && !url) { this.toast('Give the project a name', 'triangle-alert'); return false; }
    if (url && !this.looksLikeUrl(url)) { this.toast('That doesn’t look like a web address', 'triangle-alert'); return false; }
    if (!name) name = this.hostCore(url).replace(/^\w/, c => c.toUpperCase());
    const id = this.uid();
    const bms = this.state.bookmarks.concat([{ id, name, url, notes: '', icon, description }]);
    const pages = this.state.pages.slice();
    let pi = this.state.currentPage;
    if (!pages[pi]) pi = pages.length - 1;
    if (pages[pi].length >= this.PER_PAGE) { pages.push([]); pi = pages.length - 1; }
    pages[pi] = pages[pi].concat([{ type: 'app', id }]);
    this.setState({ bookmarks: bms, pages, currentPage: pi }, () => this.save());
    if (!silent) this.sheetAnnounce(id, 'Added ' + name, 'check');
    return true;
  }
  addByVoice(rawQuery) {
    const q = rawQuery.trim();
    if (this.looksLikeUrl(q)) { this.addBookmark('', q); return; }
    const known = this.STARTERS.find(s => this.normalize(s.name) === this.normalize(q));
    if (known) this.addBookmark(known.name, known.url);
    // A project doesn't need a link, so a spoken name becomes a name-only tile.
    else this.addBookmark(q.replace(/^\w/, c => c.toUpperCase()), '');
  }
  deleteBookmark(id) {
    const bms = this.state.bookmarks.filter(b => b.id !== id);
    const pages = this.state.pages.map(pg => pg.map(c => {
      if (c.type === 'folder') { const items = c.items.filter(x => x !== id); return items.length ? { ...c, items } : null; }
      return c.id === id ? null : c;
    }).filter(Boolean));
    while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
    let cur = Math.min(this.state.currentPage, pages.length - 1);
    this.setState({ bookmarks: bms, pages, currentPage: cur }, () => this.save());
    this.sheetAnnounce(id, 'Removed', 'trash-2');
  }

  /* ---------- per-bookmark editing (matches the web app's edit flow) ----------
   * Opened by tapping a tile while the springboard is in edit (jiggle) mode.
   * Edits the same fields the web version exposes — Name, URL, Icon, Notes —
   * writes them back onto the bookmark in place (its page/slot is untouched),
   * and persists through the existing save() -> sheetSync() outbox path so the
   * change reaches the Google Sheet and follows you to other devices. Delete
   * reuses the same confirm-then-remove flow the web app uses. */
  openEdit(id) {
    const bm = this.state.bookmarks.find(b => b.id === id);
    if (!bm) return;
    this.setState({
      editing: id,
      editName: bm.name || '', editUrl: bm.url || '',
      editIcon: bm.icon || '', editNotes: bm.notes || '', editDesc: bm.description || '',
      editConfirmDelete: false
    });
  }
  closeEdit() { this.setState({ editing: null, editConfirmDelete: false }); }
  saveEdit() {
    const id = this.state.editing; if (!id) return;
    const url = String(this.state.editUrl || '').trim();
    let name = String(this.state.editName || '').trim();
    // The link is optional now — a project just needs a name (or a link to derive one from).
    if (!name && !url) { this.toast('Give the project a name', 'triangle-alert'); return; }
    if (url && !this.looksLikeUrl(url)) { this.toast('That doesn’t look like a web address', 'triangle-alert'); return; }
    if (!name) name = this.hostCore(url).replace(/^\w/, c => c.toUpperCase());
    const icon = String(this.state.editIcon || '').trim();
    const notes = String(this.state.editNotes || '');
    const description = String(this.state.editDesc || '');
    // Update the project in place — its springboard slot/page is left alone, so
    // editing never moves a tile. sheetSync() diffs and queues only this change.
    const bms = this.state.bookmarks.map(b => b.id === id ? { ...b, name, url, icon, notes, description } : b);
    this.setState({ bookmarks: bms, editing: null, editConfirmDelete: false }, () => this.save());
    this.sheetAnnounce(id, 'Saved', 'check');
  }
  confirmDeleteEdit() {
    const id = this.state.editing; if (!id) return;
    this.setState({ editing: null, editConfirmDelete: false });
    this.deleteBookmark(id);
  }

  /* ---------- voice lifecycle ---------- */
  ensureRec() {
    if (!this.state.srSupported) return null;
    if (this._rec) return this._rec;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = 'en-US';
    // Ask the engine for several hypotheses per phrase, not just its single best
    // guess. The top hypothesis often mangles a site name ("fig ma", "node ion")
    // while a lower-ranked one nails it; handleTranscript matches the target
    // against ALL of them, so the right bookmark is found far more reliably.
    try { r.maxAlternatives = 6; } catch {}
    r.onresult = (e) => {
      this._lastEvt = Date.now(); let interim = '', fin = '', alts = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]; const t = res[0] && res[0].transcript || '';
        if (res.isFinal) { fin += t + ' '; for (let k = 1; k < res.length; k++) { const a = res[k] && res[k].transcript; if (a) alts.push(a); } }
        else interim += t;
      }
      if (fin) { this.setState({ interim: '' }); this.handleTranscript(fin, alts); }
      else if (interim) this.setState({ interim: interim.trim() });
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.stopListen(); this.toast('Allow microphone access, then try again', 'mic-off'); } };
    // Any sign of life resets the stall clock so the watchdog never aborts a
    // healthy recognizer mid-utterance; only a truly silent (zombie) one trips it.
    const bump = () => { this._lastEvt = Date.now(); };
    r.onstart = () => { this._running = true; bump(); };
    r.onaudiostart = bump; r.onsoundstart = bump; r.onspeechstart = bump; r.onaudioend = bump;
    r.onend = () => { this._running = false; if (this._want && this.state.listening) this.kick(); };
    this._rec = r; return r;
  }
  kick(attempt = 0) { if (!this._want || !this.state.listening || this._running) return; const r = this.ensureRec(); if (!r) return; try { r.start(); } catch (err) { if (/already started/i.test(err && err.message || '')) return; if (attempt < 6) setTimeout(() => this.kick(attempt + 1), 200 * (attempt + 1)); } }
  startListen() {
    const r = this.ensureRec();
    if (!r) { this.setState({ voiceOpen: true }); return; }
    this.holdMic();
    this._want = true; this.setState({ listening: true, interim: '', heard: '' }); this.kick();
    // Reliability watchdog. Web Speech silently dies on long sessions, so every
    // few seconds we (a) revive a recognizer that has stopped and (b) abort()+
    // restart one that is "running" but has gone silent past STALL_MS (a zombie).
    if (!this._wd) this._wd = setInterval(() => {
      if (!this._want || !this.state.listening) return;
      this.holdMic();
      if (!this._running) { this.kick(); return; }
      if (this._lastEvt && Date.now() - this._lastEvt > this.STALL_MS) {
        this._lastEvt = Date.now();
        try { this._rec.abort(); } catch {}   // onend -> kick() brings it straight back
      }
    }, 2500);
  }
  // Hold one live mic stream open for the whole session so the recognizer (and
  // the watchdog) stay warm. Only requested when we don't already have a live
  // track, so a granted permission is never re-prompted.
  holdMic() {
    if (this._mic && this._mic.getTracks().some(t => t.readyState === 'live')) return;
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { this._mic = s; }).catch(() => {});
    }
  }
  stopRec() { this._want = false; if (this._rec) { try { this._rec.stop(); } catch {} } if (this._mic) { this._mic.getTracks().forEach(t => t.stop()); this._mic = null; } }
  stopListen() { this.stopRec(); if (this._wd) { clearInterval(this._wd); this._wd = null; } this.setState({ listening: false, interim: '' }); }
  launchVoiceFn() { this.setState({ voiceOpen: true, settingsOpen: false, adding: false, folderOpen: null, search: '' }); this.startListen(); }
  closeVoiceFn() { this.stopListen(); this.setState({ voiceOpen: false }); }
  speakIf(text) { if (this.state.speak && window.speechSynthesis) { try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {} } }

  /* ---------- toast ---------- */
  toast(msg, icon) { if (this._toastT) clearTimeout(this._toastT); this.setState({ toast: msg, toastIcon: icon || 'info' }); this._toastT = setTimeout(() => this.setState({ toast: '' }), 2600); }

  /* ---------- theme + lifecycle ---------- */
  themeVars() {
    const d = this.state.dark;
    return d ? {
      '--bb-wall': 'radial-gradient(120% 80% at 80% -10%, rgba(49,209,255,.18), transparent 55%), radial-gradient(110% 70% at 0% 100%, rgba(3,114,255,.22), transparent 60%), linear-gradient(165deg,#0a0f2e,#070a1f)',
      '--bb-fg': '#eaf0ff', '--bb-fg-soft': '#93a3cf', '--bb-label': '#eef3ff', '--bb-label-shadow': 'rgba(0,0,8,.55)',
      '--bb-tile': '#fbfcff', '--bb-tile-bd': 'rgba(255,255,255,.10)', '--bb-tile-sh': '0 6px 18px rgba(0,0,0,.5)',
      '--bb-glass': 'rgba(28,38,76,.55)', '--bb-glass-bd': 'rgba(255,255,255,.13)', '--bb-glass-sh': '0 10px 30px rgba(0,0,0,.4)',
      '--bb-ctl': 'rgba(255,255,255,.10)', '--bb-search-bg': 'rgba(255,255,255,.08)', '--bb-dot': 'rgba(255,255,255,.32)',
      '--bb-folder': 'rgba(40,52,96,.6)', '--bb-folder-panel': 'rgba(20,28,60,.7)', '--bb-scrim': 'rgba(4,8,24,.6)', '--bb-scrim2': 'rgba(0,0,0,.5)',
      '--bb-sheet': '#121935', '--bb-input-bg': 'rgba(255,255,255,.06)', '--bb-input-bd': 'rgba(255,255,255,.14)',
      '--bb-accent': '#3a8bff', '--bb-accent2': '#31D1FF', '--bb-toast': '#070b22', '--bb-ease': 'cubic-bezier(.16,1,.3,1)',
      '--bb-orb-bg': this.state.listening ? '#fff' : '#0372FF', '--bb-orb-col': this.state.listening ? '#0372FF' : '#fff',
      '--bb-orb-sh': this.state.listening ? '0 0 0 8px rgba(49,209,255,.28),0 12px 40px rgba(0,0,0,.5)' : '0 12px 36px rgba(3,114,255,.5)'
    } : {
      '--bb-wall': 'radial-gradient(120% 78% at 82% -8%, rgba(49,209,255,.20), transparent 52%), radial-gradient(110% 72% at -5% 102%, rgba(3,114,255,.14), transparent 58%), linear-gradient(168deg,#f4f8ff 0%,#e7ecfa 100%)',
      '--bb-fg': '#161F5B', '--bb-fg-soft': '#5a6792', '--bb-label': '#1b245f', '--bb-label-shadow': 'rgba(255,255,255,.7)',
      '--bb-tile': '#ffffff', '--bb-tile-bd': 'rgba(120,130,160,.16)', '--bb-tile-sh': '0 6px 16px rgba(40,50,90,.15),0 1px 3px rgba(40,50,90,.10)',
      '--bb-glass': 'rgba(255,255,255,.6)', '--bb-glass-bd': 'rgba(255,255,255,.75)', '--bb-glass-sh': '0 8px 28px rgba(30,40,90,.13)',
      '--bb-ctl': 'rgba(255,255,255,.85)', '--bb-search-bg': 'rgba(255,255,255,.72)', '--bb-dot': 'rgba(30,40,90,.24)',
      '--bb-folder': 'rgba(255,255,255,.5)', '--bb-folder-panel': 'rgba(255,255,255,.78)', '--bb-scrim': 'rgba(22,31,91,.45)', '--bb-scrim2': 'rgba(22,31,91,.35)',
      '--bb-sheet': '#ffffff', '--bb-input-bg': '#f5f7fc', '--bb-input-bd': '#e2e7f2',
      '--bb-accent': '#0372FF', '--bb-accent2': '#31D1FF', '--bb-toast': '#161F5B', '--bb-ease': 'cubic-bezier(.16,1,.3,1)',
      '--bb-orb-bg': this.state.listening ? '#fff' : '#0372FF', '--bb-orb-col': this.state.listening ? '#0372FF' : '#fff',
      '--bb-orb-sh': this.state.listening ? '0 0 0 8px rgba(49,209,255,.26),0 14px 40px rgba(22,31,91,.18)' : '0 12px 30px rgba(3,114,255,.4)'
    };
  }
  applyTheme() { const root = document.querySelector('.bb-root'); if (!root) return; const v = this.themeVars(); for (const k in v) root.style.setProperty(k, v[k]); const orb = root.querySelector('.bb-vring'); }
  applyTransform(animate) {
    const track = document.querySelector('.bb-track'); if (!track) return;
    // A freshly (re)mounted track — returning from search or the list view —
    // must land on the current page instantly; animating in from page 0 every
    // time read as lag. Only real page changes animate.
    const fresh = !track.style.transform;
    track.style.transition = (animate === false || fresh) ? 'none' : 'transform .26s cubic-bezier(.16,1,.3,1)';
    track.style.transform = 'translateX(' + (-this.state.currentPage * 100) + '%)';
  }
  applyEdit() {
    const editing = this.state.editMode;
    document.querySelectorAll('.bb-root .bb-cell').forEach((el, i) => {
      el.style.animation = editing ? ('bbJiggle .32s infinite ' + (i % 2 ? '-.16s' : '0s')) : '';
    });
    const fedit = this.state.folderEdit;
    document.querySelectorAll('.bb-root .bb-fapp').forEach((el, i) => {
      el.style.animation = fedit ? ('bbJiggle .32s infinite ' + (i % 2 ? '-.16s' : '0s')) : '';
    });
    document.querySelectorAll('.bb-root .bb-vring').forEach(el => { el.style.animation = this.state.listening ? 'bbRing 1.9s ease-out infinite' : ''; el.style.animationDelay = el.style.animationDelay; });
  }
  refreshIcons() {
    if (window.lucide && window.lucide.createIcons) {
      // createIcons() rebuilds EVERY [data-lucide] element in the document —
      // including the <svg>s it already created (they keep the attribute) — so
      // calling it unconditionally re-created every icon on every render and
      // made each tap/toggle feel sticky. Only run it when an unconverted
      // <i data-lucide> actually exists, i.e. React just mounted new markup.
      try { if (document.querySelector('i[data-lucide]')) window.lucide.createIcons(); } catch {}
      this._iconTries = 0; return;
    }
    if ((this._iconTries = (this._iconTries || 0) + 1) < 50) { clearTimeout(this._iconT); this._iconT = setTimeout(() => this.refreshIcons(), 150); }
  }
  handleIcons() {
    const root = document.querySelector('.bb-root'); if (!root) return;
    root.querySelectorAll('img.bb-ico').forEach(img => {
      const want = img.dataset.src;
      if (want && img.getAttribute('src') !== want) { img.style.display = ''; const t = img.closest('.bb-tile'); if (t) t.classList.remove('noico'); img.setAttribute('src', want); }
      const fail = () => {
        img.style.display = 'none';
        const tile = img.closest('.bb-tile');
        if (tile) { tile.classList.add('noico'); const lt = tile.querySelector('.bb-tile-letter'); if (lt) { lt.style.display = 'grid'; tile.style.background = tile.dataset.bg || 'var(--bb-accent)'; } }
      };
      if (!img._bb) { img._bb = 1; img.addEventListener('error', fail); img.addEventListener('load', () => { if (img.naturalWidth === 0) fail(); }); }
      if (img.getAttribute('src') && img.complete && img.naturalWidth === 0) fail();
    });
  }
  postRender() { this.applyTheme(); this.applyTransform(); this.applyEdit(); this.refreshIcons(); this.handleIcons(); this.applyHit(); }
  componentDidMount() { this.postRender(); this.attachGestures(); this.attachFolderGestures(); this.attachPageGestures(); this.attachKeys(); this.attachLifecycle(); this.sheetBoot(); this.autoStartMic(); }
  componentDidUpdate() { this.postRender(); }
  componentWillUnmount() { this.stopListen(); this.detachLifecycle(); this.sheetDetachConnectivity(); if (this._hitT) clearTimeout(this._hitT); if (this._keyH) window.removeEventListener('keydown', this._keyH); }

  /* ---------- side-panel lifecycle (revive-only) ----------
   * A side panel keeps its own document alive for the whole session; clicking
   * into the underlying web page merely blurs the panel. So — unlike the web
   * tab version, which stops on blur/hide — we must NEVER stop listening on
   * blur, or a side-panel focus quirk would silently kill the mic on every page
   * click. We only REVIVE: whenever the panel regains visibility/focus and we
   * still want to listen, re-arm the held mic and re-kick the recognizer. The
   * watchdog covers anything that dies while we're blurred. The mic is released
   * only when the panel is genuinely torn down (pagehide / unmount). */
  attachLifecycle() {
    if (this._lifeAttached) return; this._lifeAttached = true;
    const revive = () => { if (this._want && this.state.listening) { this.holdMic(); this.kick(); } };
    this._visH = () => { if (!document.hidden) revive(); };
    this._focusH = () => revive();
    document.addEventListener('visibilitychange', this._visH);
    window.addEventListener('focus', this._focusH);
    window.addEventListener('pageshow', this._focusH);
    this._unloadH = () => { try { this.stopRec(); } catch {} };
    window.addEventListener('pagehide', this._unloadH);
  }
  detachLifecycle() {
    if (this._visH) document.removeEventListener('visibilitychange', this._visH);
    if (this._focusH) { window.removeEventListener('focus', this._focusH); window.removeEventListener('pageshow', this._focusH); }
    if (this._unloadH) window.removeEventListener('pagehide', this._unloadH);
    this._lifeAttached = false;
  }

  /* ---------- keyboard shortcut ---------- */
  attachKeys() {
    if (this._keyH) return;
    this._keyH = (e) => {
      const mod = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyM' || e.key === 'M' || e.key === 'm');
      if (mod) { e.preventDefault(); if (this.state.voiceOpen) this.closeVoiceFn(); else this.launchVoiceFn(); return; }
      if (this.state.voiceOpen && e.key === 'Escape') { this.closeVoiceFn(); return; }
      const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
      if (typing || this.state.editMode || this.state.adding || this.state.settingsOpen || this.state.folderOpen || this.state.search) return;
      if (e.key === 'ArrowRight') this.goPage(this.state.currentPage + 1);
      else if (e.key === 'ArrowLeft') this.goPage(this.state.currentPage - 1);
    };
    window.addEventListener('keydown', this._keyH);
  }
  goPage(to) { const n = this.state.pages.length; to = Math.max(0, Math.min(n - 1, to)); if (to !== this.state.currentPage) this.setState({ currentPage: to }); }

  /* ---------- gestures: swipe pages + drag reorder ----------
   * The drag engine aims for an iPhone-springboard feel: press-and-hold lifts a
   * tile straight into a drag, the neighbours flow out of the way in real time
   * (a measured FLIP reflow), hovering an app's centre offers to make a folder,
   * and the lifted tile settles into its slot on release with no snap. */
  attachGestures() {
    if (this._attached) return; this._attached = true;
    const root = document.querySelector('.bb-root'); if (!root) return;
    let vp = null, startX = 0, startY = 0, dx = 0, dy = 0, mode = null, cell = null, idx = -1, downAt = 0, lastX = 0, lastY = 0, pressT = null;
    const getVp = () => document.querySelector('.bb-viewport');
    const track = () => document.querySelector('.bb-track');
    const reset = () => { mode = null; cell = null; idx = -1; this.cancelFlip(); this.cleanupDrag(); if (pressT) { clearTimeout(pressT); pressT = null; } };

    root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.bb-badge')) return;
      if (e.target.closest('button:not(.bb-cell)') && !e.target.closest('.bb-cell')) return;
      vp = getVp(); if (!vp || !vp.contains(e.target)) return;
      startX = e.clientX; startY = e.clientY; lastX = startX; lastY = startY; dx = 0; dy = 0; downAt = Date.now();
      cell = e.target.closest('.bb-cell');
      idx = cell ? +cell.dataset.idx : -1;
      if (this.state.editMode && cell) {
        mode = 'pendingdrag';
      } else {
        mode = 'pendingswipe';
        // Press-and-hold lifts the tile straight into a drag (turning on edit
        // mode at the same time) — one motion, exactly like picking up an app.
        if (cell) pressT = setTimeout(() => {
          if (mode !== 'pendingswipe' || Math.abs(dx) > 8 || Math.abs(dy) > 8) return;
          pressT = null; mode = 'drag';
          this.setState({ editMode: true }, () => { if (mode === 'drag' && !this.startDrag(idx, lastX, lastY)) mode = null; });
        }, 420);
      }
      try { root.setPointerCapture(e.pointerId); } catch {}
    });

    root.addEventListener('pointermove', (e) => {
      if (!mode) return;
      lastX = e.clientX; lastY = e.clientY;
      dx = e.clientX - startX; dy = e.clientY - startY;
      if (mode === 'pendingswipe') {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { mode = 'swipe'; if (pressT) { clearTimeout(pressT); pressT = null; } const t = track(); if (t) t.style.transition = 'none'; }
        else if (Math.abs(dy) > 10) { reset(); }
      }
      if (mode === 'swipe') {
        const t = track(); if (!t) return;
        const w = vp.offsetWidth || 1; let off = -this.state.currentPage * w + dx;
        const min = -(this.state.pages.length - 1) * w;
        if (off > 0) off = off * 0.35; if (off < min) off = min + (off - min) * 0.35;
        t.style.transform = 'translateX(' + off + 'px)';
      } else if (mode === 'pendingdrag') {
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) { mode = this.startDrag(idx, e.clientX, e.clientY) ? 'drag' : null; }
      } else if (mode === 'drag') {
        this.dragMove(e.clientX, e.clientY, getVp());
      }
    });

    const end = () => {
      if (!mode) { reset(); return; }
      if (pressT) { clearTimeout(pressT); pressT = null; }
      if (mode === 'swipe') {
        const w = vp.offsetWidth || 1; let to = this.state.currentPage;
        if (dx < -w * 0.22) to++; else if (dx > w * 0.22) to--;
        to = Math.max(0, Math.min(this.state.pages.length - 1, to));
        const t = track(); if (t) t.style.transition = 'transform .26s cubic-bezier(.16,1,.3,1)';
        if (to !== this.state.currentPage) this.setState({ currentPage: to }); else this.applyTransform(true);
      } else if (mode === 'pendingswipe' && cell && Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - downAt < 500) {
        this.tapCell(cell);
      } else if (mode === 'pendingdrag' && cell && Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - downAt < 500) {
        // A tap (no drag) on a tile while in edit mode opens its edit panel.
        this.tapCellEdit(cell);
      } else if (mode === 'drag') {
        this.dropDrag();
      }
      mode = null; cell = null; idx = -1; this.cancelFlip(); if (pressT) { clearTimeout(pressT); pressT = null; }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', () => reset());
  }
  // Per-move work while a tile is lifted: float the ghost, re-measure after an
  // edge-flip, recompute the drop target, and flow the neighbours.
  dragMove(x, y, vp) {
    const d = this._drag; if (!d) return;
    d.lastX = x; d.lastY = y; d.vp = vp;   // remembered so a flip can re-check the arrow
    this.moveGhost(x, y);
    if (d.flipping) return;
    if (!d.board || d.board.page !== this.state.currentPage) { const b = this.measureBoard(); if (b) { d.board = b; this.prepBoardCells(b); } }
    this.updateDragTarget(x, y);
    this.applyReflow();
    this.edgeFlip(x, y, vp);
  }
  tapCell(cell) {
    const idx = +cell.dataset.idx;
    const c = this.state.pages[this.state.currentPage][idx];
    if (!c) return;
    if (c.type === 'folder') { this.openFolderModal(c); return; }
    const bm = this.state.bookmarks.find(b => b.id === c.id); if (bm) this.openBookmark(bm, false);
  }
  // In edit mode a tap (rather than a drag) on a bookmark tile opens its edit
  // panel; a tap on a folder opens it straight into edit mode so its sites can
  // be dragged out (or removed with –) right away.
  tapCellEdit(cell) {
    const idx = +cell.dataset.idx;
    const c = this.state.pages[this.state.currentPage][idx];
    if (!c) return;
    if (c.type === 'folder') { this.openFolderModal(c, true); return; }
    if (c.type !== 'app') return;
    this.openEdit(c.id);
  }
  // Lift the tile at `idx` into a drag from pointer (x,y). Returns false if the
  // board couldn't be measured (in which case the caller drops back to no-op).
  startDrag(idx, x, y) {
    const board = this.measureBoard(); if (!board) return false;
    const cell = board.cells[idx]; if (!cell) return false;
    const rect = cell.getBoundingClientRect();
    // The ghost is a clone pinned to <body> so it survives the re-render an
    // edge-flip triggers. We grab it exactly where the finger landed, so the
    // tile stays glued under the pointer instead of jumping by a fixed offset.
    const g = cell.cloneNode(true);
    g.classList.add('bb-ghost');
    g.style.position = 'fixed'; g.style.left = '0'; g.style.top = '0'; g.style.margin = '0';
    g.style.width = rect.width + 'px'; g.style.zIndex = '9999'; g.style.pointerEvents = 'none'; g.style.animation = 'none';
    g.style.filter = 'drop-shadow(0 18px 30px rgba(22,31,91,.34))';
    g.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px) scale(1)';
    document.body.appendChild(g);
    this._drag = { board, srcIdx: idx, srcKind: cell.dataset.kind, fromPage: this.state.currentPage, ghost: g, grabX: x - rect.left, grabY: y - rect.top, insertIdx: idx, mode: 'reorder', folderIdx: -1, flipping: false };
    this.prepBoardCells(board);
    this.showNavArrows();
    // Lift on the next frame so the scale + shadow transition actually plays.
    requestAnimationFrame(() => {
      const d = this._drag; if (!d || !d.ghost) return;
      d.ghost.style.transition = 'transform .16s cubic-bezier(.2,.8,.2,1), filter .16s';
      this.moveGhost(x, y); this.updateDragTarget(x, y); this.applyReflow();
    });
    return true;
  }
  moveGhost(x, y) {
    const d = this._drag; if (!d || !d.ghost) return;
    d.ghost.style.transform = 'translate(' + (x - d.grabX) + 'px,' + (y - d.grabY) + 'px) scale(1.1)';
  }
  // Prime the current page's cells for live reflow: suspend the jiggle (its
  // rotate transform would fight our translate) and arm a smooth slide.
  prepBoardCells(board) {
    if (!board) return;
    board.cells.forEach(c => { c.style.animation = 'none'; c.style.transition = 'transform .24s cubic-bezier(.2,.85,.25,1)'; c.style.willChange = 'transform'; });
  }
  // Measure the visible page's grid so reflow can place a tile in any slot —
  // including the one-past-the-end slot — without depending on column count.
  measureBoard() {
    const pageEls = document.querySelectorAll('.bb-root .bb-page');
    const pageEl = pageEls[this.state.currentPage];
    if (!pageEl) return null;
    const cells = Array.prototype.slice.call(pageEl.querySelectorAll('.bb-cell'));
    if (!cells.length) {
      return { page: this.state.currentPage, pageEl, cells, rects: [], cols: 1, slotCenter: () => { const r = pageEl.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; } };
    }
    const rects = cells.map(c => { const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
    const tol = rects[0].h * 0.5;
    const rowYs = [];
    rects.forEach(r => { if (!rowYs.some(y => Math.abs(y - r.cy) < tol)) rowYs.push(r.cy); });
    rowYs.sort((a, b) => a - b);
    let cols = 1;
    rowYs.forEach(y => { const c = rects.filter(r => Math.abs(r.cy - y) < tol).length; if (c > cols) cols = c; });
    const firstRow = rects.filter(r => Math.abs(r.cy - rowYs[0]) < tol).sort((a, b) => a.cx - b.cx);
    const colX = firstRow.map(r => r.cx);
    const pitchX = colX.length > 1 ? (colX[colX.length - 1] - colX[0]) / (colX.length - 1) : rects[0].w * 1.08;
    while (colX.length < cols) colX.push(colX[colX.length - 1] + pitchX);
    const pitchY = rowYs.length > 1 ? (rowYs[1] - rowYs[0]) : (rects[0].h + 24);
    const y0 = rowYs[0];
    const slotCenter = (k) => { k = Math.max(0, k); return { x: colX[k % cols], y: y0 + Math.floor(k / cols) * pitchY }; };
    return { page: this.state.currentPage, pageEl, cells, rects, cols, slotCenter };
  }
  // From the pointer, decide whether we're making/joining a folder or where the
  // tile would slot in. Hit-testing uses the static slot geometry so the live
  // reflow can never feed back on itself and oscillate.
  updateDragTarget(x, y) {
    const d = this._drag; if (!d || !d.board) return;
    const b = d.board, rects = b.rects, cells = b.cells, n = cells.length;
    if (!n) { d.mode = 'reorder'; d.folderIdx = -1; d.insertIdx = 0; return; }
    const srcOnPage = d.fromPage === this.state.currentPage;
    let t = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) { const ddx = x - rects[i].cx, ddy = y - rects[i].cy; const dd = ddx * ddx + ddy * ddy; if (dd < bestD) { bestD = dd; t = i; } }
    const r = rects[t];
    const isSrc = srcOnPage && t === d.srcIdx;
    const kind = cells[t].dataset.kind;
    // Folder intent: an app dragged onto the centre of another app (→ new folder)
    // or any folder (→ drop inside). Hysteresis stops it flickering at the edge.
    if (!isSrc && d.srcKind === 'app' && (kind === 'app' || kind === 'folder')) {
      const cdx = x - r.cx, cdy = y - r.cy, cdist = Math.sqrt(cdx * cdx + cdy * cdy);
      const small = Math.min(r.w, r.h), active = d.mode === 'folder' && d.folderIdx === t;
      if (cdist < small * (active ? 0.46 : 0.30)) { d.mode = 'folder'; d.folderIdx = t; return; }
    }
    d.mode = 'reorder'; d.folderIdx = -1;
    const raw = (x < r.cx) ? t : t + 1;
    const insertIdx = (srcOnPage && d.srcIdx < raw) ? raw - 1 : raw;
    d.insertIdx = Math.max(0, Math.min(srcOnPage ? n - 1 : n, insertIdx));
  }
  // Flow the neighbours: slide every other tile to the slot it would occupy once
  // the dragged tile lands, opening a gap at the insertion point (or, in folder
  // mode, send everyone home and swell the target).
  applyReflow() {
    const d = this._drag; if (!d || !d.board) return;
    const b = d.board, cells = b.cells, rects = b.rects, n = cells.length;
    const srcOnPage = d.fromPage === this.state.currentPage;
    cells.forEach((c, i) => { const tile = c.querySelector('.bb-tile'); if (tile) tile.classList.toggle('bb-folder-target', d.mode === 'folder' && i === d.folderIdx); });
    if (d.mode === 'folder') {
      for (let i = 0; i < n; i++) { if (srcOnPage && i === d.srcIdx) { cells[i].style.visibility = 'hidden'; continue; } cells[i].style.visibility = ''; cells[i].style.transform = ''; }
      return;
    }
    const insertIdx = Math.max(0, Math.min(srcOnPage ? n - 1 : n, d.insertIdx));
    let slot = 0;
    for (let i = 0; i < n; i++) {
      if (srcOnPage && i === d.srcIdx) { cells[i].style.visibility = 'hidden'; cells[i].style.transform = ''; continue; }
      cells[i].style.visibility = '';
      if (slot === insertIdx) slot++;           // hold the gap for the dragged tile
      const c = b.slotCenter(slot);
      const tx = c.x - rects[i].cx, ty = c.y - rects[i].cy;
      cells[i].style.transform = (tx || ty) ? ('translate(' + tx + 'px,' + ty + 'px)') : '';
      slot++;
    }
  }
  // Carry the tile into a left/right nav arrow to flip to the adjacent page.
  // The arrow arms while the pointer is in its edge band and flips after a short
  // dwell; moving out before the dwell elapses cancels harmlessly.
  edgeFlip(x, y, vp) {
    // Hysteresis: once a flip is arming, keep it armed until the pointer leaves a
    // wider band, so a shaky hand at the boundary can't repeatedly cancel it.
    if (this._flipDir && this._flipT && this.hitNavArrow(x, y, 40) === this._flipDir) return;
    const dir = this.hitNavArrow(x, y, 0);
    if (dir === -1 && this.state.currentPage > 0) this.scheduleFlip(-1);
    else if (dir === 1 && this.state.currentPage < this.state.pages.length - 1) this.scheduleFlip(1);
    else this.cancelFlip();
  }
  scheduleFlip(dir) {
    if (this._flipDir === dir && this._flipT) return;   // already arming this arrow — let it fill
    this.cancelFlip(); this._flipDir = dir;
    this.armNavArrow(dir, true);
    this._flipT = setTimeout(() => {
      this._flipT = null;
      const to = this.state.currentPage + dir;
      if (to < 0 || to >= this.state.pages.length) { this._flipDir = 0; this.armNavArrow(dir, false); return; }
      const d = this._drag;
      // Pause reflow and clear the old page's transforms while the track slides,
      // then re-measure the new page and pick the drag back up there.
      if (d) { d.flipping = true; this.clearBoardTransforms(d.board); }
      this.goPage(to);
      setTimeout(() => {
        const dd = this._drag; if (!dd) { this._flipDir = 0; return; }
        const b = this.measureBoard(); if (b) { dd.board = b; this.prepBoardCells(b); }
        dd.flipping = false;
        this._flipDir = 0;
        this.updateNavArrows();          // the reachable directions changed with the page
        this.armNavArrow(dir, false);    // reset the fill on the arrow we just used
        // Still resting on the arrow with another page beyond? Keep advancing.
        this.edgeFlip(dd.lastX, dd.lastY, dd.vp);
      }, 380);
    }, this.NAV_DWELL());
  }
  cancelFlip() { if (this._flipT) { clearTimeout(this._flipT); this._flipT = null; } if (this._flipDir) this.armNavArrow(this._flipDir, false); this._flipDir = 0; }
  clearBoardTransforms(board) {
    if (!board) return;
    board.cells.forEach(c => { c.style.transform = ''; c.style.transition = ''; c.style.visibility = ''; });
  }
  // Wipe every drag-time inline style so the freshly rendered grid is clean.
  clearReflow() {
    const root = document.querySelector('.bb-root'); if (!root) return;
    root.querySelectorAll('.bb-cell').forEach(c => { c.style.transform = ''; c.style.transition = ''; c.style.visibility = ''; c.style.willChange = ''; });
    root.querySelectorAll('.bb-tile.bb-folder-target').forEach(t => t.classList.remove('bb-folder-target'));
  }
  // Abort an in-flight drag (pointer cancel / interrupted) with no commit.
  cleanupDrag() {
    const d = this._drag; if (!d) return;
    this._drag = null;
    if (d.ghost) { try { d.ghost.remove(); } catch {} }
    this.hideNavArrows();
    this.clearReflow();
  }

  /* ---------- drag page-nav arrows ----------
   * While a tile is lifted in edit mode, two on-brand arrows fade in at the
   * left and right edges of the springboard. Carrying the tile onto an arrow
   * arms it (an accent fill sweeps in) and, after a short dwell, flips to the
   * adjacent page — a clearer, far more forgiving way to move a bookmark across
   * pages than nudging it into the invisible screen edge. Like the drag ghost,
   * the arrows are pinned to <body>, so a mid-drag page re-render can't disturb
   * them, and they carry literal theme colours (custom properties set on
   * .bb-root don't inherit up to <body>). */
  NAV_DWELL() { return 360; }        // ms the tile must dwell on an arrow to flip
  navColors() {
    const root = document.querySelector('.bb-root');
    const cs = root ? getComputedStyle(root) : null;
    const pick = (n, fb) => { const v = cs && cs.getPropertyValue(n).trim(); return v || fb; };
    return {
      accent: pick('--bb-accent', '#0372FF'),
      accent2: pick('--bb-accent2', '#31D1FF'),
      glass: pick('--bb-glass', 'rgba(255,255,255,.65)'),
      glassBd: pick('--bb-glass-bd', 'rgba(255,255,255,.75)')
    };
  }
  buildNavArrow(dir, col) {
    // A tall glass "edge zone" (not a small dot): reachable when dragging a tile
    // at ANY row height, with a single centred chevron as the direction cue.
    const w = 50;
    const el = document.createElement('div');
    el.className = 'bb-navarrow';
    el.style.cssText = 'position:fixed; z-index:9990; width:' + w + 'px; border-radius:25px; display:grid; place-items:center; overflow:hidden; pointer-events:none; opacity:0; transform:scale(.92); background:' + col.glass + '; border:1.5px solid ' + col.glassBd + '; box-shadow:0 0 0 1.5px rgba(3,114,255,.14), 0 10px 30px rgba(22,31,91,.20); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); transition:opacity .2s ease, transform .18s cubic-bezier(.2,.8,.2,1), box-shadow .2s ease;';
    const fill = document.createElement('span');
    fill.style.cssText = 'position:absolute; inset:0; border-radius:25px; background:linear-gradient(160deg,' + col.accent + ',' + col.accent2 + '); transform:scaleY(0); transform-origin:50% 50%; will-change:transform;';
    const path = dir < 0 ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6';
    const icon = document.createElement('span');
    icon.style.cssText = 'position:relative; z-index:1; display:grid; place-items:center; color:' + col.accent + '; transition:color .2s ease;';
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
    el.appendChild(fill); el.appendChild(icon);
    el.__fill = fill; el.__icon = icon;
    return el;
  }
  showNavArrows() {
    this.hideNavArrows();
    const vp = document.querySelector('.bb-viewport'); if (!vp) return;
    const col = this._navCol = this.navColors();
    const left = this.buildNavArrow(-1, col);
    const right = this.buildNavArrow(1, col);
    document.body.appendChild(left); document.body.appendChild(right);
    this._nav = { left, right };
    this.positionNavArrows();
    // Reveal on the next frame so the fade/scale-in transition actually plays.
    requestAnimationFrame(() => {
      const nav = this._nav; if (!nav) return;
      [nav.left, nav.right].forEach(a => { if (a) a.style.transform = 'scale(1)'; });
      this.updateNavArrows();
    });
  }
  // Run each arrow down most of the springboard's left/right edge and record the
  // hit geometry: a tall band along each edge so a tile can be carried into it
  // from any row, not just the vertical middle.
  positionNavArrows() {
    const nav = this._nav; if (!nav) return;
    const vp = document.querySelector('.bb-viewport'); if (!vp) return;
    const r = vp.getBoundingClientRect();
    const w = 50, inset = 10, vMargin = 16;
    const h = Math.max(140, r.height - vMargin * 2);
    const top = r.top + (r.height - h) / 2;
    const place = (el, x) => { if (!el) return; el.style.left = x + 'px'; el.style.top = top + 'px'; el.style.height = h + 'px'; };
    place(nav.left, r.left + inset);
    place(nav.right, r.right - inset - w);
    nav.leftEdge = r.left; nav.rightEdge = r.right;
    nav.vpTop = r.top; nav.vpBottom = r.top + r.height;
    nav.band = w + inset + 14;   // horizontal reach from the edge (~74px): covers the whole pill
  }
  // Only surface the arrow for a direction that actually has a page to reach.
  updateNavArrows() {
    const nav = this._nav; if (!nav) return;
    const cp = this.state.currentPage, n = this.state.pages.length;
    const set = (el, on) => { if (!el) return; el.dataset.enabled = on ? '1' : '0'; el.style.opacity = on ? '1' : '0'; };
    set(nav.left, cp > 0);
    set(nav.right, cp < n - 1);
  }
  // Which enabled arrow (‑1 left / 1 right / 0 none) the pointer is in — a tall
  // edge band spanning the whole board height. `pad` widens the band for the
  // hysteresis check so a shaky hand at the boundary doesn't flicker.
  hitNavArrow(x, y, pad) {
    const nav = this._nav; if (!nav) return 0;
    pad = pad || 0;
    if (y < nav.vpTop - pad || y > nav.vpBottom + pad) return 0;
    const band = (nav.band || 74) + pad;
    if (nav.left && nav.left.dataset.enabled === '1' && x <= nav.leftEdge + band) return -1;
    if (nav.right && nav.right.dataset.enabled === '1' && x >= nav.rightEdge - band) return 1;
    return 0;
  }
  // Light up (or release) an arrow. When armed, its accent fill sweeps up over
  // the dwell so the impending flip is visible; releasing retracts it.
  armNavArrow(dir, on) {
    const nav = this._nav; if (!nav) return;
    const el = dir < 0 ? nav.left : nav.right; if (!el) return;
    const col = this._navCol || (this._navCol = this.navColors());
    if (on) {
      el.style.transform = 'scale(1.06)';
      el.style.boxShadow = '0 0 0 2px ' + col.accent2 + ', 0 16px 38px rgba(3,114,255,.5)';
      if (el.__fill) {
        // Snap the fill empty (no transition) and force a reflow so it always
        // sweeps in from zero — including on a second flip while still resting
        // on the arrow, where a synchronous 0→1 would otherwise be coalesced.
        el.__fill.style.transition = 'none';
        el.__fill.style.transform = 'scaleY(0)';
        void el.__fill.offsetWidth;
        el.__fill.style.transition = 'transform ' + this.NAV_DWELL() + 'ms linear';
        el.__fill.style.transform = 'scaleY(1)';
      }
      if (el.__icon) { el.__icon.style.transition = 'color ' + Math.round(this.NAV_DWELL() * 0.7) + 'ms linear'; el.__icon.style.color = '#fff'; }
    } else {
      el.style.transform = 'scale(1)';
      el.style.boxShadow = '0 0 0 1.5px rgba(3,114,255,.14), 0 10px 30px rgba(22,31,91,.20)';
      if (el.__fill) { el.__fill.style.transition = 'transform .2s ease'; el.__fill.style.transform = 'scaleY(0)'; }
      if (el.__icon) { el.__icon.style.transition = 'color .2s ease'; el.__icon.style.color = col.accent; }
    }
  }
  hideNavArrows() {
    const nav = this._nav; this._nav = null; this._navCol = null;
    if (!nav) return;
    [nav.left, nav.right].forEach(a => { if (a) { try { a.remove(); } catch {} } });
  }
  // Release: commit the move, then settle the lifted ghost into its landing slot
  // and fade it over the freshly rendered tile. Because the neighbours were
  // already flowed to their final spots, the re-render lands without a snap.
  dropDrag() {
    const d = this._drag; if (!d) return;
    this.cancelFlip();
    this.hideNavArrows();
    const ghost = d.ghost; d.ghost = null;
    const b = d.board;
    let center = null;
    if (b && b.rects.length) {
      if (d.mode === 'folder' && d.folderIdx >= 0 && b.rects[d.folderIdx]) center = { x: b.rects[d.folderIdx].cx, y: b.rects[d.folderIdx].cy };
      else center = b.slotCenter(Math.max(0, Math.min(d.fromPage === this.state.currentPage ? b.cells.length - 1 : b.cells.length, d.insertIdx)));
    }
    this.commitDrop(d);
    this._drag = null;
    if (ghost) {
      if (center) {
        const gw = ghost.offsetWidth, gh = ghost.offsetHeight;
        ghost.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1), opacity .22s ease-out';
        ghost.style.transform = 'translate(' + (center.x - gw / 2) + 'px,' + (center.y - gh / 2) + 'px) scale(1)';
        ghost.style.opacity = '0';
      } else { ghost.style.transition = 'opacity .18s'; ghost.style.opacity = '0'; }
      setTimeout(() => { try { ghost.remove(); } catch {} }, 240);
    }
  }
  // Apply the dragged tile's new home to the page model. Insertion indices are
  // in the rendered order (source already excluded when it shares the page).
  commitDrop(d) {
    const pages = this.state.pages.map(p => p.slice());
    const fromPage = d.fromPage, toPage = this.state.currentPage;
    if (!pages[fromPage]) { this.clearReflow(); return; }
    const src = pages[fromPage][d.srcIdx];
    if (!src) { this.clearReflow(); return; }
    pages[fromPage].splice(d.srcIdx, 1);
    const dest = pages[toPage];
    if (d.mode === 'folder' && d.folderIdx >= 0) {
      let fi = d.folderIdx;
      if (fromPage === toPage && d.srcIdx < fi) fi--;            // account for the removal above
      const target = dest[fi];
      if (target && src.type === 'app' && target.type === 'folder') target.items = target.items.concat([src.id]);
      else if (target && src.type === 'app' && target.type === 'app') dest.splice(fi, 1, { type: 'folder', name: 'Folder', items: [target.id, src.id] });
      else dest.splice(Math.max(0, Math.min(dest.length, fi)), 0, src);
    } else {
      dest.splice(Math.max(0, Math.min(dest.length, d.insertIdx)), 0, src);
    }
    while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
    const cur = Math.min(this.state.currentPage, pages.length - 1);
    this.setState({ pages, currentPage: cur }, () => { this.save(); this.clearReflow(); });
  }
  /* ---------- folder drag-out / reorder ----------
   * Inside an open folder (in its edit mode) a site can be dragged: release it
   * OFF the card to take it out onto the page, or drop it among the other tiles
   * to reorder. This complements the existing "–" button. The springboard's own
   * drag system is untouched — this is a separate, self-contained handler for
   * the folder overlay (which lives outside the board's viewport). */
  attachFolderGestures() {
    if (this._fAttached) return; this._fAttached = true;
    const root = document.querySelector('.bb-root'); if (!root) return;
    let startX = 0, startY = 0, mode = null, fid = null;
    const fappId = el => { const b = el && el.querySelector('button[data-id]'); return b ? b.dataset.id : null; };
    const reset = () => {
      mode = null; fid = null;
      if (this._fGhost) { this._fGhost.remove(); this._fGhost = null; }
      if (this._fDragEl) { this._fDragEl.style.opacity = ''; this._fDragEl = null; }
      this._fOutside = false;
      this.cancelFolderFlip(); this.setFolderDragPeek(false);
      document.querySelectorAll('.bb-folder-card.bb-removearm').forEach(c => c.classList.remove('bb-removearm'));
    };
    root.addEventListener('pointerdown', (e) => {
      if (!this.state.folderOpen || !this.state.folderEdit) return;
      if (e.target.closest('button[aria-label="Take out"]')) return; // the – button
      const el = e.target.closest('.bb-fapp'); if (!el) return;
      fid = fappId(el); if (!fid) return;
      this._fDragEl = el; startX = e.clientX; startY = e.clientY; mode = 'pending';
      this._fHomePage = this.state.currentPage;   // the page the folder lives on
      try { root.setPointerCapture(e.pointerId); } catch {}
    });
    root.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (mode === 'pending') { if (Math.abs(dx) > 6 || Math.abs(dy) > 6) { this.beginFolderDrag(this._fDragEl, e); mode = 'drag'; } else return; }
      if (mode === 'drag' && this._fGhost) {
        this._fGhost.style.transform = 'translate(' + (e.clientX - 29) + 'px,' + (e.clientY - 29) + 'px)';
        const card = document.querySelector('.bb-folder-card');
        const r = card && card.getBoundingClientRect();
        const outside = r ? (e.clientX < r.left - 10 || e.clientX > r.right + 10 || e.clientY < r.top - 10 || e.clientY > r.bottom + 10) : false;
        this._fOutside = outside;
        if (card) card.classList.toggle('bb-removearm', outside);
        // Dragged off the card → reveal the springboard underneath and let the
        // tile flip pages at the left/right edges, so it can be dropped on a
        // DIFFERENT page (not just back beside the folder).
        this.setFolderDragPeek(outside);
        if (outside) this.folderEdgeFlip(e.clientX); else this.cancelFolderFlip();
      }
    });
    const end = (e) => {
      if (mode === 'drag') {
        // Swallow the click this pointer sequence would otherwise fire (which
        // would open the tile or close the folder via the backdrop).
        const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
        root.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => { try { root.removeEventListener('click', swallow, { capture: true }); } catch {} }, 60);
        if (this._fOutside) {
          const folder = this.state.folderOpen;
          if (folder) {
            // Released on a page we flipped to → move the site there and close
            // the folder. Released on the folder's own page → keep the existing
            // "drop beside the folder, stay open" behaviour.
            if (this.state.currentPage !== this._fHomePage) this.removeFromFolderToPage(folder, fid, this.state.currentPage);
            else this.removeFromFolder(folder, fid);
          }
        } else {
          // Dropped back inside the card → reorder. Undo any page flip first.
          if (this.state.currentPage !== this._fHomePage) this.setState({ currentPage: this._fHomePage });
          this.commitFolderReorder(fid, e);
        }
      } else if (mode === 'pending' && fid) {
        // A tap (no drag) on a site while the folder is in edit mode opens its
        // edit panel. pointerdown captured the pointer to root, and Chromium
        // retargets the would-be click to the capture element — so the tile
        // button's own onclick never fires. We open the editor explicitly here
        // (mirroring the springboard's tap-to-edit) and swallow the stray click.
        const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
        root.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => { try { root.removeEventListener('click', swallow, { capture: true }); } catch {} }, 60);
        this.openEdit(fid);
      }
      reset();
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', () => reset());
  }
  beginFolderDrag(el, e) {
    const tile = el.querySelector('.bb-tile');
    const g = (tile || el).cloneNode(true);
    g.style.cssText = 'position:fixed; left:0; top:0; z-index:10000; pointer-events:none; width:58px; height:58px; filter:drop-shadow(0 14px 24px rgba(0,0,0,.4)); opacity:.95;';
    g.style.transform = 'translate(' + (e.clientX - 29) + 'px,' + (e.clientY - 29) + 'px)';
    document.body.appendChild(g); this._fGhost = g; el.style.opacity = '.3';
  }
  // The first tile (in reading order) the pointer sits before; null → append.
  computeInsertBefore(pt, cands) {
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rowTol = r.height * 0.6;
      if (pt.clientY < cy - rowTol) return el;
      if (Math.abs(pt.clientY - cy) <= rowTol && pt.clientX < cx) return el;
    }
    return null;
  }
  // Reorder the dragged site within the folder, based on where it was dropped.
  commitFolderReorder(fid, e) {
    const folder = this.state.folderOpen; if (!folder || folder.type !== 'folder') return;
    const grid = document.querySelector('.bb-folder-grid'); if (!grid) return;
    const cands = [...grid.querySelectorAll('.bb-fapp')].filter(el => el !== this._fDragEl);
    const beforeEl = this.computeInsertBefore(e, cands);
    const beforeId = beforeEl ? ((beforeEl.querySelector('button[data-id]') || {}).dataset || {}).id : null;
    const items = folder.items.slice();
    const from = items.indexOf(fid); if (from < 0) return;
    const [moved] = items.splice(from, 1);
    let to = beforeId ? items.indexOf(beforeId) : items.length; if (to < 0) to = items.length;
    items.splice(to, 0, moved);
    if (items.join('|') === folder.items.join('|')) return; // no change
    const newFolder = Object.assign({}, folder, { items });
    const pages = this.state.pages.map(p => p.map(c => c === folder ? newFolder : c));
    this.setState({ pages, folderOpen: newFolder }, () => this.save());
  }
  // Rename the open folder. The name is the folder's sync key (see toLayout),
  // so editing it re-groups its items under the new name on save, mirroring
  // renamePage. Empty falls back to 'Folder' at display/sync time.
  renameFolder(name) {
    const folder = this.state.folderOpen; if (!folder || folder.type !== 'folder') return;
    const newFolder = Object.assign({}, folder, { name: String(name || '') });
    const pages = this.state.pages.map(p => p.map(c => c === folder ? newFolder : c));
    this.setState({ pages, folderOpen: newFolder }, () => this.save());
  }
  // Remove one app from an open folder, dropping it back beside the folder.
  // When the folder is left with a single item (or none) it dissolves, exactly
  // like dragging the last tile out on iOS.
  removeFromFolder(folderCell, id) {
    const pages = this.state.pages.map(p => p.slice());
    let fp = -1, fi = -1;
    for (let p = 0; p < pages.length && fp < 0; p++) { const i = pages[p].indexOf(folderCell); if (i >= 0) { fp = p; fi = i; } }
    if (fp < 0) return;
    const folder = pages[fp][fi];
    folder.items = folder.items.filter(x => x !== id);
    pages[fp].splice(fi + 1, 0, { type: 'app', id });
    let open = folder;
    if (folder.items.length <= 1) {
      if (folder.items.length === 1) pages[fp].splice(fi, 1, { type: 'app', id: folder.items[0] });
      else pages[fp].splice(fi, 1);
      open = null; // folder dissolved → close the overlay
    }
    this.setState({ pages, folderOpen: open, folderEdit: !!open && this.state.folderEdit }, () => this.save());
    this.toast(open ? 'Moved out' : 'Folder emptied', 'check');
  }
  // Take a site out of the folder and drop it onto another page (the one the
  // user flipped to while dragging off the card), then close the folder so the
  // result is visible. Persists/syncs through the same save() path.
  removeFromFolderToPage(folderCell, id, destPage) {
    const pages = this.state.pages.map(p => p.slice());
    let fp = -1, fi = -1;
    for (let p = 0; p < pages.length && fp < 0; p++) { const i = pages[p].indexOf(folderCell); if (i >= 0) { fp = p; fi = i; } }
    if (fp < 0) { this.setState({ folderOpen: null, folderEdit: false }); return; }
    if (destPage < 0 || destPage >= pages.length) destPage = fp;
    const folder = Object.assign({}, folderCell, { items: folderCell.items.filter(x => x !== id) });
    pages[fp] = pages[fp].slice(); pages[fp][fi] = folder;
    pages[destPage] = pages[destPage].concat([{ type: 'app', id }]);   // land at the end of the target page
    // A folder left with one/zero items dissolves, mirroring removeFromFolder.
    if (folder.items.length <= 1) {
      if (folder.items.length === 1) pages[fp].splice(fi, 1, { type: 'app', id: folder.items[0] });
      else pages[fp].splice(fi, 1);
    }
    while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
    const cur = Math.max(0, Math.min(destPage, pages.length - 1));
    this.setState({ pages, folderOpen: null, folderEdit: false, currentPage: cur }, () => this.save());
    this.toast('Moved to ' + this.pageName(cur), 'check');
  }
  // While a site is dragged off the folder card, fade the card + scrim so the
  // springboard (and its page dots) show through and the drop target is visible.
  setFolderDragPeek(on) {
    const card = document.querySelector('.bb-folder-card');
    const scrim = document.querySelector('.bb-folder-scrim');
    if (card) card.style.opacity = on ? '.22' : '';
    if (scrim) scrim.style.opacity = on ? '.12' : '';
  }
  // Flip the springboard underneath when the dragged-out tile hovers a side edge.
  folderEdgeFlip(x) {
    const vp = document.querySelector('.bb-viewport'); if (!vp) { this.cancelFolderFlip(); return; }
    const r = vp.getBoundingClientRect(), edge = 46;
    if (x < r.left + edge && this.state.currentPage > 0) this.scheduleFolderFlip(-1);
    else if (x > r.right - edge && this.state.currentPage < this.state.pages.length - 1) this.scheduleFolderFlip(1);
    else this.cancelFolderFlip();
  }
  scheduleFolderFlip(dir) {
    if (this._fFlipDir === dir && this._fFlipT) return;
    this.cancelFolderFlip(); this._fFlipDir = dir;
    this._fFlipT = setTimeout(() => {
      this._fFlipT = null; this._fFlipDir = 0;
      this.goPage(this.state.currentPage + dir);
    }, 500);
  }
  cancelFolderFlip() { if (this._fFlipT) { clearTimeout(this._fFlipT); this._fFlipT = null; } this._fFlipDir = 0; }
  toggleFolderEdit() { this.setState({ folderEdit: !this.state.folderEdit }); }
  // Rename the current page. Names ride along in the sheet's Page column
  // ("<n>|<name>") so they sync to other devices once a bookmark sits on the page.
  renamePage(name) {
    const names = (this.state.pageNames || []).slice();
    while (names.length < this.state.pages.length) names.push('');
    names[this.state.currentPage] = String(name || '');
    this.setState({ pageNames: names }, () => this.save());
  }
  // Add a new empty page at the end and jump to it. A page with no bookmarks
  // lives in the local layout; it (and any custom name) only reaches the sheet
  // once a bookmark sits on it — same limitation as page names.
  addPage() {
    const pages = this.state.pages.map(p => p.slice());
    const names = (this.state.pageNames || []).slice();
    pages.push([]);
    while (names.length < pages.length) names.push('');
    this.setState({ pages, pageNames: names, currentPage: pages.length - 1 }, () => this.save());
  }
  // Move a page (with its name) up/down in the order. Reordering re-stamps the
  // Page number on every bookmark via save() -> sheetSync, so it persists/syncs.
  movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.state.pages.length) return;
    const pages = this.state.pages.map(p => p.slice());
    const names = (this.state.pageNames || []).slice();
    while (names.length < pages.length) names.push('');
    const pt = pages[i]; pages[i] = pages[j]; pages[j] = pt;
    const nt = names[i]; names[i] = names[j]; names[j] = nt;
    let cur = this.state.currentPage;
    if (cur === i) cur = j; else if (cur === j) cur = i;
    this.setState({ pages, pageNames: names, currentPage: cur }, () => this.save());
  }
  // Move a page from one index to another (drag-reorder in the Pages manager).
  // `to` is the page's final index. Like movePage, this re-stamps the Page number
  // on every affected bookmark through save() -> sheetSync, so the new order
  // persists locally and syncs to the sheet (and other devices).
  reorderPages(from, to) {
    const n = this.state.pages.length;
    if (from < 0 || from >= n) return;
    to = Math.max(0, Math.min(n - 1, to));
    if (from === to) return;
    const pages = this.state.pages.map(p => p.slice());
    const names = (this.state.pageNames || []).slice();
    while (names.length < pages.length) names.push('');
    const curRef = pages[this.state.currentPage];           // follow the live page by identity
    const [pg] = pages.splice(from, 1);
    const [nm] = names.splice(from, 1);
    pages.splice(to, 0, pg);
    names.splice(to, 0, nm);
    let cur = pages.indexOf(curRef);
    if (cur < 0) cur = Math.min(this.state.currentPage, pages.length - 1);
    this.setState({ pages, pageNames: names, currentPage: cur }, () => this.save());
  }

  /* ---------- Pages manager drag-reorder ----------
   * A self-contained pointer handler for the Pages manager overlay (a scrollable
   * vertical list of page rows). Pressing a row's grip handle lifts the row into
   * a drag; the other rows slide to open a gap (uniform-pitch FLIP, same feel as
   * the springboard), and on release reorderPages() commits + syncs the new order.
   * Active only while the manager is open; the springboard's own drag engine is
   * untouched. */
  attachPageGestures() {
    if (this._pAttached) return; this._pAttached = true;
    const root = document.querySelector('.bb-root'); if (!root) return;
    let mode = null, startY = 0;
    const reset = () => {
      mode = null;
      if (this._pGhost) { try { this._pGhost.remove(); } catch {} this._pGhost = null; }
      const d = this._pDrag;
      if (d && d.rows) d.rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; r.style.visibility = ''; r.style.willChange = ''; });
      this._pDrag = null; this._pInsert = -1;
    };
    root.addEventListener('pointerdown', (e) => {
      if (!this.state.pagesOpen) return;
      if (!e.target.closest('.bb-phandle')) return;
      const row = e.target.closest('.bb-prow'); if (!row) return;
      startY = e.clientY; mode = 'pending';
      this._pDownRow = row; this._pInsert = +row.dataset.pageidx;
      e.preventDefault();
      try { root.setPointerCapture(e.pointerId); } catch {}
    });
    root.addEventListener('pointermove', (e) => {
      if (!mode) return;
      if (mode === 'pending') {
        if (Math.abs(e.clientY - startY) > 4) { if (!this.beginPageDrag(this._pDownRow, e)) { mode = null; return; } mode = 'drag'; }
        else return;
      }
      if (mode === 'drag') {
        const d = this._pDrag; if (!d) return;
        this._pGhost.style.transform = 'translateY(' + (e.clientY - d.grabDY) + 'px)';
        this.pageDragReflow(e.clientY);
      }
    });
    const end = (e) => {
      if (mode === 'drag') {
        const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
        root.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => { try { root.removeEventListener('click', swallow, { capture: true }); } catch {} }, 60);
        const d = this._pDrag;
        if (d && this._pInsert >= 0 && this._pInsert !== d.fromIdx) this.reorderPages(d.fromIdx, this._pInsert);
      }
      reset();
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', () => reset());
  }
  // Lift a page row: clone it to a body-pinned ghost, hide the original, and
  // measure every row so the reflow can slide neighbours by a uniform pitch.
  beginPageDrag(row, e) {
    const list = document.querySelector('.bb-plist'); if (!list) return false;
    const rows = Array.prototype.slice.call(list.querySelectorAll('.bb-prow'));
    if (rows.length < 2) return false;
    const rect = row.getBoundingClientRect();
    const g = row.cloneNode(true);
    g.classList.add('bb-pghost');
    g.style.position = 'fixed'; g.style.left = rect.left + 'px'; g.style.top = '0';
    g.style.width = rect.width + 'px'; g.style.margin = '0'; g.style.zIndex = '10001';
    g.style.pointerEvents = 'none'; g.style.transform = 'translateY(' + rect.top + 'px)';
    g.style.boxShadow = '0 16px 34px rgba(22,31,91,.32)';
    document.body.appendChild(g);
    const rects = rows.map(r => r.getBoundingClientRect());
    const pitch = rects.length > 1 ? (rects[1].top - rects[0].top) : rects[0].height;
    rows.forEach(r => { r.style.transition = 'transform .18s cubic-bezier(.2,.85,.25,1)'; r.style.willChange = 'transform'; });
    this._pGhost = g;
    this._pDrag = { rows, rects, pitch, fromIdx: +row.dataset.pageidx, grabDY: e.clientY - rect.top };
    this._pInsert = this._pDrag.fromIdx;
    this.pageDragReflow(e.clientY);
    return true;
  }
  // Decide where the lifted row would land and flow the others to make room.
  pageDragReflow(y) {
    const d = this._pDrag; if (!d) return;
    const { rows, rects, pitch, fromIdx } = d, n = rows.length;
    let insert = 0;
    for (let i = 0; i < n; i++) { if (i === fromIdx) continue; if (y > rects[i].top + rects[i].height / 2) insert++; }
    insert = Math.max(0, Math.min(n - 1, insert));
    this._pInsert = insert;
    rows.forEach((r, i) => {
      if (i === fromIdx) { r.style.visibility = 'hidden'; r.style.transform = ''; return; }
      r.style.visibility = '';
      const p = i < fromIdx ? i : i - 1;          // index once the dragged row is removed
      const tv = p < insert ? p : p + 1;          // visual slot once it's re-inserted
      const ty = (tv - i) * pitch;
      r.style.transform = ty ? ('translateY(' + ty + 'px)') : '';
    });
  }

  /* ---------- toggles ---------- */
  toggleEditFn() { this.setState({ editMode: !this.state.editMode }); }

  renderVals() {
    const s = this.state;
    const byId = id => s.bookmarks.find(b => b.id === id);
    const cellOf = (c, idx) => {
      if (c.type === 'folder') {
        c.__id = c.__id || ('f' + idx + '_' + (c.name || '').replace(/\s/g, ''));
        const mini = c.items.slice(0, 9).map(id => { const bm = byId(id); return { src: bm ? this.iconFor(bm) : '', letter: bm ? this.letterOf(bm) : '?' }; });
        return { id: c.__id, kind: 'folder', isFolder: true, isApp: false, name: c.name || 'Folder', mini, idx, onDelete: () => {} };
      }
      const bm = byId(c.id) || { id: c.id, name: '?', url: '' };
      return { id: c.id, kind: 'app', isApp: true, isFolder: false, name: bm.name || this.hostCore(bm.url), icon: this.iconFor(bm), letter: this.letterOf(bm), grad: this.grad(bm.name || bm.url), tileClass: '', idx, onDelete: () => this.deleteBookmark(c.id) };
    };
    const pages = s.pages.map((pg, pi) => ({ name: this.pageName(pi), cells: pg.map((c, i) => cellOf(c, i)), empty: pg.length === 0 }));
    // re-stamp idx as data attribute via cell objects (idx used by gestures); ensure data-index present
    pages.forEach(p => p.cells.forEach((c, i) => { c.idx = i; }));

    const dots = s.pages.map((_, i) => ({ go: () => this.goPage(i), scale: i === s.currentPage ? 1.3 : 1, bg: i === s.currentPage ? 'var(--bb-accent)' : 'var(--bb-dot)' }));

    const nq = this.normalize(s.search);
    const showResults = !!s.search.trim();
    let results = [];
    if (showResults) {
      // Rank by the same smart scorer the voice assistant uses (title + URL +
      // description + concept synonyms), while still keeping every literal
      // substring hit so nothing the user typed verbatim disappears.
      const prep = this.prepQuery(s.search);
      results = s.bookmarks
        .map(b => {
          const sub = this.normalize(b.name).includes(nq) || this.normalize(this.hostOf(b.url)).includes(nq) || this.normalize(b.notes).includes(nq) || this.normalize(b.description).includes(nq);
          return { b, sub, sc: this.scoreBookmark(prep, b) };
        })
        .filter(x => x.sub || x.sc >= 0.55)
        .sort((a, b) => b.sc - a.sc || (a.sub === b.sub ? 0 : a.sub ? -1 : 1) || (this.usageScore(b.b.id) - this.usageScore(a.b.id)))
        .map(({ b }) => ({ id: b.id, name: b.name || this.hostCore(b.url), host: this.hostOf(b.url), icon: this.iconFor(b), letter: this.letterOf(b), onTap: () => this.openBookmark(b, false) }));
    }

    const have = new Set(s.bookmarks.map(b => this.hostOf(b.url)));
    const suggestions = this.STARTERS.filter(x => !have.has(this.hostOf(x.url))).slice(0, 6).map(x => ({ name: x.name, icon: this.favicon(x.url), letter: x.name[0], add: () => this.addBookmark(x.name, x.url) }));

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const fname = s.bookmarks[0] ? (s.bookmarks[0].name || this.hostCore(s.bookmarks[0].url)) : 'ChatGPT';
    const transcript = s.interim || s.heard || (s.listening ? 'Listening… try “open ' + fname + '”' : 'Tap the mic, then say “open ' + fname + '”');
    const folder = s.folderOpen;
    const detailBm = s.detail ? byId(s.detail) : null;

    // ----- List view: one flat, deduped, A→Z sectioned list of every site -----
    // Folders are dissolved here — every bookmark is its own row, exactly like
    // the iPhone App Library list. Rows reuse the search-result open behaviour.
    const seenIds = new Set();
    const flat = [];
    s.pages.forEach(pg => pg.forEach(c => {
      if (!c) return;
      (c.type === 'folder' ? c.items : [c.id]).forEach(id => {
        if (seenIds.has(id)) return; seenIds.add(id);
        const bm = byId(id); if (bm) flat.push(bm);
      });
    }));
    // Any bookmark the layout hasn't placed still belongs in "all sites".
    s.bookmarks.forEach(bm => { if (!seenIds.has(bm.id)) { seenIds.add(bm.id); flat.push(bm); } });
    const dispName = bm => bm.name || this.hostCore(bm.url);
    flat.sort((a, b) => dispName(a).toLowerCase().localeCompare(dispName(b).toLowerCase()));
    const secMap = Object.create(null);
    flat.forEach(bm => {
      let L = (dispName(bm).trim()[0] || '#').toUpperCase();
      if (L < 'A' || L > 'Z') L = '#';
      (secMap[L] = secMap[L] || []).push({
        id: bm.id, name: dispName(bm), host: this.hostOf(bm.url),
        icon: this.iconFor(bm), letter: this.letterOf(bm),
        onTap: () => this.openBookmark(bm, false)
      });
    });
    const sectionLetters = Object.keys(secMap).filter(L => L !== '#').sort();
    if (secMap['#']) sectionLetters.push('#');       // "#" section always last
    const listSections = sectionLetters.map(letter => ({ letter, rows: secMap[letter] }));
    const scrollToLetter = (L) => { const el = document.getElementById('bb-sec-' + L); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    // Bindings are property paths (no call expressions), so each rail entry
    // carries its own pre-bound handler — same pattern as the page dots' d.go.
    const azIndex = sectionLetters.map(letter => ({ letter, go: () => scrollToLetter(letter) }));

    return {
      greeting, subtitle: s.bookmarks.length + (s.bookmarks.length === 1 ? ' project' : ' projects') + ' · swipe to browse',
      search: s.search, hasSearch: !!s.search, onSearch: e => this.setState({ search: e.target.value }), clearSearch: () => this.setState({ search: '' }),
      showResults, showBoard: !showResults && s.view !== 'list', noResults: showResults && results.length === 0, results,
      pages, dots, showDots: s.pages.length > 1 && !s.editMode && s.view !== 'list', editMode: s.editMode,
      // ----- List view (A→Z, App Library style) -----
      showList: !showResults && s.view === 'list',
      listSections, azIndex, listEmpty: flat.length === 0,
      scrollToLetter,
      toggleList: () => this.setState({ view: s.view === 'list' ? 'grid' : 'list', search: '' }, () => this.saveSettings()),
      listBtnStyle: s.view === 'list' ? 'background:var(--bb-accent); color:#fff; box-shadow:0 4px 14px rgba(3,114,255,.4);' : '',
      openSettings: () => this.setState({ settingsOpen: true }), closeSettings: () => this.setState({ settingsOpen: false }),
      // ----- Pages manager (opened from Settings) -----
      pagesOpen: s.pagesOpen,
      openPages: () => this.setState({ settingsOpen: false, pagesOpen: true }),
      // Rearrange lives in Settings now (dock button removed): close the sheet
      // and drop straight into edit mode so the springboard is already wiggling.
      openRearrange: () => this.setState({ settingsOpen: false, editMode: true }),
      closePages: () => this.setState({ pagesOpen: false }),
      pagesManager: s.pages.map((pg, i) => {
        const ids = [];
        pg.forEach(c => { if (!c) return; if (c.type === 'folder') ids.push.apply(ids, c.items); else ids.push(c.id); });
        const n = ids.length;
        const mini = ids.slice(0, 5).map(id => { const bm = byId(id); return { src: bm ? this.iconFor(bm) : '', letter: bm ? this.letterOf(bm) : '?' }; });
        const more = n - mini.length;
        return {
          idx: i, label: this.pageName(i),
          count: n + (n === 1 ? ' project' : ' projects'),
          mini, more: more > 0 ? ('+' + more) : '', hasMore: more > 0,
          empty: n === 0, isCurrent: i === s.currentPage,
          rowStyle: i === s.currentPage ? 'border-color:var(--bb-accent);' : '',
          jump: () => this.setState({ currentPage: i, pagesOpen: false })
        };
      }),
      openAdd: () => this.setState({ adding: true, draftName: '', draftUrl: '', draftIcon: '', draftDesc: '' }), closeAdd: () => this.setState({ adding: false }),
      launchVoice: () => this.launchVoiceFn(), closeVoice: () => this.closeVoiceFn(), toggleListen: () => { if (s.listening) this.stopListen(); else this.startListen(); },
      // Dock mic button: pulses while the mic is live; tapping it pauses
      // listening, and tapping again simply resumes the pulse inline — no voice
      // overlay pop-out. (startListen still falls back to the overlay only when
      // speech recognition isn't supported, to show the explainer.)
      toggleMic: () => { if (this.state.listening) this.stopListen(); else this.startListen(); },
      // When listening the dock mic glows blue and pulses with a plain mic icon;
      // when muted/off it shows the slashed mic-off icon in red so the off state
      // is unmistakable. Both icons are rendered once and toggled by visibility
      // rather than one <i data-lucide="{{ ... }}"> whose value flips: lucide
      // rewrites each <i> into an <svg> outside React's control, so a value that
      // changes after first paint goes stale (the button would turn blue but
      // keep the slashed icon). Showing/hiding fixed icons avoids that entirely.
      micLabel: s.listening ? 'Stop listening' : 'Start voice',
      micIconOnStyle: s.listening ? 'position:relative; z-index:1; display:grid; place-items:center;' : 'display:none;',
      micIconOffStyle: s.listening ? 'display:none;' : 'position:relative; z-index:1; display:grid; place-items:center;',
      micBtnStyle: s.listening
        ? 'color:#fff; background:linear-gradient(140deg,var(--bb-accent),var(--bb-accent2)); box-shadow:0 8px 22px rgba(3,114,255,.45);'
        : 'color:#ef4444; background:var(--bb-tile); box-shadow:0 8px 22px rgba(239,68,68,.30); border:2px solid #ef4444;',
      micRingStyle: s.listening ? 'position:absolute; inset:-5px; border-radius:50%; border:2px solid var(--bb-accent2); pointer-events:none; animation:bbRing 1.6s ease-out infinite;' : 'display:none;',
      micBtnAnim: s.listening ? 'animation:bbMicPulse 1.6s ease-in-out infinite;' : '',
      toggleEdit: () => this.toggleEditFn(), exitEdit: () => this.setState({ editMode: false }),
      adding: s.adding, settingsOpen: s.settingsOpen,
      draftName: s.draftName, draftUrl: s.draftUrl, draftIcon: s.draftIcon, draftDesc: s.draftDesc,
      onDraftName: e => this.setState({ draftName: e.target.value }), onDraftUrl: e => this.setState({ draftUrl: e.target.value }),
      onDraftIcon: e => this.setState({ draftIcon: e.target.value }), onDraftDesc: e => this.setState({ draftDesc: e.target.value }),
      saveAdd: () => { if (this.addBookmark(s.draftName, s.draftUrl, s.draftIcon, s.draftDesc)) this.setState({ adding: false }); },
      // ----- per-bookmark edit panel -----
      editing: !!s.editing,
      editName: s.editName, editUrl: s.editUrl, editIcon: s.editIcon, editNotes: s.editNotes, editDesc: s.editDesc,
      onEditName: e => this.setState({ editName: e.target.value }),
      onEditUrl: e => this.setState({ editUrl: e.target.value }),
      onEditIcon: e => this.setState({ editIcon: e.target.value }),
      onEditNotes: e => this.setState({ editNotes: e.target.value }),
      onEditDesc: e => this.setState({ editDesc: e.target.value }),
      // Live tile preview: a hosted http(s) image if given, else the site favicon
      // (same icon rule the springboard tiles use). bb-ico falls back to the letter.
      editIconPreview: (/^https?:\/\//i.test(String(s.editIcon || '').trim()) ? String(s.editIcon).trim() : this.favicon(s.editUrl)),
      editLetter: ((String(s.editName || '').trim() || this.hostCore(s.editUrl) || '?').trim()[0] || '?').toUpperCase(),
      closeEdit: () => this.closeEdit(), saveEdit: () => this.saveEdit(),
      editConfirmDelete: s.editConfirmDelete, showEditActions: !s.editConfirmDelete,
      askDeleteEdit: () => this.setState({ editConfirmDelete: true }),
      cancelDeleteEdit: () => this.setState({ editConfirmDelete: false }),
      confirmDeleteEdit: () => this.confirmDeleteEdit(),
      // ----- project detail view (tap a tile) -----
      detailOpen: !!s.detail && !!detailBm,
      detailName: detailBm ? (detailBm.name || this.hostCore(detailBm.url)) : '',
      detailHost: detailBm ? this.hostOf(detailBm.url) : '',
      detailHasUrl: !!(detailBm && detailBm.url),
      detailIcon: detailBm ? this.iconFor(detailBm) : '',
      detailLetter: detailBm ? this.letterOf(detailBm) : '?',
      detailGrad: detailBm ? this.grad(detailBm.name || detailBm.url) : '',
      detailDesc: s.detailDesc, detailNotes: s.detailNotes,
      onDetailDesc: e => this.setState({ detailDesc: e.target.value }),
      onDetailNotes: e => this.setState({ detailNotes: e.target.value }),
      closeDetail: () => this.closeDetail(),
      openDetailUrl: () => this.openDetailUrl(),
      editFromDetail: () => this.editFromDetail(),
      suggestions,
      addPage: () => this.addPage(),
      pageList: s.pages.map((pg, i) => {
        const n = pg.reduce((t, c) => t + (c && c.type === 'folder' ? c.items.length : 1), 0);
        return {
          label: this.pageName(i), count: n + (n === 1 ? ' project' : ' projects'),
          moveUp: () => this.movePage(i, -1), moveDown: () => this.movePage(i, 1),
          upStyle: i === 0 ? 'opacity:.28; pointer-events:none;' : '',
          downStyle: i === s.pages.length - 1 ? 'opacity:.28; pointer-events:none;' : ''
        };
      }),
      // ----- voice disambiguation chooser -----
      choosing: !!(s.choosing && s.choosing.length), choiceQuery: s.choiceQuery || '',
      choices: (s.choosing || []).map((bm, i) => ({
        n: i + 1, id: bm.id, name: bm.name || this.hostCore(bm.url), host: this.hostOf(bm.url),
        icon: this.iconFor(bm), letter: this.letterOf(bm),
        onTap: () => { this.setState({ choosing: null, choiceQuery: '' }); this.openBookmark(bm, true); }
      })),
      cancelChoose: () => this.setState({ choosing: null, choiceQuery: '' }),
      voiceOpen: s.voiceOpen, voiceStatus: s.listening ? 'Listening' : 'Paused', noVoice: !s.srSupported,
      statusDot: s.listening ? '#22c55e' : 'var(--bb-fg-soft)', statusAnim: s.listening ? 'animation:bbBlink 1.4s infinite;' : '',
      orbIcon: s.listening ? 'mic' : 'mic-off',
      transcript: s.interim || s.heard || (s.listening ? 'Listening… try “open ' + fname + '”' : 'Tap the mic, then say “open ' + fname + '”'),
      transcriptColor: (s.interim || s.heard) ? 'var(--bb-fg)' : 'var(--bb-fg-soft)',
      caretStyle: s.listening && !s.heard ? 'display:inline-block;width:3px;height:1em;background:var(--bb-accent2);margin-left:3px;vertical-align:text-bottom;animation:bbCaret 1s step-end infinite;' : 'display:none;',
      voiceExamples: ['open ' + fname, 'next page', 'add project Claude'],
      folderOpen: !!folder, folderName: folder ? folder.name : '', folderCount: folder ? folder.items.length : 0,
      folderEditing: s.folderEdit, folderNotEditing: !s.folderEdit, folderEditLabel: s.folderEdit ? 'Done' : 'Edit', toggleFolderEdit: () => this.toggleFolderEdit(), onFolderName: e => this.renameFolder(e.target.value),
      folderApps: folder ? folder.items.map(id => { const bm = byId(id) || { id, name: '?', url: '' }; return { id, name: bm.name || this.hostCore(bm.url), icon: this.iconFor(bm), letter: this.letterOf(bm), grad: this.grad(bm.name || bm.url), tileClass: '', onTap: () => { if (s.folderEdit) this.openEdit(id); else this.openBookmark(bm, false); }, onRemove: () => this.removeFromFolder(folder, id) }; }) : [],
      closeFolder: () => this.setState({ folderOpen: null, folderEdit: false }),
      pageTitle: (s.pageNames[s.currentPage] || ''), onPageName: e => this.renamePage(e.target.value),
      shortcutLabel: (navigator.platform || '').toLowerCase().includes('mac') ? '⌘⇧M' : 'Ctrl ⇧ M',
      dark: s.dark, toggleDark: () => this.setState({ dark: !s.dark }, () => this.saveSettings()),
      darkSwitchBg: s.dark ? 'var(--bb-accent)' : 'var(--bb-input-bd)', darkKnobX: s.dark ? '21px' : '2.5px',
      speak: s.speak, toggleSpeak: () => this.setState({ speak: !s.speak }, () => this.saveSettings()),
      speakSwitchBg: s.speak ? 'var(--bb-accent)' : 'var(--bb-input-bd)', speakKnobX: s.speak ? '21px' : '2.5px',
      count: s.bookmarks.length,
      toast: s.toast, toastIcon: s.toastIcon
    };
  }
}

;return (typeof Component !== "undefined" && Component) || undefined;
};
