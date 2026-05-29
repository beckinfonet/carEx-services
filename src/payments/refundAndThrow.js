// src/payments/refundAndThrow.js
//
// Phase 9 Plan 09-01 — shared refund-first-throw-second helper extracted from
// the inline `refundThenThrow` that lived at confirmBooking.js:38-56 in v1.0.
// Owns the D-11 invariant: Stripe refund call MUST complete (or fail) BEFORE
// any throw escapes the function.
//
// CONTEXT REFERENCES:
//   - D-14 (helper extraction) — exports `refundAndThrow` and `ListingNotAvailableError`
//   - D-11 (refund-first-throw-second invariant + 409 body shape)
//   - D-15 (regression: existing 3 v1.0 ProviderSuspendedError throw sites must
//     keep working after the call-site rewire — covered by
//     __tests__/enforcement/confirmBooking.transaction.test.js cases 2/3/4/5/6)
//
// CIRCULAR-REQUIRE NOTE (Option A from PATTERNS §6):
//   ProviderSuspendedError was previously defined at confirmBooking.js:31-36.
//   Moving it here is the cleanest way to avoid a `confirmBooking <-> refundAndThrow`
//   require cycle. confirmBooking.js re-exports it for back-compat so existing
//   `require('./confirmBooking').ProviderSuspendedError` AND every
//   `err instanceof ProviderSuspendedError` check at server.js:1061 keep working.
//
// IDEMPOTENCY (RESEARCH §Pitfall 3 / Open Question A3):
//   The Stripe refund call passes a per-PaymentIntent idempotent key (see the
//   second arg to stripe.refunds.create below) so `session.withTransaction()`'s
//   auto-retry on transient errors cannot trigger a second refund. The v1.0
//   inline function did NOT pass this key — by routing the existing 3
//   ProviderSuspendedError call sites through this helper, those v1.0 sites
//   become idempotency-protected too. No further retrofit needed.

class ListingNotAvailableError extends Error {
  constructor(body) {
    super(body.error);
    this.name = 'ListingNotAvailableError';
    // Object.assign so .listingStatus / .reasonCategory / .banner / .refundId /
    // .refundFailed hang directly off the error instance — server.js route
    // handler reads them when building the 409 body in Plan 09-04/09-05.
    Object.assign(this, body);
  }
}

class ProviderSuspendedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderSuspendedError';
  }
}

/**
 * Refund-first-throw-second helper. Always throws; never resolves.
 *
 * @param {object} stripe — Stripe SDK instance (injected from caller).
 * @param {string} paymentIntentId — PI to refund.
 * @param {object} errorBody — discriminated by `errorBody.error`:
 *   - 'listing_not_available' → throws ListingNotAvailableError carrying the
 *     full enriched body (D-11 shape: error + listingStatus + reasonCategory +
 *     banner + refundId + refundFailed).
 *   - anything else (e.g. 'provider_suspended') → throws ProviderSuspendedError
 *     with the error code as the message, plus Object.assign of the enriched
 *     body so { providerUid, refundId, refundFailed } hang off the error.
 *
 * Order is load-bearing: stripe.refunds.create is called FIRST. If it succeeds,
 * refundId carries the Stripe refund ID and refundFailed stays false. If it
 * throws, refundId stays null and refundFailed flips to true (the error is
 * logged via console.error but swallowed — the helper still throws the
 * domain error so the caller's transaction aborts).
 *
 * @returns {Promise<never>} — always rejects.
 */
async function refundAndThrow(stripe, paymentIntentId, errorBody) {
  let refundId = null;
  let refundFailed = false;
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: paymentIntentId },
      { idempotencyKey: `refund-${paymentIntentId}` }
    );
    refundId = refund.id;
  } catch (err) {
    refundFailed = true;
    // eslint-disable-next-line no-console
    console.error('[refundAndThrow] Stripe refund failed:', err);
  }
  const enriched = { ...errorBody, refundId, refundFailed };
  if (errorBody.error === 'listing_not_available') {
    throw new ListingNotAvailableError(enriched);
  }
  // v1.0 contract: ProviderSuspendedError carries errorBody.error as message
  // (e.g. 'provider_suspended') so existing route handler at server.js:1061
  // `err.message === 'provider_suspended'` checks keep working AND
  // `instanceof ProviderSuspendedError` keeps working.
  const err = new ProviderSuspendedError(errorBody.error);
  Object.assign(err, enriched);
  throw err;
}

module.exports = { refundAndThrow, ListingNotAvailableError, ProviderSuspendedError };
