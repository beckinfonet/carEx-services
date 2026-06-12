const DEFAULT_AMOUNT = 500;
const DEFAULT_CURRENCY = 'KGS';

/**
 * Server-authoritative flat unlock fee. Admin-changeable via env without a
 * mobile release. Returns { amount, currency }. Invalid/non-positive amounts
 * fall back to the default so a bad env value can never produce a free unlock.
 */
function getUnlockPrice() {
  const raw = Number(process.env.REQUEST_UNLOCK_PRICE);
  const amount = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AMOUNT;
  const currency = process.env.REQUEST_UNLOCK_CURRENCY || DEFAULT_CURRENCY;
  return { amount, currency };
}

module.exports = { getUnlockPrice, DEFAULT_AMOUNT, DEFAULT_CURRENCY };
