/*********************************************************************
 * AS CRM — server (Google Apps Script)
 * ------------------------------------------------------------------
 * Pairs with Index.html. Data lives in a private Google Sheet owned
 * by the admin; users never touch the sheet directly — every read /
 * write goes through this web app, which enforces level + tag based
 * access control.
 *
 * DEPLOY (see SETUP_GUIDE.md for full steps):
 *   1. Paste this file + Index.html into a new Apps Script project.
 *   2. Run setupCRM() once from the editor (creates DB + folders).
 *   3. Deploy > New deployment > Web app
 *        Execute as:        Me (the admin)
 *        Who has access:    Anyone within <your domain>
 *   4. Share the web app URL with your team. Add users in Admin tab.
 *********************************************************************/

var APP_NAME = 'AS CRM';
var EMAIL_DOMAIN = 'automationsystems.org';  // usernames are expanded to <name>@EMAIL_DOMAIN

var PROPS = {
  DB: 'CRM_DB_ID',
  ROOT: 'CRM_ROOT_FOLDER',
  TPL: 'CRM_TEMPLATES_FOLDER',
  OUT: 'CRM_QUOTES_FOLDER'
};

var T = {
  USERS: 'Users',
  CUSTOMERS: 'Customers',
  CONTACTS: 'Contacts',
  HANDLERS: 'Handlers',
  CASES: 'Cases',
  ACTIONS: 'Actions',
  QUOTES: 'Quotations',
  QBOQ: 'QuoteBOQ',
  RECYCLE: 'RecycleBin',
  SETTINGS: 'Settings',
  COUNTERS: 'Counters',
  LOG: 'ActivityLog',
  IMPORT: 'Import',
  IMPORTC: 'ImportContacts'
};

var HEADERS = {
  Users: ['Email', 'Name', 'Role', 'AllowedTags', 'Active', 'AddedOn', 'AddedBy'],
  Customers: ['CustomerID', 'Name', 'Tags', 'Type', 'Priority', 'Area', 'Address', 'GSTIN', 'Website', 'Notes', 'SEI', 'Remarks', 'Status', 'CreatedBy', 'CreatedOn', 'UpdatedOn'],
  Contacts: ['ContactID', 'CustomerID', 'Name', 'Designation', 'Phone', 'Email', 'Notes', 'CreatedBy', 'CreatedOn'],
  Handlers: ['CustomerID', 'UserEmail', 'AssignedBy', 'AssignedOn'],
  Cases: ['CaseID', 'CustomerID', 'Title', 'Details', 'Source', 'Stage', 'Outcome', 'OrderValue', 'WonCategories', 'OutcomeNote', 'Owner', 'ExtraOwners', 'Assignee', 'ClosedOn', 'CreatedBy', 'CreatedOn', 'UpdatedOn'],
  Actions: ['ActionID', 'CaseID', 'CustomerID', 'Title', 'DueDate', 'Assignees', 'Status', 'Note', 'CreatedBy', 'CreatedOn', 'DoneOn', 'DoneBy'],
  Quotations: ['QuoteNo', 'Rev', 'CaseID', 'CustomerID', 'Title', 'Source', 'FileName', 'TemplateId', 'TemplateName', 'Status', 'Subtotal', 'TaxPct', 'TaxAmount', 'Total', 'Currency', 'ValidUntil', 'Notes', 'DocLink', 'PdfLink', 'CreatedBy', 'CreatedOn'],
  QuoteBOQ: ['QuoteNo', 'Rev', 'Block', 'Title', 'Headers', 'Rows'],
  RecycleBin: ['CustomerID', 'Name', 'Tags', 'Type', 'Priority', 'Area', 'Address', 'GSTIN', 'Website', 'Notes', 'SEI', 'Remarks', 'Status', 'CreatedBy', 'CreatedOn', 'UpdatedOn', 'DeletedBy', 'DeletedOn'],
  Settings: ['Key', 'Value'],
  Counters: ['Key', 'Last'],
  ActivityLog: ['When', 'Who', 'Action', 'Entity', 'CustomerID', 'Details'],
  Import: ['Name', 'Tag', 'Type', 'Priority', 'Area', 'Address', 'GSTIN', 'ContactName', 'ContactDesignation', 'ContactPhone', 'ContactEmail', 'Handlers'],
  ImportContacts: ['CustomerName', 'ContactName', 'Designation', 'Phone', 'Email', 'Notes']
};

var DEFAULTS = {
  STAGES: ['Lead', 'Opportunity', 'Quoted'],          // working pipeline (kept deliberately simple)
  OUTCOMES: ['Won', 'Lost', 'Hold'],                  // overlay; blank = open
  QUOTE_STATUSES: ['Draft', 'Sent', 'Superseded'],
  SOURCES: ['Direct Enquiry', 'Sales Team', 'Reference', 'Exhibition', 'Tender', 'Existing Customer', 'Other'],
  TAGS: ['Punjab', 'Chandigarh', 'NCR', 'Geo', 'Other'],
  TYPES: ['OEM', 'End User', 'EPC', 'Other'],
  PRIORITIES: ['High', 'Medium', 'Low'],
  CATEGORIES: ['VFDs', 'PLC', 'HMI', 'Panels', 'AVEVA', 'iMCC', 'Soft Starters', 'Motion Control & Robotics', 'Switchgear', 'Metering', 'EMS', 'BMS', 'Lighting, Switches, Wires', 'Pneumatics', 'Service', 'Others'],
  ROLES: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
  TAX_PCT: 18,
  CURRENCY: 'INR',
  COMPANY: 'Automation Systems NG Pvt Ltd'
};

// Human-readable level descriptions (shown in Admin)
var LEVEL_DESC = {
  L1: 'Assignments only — sees only cases & follow-ups assigned to them.',
  L2: 'Sales — own performance dashboard + assignments. Can create customers, cases, quotes.',
  L3: 'L2 + can view the dashboards of L2 users who share a tag, and edit customer tags/type.',
  L4: 'L3 + full access to all customers, cases and follow-ups across all tags.',
  L5: 'L4 without a sales performance dashboard — back-office, full data access, no Admin.',
  L6: 'L5 + Admin (users, settings, import, database links). No performance dashboard.'
};

/* ================================================================
 * ONE-TIME SETUP  — run setupCRM() from the script editor
 * ================================================================ */

/**
 * Clears the stored database/folder IDs so setupCRM() can build a FRESH database.
 * Does NOT delete data — the old spreadsheet and folders stay in your Drive
 * (delete or archive them by hand if you no longer need them).
 * Use it when you deleted the AS CRM Drive folder, or want to start clean:
 * run resetCRM(), then run setupCRM().
 */
function resetCRM() {
  var p = PropertiesService.getScriptProperties();
  [PROPS.DB, PROPS.ROOT, PROPS.TPL, PROPS.OUT].forEach(function (k) { p.deleteProperty(k); });
  Logger.log('AS CRM properties cleared. Now run setupCRM() to build a fresh database.');
}

function setupCRM() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROPS.DB)) {
    var existing = SpreadsheetApp.openById(props.getProperty(PROPS.DB));
    Logger.log('Setup already done.\nDatabase: ' + existing.getUrl());
    return;
  }

  var root = DriveApp.createFolder(APP_NAME);
  var tpl = root.createFolder('Templates');
  var out = root.createFolder('Quotations');

  var ss = SpreadsheetApp.create(APP_NAME + ' Database');
  DriveApp.getFileById(ss.getId()).moveTo(root);
  ss.setSpreadsheetTimeZone('Asia/Kolkata');

  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.insertSheet(name);
    var head = HEADERS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#E7EFE9');
    sh.setFrozenRows(1);
  });
  ss.deleteSheet(ss.getSheetByName('Sheet1'));

  // Keep phone / GSTIN columns as plain text so leading zeros survive
  ss.getSheetByName(T.CONTACTS).getRange('E:E').setNumberFormat('@'); // Phone
  ss.getSheetByName(T.CUSTOMERS).getRange('H:H').setNumberFormat('@'); // GSTIN

  // Seed settings
  var st = ss.getSheetByName(T.SETTINGS);
  [
    ['STAGES', DEFAULTS.STAGES.join(' | ')],
    ['OUTCOMES', DEFAULTS.OUTCOMES.join(' | ')],
    ['QUOTE_STATUSES', DEFAULTS.QUOTE_STATUSES.join(' | ')],
    ['SOURCES', DEFAULTS.SOURCES.join(' | ')],
    ['TAGS', DEFAULTS.TAGS.join(' | ')],
    ['TYPES', DEFAULTS.TYPES.join(' | ')],
    ['PRIORITIES', DEFAULTS.PRIORITIES.join(' | ')],
    ['CATEGORIES', DEFAULTS.CATEGORIES.join(' | ')],
    ['ROLES', DEFAULTS.ROLES.join(' | ')],
    ['TAX_PCT', DEFAULTS.TAX_PCT],
    ['CURRENCY', DEFAULTS.CURRENCY],
    ['COMPANY', DEFAULTS.COMPANY]
  ].forEach(function (r) { st.appendRow(r); });

  // Owner becomes the first L6 (full admin)
  var me = Session.getEffectiveUser().getEmail();
  ss.getSheetByName(T.USERS).appendRow([me, 'Administrator', 'L6', '*', true, nowStamp_(), 'setup']);

  createStarterTemplate_(tpl);

  props.setProperties({
    CRM_DB_ID: ss.getId(),
    CRM_ROOT_FOLDER: root.getId(),
    CRM_TEMPLATES_FOLDER: tpl.getId(),
    CRM_QUOTES_FOLDER: out.getId()
  });

  Logger.log('Setup complete.\nDatabase: ' + ss.getUrl() + '\nCRM folder: ' + root.getUrl() + '\nNext: Deploy > New deployment > Web app (Execute as Me, access: Anyone within your domain).');
}

function createStarterTemplate_(folder) {
  var doc = DocumentApp.create('Quotation Template – Standard');
  var body = doc.getBody();
  body.clear();

  var h = body.appendParagraph('{{COMPANY}}');
  h.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Industrial Automation | Control & Distribution Panels | Energy Management').setItalic(true).setFontSize(9);
  body.appendParagraph('').setItalic(false);

  body.appendParagraph('QUOTATION').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('Quote No: {{QUOTE_NO}}    Rev: {{REV}}    Date: {{DATE}}').setBold(true).setFontSize(10);
  body.appendParagraph('');
  body.appendParagraph('To: {{CUSTOMER_NAME}}').setBold(true);
  body.appendParagraph('{{CUSTOMER_ADDRESS}}');
  body.appendParagraph('Kind Attn: {{CONTACT_NAME}}');
  body.appendParagraph('');
  body.appendParagraph('Subject: {{TITLE}}').setBold(true);
  body.appendParagraph('');
  body.appendParagraph('Dear Sir / Madam,');
  body.appendParagraph('Thank you for your enquiry. We are pleased to submit our offer as per the details below.');
  body.appendParagraph('');
  body.appendParagraph('{{BOQ_TABLE}}');
  body.appendParagraph('');
  body.appendParagraph('Notes: {{NOTES}}');
  body.appendParagraph('');
  body.appendParagraph('Terms & Conditions').setBold(true);
  body.appendParagraph('Prices: In {{CURRENCY}}, ex-works Ludhiana unless stated otherwise.');
  body.appendParagraph('Taxes: GST @ {{TAX_PCT}}% included as shown above.');
  body.appendParagraph('Validity: This offer is valid until {{VALID_UNTIL}}.');
  body.appendParagraph('Delivery & payment: As mutually agreed at the time of order.');
  body.appendParagraph('');
  body.appendParagraph('We look forward to your valued order.');
  body.appendParagraph('');
  body.appendParagraph('For {{COMPANY}}').setBold(true);
  body.appendParagraph('{{PREPARED_BY}}');

  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  return doc.getId();
}

/* ================================================================
 * WEB APP ENTRY
 * ================================================================ */

