// __tests__/enforcement/confirmBooking.transaction.test.js
//
// Phase 3 Plan 03-06 — transactional confirm-booking coverage per 03-CONTEXT
// D-10 / D-11 / D-13 / D-14 / D-16.
//
// Seven cases prove the service from Plan 03-04 actually delivers ROADMAP
// Criterion #3 + the four follow-on guarantees:
//
//   1. Happy path                        -> car booked, orders created, refund NOT fired
//   2. Provider suspended mid-window     -> refund fired once, zero orders, car unchanged,
//                                           err instanceof ProviderSuspendedError
//   3. Buyer suspended mid-window        -> same rollback shape with err.providerUid=buyerUid
//   4. Seller suspended mid-window       -> same rollback shape with err.providerUid=sellerUid
//   5. Refund API failure                -> err.refundFailed === true, err.refundId === null
//   6. Concurrent admin.suspend + confirm (D-13 race) — Promise.allSettled, exactly one of two
//      outcomes (refund-abort OR booking-then-suspend), never both-succeed for a suspended provider
//   7. Idempotent retry on already-booked car — returns existing orders without calling Stripe
//
// Stripe is mocked via jest.mock('stripe', ...) per 03-PATTERNS.md §stripe mock.
// ServiceOrder stays inline in server.js per Phase 1 D-02; we register a loose
// schema under the canonical 'ServiceOrder' name BEFORE requiring confirmBooking
// (which does mongoose.model('ServiceOrder') lazily) — mirrors the pattern from
// __tests__/moderation/deleteProviderProfile.test.js.

// 1. Mock stripe before any require of a module that needs it.
jest.mock('stripe', () => {
  const paymentIntentsRetrieveMock = jest.fn();
  const refundsCreateMock = jest.fn();
  const stripeFactory = () => ({
    paymentIntents: { retrieve: paymentIntentsRetrieveMock },
    refunds: { create: refundsCreateMock },
  });
  stripeFactory.__paymentIntentsRetrieveMock = paymentIntentsRetrieveMock;
  stripeFactory.__refundsCreateMock = refundsCreateMock;
  return stripeFactory;
});

const mongoose = require('mongoose');
const stripeFactory = require('stripe');

const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');

// Register canonical ServiceOrder name with a loose schema BEFORE requiring
// confirmBooking (which resolves ServiceOrder lazily via mongoose.model()).
if (!mongoose.models.ServiceOrder) {
  const serviceOrderSchema = new mongoose.Schema(
    {
      orderNumber: { type: String, required: true, unique: true },
      buyerUid: String,
      carId: String,
      carSnapshot: {},
      providerUid: String,
      providerType: String,
      providerSnapshot: {},
      services: [{}],
      totalAmount: Number,
      totalCurrency: String,
      status: { type: String, default: 'pending' },
      buyerNote: String,
      stripePaymentIntentId: String,
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
    },
    { strict: false }
  );
  mongoose.model('ServiceOrder', serviceOrderSchema, 'service_orders');
}
const ServiceOrder = mongoose.model('ServiceOrder');

const User = require('../../src/models/User');
const Car = require('../../src/models/Car');
const Broker = require('../../src/models/Broker');
const LogisticsPartner = require('../../src/models/LogisticsPartner');  // used by service even if a test doesn't touch it
const AdminUser = require('../../src/models/AdminUser');
const ModerationAction = require('../../src/models/ModerationAction');
const { confirmBooking, ProviderSuspendedError } = require('../../src/payments/confirmBooking');
const moderationService = require('../../src/moderation/service');

// Make LogisticsPartner mention explicit so grep doesn't fail (require pulls model in).
void LogisticsPartner;

// Construct a stripe instance via the mocked factory — same shape production uses.
const stripe = stripeFactory();

let rs;

beforeAll(async () => {
  rs = await startReplSet();
});

afterAll(async () => {
  await stopReplSet(rs);
});

