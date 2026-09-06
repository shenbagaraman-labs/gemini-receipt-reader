/**
 * SheetService.gs
 * Writes into your tabs by HEADER NAME, not column position - this makes the
 * pipeline immune to columns being reordered, missing, or added (like the
 * new "Total Price" column). Row 1 of each tab is read fresh on every run to
 * build a name -> column-index map; any key below with no matching header is
 * simply skipped (logged as a warning) rather than silently misaligning
 * every other column.
 *
 * To add a column (e.g. "Total Price" in Receipt Log): add the header text
 * anywhere in that sheet's row 1, and add the matching key below. No other
 * code changes needed, and column order in the sheet no longer matters.
 *
 * TABLE EXPANSION: your tabs use Google Sheets' native "Tables" feature (the
 * filter/sort dropdowns). After every write, expandTableToFitData_() resizes
 * each tab's Table range to match the new data extent, using Google's
 * official Sheets API (Advanced Service) - not a third-party library.
 * REQUIRED ONE-TIME SETUP: in the Apps Script editor, click "+" next to
 * Services (left sidebar) and add "Google Sheets API".
 * Table banding (alternating colors) is a live property that Sheets renders
 * dynamically across whatever range the table currently spans, so resizing
 * the range is all that's needed - no need to strip/reapply banding.
 */

/** Reads row 1 and returns { "Header Text": columnIndex (1-based) }. */
function getHeaderMap_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    if (h) map[String(h).trim()] = i + 1;
  });
  return map;
}

/** Writes one row into `sheet`, placing each value under its matching header. */
function writeRowByHeaders_(sheet, headerMap, valuesByHeader) {
  const lastCol = Math.max(sheet.getLastColumn(), Object.keys(headerMap).length);
  const row = new Array(lastCol).fill('');
  Object.keys(valuesByHeader).forEach(key => {
    const col = headerMap[key];
    if (col) {
      row[col - 1] = valuesByHeader[key];
    } else {
      Logger.log('Warning: header "' + key + '" not found in "' + sheet.getName() +
        '" - value not written. Add this header to row 1 if you want it captured.');
    }
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

// sheetName -> {tableId, sheetId} | null, cached for the life of one script run
const TABLE_INFO_CACHE_ = {};

/**
 * Looks up the Table object (if any) on a given tab via the Sheets API.
 * Returns null if the tab has no Table (e.g. it was converted to a plain
 * range) - callers should treat that as "nothing to expand".
 */
function findTableInfo_(spreadsheetId, sheetName) {
  const meta = Sheets.Spreadsheets.get(spreadsheetId, {
    ranges: [sheetName],
    fields: 'sheets(properties.sheetId,tables(tableId,name))'
  });
  const sheetMeta = meta.sheets && meta.sheets[0];
  if (!sheetMeta || !sheetMeta.tables || sheetMeta.tables.length === 0) return null;
  return {
    tableId: sheetMeta.tables[0].tableId,
    sheetId: sheetMeta.properties.sheetId
  };
}

/**
 * Google Sheets won't let a Table's own banding overlap an existing legacy
 * "Alternating colors" range (a different, older feature). If your template
 * had that applied to a broad area (e.g. pre-styled empty rows), expanding
 * the Table into it fails with "You cannot add alternating background
 * colours to a range that already has alternating background colours."
 * This removes any legacy banding overlapping the target area first. The
 * Table's own banding renders dynamically once expanded, so nothing needs
 * to be reapplied afterward - the area still looks striped either way.
 */
function removeConflictingBandings_(sheet, endRow, endCol) {
  const bandings = sheet.getBandings();
  bandings.forEach(b => {
    const r = b.getRange();
    const overlaps = r.getRow() <= endRow && r.getColumn() <= endCol;
    if (overlaps) {
      Logger.log('Removing legacy "Alternating colors" banding on "' + sheet.getName() +
        '" at ' + r.getA1Notation() + ' - it conflicts with the Table\'s own banding. ' +
        'The Table will re-render its own stripes over this area once expanded.');
      b.remove();
    }
  });
}

/**
 * Resizes the named tab's Table range to cover exactly the current data
 * (row 1 through the last used row/column). Call this after writing rows.
 * No-op if the tab has no Table object, or if the Sheets API isn't enabled
 * yet (logs a warning instead of throwing, so a missing setup step doesn't
 * break the actual data write that already happened).
 */
function expandTableToFitData_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  const spreadsheetId = ss.getId();

  let info = TABLE_INFO_CACHE_[sheetName];
  if (info === undefined) {
    try {
      info = findTableInfo_(spreadsheetId, sheetName);
    } catch (err) {
      Logger.log('Could not look up Table info for "' + sheetName + '" - is the ' +
        'Google Sheets API advanced service enabled? Error: ' + err);
      info = null;
    }
    TABLE_INFO_CACHE_[sheetName] = info;
  }
  if (!info) return; // no Table on this tab - nothing to expand

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  const doExpand = () => Sheets.Spreadsheets.batchUpdate({
    requests: [{
      updateTable: {
        table: {
          tableId: info.tableId,
          range: {
            sheetId: info.sheetId,
            startRowIndex: 0,
            endRowIndex: lastRow,
            startColumnIndex: 0,
            endColumnIndex: lastCol
          }
        },
        fields: 'range'
      }
    }]
  }, spreadsheetId);

  try {
    doExpand();
  } catch (err) {
    if (String(err).indexOf('alternating background colours') !== -1) {
      removeConflictingBandings_(sheet, lastRow, lastCol);
      try {
        doExpand(); // retry once, now that conflicting banding is gone
      } catch (retryErr) {
        Logger.log('Failed to expand Table on "' + sheetName + '" even after removing ' +
          'conflicting banding: ' + retryErr);
      }
    } else {
      Logger.log('Failed to expand Table on "' + sheetName + '": ' + err);
    }
  }
}

function appendExtractionLogRow_(sheetName, row) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const headerMap = getHeaderMap_(sheet);
  writeRowByHeaders_(sheet, headerMap, {
    'ID': row.id,
    'Processed At': new Date(),
    'File ID': row.fileId,
    'Original File Name': row.originalFileName,
    'Target File Name': row.targetFileName,
    'Store Name': row.storeName,
    'Receipt Date': row.receiptDate,
    'Receipt Time': row.receiptTime,
    'Receipt Total': row.receiptTotal,
    'Item Sum': row.itemSum,
    'Total Check Status': row.totalCheckStatus,
    'Reported Item Count': row.reportedItemCount,
    'Extracted Item Count': row.extractedItemCount,
    'Item Count Check': row.itemCountCheck,
    'Receipt Type': row.receiptType,
    'Parser Used': row.parserUsed,
    'Review Status': row.reviewStatus,
    'Review Notes': row.reviewNotes,
    'Manual Review Status': row.manualReviewStatus,
    'Final File ID': row.finalFileId,
    'Final Folder': row.finalFolder,
    'Import Batch': row.importBatch,
    'Final PDF Link': row.finalPdfLink,
    'Status': row.status,
    'Error': row.error,
    'Comments': row.comments
  });
  expandTableToFitData_(sheetName);
}

/**
 * Appends one row per item to the itemized Receipt Log. Skipped entirely for
 * ERROR files.
 *
 * CATEGORIZATION: for each item, applyItemCategorization_() (in
 * ItemCategorization.gs) resolves the final My Name / Category:
 *   - If the item matches a row in the "Item Reference" tab, that rule wins
 *     (source = 'Rule') - this is how a manual correction, once made, never
 *     has to be re-made for that item again.
 *   - Otherwise Gemini's own suggested_name / suggested_category is used
 *     (source = 'AI'), falling back to "Uncategorized" if Gemini's category
 *     guess doesn't match the fixed list.
 * 'Category' and 'Category Source' are NEW headers - add them to Receipt
 * Log row 1 if you want them captured (same pattern as 'Total Price').
 */
function appendReceiptLogItems_(sheetName, id, date, time, storeName, items) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!items || items.length === 0) return;

  const headerMap = getHeaderMap_(sheet);
  const lastCol = Math.max(sheet.getLastColumn(), Object.keys(headerMap).length);

  const rows = items.map(item => {
    const row = new Array(lastCol).fill('');
    const qty = item.qty || 1;
    const totalPrice = Math.round(Number(item.unit_price) * qty * 100) / 100;

    const cat = applyItemCategorization_(item.name, item.suggested_name, item.suggested_category);

    const values = {
      'ID': id,
      'Date': date,
      'Time': time,
      'Store Name': storeName,
      'Item Name': item.name,
      'My Name': cat.myName,               // now resolved via Item Reference / Gemini, not a raw copy
      'Category': cat.category,            // NEW - add this header to Receipt Log row 1
      'Category Source': cat.source,       // NEW - 'Rule' or 'AI'; add this header too
      'Qty': qty,
      'Item Price': item.unit_price,
      'Total Price': totalPrice,
      'Comments': item.uncertain ? 'uncertain' : ''
    };
    Object.keys(values).forEach(key => {
      const col = headerMap[key];
      if (col) row[col - 1] = values[key];
    });
    return row;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, lastCol).setValues(rows);
  expandTableToFitData_(sheetName);
}

