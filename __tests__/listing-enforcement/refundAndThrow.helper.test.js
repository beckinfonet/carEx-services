// __tests__/listing-enforcement/refundAndThrow.helper.test.js
//
// Phase 9 Plan 09-01 — Wave 0 helper unit tests. This is the ONE Wave 0 scaffold
// that ends GREEN at end of Plan 09-01:
//   - At end of Task 1 (this file's creation): RED because Task 2 hasn't created
//     `../../src/payments/refundAndThrow` yet (intentional missing-module gate).
//   - At end of Task 2: still RED — helper exists but unit cases haven't been
//     verified yet (the file is here from Task 1 with the real assertions).
//   - At end of Task 3: GREEN — Task 3 completes by running this file and
//     locking it as the regression gate for the D-14 helper contract.
//
// Locked unit cases (5 base, per Plan 09-01 §Task 3 action body):
//   1. listing_not_available branch — idempotencyKey passed correctly + single call
//   2. listing_not_available branch — throws ListingNotAvailableError with enriched body
//   3. Stripe failure mode — refundFailed: true / refundId: null / console.error logged
//   4. provider_suspended branch — throws ProviderSuspendedError (NOT ListingNotAvailableError)
//      → preserves v1.0 contract
//   5. Refund-first-throw-second ordering — refundOrder < throwOrder invariant
//
// Stripe mock factory per Shared Pattern S-7 (mirrors
// __tests__/enforcement/confirmBooking.transaction.test.js:26-36). No
// MongoMemoryServer — `refundAndThrow` is pure JS + Stripe; no DB.

jest.mock('stripe', () => {
  const refundsCreateMock = jest.fn();
  const stripeFactory = () => ({
    refunds: { create: refundsCreateMock },
  });
  stripeFactory.__refundsCreateMock = refundsCreateMock;
  return stripeFactory;
});

const stripeFactory = require('stripe');
const {
  refundAndThrow,
  ListingNotAvailableError,
} = require('../../src/payments/refundAndThrow');

const stripe = stripeFactory();

beforeEach(() => {
  stripeFactory.__refundsCreateMock.mockReset();
  stripeFactory.__refundsCreateMock.mockResolvedValue({ id: 're_mock_123' });
});

