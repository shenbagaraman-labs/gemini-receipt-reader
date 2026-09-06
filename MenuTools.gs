/**
 * MenuTools.gs
 * Adds a "Receipt Tools" menu to the spreadsheet for manual corrections:
 *   - Rename Receipt: fix one receipt's store name/ID by its exact ID.
 *   - Rename Store Name (bulk): fix EVERY receipt currently filed under one
 *     store name (e.g. every "ALDI STORES SHIRES RETAIL PARK LEAMINGTON"
 *     entry) in one action, with a count-based confirmation first.
 * Both rename the Drive PDF and update Store Name/ID in the Extraction Log,
 * every matching Receipt Log item row, and the Payment Details row.
 *
 * The menu appears automatically when you open the Sheet. If you don't see
 * it right after pasting this file, run onOpen once from the Apps Script
 * editor (Run > onOpen), or just reload the Sheet tab.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Receipt Tools')
    .addItem('Rename Receipt (fix one, by ID)...', 'renameReceiptDialog_')
    .addItem('Rename Store Name (bulk, by store)...', 'renameStoreDialog_')
    .addToUi();
}

/**
 * Prompts for the receipt's current ID and a corrected store name, then
 * renames it everywhere. The date/time portion of the ID is kept as-is -
 * only the store segment changes.
 */
