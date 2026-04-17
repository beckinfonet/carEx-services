// __tests__/enforcement/acceptance.test.js
//
// Phase 3 Plan 03-06 capstone — end-to-end acceptance proof for the four
// ROADMAP Phase 3 Success Criteria. Each describe block names its criterion
// literally so the verifier can grep ("ROADMAP Criterion #1" ... "#4") to
// confirm coverage at a glance.
//
// TEST ISOLATION: mirrors the Phase 2 pattern from
// __tests__/moderation/acceptance.test.js — build the Express app exactly
// ONCE in a top-level beforeAll; never re-require the moderation router
// (would OverwriteModelError on the User/AdminUser/ModerationAction
// singletons); per-test state is reset in beforeEach via collection
// deleteMany + mock reset. See the Phase 2 write-up for the full B-01/B-02
// rationale.
//
// We DO NOT import server.js — it pulls in MongoDB URIs, Twilio, S3,
// Stripe, and Firebase initializers. Instead this test builds a minimal
// Express app wiring ONLY the five gated routes (from Plan 03-03's D-02
// hybrid cutover) + the 410 Gone handler (from Plan 03-05). The confirm-
// booking route delegates to the real confirmBookingService from Plan 03-04
// with an injected mocked Stripe instance so we exercise the actual
// transactional re-check code path.

// 1. firebase-admin mock — MUST come before any require of a module that uses it.
jest.mock('firebase-admin', () => {
  const verifyIdTokenMock = jest.fn();
  const mock = {
    credential: { cert: jest.fn(() => ({})) },
    initializeApp: jest.fn(),
    auth: jest.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
  };
  mock.__verifyIdTokenMock = verifyIdTokenMock;
  return mock;
});

// 2. Stripe mock — MUST come before any require of confirmBooking.
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

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');
const admin = require('firebase-admin');
const stripeFactory = require('stripe');

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
const AdminUser = require('../../src/models/AdminUser');
const ModerationAction = require('../../src/models/ModerationAction');
const Car = require('../../src/models/Car');
const Broker = require('../../src/models/Broker');
const LogisticsPartner = require('../../src/models/LogisticsPartner');

const { attachAuthIfPresent } = require('../../src/security/attachAuthIfPresent');
const { requireNotSuspended } = require('../../src/security/requireNotSuspended');
const { confirmBooking, ProviderSuspendedError } = require('../../src/payments/confirmBooking');
const moderationService = require('../../src/moderation/service');

// Construct a stripe instance via the mocked factory.
const stripe = stripeFactory();

let rs;
let app;

beforeAll(async () => {
  rs = await startReplSet();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  app = express();
  app.use(express.json());

  // The five gated routes (Plan 03-03 D-02 hybrid cutover).
  app.post(
    '/api/cars',
    attachAuthIfPresent,
    requireNotSuspended('create_listing'),
    (req, res) => res.status(201).json({ ok: true })
  );
  app.post(
    '/api/payments/create-payment-intent',
    attachAuthIfPresent,
    requireNotSuspended('create_order'),
    (req, res) => res.json({ ok: true, clientSecret: 'pi_mock_client_secret' })
  );
  // confirm-booking delegates to the real service with the injected mocked Stripe.
  app.post(
    '/api/payments/confirm-booking',
    attachAuthIfPresent,
    requireNotSuspended('create_order'),
    async (req, res) => {
      try {
        const { paymentIntentId, carId, buyerUid, items } = req.body;
        const result = await confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items });
        return res.json(result);
      } catch (err) {
        if (err instanceof ProviderSuspendedError) {
          return res.status(409).json({
            error: 'provider_suspended',
            providerUid: err.providerUid,
            refundId: err.refundId,
            refundFailed: err.refundFailed,
          });
        }
        if (err.message === 'invalid_payment_intent') {
          return res.status(400).json({ error: 'invalid_payment_intent' });
        }
        if (err.message === 'car_not_found') {
          return res.status(404).json({ error: 'car_not_found' });
        }
        // eslint-disable-next-line no-console
        console.error('[confirm-booking]', err);
        return res.status(500).json({ error: 'internal_error' });
      }
    }
  );
  app.put(
    '/api/brokers/:uid',
    attachAuthIfPresent,
    requireNotSuspended('update_profile'),
    (req, res) => res.json({ ok: true })
  );
  app.put(
    '/api/logistics/:uid',
    attachAuthIfPresent,
    requireNotSuspended('update_profile'),
    (req, res) => res.json({ ok: true })
  );

  // Deprecated route per Plan 03-05.
  app.post('/api/orders', (req, res) => {
    res.status(410).json({
      error: 'deprecated',
      message: 'Use POST /api/payments/confirm-booking which now creates orders atomically',
    });
  });
});

afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await User.deleteMany({});
  await AdminUser.deleteMany({});
  await Car.deleteMany({}).setOptions({ includeAllUsers: true });
  await Broker.deleteMany({}).setOptions({ includeAllUsers: true });
  await LogisticsPartner.deleteMany({}).setOptions({ includeAllUsers: true });
  try { await ModerationAction.collection.drop(); } catch (_) { /* may not exist */ }
  try { await ServiceOrder.collection.drop(); } catch (_) { /* may not exist */ }

  admin.__verifyIdTokenMock.mockReset();
  stripeFactory.__paymentIntentsRetrieveMock.mockReset();
  stripeFactory.__refundsCreateMock.mockReset();
  stripeFactory.__paymentIntentsRetrieveMock.mockResolvedValue({ status: 'succeeded' });
  stripeFactory.__refundsCreateMock.mockResolvedValue({ id: 're_accept_123' });
});

// ============================================================================
// BLOCK 1 — ROADMAP Criterion #1 (403 on user-write for suspended, all 5 routes)
// ============================================================================
describe('ROADMAP Criterion #1: 403 account_suspended on every gated user-write route', () => {
  const UID = 'blocked-user-c1';
  const EMAIL = 'c1@test.local';

  beforeEach(async () => {
    await User.create({
      firebaseUid: UID,
      email: EMAIL,
      sellerStatus: 'APPROVED',
      brokerStatus: 'APPROVED',
      logisticsStatus: 'APPROVED',
      moderationStatus: {
        state: 'blocked_with_review',
        severity: 'blocked_with_review',
        reasonCategory: 'fraud',
        note: 'test note',
        setByAdminUid: 'admin-uid',
        setAt: new Date(),
      },
    });
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: UID, email: EMAIL });
  });

  // Drive the five gated routes via a single forEach matrix per Phase 2 DRY style.
  const GATED_ROUTES = [
    { method: 'post', path: '/api/cars', body: {} },
    { method: 'post', path: '/api/payments/create-payment-intent', body: { buyerUid: UID } },
    {
      method: 'post',
      path: '/api/payments/confirm-booking',
      body: { buyerUid: UID, paymentIntentId: 'pi_x', carId: 'does-not-matter', items: [] },
    },
    { method: 'put', path: `/api/brokers/${UID}`, body: {} },
    { method: 'put', path: `/api/logistics/${UID}`, body: {} },
  ];

  GATED_ROUTES.forEach(({ method, path, body }) => {
    test(`${method.toUpperCase()} ${path} -> 403 account_suspended with full shape`, async () => {
      const res = await request(app)
        [method](path)
        .set('Authorization', 'Bearer ok-token')
        .send(body);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'account_suspended',
        status: 'blocked_with_review',
        reasonCategory: 'fraud',
        note: 'test note',
      });
    });
  });
});

// ============================================================================
// BLOCK 2 — ROADMAP Criterion #2 (hide/restore on suspend/unsuspend with zero mutation)
// ============================================================================
describe('ROADMAP Criterion #2: GET-style Car query hides/restores on suspend/unsuspend with zero mutation', () => {
  const SELLER_UID = 'seller-c2';

  test('suspend hides Car; bypass re-fetch shows listingStatus unchanged; unsuspend restores', async () => {
    await User.create({
      firebaseUid: SELLER_UID,
      email: 'seller-c2@test.local',
      sellerStatus: 'APPROVED',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    const car = await Car.create({
      sellerId: SELLER_UID,
      makeName: 'Toyota',
      modelName: 'Camry',
      year: 2022,
      price: 22000,
      currency: '$',
      listingStatus: 'active',
    });

    // Active: 1 result via public query.
    expect(await Car.find({})).toHaveLength(1);

    // Suspend seller — the owned Car doc is NOT touched.
    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );

    // Public query hides.
    expect(await Car.find({})).toHaveLength(0);

    // Admin bypass re-fetch: listingStatus still 'active' (zero-mutation proof
    // — ROADMAP criterion #2 verbatim, "still have whatever active flag X
    // originally set").
    const raw = await Car.findById(car._id).setOptions({ includeAllUsers: true });
    expect(raw).not.toBeNull();
    expect(raw.listingStatus).toBe('active');

    // Unsuspend — listing returns, with same _id and same listingStatus.
    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { 'moderationStatus.state': 'active' } }
    );
    const restored = await Car.find({});
    expect(restored).toHaveLength(1);
    expect(restored[0]._id.toString()).toBe(car._id.toString());
    expect(restored[0].listingStatus).toBe('active');
  });
});