function doGet() {
  var boot;
  try {
    var u = me_();
    boot = { ok: true, email: u.Email };
  } catch (e) {
    boot = { ok: false, email: currentEmail_(), reason: String(e && e.message || e) };
  }
  var t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify(boot);
  return t.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ================================================================
 * CORE HELPERS  (with per-execution memoisation for speed)
 * ================================================================ */

var _SS = null;          // memoised spreadsheet handle for this execution
var _SHEETS = {};        // memoised sheet handles
var _HEAD = {};          // memoised header rows

function db_() {
  if (_SS) return _SS;
  var id = PropertiesService.getScriptProperties().getProperty(PROPS.DB);
  if (!id) throw new Error('Setup pending: open the Apps Script editor and run setupCRM() once.');
  _SS = SpreadsheetApp.openById(id);
  return _SS;
}
function sh_(name) {
  if (_SHEETS[name]) return _SHEETS[name];
  _SHEETS[name] = db_().getSheetByName(name);
  return _SHEETS[name];
}
function head_(name) {
  if (_HEAD[name]) return _HEAD[name];
  var sh = sh_(name);
  _HEAD[name] = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  return _HEAD[name];
}

var _ROWS = {};
function rows_(name) {
  if (_ROWS[name]) return _ROWS[name];
  var sh = sh_(name);
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) { _ROWS[name] = []; return []; }
  var head = vals[0], out = [];
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === '') continue;
    var o = { _row: i + 1 };
    for (var j = 0; j < head.length; j++) o[head[j]] = vals[i][j];
    out.push(o);
  }
  _ROWS[name] = out;
  return out;
}

// Read only the last n data rows (used for the activity feed so it stays fast as the log grows)
function tailRows_(name, n) {
  var sh = sh_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var head = head_(name);
  var start = Math.max(2, last - n + 1);
  var count = last - start + 1;
  var vals = sh.getRange(start, 1, count, head.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === '') continue;
    var o = {};
    for (var j = 0; j < head.length; j++) o[head[j]] = vals[i][j];
    out.push(o);
  }
  return out;
}

function deleteRowsWhere_(name, pred) {
  var sh = sh_(name);
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return 0;
  var head = vals[0], del = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {};
    for (var j = 0; j < head.length; j++) o[head[j]] = vals[i][j];
    if (pred(o)) del.push(i + 1);
  }
  del.sort(function (a, b) { return b - a; });
  del.forEach(function (r) { sh.deleteRow(r); });
  _ROWS[name] = null;
  return del.length;
}
function append_(name, obj) {
  var head = head_(name);
  sh_(name).appendRow(head.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
  _ROWS[name] = null;
}

/**
 * Write several fields of a row in ONE Sheets call where possible.
 * (Previously one setValue() per field — a 6-field update cost 6 round trips.)
 * Contiguous columns => 1 call. Scattered columns => 1 read + 1 write.
 */
function setCells_(name, row, obj) {
  var sh = sh_(name);
  var head = head_(name);
  var cols = [];
  head.forEach(function (h, j) {
    if (Object.prototype.hasOwnProperty.call(obj, h)) cols.push(j);
  });
  if (!cols.length) return;
  if (cols.length === 1) {
    sh.getRange(row, cols[0] + 1).setValue(obj[head[cols[0]]]);
    _ROWS[name] = null;
    return;
  }
  var min = Math.min.apply(null, cols), max = Math.max.apply(null, cols);
  var span = max - min + 1;
  var vals;
  if (span === cols.length) {
    vals = [];
    for (var j = min; j <= max; j++) vals.push(obj[head[j]]);
  } else {
    vals = sh.getRange(row, min + 1, 1, span).getValues()[0];
    cols.forEach(function (j) { vals[j - min] = obj[head[j]]; });
  }
  sh.getRange(row, min + 1, 1, span).setValues([vals]);
  _ROWS[name] = null;
}

function tz_() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }
function nowStamp_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'); }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'dd-MMM-yyyy'); }
function ymNow_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM'); }
function low_(v) { return String(v === null || v === undefined ? '' : v).toLowerCase().trim(); }
function isTrue_(v) { return v === true || low_(v) === 'true' || low_(v) === 'yes'; }
function parseList_(v) {
  return String(v === null || v === undefined ? '' : v)
    .split(/[|,]/).map(function (s) { return s.trim(); }).filter(Boolean);
}
// Pipe-only splitter — for values that may themselves contain commas (categories, emails)
function parsePipe_(v) {
  return String(v === null || v === undefined ? '' : v)
    .split('|').map(function (s) { return s.trim(); }).filter(Boolean);
}
function joinPipe_(arr) { return (arr || []).join(' | '); }
function r2_(n) { return Math.round(Number(n || 0) * 100) / 100; }
function pad_(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

// Days between a stored 'yyyy-MM-dd HH:mm' stamp and now (positive = in the past)
function daysAgo_(stamp) {
  var s = String(stamp || '').trim(); if (!s) return 1e9;
  var d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) return 1e9;
  return (Date.now() - d.getTime()) / 86400000;
}

function nextId_(key) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = sh_(T.COUNTERS);
    var vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      if (vals[i][0] === key) {
        var n = Number(vals[i][1]) + 1;
        sh.getRange(i + 1, 2).setValue(n);
        return n;
      }
    }
    sh.appendRow([key, 1]);
    return 1;
  } finally {
    lock.releaseLock();
  }
}

function log_(action, entity, customerId, details) {
  try {
    sh_(T.LOG).appendRow([nowStamp_(), currentEmail_(), action, entity || '', customerId || '', details || '']);
  } catch (e) { /* logging must never break the request */ }
}

// Recursively make values safe to send to the browser
function out_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  if (Array.isArray(v)) return v.map(out_);
  if (typeof v === 'object') {
    var o = {};
    for (var k in v) if (k !== '_row' && Object.prototype.hasOwnProperty.call(v, k)) o[k] = out_(v[k]);
    return o;
  }
  return v;
}

/* ---------------- lightweight cache ---------------- */
function cacheGet_(key) {
  try { var c = CacheService.getScriptCache().get(key); return c ? JSON.parse(c) : null; }
  catch (e) { return null; }
}
function cacheSet_(key, obj, sec) {
  try { var s = JSON.stringify(obj); if (s.length < 95000) CacheService.getScriptCache().put(key, s, sec || 300); }
  catch (e) { /* ignore */ }
}
function cacheDel_(key) { try { CacheService.getScriptCache().remove(key); } catch (e) { } }

/* ================================================================
 * AUTH & PERMISSION LEVELS
 * ================================================================ */

function currentEmail_() { return low_(Session.getActiveUser().getEmail()); }

function me_() {
  var e = currentEmail_();
  if (!e) throw new Error('Could not identify your Google account. The app must be deployed with access "Anyone within your domain", and you must be signed into your work account.');
  var u = rows_(T.USERS).filter(function (x) { return low_(x.Email) === e; })[0];
  if (!u || !isTrue_(u.Active)) throw new Error('NOT_REGISTERED: You are signed in as ' + e + ' but have not been added to the CRM yet. Ask your administrator to add you.');
  u.Email = e;
  u.allowedTags = parseList_(u.AllowedTags);
  u.level = lvl_(u);
  return u;
}

// Map a role string to a numeric level. Understands L1..L6 and legacy Admin/Manager/Sales.
function lvl_(u) {
  var r = String(u && u.Role || '').trim();
  var m = r.match(/([1-6])/);
  if (m) return Number(m[1]);
  var lc = r.toLowerCase();
  if (lc === 'admin') return 6;
  if (lc === 'manager') return 4;
  if (lc === 'sales') return 2;
  return 1;
}
function requireLevel_(u, n) {
  if (lvl_(u) < n) throw new Error('Your access level (L' + lvl_(u) + ') does not allow this. It needs L' + n + ' or higher.');
}
function seesAll_(u) { return lvl_(u) >= 4; }
// L2..L4 get a personal sales performance dashboard. L5/L6 are back-office (no perf dashboard).
function hasPerfDash_(u) { var l = lvl_(u); return l >= 2 && l <= 4; }

/* ---------------- access context (built once per request) ---------------- */
function context_(u) {
  var ctx = { hMap: {}, ownSet: {}, idx: {} };
  rows_(T.HANDLERS).forEach(function (h) {
    var k = String(h.CustomerID).trim();
    (ctx.hMap[k] = ctx.hMap[k] || []).push(low_(h.UserEmail));
  });
  // NOTE: the opportunity-ticket assignee is deliberately NOT granted customer access here.
  // A ticket-holder can see and work the case (caseVisible_) but cannot open the customer.
  rows_(T.USERS).forEach(function (x) {
    ctx.idx[low_(x.Email)] = { name: x.Name, role: x.Role, level: lvl_(x), active: isTrue_(x.Active), tags: parseList_(x.AllowedTags) };
  });
  return ctx;
}

// FULL = may see contact details & everything; NAME = name + tags only
/**
 * How much of a customer a user may see.
 *   FULL — open the record: contacts, cases, quotations, edits.
 *   NAME — the customer appears in search (name/tag/type/handlers) but cannot be opened.
 *   NONE — the customer is not visible at all.
 *
 * Tags grant VISIBILITY; being an account handler grants ACCESS.
 *   L4+        : FULL on everything.
 *   L3         : FULL within their tags, NAME outside them.
 *   L2 (Sales) : FULL only where they are a handler (or hold a case/ticket on the customer).
 *                Within their tags they see the customer in search (NAME) and can ask a handler
 *                to add them. Outside their tags the customer is invisible (NONE).
 *   L1         : NONE — no customer browsing at all.
 */
function accessLevel_(u, cust, ctx) {
  if (seesAll_(u)) return 'FULL';
  var lv = lvl_(u);
  var id = String(cust.CustomerID).trim();

  var hs = ctx.hMap[id] || [];
  if (hs.indexOf(u.Email) > -1) return 'FULL';          // account handler

  var match = u.allowedTags.indexOf('*') > -1;
  if (!match) {
    var tags = parseList_(cust.Tags);
    for (var i = 0; i < tags.length; i++) {
      if (u.allowedTags.indexOf(tags[i]) > -1) { match = true; break; }
    }
  }

  if (lv >= 3) return match ? 'FULL' : 'NAME';
  if (lv === 2) return match ? 'NAME' : 'NONE';
  return 'NONE';
}

function usersIndex_() {
  var m = {};
  rows_(T.USERS).forEach(function (u) {
    m[low_(u.Email)] = { name: u.Name, role: u.Role, level: lvl_(u), active: isTrue_(u.Active) };
  });
  return m;
}
function nameOf_(idx, email) {
  if (low_(email) === 'direct') return 'Direct';
  var u = idx[low_(email)];
  return u ? u.name : String(email || '');
}

function findCustomer_(id) {
  var c = rows_(T.CUSTOMERS).filter(function (x) { return x.CustomerID === id; })[0];
  if (!c) throw new Error('Customer ' + id + ' was not found.');
  return c;
}
function ensureFull_(u, custId, ctx) {
  ctx = ctx || context_(u);
  var c = findCustomer_(custId);
  if (accessLevel_(u, c, ctx) !== 'FULL') {
    throw new Error('You are not an account handler for this customer, so you cannot open its details. Ask one of its handlers (or an L3+ user) to add you as a handler.');
  }
  return c;
}

/* ---------------- settings (cached) ---------------- */
function settings_() {
  var c = cacheGet_('settings_v3');
  if (c) return c;
  var m = {};
  rows_(T.SETTINGS).forEach(function (r) { m[r.Key] = String(r.Value); });
  var s = {
    stages: parseList_(m.STAGES).length ? parseList_(m.STAGES) : DEFAULTS.STAGES,
    outcomes: parseList_(m.OUTCOMES).length ? parseList_(m.OUTCOMES) : DEFAULTS.OUTCOMES,
    quoteStatuses: parseList_(m.QUOTE_STATUSES).length ? parseList_(m.QUOTE_STATUSES) : DEFAULTS.QUOTE_STATUSES,
    sources: parseList_(m.SOURCES),
    tags: parseList_(m.TAGS).length ? parseList_(m.TAGS) : DEFAULTS.TAGS,
    types: parseList_(m.TYPES).length ? parseList_(m.TYPES) : DEFAULTS.TYPES,
    priorities: parseList_(m.PRIORITIES).length ? parseList_(m.PRIORITIES) : DEFAULTS.PRIORITIES,
    categories: parsePipe_(m.CATEGORIES).length ? parsePipe_(m.CATEGORIES) : DEFAULTS.CATEGORIES,
    roles: DEFAULTS.ROLES,
    taxPct: Number(m.TAX_PCT || 18),
    currency: m.CURRENCY || 'INR',
    company: m.COMPANY || '',
    domain: EMAIL_DOMAIN
  };
  cacheSet_('settings_v3', s, 600);
  return s;
}
function setSetting_(key, value) {
  var sh = sh_(T.SETTINGS);
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (vals[i][0] === key) { sh.getRange(i + 1, 2).setValue(value); cacheDel_('settings_v3'); return; }
  }
  sh.appendRow([key, value]);
  cacheDel_('settings_v3');
}

