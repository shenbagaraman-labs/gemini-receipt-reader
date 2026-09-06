/**
 * DashboardServer.gs
 * -----------------------------------------------------------------------
 * Read-only mobile dashboard for the receipts pipeline.
 * Add this file to the SAME Apps Script project as Config.gs / Main.gs /
 * SheetService.gs (Extensions > Apps Script > + > Script), then add the
 * matching Dashboard.html file (+ > HTML).
 *
 * NOTE: this file must NOT be named "Dashboard" — Apps Script shares one
 * naming namespace across .gs and .html files in a project, so it would
 * collide with Dashboard.html. The name here doesn't matter otherwise;
 * doGet() and the query functions below are globally scoped regardless
 * of which file they live in.
 *
 * Deploy as a Web App:
 *   Execute as:      Me
 *   Who has access:  Only myself
 * That gives you free Google-account auth with zero extra code — anyone
 * else hitting the URL gets bounced by Google before this script even runs.
 *
 * Everything here only READS the sheets below. It never writes anything.
 * -----------------------------------------------------------------------
 */

// ---- Sheet tab names — adjust here if yours differ from the project doc ----
var DASH_SHEET_EXTRACTION = 'Extraction Log';
var DASH_SHEET_RECEIPT    = 'Receipt Log';
var DASH_SHEET_PAYMENT    = 'Payment Details';

// How long query results are cached (seconds). Keeps repeat navigation fast
// without the dashboard going stale for long after a new receipt lands.
var DASH_CACHE_TTL_SEC = 120;

// =========================================================================
// Entry point
// =========================================================================

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Receipts')
    // The <meta viewport> tag inside Dashboard.html only controls the inner
    // sandboxed iframe Apps Script renders your content in — it does NOT
    // reach the outer page the phone's browser actually applies pinch-zoom/
    // scaling rules to (that outer page, with the "Report abuse" bar, is
    // Google's own chrome). addMetaTag writes the viewport tag onto that
    // OUTER page instead, which is the documented way to make an Apps
    // Script web app render at mobile width instead of shrunk-down desktop
    // width. See: https://developers.google.com/apps-script/reference/html/html-output-meta-tag
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// =========================================================================
// Public API — called from Dashboard.html via google.script.run
// =========================================================================

/** Years with receipts, most recent first, each with count + total spend. */
function getYearsSummary() {
  return withCache_('dash_years_v1', DASH_CACHE_TTL_SEC, function () {
    var rows = readSheetAsObjects_(DASH_SHEET_EXTRACTION);
    var byYear = {};
    rows.forEach(function (r) {
      var d = parseReceiptDate_(r['Receipt Date']);
      if (!d) return;
      var y = d.getFullYear();
      if (!byYear[y]) byYear[y] = { year: y, count: 0, total: 0 };
      byYear[y].count += 1;
      byYear[y].total += toNumber_(r['Receipt Total']);
    });
    return Object.keys(byYear)
      .map(function (y) { return byYear[y]; })
      .sort(function (a, b) { return b.year - a.year; });
  });
}

/** Months within a year that have receipts, most recent first. */
function getMonthsForYear(year) {
  year = Number(year);
  return withCache_('dash_months_' + year + '_v1', DASH_CACHE_TTL_SEC, function () {
    var rows = readSheetAsObjects_(DASH_SHEET_EXTRACTION);
    var byMonth = {};
    rows.forEach(function (r) {
      var d = parseReceiptDate_(r['Receipt Date']);
      if (!d || d.getFullYear() !== year) return;
      var m = d.getMonth() + 1;
      if (!byMonth[m]) byMonth[m] = { month: m, count: 0, total: 0 };
      byMonth[m].count += 1;
      byMonth[m].total += toNumber_(r['Receipt Total']);
    });
    return Object.keys(byMonth)
      .map(function (m) { return byMonth[m]; })
      .sort(function (a, b) { return b.month - a.month; });
  });
}

