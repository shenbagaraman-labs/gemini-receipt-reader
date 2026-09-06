/**
 * FileService.gs
 * File naming, and moving files between A. INBOX / B. Needs Review /
 * C. Error / D. ARCHIVE/<year>/<month> / E. Duplicate.
 */

/**
 * Best-effort normalization to YYYY-MM-DD. The schema asks Gemini for this
 * format explicitly, but it doesn't always comply (e.g. returning a
 * day-first "22/08/2026" style date). Un-normalized, that breaks both the ID
 * (which then embeds slashes) and the archive year/month folder lookup.
 * Assumes day-first DD/MM/YYYY for slash-separated input - change this if
 * your receipts use a different date convention. Falls back to the
 * original string (logged) if the shape isn't recognized at all.
 */
function normalizeDateString_(rawDate) {
  if (!rawDate) return rawDate;
  const s = String(rawDate).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already correct

  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, '0');
    const month = slashMatch[2].padStart(2, '0');
    const year = slashMatch[3];
    return year + '-' + month + '-' + day; // day-first DD/MM/YYYY -> YYYY-MM-DD
  }

  Logger.log('Could not normalize date "' + s + '" to YYYY-MM-DD - using it as-is; ' +
    'check this receipt\'s ID and archive folder for correctness.');
  return s;
}

/** Uppercase, strip non-alphanumeric, first 12 chars - the rule used everywhere an ID's store segment is built. */
function shortenStoreName_(storeName) {
  return (storeName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

/** e.g. 20260830-141230-ALDI  (matches your existing ID convention) */
function buildReceiptId_(dateStr, timeStr, storeName) {
  const datePart = (dateStr || Utilities.formatDate(new Date(), 'Europe/London', 'yyyyMMdd'))
    .replace(/-/g, '');
  const timePart = (timeStr || '000000').replace(/:/g, '');
  return datePart + '-' + timePart + '-' + shortenStoreName_(storeName);
}

function buildDuplicateKey_(dateStr, timeStr, total) {
  return [dateStr, timeStr, Number(total).toFixed(2)].join('|');
}

/** Finds (or creates) a year/month subfolder under the archive root. */
function getArchiveTargetFolder_(archiveRootId, dateStr) {
  const root = DriveApp.getFolderById(archiveRootId);
  const d = dateStr ? new Date(dateStr) : new Date();
  const year = String(d.getFullYear());
  const month = Utilities.formatDate(d, 'Europe/London', 'MMMM'); // "August" - matches your existing folders

  const yearFolder = getOrCreateSubfolder_(root, year);
  return getOrCreateSubfolder_(yearFolder, month);
}

function getOrCreateSubfolder_(parent, name) {
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}

/**
 * Renames the Drive file and moves it into the target folder. Returns the file.
 * Adds to the target folder FIRST, then removes old parents - never the reverse.
 * A file always has at least one parent, so if the script is force-killed
 * (e.g. Apps Script's 6-minute execution limit) mid-move, the file is still
 * findable in either the old or new folder, never orphaned with zero parents.
 */
function renameAndMoveFile_(file, newBaseName, targetFolder) {
  const ext = file.getName().includes('.') ? file.getName().split('.').pop() : 'pdf';
  file.setName(newBaseName + '.' + ext);

  targetFolder.addFile(file); // add new parent first
  const parents = file.getParents();
  while (parents.hasNext()) {
    const parent = parents.next();
    if (parent.getId() !== targetFolder.getId()) {
      parent.removeFile(file); // then drop old parent(s)
    }
  }
  return file;
}

/** For duplicates: append a short unique suffix so the filename never collides. */
function buildDuplicateFileName_(baseName) {
  const suffix = Utilities.getUuid().slice(0, 6);
  return baseName + '-DUP-' + suffix;
}