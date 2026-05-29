// __tests__/listing-moderation/suspendListing.test.js
//
// Integration test for listingService.suspendListing() (Plan 08-02, LADM-02).
//
// Uses MongoMemoryReplSet fixture because session.withTransaction() requires
// replica-set mode. Mirrors __tests__/moderation/suspend.test.js shape but
// against the LISTING domain (Car + ListingModerationAction) instead of the
// USER domain (User + ModerationAction).
//
// Coverage (per 08-02-PLAN.md Task 3 behavior block + 08-CONTEXT.md D-16):
//   1. happy path: active → suspended (audit row + Car state both correct)
//   2. same-state suspend → throws 'already_in_state' + zero audit rows
//   3. cross-state archived → suspend succeeds (D-B open matrix)
//   4. cross-state deleted → suspend succeeds (D-B open matrix)
//   5. listing_not_found on never-seeded ObjectId
//   6. missing reasonCategory → throws 'invalid_payload' (defensive guard)
//   7. response shape matches D-02 thin projection (exact key set)
//   8. note omitted → audit.reasonNote === null AND Car.moderationNote === null
//
// Car docs seeded via Car.collection.insertOne() to skip the pre(/^find/)
// seller-cascade hide-hook noise + model-level pre-save validators (mirrors
// editProfile.test.js:54-57 + listingTransaction.atomicity.test.js:81-85).

const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');

const service = require('../../src/moderation/listingService');
const Car = require('../../src/models/Car');
const ListingModerationAction = require('../../src/models/ListingModerationAction');

let rs;

beforeAll(async () => { rs = await startReplSet(); });
afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await Car.deleteMany({});
  try {
    await ListingModerationAction.collection.drop();
  } catch (_) {
    // may not exist yet
  }
});

// Seed a Car directly via collection.insertOne so we bypass:
//   - Mongoose pre-save validators (cleaner test surface)
//   - the pre(/^find/) seller-cascade hide hook during seeding
// Returns the inserted _id as a string (Phase 8 audit rows store listingId
// as string per ListingModerationAction.js:41).
async function seedCar(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Car.collection.insertOne({
    _id,
    sellerId: 'seller-x',
    status: 'active',
    listingStatus: 'active',
    createdAt: new Date(),
    ...overrides,
  });
  return _id.toString();
}

describe('service.suspendListing (LADM-02)', () => {
  test('happy path active → suspended: audit row + Car state both correct', async () => {
    const carId = await seedCar();

    const result = await service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'spam',
      note: 'manual test',
    });

    // Audit row assertions
    const audits = await ListingModerationAction.find({ listingId: carId }).lean();
    expect(audits.length).toBe(1);
    const audit = audits[0];
    expect(audit.action).toBe('suspend');
    expect(audit.fromStatus).toBe('active');
    expect(audit.toStatus).toBe('suspended');
    expect(audit.reasonCategory).toBe('spam');
    expect(audit.reasonNote).toBe('manual test');
    expect(audit.listingId).toBe(carId);
    expect(audit.sellerUid).toBe('seller-x');
    expect(audit.adminUid).toBe('admin-uid');
    expect(audit.adminEmail).toBe('admin@test.local');

    // Car state assertions — read with the double bypass to defeat both hooks
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('suspended');
    expect(car.moderationReason).toBe('spam');
    expect(car.moderationNote).toBe('manual test');
    expect(car.moderatedBy).toBe('admin-uid');
    expect(car.moderatedAt).toBeInstanceOf(Date);

    // Response shape
    expect(result.listing._id).toBe(carId);
    expect(result.listing.status).toBe('suspended');
    expect(result.listing.moderatedBy).toBe('admin-uid');
    expect(result.listing.moderatedAt).toBeInstanceOf(Date);
    expect(result.action.action).toBe('suspend');
    expect(result.action.fromStatus).toBe('active');
    expect(result.action.toStatus).toBe('suspended');
    expect(typeof result.action._id).toBe('string');
    expect(result.action.createdAt).toBeInstanceOf(Date);
  });

  test('same-state suspended → suspend: throws already_in_state + zero audit rows', async () => {
    const carId = await seedCar({ status: 'suspended' });

    await expect(service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'spam',
      note: null,
    })).rejects.toThrow('already_in_state');

    // No audit row appended on the rejected same-state call
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);

    // Car state unchanged
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('suspended');
  });

  test('cross-state archived → suspend succeeds (D-B open matrix)', async () => {
    const carId = await seedCar({ status: 'archived' });

    const result = await service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'fraud',
      note: 'escalating from archive',
    });

    expect(result.action.fromStatus).toBe('archived');
    expect(result.action.toStatus).toBe('suspended');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('archived');
    expect(audit.toStatus).toBe('suspended');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('suspended');
  });

  test('cross-state deleted → suspend succeeds (D-B open matrix)', async () => {
    const carId = await seedCar({ status: 'deleted' });

    const result = await service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'policy_violation',
      note: 'reactivating to review',
    });

    expect(result.action.fromStatus).toBe('deleted');
    expect(result.action.toStatus).toBe('suspended');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('deleted');
    expect(audit.toStatus).toBe('suspended');
  });

  test('listing not found: throws listing_not_found', async () => {
    const ghostId = new mongoose.Types.ObjectId().toString();

    await expect(service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId: ghostId,
      reasonCategory: 'spam',
    })).rejects.toThrow('listing_not_found');
  });

  test('missing reasonCategory: throws invalid_payload (defensive guard)', async () => {
    const carId = await seedCar();

    await expect(service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      // reasonCategory deliberately omitted
    })).rejects.toThrow('invalid_payload');

    // No audit row written on rejected call
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);
  });

  test('response shape matches D-02 thin projection (exact key set, no leak)', async () => {
    const carId = await seedCar();

    const result = await service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'spam',
      note: 'shape check',
    });

    // Listing projection: exactly { _id, status, moderatedBy, moderatedAt }
    expect(Object.keys(result.listing).sort()).toEqual(
      ['_id', 'moderatedAt', 'moderatedBy', 'status'].sort()
    );
    // Action projection: exactly { _id, action, fromStatus, toStatus, createdAt }
    expect(Object.keys(result.action).sort()).toEqual(
      ['_id', 'action', 'createdAt', 'fromStatus', 'toStatus'].sort()
    );

    // Negative shape: NO leaked Car fields like description / imageUrls / price
    expect(result.listing.description).toBeUndefined();
    expect(result.listing.imageUrls).toBeUndefined();
    expect(result.listing.price).toBeUndefined();
    expect(result.listing.moderationNote).toBeUndefined();
    expect(result.listing.moderationReason).toBeUndefined();
  });

  test('note omitted: audit.reasonNote === null AND Car.moderationNote === null', async () => {
    const carId = await seedCar();

    await service.suspendListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'spam',
      // note deliberately omitted
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.reasonNote).toBeNull();

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.moderationNote).toBeNull();
  });
});