/** Receipt summaries for one year+month, most recent first. */
function getReceiptsForMonth(year, month) {
  year = Number(year); month = Number(month);
  return withCache_('dash_receipts_' + year + '_' + month + '_v1', DASH_CACHE_TTL_SEC, function () {
    var rows = readSheetAsObjects_(DASH_SHEET_EXTRACTION);
    return rows
      .filter(function (r) {
        var d = parseReceiptDate_(r['Receipt Date']);
        return d && d.getFullYear() === year && (d.getMonth() + 1) === month;
      })
      .map(summarizeReceipt_)
      .sort(sortByDateTimeDesc_);
  });
}

/** Full detail for one receipt: header info + line items + payment info. */
function getReceiptDetail(id) {
  try {
    if (id === null || id === undefined || id === '') {
      throw new Error('getReceiptDetail called with no id (got: ' + JSON.stringify(id) + ')');
    }

    var header = readSheetAsObjects_(DASH_SHEET_EXTRACTION).filter(function (r) {
      return r['ID'] === id;
    })[0];
    if (!header) throw new Error('Receipt not found: ' + id);

    var items = readSheetAsObjects_(DASH_SHEET_RECEIPT)
      .filter(function (r) { return r['ID'] === id; })
      .map(function (r) {
        return {
          itemName: r['Item Name'],
          myName: r['My Name'],
          category: (r['Category'] || '').toString().trim(),
          qty: r['Qty'],
          itemPrice: toNumber_(r['Item Price']),
          totalPrice: toNumber_(r['Total Price']),
          comments: r['Comments']
        };
      });

    var payment = readSheetAsObjects_(DASH_SHEET_PAYMENT).filter(function (r) {
      return r['ID'] === id;
    })[0];

    var result = {
      id: header['ID'],
      date: formatDate_(parseReceiptDate_(header['Receipt Date'])),
      time: formatTime_(header['Receipt Time']),
      store: header['Store Name'],
      total: toNumber_(header['Receipt Total']),
      itemSum: toNumber_(header['Item Sum']),
      status: header['Status'],
      reviewStatus: header['Manual Review Status'] || header['Review Status'] || '',
      reviewNotes: header['Review Notes'],
      pdfLink: header['Final PDF Link'],
      items: items,
      payment: payment ? {
        method: payment['Payment Method'],
        cardType: payment['Card Type'],
        cardNumber: payment['Card Number'],
        authCode: payment['Auth Code'],
        txnRef: payment['Transaction Ref']
      } : null
    };

    // Belt-and-braces: never let this function resolve to something the
    // client can't use. If this ever fires, check Extraction Log / Receipt
    // Log / Payment Details for a row with a corrupted 'ID' cell.
    if (!result || typeof result !== 'object') {
      throw new Error('getReceiptDetail(' + id + ') built an invalid result — check the sheets for a corrupted ID cell.');
    }
    return result;
  } catch (err) {
    // Shows up in the Apps Script editor's Executions log (left sidebar)
    // with the full id and stack trace, even though the client only sees
    // err.message.
    Logger.log('getReceiptDetail(%s) failed: %s', id, (err && err.stack) || err);
    throw err;
  }
}

/** Distinct store names with receipt counts, alphabetical. */
function getStores() {
  return withCache_('dash_stores_v1', DASH_CACHE_TTL_SEC * 3, function () {
    var rows = readSheetAsObjects_(DASH_SHEET_EXTRACTION);
    var counts = {};
    rows.forEach(function (r) {
      var s = (r['Store Name'] || '').toString().trim();
      if (!s) return;
      counts[s] = (counts[s] || 0) + 1;
    });
    return Object.keys(counts)
      .sort(function (a, b) { return a.localeCompare(b); })
      .map(function (s) { return { store: s, count: counts[s] }; });
  });
}

/** Receipt summaries for one store, most recent first. */
function getReceiptsByStore(store) {
  var rows = readSheetAsObjects_(DASH_SHEET_EXTRACTION);
  return rows
    .filter(function (r) { return r['Store Name'] === store; })
    .map(summarizeReceipt_)
    .sort(sortByDateTimeDesc_);
}