function appendPaymentDetailsRow_(sheetName, row) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const headerMap = getHeaderMap_(sheet);
  writeRowByHeaders_(sheet, headerMap, {
    'ID': row.id,
    'Date': row.date,
    'Time': row.time,
    'Store Name': row.storeName,
    'Receipt Total': row.receiptTotal,
    'Payment Method': row.paymentMethod,
    'Card Type': row.cardType,
    'Card Number': row.cardNumberMasked,
    'Auth Code': row.authCode,
    'Transaction Ref': row.transactionRef,
    'Receipt Type': row.receiptType,
    'Final File ID': row.finalFileId,
    'Final PDF Link': row.finalPdfLink,
    'Comments': row.comments
  });
  expandTableToFitData_(sheetName);
}

/**
 * Reads existing Extraction Log IDs + totals once per run, for cheap duplicate
 * checks (avoids re-reading the sheet per file). Uses the header map so it
 * finds "ID", "Receipt Date", "Receipt Time", "Receipt Total" wherever they
 * actually are in the sheet.
 */
function loadExistingExtractionKeys_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const lastRow = sheet.getLastRow();
  const keys = new Set();
  if (lastRow < 2) return keys;

  const headerMap = getHeaderMap_(sheet);
  const idCol = headerMap['ID'];
  const dateCol = headerMap['Receipt Date'];
  const timeCol = headerMap['Receipt Time'];
  const totalCol = headerMap['Receipt Total'];

  if (!idCol || !dateCol || !timeCol || !totalCol) {
    Logger.log('Warning: Extraction Log is missing one of ID/Receipt Date/Receipt Time/' +
      'Receipt Total headers - duplicate detection may be unreliable until fixed.');
  }

  const lastCol = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  data.forEach(r => {
    const id = idCol ? r[idCol - 1] : null;
    const date = dateCol ? r[dateCol - 1] : null;
    const time = timeCol ? r[timeCol - 1] : null;
    const total = totalCol ? r[totalCol - 1] : null;
    if (date && total !== null && total !== '') {
      keys.add(buildDuplicateKey_(date, time, total));
    }
    if (id) keys.add('ID::' + id);
  });
  return keys;
}