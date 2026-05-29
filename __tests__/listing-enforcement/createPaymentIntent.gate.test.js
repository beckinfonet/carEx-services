// __tests__/listing-enforcement/createPaymentIntent.gate.test.js
//
// Phase 9 Plan 09-01 — Wave 0 RED scaffold for LENF-03 cart-add half (Plan
// 09-04 contract). Covers VALIDATION rows 09-LENF03-A-a..d. Real implementation
// lands in Plan 09-04 (early 409 listing_not_available gate at the top of
// POST /api/payments/create-payment-intent per 09-CONTEXT D-09).
//
// INTENTIONAL RED at end of Plan 09-01: 4 test.todo entries lock the contract.
// Plan 09-04 flips them to real supertest cases against a route handler that
// reads LISTING_STATUS_POLICY[car.status].banner for the 409 body.
//
// Stripe is mocked via jest.mock('stripe', ...) per Shared Pattern S-7 (mirrors
// __tests__/enforcement/confirmBooking.transaction.test.js:26-36). The
// `__paymentIntentsCreateMock` is exposed so Plan 09-04 can assert
// `expect(__paymentIntentsCreateMock).not.toHaveBeenCalled()` for the
// non-active branch.

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

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const request = require('supertest');

const stripeFactory = require('stripe');
const Car = require('../../src/models/Car');

let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  // Plan 09-04 mounts the real POST /api/payments/create-payment-intent
  // handler here with the listing-status gate at the top. Scaffold defines
  // `app` for symmetry with the other Wave 0 scaffolds.
  app = express();
  app.use(express.json());
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
  stripeFactory.__paymentIntentsCreateMock.mockReset();
  stripeFactory.__paymentIntentsRetrieveMock.mockReset();
  stripeFactory.__refundsCreateMock.mockReset();
});

// Reference unused-import locals to satisfy lint and keep harness wired.
void request;
void app;

describe('LENF-03 cart-add gate at POST /api/payments/create-payment-intent (Plan 09-04 contract)', () => {
  // (a) — 09-LENF03-A-a — suspended → 409 + D-11 body
  test.todo(
    'POST create-payment-intent with suspended carId returns 409 + D-11 body { error: listing_not_available, listingStatus, reasonCategory, banner }'
  );

  // (b) — 09-LENF03-A-b — no Stripe call on non-active
  test.todo(
    'stripe.paymentIntents.create is NOT called when listing is non-active (expect(__paymentIntentsCreateMock).not.toHaveBeenCalled())'
  );

  // (c) — 09-LENF03-A-c — active listing returns clientSecret normally
  test.todo(
    'POST create-payment-intent with active carId proceeds and returns clientSecret'
  );

  // (d) — 09-LENF03-A-d — all three non-active states return 409 with correct banner
  test.todo(
    'All three non-active statuses (suspended/archived/deleted) return 409 with correct banner from LISTING_STATUS_POLICY[status].banner'
  );
});
