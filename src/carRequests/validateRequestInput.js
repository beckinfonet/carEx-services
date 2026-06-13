const ALLOWED_STRING_FIELDS = [
  'exteriorColor',
  'interiorColor',
  'interiorMaterial',
  'engine',
  'fuel',
  'note',
];

const ALLOWED_CURRENCIES = ['KGS', 'USD'];
const DEFAULT_CURRENCY = 'KGS';

function toNumberOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Validate + normalize a CarRequest create/update body.
 * Returns { errors: string[], value: object }. `value` contains only
 * recognized, normalized fields. Caller derives buyerUid/contactPhone
 * server-side — they are intentionally NOT read here.
 */
function validateRequestInput(body = {}) {
  const errors = [];
  const value = {};

  // makeId (required)
  if (!body.makeId || typeof body.makeId !== 'string') {
    errors.push('makeId is required');
  } else {
    value.makeId = body.makeId;
  }

  if (body.modelId && typeof body.modelId === 'string') {
    value.modelId = body.modelId;
  }

  // budgetMax (required, positive)
  const budgetMax = toNumberOrNull(body.budgetMax);
  if (budgetMax === null || Number.isNaN(budgetMax) || budgetMax <= 0) {
    errors.push('budgetMax must be a positive number');
  } else {
    value.budgetMax = budgetMax;
  }

  // budgetMin (optional)
  const budgetMin = toNumberOrNull(body.budgetMin);
  if (budgetMin !== null) {
    if (Number.isNaN(budgetMin) || budgetMin < 0) {
      errors.push('budgetMin must be a non-negative number');
    } else {
      value.budgetMin = budgetMin;
      if (value.budgetMax !== undefined && budgetMin > value.budgetMax) {
        errors.push('budgetMin cannot exceed budgetMax');
      }
    }
  }

  // year range (optional)
  const yearMin = toNumberOrNull(body.yearMin);
  const yearMax = toNumberOrNull(body.yearMax);
  if (yearMin !== null) {
    if (Number.isNaN(yearMin)) errors.push('yearMin must be a number');
    else value.yearMin = yearMin;
  }
  if (yearMax !== null) {
    if (Number.isNaN(yearMax)) errors.push('yearMax must be a number');
    else value.yearMax = yearMax;
  }
  if (value.yearMin !== undefined && value.yearMax !== undefined && value.yearMin > value.yearMax) {
    errors.push('yearMin cannot exceed yearMax');
  }

  // free-text string fields (optional)
  for (const f of ALLOWED_STRING_FIELDS) {
    if (body[f] !== undefined && body[f] !== null && String(body[f]).trim() !== '') {
      value[f] = String(body[f]).trim();
    }
  }

  // telegram (optional, strip leading @)
  if (body.telegramUsername && String(body.telegramUsername).trim() !== '') {
    value.telegramUsername = String(body.telegramUsername).trim().replace(/^@+/, '');
  }

  // currency (optional, normalize to KGS|USD; forgiving — unrecognized falls back to KGS)
  const normalizedCurrency = String(body.currency || '').trim().toUpperCase();
  value.currency = ALLOWED_CURRENCIES.includes(normalizedCurrency)
    ? normalizedCurrency
    : DEFAULT_CURRENCY;

  return { errors, value };
}

module.exports = { validateRequestInput };
