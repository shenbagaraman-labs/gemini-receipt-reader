# Gemini Receipt Reader

A Google Apps Script pipeline that automatically extracts data from shop,
parking, and fuel receipts using the Gemini API, logs everything to a Google
Sheet, and files the original PDFs/images into dated Drive folders. Includes
a read-only mobile dashboard for browsing spend on the go.

Written up in more detail here: **[Medium article link]**

## How it works

1. Drop a receipt (PDF/image) into a Drive **A. INBOX** folder.
2. A time-driven trigger runs `processInbox()` every 15–30 minutes.
3. Gemini reads the receipt against a structured JSON schema (store, date,
   items, totals, payment details).
4. The extracted total is cross-checked against the sum of line items.
   - Matches → filed into **D. ARCHIVE/\<year\>/\<month\>**
   - Mismatches → filed into **B. Needs Review**
   - Unreadable → filed into **C. Error**
   - Already logged → filed into **E. Duplicate**
5. Every receipt (except errors) gets a row in **Extraction Log**, one row
   per line item in **Receipt Log**, and a row in **Payment Details**.
6. A mobile web dashboard (deployed as an Apps Script Web App) lets you
   browse by year/month, store, spend category, or search items — read-only,
   no write-back to the sheet.

## Two-tier extraction strategy

- **Primary:** `gemini-flash-lite` — generous daily quota, handles the bulk
  of receipts, retried a few times on transient failures.
- **Escalation:** `gemini-flash` (full) — much smaller daily quota, used
  **once** only when the primary result comes back low-confidence or fails
  outright.

Errors are classified (`DAILY_QUOTA` / `RATE_LIMIT` / `SERVER_UNAVAILABLE` /
`NETWORK` / `UNKNOWN`) so a transient Google-side hiccup doesn't wrongly
route a perfectly good receipt to the Error folder.

> Model names move fast — check the
> [Gemini API model docs](https://ai.google.dev/gemini-api/docs/models) for
> current IDs and update `Config.gs` if needed.

## Files

| File | Purpose |
|---|---|
| `Setup.gs` | One-time helper: creates the required sheet tabs + headers on a blank spreadsheet |
| `Config.gs` | Reads settings from a `Config` sheet tab + Script Properties (secrets/IDs); fixed category list |
| `Main.gs` | Orchestration: `processInbox()`, time-budget and transient-failure circuit breakers |
| `GeminiService.gs` | Calls Gemini with a structured JSON schema; retry/escalation/error-classification logic |
| `FileService.gs` | Receipt ID/date normalization, Drive file rename + move logic |
| `StoreAliases.gs` | Normalizes messy AI-read store names via a `Store Aliases` sheet tab |
| `ItemCategorization.gs` | Resolves canonical item name + spend category per line item |
| `SheetService.gs` | Header-name-based row writes (column-order-proof), auto-expands Sheets "Tables" |
| `MenuTools.gs` | Custom **Receipt Tools** menu for manual ID/store-name corrections |
| `DashboardServer.gs` | Read-only server-side query functions + `doGet()` for the web app |
| `Dashboard.html` | Single-file mobile dashboard UI (vanilla JS, no build step) |

## Setup

This is a **Google Apps Script** project (bound to a Google Sheet), not a
standalone Node/web app — there's no `npm install` step.

1. Create a blank Google Sheet, open **Extensions → Apps Script**, add all
   files from this repo (including `Setup.gs`), then run
   `createSheetStructure_()` once from the editor — it creates `Config`,
   `Extraction Log`, `Receipt Log`, and `Payment Details` with the correct
   headers already in place and seeds sensible Config defaults. Full column
   reference: [SHEET_SCHEMA.md](SHEET_SCHEMA.md). `Store Aliases` and
   `Item Reference` are not created by this step — see the schema doc for
   why.
2. Create five Drive folders: **A. INBOX**, **B. Needs Review**,
   **C. Error**, **D. ARCHIVE**, **E. Duplicate**.
3. In the Sheet, open **Extensions → Apps Script** and add all `.gs` files
   and `Dashboard.html` from this repo.
4. In the Apps Script editor, add the **Google Sheets API** advanced service
   (required for auto-expanding the sheet Tables — see `SheetService.gs`).
5. Under **Project Settings → Script Properties**, set:
   - `GEMINI_API_KEY`
   - `INBOX_FOLDER_ID`
   - `ARCHIVE_ROOT_ID`
   - `REVIEW_FOLDER_ID`
   - `ERROR_FOLDER_ID`
   - `DUPLICATE_FOLDER_ID`
6. Fill in the `Config` tab (folder/sheet display names, timezone, total
   tolerance — see `Config.gs` for the exact keys read).
7. Run `processInbox()` manually once against a few test receipts, then
   attach a time-driven trigger (every 15–30 min).
8. (Optional) Deploy as a **Web App** for the mobile dashboard:
   **Execute as: Me**, **Who has access: Only myself** — this gives free
   Google-account auth with no extra code.

### Deploying dashboard changes

Editing code in the Apps Script editor does **not** update a published web
app's live `/exec` URL — it's pinned to whichever version it was deployed
with. To push a change live on the same URL: **Deploy → Manage deployments
→ pencil icon → Version: New version → Deploy**. ("Deploy → New deployment"
creates a separate URL — avoid unless that's what you want.)

## Known limitations

- Designed and tested at personal-use volume (~70–100 receipts/month).
  At several years of history (tens of thousands of itemized rows),
  uncached dashboard lookups (receipt detail, item search) would start to
  slow down — see code comments in `DashboardServer.gs` for the planned
  fix path (`TextFinder`-based lookups instead of full-tab reads).
- Assumes a day-first date format (`DD/MM/YYYY`) in `FileService.gs` — adjust
  the regex there if your receipts use month-first dates instead.
- Read-only dashboard by design — no editing from the mobile UI.

## Roadmap

Planning to rebuild this on **Google Antigravity** — this repo reflects the
original Apps Script implementation.

## License

MIT — see [LICENSE](LICENSE).
