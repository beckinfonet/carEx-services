// __tests__/listing-moderation/archiveListing.test.js
//
// Integration test for listingService.archiveListing() (Plan 08-03, LADM-03).
//
// Same shape as suspendListing.test.js (Plan 08-02) — Archive is a near-clone
// of Suspend at the data layer; the only differences are the target status
// literal ('archived') and the audit action verb ('archive'). Archive is
// semantically distinct from Suspend per D-09: 'inactive_seller' is the
// canonical reasonCategory enum value that exists exactly for this
// non-punitive cleanup path.
//
// Uses MongoMemoryReplSet fixture because session.withTransaction() requires
// replica-set mode.
//
// Coverage (per 08-03-PLAN.md Task 3 behavior block + 08-CONTEXT.md D-16):
//   1. happy path: active → archived (audit row + Car state both correct,
//      reasonCategory='inactive_seller')
//   2. same-state archived → archive: throws 'already_in_state' + zero
//      audit rows (D-B-1 fast-path)
//   3. cross-state suspended → archive succeeds (D-B open matrix)
//   4. cross-state deleted → archive succeeds (D-B open matrix)
//   5. response shape matches D-02 thin projection (exact key set, no leak)
//
// Car docs seeded via Car.collection.insertOne() to skip the pre(/^find/)
// seller-cascade hide-hook noise + model-level pre-save validators (mirrors
// suspendListing.test.js:45-61 + editProfile.test.js:54-57).

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

describe('service.archiveListing (LADM-03)', () => {
  test('happy path active → archived: audit row + Car state both correct (inactive_seller)', async () => {
    const carId = await seedCar();

    const result = await service.archiveListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'inactive_seller',
      note: 'seller dormant 90+ days',
    });

    // Audit row assertions
    const audits = await ListingModerationAction.find({ listingId: carId }).lean();
    expect(audits.length).toBe(1);
    const audit = audits[0];
    expect(audit.action).toBe('archive');
    expect(audit.fromStatus).toBe('active');
    expect(audit.toStatus).toBe('archived');
    expect(audit.reasonCategory).toBe('inactive_seller');
    expect(audit.reasonNote).toBe('seller dormant 90+ days');
    expect(audit.listingId).toBe(carId);
    expect(audit.sellerUid).toBe('seller-x');
    expect(audit.adminUid).toBe('admin-uid');
    expect(audit.adminEmail).toBe('admin@test.local');

    // Car state assertions — read with the double bypass to defeat both hooks
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('archived');
    expect(car.moderationReason).toBe('inactive_seller');
    expect(car.moderationNote).toBe('seller dormant 90+ days');
    expect(car.moderatedBy).toBe('admin-uid');
    expect(car.moderatedAt).toBeInstanceOf(Date);

    // Response shape
    expect(result.listing._id).toBe(carId);
    expect(result.listing.status).toBe('archived');
    expect(result.listing.moderatedBy).toBe('admin-uid');
    expect(result.listing.moderatedAt).toBeInstanceOf(Date);
    expect(result.action.action).toBe('archive');
    expect(result.action.fromStatus).toBe('active');
    expect(result.action.toStatus).toBe('archived');
    expect(typeof result.action._id).toBe('string');
    expect(result.action.createdAt).toBeInstanceOf(Date);
  });

  test('same-state archived → archive: throws already_in_state + zero audit rows', async () => {
    const carId = await seedCar({ status: 'archived' });

    await expect(service.archiveListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'inactive_seller',
      note: null,
    })).rejects.toThrow('already_in_state');

    // No audit row appended on the rejected same-state call (D-B-1 fast-path)
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);

    // Car state unchanged
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('archived');
  });

  test('cross-state suspended → archive succeeds (D-B open matrix)', async () => {
    const carId = await seedCar({ status: 'suspended' });

    const result = await service.archiveListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'inactive_seller',
      note: 'reclassifying — seller went dormant',
    });

    expect(result.action.fromStatus).toBe('suspended');
    expect(result.action.toStatus).toBe('archived');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('suspended');
    expect(audit.toStatus).toBe('archived');
    expect(audit.action).toBe('archive');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('archived');
  });

  test('cross-state deleted → archive succeeds (D-B open matrix)', async () => {
    const carId = await seedCar({ status: 'deleted' });

    const result = await service.archiveListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'inactive_seller',
      note: 'restoring as archive instead of full restore',
    });

    expect(result.action.fromStatus).toBe('deleted');
    expect(result.action.toStatus).toBe('archived');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('deleted');
    expect(audit.toStatus).toBe('archived');
    expect(audit.action).toBe('archive');
  });

  test('response shape matches D-02 thin projection (exact key set, no leak)', async () => {
    const carId = await seedCar();

    const result = await service.archiveListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'inactive_seller',
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
});
