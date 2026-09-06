/**
 * Main.gs
 * Entry point. Run processInbox() manually first (Run > processInbox in the
 * Apps Script editor) against a handful of test receipts. Once it behaves,
 * attach a time-driven trigger (Triggers > Add Trigger > processInbox >
 * Time-driven > every 15/30 minutes).
 */

// Apps Script hard-kills execution at 6 minutes. Stop starting new files
// once we're past this budget, so an in-progress move is never caught
// mid-operation by a forced kill - it just waits for the next trigger run.
const MAX_RUNTIME_MS_ = 4.5 * 60 * 1000; // 4.5 min - leaves headroom for a slow last file

// If this many files IN A ROW all hit a transient API failure, that's a
// live Google-side outage, not independent bad luck per file. Stop the run
// rather than grinding through the rest of the batch into the same outage -
// the next trigger run will pick everything back up once things recover.
const MAX_CONSECUTIVE_TRANSIENT_FAILURES_ = 2;

function processInbox() {
  const startTime = Date.now();
  const cfg = getConfig_();
  cfg.deadline = startTime + MAX_RUNTIME_MS_;
  cfg.storeAliases = loadStoreAliases_();
  const inboxFolder = DriveApp.getFolderById(cfg.inboxFolderId);
  const files = inboxFolder.getFiles();

  const existingKeys = loadExistingExtractionKeys_(cfg.extractionLogSheet);
  let consecutiveTransientFailures = 0;

  while (files.hasNext()) {
    if (Date.now() - startTime > MAX_RUNTIME_MS_) {
      Logger.log('Time budget reached - stopping early, remaining files left in inbox for next run.');
      break;
    }
    const file = files.next();
    try {
      const wasTransient = processOneReceipt_(file, cfg, existingKeys);
      consecutiveTransientFailures = wasTransient ? consecutiveTransientFailures + 1 : 0;
      if (consecutiveTransientFailures >= MAX_CONSECUTIVE_TRANSIENT_FAILURES_) {
        Logger.log(consecutiveTransientFailures + ' files in a row hit transient API failures - ' +
          'likely a live Google-side outage. Stopping this run early instead of grinding through ' +
          'the rest of the batch; remaining files are untouched in the inbox for the next run.');
        break;
      }
    } catch (err) {
      if (String(err).indexOf('TIME_BUDGET_EXCEEDED') !== -1) {
        // Not a bad file - just ran out of time. Leave it untouched in the
        // inbox; the next trigger run will pick it up fresh.
        Logger.log('Time budget exceeded mid-file for ' + file.getName() + ' - left in inbox for next run.');
        break;
      }
      // Genuine failure (e.g. Gemini API totally unreachable, corrupt file) -> Error folder.
      routeToError_(file, cfg, String(err));
      consecutiveTransientFailures = 0;
    }
  }
}

