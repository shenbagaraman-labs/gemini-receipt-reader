/**
 * StoreAliases.gs
 * Normalizes AI-extracted store names before they're used to build the ID,
 * filename, or any sheet row - e.g. Gemini reading a branch receipt as
 * "ALDI STORES SHIRES RETAIL PARK LEAMINGTON" gets mapped down to "ALDI".
 *
 * Setup: a "Store Aliases" tab is created automatically (with example rows)
 * the first time this runs. Edit it directly in the Sheet - two columns:
 *   Keyword         - matches if the AI's store name CONTAINS this text
 *                      (case-insensitive), e.g. "ALDI"
 *   Canonical Name   - what to replace it with, e.g. "ALDI"
 * First matching row wins, top to bottom - put more specific keywords above
 * general ones if you ever need that. No match = store name is left as-is.
 */

const STORE_ALIAS_SHEET_NAME_ = 'Store Aliases';

/** Ensures the Store Aliases tab exists; creates it with example rows if missing. */
function ensureStoreAliasSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(STORE_ALIAS_SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(STORE_ALIAS_SHEET_NAME_);
    sheet.getRange(1, 1, 1, 3).setValues([
      ['Keyword (matches if store name CONTAINS this)', 'Canonical Name', 'Notes']
    ]);
    sheet.getRange(2, 1, 2, 3).setValues([
      ['ALDI', 'ALDI', 'Matches any branch, e.g. "ALDI STORES SHIRES RETAIL PARK LEAMINGTON"'],
      ['ASDA', 'ASDA', '']
    ]);
    sheet.setFrozenRows(1);
    Logger.log('Created "' + STORE_ALIAS_SHEET_NAME_ + '" tab with example rows - edit it directly in the Sheet.');
  }
  return sheet;
}

/** Loads the alias list once per run: array of {keyword, canonical}, in row order (first match wins). */
function loadStoreAliases_() {
  const sheet = ensureStoreAliasSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return rows
    .filter(r => r[0])
    .map(r => ({ keyword: String(r[0]).toUpperCase(), canonical: String(r[1]).trim() }));
}

/**
 * Normalizes a raw AI-extracted store name against the Store Aliases tab.
 * Returns the original name unchanged if nothing matches.
 */
function normalizeStoreName_(rawStoreName, aliases) {
  if (!rawStoreName || !aliases || !aliases.length) return rawStoreName;
  const upper = rawStoreName.toUpperCase();
  for (let i = 0; i < aliases.length; i++) {
    if (upper.indexOf(aliases[i].keyword) !== -1 && aliases[i].canonical) {
      return aliases[i].canonical;
    }
  }
  return rawStoreName;
}