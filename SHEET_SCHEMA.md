# Sheet schema

The pipeline reads/writes by **header name**, not column position (see
`SheetService.gs`), so column order doesn't matter and you can add extra
columns freely — just make sure every header below exists somewhere in row 1
of its tab, spelled exactly as shown.

You don't have to type these in by hand: run `createSheetStructure_()` from
`Setup.gs` once against a blank spreadsheet and it creates every tab below
with the correct headers already in place. `Store Aliases` and
`Item Reference` are exceptions — the code creates those two automatically
(with example rows) the first time the pipeline runs, so you don't need to
pre-create them.

## `Config`

Two columns, one row per setting:

| Key | Value example |
|---|---|
| `SOURCE_FOLDER_NAME` | `A. INBOX` |
| `NEEDS_REVIEW_FOLDER_NAME` | `B. Needs Review` |
| `ERROR_FOLDER_NAME` | `C. Error` |
| `ARCHIVE_FOLDER_NAME` | `D. ARCHIVE` |
| `DUPLICATE_FOLDER_NAME` | `E. Duplicate` |
| `RECEIPT_LOG_SHEET` | `Receipt Log` |
| `PAYMENT_DETAILS_SHEET` | `Payment Details` |
| `EXTRACTION_LOG_SHEET` | `Extraction Log` |
| `TIMEZONE` | `Europe/London` (any IANA timezone) |
| `TOTAL_TOLERANCE` | `0.01` |
| `PROCESS_LATEST_ONLY` | `true` / `false` |

Secrets and Drive folder IDs are **not** stored here — they live in
**Project Settings → Script Properties** (see README setup steps).

## `Extraction Log` — one row per receipt

`ID`, `Processed At`, `File ID`, `Original File Name`, `Target File Name`,
`Store Name`, `Receipt Date`, `Receipt Time`, `Receipt Total`, `Item Sum`,
`Total Check Status`, `Reported Item Count`, `Extracted Item Count`,
`Item Count Check`, `Receipt Type`, `Parser Used`, `Review Status`,
`Review Notes`, `Manual Review Status`, `Final File ID`, `Final Folder`,
`Import Batch`, `Final PDF Link`, `Status`, `Error`, `Comments`

## `Receipt Log` — one row per line item

`ID`, `Date`, `Time`, `Store Name`, `Item Name`, `My Name`, `Category`,
`Category Source`, `Qty`, `Item Price`, `Total Price`, `Comments`

`Category` and `Category Source` power the dashboard's Categories tab —
`Category Source` is either `Rule` (matched a row in `Item Reference`) or
`AI` (fell back to Gemini's own suggestion).

## `Payment Details` — one row per receipt

`ID`, `Date`, `Time`, `Store Name`, `Receipt Total`, `Payment Method`,
`Card Type`, `Card Number`, `Auth Code`, `Transaction Ref`, `Receipt Type`,
`Final File ID`, `Final PDF Link`, `Comments`

## `Store Aliases` — auto-created on first run

`Keyword` (matches if the AI's store name **contains** this text,
case-insensitive), `Canonical Name`, `Notes`. First matching row wins.

## `Item Reference` — not auto-created, optional

`Keyword`, `Canonical Name`, `Category`. Same first-match-wins pattern as
`Store Aliases`, used by `ItemCategorization.gs` to override Gemini's
per-item suggestion once you've corrected an item name/category — the
correction then applies automatically to every future receipt.
