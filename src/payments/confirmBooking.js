// src/payments/confirmBooking.js
//
// Shared transactional confirm-booking service (Phase 3 Plan 03-04, closes ENF-03).
//
// Closes the TOCTOU race between POST /api/payments/create-payment-intent and
// POST /api/payments/confirm-booking: an admin may suspend a provider (buyer,
// broker, logistics, or the car's seller) in the window between those two
// requests. This service re-verifies every party INSIDE a Mongoose transaction
// and aborts with a Stripe refund if any party is non-active or has lost their
// role approval.
//
// Ordering contract (D-11): Stripe refunds are NOT in the Mongo transaction.
// Refund first, throw second. Reversing the order risks "buyer charged, no
// order, no refund" on Stripe API failure.
//
// Bypass contract (D-07): every User/Car/Broker/LogisticsPartner read inside
// this service passes .setOptions({ includeAllUsers: true }) to bypass the
// Plan 03-01 pre(/^find/) hide hooks. Without the bypass, the hook would hide
// suspended/revoked parties and the handler would 404 instead of 409 —
// masking the exact race this service closes.

const mongoose = require('mongoose');
const User = require('../models/User');
const Car = require('../models/Car');
const Broker = require('../models/Broker');
const LogisticsPartner = require('../models/LogisticsPartner');
// Phase 9 Plan 09-01 — shared refund-first-throw-second helper. ProviderSuspendedError
// class moved into refundAndThrow.js to avoid circular require; re-exported below
// for back-compat (server.js:1061 instanceof + existing test
// __tests__/enforcement/confirmBooking.transaction.test.js require unchanged).
// Phase 9 Plan 09-05 — ListingNotAvailableError pulled from the SAME canonical
// neighbor module per W-7 so the class object referenced by `throw new
// ListingNotAvailableError(...)` here matches the class referenced by
// `if (err instanceof ListingNotAvailableError)` in server.js (Plan 04).
const { refundAndThrow, ListingNotAvailableError, ProviderSuspendedError } = require('./refundAndThrow');
// Phase 9 Plan 09-05 — LISTING_STATUS_POLICY supplies the D-11 banner field for
// the 409 listing_not_available body (consistent with the cart-add gate in
// Plan 09-04 server.js:1118 — single source of truth for banner copy).
const { LISTING_STATUS_POLICY } = require('../moderation/listingCapabilities');
// ServiceOrder stays inline in server.js per Phase 1 D-02; resolve lazily inside
// the function body via mongoose.model('ServiceOrder') so this module works
// whether server.js has loaded yet (test isolation).

// De-dupe items by { providerUid, providerType }. Pure — no DB calls.
// Mirrors the grouping in server.js:1079-1116 (POST /api/orders handler).
function buildProviderGroups(items) {
  const groupsByKey = {};
  for (const item of items) {
    const key = `${item.providerUid}_${item.providerType}`;
    if (!groupsByKey[key]) {
      groupsByKey[key] = {
        providerUid: item.providerUid,
        providerType: item.providerType,
        services: [],
      };
    }
    groupsByKey[key].services.push(item.service);
  }
  return Object.values(groupsByKey);
}