function renameReceiptDialog_() {
  const ui = SpreadsheetApp.getUi();

  const idResponse = ui.prompt(
    'Rename Receipt - Step 1 of 2',
    'Enter the current ID exactly as it appears in the "ID" column ' +
    '(e.g. 20260807-202559-ALDISTORESSH):',
    ui.ButtonSet.OK_CANCEL
  );
  if (idResponse.getSelectedButton() !== ui.Button.OK) return;
  const oldId = idResponse.getResponseText().trim();
  if (!oldId) return;

  const parts = oldId.split('-');
  if (parts.length < 3) {
    ui.alert('That doesn\'t look like a valid ID (expected DATE-TIME-STORE, e.g. 20260807-202559-ALDI).');
    return;
  }

  const storeResponse = ui.prompt(
    'Rename Receipt - Step 2 of 2',
    'Enter the corrected store name (e.g. ALDI):',
    ui.ButtonSet.OK_CANCEL
  );
  if (storeResponse.getSelectedButton() !== ui.Button.OK) return;
  const newStoreName = storeResponse.getResponseText().trim();
  if (!newStoreName) return;

  const newId = parts[0] + '-' + parts[1] + '-' + shortenStoreName_(newStoreName);
  if (newId === oldId) {
    ui.alert('That produces the same ID (' + newId + ') - nothing to change.');
    return;
  }

  try {
    const result = renameReceiptEverywhere_(oldId, newId, newStoreName);
    ui.alert('Done', 'Renamed ' + oldId + '\n     to ' + newId + '\n\n' + formatRenameResult_(result),
      ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Something went wrong: ' + err);
  }
}

/**
 * Prompts for an old store name and a new one, finds every receipt in the
 * Extraction Log currently filed under the old name, shows a count-based
 * confirmation, and only then renames all of them - the Drive PDFs and
 * every matching row across all three tabs.
 */
function renameStoreDialog_() {
  const ui = SpreadsheetApp.getUi();

  const oldResponse = ui.prompt(
    'Rename Store Name - Step 1 of 2',
    'Enter the EXACT current store name to replace, as it appears in the ' +
    '"Store Name" column (e.g. ALDI STORES SHIRES RETAIL PARK LEAMINGTON):',
    ui.ButtonSet.OK_CANCEL
  );
  if (oldResponse.getSelectedButton() !== ui.Button.OK) return;
  const oldStoreName = oldResponse.getResponseText().trim();
  if (!oldStoreName) return;

  const cfg = getConfig_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const extractionSheet = ss.getSheetByName(cfg.extractionLogSheet);
  const extractionMap = getHeaderMap_(extractionSheet);
  const matchingIds = findAllIdsByStoreName_(extractionSheet, extractionMap, oldStoreName);

  if (matchingIds.length === 0) {
    ui.alert('No entries found with Store Name exactly "' + oldStoreName + '".');
    return;
  }

  const newResponse = ui.prompt(
    'Rename Store Name - Step 2 of 2',
    'Found ' + matchingIds.length + ' receipt(s) with store name "' + oldStoreName + '".\n\n' +
    'Enter the new store name to replace it with:',
    ui.ButtonSet.OK_CANCEL
  );
  if (newResponse.getSelectedButton() !== ui.Button.OK) return;
  const newStoreName = newResponse.getResponseText().trim();
  if (!newStoreName) return;

  const confirm = ui.alert(
    'Confirm bulk rename',
    'This will update ' + matchingIds.length + ' entr' + (matchingIds.length === 1 ? 'y' : 'ies') +
    ' - renaming the Drive PDF and updating Store Name/ID in the Extraction Log, Receipt Log, ' +
    'and Payment Details for each - from:\n\n"' + oldStoreName + '"\n\nto:\n\n"' + newStoreName + '"\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  let renamedCount = 0;
  const totals = { fileRenamed: 0, fileFailed: 0, itemRows: 0, paymentRows: 0 };
  const errors = [];

  matchingIds.forEach(oldId => {
    const parts = String(oldId).split('-');
    if (parts.length < 3) {
      errors.push(oldId + ' (unexpected ID format, skipped)');
      return;
    }
    const newId = parts[0] + '-' + parts[1] + '-' + shortenStoreName_(newStoreName);
    try {
      const result = renameReceiptEverywhere_(oldId, newId, newStoreName);
      renamedCount++;
      totals.fileRenamed += result.fileRenamed ? 1 : 0;
      totals.fileFailed += result.fileRenamed ? 0 : 1;
      totals.itemRows += result.itemRowCount;
      totals.paymentRows += result.paymentRowCount;
    } catch (err) {
      errors.push(oldId + ' (' + err + ')');
    }
  });

  let resultMsg = 'Renamed ' + renamedCount + ' of ' + matchingIds.length + ' receipt(s).\n' +
    totals.itemRows + ' item row(s) and ' + totals.paymentRows + ' payment row(s) updated.\n' +
    totals.fileRenamed + ' Drive file(s) renamed.';
  if (totals.fileFailed > 0) {
    resultMsg += '\n' + totals.fileFailed + ' Drive file(s) could not be found/renamed - check manually.';
  }
  if (errors.length > 0) {
    resultMsg += '\n\nSkipped/errored:\n' + errors.join('\n');
  }

  ui.alert('Bulk rename complete', resultMsg, ui.ButtonSet.OK);
}

/**
 * Core rename logic. Finds the receipt by its current ID in the Extraction
 * Log, renames the Drive file, and updates ID/Store Name everywhere that ID
 * appears across all three tabs. Returns { fileRenamed, itemRowCount, paymentRowCount }.
 */
function renameReceiptEverywhere_(oldId, newId, newStoreName) {
  const cfg = getConfig_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const extractionSheet = ss.getSheetByName(cfg.extractionLogSheet);
  const extractionMap = getHeaderMap_(extractionSheet);
  const extractionRow = findFirstRowByValue_(extractionSheet, extractionMap['ID'], oldId);
  if (!extractionRow) {
    throw new Error('No row found in "' + cfg.extractionLogSheet + '" with ID "' + oldId + '".');
  }

  // Rename the actual Drive file - file ID doesn't change on rename, so
  // Final File ID / Final PDF Link columns stay valid with no edits needed.
  const fileIdCol = extractionMap['Final File ID'] || extractionMap['File ID'];
  const fileId = fileIdCol ? extractionSheet.getRange(extractionRow, fileIdCol).getValue() : null;
  let fileRenamed = false;
  let newFileName = null;
  if (fileId) {
    try {
      const file = DriveApp.getFileById(fileId);
      const ext = file.getName().includes('.') ? file.getName().split('.').pop() : 'pdf';
      newFileName = newId + '.' + ext;
      file.setName(newFileName);
      fileRenamed = true;
    } catch (err) {
      Logger.log('Could not rename Drive file for ' + oldId + ': ' + err);
    }
  }

  setCellByHeader_(extractionSheet, extractionMap, extractionRow, 'ID', newId);
  setCellByHeader_(extractionSheet, extractionMap, extractionRow, 'Store Name', newStoreName);
  if (fileRenamed) {
    setCellByHeader_(extractionSheet, extractionMap, extractionRow, 'Target File Name', newFileName);
  }

  const receiptSheet = ss.getSheetByName(cfg.receiptLogSheet);
  const receiptMap = getHeaderMap_(receiptSheet);
  const receiptRows = findAllRowsByValue_(receiptSheet, receiptMap['ID'], oldId);
  receiptRows.forEach(r => {
    setCellByHeader_(receiptSheet, receiptMap, r, 'ID', newId);
    setCellByHeader_(receiptSheet, receiptMap, r, 'Store Name', newStoreName);
  });

  const paymentSheet = ss.getSheetByName(cfg.paymentDetailsSheet);
  const paymentMap = getHeaderMap_(paymentSheet);
  const paymentRows = findAllRowsByValue_(paymentSheet, paymentMap['ID'], oldId);
  paymentRows.forEach(r => {
    setCellByHeader_(paymentSheet, paymentMap, r, 'ID', newId);
    setCellByHeader_(paymentSheet, paymentMap, r, 'Store Name', newStoreName);
  });

  return {
    fileRenamed: fileRenamed,
    itemRowCount: receiptRows.length,
    paymentRowCount: paymentRows.length
  };
}

function formatRenameResult_(result) {
  return (result.fileRenamed ? 'Drive file renamed. ' : 'Drive file NOT found/renamed - check manually. ') +
    result.itemRowCount + ' item row(s) updated. ' + result.paymentRowCount + ' payment row(s) updated.';
}

/** Returns all IDs (from the Extraction Log) whose Store Name exactly matches (case-insensitive, trimmed). */
function findAllIdsByStoreName_(sheet, headerMap, storeName) {
  const idCol = headerMap['ID'];
  const storeCol = headerMap['Store Name'];
  if (!idCol || !storeCol) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, Math.max(idCol, storeCol)).getValues();
  const target = storeName.trim().toUpperCase();
  const ids = [];
  values.forEach(row => {
    const rowStore = String(row[storeCol - 1] || '').trim().toUpperCase();
    if (rowStore === target) ids.push(row[idCol - 1]);
  });
  return ids;
}

/** Returns the first sheet row (1-based) where the given column equals value, or null. */
function findFirstRowByValue_(sheet, col, value) {
  if (!col) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2; // +2: skip header, convert to 1-based row
  }
  return null;
}

/** Returns all sheet rows (1-based) where the given column equals value. */
function findAllRowsByValue_(sheet, col, value) {
  if (!col) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  const rows = [];
  values.forEach((v, i) => {
    if (String(v[0]) === String(value)) rows.push(i + 2);
  });
  return rows;
}

/** Sets a single cell by header name, skipping silently if that header doesn't exist on this sheet. */
function setCellByHeader_(sheet, headerMap, row, headerName, value) {
  const col = headerMap[headerName];
  if (col) sheet.getRange(row, col).setValue(value);
}