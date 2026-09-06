/**
 * GeminiService.gs
 * Calls the Gemini API with a receipt image/PDF and a structured JSON schema,
 * so you get parseable output instead of freeform text.
 *
 * Two-tier strategy (see Config.gs): Flash-Lite as primary (500 RPD budget),
 * full Flash as a single-shot escalation for shaky reads (only 20 RPD).
 * A model reporting its DAILY quota is exhausted is never retried again in
 * the same run - retrying a per-day cap before midnight Pacific is pure
 * waste. RPM/503 "high demand" errors still get normal retries.
 *
 * NOTE: model names move fast. Check
 * https://ai.google.dev/gemini-api/docs/models for the current model IDs
 * before your first run, and update Config.gs if needed.
 *
 * CATEGORIZATION: each item's schema also asks Gemini for suggested_name /
 * suggested_category (see ItemCategorization.gs). buildReceiptSchema_() is a
 * FUNCTION rather than a top-level const specifically because it references
 * CATEGORY_LIST (declared in Config.gs) - Apps Script doesn't guarantee
 * which .gs file's top-level code runs first, so embedding CATEGORY_LIST
 * directly into a top-level const here could throw "Cannot access
 * 'CATEGORY_LIST' before initialization" depending on file load order.
 * Building it lazily inside a function sidesteps that entirely, since by
 * the time any function actually runs, the whole project has finished
 * loading and every top-level const is available.
 */

function buildReceiptSchema_() {
  return {
    type: 'OBJECT',
    properties: {
      store_name: { type: 'STRING' },
      receipt_date: { type: 'STRING', description: 'YYYY-MM-DD' },
      receipt_time: { type: 'STRING', description: 'HH:MM:SS, empty string if not visible' },
      receipt_type: { type: 'STRING', enum: ['ITEMIZED', 'PARKING', 'FUEL', 'OTHER'] },
      payment_method: { type: 'STRING' },
      card_type: { type: 'STRING' },
      card_number_masked: { type: 'STRING' },
      auth_code: { type: 'STRING' },
      transaction_ref: { type: 'STRING' },
      receipt_total: { type: 'NUMBER' },
      reported_item_count: {
        type: 'NUMBER',
        description: 'The item/product count if EXPLICITLY PRINTED on the receipt ' +
          '(e.g. "ITEMS SOLD 12", "NO. OF ITEMS: 8"). Omit this field entirely if no ' +
          'such count is printed - do not guess or compute it yourself.'
      },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            qty: { type: 'NUMBER' },
            unit_price: { type: 'NUMBER', description: 'Negative for discounts/refunds' },
            uncertain: { type: 'BOOLEAN' },
            suggested_name: {
              type: 'STRING',
              description:
                'A short, clean, human-friendly name for this item (e.g. "Milk", ' +
                '"Free Range Eggs", "Petit Filous"). Prefer an exact match from the ' +
                'CANONICAL NAMES list in the prompt if this item matches one of them.'
            },
            suggested_category: {
              type: 'STRING',
              enum: CATEGORY_LIST,
              description:
                'The single best-fit category for this item from the fixed list ' +
                'provided in the prompt. Use "Uncategorized" only if genuinely unclear.'
            }
          },
          // Deliberately NOT requiring suggested_name/suggested_category - a
          // missing/blank value here just falls back to Gemini's raw item
          // name and "Uncategorized" in applyItemCategorization_(), rather
          // than failing the whole receipt over a categorization miss.
          required: ['name', 'unit_price', 'uncertain']
        }
      },
      confidence: { type: 'STRING', enum: ['high', 'low'] },
      notes: { type: 'STRING' }
    },
    required: ['store_name', 'receipt_date', 'receipt_total', 'items', 'confidence']
  };
}