/* ---------------- customer index (cached, for fast search) ---------------- */
function customerIndex_() {
  var c = cacheGet_('custIndex_v3');
  if (c) return c;
  var list = rows_(T.CUSTOMERS).map(function (x) {
    return {
      id: x.CustomerID, name: x.Name, tags: parseList_(x.Tags), type: x.Type, priority: x.Priority,
      area: x.Area, status: x.Status
    };
  });
  cacheSet_('custIndex_v3', list, 120);
  return list;
}
function clearCustIndex_() { cacheDel_('custIndex_v3'); }

/* ================================================================
 * BOOTSTRAP + DASHBOARDS
 * ================================================================ */

function api_bootstrap() {
  var u = me_();
  var s = settings_();
  var ctx = context_(u);
  var level = lvl_(u);

  var nav = { admin: level >= 6 };
  var backend = !hasPerfDash_(u);  // L5/L6 — no personal sales performance dashboard

  // Peers whose dashboard this user may view
  var peers = [];
  if (level >= 3) {
    rows_(T.USERS).forEach(function (x) {
      var e = low_(x.Email);
      if (e === u.Email || !isTrue_(x.Active)) return;
      var xl = lvl_(x);
      if (level >= 4) {
        peers.push({ email: e, name: x.Name, role: x.Role });
      } else { // L3 — only L2 sharing a tag
        if (xl !== 2) return;
        if (u.allowedTags.indexOf('*') > -1) { peers.push({ email: e, name: x.Name, role: x.Role }); return; }
        var xt = parseList_(x.AllowedTags);
        for (var i = 0; i < xt.length; i++) if (u.allowedTags.indexOf(xt[i]) > -1) { peers.push({ email: e, name: x.Name, role: x.Role }); break; }
      }
    });
    peers.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  }

  var self = (level <= 4) ? computeDash_(u, u.Email, ctx, s) : null;

  return out_({
    user: { email: u.Email, name: u.Name, role: u.Role, level: level },
    settings: s,
    nav: nav,
    isL1: level <= 1,
    isBackend: backend,
    peers: peers,
    self: self,
    recent: recentActivity_(u, ctx)
  });
}

/**
 * Everything the app needs, in ONE round trip: bootstrap + the customer grid + the case list.
 * Apps Script charges ~0.3-1s of fixed overhead per call, so three calls cost three times the
 * latency even though the underlying reads are memoised. Fetch once, navigate from memory.
 */
function api_workspace(caseFilter) {
  var boot = api_bootstrap();
  var out = { boot: boot, customers: null, cases: null };
  try { out.customers = api_myCustomers(); } catch (e) { out.customers = null; }
  try { out.cases = api_listCases(caseFilter || {}); } catch (e2) { out.cases = null; }
  return out;
}

// Save several inline grid edits in one call (the grid batches keystrokes client-side).
// patches: [{id, fields:{name, type, priority, city, state}}, ...]
function api_saveCustomerCells(patches) {
  me_();  // identity check
  var okIds = [], failed = [];
  (patches || []).forEach(function (p) {
    try {
      api_updateCustomer(p.id, p.fields || {});
      okIds.push(p.id);
    } catch (e) {
      failed.push({ id: p.id, error: String(e && e.message ? e.message : e) });
    }
  });
  return out_({ saved: okIds, failed: failed });
}

// View a teammate's dashboard (L3+)
function api_dashboard(forEmail) {
  var u = me_();
  var ctx = context_(u);
  var s = settings_();
  var target = low_(forEmail || u.Email);

  if (target !== u.Email) {
    requireLevel_(u, 3);
    var tu = ctx.idx[target];
    if (!tu || !tu.active) throw new Error('That user is not an active CRM user.');
    if (lvl_(u) < 4) {
      if (tu.level !== 2) throw new Error('At L3 you can only view the dashboards of L2 (Sales) users.');
      var ok = u.allowedTags.indexOf('*') > -1;
      if (!ok) for (var i = 0; i < tu.tags.length; i++) if (u.allowedTags.indexOf(tu.tags[i]) > -1) { ok = true; break; }
      if (!ok) throw new Error('You can only view dashboards of L2 users who share one of your tags.');
    }
  }
  var name = (ctx.idx[target] && ctx.idx[target].name) || target;
  var role = (ctx.idx[target] && ctx.idx[target].role) || '';
  return out_({ subject: { email: target, name: name, role: role }, dash: computeDash_(u, target, ctx, s) });
}

// Core stats for a subject user. ctx is the *viewer's* context but stats are about the subject.
function computeDash_(viewer, subjectEmail, ctx, s) {
  subjectEmail = low_(subjectEmail);
  var custName = {};
  customerIndex_().forEach(function (c) { custName[c.id] = c.name; });

  var cases = rows_(T.CASES);
  var openMine = [];     // subject's open cases (Outcome blank) — by ownership
  var myTickets = [];    // open cases the subject is currently working on (Assignee)
  var wonMonthV = 0, wonMonthC = 0, won2wV = 0, won2wC = 0;
  var subjectHandles = {};          // customers where subject is a handler
  Object.keys(ctx.hMap).forEach(function (cid) { if ((ctx.hMap[cid] || []).indexOf(subjectEmail) > -1) subjectHandles[cid] = true; });

  var ym = ymNow_();
  cases.forEach(function (o) {
    var mine = caseOwners_(o, ctx).indexOf(subjectEmail) > -1;   // subject is an account handler => a case owner
    var outcome = String(o.Outcome || '').trim();
    if (mine && !outcome) {
      openMine.push({ id: o.CaseID, title: o.Title, customerId: o.CustomerID, customerName: custName[o.CustomerID] || o.CustomerID, stage: o.Stage });
    }
    if (low_(o.Assignee) === subjectEmail && !outcome) {
      myTickets.push({ id: o.CaseID, title: o.Title, customerId: o.CustomerID, customerName: custName[o.CustomerID] || o.CustomerID, stage: o.Stage });
    }
    if (mine && outcome === 'Won') {
      var val = Number(o.OrderValue || 0) || 0;
      var closed = String(o.ClosedOn || '');
      if (closed.substring(0, 7) === ym) { wonMonthV += val; wonMonthC++; }
      if (daysAgo_(closed) <= 14) { won2wV += val; won2wC++; }
    }
  });

  // distinct customers the subject handles (ownership follows the account)
  var myCustSet = {};
  Object.keys(subjectHandles).forEach(function (k) { myCustSet[k] = true; });

  openMine.sort(function (a, b) { return a.title < b.title ? -1 : 1; });
  myTickets.sort(function (a, b) { return a.title < b.title ? -1 : 1; });

  return {
    stats: {
      myCustomers: Object.keys(myCustSet).length,
      openOpps: openMine.length,
      wonMonthValue: r2_(wonMonthV), wonMonthCount: wonMonthC,
      won2wValue: r2_(won2wV), won2wCount: won2wC
    },
    cases: openMine.slice(0, 60),
    tickets: myTickets.slice(0, 60)
  };
}

function recentActivity_(u, ctx) {
  var idx = ctx.idx;
  var level = lvl_(u);
  var rows = tailRows_(T.LOG, 250).reverse();
  var custTagFull = {};   // cache access decisions by customer id
  var out = [];
  for (var i = 0; i < rows.length && out.length < 14; i++) {
    var r = rows[i];
    var ok = level >= 4 || low_(r.Who) === u.Email;
    if (!ok && r.CustomerID) {
      if (custTagFull[r.CustomerID] === undefined) {
        try { custTagFull[r.CustomerID] = (accessLevel_(u, findCustomer_(r.CustomerID), ctx) === 'FULL'); }
        catch (e) { custTagFull[r.CustomerID] = false; }
      }
      ok = custTagFull[r.CustomerID];
    }
    if (!ok) continue;
    out.push({ when: r.When, who: nameOf_(idx, r.Who), action: r.Action, entity: r.Entity, details: r.Details });
  }
  return out;
}

/* ================================================================
 * CUSTOMERS
 * ================================================================ */

// Customers the signed-in user owns (handles) \u2014 powers the inline-editable grid. L4+ see all.
function contactCounts_() {
  var m = {};
  rows_(T.CONTACTS).forEach(function (k) { var id = String(k.CustomerID).trim(); m[id] = (m[id] || 0) + 1; });
  return m;
}
function custRow_(c, ctx, cc) {
  var idx = ctx.idx;
  var hs = ctx.hMap[String(c.CustomerID).trim()] || [];
  return {
    id: c.CustomerID, name: c.Name, tags: parseList_(c.Tags), type: c.Type,
    priority: c.Priority, area: c.Area, sei: c.SEI, remarks: c.Remarks,
    contacts: cc[String(c.CustomerID).trim()] || 0,
    handlers: hs.map(function (e) { return { email: e, name: nameOf_(idx, e) }; })
  };
}
function custMeta_(u, s) {
  return {
    canEditPriority: lvl_(u) >= 2,
    canEditClass: lvl_(u) >= 3,
    canDelete: lvl_(u) >= 3,
    tags: s.tags, types: s.types, priorities: s.priorities
  };
}
// L1-L4: the customers the signed-in user handles.
function api_myCustomers() {
  var u = me_();
  var ctx = context_(u);
  var s = settings_();
  var cc = contactCounts_();
  var me = u.Email, list = [];
  rows_(T.CUSTOMERS).forEach(function (c) {
    if (String(c.Status) === 'Archived') return;
    var hs = ctx.hMap[String(c.CustomerID).trim()] || [];
    if (hs.indexOf(me) === -1) return;
    list.push(custRow_(c, ctx, cc));
  });
  list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  var meta = custMeta_(u, s);
  meta.customers = list.slice(0, 400);
  meta.total = list.length;
  meta.scope = 'mine';
  return out_(meta);
}
// L4+ (used by L5/L6 back office): every customer. No cap — fetched only on explicit request.
function api_allCustomers() {
  var u = me_();
  requireLevel_(u, 4);
  var ctx = context_(u);
  var s = settings_();
  var cc = contactCounts_();
  var list = [];
  rows_(T.CUSTOMERS).forEach(function (c) {
    if (String(c.Status) === 'Archived') return;
    list.push(custRow_(c, ctx, cc));
  });
  list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  var meta = custMeta_(u, s);
  meta.customers = list;
  meta.total = list.length;
  meta.scope = 'all';
  return out_(meta);
}

// Soft-delete customers to the RecycleBin sheet. L3+. Customers with cases/quotations are skipped.
function api_deleteCustomers(ids) {
  var u = me_();
  requireLevel_(u, 3);
  var ctx = context_(u);
  ids = (ids || []).map(String);
  var custs = rows_(T.CUSTOMERS);
  var cases = rows_(T.CASES);
  var quotes = rows_(T.QUOTES);
  var binHead = head_(T.RECYCLE);
  var deleted = 0, skipped = [];
  ids.forEach(function (id) {
    var c = custs.filter(function (x) { return x.CustomerID === id; })[0];
    if (!c) { skipped.push({ name: id, reason: 'not found' }); return; }
    if (accessLevel_(u, c, ctx) !== 'FULL') { skipped.push({ name: c.Name, reason: 'no access' }); return; }
    var hasCase = cases.filter(function (o) { return o.CustomerID === id; }).length > 0;
    var hasQuote = quotes.filter(function (q) { return q.CustomerID === id; }).length > 0;
    if (hasCase || hasQuote) { skipped.push({ name: c.Name, reason: 'has cases/quotations' }); return; }
    var rec = {};
    binHead.forEach(function (h) { rec[h] = c[h] !== undefined ? c[h] : ''; });
    rec.DeletedBy = u.Email; rec.DeletedOn = nowStamp_();
    append_(T.RECYCLE, rec);
    deleteRowsWhere_(T.CONTACTS, function (x) { return x.CustomerID === id; });
    deleteRowsWhere_(T.HANDLERS, function (x) { return x.CustomerID === id; });
    deleteRowsWhere_(T.CUSTOMERS, function (x) { return x.CustomerID === id; });
    log_('CUSTOMER_DELETE', id, id, c.Name);
    deleted++;
  });
  clearCustIndex_();
  return out_({ deleted: deleted, skipped: skipped });
}

