/**
 * Config.gs
 * Reads settings from the "Config" tab (so you can tweak folder/sheet names
 * without touching code) and from Script Properties (for secrets + IDs
 * you don't want sitting in a shared spreadsheet).
 *
 * ONE-TIME SETUP (Project Settings > Script Properties):
 *   GEMINI_API_KEY   -> your AI Studio key
 *   INBOX_FOLDER_ID  -> Drive folder ID for "A. INBOX"
 *   ARCHIVE_ROOT_ID  -> Drive folder ID for "D. ARCHIVE"
 *   REVIEW_FOLDER_ID -> Drive folder ID for "B. Needs Review"
 *   ERROR_FOLDER_ID  -> Drive folder ID for "C. Error"
 *   DUPLICATE_FOLDER_ID -> Drive folder ID for "E. Duplicate"
 */

// ---------------------------------------------------------------------------
// Fixed category list for item categorization (see ItemCategorization.gs).
// This is the SINGLE SOURCE OF TRUTH for categories - referenced by:
//   - GeminiService.gs (schema enum + prompt text)
//   - ItemCategorization.gs (validating Gemini's suggestion, Item Reference
//     rule resolution)
// Declared here (not in ItemCategorization.gs) specifically so it lives in
// only one file - Apps Script shares one global namespace across all .gs
// files, so declaring the same const in two files would throw a
// "already declared" error at load time.
// ---------------------------------------------------------------------------
const CATEGORY_LIST = [
  'Fruit & Veg',
  'Dairy & Eggs',
  'Bakery',
  'Frozen',
  'Store Cupboard & Grocery',
  'Snacks & Confectionery',
  'Drinks',
  'Health & Toiletries',
  'Household & Cleaning',
  'Baby & Kids',
  'Clothing & Footwear',
  'Stationery & Office',
  'Home & DIY',
  'Fuel',
  'Parking & Travel',
  'Gifts & Occasions',
  'Electronics & Tech',
  'Books & Media',
  'Furniture & Homeware',
  'Charity & Donations',
  'Repairs & Services',
  'Uncategorized'
];

// Tab name for the Keyword -> Canonical Name -> Category reference table
// (same shape/pattern as the "Store Aliases" tab). See
// item_categorization_setup.md for the column layout.
const ITEM_REFERENCE_SHEET_NAME = 'Item Reference';

function getConfig_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configSheet = ss.getSheetByName('Config');
  const rows = configSheet.getDataRange().getValues();

  const cfg = {};
  for (let i = 1; i < rows.length; i++) {
    const key = rows[i][0];
    const value = rows[i][1];
    if (key) cfg[key] = value;
  }

  const props = PropertiesService.getScriptProperties();

  return {
    // From Config tab
    sourceFolderName: cfg['SOURCE_FOLDER_NAME'],
    reviewFolderName: cfg['NEEDS_REVIEW_FOLDER_NAME'],
    errorFolderName: cfg['ERROR_FOLDER_NAME'],
    archiveFolderName: cfg['ARCHIVE_FOLDER_NAME'],
    duplicateFolderName: cfg['DUPLICATE_FOLDER_NAME'],
    receiptLogSheet: cfg['RECEIPT_LOG_SHEET'],
    paymentDetailsSheet: cfg['PAYMENT_DETAILS_SHEET'],
    extractionLogSheet: cfg['EXTRACTION_LOG_SHEET'],
    timezone: cfg['TIMEZONE'] || 'Europe/London',
    totalTolerance: Number(cfg['TOTAL_TOLERANCE']) || 0.01,
    processLatestOnly: String(cfg['PROCESS_LATEST_ONLY']).toLowerCase() === 'true',

    // From Script Properties (secrets / IDs)
    geminiApiKey: props.getProperty('GEMINI_API_KEY'),
    inboxFolderId: props.getProperty('INBOX_FOLDER_ID'),
    archiveRootId: props.getProperty('ARCHIVE_ROOT_ID'),
    reviewFolderId: props.getProperty('REVIEW_FOLDER_ID'),
    errorFolderId: props.getProperty('ERROR_FOLDER_ID'),
    duplicateFolderId: props.getProperty('DUPLICATE_FOLDER_ID'),

    // Two-tier model strategy, based on your account's actual rate-limit
    // dashboard (not generic docs - free tier RPD varies a lot by account):
    //   modelPrimary: Flash-Lite - 500 requests/day, 15 RPM. Handles the
    //     bulk of receipts; this budget comfortably covers even backlog runs.
    //   modelEscalation: full Flash - only 20 requests/day. Used ONCE, only
    //     when the primary result comes back shaky (low confidence /
    //     uncertain items) or fails outright - not routine redundancy.
    // Check https://ai.google.dev/gemini-api/docs/models periodically;
    // Google retires/renames model IDs with notice.
    modelPrimary: 'gemini-3.5-flash-lite',
    modelEscalation: 'gemini-3.7-flash'
  };
}