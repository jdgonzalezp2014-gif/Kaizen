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

/**
 * The scoreboard, computed rather than stated.
 *
 * The client's spec prints "22 live units × $1,500/mo = $33,000". All
 * three of those are wrong to hardcode: units go on and off, the target
 * is a business decision that changes, and the portfolio figure is just
 * their product. A target set for 27 units judges a portfolio of 20
 * unfairly, and the failure is invisible — the number simply looks
 * missed.
 *
 * So the unit count is derived at read time. A unit Hostaway reports as
 * inactive shows ⚪ on 📊 Dashboard and is excluded, and the response
 * carries the count it used so a screen can say "20 active × $1,500"
 * rather than presenting a moved target as an unexplained drop.
 */
function apiTargets_(ss) {
  const perUnit = cfgNum_('TARGET_NET_PER_UNIT', 1500);
  const sheet = ss.getSheetByName(SHEET_DASH);

  let active = 0, inactive = 0;
  if (sheet && sheet.getLastRow() > 1) {
    const H = headerMap_(sheet);
    const col = H['🚥 Vacancy'];
    if (col) {
      sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues().forEach(r => {
        const v = String(r[0] || '');
        if (!v) return;
        if (v.indexOf('⚪') >= 0) inactive++; else active++;
      });
    }
  }

  return {
    perUnitNet: perUnit,
    activeUnits: active,
    inactiveUnits: inactive,
    portfolioNet: active * perUnit,
    // Stated so a screen never has to infer it: the target moved because
    // the portfolio did, not because something broke.
    basis: active + ' active unit(s) × ' + perUnit
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
    lastSync: cfg_('LAST_SYNC_AT', '') || null,
    targets: apiTargets_(ss)
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

// ============================================================
// WRITES — expenses and claims, appended only
// ============================================================

/**
 * The only two things the team writes from the app.
 *
 * Append-only, deliberately. A retry, a double-tap on a phone, or a lost
 * response cannot corrupt a row that already exists — the worst case is
 * a duplicate, which is visible and deletable, rather than a silently
 * rewritten figure that nobody can reconstruct. It also means yesterday's
 * numbers stay reproducible: the sheets are a ledger, not a current-state
 * table.
 *
 * `source` and `externalRef` are carried now and used by nobody. They are
 * here because Walmart and Amazon invoice import is explicitly wanted
 * later, and a column added before there is data is free while a column
 * added after means a migration.
 */
const API_WRITABLE = {
  expense: {
    sheet: function () { return SHEET_COSTS; },
    // Maps the request body onto the sheet's own header names. The panel
    // owns those names; this map is the seam, so a column rename is one
    // edit here rather than a hunt through the front end.
    map: {
      startDate:  'Start Date',
      endDate:    'End Date',
      scope:      'Scope',
      listingId:  'Listing ID',
      unit:       'Internal Name',
      category:   'Category',
      frequency:  'Frequency',
      amount:     'Amount',
      notes:      'Notes'
    },
    required: ['startDate', 'amount'],
    defaults: { frequency: 'One-time', category: 'General', scope: 'This unit' }
  },
  claim: {
    sheet: function () { return SHEET_CLAIMS; },
    map: {
      date:        'Date',
      listingId:   'Listing ID',
      unit:        'Internal Name',
      source:      'Source',
      category:    'Category',
      severity:    'Severity',
      description: 'Description',
      status:      'Status',
      refund:      'Refund / Credit',
      repair:      'Repair Cost',
      notes:       'Notes'
    },
    required: ['date'],
    defaults: { severity: 'Medium', status: 'Open', source: 'Guest message' }
  }
};

function apiAppend_(ss, kind, body) {
  const spec = API_WRITABLE[kind];
  if (!spec) return { ok: false, error: 'unknown_kind', message: '"' + kind + '" is not writable.' };

  const sheet = ss.getSheetByName(spec.sheet());
  if (!sheet) return { ok: false, error: 'no_sheet', message: spec.sheet() + ' does not exist yet.' };

  const missing = spec.required.filter(k => body[k] === undefined || body[k] === '' || body[k] === null);
  if (missing.length) {
    return { ok: false, error: 'missing_fields', message: 'Required: ' + missing.join(', ') };
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const values  = Object.assign({}, spec.defaults, body);
  const row     = new Array(headers.length).fill('');

  Object.keys(spec.map).forEach(field => {
    const header = spec.map[field];
    const at = headers.indexOf(header);
    if (at < 0) return;                       // sheet predates this field; skip rather than fail
    if (values[field] === undefined) return;
    row[at] = values[field];
  });

  // Provenance on every written row. Who entered it matters when a number
  // is questioned three months later, and it is the only audit trail a
  // spreadsheet gives you for free.
  const note = 'Entered via Kaizen OS by ' + (values._user || 'unknown') +
               ' at ' + nowStamp_() +
               (values.source ? ' · source: ' + values.source : '') +
               (values.externalRef ? ' · ref: ' + values.externalRef : '');

  sheet.appendRow(row);
  const written = sheet.getLastRow();
  try { sheet.getRange(written, 1).setNote(note); } catch (e) {}

  return { ok: true, kind: kind, row: written, sheet: spec.sheet() };
}

/**
 * POST { kind: "expense" | "claim", ...fields }
 *
 * Same allowlist as doGet. Always returns 200 at the HTTP level; read
 * `ok` and `status` in the body — Apps Script web apps cannot set a status.
 */
function doPost(e) {
  let email = '';
  try { email = Session.getEffectiveUser().getEmail(); } catch (err) { email = ''; }

  if (!apiAllowed_(email)) {
    return apiJson_({ error: 'not_authorised', message: 'Not on the allowlist.' }, 403);
  }

  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return apiJson_({ error: 'bad_json', message: err.message }, 400);
  }

  const kind = String(body.kind || '').trim();
  body._user = email;

  // One row per request. Batching would need an idempotency key to stay
  // safe on retry, and nobody is entering expenses fast enough to need it.
  const result = apiAppend_(SpreadsheetApp.getActiveSpreadsheet(), kind, body);
  return apiJson_(result, result.ok ? 200 : 400);
}