function api_searchCustomers(q) {
  var u = me_();
  requireLevel_(u, 2);  // L1 cannot browse the customer base
  q = low_(q);
  var ctx = context_(u);
  var idx = ctx.idx;
  var all = customerIndex_().filter(function (c) { return low_(c.status) !== 'archived'; });

  if (!q && lvl_(u) < 4) throw new Error('Type at least 2 characters to search customers.');
  if (q && q.length < 2) throw new Error('Type at least 2 characters to search customers.');

  var list = q
    ? all.filter(function (c) {
        var hay = low_(c.name) + ' ' + (c.tags || []).join(' ').toLowerCase() + ' ' + low_(c.area) + ' ' + low_(c.type);
        return hay.indexOf(q) > -1;
      })
    : all;

  list.sort(function (a, b) { return low_(a.name) < low_(b.name) ? -1 : 1; });

  var visible = [];
  for (var k = 0; k < list.length && visible.length < 80; k++) {
    var c = list[k];
    var cust = { CustomerID: c.id, Tags: (c.tags || []).join(', '), Status: c.status };
    var a = accessLevel_(u, cust, ctx);
    if (a === 'NONE') continue;                        // outside their tags — not shown at all
    var handlerNames = (ctx.hMap[String(c.id).trim()] || []).map(function (e) { return nameOf_(idx, e); });
    var base = { id: c.id, name: c.name, tags: c.tags, type: c.type, priority: c.priority, handlers: handlerNames, access: a };
    if (a === 'FULL') { base.area = c.area; }
    visible.push(base);
  }
  return out_(visible);
}

function api_getCustomer(id) {
  var u = me_();
  var c = findCustomer_(id);
  var ctx = context_(u);
  var idx = ctx.idx;
  var a = accessLevel_(u, c, ctx);
  if (a === 'NONE') throw new Error('You do not have access to this customer.');
  var handlers = (ctx.hMap[id] || []).map(function (e) { return { email: e, name: nameOf_(idx, e) }; });

  if (a !== 'FULL') {
    return out_({
      access: 'NAME',
      customer: { id: c.CustomerID, name: c.Name, tags: parseList_(c.Tags), type: c.Type, priority: c.Priority },
      handlers: handlers
    });
  }

  var contacts = rows_(T.CONTACTS).filter(function (x) { return x.CustomerID === id; })
    .map(function (x) { return { id: x.ContactID, name: x.Name, designation: x.Designation, phone: x.Phone, email: x.Email, notes: x.Notes }; });

  var cases = rows_(T.CASES).filter(function (o) { return o.CustomerID === id; })
    .sort(function (a1, b1) { return String(out_(b1.UpdatedOn)) < String(out_(a1.UpdatedOn)) ? -1 : 1; });

  var quotes = rows_(T.QUOTES).filter(function (qx) { return qx.CustomerID === id; });
  var quoteCountByCase = {};
  quotes.forEach(function (qx) { quoteCountByCase[qx.CaseID] = (quoteCountByCase[qx.CaseID] || 0) + 1; });
  var qvc = quotedValueMap_();

  var latest = {};
  quotes.forEach(function (qx) {
    var k = qx.QuoteNo;
    if (!latest[k] || Number(qx.Rev) > Number(latest[k].Rev)) latest[k] = qx;
  });
  var quoteList = Object.keys(latest).map(function (k) {
    var qx = latest[k];
    return { quoteNo: qx.QuoteNo, rev: Number(qx.Rev), title: qx.Title, total: qx.Total, currency: qx.Currency, status: qx.Status, date: qx.CreatedOn, caseId: qx.CaseID, pdf: qx.PdfLink };
  }).sort(function (a2, b2) { return a2.quoteNo < b2.quoteNo ? 1 : -1; });

  return out_({
    access: 'FULL',
    canEditTags: lvl_(u) >= 3,
    canEditPriority: lvl_(u) >= 2,
    customer: {
      id: c.CustomerID, name: c.Name, tags: parseList_(c.Tags), type: c.Type, priority: c.Priority,
      area: c.Area, address: c.Address, gstin: c.GSTIN,
      website: c.Website, notes: c.Notes, sei: c.SEI, remarks: c.Remarks, status: c.Status,
      createdBy: nameOf_(idx, c.CreatedBy), createdOn: c.CreatedOn
    },
    handlers: handlers,
    contacts: contacts,
    cases: cases.map(function (o) {
      return { id: o.CaseID, title: o.Title, stage: o.Stage, outcome: String(o.Outcome || ''), orderValue: o.OrderValue, quotedValue: (qvc[o.CaseID] !== undefined ? qvc[o.CaseID] : ''), owners: ownerNames_(o, ctx), assignee: String(o.Outcome || '') ? '' : (o.Assignee ? nameOf_(idx, o.Assignee) : ''), updatedOn: o.UpdatedOn, quotes: quoteCountByCase[o.CaseID] || 0 };
    }),
    quotes: quoteList
  });
}

function validTag_(s, t) { return s.tags.indexOf(t) > -1 ? t : ''; }
function validType_(s, t) { return s.types.indexOf(t) > -1 ? t : ''; }
function validPri_(s, t) { return s.priorities.indexOf(t) > -1 ? t : ''; }

function api_createCustomer(d) {
  var u = me_();
  requireLevel_(u, 2);
  var s = settings_();
  var name = String(d && d.name || '').trim();
  if (!name) throw new Error('Customer name is required.');

  var dup = customerIndex_().filter(function (c) { return low_(c.name) === low_(name); })[0];
  if (dup && !d.force) {
    throw new Error('DUPLICATE: A customer named "' + dup.name + '" already exists (' + dup.id + '). Save again to create anyway.');
  }

  var tags = parseList_(d.tags).filter(function (t) { return s.tags.indexOf(t) > -1; });
  var id = 'CUST-' + pad_(nextId_('CUST'), 4);
  append_(T.CUSTOMERS, {
    CustomerID: id, Name: name, Tags: tags.join(', '),
    Type: validType_(s, d.type), Priority: validPri_(s, d.priority),
    Area: d.area || '', Address: d.address || '',
    GSTIN: d.gstin || '', Website: d.website || '', Notes: d.notes || '',
    SEI: d.sei || '', Remarks: d.remarks || '',
    Status: 'Active', CreatedBy: u.Email, CreatedOn: nowStamp_(), UpdatedOn: nowStamp_()
  });
  // L5/L6 do not own accounts, so a customer they create is left unassigned (handler = 'Direct') until a real user is added.
  var firstHandler = (lvl_(u) >= 5) ? 'Direct' : u.Email;
  append_(T.HANDLERS, { CustomerID: id, UserEmail: firstHandler, AssignedBy: 'self (creator)', AssignedOn: nowStamp_() });
  clearCustIndex_();

  if (d.contact && String(d.contact.name || '').trim()) addContactRow_(u, id, d.contact);
  log_('CUSTOMER_NEW', id, id, name);
  return out_({ id: id });
}

function api_updateCustomer(id, d) {
  var u = me_();
  var ctx = context_(u);
  var c = ensureFull_(u, id, ctx);
  var s = settings_();
  var upd = { UpdatedOn: nowStamp_() };
  ['Area', 'Address', 'GSTIN', 'Website', 'Notes', 'SEI', 'Remarks'].forEach(function (k) {
    var lk = k.toLowerCase();
    if (d[lk] !== undefined) upd[k] = d[lk];
  });
  if (d.name !== undefined) {
    if (!String(d.name).trim()) throw new Error('Customer name cannot be empty.');
    upd.Name = String(d.name).trim();
  }
  // Priority is editable at L2+
  if (d.priority !== undefined) {
    if (lvl_(u) < 2) throw new Error('Priority can be changed at L2 or higher.');
    upd.Priority = validPri_(s, d.priority);
  }
  // Tag / Type / archive are classification fields — L3+ only
  var wantsClass = (d.tags !== undefined || d.type !== undefined || d.status !== undefined);
  if (wantsClass) {
    if (lvl_(u) < 3) throw new Error('Tags, type and archive status can only be changed at L3 or higher.');
    if (d.tags !== undefined) upd.Tags = parseList_(d.tags).filter(function (t) { return s.tags.indexOf(t) > -1; }).join(', ');
    if (d.type !== undefined) upd.Type = validType_(s, d.type);
    if (d.status !== undefined) upd.Status = d.status === 'Archived' ? 'Archived' : 'Active';
  }
  setCells_(T.CUSTOMERS, c._row, upd);
  clearCustIndex_();
  log_('CUSTOMER_EDIT', id, id, upd.Name || c.Name);
  return out_({ ok: true });
}

// Bulk create customers from pasted rows. rows: [{name,tag,type,priority,city}]
function api_bulkCustomers(rows) {
  var u = me_();
  requireLevel_(u, 2);
  var s = settings_();
  if (!rows || !rows.length) throw new Error('Nothing to import — add at least one row.');
  if (rows.length > 500) throw new Error('Please import at most 500 customers at a time.');

  var existing = {};
  customerIndex_().forEach(function (c) { existing[low_(c.name)] = c.id; });

  var created = 0, skipped = [];
  rows.forEach(function (r) {
    var name = String(r.name || '').trim();
    if (!name) return;
    if (existing[low_(name)]) { skipped.push(name); return; }
    var id = 'CUST-' + pad_(nextId_('CUST'), 4);
    append_(T.CUSTOMERS, {
      CustomerID: id, Name: name,
      Tags: validTag_(s, String(r.tag || '').trim()),
      Type: validType_(s, String(r.type || '').trim()),
      Priority: validPri_(s, String(r.priority || '').trim()),
      Area: r.area || '', Address: r.address || '',
      GSTIN: r.gstin || '', Website: '', Notes: '', Status: 'Active',
      CreatedBy: u.Email, CreatedOn: nowStamp_(), UpdatedOn: nowStamp_()
    });
    append_(T.HANDLERS, { CustomerID: id, UserEmail: u.Email, AssignedBy: 'bulk (creator)', AssignedOn: nowStamp_() });
    existing[low_(name)] = id;
    created++;
  });
  clearCustIndex_();
  log_('BULK_CUSTOMERS', '', '', created + ' created, ' + skipped.length + ' skipped');
  return out_({ created: created, skipped: skipped });
}

/* ---------------- Contacts ---------------- */

function addContactRow_(u, custId, d) {
  var cid = 'CT-' + pad_(nextId_('CT'), 4);
  append_(T.CONTACTS, {
    ContactID: cid, CustomerID: custId, Name: String(d.name || '').trim(),
    Designation: d.designation || '', Phone: String(d.phone || ''), Email: d.email || '',
    Notes: d.notes || '', CreatedBy: u.Email, CreatedOn: nowStamp_()
  });
  return cid;
}

function api_addContact(custId, d) {
  var u = me_();
  ensureFull_(u, custId);
  if (!String(d && d.name || '').trim()) throw new Error('Contact name is required.');
  var cid = addContactRow_(u, custId, d);
  log_('CONTACT_NEW', cid, custId, d.name);
  return out_({ id: cid });
}

function api_updateContact(contactId, d) {
  var u = me_();
  var ct = rows_(T.CONTACTS).filter(function (x) { return x.ContactID === contactId; })[0];
  if (!ct) throw new Error('Contact not found.');
  ensureFull_(u, ct.CustomerID);
  setCells_(T.CONTACTS, ct._row, {
    Name: d.name !== undefined ? d.name : ct.Name,
    Designation: d.designation !== undefined ? d.designation : ct.Designation,
    Phone: d.phone !== undefined ? String(d.phone) : ct.Phone,
    Email: d.email !== undefined ? d.email : ct.Email,
    Notes: d.notes !== undefined ? d.notes : ct.Notes
  });
  log_('CONTACT_EDIT', contactId, ct.CustomerID, d.name || ct.Name);
  return out_({ ok: true });
}