describe('refundAndThrow helper (D-14 + D-11 contract)', () => {
  // -------------------------------------------------------------------------
  // Case 1 — idempotencyKey + call shape
  // -------------------------------------------------------------------------
  test('refundAndThrow with listing_not_available calls stripe.refunds.create ONCE with idempotencyKey `refund-pi_XXX`', async () => {
    await expect(
      refundAndThrow(stripe, 'pi_abc', {
        error: 'listing_not_available',
        listingStatus: 'suspended',
        reasonCategory: 'spam',
        banner: { titleKey: 'tk', bodyKey: 'bk', severity: 'warning' },
      })
    ).rejects.toThrow();

    expect(stripeFactory.__refundsCreateMock).toHaveBeenCalledTimes(1);
    expect(stripeFactory.__refundsCreateMock).toHaveBeenCalledWith(
      { payment_intent: 'pi_abc' },
      { idempotencyKey: 'refund-pi_abc' }
    );
  });

  // -------------------------------------------------------------------------
  // Case 2 — ListingNotAvailableError carries enriched body
  // -------------------------------------------------------------------------
  test('refundAndThrow with listing_not_available throws ListingNotAvailableError carrying enriched body', async () => {
    await expect(
      refundAndThrow(stripe, 'pi_xyz', {
        error: 'listing_not_available',
        listingStatus: 'suspended',
        reasonCategory: 'spam',
        banner: { titleKey: 'tk', bodyKey: 'bk', severity: 'warning' },
      })
    ).rejects.toMatchObject({
      name: 'ListingNotAvailableError',
      error: 'listing_not_available',
      listingStatus: 'suspended',
      reasonCategory: 'spam',
      refundId: 're_mock_123',
      refundFailed: false,
    });

    // Sanity: confirm the instanceof contract holds — server.js handler maps
    // err instanceof ListingNotAvailableError → 409 in Plan 09-04/09-05.
    let caught;
    try {
      await refundAndThrow(stripe, 'pi_xyz2', {
        error: 'listing_not_available',
        listingStatus: 'archived',
        reasonCategory: 'inactive_seller',
        banner: { titleKey: 'tk2', bodyKey: 'bk2', severity: 'neutral' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ListingNotAvailableError);
    expect(caught.message).toBe('listing_not_available');
  });

  // -------------------------------------------------------------------------
  // Case 3 — Stripe failure mode (refundFailed: true / refundId: null / logged)
  // -------------------------------------------------------------------------
  test('Stripe failure mode: refunds.create throws → thrown error has refundFailed: true, refundId: null', async () => {
    stripeFactory.__refundsCreateMock.mockRejectedValueOnce(new Error('stripe down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    let caught;
    try {
      await refundAndThrow(stripe, 'pi_fail', {
        error: 'listing_not_available',
        listingStatus: 'suspended',
        reasonCategory: 'spam',
        banner: null,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.refundFailed).toBe(true);
    expect(caught.refundId).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    // First arg of the console.error call is the literal log prefix from
    // refundAndThrow's catch block.
    const firstCallArgs = errorSpy.mock.calls[0];
    expect(firstCallArgs[0]).toBe('[refundAndThrow] Stripe refund failed:');

    errorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Case 4 — provider_suspended preserves v1.0 ProviderSuspendedError contract.
  // D-15 regression coverage: existing 7-case suite in
  // __tests__/enforcement/confirmBooking.transaction.test.js exercises the
  // provider-suspended discriminator at cases 2, 5, 6. This unit case adds
  // direct helper-level coverage so any regression in the discriminator branch
  // shows up here (faster signal than the full transactional suite).
  // -------------------------------------------------------------------------
  test('refundAndThrow with provider_suspended throws ProviderSuspendedError (NOT ListingNotAvailableError) — preserves v1.0 contract', async () => {
    let caught;
    try {
      await refundAndThrow(stripe, 'pi_psupp', {
        error: 'provider_suspended',
        providerUid: 'uid-provider-1',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      name: 'ProviderSuspendedError',
      providerUid: 'uid-provider-1',
      refundId: 're_mock_123',
      refundFailed: false,
    });
    expect(caught).not.toBeInstanceOf(ListingNotAvailableError);
    // message is the error code string from v1.0 ProviderSuspendedError
    // constructor — preserves what server.js:1061 instanceof + body shape.
    expect(caught.message).toBe('provider_suspended');
  });

  // -------------------------------------------------------------------------
  // Case 5 — Refund-first-throw-second ordering invariant.
  // The single most load-bearing invariant of the helper: stripe.refunds.create
  // MUST complete (or fail) BEFORE the throw escapes. Using mock invocationCallOrder
  // plus a side-effect counter that increments in the mockImplementation and again
  // in the catch block — assert refundOrder < throwOrder.
  // -------------------------------------------------------------------------
  test('Refund-first-throw-second invocation ordering: stripe.refunds.create completes BEFORE the throw escapes the helper', async () => {
    let order = 0;
    let refundOrder = null;
    let throwOrder = null;

    stripeFactory.__refundsCreateMock.mockImplementation(() => {
      refundOrder = ++order;
      return Promise.resolve({ id: 're_ordering_1' });
    });

    try {
      await refundAndThrow(stripe, 'pi_order', {
        error: 'listing_not_available',
        listingStatus: 'suspended',
        reasonCategory: 'spam',
        banner: null,
      });
    } catch (_err) {
      throwOrder = ++order;
    }

    expect(refundOrder).not.toBeNull();
    expect(throwOrder).not.toBeNull();
    expect(refundOrder).toBeLessThan(throwOrder);
  });
});