const EXTRACTION_PROMPT_ = `You are extracting structured data from a photo or PDF of a shop
receipt, parking ticket, or fuel receipt. Read every line carefully.

Rules:
- Extract the store/vendor name, date, and time exactly as printed.
- Produce a clean itemized list: one entry per line item, with quantity and price.
- Any discount, coupon, or refund line must be its own item entry with a NEGATIVE
  unit_price and a name starting with "DISCOUNT:" or "REFUND:" - never fold it
  into another item's price.
- If a character, price, or item name is genuinely illegible or ambiguous, set
  "uncertain": true for that item rather than guessing a plausible value.
- receipt_total must be the final total actually charged/paid on the receipt.
- If the receipt explicitly prints its own item count (e.g. "ITEMS SOLD 12"),
  extract it as reported_item_count. Do NOT compute or guess this yourself -
  omit the field entirely if no such count is printed anywhere on the receipt.
- Set "confidence": "low" if the image quality made more than a couple of fields
  hard to read, so a human knows to double check it.
- If this is not a valid receipt/ticket, set store_name to "UNREADABLE" and
  confidence to "low".
Return only the structured data - no commentary.`;

/**
 * Calls Gemini with the given file blob. Returns parsed JSON object, or
 * throws on hard failure (network/API error) so the caller can route the
 * file to the Error folder.
 */