function api_deleteContact(contactId) {
  var u = me_();
  var ct = rows_(T.CONTACTS).filter(function (x) { return x.ContactID === contactId; })[0];
  if (!ct) throw new Error('Contact not found.');
  ensureFull_(u, ct.CustomerID);
  sh_(T.CONTACTS).deleteRow(ct._row);
  log_('CONTACT_DELETE', contactId, ct.CustomerID, ct.Name);
  return out_({ ok: true });
}

// Bulk add contacts to one customer. rows: [{name,designation,phone,email}]
function api_bulkContacts(custId, rows) {
  var u = me_();
  ensureFull_(u, custId);
  if (!rows || !rows.length) throw new Error('Nothing to add — paste at least one contact.');
  var created = 0;
  rows.forEach(function (r) {
    if (!String(r.name || '').trim()) return;
    addContactRow_(u, custId, r);
    created++;
  });
  log_('BULK_CONTACTS', custId, custId, created + ' contacts added');
  return out_({ created: created });
}

/* ---------------- Account handlers ---------------- */

function api_addHandler(custId, email) {
  var u = me_();
  var ctx = context_(u);
  var c = findCustomer_(custId);
  var existing = ctx.hMap[custId] || [];
  var canAssign = lvl_(u) >= 3 || existing.indexOf(u.Email) > -1;
  if (!canAssign) throw new Error('Only an existing handler, or L3+, can add account handlers.');

  email = expandEmail_(email);
  if (!ctx.idx[email] || !ctx.idx[email].active) throw new Error('That email is not an active CRM user. Add them under Admin > Users first.');
  deleteRowsWhere_(T.HANDLERS, function (h) { return String(h.CustomerID).trim() === String(custId).trim() && low_(h.UserEmail) === 'direct'; });
  if (existing.indexOf(email) > -1) throw new Error(nameOf_(ctx.idx, email) + ' is already a handler for this customer.');

  append_(T.HANDLERS, { CustomerID: custId, UserEmail: email, AssignedBy: u.Email, AssignedOn: nowStamp_() });
  log_('HANDLER_ADD', custId, custId, nameOf_(ctx.idx, email) + ' added to ' + c.Name);
  return out_({ ok: true });
}

function api_removeHandler(custId, email) {
  var u = me_();
  var ctx = context_(u);
  var existing = ctx.hMap[custId] || [];
  var canAssign = lvl_(u) >= 3 || existing.indexOf(u.Email) > -1;
  if (!canAssign) throw new Error('Only an existing handler, or L3+, can remove account handlers.');
  email = low_(email);
  var h = rows_(T.HANDLERS).filter(function (x) { return x.CustomerID === custId && low_(x.UserEmail) === email; })[0];
  if (!h) throw new Error('That user is not a handler for this customer.');
  sh_(T.HANDLERS).deleteRow(h._row);
  log_('HANDLER_REMOVE', custId, custId, email);
  return out_({ ok: true });
}

/* ---------------- assignable users (for owner / action pickers) ---------------- */
function api_listAssignableUsers() {
  var u = me_();
  requireLevel_(u, 1);
  return out_(rows_(T.USERS).filter(function (x) { return isTrue_(x.Active); })
    .map(function (x) { return { email: low_(x.Email), name: x.Name, role: x.Role }; })
    .sort(function (a, b) { return a.name < b.name ? -1 : 1; }));
}

/* ================================================================
 * CASES  (Lead → Opportunity → Quoted; outcome Won / Lost / Hold)
 * ================================================================ */

function findCase_(id) {
  var o = rows_(T.CASES).filter(function (x) { return x.CaseID === id; })[0];
  if (!o) throw new Error('Case ' + id + ' was not found.');
  return o;
}

/**
 * The owners of a case are the ACCOUNT HANDLERS of its customer — ownership follows the
 * account, so handlers share credit for won orders. Falls back to the stored Owner
 * (the creator) if the customer somehow has no handlers.
 */
// Owners = the customer's account handlers (mandatory) PLUS any extra owners added for this case.
// Handlers cannot be removed as owners; extras can.
function caseHandlerOwners_(o, ctx) {
  var hs = (ctx.hMap[String(o.CustomerID).trim()] || []).slice()
    .filter(function (e) { return e !== 'direct'; });
  if (!hs.length) { var fb = low_(o.Owner); if (fb && fb !== 'direct') hs = [fb]; }
  return hs;
}
function caseExtraOwners_(o) {
  return parsePipe_(o.ExtraOwners).map(low_).filter(Boolean);
}
function caseOwners_(o, ctx) {
  var out = caseHandlerOwners_(o, ctx).slice();
  caseExtraOwners_(o).forEach(function (e) { if (out.indexOf(e) === -1) out.push(e); });
  return out;
}
function ownerNames_(o, ctx) {
  return caseOwners_(o, ctx).map(function (e) { return nameOf_(ctx.idx, e); });
}

function caseVisible_(u, o, ctx) {
  if (seesAll_(u)) return true;
  if (caseOwners_(o, ctx).indexOf(u.Email) > -1) return true;
  if (low_(o.Assignee) === u.Email) return true;
  var c;
  try { c = findCustomer_(o.CustomerID); } catch (e) { return false; }
  return accessLevel_(u, c, ctx) === 'FULL';
}

// Resolve an owner email from input, defaulting to the creator. Reassigning to others needs L2+.
function expandEmail_(v) {
  var x = String(v == null ? '' : v).trim().toLowerCase();
  if (!x) return '';
  return x.indexOf('@') > -1 ? x : (x + '@' + EMAIL_DOMAIN);
}
function resolveUser_(ctx, who) {
  var e = expandEmail_(who);
  if (!e) throw new Error('Pick a user to assign the ticket to.');
  if (!ctx.idx[e] || !ctx.idx[e].active) throw new Error(e + ' is not an active CRM user.');
  return e;
}

function createCaseRow_(u, ctx, custId, d, assigneeEmail) {
  var s = settings_();
  var yr = new Date().getFullYear();
  var id = 'CASE-' + yr + '-' + pad_(nextId_('CASE-' + yr), 4);
  var stage = (d.stage && s.stages.indexOf(d.stage) > -1) ? d.stage : s.stages[0];
  var outcome = '', orderValue = '', wonCats = '', closedOn = '';
  if (d.order) {  // "add order directly" — create as a Won case
    stage = 'Quoted';
    outcome = 'Won';
    orderValue = (d.orderValue !== undefined && d.orderValue !== '') ? Number(d.orderValue) : '';
    wonCats = joinPipe_((d.categories || []).filter(function (c) { return s.categories.indexOf(c) > -1; }));
    closedOn = nowStamp_();
  }
  append_(T.CASES, {
    CaseID: id, CustomerID: custId, Title: String(d.title || '').trim() || 'Untitled case',
    Details: d.details || '', Source: d.source || '', Stage: stage, Outcome: outcome,
    OrderValue: orderValue, WonCategories: wonCats, OutcomeNote: '',
    Owner: u.Email,                                   // creator — fallback only; real owners = the account handlers
    ExtraOwners: '',
    Assignee: outcome ? '' : (assigneeEmail || u.Email),
    ClosedOn: closedOn,
    CreatedBy: u.Email, CreatedOn: nowStamp_(), UpdatedOn: nowStamp_()
  });
  return id;
}

function api_createCase(custId, d) {
  var u = me_();
  requireLevel_(u, 2);
  var ctx = context_(u);
  var c = ensureFull_(u, custId, ctx);
  d = d || {};
  if (!String(d.title || '').trim()) throw new Error('Give the case a short title.');
  var s = settings_();
  if (d.order) {
    if (!(Number(d.orderValue) > 0)) throw new Error('Enter the order value to add a won order.');
    var cats = (d.categories || []).filter(function (c2) { return s.categories.indexOf(c2) > -1; });
    if (!cats.length) throw new Error('Select at least one product category for the order.');
  }
  var assignee;
  if (d.assignee) assignee = resolveUser_(ctx, d.assignee);
  else if (lvl_(u) >= 5) throw new Error('Choose who this case is assigned to.');
  else assignee = u.Email;
  var id = createCaseRow_(u, ctx, custId, d, assignee);
  log_('CASE_NEW', id, custId, d.title + ' (' + c.Name + (d.order ? ', order' : ', ' + (d.stage || 'Lead')) + ')');
  return out_({ id: id });
}

function api_updateCase(id, d) {
  var u = me_();
  var ctx = context_(u);
  var o = findCase_(id);
  if (!caseVisible_(u, o, ctx)) throw new Error('You do not have access to this case.');
  var upd = { UpdatedOn: nowStamp_() };
  if (d.title !== undefined) upd.Title = String(d.title).trim() || o.Title;
  if (d.details !== undefined) upd.Details = d.details;
  if (d.source !== undefined) upd.Source = d.source;
  setCells_(T.CASES, o._row, upd);
  log_('CASE_EDIT', id, o.CustomerID, upd.Title || o.Title);
  return out_({ ok: true });
}

function api_setCaseStage(id, stage, note) {
  var u = me_();
  var ctx = context_(u);
  var o = findCase_(id);
  if (!caseVisible_(u, o, ctx)) throw new Error('You do not have access to this case.');
  var s = settings_();
  if (s.stages.indexOf(stage) === -1) throw new Error('"' + stage + '" is not a valid stage.');
  var outcome = String(o.Outcome || '').trim();
  if (outcome === 'Won' || outcome === 'Lost') throw new Error('This case is closed as ' + outcome + '. Reopen it before changing the stage.');
  var upd = { Stage: stage, UpdatedOn: nowStamp_() };
  if (outcome === 'Hold') upd.Outcome = '';  // moving stage resumes a held case
  if (o.Stage === stage && !outcome) return out_({ ok: true });
  setCells_(T.CASES, o._row, upd);
  log_('CASE_STAGE', id, o.CustomerID, (o.Stage || '—') + ' → ' + stage + (note ? ' — ' + note : ''));
  return out_({ ok: true });
}

// outcome: 'Won' | 'Lost' | 'Hold' | 'Open' (reopen). data: {orderValue, categories[], note}
function api_setCaseOutcome(id, outcome, data) {
  var u = me_();
  var ctx = context_(u);
  var o = findCase_(id);
  if (!caseVisible_(u, o, ctx)) throw new Error('You do not have access to this case.');
  var s = settings_();
  data = data || {};

  if (outcome === 'Open') {
    setCells_(T.CASES, o._row, { Outcome: '', ClosedOn: '', UpdatedOn: nowStamp_() });
    log_('CASE_OUTCOME', id, o.CustomerID, 'Reopened');
    return out_({ ok: true });
  }
  if (s.outcomes.indexOf(outcome) === -1) throw new Error('"' + outcome + '" is not a valid outcome.');

  var upd = { Outcome: outcome, OutcomeNote: data.note || '', UpdatedOn: nowStamp_() };
  if (outcome === 'Won') {
    var val = Number(data.orderValue);
    if (!(val > 0)) throw new Error('Enter the order value (the amount at which the order was won).');
    var cats = (data.categories || []).filter(function (c) { return s.categories.indexOf(c) > -1; });
    if (!cats.length) throw new Error('Select at least one product category for the won order.');
    upd.OrderValue = r2_(val);
    upd.WonCategories = joinPipe_(cats);
    upd.ClosedOn = nowStamp_();
    if (s.stages.indexOf('Quoted') > -1) upd.Stage = 'Quoted';
  } else if (outcome === 'Lost') {
    upd.ClosedOn = nowStamp_();
  } else if (outcome === 'Hold') {
    upd.ClosedOn = '';
  }
  // a closed case is nobody's open ticket any more
  if (outcome === 'Won' || outcome === 'Lost') upd.Assignee = '';
  setCells_(T.CASES, o._row, upd);
  var detail = outcome + (outcome === 'Won' ? ' — ' + s.currency + ' ' + fmtMoney_(upd.OrderValue) + ' [' + (upd.WonCategories || '') + ']' : '') + (data.note ? ' — ' + data.note : '');
  log_('CASE_OUTCOME', id, o.CustomerID, detail);
  return out_({ ok: true });
}