// orderNumber generator (mirrors server.js:160-166).
function generateOrderNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = 'ORD-';
  for (let i = 0; i < 3; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  result += '-';
  for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

/**
 * Confirm a booking atomically.
 *
 * @param {object} args
 * @param {object} args.stripe - Stripe SDK instance (injected for testability).
 * @param {string} args.paymentIntentId
 * @param {string} args.carId
 * @param {string} args.buyerUid
 * @param {Array<{providerUid: string, providerType: 'broker'|'logistics', service: object}>} args.items
 * @returns {Promise<{ car: object, orders: Array<object> }>}
 * @throws {ProviderSuspendedError} with { providerUid, refundId, refundFailed }
 * @throws {ListingNotAvailableError} with { listingStatus, reasonCategory, banner, refundId, refundFailed } — Phase 9 LENF-03 (Plan 09-05); thrown when car.status !== 'active' inside the transaction
 * @throws {Error} 'invalid_payment_intent' if PI.status !== 'succeeded' (no refund — no charge)
 * @throws {Error} 'car_not_found' if carId resolves to null
 */
async function confirmBooking({ stripe, paymentIntentId, carId, buyerUid, items = [] }) {
  // --- Idempotency fast-path (Claude's Discretion — 03-CONTEXT.md) ----------
  // If a buyer retries the same paymentIntentId after a previous successful
  // booking, short-circuit with the existing car + ServiceOrder rows. Prevents
  // double-charge / double-refund storms on mobile retry loops (T-03-04-06).
  const existingCar = await Car.findById(carId).setOptions({ includeAllUsers: true }).lean();
  if (existingCar && existingCar.stripePaymentIntentId === paymentIntentId) {
    const ServiceOrder = mongoose.model('ServiceOrder');
    const existingOrders = await ServiceOrder.find({ stripePaymentIntentId: paymentIntentId }).lean();
    return { car: existingCar, orders: existingOrders };
  }

  // --- Stripe PI retrieval (OUTSIDE transaction; no refund if not succeeded) -
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== 'succeeded') {
    const err = new Error('invalid_payment_intent');
    err.code = 'invalid_payment_intent';
    throw err;
  }

  const providerGroups = buildProviderGroups(items);
  let savedCar;
  const savedOrders = [];

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Stripe refunds are NOT in the Mongo transaction. Refund first, throw second.
      // Reversed order risks "buyer charged, no order, no refund" on Stripe API failure.

      // WR-04 fix: rebuild a LOCAL copy of the group list on each transaction
      // attempt. session.withTransaction auto-retries on transient errors
      // (D-13 / D-23); if we mutate the outer providerGroups array in place,
      // retries see stale providerSnapshot / drifted snapshotAt timestamps,
      // and any future additive mutation (push vs wholesale reassign) would
      // accumulate data across retries. Cloning makes each attempt
      // self-contained.
      const localGroups = providerGroups.map((g) => ({
        providerUid: g.providerUid,
        providerType: g.providerType,
        services: g.services,
      }));
      // Reset per-attempt mutable accumulators so retries do not carry over
      // orders created on a prior (rolled-back) attempt.
      savedOrders.length = 0;

      // ---- a. Buyer re-check (D-14) --------------------------------------
      const buyer = await User.findOne({ firebaseUid: buyerUid })
        .setOptions({ includeAllUsers: true })
        .session(session)
        .lean();
      if (!buyer || buyer.moderationStatus?.state !== 'active') {
        await refundAndThrow(stripe, paymentIntentId, {
          error: 'provider_suspended',
          providerUid: buyerUid,
        });
      }

      // ---- b. Provider re-check + providerSnapshot build -----------------
      for (const group of localGroups) {
        const providerUser = await User.findOne({ firebaseUid: group.providerUid })
          .setOptions({ includeAllUsers: true })
          .session(session)
          .lean();
        const roleField = group.providerType === 'broker' ? 'brokerStatus' : 'logisticsStatus';
        if (
          !providerUser ||
          providerUser.moderationStatus?.state !== 'active' ||
          providerUser[roleField] !== 'APPROVED'
        ) {
          await refundAndThrow(stripe, paymentIntentId, {
            error: 'provider_suspended',
            providerUid: group.providerUid,
          });
        }

        const ProfileModel = group.providerType === 'broker' ? Broker : LogisticsPartner;
        const profile = await ProfileModel.findOne({ ownerUid: group.providerUid })
          .setOptions({ includeAllUsers: true })
          .session(session)
          .lean();

        // providerSnapshot resolution — server-authoritative per Phase 1 D-21..D-24.
        group.providerSnapshot = {
          companyName: profile?.companyName ?? null,
          phoneNumber: profile?.phoneNumber ?? null,
          telegramUsername: profile?.telegramUsername ?? null,
          email: providerUser.email ?? null,
          firstName: providerUser.firstName ?? null,
          lastName: providerUser.lastName ?? null,
          providerRole: group.providerType,
          snapshotAt: new Date(),
        };
      }

      // ---- c. Seller re-check + listing-status re-check + car flip -------
      // Phase 9 LENF-03 (Plan 09-05): the Car refetch chains BOTH bypass flags
      // below (D-12 / Pitfall 1) — without the listing-status bypass, the Plan
      // 02 hide hook would 404 a suspended listing inside the transaction and
      // the buyer would be charged with no refund. The third in-txn check on
      // car.status === 'active' (D-13) routes through refundAndThrow with the
      // listing_not_available discriminator → ListingNotAvailableError throw →
      // server.js 409 mapping (Plan 04).
      const car = await Car.findById(carId)
        .setOptions({ includeAllUsers: true, includeAllListingStatuses: true })
        .session(session);
      if (!car) {
        throw new Error('car_not_found');
      }

      const sellerUser = await User.findOne({ firebaseUid: car.sellerId })
        .setOptions({ includeAllUsers: true })
        .session(session)
        .lean();
      if (
        !sellerUser ||
        sellerUser.moderationStatus?.state !== 'active' ||
        sellerUser.sellerStatus !== 'APPROVED'
      ) {
        await refundAndThrow(stripe, paymentIntentId, {
          error: 'provider_suspended',
          providerUid: car.sellerId,
        });
      }

      // Phase 9 LENF-03 — third TOCTOU dimension: listing status (D-13).
      // Runs AFTER the seller checks (D-13 ordering: cheaper seller checks
      // first; non-active seller + non-active listing routes through the
      // provider_suspended refund path, preserving v1.0 semantics for the
      // seller dimension).
      if (car.status !== 'active') {
        const banner = LISTING_STATUS_POLICY[car.status]?.banner ?? null;
        await refundAndThrow(stripe, paymentIntentId, {
          error: 'listing_not_available',
          listingStatus: car.status,
          reasonCategory: car.moderationReason,
          banner,
        });
      }

      car.listingStatus = 'booked';
      car.bookedByUid = buyerUid;
      car.stripePaymentIntentId = paymentIntentId;
      await car.save({ session });
      savedCar = car.toObject();
      savedCar.id = car._id.toString();

      // ---- d. ServiceOrder row creation (one per provider group) ---------
      // Array form is required by Mongoose to accept { session } per Phase 2 D-23.
      const ServiceOrder = mongoose.model('ServiceOrder');
      const carSnapshot = {
        makeName: car.makeName,
        modelName: car.modelName,
        year: car.year,
        price: car.price,
        currency: car.currency,
        imageUrl: Array.isArray(car.imageUrls) && car.imageUrls.length > 0 ? car.imageUrls[0] : null,
        listingId: car.listingId,
      };

      for (const group of localGroups) {
        let totalAmount = 0;
        let totalCurrency = '$';
        for (const svc of group.services) {
          const fee = parseFloat(svc.fee);
          if (!isNaN(fee)) {
            totalAmount += fee;
            if (svc.currency) totalCurrency = svc.currency;
          }
        }

        // Unique orderNumber — retry until collision-free. Lookup is {session}-scoped
        // so it participates in the transaction's snapshot isolation.
        // WR-03 fix: cap retries. The orderNumber key-space is ~3.4e10 so a
        // genuine collision is astronomically rare, but if the orderNumber
        // index is ever dropped/corrupted this loop would spin forever inside
        // the Mongo transaction and exhaust the transaction lifetime.
        let orderNumber;
        let attempts = 0;
        const MAX_ORDER_NUMBER_ATTEMPTS = 8;
        while (attempts < MAX_ORDER_NUMBER_ATTEMPTS) {
          orderNumber = generateOrderNumber();
          const existing = await ServiceOrder.findOne({ orderNumber }).session(session).lean();
          if (!existing) break;
          attempts += 1;
        }
        if (attempts >= MAX_ORDER_NUMBER_ATTEMPTS) {
          throw new Error('order_number_generation_exhausted');
        }

        const [order] = await ServiceOrder.create(
          [
            {
              orderNumber,
              buyerUid,
              carId: car._id.toString(),
              carSnapshot,
              providerUid: group.providerUid,
              providerType: group.providerType,
              providerSnapshot: group.providerSnapshot,
              services: group.services,
              totalAmount,
              totalCurrency,
              buyerNote: '',
              stripePaymentIntentId: paymentIntentId,
            },
          ],
          { session }
        );

        const orderObj = order.toObject();
        orderObj.id = order._id.toString();
        savedOrders.push(orderObj);
      }
    });
  } finally {
    await session.endSession();
  }

  return { car: savedCar, orders: savedOrders };
}

module.exports = { confirmBooking, ProviderSuspendedError };