function extractReceiptData_(blob, model, apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    model + ':generateContent?key=' + encodeURIComponent(apiKey);

  // Appends the categorization instructions (fixed category list + your
  // confirmed canonical item names, pulled from the "Item Reference" tab)
  // to the base extraction prompt. See ItemCategorization.gs.
  const fullPrompt = EXTRACTION_PROMPT_ + buildCategorizationPromptAddition_();

  const payload = {
    contents: [{
      parts: [
        { text: fullPrompt },
        {
          inline_data: {
            mime_type: blob.getContentType(),
            data: Utilities.base64Encode(blob.getBytes())
          }
        }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildReceiptSchema_()
      // Note: temperature/top_p/top_k are deprecated on Gemini 3.x models
      // (silently ignored, not an error) - omitted rather than left misleading.
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Gemini API error ' + code + ': ' + response.getContentText());
  }

  const body = JSON.parse(response.getContentText());
  const candidate = body.candidates && body.candidates[0];
  if (!candidate) throw new Error('Gemini returned no candidates');

  const text = candidate.content.parts.map(p => p.text || '').join('');
  return JSON.parse(text); // schema-constrained, so this should always be valid JSON
}

const MAX_PRIMARY_ATTEMPTS_ = 3;
const RETRY_BACKOFF_MS_ = 1500; // base delay; doubles each retry

/**
 * Classifies an API failure so callers can decide how to react, instead of
 * treating every non-200 response the same way. Returns one of:
 *   'DAILY_QUOTA'         - per-day cap hit (resets midnight Pacific).
 *                           Retrying this model again THIS RUN is futile.
 *   'RATE_LIMIT'          - per-minute/other short-window quota. May clear
 *                           within seconds - normal retry is reasonable.
 *   'SERVER_UNAVAILABLE'  - Google-side capacity/infra issue (5xx, overload,
 *                           deadline exceeded) - not your data, not your quota.
 *   'NETWORK'             - request never reached/returned from Google at all
 *                           (timeout, DNS, connection reset).
 *   'UNKNOWN'             - anything else (malformed request, genuinely bad
 *                           file content, unexpected response shape) - treated
 *                           as a real failure, eligible for the Error folder.
 */
function classifyApiError_(err) {
  const s = String(err);
  if (s.indexOf('GenerateRequestsPerDayPerProjectPerModel') !== -1 || s.indexOf('PerDay') !== -1) {
    return 'DAILY_QUOTA';
  }
  if (s.indexOf('"code": 429') !== -1 || s.indexOf('RESOURCE_EXHAUSTED') !== -1) {
    return 'RATE_LIMIT';
  }
  if (s.indexOf('"code": 503') !== -1 || s.indexOf('"code": 500') !== -1 ||
    s.indexOf('"code": 502') !== -1 || s.indexOf('"code": 504') !== -1 ||
    s.indexOf('UNAVAILABLE') !== -1 || s.indexOf('DEADLINE_EXCEEDED') !== -1 ||
    s.indexOf('"status": "INTERNAL"') !== -1) {
    return 'SERVER_UNAVAILABLE';
  }
  const lower = s.toLowerCase();
  if (lower.indexOf('address unavailable') !== -1 || lower.indexOf('timeout') !== -1 ||
    lower.indexOf('timed out') !== -1 || lower.indexOf('dns') !== -1 ||
    lower.indexOf('connection reset') !== -1) {
    return 'NETWORK';
  }
  return 'UNKNOWN';
}

/** True for any Google-side/infrastructure failure - not a bad receipt, just bad timing. */
function isTransientApiError_(err) {
  return classifyApiError_(err) !== 'UNKNOWN';
}

/**
 * True specifically for a DAILY quota cap - retrying the same model again
 * in this run cannot possibly succeed until it resets at midnight Pacific.
 * Skip straight to giving up on that model rather than burning retry
 * attempts/time (and, per Google's own quirk, likely more quota) on a
 * guaranteed failure.
 */
function isDailyQuotaError_(err) {
  return classifyApiError_(err) === 'DAILY_QUOTA';
}

/**
 * Tries one model up to maxAttempts times. Stops immediately (no further
 * retries) if a daily quota error is seen, since retrying can't help until
 * tomorrow. Returns { data, parser, errors } - data is null on total failure.
 */
function tryModelWithRetries_(blob, cfg, model, maxAttempts) {
  const errors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cfg.deadline && Date.now() > cfg.deadline) {
      throw new Error('TIME_BUDGET_EXCEEDED: ran out of time before ' + model + ' attempt ' + attempt);
    }
    try {
      const data = extractReceiptData_(blob, model, cfg.geminiApiKey);
      return { data: data, parser: model, errors: errors };
    } catch (err) {
      errors.push(err);
      Logger.log('Attempt ' + attempt + ' (' + model + ') failed: ' + err);
      if (isDailyQuotaError_(err)) {
        Logger.log(model + ' has hit its DAILY quota - not retrying this model again this run.');
        break;
      }
      if (attempt < maxAttempts) {
        Utilities.sleep(RETRY_BACKOFF_MS_ * attempt); // simple linear backoff
      }
    }
  }
  return { data: null, parser: null, errors: errors };
}

/**
 * Primary model (Flash-Lite, generous quota) does the real work, retried up
 * to MAX_PRIMARY_ATTEMPTS_ times. If it succeeds cleanly, that's the answer.
 * If it comes back shaky (low confidence/uncertain items) or fails outright,
 * escalate ONCE to a stronger model (full Flash, scarce quota) - never more
 * than a single attempt there, to conserve that tiny daily budget.
 * If escalation isn't available/fails but the primary DID produce a shaky
 * result, that result is still used (better than losing the receipt) - it'll
 * surface in Review with its uncertain flags intact.
 * Throws only if nothing usable came back at all; the message is prefixed
 * TRANSIENT_API_FAILURE if every failure was capacity/quota-related.
 */
function extractReceiptWithFallback_(blob, cfg) {
  const primary = tryModelWithRetries_(blob, cfg, cfg.modelPrimary, MAX_PRIMARY_ATTEMPTS_);

  let shakyResult = null;
  if (primary.data) {
    const looksShaky = primary.data.confidence === 'low' ||
      primary.data.store_name === 'UNREADABLE' ||
      (primary.data.items || []).some(i => i.uncertain);
    if (!looksShaky) {
      return { data: primary.data, parser: primary.parser };
    }
    shakyResult = { data: primary.data, parser: primary.parser };
  }

  const hardErrors = primary.errors || [];

  if (cfg.modelEscalation) {
    if (cfg.deadline && Date.now() > cfg.deadline) {
      if (shakyResult) return shakyResult;
      throw new Error('TIME_BUDGET_EXCEEDED: ran out of time before escalation attempt');
    }
    const escalation = tryModelWithRetries_(blob, cfg, cfg.modelEscalation, 1); // scarce quota - one shot only
    if (escalation.data) {
      return { data: escalation.data, parser: cfg.modelEscalation + ' (escalation)' };
    }
    hardErrors.push.apply(hardErrors, escalation.errors);
  }

  if (shakyResult) {
    return { data: shakyResult.data, parser: shakyResult.parser + ' (escalation unavailable)' };
  }

  const allTransient = hardErrors.length > 0 && hardErrors.every(isTransientApiError_);
  throw new Error((allTransient ? 'TRANSIENT_API_FAILURE: ' : '') +
    hardErrors.length + ' error(s), last: ' + hardErrors[hardErrors.length - 1]);
}