/** Returns true if this file hit a transient API failure (not routed anywhere, left in inbox). */
function processOneReceipt_(file, cfg, existingKeys) {
  const blob = file.getBlob();

  let extraction;
  try {
    extraction = extractReceiptWithFallback_(blob, cfg);
  } catch (err) {
    if (String(err).indexOf('TIME_BUDGET_EXCEEDED') !== -1) {
      throw err; // let the outer loop in processInbox() handle this - stop the run cleanly
    }
    if (String(err).indexOf('TRANSIENT_API_FAILURE') !== -1) {
      // The AI model was unavailable/rate-limited, not a bad receipt.
      // Leave the file untouched in the inbox - the next trigger run retries it.
      Logger.log('Leaving ' + file.getName() + ' in inbox - all attempts hit a transient ' +
        'API failure (model unavailable or quota), not a genuine read failure: ' + err);
      return true;
    }
    // Genuine failure (corrupt file, consistently malformed response, etc.) -> Error folder.
    routeToError_(file, cfg, 'Extraction failed: ' + err);
    return false;
  }

  const data = extraction.data;

  // Genuinely unreadable receipt -> Error, no sheet row at all (per your spec).
  if (!data || data.store_name === 'UNREADABLE') {
    routeToError_(file, cfg, 'Model could not read the receipt');
    return false;
  }

  // Normalize the AI's store name (e.g. "ALDI STORES SHIRES RETAIL PARK
  // LEAMINGTON" -> "ALDI") before it flows into the ID, filename, or any
  // sheet row - see the "Store Aliases" tab to add/edit mappings.
  data.store_name = normalizeStoreName_(data.store_name, cfg.storeAliases);

  // Defensive: Gemini doesn't always follow the YYYY-MM-DD instruction (e.g.
  // may return a day-first "22/08/2026" style date). Normalize before it's used to build
  // the ID or find the archive year/month folder.
  data.receipt_date = normalizeDateString_(data.receipt_date);

  const id = buildReceiptId_(data.receipt_date, data.receipt_time, data.store_name);
  const dupKey = buildDuplicateKey_(data.receipt_date, data.receipt_time, data.receipt_total);

  // --- Duplicate check ---
  if (existingKeys.has(dupKey) || existingKeys.has('ID::' + id)) {
    const dupName = buildDuplicateFileName_(id);
    const dupFolder = DriveApp.getFolderById(cfg.duplicateFolderId);
    renameAndMoveFile_(file, dupName, dupFolder);
    // No sheet updates for duplicates, per your spec - it's already logged
    // under the original ID.
    return false; // handled, not a transient failure
  }
  existingKeys.add(dupKey);
  existingKeys.add('ID::' + id);

  const items = data.items || [];

  // --- Item count reconciliation ---
  // Only a real check when the receipt printed its own count; otherwise
  // there's nothing to cross-check against, so it's N/A rather than a
  // false MATCH (which is what always comparing a number to itself gave before).
  const hasReportedCount = data.reported_item_count !== undefined && data.reported_item_count !== null;
  const itemCountCheck = hasReportedCount
    ? (Number(data.reported_item_count) === items.length ? 'MATCH' : 'MISMATCH')
    : 'N/A';

  // --- Price reconciliation ---
  const itemSum = items.reduce((sum, i) => sum + (Number(i.unit_price) * (i.qty || 1)), 0);
  const total = Number(data.receipt_total) || 0;
  const totalMatches = Math.abs(itemSum - total) <= cfg.totalTolerance;

  // Either a price mismatch OR a genuine (not N/A) item-count mismatch sends
  // it to Review - N/A never blocks archiving, since most receipts don't
  // print a count to check against at all.
  const needsReview = !totalMatches || itemCountCheck === 'MISMATCH';

  const targetFolder = needsReview
    ? DriveApp.getFolderById(cfg.reviewFolderId)
    : getArchiveTargetFolder_(cfg.archiveRootId, data.receipt_date);

  renameAndMoveFile_(file, id, targetFolder);

  const finalPdfLink = file.getUrl();
  const finalFolderLabel = needsReview
    ? cfg.reviewFolderName
    : cfg.archiveFolderName + ' / ' + new Date(data.receipt_date).getFullYear() + ' / ' +
      Utilities.formatDate(new Date(data.receipt_date), cfg.timezone, 'MMMM');

  // Extraction Log row - written whether it's a clean match or a review case.
  appendExtractionLogRow_(cfg.extractionLogSheet, {
    id: id,
    fileId: file.getId(),
    originalFileName: file.getName(),
    targetFileName: file.getName(),
    storeName: data.store_name,
    receiptDate: data.receipt_date,
    receiptTime: data.receipt_time,
    receiptTotal: total,
    itemSum: Math.round(itemSum * 100) / 100,
    totalCheckStatus: totalMatches ? 'MATCH' : 'MISMATCH',
    reportedItemCount: hasReportedCount ? data.reported_item_count : '',
    extractedItemCount: items.length,
    itemCountCheck: itemCountCheck,
    receiptType: data.receipt_type || 'ITEMIZED',
    parserUsed: extraction.parser,
    reviewStatus: needsReview ? 'NEEDS_REVIEW' : 'OK',
    reviewNotes: data.notes || '',
    manualReviewStatus: '',
    finalFileId: file.getId(),
    finalFolder: finalFolderLabel,
    importBatch: '',
    finalPdfLink: finalPdfLink,
    status: needsReview ? 'REVIEW' : 'PROCESSED',
    error: '',
    comments: ''
  });

  // Itemized rows - added regardless of match status, per your spec
  // ("extracted details added in sheet" even on mismatch).
  appendReceiptLogItems_(cfg.receiptLogSheet, id, data.receipt_date, data.receipt_time,
    data.store_name, items);

  // Payment Details row
  appendPaymentDetailsRow_(cfg.paymentDetailsSheet, {
    id: id,
    date: data.receipt_date,
    time: data.receipt_time,
    storeName: data.store_name,
    receiptTotal: total,
    paymentMethod: data.payment_method || '',
    cardType: data.card_type || '',
    cardNumberMasked: data.card_number_masked || '',
    authCode: data.auth_code || '',
    transactionRef: data.transaction_ref || '',
    receiptType: data.receipt_type || 'ITEMIZED',
    finalFileId: file.getId(),
    finalPdfLink: finalPdfLink,
    comments: ''
  });

  // Explicit contract: false = "not a transient failure" (this file was
  // fully handled). Previously this fell through as `undefined`, which
  // happened to work in processInbox()'s falsy check but was fragile -
  // making it explicit here matches every other return in this function.
  return false;
}

function routeToError_(file, cfg, reason) {
  const errorFolder = DriveApp.getFolderById(cfg.errorFolderId);
  errorFolder.addFile(file); // add new parent first (see renameAndMoveFile_ comment)
  const parents = file.getParents();
  while (parents.hasNext()) {
    const parent = parents.next();
    if (parent.getId() !== errorFolder.getId()) {
      parent.removeFile(file);
    }
  }
  // Per your spec: no sheet row for error files. If you want an audit trail
  // later, log `reason` to Stackdriver/Logger instead:
  Logger.log('ERROR routing ' + file.getName() + ': ' + reason);
}