// ============================================================================
// BLOCK 3 — ROADMAP Criterion #3 (concurrent admin.suspend vs confirm-booking)
// ============================================================================
describe('ROADMAP Criterion #3: concurrent admin.suspend vs confirm-booking — exactly one valid outcome', () => {
  test('Promise.allSettled race yields refund-abort OR booking-succeed, never both', async () => {
    const BUYER_UID = 'buyer-c3';
    const PROVIDER_UID = 'provider-c3';
    const SELLER_UID = 'seller-c3';
    const ADMIN_UID = 'admin-c3';
    const ADMIN_EMAIL = 'admin-c3@test.local';
    const PAYMENT_INTENT = 'pi_c3_race';

    await User.create({
      firebaseUid: BUYER_UID,
      email: 'buyer-c3@test.local',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    await User.create({
      firebaseUid: PROVIDER_UID,
      email: 'provider-c3@test.local',
      brokerStatus: 'APPROVED',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    await User.create({
      firebaseUid: SELLER_UID,
      email: 'seller-c3@test.local',
      sellerStatus: 'APPROVED',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    await Broker.create({
      ownerUid: PROVIDER_UID,
      companyName: 'Race Brokers',
      phoneNumber: '+10000009',
      status: 'active',
    });
    const car = await Car.create({
      sellerId: SELLER_UID,
      makeName: 'Honda',
      modelName: 'Accord',
      year: 2021,
      price: 18000,
      currency: '$',
      listingStatus: 'active',
    });
    // Admin seed for moderationService.suspend.
    await AdminUser.create({ email: ADMIN_EMAIL, role: 'admin' });
    await User.create({
      firebaseUid: ADMIN_UID,
      email: ADMIN_EMAIL,
      moderationStatus: { state: 'active', severity: 'none' },
    });

    admin.__verifyIdTokenMock.mockResolvedValue({ uid: BUYER_UID, email: 'buyer-c3@test.local' });

    const confirmBody = {
      paymentIntentId: PAYMENT_INTENT,
      carId: car._id.toString(),
      buyerUid: BUYER_UID,
      items: [
        {
          providerUid: PROVIDER_UID,
          providerType: 'broker',
          service: { name: 'Delivery', fee: 500, currency: '$' },
        },
      ],
    };

    const results = await Promise.allSettled([
      moderationService.suspend({
        adminUid: ADMIN_UID,
        adminEmail: ADMIN_EMAIL,
        targetUid: PROVIDER_UID,
        severity: 'blocked_with_review',
        reasonCategory: 'fraud',
        note: 'race',
      }),
      request(app)
        .post('/api/payments/confirm-booking')
        .set('Authorization', 'Bearer ok-token')
        .send(confirmBody),
    ]);

    const confirmResult = results[1];
    expect(confirmResult.status).toBe('fulfilled');
    const res = confirmResult.value;

    const refundCalls = stripeFactory.__refundsCreateMock.mock.calls.length;
    const orders = await ServiceOrder.find({ stripePaymentIntentId: PAYMENT_INTENT }).lean();
    const rawCar = await Car.findById(car._id).setOptions({ includeAllUsers: true });

    if (res.status === 409) {
      // Outcome A: suspend won the race, confirm aborted with refund.
      expect(res.body.error).toBe('provider_suspended');
      expect(res.body.providerUid).toBe(PROVIDER_UID);
      expect(refundCalls).toBeGreaterThanOrEqual(1);
      expect(orders.length).toBe(0);
      expect(rawCar.listingStatus).toBe('active');
    } else if (res.status === 200) {
      // Outcome B: confirm committed before suspend observed.
      expect(res.body.car).toBeDefined();
      expect(res.body.car.listingStatus).toBe('booked');
      expect(res.body.orders.length).toBeGreaterThanOrEqual(1);
      expect(refundCalls).toBe(0);
      expect(orders.length).toBeGreaterThanOrEqual(1);
    } else {
      throw new Error(`unexpected confirm status: ${res.status} body=${JSON.stringify(res.body)}`);
    }
  });
});

// ============================================================================
// BLOCK 4 — ROADMAP Criterion #4 (feature_limited capability selectivity)
// ============================================================================
describe('ROADMAP Criterion #4: feature_limited capability gating is selective', () => {
  const UID = 'feature-limited-c4';
  const EMAIL = 'c4@test.local';

  beforeEach(async () => {
    await User.create({
      firebaseUid: UID,
      email: EMAIL,
      sellerStatus: 'APPROVED',
      brokerStatus: 'APPROVED',
      moderationStatus: {
        state: 'feature_limited',
        severity: 'feature_limited',
        reasonCategory: 'policy_violation',
        note: 'low-trust',
        restrictedFeatures: ['create_listing'],  // create_order NOT blocked
      },
    });
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: UID, email: EMAIL });
  });

  test('POST /api/cars (create_listing blocked) -> 403 account_suspended', async () => {
    const res = await request(app)
      .post('/api/cars')
      .set('Authorization', 'Bearer ok-token')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'account_suspended',
      status: 'feature_limited',
      reasonCategory: 'policy_violation',
      note: 'low-trust',
    });
  });

  test('POST /api/payments/create-payment-intent (create_order NOT blocked) -> 200', async () => {
    const res = await request(app)
      .post('/api/payments/create-payment-intent')
      .set('Authorization', 'Bearer ok-token')
      .send({ buyerUid: UID });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
