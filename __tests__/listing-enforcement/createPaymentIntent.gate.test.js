// __tests__/listing-enforcement/createPaymentIntent.gate.test.js
//
// Phase 9 Plan 09-04 — LENF-03 cart-add gate contract (Plan 09-04 GREEN).
// Covers VALIDATION rows 09-LENF03-A-a..d + a defensive Pitfall 6 case (5).
//
// Mounts the PRODUCTION handler `createPaymentIntentHandler` from server.js
// (W-6 — production/test divergence impossible by construction). Stripe is
// mocked per Shared Pattern S-7 (mirrors
// __tests__/enforcement/confirmBooking.transaction.test.js:26-36). The
// `__paymentIntentsCreateMock` is asserted NOT to have been called on the
// non-active branches, proving the gate fires BEFORE any Stripe API call.

// 1. Mock stripe BEFORE any require of a module that needs it.
jest.mock('stripe', () => {
  const paymentIntentsCreateMock = jest.fn();
  const paymentIntentsRetrieveMock = jest.fn();
  const refundsCreateMock = jest.fn();
  const stripeFactory = () => ({
    paymentIntents: {
      create: paymentIntentsCreateMock,
      retrieve: paymentIntentsRetrieveMock,
    },
    refunds: { create: refundsCreateMock },
  });
  stripeFactory.__paymentIntentsCreateMock = paymentIntentsCreateMock;
  stripeFactory.__paymentIntentsRetrieveMock = paymentIntentsRetrieveMock;
  stripeFactory.__refundsCreateMock = refundsCreateMock;
  return stripeFactory;
});

// Prevent server.js from connecting to a real MongoDB on require — the test
// drives its own in-memory mongoose connection. Setting MONGODB_URI to a
// reachable-but-unused value before require keeps mongoose.connect from
// throwing synchronously; the test reconnects mongoose to MongoMemoryServer
// in beforeAll.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:0/test';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON =
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON || JSON.stringify({ project_id: 'test' });

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const request = require('supertest');

const stripeFactory = require('stripe');
const Car = require('../../src/models/Car');
const User = require('../../src/models/User');
const { LISTING_STATUS_POLICY } = require('../../src/moderation/listingCapabilities');

// W-6: import the PRODUCTION handler so the test exercises the exact function
// that ships in production.
const { createPaymentIntentHandler } = require('../../server.js');

let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  try {
    await mongoose.disconnect();
  } catch (_) {
    // not connected
  }
  await mongoose.connect(mongo.getUri());

  // Mount the production handler WITHOUT the requireNotSuspended middleware:
  // the LENF-03 gate fires BEFORE requireNotSuspended in the production
  // route's logical contract, but more importantly, requireNotSuspended
  // checks the buyer's User.moderationStatus.state which is orthogonal to
  // the listing-status check under test here. Stubbing simplifies the
  // harness; the listing-status branch is what we exercise.
  app = express();
  app.use(express.json());
  app.post('/api/payments/create-payment-intent', createPaymentIntentHandler);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Car.deleteMany({ /* no filter */ }).setOptions({
    includeAllUsers: true,
    includeAllListingStatuses: true,
  });
  await User.deleteMany({});
  stripeFactory.__paymentIntentsCreateMock.mockReset();
  stripeFactory.__paymentIntentsRetrieveMock.mockReset();
  stripeFactory.__refundsCreateMock.mockReset();
});

