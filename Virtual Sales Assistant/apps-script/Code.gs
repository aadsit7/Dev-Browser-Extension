/**
 * Virtual Sales Assistant — Google Apps Script backend
 * =====================================================
 *
 * This is the complete server-side code for the Apps Script project the
 * extension's GSHEET_WEBHOOK points at. It does two jobs:
 *
 *   1. AI PROXY ("action":"chat") — holds the Anthropic API key and forwards
 *      the extension's coverage-classifier calls to the Anthropic Messages
 *      API, returning { ok, reply, usage }. The call shape the extension
 *      sends (model, max_tokens, system, messages, metadata.user_id,
 *      output_config with a json_schema structured-output format) is
 *      forwarded as-is. Structured outputs are GA — no beta header needed.
 *
 *   2. CHECKLIST LOG ("action":"log_item") — writes back the correct
 *      information for the checklist tool: one row per checked-off item,
 *      appended to the "Checklist Log" tab. Columns:
 *        Timestamp | Session_ID | Item | Covered_By | Evidence | Confidence
 *        | Progress | User_ID | User_Name | First_Name | Last_Name
 *      "Covered_By" is "auto" (the classifier checked it) or "you" (the
 *      seller tapped it). "Evidence" is what was said that covered the item
 *      (auto checks only). "Progress" is e.g. "3 of 5" at the moment of the
 *      check. The tab is created with headers automatically if missing.
 *
 *   A GET with ?action=ping answers { ok, has_api_key, sheet } — the health
 *   check the extension runs when listening starts (and its keep-warm ping).
 *
 * HOW TO INSTALL
 * --------------
 *   1. Open the Apps Script project and replace the contents of Code.gs
 *      with this file.
 *   2. Script Properties (Project Settings → Script Properties):
 *        ANTHROPIC_API_KEY — required; the Anthropic API key.
 *        SHEET_ID          — optional; the ID of the Google Sheet to log to.
 *                            Only needed if this script is NOT bound to a
 *                            spreadsheet (a bound script logs to its own
 *                            spreadsheet automatically).
 *   3. Deploy → Manage deployments → edit the existing deployment (pencil)
 *      → Version: "New version" → Deploy. Editing the EXISTING deployment
 *      keeps the same /exec URL, so the extension needs no change.
 *      ("Execute as: Me", "Who has access: Anyone" — same as the original.)
 */

'use strict';

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

var LOG_SHEET_NAME = 'Checklist Log';
var LOG_HEADERS = [
  'Timestamp', 'Session_ID', 'Item', 'Covered_By', 'Evidence',
  'Confidence', 'Progress', 'User_ID', 'User_Name', 'First_Name', 'Last_Name'
];

// The Anthropic key lives in Script Properties, never in this file or the
// extension. Checked under a few common property names so an existing
// project's configuration keeps working.
function getApiKey_() {
  var props = PropertiesService.getScriptProperties();
  return props.getProperty('ANTHROPIC_API_KEY') ||
         props.getProperty('API_KEY') ||
         props.getProperty('anthropic_api_key') || '';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ *
 * GET — health check / keep-warm ping
 * ------------------------------------------------------------------ */
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'ping') {
    return json_({ ok: true, has_api_key: !!getApiKey_(), sheet: LOG_SHEET_NAME });
  }
  return json_({ ok: true });
}

/* ------------------------------------------------------------------ *
 * POST — chat proxy + checklist log
 * (The extension posts text/plain JSON, which avoids the CORS
 *  preflight Apps Script can't answer.)
 * ------------------------------------------------------------------ */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Request body was not valid JSON.' });
  }
  try {
    if (body.action === 'chat') return handleChat_(body);
    if (body.action === 'log_item') return handleLogItem_(body);
    return json_({ ok: false, error: 'Unknown action: ' + String(body.action || '(none)') });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ------------------------------------------------------------------ *
 * action:"chat" — forward the coverage-classifier call to Anthropic.
 * Whitelisted fields are passed through untouched, including
 * output_config { format: { type:"json_schema", schema } } (structured
 * outputs, GA) and metadata.user_id (the extension's anonymous id).
 * The extension sends save:false on these calls, and classifier churn
 * is deliberately never logged — only real checklist events are.
 * ------------------------------------------------------------------ */
function handleChat_(body) {
  var key = getApiKey_();
  if (!key) {
    return json_({ ok: false, error: 'No Anthropic API key configured — set ANTHROPIC_API_KEY in Script Properties.' });
  }

  var req = {
    model: body.model || 'claude-haiku-4-5',
    max_tokens: body.max_tokens || 512,
    messages: body.messages || []
  };
  var passthrough = ['system', 'metadata', 'output_config', 'tools', 'tool_choice'];
  for (var i = 0; i < passthrough.length; i++) {
    var f = passthrough[i];
    if (body[f] !== undefined) req[f] = body[f];
  }

  var resp = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION
    },
    payload: JSON.stringify(req),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var data = {};
  try { data = JSON.parse(resp.getContentText()); } catch (err) {}

  if (code < 200 || code >= 300) {
    var msg = (data && data.error && data.error.message) || ('Anthropic HTTP ' + code);
    return json_({ ok: false, error: msg });
  }

  // reply = concatenated text blocks. With structured outputs the first
  // text block is guaranteed-valid JSON matching the extension's schema.
  var reply = '';
  var content = data.content || [];
  for (var j = 0; j < content.length; j++) {
    var b = content[j];
    if (b && b.type === 'text' && b.text) reply += b.text;
  }
  return json_({ ok: true, reply: reply, usage: data.usage || null, stop_reason: data.stop_reason || '' });
}

/* ------------------------------------------------------------------ *
 * action:"log_item" — the write-back. One row per checked-off item.
 * ------------------------------------------------------------------ */
function handleLogItem_(body) {
  var sheet = openLogSheet_();
  if (!sheet) {
    return json_({ ok: false, error: 'No spreadsheet available — bind the script to a Sheet or set SHEET_ID in Script Properties.' });
  }
  sheet.appendRow([
    new Date(),
    String(body.session_id || ''),
    String(body.item_text || ''),
    String(body.covered_by || ''),
    String(body.evidence || ''),
    (typeof body.confidence === 'number') ? body.confidence : String(body.confidence || ''),
    String(body.progress || ''),
    String(body.user_id || ''),
    String(body.user_name || ''),
    String(body.first_name || ''),
    String(body.last_name || '')
  ]);
  return json_({ ok: true, logged: true });
}

// Resolve the spreadsheet: SHEET_ID script property first (standalone
// scripts), then the bound spreadsheet. Creates the "Checklist Log" tab
// with headers on first use.
function openLogSheet_() {
  var ss = null;
  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (sheetId) {
    try { ss = SpreadsheetApp.openById(sheetId); } catch (err) {}
  }
  if (!ss) {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) {}
  }
  if (!ss) return null;

  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}
