/**
 * Setup.gs
 * One-time helper for a brand-new spreadsheet: creates the four required
 * tabs (Config, Extraction Log, Receipt Log, Payment Details) with the
 * correct headers already in row 1, and seeds a few sensible Config rows.
 *
 * `Store Aliases` and `Item Reference` are NOT created here - Store Aliases
 * is auto-created with example rows the first time processInbox() runs
 * (see StoreAliases.gs), and Item Reference is optional (see
 * SHEET_SCHEMA.md).
 *
 * USAGE: open Extensions > Apps Script on a blank spreadsheet, paste this
 * file in alongside the rest of the project, then Run > createSheetStructure_
 * once from the editor. Safe to re-run - it skips any tab that already
 * exists rather than overwriting it.
 */

function createSheetStructure_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  createTabWithHeaders_(ss, 'Config', ['Key', 'Value']);
  seedConfigDefaults_(ss.getSheetByName('Config'));

  createTabWithHeaders_(ss, 'Extraction Log', [
    'ID', 'Processed At', 'File ID', 'Original File Name', 'Target File Name',
    'Store Name', 'Receipt Date', 'Receipt Time', 'Receipt Total', 'Item Sum',
    'Total Check Status', 'Reported Item Count', 'Extracted Item Count',
    'Item Count Check', 'Receipt Type', 'Parser Used', 'Review Status',
    'Review Notes', 'Manual Review Status', 'Final File ID', 'Final Folder',
    'Import Batch', 'Final PDF Link', 'Status', 'Error', 'Comments'
  ]);

  createTabWithHeaders_(ss, 'Receipt Log', [
    'ID', 'Date', 'Time', 'Store Name', 'Item Name', 'My Name', 'Category',
    'Category Source', 'Qty', 'Item Price', 'Total Price', 'Comments'
  ]);

  createTabWithHeaders_(ss, 'Payment Details', [
    'ID', 'Date', 'Time', 'Store Name', 'Receipt Total', 'Payment Method',
    'Card Type', 'Card Number', 'Auth Code', 'Transaction Ref',
    'Receipt Type', 'Final File ID', 'Final PDF Link', 'Comments'
  ]);

  Logger.log('Setup complete. Next: create your five Drive folders, set ' +
    'Script Properties (see README), and fill in the Config tab values.');
}

/** Creates `name` with `headers` in row 1 if it doesn't already exist; no-op otherwise. */
function createTabWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    Logger.log('"' + name + '" already exists - skipping (not overwriting existing data).');
    return sheet;
  }
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

/** Seeds Config with placeholder rows for every key Config.gs reads - edit values directly in the sheet. */
function seedConfigDefaults_(configSheet) {
  if (configSheet.getLastRow() > 0) return; // already has rows - don't clobber
  const defaults = [
    ['SOURCE_FOLDER_NAME', 'A. INBOX'],
    ['NEEDS_REVIEW_FOLDER_NAME', 'B. Needs Review'],
    ['ERROR_FOLDER_NAME', 'C. Error'],
    ['ARCHIVE_FOLDER_NAME', 'D. ARCHIVE'],
    ['DUPLICATE_FOLDER_NAME', 'E. Duplicate'],
    ['RECEIPT_LOG_SHEET', 'Receipt Log'],
    ['PAYMENT_DETAILS_SHEET', 'Payment Details'],
    ['EXTRACTION_LOG_SHEET', 'Extraction Log'],
    ['TIMEZONE', 'Europe/London'],
    ['TOTAL_TOLERANCE', '0.01'],
    ['PROCESS_LATEST_ONLY', 'false']
  ];
  configSheet.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
  configSheet.getRange(2, 1, defaults.length, 2).setValues(defaults);
}
