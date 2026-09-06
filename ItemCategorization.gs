/**
 * ItemCategorization.gs
 *
 * Resolves "My Name" (canonical item name) and "Category" for each Receipt
 * Log line item, on top of the existing Gemini extraction pipeline.
 *
 * NOTE: CATEGORY_LIST and ITEM_REFERENCE_SHEET_NAME live in Config.gs, not
 * here - Apps Script shares one global namespace across all .gs files in a
 * project, so declaring the same const in two files throws an "already
 * declared" error at load time. Keeping them in Config.gs also matches
 * where your other fixed lists/tab-name settings already live.
 *
 * Integration points:
 *  - Config.gs        : CATEGORY_LIST + ITEM_REFERENCE_SHEET_NAME
 *  - GeminiService.gs : buildReceiptSchema_() includes suggested_name /
 *                        suggested_category per item; extractReceiptData_()
 *                        appends buildCategorizationPromptAddition_() to the
 *                        prompt
 *  - SheetService.gs  : appendReceiptLogItems_() calls
 *                        applyItemCategorization_() before writing each row
 */

// ---------------------------------------------------------------------------
// 1. Prompt addition - appended to the base extraction prompt in
//    GeminiService.gs. {{CANONICAL_NAMES}} and {{CATEGORY_LIST}} are filled
//    in dynamically from the current Item Reference sheet + Config.gs.
// ---------------------------------------------------------------------------
const PROMPT_ADDITION_TEMPLATE =
  '\n\nFor EACH line item, also provide:\n' +
  '1. "suggested_name": a short, clean name a human would recognise ' +
  '(e.g. "MILK WHOLE 4PT" -> "Milk", "P FILOUS" -> "Petit Filous"). ' +
  'If the item matches one of these known canonical names, use that exact ' +
  'name rather than inventing a new one:\n{{CANONICAL_NAMES}}\n\n' +
  '2. "suggested_category": pick exactly one from this fixed list ' +
  '(use "Uncategorized" only if genuinely unclear):\n{{CATEGORY_LIST}}\n';

/**
 * Builds the dynamic portion of the prompt (canonical names + category list)
 * from the current Item Reference sheet. Called once per Gemini request in
 * extractReceiptData_() (GeminiService.gs).
 */
function buildCategorizationPromptAddition_() {
  const refs = loadItemReference_();

  // De-dupe canonical names, cap the list length so the prompt doesn't
  // balloon as the table grows over months of use.
  const MAX_NAMES_IN_PROMPT = 150;
  const uniqueNames = [...new Set(refs.map(function (r) { return r.canonicalName; }))]
    .slice(0, MAX_NAMES_IN_PROMPT);

  return PROMPT_ADDITION_TEMPLATE
    .replace('{{CANONICAL_NAMES}}', uniqueNames.join(', '))
    .replace('{{CATEGORY_LIST}}', CATEGORY_LIST.join(', '));
}

// ---------------------------------------------------------------------------
// 2. Item Reference loader - cached per execution, same pattern as
//    StoreAliases.gs uses for Store Aliases.
// ---------------------------------------------------------------------------
let _itemReferenceCache = null;

function loadItemReference_() {
  if (_itemReferenceCache) return _itemReferenceCache;

  const sheet = SpreadsheetApp.getActive().getSheetByName(ITEM_REFERENCE_SHEET_NAME);
  if (!sheet) {
    _itemReferenceCache = [];
    return _itemReferenceCache;
  }

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const keywordIdx = headers.indexOf('Keyword');
  const nameIdx = headers.indexOf('Canonical Name');
  const categoryIdx = headers.indexOf('Category');

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[keywordIdx]) continue; // skip blank rows
    rows.push({
      keyword: String(row[keywordIdx]).trim().toUpperCase(),
      canonicalName: String(row[nameIdx]).trim(),
      category: String(row[categoryIdx]).trim()
    });
  }

  _itemReferenceCache = rows;
  return _itemReferenceCache;
}

/**
 * Not required for a normal trigger run - each Apps Script execution starts
 * with a fresh global scope, so _itemReferenceCache is naturally empty at
 * the start of every processInbox() run. Provided for cases where you might
 * call loadItemReference_() multiple times within one execution AFTER
 * editing the Item Reference tab mid-run (e.g. from a custom menu tool) and
 * want the next read to pick up the change.
 */
function clearItemReferenceCache_() {
  _itemReferenceCache = null;
}

// ---------------------------------------------------------------------------
// 3. Resolution - Item Reference (trusted) wins over Gemini's guess (AI).
// ---------------------------------------------------------------------------

/**
 * Strips a leading barcode/SKU prefix like "339748 " or "45612 " from raw
 * item names before matching, so "339748 BABY POTATOES" matches the same
 * rule as "BABY POTATOES".
 */
function stripBarcodePrefix_(rawItemName) {
  return String(rawItemName || '').replace(/^\d{4,}\s+/, '').trim();
}

/**
 * Resolves the final My Name / Category / Source for one line item.
 *
 * @param {string} rawItemName            The raw extracted Item Name.
 * @param {string} geminiSuggestedName     Gemini's suggested_name (may be blank).
 * @param {string} geminiSuggestedCategory Gemini's suggested_category (may be blank/invalid).
 * @return {{myName: string, category: string, source: string}}
 */
function applyItemCategorization_(rawItemName, geminiSuggestedName, geminiSuggestedCategory) {
  const cleaned = stripBarcodePrefix_(rawItemName).toUpperCase();
  const refs = loadItemReference_();

  // First match wins - put more specific keywords above general ones in the
  // Item Reference sheet (e.g. "EE MILK WHITE" above "MILK", so an Easter
  // egg doesn't get matched as dairy).
  for (let i = 0; i < refs.length; i++) {
    if (cleaned.indexOf(refs[i].keyword) !== -1) {
      return {
        myName: refs[i].canonicalName,
        category: refs[i].category,
        source: 'Rule'
      };
    }
  }

  // No rule matched - fall back to Gemini's suggestion.
  const category = CATEGORY_LIST.indexOf(geminiSuggestedCategory) !== -1
    ? geminiSuggestedCategory
    : 'Uncategorized';

  return {
    myName: geminiSuggestedName || stripBarcodePrefix_(rawItemName),
    category: category,
    source: 'AI'
  };
}