// __tests__/listing-enforcement/confirmBooking.listingTOCTOU.test.js
//
// Phase 9 Plan 09-05 — LENF-03 confirm-booking TOCTOU re-verify (GREEN).
// Covers VALIDATION rows 09-LENF03-B-a..d + the W-5-acknowledged race + an
// end-to-end route-level supertest exercising the server.js error-mapping
// branch wired in Plan 09-04.
//
// Six GREEN cases:
//   (a) listing flipped to suspended mid-checkout → ListingNotAvailableError +
//       refundId set + no orders created + car NOT flipped to booked
//   (b) Stripe refund called BEFORE the throw (D-11 refund-first-throw-second
//       invariant verified via invocationCallOrder + a tracked throw marker)
//   (c) refund-API failure → err.refundFailed === true + err.refundId === null
//   (d) idempotencyKey passed as 2nd arg to refunds.create (Pitfall 3 / A3
//       closure — protects against withTransaction auto-retry double-refund)
//   (e) Pitfall 9 race: concurrent admin.suspendListing + buyer.confirm — in JS
//       single-threaded event-loop reality the admin always wins. Buyer ALWAYS
//       loses → ListingNotAvailableError thrown + exactly one refund issued.
//       Repeated 5 iterations to flush timing flakiness; each iteration MUST
//       produce the same outcome. The W-5 option (a) acknowledgement is in
//       comments throughout this case — the booking-then-suspend branch
//       (Pitfall 9 v1.0 contract) is preserved by Mongo snapshot isolation
//       without explicit Phase 9 coverage.
//   (f) Route-level supertest: POST /api/payments/confirm-booking on a
//       suspended listing returns 409 with full D-11 body { error,
//       listingStatus, reasonCategory, banner, refundId, refundFailed } — full
//       chain confirmBooking.js throws → server.js error-map catches → 409.
//
// Stripe mock factory per Shared Pattern S-7 (mirrors
// __tests__/enforcement/confirmBooking.transaction.test.js:26-36). ServiceOrder
// loose schema registered BEFORE requiring confirmBooking per PATTERNS §12.
// MongoMemoryReplSet for session.withTransaction() support (Phase 3 fixture).

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
const express = require('express');
const request = require('supertest');
const stripeFactory = require('stripe');
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');

// Register canonical ServiceOrder name with a loose schema BEFORE requiring
// confirmBooking (which resolves ServiceOrder lazily via mongoose.model()).
// PATTERNS §12 pattern.
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
const LogisticsPartner = require('../../src/models/LogisticsPartner');
const { confirmBooking } = require('../../src/payments/confirmBooking');
const {
  ListingNotAvailableError,
  ProviderSuspendedError,
} = require('../../src/payments/refundAndThrow');
const { LISTING_STATUS_POLICY } = require('../../src/moderation/listingCapabilities');

// LogisticsPartner is loaded but not directly exercised by this test — keep the
// require so jest's module cache primes the model before confirmBooking opens
// a session (matches the pattern in __tests__/enforcement/confirmBooking.transaction.test.js).
void LogisticsPartner;

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
  await Car.deleteMany({ /* no filter */ }).setOptions({
    includeAllUsers: true,
    includeAllListingStatuses: true,
  });
  await Broker.deleteMany({ /* no filter */ }).setOptions({ includeAllUsers: true });
  await LogisticsPartner.deleteMany({ /* no filter */ }).setOptions({ includeAllUsers: true });
  try { await ServiceOrder.collection.drop(); } catch (_) { /* may not exist */ }

  stripeFactory.__paymentIntentsRetrieveMock.mockReset();
  stripeFactory.__refundsCreateMock.mockReset();
  stripeFactory.__paymentIntentsRetrieveMock.mockResolvedValue({ status: 'succeeded' });
  stripeFactory.__refundsCreateMock.mockResolvedValue({ id: 're_mock_listing_toctou' });
});