// Latest non-superseded quotation total per case (for showing a 'quoted' value on open cases).
function quotedValueMap_() {
  var best = {};
  rows_(T.QUOTES).forEach(function (q) {
    if (!q.CaseID || String(q.Status) === 'Superseded') return;
    var cur = best[q.CaseID];
    var better = !cur || q.QuoteNo > cur.qn || (q.QuoteNo === cur.qn && Number(q.Rev) > cur.rev);
    if (better) best[q.CaseID] = { qn: q.QuoteNo, rev: Number(q.Rev), total: q.Total };
  });
  var out = {};
  Object.keys(best).forEach(function (k) { out[k] = best[k].total; });
  return out;
}
function bumpStage_(caseRow, target) {
  try {
    var s = settings_();
    if (String(caseRow.Outcome || '').trim()) return; // don't move closed/held cases
    var ci = s.stages.indexOf(caseRow.Stage);
    var ti = s.stages.indexOf(target);
    if (ti > -1 && ci < ti) {
      setCells_(T.CASES, caseRow._row, { Stage: target, UpdatedOn: nowStamp_() });
      log_('CASE_STAGE', caseRow.CaseID, caseRow.CustomerID, (caseRow.Stage || '—') + ' → ' + target + ' (auto)');
    }
  } catch (e) { /* best-effort */ }
}

// Add an extra owner to a specific case (beyond the account handlers, who are always owners).
function api_addCaseOwner(caseId, who) {
  var u = me_();
  var ctx = context_(u);
  var o = findCase_(caseId);
  if (caseOwners_(o, ctx).indexOf(u.Email) === -1 && !seesAll_(u)) throw new Error('Only a current owner of this case can add owners.');
  var e = resolveUser_(ctx, who);
  if (caseHandlerOwners_(o, ctx).indexOf(e) > -1) throw new Error(nameOf_(ctx.idx, e) + ' is already an owner (as an account handler).');
  var extras = caseExtraOwners_(o);
  if (extras.indexOf(e) > -1) throw new Error(nameOf_(ctx.idx, e) + ' is already an owner of this case.');
  extras.push(e);
  setCells_(T.CASES, o._row, { ExtraOwners: joinPipe_(extras), UpdatedOn: nowStamp_() });
  log_('CASE_OWNER_ADD', caseId, o.CustomerID, nameOf_(ctx.idx, e));
  return out_({ ok: true });
}
// Remove an extra owner. Account handlers are owners by definition and cannot be removed here.
function api_removeCaseOwner(caseId, who) {
  var u = me_();
  var ctx = context_(u);
  var o = findCase_(caseId);
  if (caseOwners_(o, ctx).indexOf(u.Email) === -1 && !seesAll_(u)) throw new Error('Only a current owner of this case can remove owners.');
  var e = expandEmail_(who);
  if (caseHandlerOwners_(o, ctx).indexOf(e) > -1) throw new Error('Account handlers are owners of every case on the account and cannot be removed here. Remove them as a handler on the customer instead.');
  var extras = caseExtraOwners_(o).filter(function (x) { return x !== e; });
  setCells_(T.CASES, o._row, { ExtraOwners: joinPipe_(extras), UpdatedOn: nowStamp_() });
  log_('CASE_OWNER_REMOVE', caseId, o.CustomerID, nameOf_(ctx.idx, e));
  return out_({ ok: true });
}

// Reassign the opportunity ticket (who is working the case). Any user who can see the
// case may reassign it to any active CRM user, while the opportunity is still open.
function api_assignTicket(caseId, who) {
  var u = me_();
  var ctx = context_(u);
  var o = findCase_(caseId);
  if (!caseVisible_(u, o, ctx)) throw new Error('You do not have access to this case.');
  if (String(o.Outcome || '').trim()) throw new Error('This opportunity is closed — the ticket can no longer be reassigned.');
  var e = resolveUser_(ctx, who);
  setCells_(T.CASES, o._row, { Assignee: e, UpdatedOn: nowStamp_() });
  log_('CASE_ASSIGN', caseId, o.CustomerID, 'Working on \u2192 ' + nameOf_(ctx.idx, e));
  return out_({ ok: true, assignee: nameOf_(ctx.idx, e), assigneeEmail: e });
}

function api_getCase(id) {
  var u = me_();
  var ctx = context_(u);
  var o = findCase_(id);
  var vis = caseVisible_(u, o, ctx);
  if (!vis) {
    // (follow-up module removed) — placeholder to keep structure
    var amAssignee = [].filter(function (a) {
      return a.CaseID === id && parsePipe_(a.Assignees).map(low_).indexOf(u.Email) > -1;
    }).length > 0;
    if (!amAssignee) throw new Error('You do not have access to this case.');
  }
  var c = findCustomer_(o.CustomerID);
  var idx = ctx.idx;

  var quotes = rows_(T.QUOTES).filter(function (q) { return q.CaseID === id; })
    .sort(function (a, b) {
      if (a.QuoteNo === b.QuoteNo) return Number(b.Rev) - Number(a.Rev);
      return a.QuoteNo < b.QuoteNo ? 1 : -1;
    })
    .map(function (q) {
      return { quoteNo: q.QuoteNo, rev: Number(q.Rev), title: q.Title, total: q.Total, currency: q.Currency, status: q.Status, date: q.CreatedOn, doc: q.DocLink, pdf: q.PdfLink, by: nameOf_(idx, q.CreatedBy) };
    });

  var history = rows_(T.LOG).filter(function (r) { return r.Entity === id; })
    .reverse().slice(0, 40)
    .map(function (r) { return { when: r.When, who: nameOf_(idx, r.Who), action: r.Action, details: r.Details }; });

  return out_({
    canEdit: vis,
    canAssign: vis && lvl_(u) >= 2,
    canAssignTicket: !String(o.Outcome || '').trim(),
    case: {
      id: o.CaseID, title: o.Title, details: o.Details, source: o.Source,
      stage: o.Stage, outcome: String(o.Outcome || ''),
      orderValue: o.OrderValue, wonCategories: parsePipe_(o.WonCategories),
      outcomeNote: o.OutcomeNote,
      owners: ownerNames_(o, ctx), ownerEmails: caseOwners_(o, ctx),
      ownerList: (function () {
        var handlers = caseHandlerOwners_(o, ctx);
        return caseOwners_(o, ctx).map(function (e) {
          return { email: e, name: nameOf_(idx, e), removable: handlers.indexOf(e) === -1 };
        });
      })(),
      assignee: o.Assignee ? nameOf_(idx, o.Assignee) : '', assigneeEmail: low_(o.Assignee),
      closedOn: o.ClosedOn, createdOn: o.CreatedOn, updatedOn: o.UpdatedOn
    },
    customer: { id: c.CustomerID, name: c.Name, tags: parseList_(c.Tags) },
    quotes: quotes,
    history: history
  });
}

// filter f: {mine, stage, outcome ('Open'|'Won'|'Lost'|'Hold'|''), q}
function api_listCases(f) {
  var u = me_();
  var ctx = context_(u);
  f = f || {};
  var idx = ctx.idx;
  var customers = {};
  customerIndex_().forEach(function (c) { customers[c.id] = c; });

  var list = rows_(T.CASES).filter(function (o) {
    if (!caseVisible_(u, o, ctx)) return false;
    if (f.mine && caseOwners_(o, ctx).indexOf(u.Email) === -1) return false;
    var outcome = String(o.Outcome || '').trim();
    if (f.outcome === 'Open' && outcome) return false;
    if (f.outcome && f.outcome !== 'Open' && outcome !== f.outcome) return false;
    if (f.stage && o.Stage !== f.stage) return false;
    if (f.q) {
      var cn = customers[o.CustomerID] ? customers[o.CustomerID].name : '';
      var hay = low_(o.Title) + ' ' + low_(o.CaseID) + ' ' + low_(cn);
      if (hay.indexOf(low_(f.q)) === -1) return false;
    }
    return true;
  });

  list.sort(function (a, b) { return String(out_(b.UpdatedOn)) < String(out_(a.UpdatedOn)) ? -1 : 1; });

  var qv = quotedValueMap_();
  return out_(list.slice(0, 300).map(function (o) {
    var outc = String(o.Outcome || '');
    return {
      id: o.CaseID, title: o.Title, customerId: o.CustomerID,
      customerName: customers[o.CustomerID] ? customers[o.CustomerID].name : o.CustomerID,
      stage: o.Stage, outcome: outc, orderValue: o.OrderValue,
      quotedValue: (qv[o.CaseID] !== undefined ? qv[o.CaseID] : ''),
      owners: ownerNames_(o, ctx),
      assignee: outc ? '' : (o.Assignee ? nameOf_(idx, o.Assignee) : ''),
      updatedOn: o.UpdatedOn
    };
  }));
}

/* ---------------- quick log (one round-trip; built for mobile) ---------------- */
function api_quickLog(p) {
  var u = me_();
  requireLevel_(u, 2);
  var ctx = context_(u);
  var s = settings_();
  p = p || {};

  var custId = p.customerId || '';
  if (!custId) {
    var nc = p.newCustomer || {};
    var name = String(nc.name || '').trim();
    if (!name) throw new Error('Pick an existing customer or enter a new customer name.');
    var dup = customerIndex_().filter(function (c) { return low_(c.name) === low_(name); })[0];
    if (dup) {
      custId = dup.id; // reuse existing rather than duplicate
    } else {
      custId = 'CUST-' + pad_(nextId_('CUST'), 4);
      append_(T.CUSTOMERS, {
        CustomerID: custId, Name: name, Tags: validTag_(s, String(nc.tag || '').trim()),
        Type: validType_(s, String(nc.type || '').trim()), Priority: validPri_(s, String(nc.priority || '').trim()),
        Area: nc.area || '', Address: '', GSTIN: '', Website: '', Notes: '', SEI: '', Remarks: '',
        Status: 'Active', CreatedBy: u.Email, CreatedOn: nowStamp_(), UpdatedOn: nowStamp_()
      });
      append_(T.HANDLERS, { CustomerID: custId, UserEmail: u.Email, AssignedBy: 'quick-log', AssignedOn: nowStamp_() });
      clearCustIndex_();
      log_('CUSTOMER_NEW', custId, custId, name + ' (quick-log)');
    }
  } else {
    ensureFull_(u, custId, ctx);
  }

  var caseId = createCaseRow_(u, ctx, custId, {
    title: p.title, stage: p.stage, source: '', details: p.details || ''
  }, u.Email);
  log_('CASE_NEW', caseId, custId, (p.title || 'Case') + ' (quick-log)');

  return out_({ caseId: caseId, customerId: custId });
}

/* ================================================================
 * QUOTATIONS
 * ================================================================ */

function api_listTemplates() {
  me_();
  var folderId = PropertiesService.getScriptProperties().getProperty(PROPS.TPL);
  var files = DriveApp.getFolderById(folderId).getFiles();
  var list = [];
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_DOCS) list.push({ id: f.getId(), name: f.getName() });
  }
  list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return out_(list);
}


// Normalise pasted BOQ blocks: [{title, headers:[...], rows:[[...]]}]. First row of each paste = headers.
function boqClean_(blocks) {
  var out = [];
  (blocks || []).forEach(function (b) {
    var headers = (b.headers || []).map(function (h) { return String(h == null ? '' : h).trim(); });
    while (headers.length && headers[headers.length - 1] === '') headers.pop();
    if (!headers.length) return;
    var rows = (b.rows || []).map(function (r) {
      var rr = [];
      for (var i = 0; i < headers.length; i++) rr.push(String(r && r[i] != null ? r[i] : ''));
      return rr;
    }).filter(function (r) { return r.join('').trim() !== ''; });
    out.push({ title: String(b.title || '').trim(), headers: headers, rows: rows });
  });
  if (!out.length) throw new Error('Paste at least one BOQ table (the first pasted row is treated as the column headers).');
  return out;
}
function boqBlocks_(quoteNo, rev) {
  return rows_(T.QBOQ)
    .filter(function (b) { return b.QuoteNo === quoteNo && Number(b.Rev) === Number(rev); })
    .sort(function (a, b) { return Number(a.Block) - Number(b.Block); })
    .map(function (b) {
      var headers = [], rows = [];
      try { headers = JSON.parse(b.Headers || '[]'); } catch (e) {}
      try { rows = JSON.parse(b.Rows || '[]'); } catch (e2) {}
      return { title: String(b.Title || ''), headers: headers, rows: rows };
    });
}
function styleBoqTable_(table) {
  for (var r = 0; r < table.getNumRows(); r++) {
    for (var c = 0; c < table.getRow(r).getNumCells(); c++) {
      var cell = table.getRow(r).getCell(c);
      cell.editAsText().setFontSize(9);
      if (r === 0) { cell.editAsText().setBold(true); cell.setBackgroundColor('#E7EFE9'); }
    }
  }
}