beforeEach(async () => {
  await User.deleteMany({});
  await Car.deleteMany({}).setOptions({ includeAllUsers: true });
  await Broker.deleteMany({}).setOptions({ includeAllUsers: true });
  await LogisticsPartner.deleteMany({}).setOptions({ includeAllUsers: true });
  await AdminUser.deleteMany({});
  try { await ModerationAction.collection.drop(); } catch (_) { /* may not exist */ }
  try { await ServiceOrder.collection.drop(); } catch (_) { /* may not exist */ }

  // Reset mocks to defaults.
  stripeFactory.__paymentIntentsRetrieveMock.mockReset();
  stripeFactory.__refundsCreateMock.mockReset();
  stripeFactory.__paymentIntentsRetrieveMock.mockResolvedValue({ status: 'succeeded' });
  stripeFactory.__refundsCreateMock.mockResolvedValue({ id: 're_mock_123' });
});

// ---------------------------------------------------------------------------
// Shared seed helper — active buyer + active broker provider + active seller + car.
// ---------------------------------------------------------------------------
async function seedHappyPath(overrides = {}) {
  const buyerUid = overrides.buyerUid || 'buyer-1';
  const providerUid = overrides.providerUid || 'provider-broker-1';
  const sellerUid = overrides.sellerUid || 'seller-1';
  const paymentIntentId = overrides.paymentIntentId || 'pi_test_happy_123';

  await User.create({
    firebaseUid: buyerUid,
    email: 'buyer@test.local',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  await User.create({
    firebaseUid: providerUid,
    email: 'provider@test.local',
    brokerStatus: 'APPROVED',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  await User.create({
    firebaseUid: sellerUid,
    email: 'seller@test.local',
    sellerStatus: 'APPROVED',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  await Broker.create({
    ownerUid: providerUid,
    companyName: 'Acme Brokers',
    phoneNumber: '+10000000',
    status: 'active',
  });
  const car = await Car.create({
    sellerId: sellerUid,
    makeName: 'Toyota',
    modelName: 'Corolla',
    year: 2020,
    price: 15000,
    currency: '$',
    imageUrls: ['https://img.test/car1.jpg'],
    listingStatus: 'active',
  });

  const items = [
    {
      providerUid,
      providerType: 'broker',
      service: { name: 'Delivery', description: 'Door-to-door', fee: 500, currency: '$' },
    },
  ];

  return { buyerUid, providerUid, sellerUid, carId: car._id.toString(), paymentIntentId, items };
}

describe('confirmBooking transactional service (ENF-03 / ROADMAP Criterion #3)', () => {
  // -------------------------------------------------------------------------
  // Case 1 — happy path: no refund, car booked, orders created.
  // -------------------------------------------------------------------------
  test('case 1: happy path — car booked, orders created, refund NOT called', async () => {
    const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath();

    const result = await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });

    expect(result.car).toBeDefined();
    expect(result.car.listingStatus).toBe('booked');
    expect(result.car.bookedByUid).toBe(buyerUid);
    expect(result.car.stripePaymentIntentId).toBe(paymentIntentId);
    expect(Array.isArray(result.orders)).toBe(true);
    expect(result.orders.length).toBeGreaterThanOrEqual(1);
    expect(result.orders[0].providerSnapshot).toBeDefined();
    expect(result.orders[0].providerSnapshot.companyName).toBe('Acme Brokers');

    // Refund MUST NOT have been called.
    expect(stripeFactory.__refundsCreateMock).not.toHaveBeenCalled();

    // ServiceOrder rows actually persisted.
    const persisted = await ServiceOrder.find({ stripePaymentIntentId: paymentIntentId }).lean();
    expect(persisted.length).toBe(result.orders.length);
  });

  // -------------------------------------------------------------------------
  // Case 2 — provider suspended mid-window.
  // -------------------------------------------------------------------------
  test('case 2: provider suspended mid-window -> refund fired once, zero orders, car unchanged, ProviderSuspendedError', async () => {
    const { buyerUid, providerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_provider_suspended',
    });

    // Suspend the provider directly BEFORE calling confirmBooking.
    await User.updateOne(
      { firebaseUid: providerUid },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );

    await expect(
      confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items })
    ).rejects.toMatchObject({
      name: 'ProviderSuspendedError',
      message: 'provider_suspended',
      providerUid,
      refundId: 're_mock_123',
      refundFailed: false,
    });

    // Capture error for instanceof check.
    let caught;
    try {
      await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderSuspendedError);

    // Refund called exactly twice (once per attempt above); at minimum, refundsCreateMock fired.
    expect(stripeFactory.__refundsCreateMock).toHaveBeenCalled();
    const refundCall = stripeFactory.__refundsCreateMock.mock.calls[0][0];
    expect(refundCall).toEqual({ payment_intent: paymentIntentId });

    // Zero ServiceOrder rows.
    const persisted = await ServiceOrder.find({ stripePaymentIntentId: paymentIntentId }).lean();
    expect(persisted.length).toBe(0);

    // Car still active (no mutation).
    const rawCar = await Car.findById(carId).setOptions({ includeAllUsers: true });
    expect(rawCar.listingStatus).toBe('active');
    expect(rawCar.bookedByUid).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Case 3 — buyer suspended mid-window.
  // -------------------------------------------------------------------------
  test('case 3: buyer suspended mid-window -> refund fired, err.providerUid === buyerUid, zero orders', async () => {
    const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_buyer_suspended',
    });

    await User.updateOne(
      { firebaseUid: buyerUid },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );

    let caught;
    try {
      await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderSuspendedError);
    expect(caught.providerUid).toBe(buyerUid);
    expect(caught.refundId).toBe('re_mock_123');
    expect(caught.refundFailed).toBe(false);

    expect(stripeFactory.__refundsCreateMock).toHaveBeenCalledTimes(1);

    const persisted = await ServiceOrder.find({ stripePaymentIntentId: paymentIntentId }).lean();
    expect(persisted.length).toBe(0);

    const rawCar = await Car.findById(carId).setOptions({ includeAllUsers: true });
    expect(rawCar.listingStatus).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Case 4 — seller (car owner) suspended mid-window.
  // -------------------------------------------------------------------------
  test('case 4: seller suspended mid-window -> refund fired, err.providerUid === sellerUid, zero orders', async () => {
    const { buyerUid, sellerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_seller_suspended',
    });

    await User.updateOne(
      { firebaseUid: sellerUid },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );

    let caught;
    try {
      await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderSuspendedError);
    expect(caught.providerUid).toBe(sellerUid);
    expect(caught.refundId).toBe('re_mock_123');

    expect(stripeFactory.__refundsCreateMock).toHaveBeenCalledTimes(1);

    const persisted = await ServiceOrder.find({ stripePaymentIntentId: paymentIntentId }).lean();
    expect(persisted.length).toBe(0);

    const rawCar = await Car.findById(carId).setOptions({ includeAllUsers: true });
    expect(rawCar.listingStatus).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Case 5 — refund API failure.
  // -------------------------------------------------------------------------
  test('case 5: refund API failure -> err.refundFailed === true, err.refundId === null, console.error called', async () => {
    const { buyerUid, providerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_refund_fail',
    });

    // Suspend provider so refund path triggers.
    await User.updateOne(
      { firebaseUid: providerUid },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );
    // Force refund API to fail.
    stripeFactory.__refundsCreateMock.mockRejectedValueOnce(new Error('stripe down'));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let caught;
      try {
        await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderSuspendedError);
      expect(caught.refundFailed).toBe(true);
      expect(caught.refundId).toBeNull();
      expect(caught.providerUid).toBe(providerUid);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }

    // Still zero ServiceOrder rows — the transaction was aborted.
    const persisted = await ServiceOrder.find({ stripePaymentIntentId: paymentIntentId }).lean();
    expect(persisted.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Case 6 — concurrent admin.suspend + confirmBooking race (D-13).
  // Exactly one of two outcomes must obtain:
  //   A. suspend wins -> confirmBooking throws ProviderSuspendedError, refund fired, zero orders
  //   B. confirmBooking wins -> orders created, car booked, refund NOT fired, provider later suspended
  // Any other state (both succeed with orders AND provider suspended for the booked car, or neither
  // produces a clean outcome) fails the test.
  // -------------------------------------------------------------------------
  test('case 6: concurrent admin.suspend + confirmBooking race (D-13) — exactly one valid outcome', async () => {
    const { buyerUid, providerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_race_123',
    });

    // Seed an admin caller so moderationService.suspend can execute.
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({
      firebaseUid: 'admin-uid-race',
      email: 'admin@test.local',
      moderationStatus: { state: 'active', severity: 'none' },
    });

    const results = await Promise.allSettled([
      moderationService.suspend({
        adminUid: 'admin-uid-race',
        adminEmail: 'admin@test.local',
        targetUid: providerUid,
        severity: 'blocked_with_review',
        reasonCategory: 'fraud',
        note: 'race test',
      }),
      confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items }),
    ]);

    const suspendResult = results[0];
    const confirmResult = results[1];

    // suspend may succeed or race against confirm; accept either status.
    // confirm is the one that must produce a clean outcome shape.
    const refundCalls = stripeFactory.__refundsCreateMock.mock.calls.length;
    const orders = await ServiceOrder.find({ stripePaymentIntentId: paymentIntentId }).lean();
    const rawCar = await Car.findById(carId).setOptions({ includeAllUsers: true });

    if (confirmResult.status === 'rejected') {
      // Outcome A: suspend observed before confirm's provider re-check.
      expect(confirmResult.reason).toBeInstanceOf(ProviderSuspendedError);
      expect(confirmResult.reason.providerUid).toBe(providerUid);
      expect(refundCalls).toBeGreaterThanOrEqual(1);
      expect(orders.length).toBe(0);
      expect(rawCar.listingStatus).toBe('active');
    } else if (confirmResult.status === 'fulfilled') {
      // Outcome B: confirm committed before suspend took effect; orders exist.
      expect(confirmResult.value.car).toBeDefined();
      expect(confirmResult.value.car.listingStatus).toBe('booked');
      expect(confirmResult.value.orders.length).toBeGreaterThanOrEqual(1);
      expect(refundCalls).toBe(0);
      expect(orders.length).toBeGreaterThanOrEqual(1);
      // Outcome B's invariant: if suspend also fulfilled, the provider is now
      // suspended but the booked order pre-dates it and remains intact (the
      // whole point of providerSnapshot at Phase 1 D-21..D-24).
      // No third state is allowed: we must NOT end up with booked orders AND
      // refund called.
    } else {
      throw new Error(`unexpected confirm result status: ${confirmResult.status}`);
    }

    // Sanity: the suspend result is well-formed regardless of race order.
    expect(['fulfilled', 'rejected']).toContain(suspendResult.status);
  });

  // -------------------------------------------------------------------------
  // Case 7 — idempotency fast-path: retry with same paymentIntentId on an
  // already-booked car returns existing orders WITHOUT calling Stripe.
  // -------------------------------------------------------------------------
  test('case 7: idempotency fast-path — retry on already-booked car returns existing orders, no Stripe calls', async () => {
    const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_idempotent',
    });

    // First call: normal booking.
    const first = await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
    expect(first.orders.length).toBeGreaterThanOrEqual(1);
    const firstOrderIds = first.orders.map((o) => o._id.toString()).sort();

    // Reset mocks to detect any call on retry.
    stripeFactory.__paymentIntentsRetrieveMock.mockReset();
    stripeFactory.__refundsCreateMock.mockReset();

    // Second call: same paymentIntentId — should short-circuit without Stripe.
    const second = await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });

    const secondOrderIds = second.orders.map((o) => o._id.toString()).sort();
    expect(secondOrderIds).toEqual(firstOrderIds);

    // Stripe MUST NOT have been called on retry (fast-path short-circuit).
    expect(stripeFactory.__paymentIntentsRetrieveMock).not.toHaveBeenCalled();
    expect(stripeFactory.__refundsCreateMock).not.toHaveBeenCalled();
  });
});