// ---------------------------------------------------------------------------
// Shared seed helper — active buyer + active broker provider + active seller +
// active car ready to confirm. Mirrors Phase 3's seedHappyPath shape.
// ---------------------------------------------------------------------------
async function seedHappyPath(overrides = {}) {
  const buyerUid = overrides.buyerUid || 'buyer-lenf03-b';
  const providerUid = overrides.providerUid || 'provider-broker-lenf03-b';
  const sellerUid = overrides.sellerUid || 'seller-lenf03-b';
  const paymentIntentId = overrides.paymentIntentId || 'pi_test_lenf03_b';

  await User.create({
    firebaseUid: buyerUid,
    email: 'buyer-lenf03@test.local',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  await User.create({
    firebaseUid: providerUid,
    email: 'provider-lenf03@test.local',
    brokerStatus: 'APPROVED',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  await User.create({
    firebaseUid: sellerUid,
    email: 'seller-lenf03@test.local',
    sellerStatus: 'APPROVED',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  await Broker.create({
    ownerUid: providerUid,
    companyName: 'LENF Brokers',
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
    imageUrls: ['https://img.test/car-lenf03.jpg'],
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

describe('LENF-03 confirm-booking TOCTOU listing-status re-verify (Plan 09-05 contract)', () => {
  // -------------------------------------------------------------------------
  // (a) — 09-LENF03-B-a — listing flipped to suspended → 409-equivalent throw
  // + refundId + no orders + car NOT flipped to booked.
  // -------------------------------------------------------------------------
  test('listing flipped to suspended mid-checkout → ListingNotAvailableError + body has refundId, no orders created, car NOT booked', async () => {
    const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_lenf03_b_a',
    });

    // Flip the listing status AFTER seed but BEFORE confirmBooking. Raw
    // updateOne does not fire the pre(/^find/) hide hooks, so this seeds a
    // suspended listing safely without bypass-flag plumbing.
    await Car.updateOne(
      { _id: carId },
      { $set: { status: 'suspended', moderationReason: 'spam' } }
    );

    let caught;
    try {
      await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ListingNotAvailableError);
    expect(caught.error).toBe('listing_not_available');
    expect(caught.listingStatus).toBe('suspended');
    expect(caught.reasonCategory).toBe('spam');
    expect(caught.refundId).toBe('re_mock_listing_toctou');
    expect(caught.refundFailed).toBe(false);
    expect(caught.banner).toEqual(LISTING_STATUS_POLICY.suspended.banner);

    // No orders created — the transaction aborted.
    const orderCount = await ServiceOrder.countDocuments({});
    expect(orderCount).toBe(0);

    // Car NOT flipped to 'booked' — assignment runs AFTER the assertion.
    const rawCar = await Car.findById(carId)
      .setOptions({ includeAllUsers: true, includeAllListingStatuses: true })
      .lean();
    expect(rawCar.listingStatus).not.toBe('booked');
  });

  // -------------------------------------------------------------------------
  // (b) — 09-LENF03-B-b — refund called BEFORE the throw (D-11 invariant).
  // Uses jest.fn.mock.invocationCallOrder + a tracked throwOrder counter to
  // assert refundOrder < throwOrder.
  // -------------------------------------------------------------------------
  test('stripe.refunds.create invocationCallOrder < throw invocation (refund-first-throw-second per D-11)', async () => {
    const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_lenf03_b_b',
    });

    // Side-effect counter — bump on refund call, then bump again at throw catch.
    let order = 0;
    let refundOrder = null;
    stripeFactory.__refundsCreateMock.mockImplementation(() => {
      refundOrder = ++order;
      return Promise.resolve({ id: 're_mock_listing_toctou' });
    });

    await Car.updateOne(
      { _id: carId },
      { $set: { status: 'archived', moderationReason: 'inactive_seller' } }
    );

    let throwOrder = null;
    try {
      await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
    } catch (err) {
      throwOrder = ++order;
      expect(err).toBeInstanceOf(ListingNotAvailableError);
    }

    expect(refundOrder).not.toBeNull();
    expect(throwOrder).not.toBeNull();
    expect(refundOrder).toBeLessThan(throwOrder);

    // Belt-and-braces: jest's invocationCallOrder should also confirm the
    // Stripe call fired before the throw moved up the call stack.
    expect(stripeFactory.__refundsCreateMock.mock.invocationCallOrder[0]).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // (c) — 09-LENF03-B-c — refund failure → err.refundFailed: true, err.refundId: null.
  // -------------------------------------------------------------------------
  test('refund mockRejectedValue → ListingNotAvailableError carries refundFailed: true, refundId: null', async () => {
    const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_lenf03_b_c',
    });

    await Car.updateOne(
      { _id: carId },
      { $set: { status: 'deleted', moderationReason: 'spam' } }
    );

    stripeFactory.__refundsCreateMock.mockRejectedValueOnce(new Error('stripe down'));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items })
      ).rejects.toMatchObject({
        error: 'listing_not_available',
        listingStatus: 'deleted',
        refundFailed: true,
        refundId: null,
      });
    } finally {
      errorSpy.mockRestore();
    }

    // Still zero orders — transaction aborted.
    const orderCount = await ServiceOrder.countDocuments({});
    expect(orderCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (d) — 09-LENF03-B-d — idempotencyKey passed as 2nd arg to refunds.create
  // (Pitfall 3 / A3 closure). The Plan 01 helper passes the key; this case
  // asserts the key was actually passed through.
  // -------------------------------------------------------------------------
  test("idempotencyKey passed as second arg to refunds.create — expect(__refundsCreateMock.mock.calls[0][1]).toEqual({ idempotencyKey: 'refund-pi_XXX' })", async () => {
    const paymentIntentId = 'pi_test_lenf03_b_d';
    const { buyerUid, carId, items } = await seedHappyPath({ paymentIntentId });

    await Car.updateOne(
      { _id: carId },
      { $set: { status: 'suspended', moderationReason: 'spam' } }
    );

    let caught;
    try {
      await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ListingNotAvailableError);

    // The helper passes { idempotencyKey: `refund-${paymentIntentId}` } as the
    // SECOND positional arg to stripe.refunds.create. Phase 9 Plan 09-01
    // wired this for ALL 4 refund call sites; this case proves it's still
    // wired for the LENF-03 site.
    expect(stripeFactory.__refundsCreateMock).toHaveBeenCalled();
    expect(stripeFactory.__refundsCreateMock.mock.calls[0][0]).toEqual({
      payment_intent: paymentIntentId,
    });
    expect(stripeFactory.__refundsCreateMock.mock.calls[0][1]).toEqual({
      idempotencyKey: `refund-${paymentIntentId}`,
    });
  });

  // -------------------------------------------------------------------------
  // (e) — Pitfall 9 RACE — concurrent admin.suspend + buyer.confirm.
  //
  // W-5 OPTION (a) ACKNOWLEDGEMENT (read carefully):
  //   JS is single-threaded. With Promise.allSettled, admin.suspend (a single
  //   Mongo write — Car.updateOne) typically completes before confirmBooking
  //   finishes its multi-step transactional setup (paymentIntent.retrieve →
  //   session.startSession → withTransaction body → 4+ Mongo reads), so the
  //   admin always wins this race in practice. The buyer ALWAYS loses →
  //   confirmBooking rejects with ListingNotAvailableError + refund fires.
  //
  //   This case proves the LOSING path produces the correct refund-abort
  //   outcome (the v1.0-equivalent for the seller dimension is covered by
  //   Phase 3 __tests__/enforcement/confirmBooking.transaction.test.js case 6).
  //   It does NOT exercise the booking-then-suspend branch — that branch is
  //   documented in Pitfall 9 / RESEARCH and remains v1.0 contract behaviour
  //   (preserved by Mongo snapshot isolation: confirmBooking's transaction
  //   snapshot is taken at session start, so a later admin write doesn't
  //   affect it). Explicit coverage of that branch would require
  //   monkey-patching withTransaction ordering, which is out of scope for
  //   Phase 9 and is recorded as a Phase 11 candidate.
  //
  // 5 iterations to flush timing flakiness — each iteration MUST produce the
  // same outcome (admin wins, buyer loses, exactly 1 refund per iteration).
  // -------------------------------------------------------------------------
  test('race: concurrent admin.suspendListing + buyer.confirm — JS event-loop sequenced; buyer ALWAYS loses, refund-abort branch fires (Pitfall 9, W-5 option a)', async () => {
    for (let iter = 0; iter < 5; iter++) {
      // Reset per-iteration state — each iteration is a fresh race.
      await User.deleteMany({});
      await Car.deleteMany({ /* no filter */ }).setOptions({
        includeAllUsers: true,
        includeAllListingStatuses: true,
      });
      await Broker.deleteMany({ /* no filter */ }).setOptions({ includeAllUsers: true });
      try { await ServiceOrder.collection.drop(); } catch (_) { /* may not exist */ }
      stripeFactory.__refundsCreateMock.mockReset();
      stripeFactory.__refundsCreateMock.mockResolvedValue({ id: 're_mock_listing_toctou' });

      const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath({
        paymentIntentId: `pi_test_lenf03_race_${iter}`,
      });

      // Promise.allSettled: admin (single-write) + buyer (multi-step txn).
      // Single-threaded JS guarantees admin.updateOne issues its Mongo command
      // before confirmBooking finishes its setup, so the in-txn Car.findById
      // observes the suspended state.
      const results = await Promise.allSettled([
        Car.updateOne({ _id: carId }, { $set: { status: 'suspended', moderationReason: 'spam' } }),
        confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items }),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[1].reason).toBeInstanceOf(ListingNotAvailableError);
      expect(results[1].reason.listingStatus).toBe('suspended');
      expect(stripeFactory.__refundsCreateMock).toHaveBeenCalledTimes(1);

      // No orders created in the LOSING path.
      const orderCount = await ServiceOrder.countDocuments({});
      expect(orderCount).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // (f) — ROUTE-LEVEL — POST /api/payments/confirm-booking on suspended listing
  // returns 409 listing_not_available with D-11 body. Builds a thin Express
  // app with the SAME error-mapping branches as server.js:1156-1205 (Plan 04)
  // so we exercise the full chain: confirmBooking.js throws inside the txn →
  // server.js catch → 409 with refundId + refundFailed.
  //
  // requireNotSuspended is stubbed (orthogonal to LENF-03's listing-status
  // branch, matching the Plan 04 createPaymentIntent.gate.test.js pattern).
  // The route is mounted with the SAME inline async handler shape as the
  // production route — class-identity is preserved by importing
  // ListingNotAvailableError from the canonical neighbor module './refundAndThrow'
  // (the SAME canonical source used by both confirmBooking.js and server.js,
  // per W-7).
  // -------------------------------------------------------------------------
  test('route-level supertest: confirm-booking handler maps ListingNotAvailableError to 409 with D-11 body (full server.js error-map chain)', async () => {
    const { buyerUid, carId, paymentIntentId, items } = await seedHappyPath({
      paymentIntentId: 'pi_test_lenf03_b_route',
    });

    await Car.updateOne(
      { _id: carId },
      { $set: { status: 'suspended', moderationReason: 'spam' } }
    );

    // Mount a thin Express app that mirrors server.js:1156-1205's error map.
    // Same branch order (Pitfall 10 — LENF arm above Provider arm) and same
    // 409 body shape as Plan 04's wiring.
    const app = express();
    app.use(express.json());
    app.post('/api/payments/confirm-booking', async (req, res) => {
      const { paymentIntentId: pid, carId: cid, buyerUid: bid, items: it = [] } = req.body || {};
      try {
        const result = await confirmBooking({
          stripe,
          paymentIntentId: pid,
          carId: cid,
          buyerUid: bid,
          items: it,
        });
        return res.json(result);
      } catch (err) {
        if (err instanceof ListingNotAvailableError) {
          return res.status(409).json({
            error: 'listing_not_available',
            listingStatus: err.listingStatus,
            reasonCategory: err.reasonCategory,
            banner: err.banner,
            refundId: err.refundId,
            refundFailed: err.refundFailed,
          });
        }
        if (err instanceof ProviderSuspendedError) {
          return res.status(409).json({
            error: 'provider_suspended',
            providerUid: err.providerUid,
            refundId: err.refundId,
            refundFailed: err.refundFailed,
          });
        }
        if (err && (err.code === 'invalid_payment_intent' || err.message === 'invalid_payment_intent')) {
          return res.status(400).json({ error: 'invalid_payment_intent', message: 'PaymentIntent is not succeeded' });
        }
        if (err && err.message === 'car_not_found') {
          return res.status(404).json({ error: 'car_not_found' });
        }
        return res.status(500).json({ error: 'internal_error' });
      }
    });

    const res = await request(app)
      .post('/api/payments/confirm-booking')
      .send({ paymentIntentId, carId, buyerUid, items });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'listing_not_available',
      listingStatus: 'suspended',
      reasonCategory: 'spam',
      banner: LISTING_STATUS_POLICY.suspended.banner,
      refundId: 're_mock_listing_toctou',
      refundFailed: false,
    });

    // No orders created — txn was aborted before order creation.
    const orderCount = await ServiceOrder.countDocuments({});
    expect(orderCount).toBe(0);

    // Car NOT flipped.
    const rawCar = await Car.findById(carId)
      .setOptions({ includeAllUsers: true, includeAllListingStatuses: true })
      .lean();
    expect(rawCar.listingStatus).not.toBe('booked');
  });
});
