// ============================================================
//  KAIZEN OS — JSON API
//
//  Deploying this same Apps Script project as a Web App turns the
//  existing backend into an API at no extra cost and with no extra
//  infrastructure. It already holds the Hostaway credentials, already
//  runs on a timer, and already owns the Sheet — a separate server
//  would only be a second place for those things to live.
//
//  DEPLOYMENT, and this part is not optional:
//
//    Deploy > New deployment > Web app
//      Execute as:      User accessing the web app
//      Who has access:  Anyone with a Google Account
//
//  "Execute as: the user" is what makes the allowlist meaningful. If it
//  ran as the owner, anyone with the URL would read the whole portfolio
//  under the owner's permissions, and the check below would be the only
//  thing between the internet and the financials. Running as the caller
//  means Google authenticates them first and the Sheet's own sharing
//  applies as a second layer.
//
//  Do NOT use File > Share > Publish to web to expose CSV. That URL is
//  readable by anyone who ever sees it, forever, with no audit trail and
//  no way to revoke access short of republishing. Money does not go on
//  a public URL.
//
//  Depends on the panel's own helpers: headerMap_, cfg_, SHEET_* names.
// ============================================================

// Comma-separated Google accounts allowed to read. Stored in Script
// Properties (File > Project Settings > Script Properties), never here —
// an allowlist in source is an allowlist in the git history.
const API_ALLOWLIST_KEY = 'API_ALLOWED_EMAILS';

// Only these sheets are ever served. An explicit list, not "any sheet
// named in the query string": the next sheet someone adds should not
// become public because the API was permissive by default.
function apiReadableSheets_() {
  return {
    dashboard:    SHEET_DASH,
    reservations: SHEET_LEDGER,
    costs:        SHEET_COSTS,
    fixedCosts:   SHEET_FIXED_COSTS,
    claims:       SHEET_CLAIMS,
    decisions:    SHEET_DECISIONS,
    suggestions:  SHEET_PRICE_SUGGEST
  };
}

function apiAllowed_(email) {
  const raw = String(cfg_(API_ALLOWLIST_KEY, '')).trim();
  if (!raw) return false;            // unset means closed, never open
  if (!email) return false;
  const list = raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return list.indexOf(String(email).toLowerCase()) >= 0;
}

function apiJson_(obj, code) {
  // Apps Script cannot set an HTTP status on a web app response, so the
  // status rides inside the body and the client checks it. Saying so here
  // because the missing status code otherwise looks like an oversight.
  const payload = Object.assign({ ok: code === 200, status: code || 200 }, obj);
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * A sheet as an array of objects keyed by its header row.
 *
 * Header names are the contract with the web app — they are the same
 * strings the panel writes, emoji included. Renaming a column here
 * silently breaks a screen there, so the front end reads by name and
 * never by position.
 */
function apiSheetRows_(ss, name, limit) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const lastRow = limit ? Math.min(sheet.getLastRow(), limit + 1) : sheet.getLastRow();
  const values  = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const headers = values.shift().map(h => String(h));

  return values.map(r => {
    const o = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const v = r[i];
      // Dates serialise as ISO by default, which the front end then has to
      // guess a timezone for. The panel already stores dates as yyyy-MM-dd
      // text where it matters; anything still a Date is flattened the same way.
      o[h] = (Object.prototype.toString.call(v) === '[object Date]') ? fmtDate(v) : v;
    });
    return o;
  }).filter(o => Object.keys(o).some(k => o[k] !== '' && o[k] != null));
}

/**
 * GET ?sheet=dashboard          one sheet
 * GET ?sheet=all                every readable sheet
 * GET ?sheet=dashboard&limit=50 first N rows
 *
 * Always returns 200 at the HTTP level; read `ok` and `status` in the body.
 */
function doGet(e) {
  let email = '';
  try { email = Session.getEffectiveUser().getEmail(); } catch (err) { email = ''; }

  if (!apiAllowed_(email)) {
    return apiJson_({
      error: 'not_authorised',
      message: email
        ? email + ' is not on the allowlist.'
        : 'No Google account on the request. The deployment must be "Execute as: User accessing the web app".'
    }, 403);
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const want  = String((e && e.parameter && e.parameter.sheet) || 'all').trim();
  const limit = Number((e && e.parameter && e.parameter.limit) || 0) || 0;
  const readable = apiReadableSheets_();

  const meta = {
    user: email,
    generatedAt: new Date().toISOString(),
    // Every response says how fresh it is. The client's spec is right that
    // the real risk is silent staleness — a screen showing yesterday's
    // numbers as if they were today's is worse than a screen that is down.
    lastSync: cfg_('LAST_SYNC_AT', '') || null
  };

  if (want === 'all') {
    const data = {};
    Object.keys(readable).forEach(key => { data[key] = apiSheetRows_(ss, readable[key], limit); });
    return apiJson_({ meta: meta, data: data }, 200);
  }

  if (!readable[want]) {
    return apiJson_({
      error: 'unknown_sheet',
      message: '"' + want + '" is not readable. Available: ' + Object.keys(readable).join(', ')
    }, 404);
  }

  return apiJson_({ meta: meta, sheet: want, rows: apiSheetRows_(ss, readable[want], limit) }, 200);
}

/**
 * Run this once from the editor after deploying, then open the Web App
 * URL. It prints who Apps Script thinks you are and whether the
 * allowlist lets you in — the two things that are wrong when a correct
 * deployment still returns 403.
 */
function apiSelfTest() {
  let email = '';
  try { email = Session.getEffectiveUser().getEmail(); } catch (err) { email = '(threw: ' + err.message + ')'; }
  const raw = cfg_(API_ALLOWLIST_KEY, '');

  SpreadsheetApp.getUi().alert(
    'Kaizen OS — API self test\n\n' +
    'Effective user: ' + (email || '(none)') + '\n' +
    'Allowlist (' + API_ALLOWLIST_KEY + '): ' + (raw || '(not set — the API is closed)') + '\n' +
    'Would be allowed: ' + (apiAllowed_(email) ? 'YES' : 'NO') + '\n\n' +
    'Readable sheets: ' + Object.keys(apiReadableSheets_()).join(', ') + '\n\n' +
    'If this says YES but the URL still returns 403, the deployment is set to ' +
    '"Execute as: Me" instead of "User accessing the web app".');
}