/**
 * Categories with item counts and total spend, highest spend first — the
 * "where is my money actually going" view. Blank Category cells are
 * grouped under "(Uncategorized)" rather than dropped.
 *
 * year/month independently filter the Receipt Log 'Date' column: pass a
 * number to filter to that year/month, or 'ALL' (or omit) for no filter on
 * that dimension. They're independent on purpose — year='ALL' with month=8
 * means "every August, across all years". Returns {total, categories}.
 */
function getCategoriesSummary(year, month) {
  var y = normalizeFilterValue_(year);
  var m = normalizeFilterValue_(month);
  return withCache_('dash_categories_' + y + '_' + m + '_v1', DASH_CACHE_TTL_SEC * 2, function () {
    var rows = readSheetAsObjects_(DASH_SHEET_RECEIPT);
    var byCat = {};
    var total = 0;
    rows.forEach(function (r) {
      if (!matchesYearMonth_(r['Date'], y, m)) return;
      var cat = (r['Category'] || '').toString().trim() || '(Uncategorized)';
      var amt = toNumber_(r['Total Price']);
      if (!byCat[cat]) byCat[cat] = { category: cat, count: 0, total: 0 };
      byCat[cat].count += 1;
      byCat[cat].total += amt;
      total += amt;
    });
    var categories = Object.keys(byCat)
      .map(function (c) { return byCat[c]; })
      .sort(function (a, b) { return b.total - a.total; });
    return { total: total, categories: categories };
  });
}

/**
 * Every line item in one category (or "(Uncategorized)"), most recent
 * first, filtered the same way as getCategoriesSummary's year/month.
 */
function getItemsByCategory(category, year, month) {
  var y = normalizeFilterValue_(year);
  var m = normalizeFilterValue_(month);
  var rows = readSheetAsObjects_(DASH_SHEET_RECEIPT);
  return rows
    .filter(function (r) {
      var cat = (r['Category'] || '').toString().trim();
      var matchCat = category === '(Uncategorized)' ? !cat : cat === category;
      return matchCat && matchesYearMonth_(r['Date'], y, m);
    })
    .map(function (r) {
      return {
        id: r['ID'],
        date: formatDate_(parseReceiptDate_(r['Date'])),
        store: r['Store Name'],
        itemName: r['Item Name'],
        myName: r['My Name'],
        qty: r['Qty'],
        itemPrice: toNumber_(r['Item Price']),
        totalPrice: toNumber_(r['Total Price'])
      };
    })
    .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
}

/** 'ALL' / blank / missing -> 'ALL'; anything else -> Number(v). */
function normalizeFilterValue_(v) {
  if (v === 'ALL' || v === undefined || v === null || v === '') return 'ALL';
  return Number(v);
}

/** True if cell `dateVal` falls in year `y` and month `m` ('ALL' = no filter on that dimension). */
function matchesYearMonth_(dateVal, y, m) {
  if (y === 'ALL' && m === 'ALL') return true;
  var d = parseReceiptDate_(dateVal);
  if (!d) return false;
  if (y !== 'ALL' && d.getFullYear() !== y) return false;
  if (m !== 'ALL' && (d.getMonth() + 1) !== m) return false;
  return true;
}

/**
 * Search item lines by name (matches Item Name or My Name, case-insensitive
 * substring). Returns individual matches (most recent first, capped) plus a
 * per-item-name summary with min/max price seen and the latest purchase —
 * the quick "am I being overcharged" view.
 */
