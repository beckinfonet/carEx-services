// __tests__/listing-enforcement/confirmBooking.listingTOCTOU.test.js
//
// Phase 9 Plan 09-01 — Wave 0 RED scaffold for LENF-03 confirm-booking half
// (Plan 09-05 contract). Covers VALIDATION rows 09-LENF03-B-a..d + race + route.
// Real implementation lands in Plan 09-05 (the 3rd in-txn listing-status assertion
// at confirmBooking.js step c per 09-CONTEXT D-12/D-13, routed through the
// refundAndThrow helper that Plan 09-01 Task 2/3 lands).
//
// INTENTIONAL RED at end of Plan 09-01: 6 test.todo entries lock the contract.
// Plan 09-05 flips them to real txn cases.
//
// Stripe mock factory per Shared Pattern S-7 (mirrors
// __tests__/enforcement/confirmBooking.transaction.test.js:26-36). MongoMemoryReplSet
// for `session.withTransaction()` support (Phase 3 fixture, proven). ServiceOrder
// registered as a loose schema BEFORE requiring confirmBooking — mirrors
// PATTERNS §12 pattern so the lazy `mongoose.model('ServiceOrder')` inside
// confirmBooking resolves cleanly without depending on server.js init.

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

void ServiceOrder;
void User;
void Car;
void Broker;
void LogisticsPartner;
void confirmBooking;

const stripe = stripeFactory();
void stripe;

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

describe('LENF-03 confirm-booking TOCTOU listing-status re-verify (Plan 09-05 contract)', () => {
  // (a) — 09-LENF03-B-a — listing flipped to suspended → 409 + body has refundId
  test.todo(
    'listing flipped to suspended mid-checkout → 409 + body has refundId, no orders created, car NOT booked'
  );

  // (b) — 09-LENF03-B-b — refund-first-throw-second ordering invariant
  test.todo(
    'stripe.refunds.create invocationCallOrder < throw invocation (refund-first-throw-second per D-11)'
  );

  // (c) — 09-LENF03-B-c — refund failure → refundFailed:true / refundId:null
  test.todo(
    'refund mockRejectedValue → response body has refundFailed: true, refundId: null'
  );

  // (d) — 09-LENF03-B-d — idempotencyKey passed as second arg (Pitfall 3 / A3)
  test.todo(
    "idempotencyKey passed as second arg to refunds.create — expect(__refundsCreateMock.mock.calls[0][1]).toEqual({ idempotencyKey: 'refund-pi_XXX' })"
  );

  // (e) — race test — concurrent admin.suspendListing + buyer confirm
  test.todo(
    'race: concurrent admin.suspendListing + buyer confirm — Promise.allSettled returns exactly one valid outcome, never both succeed'
  );

  // (f) — route-level supertest — handler maps ListingNotAvailableError → 409
  test.todo(
    'route-level supertest: confirm-booking handler maps ListingNotAvailableError to 409 with D-11 body'
  );
});