function api_createQuotation(p) {
  var u = me_();
  var ctx = context_(u);
  var c = ensureFull_(u, p.customerId, ctx);
  var s = settings_();
  var blocks = boqClean_(p.blocks);

  var subtotal = Number(p.subtotal);
  if (!isFinite(subtotal) || subtotal < 0) subtotal = 0;
  subtotal = r2_(subtotal);
  var taxPct = (p.taxPct === '' || p.taxPct === undefined) ? s.taxPct : Number(p.taxPct);
  if (!isFinite(taxPct) || taxPct < 0) taxPct = 0;
  var taxAmount = r2_(subtotal * taxPct / 100);
  var total = r2_(subtotal + taxAmount);
  var currency = String(p.currency || s.currency || 'INR');
  var title = String(p.title || '').trim() || ('Quotation for ' + c.Name);

  var caseId = p.caseId || '';
  var theCase = null;
  if (caseId) {
    theCase = findCase_(caseId);
    if (theCase.CustomerID !== c.CustomerID) throw new Error('That case belongs to a different customer.');
  }

  var quoteNo, rev;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (p.baseQuoteNo) {
      var prev = rows_(T.QUOTES).filter(function (q) { return q.QuoteNo === p.baseQuoteNo; });
      if (!prev.length) throw new Error('Quotation ' + p.baseQuoteNo + ' was not found.');
      var maxRev = 0;
      prev.forEach(function (q) { if (Number(q.Rev) > maxRev) maxRev = Number(q.Rev); });
      quoteNo = p.baseQuoteNo;
      rev = maxRev + 1;
      if (!caseId) { caseId = prev[0].CaseID; try { theCase = findCase_(caseId); } catch (e) { theCase = null; } }
      prev.forEach(function (q) {
        if (q.Status === 'Draft' || q.Status === 'Sent') setCells_(T.QUOTES, q._row, { Status: 'Superseded' });
      });
    } else {
      var yr = new Date().getFullYear();
      quoteNo = 'QTN-' + yr + '-' + pad_(nextId_('QTN-' + yr), 4);
      rev = 0;
    }

    if (!caseId) {
      caseId = createCaseRow_(u, ctx, c.CustomerID, {
        title: title, source: 'Sales Team', stage: 'Opportunity', details: 'Auto-created with quotation ' + quoteNo
      }, u.Email);
      log_('CASE_NEW', caseId, c.CustomerID, 'Auto-created for ' + quoteNo);
      try { theCase = findCase_(caseId); } catch (e2) { theCase = null; }
    }

    var tplName = '';
    if (p.templateId) { try { tplName = DriveApp.getFileById(p.templateId).getName(); } catch (e3) { tplName = ''; } }

    append_(T.QUOTES, {
      QuoteNo: quoteNo, Rev: rev, CaseID: caseId, CustomerID: c.CustomerID, Title: title,
      Source: 'Generated', FileName: '',
      TemplateId: p.templateId || '', TemplateName: tplName, Status: 'Draft',
      Subtotal: subtotal, TaxPct: taxPct, TaxAmount: taxAmount, Total: total, Currency: currency,
      ValidUntil: p.validUntil || '', Notes: p.notes || '', DocLink: '', PdfLink: '',
      CreatedBy: u.Email, CreatedOn: nowStamp_()
    });

    blocks.forEach(function (b, i) {
      append_(T.QBOQ, { QuoteNo: quoteNo, Rev: rev, Block: i + 1, Title: b.title, Headers: JSON.stringify(b.headers), Rows: JSON.stringify(b.rows) });
    });
  } finally {
    lock.releaseLock();
  }

  log_('QUOTE_NEW', quoteNo + ' R' + rev, c.CustomerID, title + ' — ' + currency + ' ' + total);
  // Preparing a quote does NOT advance the stage; only marking it Sent does (api_setQuoteStatus).

  return out_({ quoteNo: quoteNo, rev: rev, caseId: caseId });
}

// Attach an externally prepared quotation (PDF/Doc/Excel) to a case, for the record.
// p: {customerId, caseId?, baseQuoteNo?, title, fileName, mimeType, dataB64, total, currency,
//     status?, validUntil?, notes?}
function api_uploadQuotation(p) {
  var u = me_();
  var ctx = context_(u);
  var c = ensureFull_(u, p.customerId, ctx);
  var s = settings_();

  var b64 = String(p.dataB64 || '');
  if (!b64) throw new Error('Choose a file to upload.');
  if (b64.length > 11000000) throw new Error('That file is too large — please keep uploads under about 8 MB.');
  var fileName = String(p.fileName || '').trim() || 'quotation';
  var total = Number(p.total);
  if (!isFinite(total) || total < 0) total = 0;
  total = r2_(total);
  var currency = String(p.currency || s.currency || 'INR');
  var title = String(p.title || '').trim() || ('Quotation for ' + c.Name);
  var status = ['Draft', 'Sent'].indexOf(String(p.status)) > -1 ? String(p.status) : 'Sent';

  var caseId = p.caseId || '';
  var theCase = null;
  if (caseId) {
    theCase = findCase_(caseId);
    if (theCase.CustomerID !== c.CustomerID) throw new Error('That case belongs to a different customer.');
  }

  var quoteNo, rev;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (p.baseQuoteNo) {
      var prev = rows_(T.QUOTES).filter(function (q) { return q.QuoteNo === p.baseQuoteNo; });
      if (!prev.length) throw new Error('Quotation ' + p.baseQuoteNo + ' was not found.');
      var maxRev = 0;
      prev.forEach(function (q) { if (Number(q.Rev) > maxRev) maxRev = Number(q.Rev); });
      quoteNo = p.baseQuoteNo;
      rev = maxRev + 1;
      if (!caseId) { caseId = prev[0].CaseID; try { theCase = findCase_(caseId); } catch (e) { theCase = null; } }
      prev.forEach(function (q) {
        if (q.Status === 'Draft' || q.Status === 'Sent') setCells_(T.QUOTES, q._row, { Status: 'Superseded' });
      });
    } else {
      var yr = new Date().getFullYear();
      quoteNo = 'QTN-' + yr + '-' + pad_(nextId_('QTN-' + yr), 4);
      rev = 0;
    }

    if (!caseId) {
      caseId = createCaseRow_(u, ctx, c.CustomerID, {
        title: title, stage: (status === 'Sent' ? 'Quoted' : 'Opportunity'), details: 'Auto-created with uploaded quotation ' + quoteNo
      }, u.Email);
      log_('CASE_NEW', caseId, c.CustomerID, 'Auto-created for ' + quoteNo);
      try { theCase = findCase_(caseId); } catch (e2) { theCase = null; }
    }

    var outFolder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty(PROPS.OUT));
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), p.mimeType || 'application/octet-stream', fileName);
    var saved = outFolder.createFile(blob).setName(quoteNo + ' R' + rev + ' - ' + c.Name + ' - ' + fileName);
    try { saved.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e3) { /* domain policy may block */ }

    append_(T.QUOTES, {
      QuoteNo: quoteNo, Rev: rev, CaseID: caseId, CustomerID: c.CustomerID, Title: title,
      Source: 'External', FileName: fileName,
      TemplateId: '', TemplateName: '', Status: status,
      Subtotal: '', TaxPct: '', TaxAmount: '', Total: total, Currency: currency,
      ValidUntil: p.validUntil || '', Notes: p.notes || '', DocLink: '', PdfLink: saved.getUrl(),
      CreatedBy: u.Email, CreatedOn: nowStamp_()
    });
  } finally {
    lock.releaseLock();
  }

  log_('QUOTE_UPLOAD', quoteNo + ' R' + rev, c.CustomerID, title + ' — ' + currency + ' ' + total);
  if (theCase && status === 'Sent') bumpStage_(theCase, 'Quoted');

  return out_({ quoteNo: quoteNo, rev: rev, caseId: caseId });
}

function findQuote_(quoteNo, rev) {
  var q = rows_(T.QUOTES).filter(function (x) { return x.QuoteNo === quoteNo && Number(x.Rev) === Number(rev); })[0];
  if (!q) throw new Error('Quotation ' + quoteNo + ' R' + rev + ' was not found.');
  return q;
}

function api_getQuotation(quoteNo, rev) {
  var u = me_();
  var q = findQuote_(quoteNo, rev);
  var c = ensureFull_(u, q.CustomerID);
  var idx = usersIndex_();

  var blocks = boqBlocks_(quoteNo, rev);

  var revs = rows_(T.QUOTES).filter(function (x) { return x.QuoteNo === quoteNo; })
    .map(function (x) { return { rev: Number(x.Rev), status: x.Status, date: x.CreatedOn, total: x.Total }; })
    .sort(function (a, b) { return b.rev - a.rev; });

  return out_({
    quote: {
      quoteNo: q.QuoteNo, rev: Number(q.Rev), caseId: q.CaseID, title: q.Title,
      source: q.Source || 'Generated', fileName: q.FileName || '',
      templateId: q.TemplateId, templateName: q.TemplateName, status: q.Status,
      subtotal: q.Subtotal, taxPct: q.TaxPct, taxAmount: q.TaxAmount, total: q.Total,
      currency: q.Currency, validUntil: q.ValidUntil, notes: q.Notes,
      doc: q.DocLink, pdf: q.PdfLink, by: nameOf_(idx, q.CreatedBy), date: q.CreatedOn
    },
    customer: { id: c.CustomerID, name: c.Name },
    blocks: blocks,
    revisions: revs
  });
}

function api_setQuoteStatus(quoteNo, rev, status) {
  var u = me_();
  var q = findQuote_(quoteNo, rev);
  ensureFull_(u, q.CustomerID);
  var s = settings_();
  if (s.quoteStatuses.indexOf(status) === -1) throw new Error('"' + status + '" is not a valid quotation status.');
  setCells_(T.QUOTES, q._row, { Status: status });
  log_('QUOTE_STATUS', quoteNo + ' R' + rev, q.CustomerID, status);
  if (status === 'Sent' && q.CaseID) {
    try { bumpStage_(findCase_(q.CaseID), 'Quoted'); } catch (e) { /* case may be gone */ }
  }
  return out_({ ok: true });
}