function searchItems(query) {
  var q = (query || '').toString().trim().toLowerCase();
  if (!q) return { matches: [], groups: [] };

  var rows = readSheetAsObjects_(DASH_SHEET_RECEIPT);
  var matches = rows
    .filter(function (r) {
      var haystack = ((r['Item Name'] || '') + ' ' + (r['My Name'] || '')).toLowerCase();
      return haystack.indexOf(q) !== -1;
    })
    .map(function (r) {
      return {
        id: r['ID'],
        date: formatDate_(parseReceiptDate_(r['Date'])),
        store: r['Store Name'],
        itemName: r['Item Name'],
        myName: r['My Name'],
        category: (r['Category'] || '').toString().trim(),
        qty: r['Qty'],
        itemPrice: toNumber_(r['Item Price']),
        totalPrice: toNumber_(r['Total Price'])
      };
    })
    .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

  var groups = {};
  matches.forEach(function (m) {
    var key = (m.myName || m.itemName || '').toString().trim() || '(unnamed item)';
    if (!groups[key]) {
      groups[key] = { name: key, count: 0, min: Infinity, max: -Infinity, latest: null };
    }
    var g = groups[key];
    g.count += 1;
    if (m.itemPrice > 0) {
      g.min = Math.min(g.min, m.itemPrice);
      g.max = Math.max(g.max, m.itemPrice);
    }
    if (!g.latest || m.date > g.latest.date) g.latest = m;
  });

  var groupList = Object.keys(groups).map(function (k) {
    var g = groups[k];
    if (g.min === Infinity) { g.min = 0; g.max = 0; }
    return g;
  }).sort(function (a, b) { return b.count - a.count; });

  return {
    matches: matches.slice(0, 300),
    groups: groupList
  };
}

// =========================================================================
// Internal helpers
// =========================================================================

function summarizeReceipt_(r) {
  return {
    id: r['ID'],
    date: formatDate_(parseReceiptDate_(r['Receipt Date'])),
    time: formatTime_(r['Receipt Time']),
    store: r['Store Name'],
    total: toNumber_(r['Receipt Total']),
    itemCount: r['Extracted Item Count'] || r['Reported Item Count'] || '',
    status: r['Status'],
    reviewStatus: r['Manual Review Status'] || r['Review Status'] || ''
  };
}

function sortByDateTimeDesc_(a, b) {
  if (a.date !== b.date) return (b.date || '').localeCompare(a.date || '');
  return (b.time || '').toString().localeCompare((a.time || '').toString());
}

/** Reads a whole tab into an array of {header: value} objects. Skips blank rows. */
function readSheetAsObjects_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var blank = row.every(function (c) { return c === '' || c === null; });
    if (blank) continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = row[j];
    rows.push(obj);
  }
  return rows;
}

/** Wraps fn() in a short-lived script cache entry keyed by `key`. */
function withCache_(key, ttlSec, fn) {
  var cache = CacheService.getScriptCache();
  var cached;
  try { cached = cache.get(key); } catch (e) { cached = null; }
  if (cached) return JSON.parse(cached);

  var result = fn();
  try { cache.put(key, JSON.stringify(result), ttlSec); } catch (e) {
    // Result too large for the 100KB cache limit, or cache unavailable —
    // fine, we just skip caching this one.
  }
  return result;
}

function parseReceiptDate_(val) {
  if (!val) return null;
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    return val;
  }
  var s = val.toString().trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); // day-first DD/MM/YYYY
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate_(d) {
  if (!d) return '';
  var y = d.getFullYear();
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return y + '-' + m + '-' + day;
}

/**
 * A cell formatted as Time-only in Sheets (e.g. "14:12:30" with no date
 * part) comes back from getValues() as a JS Date anchored to the Sheets
 * epoch (Dec 30, 1899) with the time-of-day set. Left as-is, it crosses
 * the google.script.run bridge as a raw ISO string like
 * "1899-12-31T05:57:24.000Z" — this pulls just the HH:mm(:ss) back out,
 * using the spreadsheet's own timezone so it matches what the Sheet shows.
 */
function formatTime_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm:ss');
  }
  return v.toString();
}

function toNumber_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    // A numeric cell (Receipt Total / Item Sum / Item Price / Total Price)
    // whose Google Sheets number FORMAT is a Date/Time pattern comes back
    // from getValues() as a JS Date object instead of a plain number. Left
    // to the string parser below, Date#toString() garbles into a huge fake
    // number (e.g. "Sun Aug 30 2026 14:12:30 GMT+0100..." -> a 16-digit
    // number). Showing 0 here is deliberately obvious-wrong rather than a
    // plausible-looking incorrect amount — fix the column's number format
    // in the Sheet (Format > Number > Number or Currency) and it'll read
    // correctly again.
    return 0;
  }
  var n = parseFloat(v.toString().replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}