// Seed a fully-active seller so the Phase 3 seller-cascade hide hook does NOT
// short-circuit our cars during the gate's Car.findById — only the new
// listing-status branch is exercised. Belt-and-braces per PATTERNS §9.
async function seedActiveSeller(uid = 'seller-lenf03-1') {
  await User.create({
    firebaseUid: uid,
    email: 'seller-lenf03@test.local',
    sellerStatus: 'APPROVED',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  return uid;
}

// Seed a Car via Car.collection.insertOne (Shared Pattern S-9) — bypasses save
// validators AND pre(/^find/) hooks during seeding.
async function seedCar(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Car.collection.insertOne({
    _id,
    sellerId: 'seller-lenf03-1',
    sellerEmail: 'seller-lenf03@test.local',
    sellerName: 'Seller Name',
    sellerPhone: '+10000000000',
    makeName: 'Honda',
    modelName: 'Civic',
    year: 2021,
    price: 18000,
    imageUrls: [],
    listingStatus: 'active',
    status: 'active',
    createdAt: new Date(),
    ...overrides,
  });
  return _id.toString();
}

describe('LENF-03 cart-add gate at POST /api/payments/create-payment-intent (Plan 09-04 contract)', () => {
  // (a) — 09-LENF03-A-a — suspended → 409 + D-11 body
  test('POST create-payment-intent with suspended carId returns 409 + D-11 body { error: listing_not_available, listingStatus, reasonCategory, banner }', async () => {
    await seedActiveSeller();
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'spam',
    });

    const res = await request(app)
      .post('/api/payments/create-payment-intent')
      .send({ buyerUid: 'buyer-1', carId, currency: 'kgs' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'listing_not_available',
      listingStatus: 'suspended',
      reasonCategory: 'spam',
      banner: LISTING_STATUS_POLICY.suspended.banner,
    });
  });

  // (b) — 09-LENF03-A-b — no Stripe call on non-active
  test('stripe.paymentIntents.create is NOT called when listing is non-active (expect(__paymentIntentsCreateMock).not.toHaveBeenCalled())', async () => {
    await seedActiveSeller();
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'spam',
    });

    await request(app)
      .post('/api/payments/create-payment-intent')
      .send({ buyerUid: 'buyer-1', carId, currency: 'kgs' });

    expect(stripeFactory.__paymentIntentsCreateMock).not.toHaveBeenCalled();
  });

  // (c) — 09-LENF03-A-c — active listing returns clientSecret normally
  test('POST create-payment-intent with active carId proceeds and returns clientSecret', async () => {
    await seedActiveSeller();
    const carId = await seedCar({ status: 'active' });

    stripeFactory.__paymentIntentsCreateMock.mockResolvedValueOnce({
      id: 'pi_test',
      client_secret: 'cs_test',
    });

    const res = await request(app)
      .post('/api/payments/create-payment-intent')
      .send({ buyerUid: 'buyer-1', carId, currency: 'kgs' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('clientSecret', 'cs_test');
    expect(res.body).toHaveProperty('paymentIntentId', 'pi_test');
    expect(stripeFactory.__paymentIntentsCreateMock).toHaveBeenCalledTimes(1);
  });

  // (d) — 09-LENF03-A-d — all three non-active states return 409 with correct banner
  test.each(['suspended', 'archived', 'deleted'])(
    'non-active status "%s" returns 409 with banner === LISTING_STATUS_POLICY[status].banner',
    async (status) => {
      await seedActiveSeller();
      const carId = await seedCar({
        status,
        moderationReason: status === 'suspended' ? 'spam' : status === 'archived' ? 'inactive_seller' : 'spam',
      });

      const res = await request(app)
        .post('/api/payments/create-payment-intent')
        .send({ buyerUid: 'buyer-1', carId, currency: 'kgs' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('listing_not_available');
      expect(res.body.listingStatus).toBe(status);
      expect(res.body.banner).toEqual(LISTING_STATUS_POLICY[status].banner);
      expect(stripeFactory.__paymentIntentsCreateMock).not.toHaveBeenCalled();
    }
  );

  // (e) — HARDENING — malformed carId returns 404 (NOT 500 CastError) — Pitfall 6
  test('malformed carId (e.g. "not-an-object-id") returns 404 not 500 CastError (Pitfall 6 / Shared Pattern S-5)', async () => {
    const res = await request(app)
      .post('/api/payments/create-payment-intent')
      .send({ buyerUid: 'buyer-1', carId: 'not-an-object-id', currency: 'kgs' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'car_not_found' });
    expect(stripeFactory.__paymentIntentsCreateMock).not.toHaveBeenCalled();
  });
});
