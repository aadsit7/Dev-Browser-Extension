/**
 * AI Projects Assistant — Google Apps Script backend
 * ===================================================
 *
 * Server side of the extension's Google Sheet sync. It speaks EXACTLY the
 * protocol the extension expects:
 *
 *   GET  {url}?action=getBookmarks&token={token}
 *        -> { ok: true, bookmarks: [ { "Bookmark ID": ..., "Name": ..., ... } ] }
 *
 *   POST {url}   (Content-Type: text/plain — this is deliberate: it keeps the
 *                 request "simple" so there is no CORS preflight, which Apps
 *                 Script cannot answer)
 *        body { token, action: "saveBookmark", bookmark: {row} } -> { ok: true }
 *        body { token, action: "deleteBookmark", id }            -> { ok: true }
 *
 * Rows live in the "Projects" tab. Columns (created automatically if missing):
 *   Bookmark ID | Name | URL | Folder | Page | Position | Owner (Profile ID) |
 *   Date Added | Last Opened | Times Opened | Notes | Icon | Description
 *
 * HOW TO INSTALL
 * --------------
 *   1. Open the Apps Script project behind your deployed web app and replace
 *      the contents of Code.gs with this file. Save.
 *   2. (Optional) Script Properties (Project Settings -> Script Properties):
 *        SHEET_ID  — the spreadsheet to use. Only needed if the script is
 *                    NOT bound to your "AI Projects" spreadsheet AND you want
 *                    to override DEFAULT_SPREADSHEET_ID below.
 *        APP_TOKEN — set this to require a token from clients. Leave unset
 *                    for tokenless operation (the extension's default).
 *   3. Deploy -> Manage deployments -> edit the EXISTING deployment (pencil)
 *      -> Version: "New version" -> Deploy. Editing the existing deployment
 *      keeps the same /exec URL, so the extension needs no change.
 *      ("Execute as: Me", "Who has access: Anyone".)
 */

'use strict';

// The "AI Projects" spreadsheet. Used only when the script is not bound to a
// spreadsheet and no SHEET_ID script property is set.
var DEFAULT_SPREADSHEET_ID = '1jNowsAcytrNcZQg3Qc9mFJ0hv-hHWqGescCh3pqfj6E';

var TAB_NAME = 'Projects';
var HEADERS = [
  'Bookmark ID', 'Name', 'URL', 'Folder', 'Page', 'Position',
  'Owner (Profile ID)', 'Date Added', 'Last Opened', 'Times Opened',
  'Notes', 'Icon', 'Description'
];

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Token check: only enforced when an APP_TOKEN script property exists.
function tokenOk_(token) {
  var want = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!want) return true;
  return String(token || '') === want;
}

// Resolve the spreadsheet (SHEET_ID property -> bound sheet -> default) and
// return the "Projects" tab, creating it — and any missing columns — on demand.
function sheet_() {
  var ss = null;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) {} }
  if (!ss) { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {} }
  if (!ss) { try { ss = SpreadsheetApp.openById(DEFAULT_SPREADSHEET_ID); } catch (e) {} }
  if (!ss) return null;

  var sh = ss.getSheetByName(TAB_NAME);
  if (!sh) {
    sh = ss.insertSheet(TAB_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    return sh;
  }
  // Make sure every expected column exists; append any that are missing.
  var lastCol = Math.max(1, sh.getLastColumn());
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var missing = HEADERS.filter(function (h) { return head.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

// Map header name -> 1-based column index for the tab's CURRENT layout.
function headerMap_(sh) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {};
  for (var c = 0; c < head.length; c++) {
    var h = String(head[c] || '').trim();
    if (h) map[h] = c + 1;
  }
  return map;
}

// 1-based row index of the row whose "Bookmark ID" equals id, or -1.
function findRow_(sh, map, id) {
  var col = map['Bookmark ID'];
  if (!col || sh.getLastRow() < 2) return -1;
  var ids = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  for (var r = 0; r < ids.length; r++) {
    if (String(ids[r][0] || '').trim() === id) return r + 2;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * GET — action=getBookmarks
 * ------------------------------------------------------------------ */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'getBookmarks') {
    if (!tokenOk_(p.token)) return json_({ ok: false, error: 'Invalid token.' });
    var sh = sheet_();
    if (!sh) return json_({ ok: false, error: 'No spreadsheet available — set SHEET_ID in Script Properties.' });
    var map = headerMap_(sh);
    var out = [];
    if (sh.getLastRow() > 1) {
      var vals = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
      for (var r = 0; r < vals.length; r++) {
        var row = {};
        var empty = true;
        for (var h in map) {
          var v = vals[r][map[h] - 1];
          if (v instanceof Date) v = v.toISOString();
          row[h] = v == null ? '' : v;
          if (row[h] !== '') empty = false;
        }
        if (!empty && String(row['Bookmark ID'] || '').trim()) out.push(row);
      }
    }
    return json_({ ok: true, bookmarks: out });
  }
  return json_({ ok: true, service: 'ai-projects-assistant' });
}

/* ------------------------------------------------------------------ *
 * POST — saveBookmark (upsert by Bookmark ID) / deleteBookmark
 * ------------------------------------------------------------------ */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Request body was not valid JSON.' });
  }
  if (!tokenOk_(body.token)) return json_({ ok: false, error: 'Invalid token.' });
  try {
    if (body.action === 'saveBookmark') return saveBookmark_(body.bookmark || {});
    if (body.action === 'deleteBookmark') return deleteBookmark_(String(body.id || '').trim());
    return json_({ ok: false, error: 'Unknown action: ' + String(body.action || '(none)') });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function saveBookmark_(bm) {
  var id = String(bm['Bookmark ID'] || '').trim();
  if (!id) return json_({ ok: false, error: 'saveBookmark needs a "Bookmark ID".' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    if (!sh) return json_({ ok: false, error: 'No spreadsheet available.' });
    var map = headerMap_(sh);
    var rowIdx = findRow_(sh, map, id);
    if (rowIdx < 0) {
      rowIdx = Math.max(2, sh.getLastRow() + 1);
      sh.getRange(rowIdx, map['Bookmark ID']).setValue(id);
    }
    for (var h in map) {
      if (h === 'Bookmark ID') continue;
      if (Object.prototype.hasOwnProperty.call(bm, h)) {
        sh.getRange(rowIdx, map[h]).setValue(bm[h] == null ? '' : bm[h]);
      }
    }
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function deleteBookmark_(id) {
  if (!id) return json_({ ok: false, error: 'deleteBookmark needs an "id".' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    if (!sh) return json_({ ok: false, error: 'No spreadsheet available.' });
    var map = headerMap_(sh);
    var rowIdx = findRow_(sh, map, id);
    if (rowIdx > 0) sh.deleteRow(rowIdx);
    // Deleting a row that's already gone still succeeds — the outcome matches.
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