function fmtMoney_(n) {
  var v = Number(n || 0);
  try { return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  catch (e) { return v.toFixed(2); }
}

function api_generateQuoteDoc(quoteNo, rev) {
  var u = me_();
  var q = findQuote_(quoteNo, rev);
  if (String(q.Source) === 'External') throw new Error('This quotation was uploaded as an external file — there is no template to generate from.');
  var c = ensureFull_(u, q.CustomerID);
  var s = settings_();
  if (!q.TemplateId) throw new Error('This quotation has no template selected. Create a revision and pick a template.');

  var contact = rows_(T.CONTACTS).filter(function (x) { return x.CustomerID === c.CustomerID; })[0];

  var outFolder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty(PROPS.OUT));
  var name = quoteNo + '-R' + rev + ' — ' + c.Name;
  var copyFile = DriveApp.getFileById(q.TemplateId).makeCopy(name, outFolder);
  var doc = DocumentApp.openById(copyFile.getId());
  var body = doc.getBody();

  var map = {
    '{{QUOTE_NO}}': q.QuoteNo,
    '{{REV}}': 'R' + rev,
    '{{DATE}}': today_(),
    '{{CUSTOMER_NAME}}': c.Name,
    '{{CUSTOMER_ADDRESS}}': [c.Address, c.Area].filter(function (x) { return String(x || '').trim(); }).join(', '),
    '{{CONTACT_NAME}}': contact ? (contact.Name + (contact.Designation ? ' (' + contact.Designation + ')' : '')) : '—',
    '{{TITLE}}': q.Title,
    '{{VALID_UNTIL}}': String(out_(q.ValidUntil)) || '30 days from date of offer',
    '{{NOTES}}': q.Notes || '—',
    '{{TAX_PCT}}': String(q.TaxPct),
    '{{SUBTOTAL}}': fmtMoney_(q.Subtotal),
    '{{TAX_AMOUNT}}': fmtMoney_(q.TaxAmount),
    '{{TOTAL}}': fmtMoney_(q.Total),
    '{{CURRENCY}}': q.Currency,
    '{{COMPANY}}': s.company,
    '{{PREPARED_BY}}': u.Name + ' (' + u.Email + ')'
  };
  Object.keys(map).forEach(function (k) {
    var pattern = k.replace(/[{}]/g, '\\$&');
    body.replaceText(pattern, String(map[k]));
  });

  var found = body.findText('\\{\\{BOQ_TABLE\\}\\}');
  if (found) {
    var par = found.getElement().getParent();
    var at = body.getChildIndex(par) + 1;
    boqBlocks_(quoteNo, rev).forEach(function (blk) {
      if (blk.title) {
        var tp = body.insertParagraph(at, blk.title);
        try { tp.setHeading(DocumentApp.ParagraphHeading.HEADING4); } catch (e) { /* heading optional */ }
        at++;
      }
      var data = [blk.headers.map(function (h) { return String(h); })];
      blk.rows.forEach(function (r) { data.push(r.map(function (x) { return String(x); })); });
      styleBoqTable_(body.insertTable(at, data));
      at++;
    });
    var tot = body.insertTable(at, [
      ['Subtotal', q.Currency + ' ' + fmtMoney_(q.Subtotal)],
      ['GST @ ' + q.TaxPct + '%', q.Currency + ' ' + fmtMoney_(q.TaxAmount)],
      ['Total', q.Currency + ' ' + fmtMoney_(q.Total)]
    ]);
    for (var tr = 0; tr < tot.getNumRows(); tr++) {
      tot.getRow(tr).getCell(0).editAsText().setBold(true).setFontSize(9);
      tot.getRow(tr).getCell(1).editAsText().setFontSize(9);
    }
    body.removeChild(par);
  }

  doc.saveAndClose();
  var pdf = outFolder.createFile(copyFile.getAs('application/pdf')).setName(name + '.pdf');
  try {
    copyFile.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
    pdf.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) { /* some domains restrict link sharing */ }

  setCells_(T.QUOTES, q._row, { DocLink: copyFile.getUrl(), PdfLink: pdf.getUrl() });
  log_('QUOTE_PDF', quoteNo + ' R' + rev, q.CustomerID, name);
  return out_({ doc: copyFile.getUrl(), pdf: pdf.getUrl() });
}

/* ================================================================
 * ADMIN
 * ================================================================ */

function api_admin_listUsers() {
  var u = me_();
  requireLevel_(u, 6);
  return out_(rows_(T.USERS).map(function (x) {
    return { email: low_(x.Email), name: x.Name, role: String(x.Role), allowedTags: parseList_(x.AllowedTags), active: isTrue_(x.Active), addedOn: x.AddedOn };
  }));
}

function api_admin_saveUser(d) {
  var u = me_();
  requireLevel_(u, 6);
  var email = low_(d.email);
  if (!email || email.indexOf('@') === -1) throw new Error('Enter a valid email address.');
  var role = /^L[1-6]$/.test(String(d.role)) ? d.role : 'L2';
  var tags = (d.allowedTags || []).indexOf('*') > -1 ? '*' : (d.allowedTags || []).join(', ');
  var active = d.active !== false;
  if (email === u.Email && !active) throw new Error('You cannot deactivate your own account.');
  if (email === u.Email && role !== 'L6') throw new Error('You cannot lower your own level below L6.');

  var existing = rows_(T.USERS).filter(function (x) { return low_(x.Email) === email; })[0];
  if (existing) {
    setCells_(T.USERS, existing._row, { Name: d.name || existing.Name, Role: role, AllowedTags: tags, Active: active });
    log_('USER_EDIT', email, '', role + (active ? '' : ' (deactivated)'));
  } else {
    append_(T.USERS, { Email: email, Name: d.name || email.split('@')[0], Role: role, AllowedTags: tags, Active: active, AddedOn: nowStamp_(), AddedBy: u.Email });
    log_('USER_ADD', email, '', role);
  }
  return out_({ ok: true });
}

function api_admin_saveSettings(d) {
  var u = me_();
  requireLevel_(u, 6);
  function clean(arr) { return (arr || []).map(function (s) { return String(s).trim(); }).filter(Boolean); }
  if (d.tags !== undefined) { var t = clean(d.tags); if (!t.length) throw new Error('Keep at least one tag.'); setSetting_('TAGS', t.join(' | ')); }
  if (d.types !== undefined) setSetting_('TYPES', clean(d.types).join(' | '));
  if (d.priorities !== undefined) setSetting_('PRIORITIES', clean(d.priorities).join(' | '));
  if (d.categories !== undefined) setSetting_('CATEGORIES', clean(d.categories).join(' | ')); // pipe-joined; categories may contain commas
  if (d.sources !== undefined) setSetting_('SOURCES', clean(d.sources).join(' | '));
  if (d.taxPct !== undefined) setSetting_('TAX_PCT', Number(d.taxPct) || 0);
  if (d.currency !== undefined) setSetting_('CURRENCY', String(d.currency || 'INR'));
  if (d.company !== undefined) setSetting_('COMPANY', String(d.company || ''));
  log_('SETTINGS', '', '', 'Settings updated');
  return out_({ ok: true });
}

function api_admin_links() {
  var u = me_();
  requireLevel_(u, 6);
  var p = PropertiesService.getScriptProperties();
  return out_({
    db: SpreadsheetApp.openById(p.getProperty(PROPS.DB)).getUrl(),
    templates: DriveApp.getFolderById(p.getProperty(PROPS.TPL)).getUrl(),
    quotes: DriveApp.getFolderById(p.getProperty(PROPS.OUT)).getUrl()
  });
}

function api_admin_runImport() {
  var u = me_();
  requireLevel_(u, 6);
  var s = settings_();
  var imp = rows_(T.IMPORT);
  if (!imp.length) return out_({ created: 0, skipped: [], message: 'The Import tab in the database sheet has no rows.' });

  var existingNames = {};
  customerIndex_().forEach(function (c) { existingNames[low_(c.name)] = c.id; });
  var idx = usersIndex_();

  var created = 0, skipped = [];
  imp.forEach(function (r) {
    var name = String(r.Name || '').trim();
    if (!name) return;
    if (existingNames[low_(name)]) { skipped.push(name + ' (exists as ' + existingNames[low_(name)] + ')'); return; }

    var id = 'CUST-' + pad_(nextId_('CUST'), 4);
    append_(T.CUSTOMERS, {
      CustomerID: id, Name: name,
      Tags: validTag_(s, String(r.Tag || '').trim()),
      Type: validType_(s, String(r.Type || '').trim()),
      Priority: validPri_(s, String(r.Priority || '').trim()),
      Area: r.Area || '', Address: r.Address || '',
      GSTIN: r.GSTIN || '', Website: '', Notes: '', Status: 'Active',
      CreatedBy: u.Email, CreatedOn: nowStamp_(), UpdatedOn: nowStamp_()
    });
    existingNames[low_(name)] = id;

    if (String(r.ContactName || '').trim()) {
      addContactRow_(u, id, { name: r.ContactName, designation: r.ContactDesignation, phone: r.ContactPhone, email: r.ContactEmail });
    }
    var anyHandler = false;
    parseList_(r.Handlers).forEach(function (e) {
      e = low_(e);
      if (idx[e] && idx[e].active) {
        append_(T.HANDLERS, { CustomerID: id, UserEmail: e, AssignedBy: 'import', AssignedOn: nowStamp_() });
        anyHandler = true;
      }
    });
    if (!anyHandler) append_(T.HANDLERS, { CustomerID: id, UserEmail: u.Email, AssignedBy: 'import (default)', AssignedOn: nowStamp_() });
    created++;
  });

  var sh = sh_(T.IMPORT);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  clearCustIndex_();

  log_('IMPORT', '', '', created + ' customers imported, ' + skipped.length + ' skipped');
  return out_({ created: created, skipped: skipped });
}

function api_admin_runImportContacts() {
  var u = me_();
  requireLevel_(u, 6);
  var imp = rows_(T.IMPORTC);
  if (!imp.length) return out_({ created: 0, skipped: [], message: 'The ImportContacts tab has no rows.' });

  var byName = {};
  rows_(T.CUSTOMERS).forEach(function (c) { byName[low_(c.Name)] = c.CustomerID; });

  var created = 0, skipped = [];
  imp.forEach(function (r) {
    var cust = String(r.CustomerName || '').trim();
    var nm = String(r.ContactName || '').trim();
    if (!cust && !nm) return;
    var cid = byName[low_(cust)];
    if (!cid) { skipped.push((cust || '(blank)') + ' — no matching customer'); return; }
    if (!nm) { skipped.push(cust + ' — blank contact name'); return; }
    addContactRow_(u, cid, { name: nm, designation: r.Designation, phone: r.Phone, email: r.Email, notes: r.Notes });
    created++;
  });

  var sh = sh_(T.IMPORTC);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();

  log_('IMPORT_CONTACTS', '', '', created + ' contacts imported, ' + skipped.length + ' skipped');
  return out_({ created: created, skipped: skipped });
}

/* ================================================================
 * MAINTENANCE — optional weekly backup (see SETUP_GUIDE.md)
 * ================================================================ */

function api_admin_listRecycle() {
  var u = me_();
  requireLevel_(u, 6);
  return out_({
    customers: rows_(T.RECYCLE).map(function (r) {
      return { id: r.CustomerID, name: r.Name, tags: parseList_(r.Tags), type: r.Type, priority: r.Priority, area: r.Area, deletedBy: r.DeletedBy, deletedOn: r.DeletedOn };
    })
  });
}
function api_admin_restoreCustomer(id) {
  var u = me_();
  requireLevel_(u, 6);
  var rec = rows_(T.RECYCLE).filter(function (x) { return x.CustomerID === id; })[0];
  if (!rec) throw new Error('That customer is not in the recycle bin.');
  if (rows_(T.CUSTOMERS).filter(function (x) { return x.CustomerID === id; }).length) throw new Error('A customer with this ID already exists.');
  var cust = {};
  head_(T.CUSTOMERS).forEach(function (h) { cust[h] = rec[h] !== undefined ? rec[h] : ''; });
  append_(T.CUSTOMERS, cust);
  deleteRowsWhere_(T.RECYCLE, function (x) { return x.CustomerID === id; });
  clearCustIndex_();
  log_('CUSTOMER_RESTORE', id, id, rec.Name);
  return out_({ ok: true });
}
function api_admin_purgeCustomer(id) {
  var u = me_();
  requireLevel_(u, 6);
  var n = deleteRowsWhere_(T.RECYCLE, function (x) { return x.CustomerID === id; });
  if (!n) throw new Error('That customer is not in the recycle bin.');
  log_('CUSTOMER_PURGE', id, id, '');
  return out_({ ok: true });
}

/**
 * Editor utility (run from the Apps Script editor, not the web app).
 * Makes the account currently running the script an active L6 admin with all tags.
 * Use this after moving the CRM to a different owner account (e.g. crm@ -> admin@).
 */
function makeMeAdmin() {
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var existing = rows_(T.USERS).filter(function (x) { return low_(x.Email) === me; })[0];
  if (existing) {
    setCells_(T.USERS, existing._row, { Role: 'L6', AllowedTags: '*', Active: true });
    Logger.log(me + ' updated to L6 (all tags).');
  } else {
    append_(T.USERS, { Email: me, Name: 'Administrator', Role: 'L6', AllowedTags: '*', Active: true, CreatedOn: nowStamp_(), CreatedBy: 'makeMeAdmin' });
    Logger.log(me + ' added as L6 (all tags).');
  }
}

function backupDatabase() {
  var p = PropertiesService.getScriptProperties();
  var dbId = p.getProperty(PROPS.DB);
  if (!dbId) return;
  var root = DriveApp.getFolderById(p.getProperty(PROPS.ROOT));
  var stamp = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  DriveApp.getFileById(dbId).makeCopy(APP_NAME + ' Database — backup ' + stamp, root);
}
