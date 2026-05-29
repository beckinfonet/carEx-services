// __tests__/listing-moderation/deleteListing.test.js
//
// Integration test for listingService.deleteListing() (Plan 08-04, LADM-04).
//
// Same shape as suspendListing.test.js (Plan 08-02) and archiveListing.test.js
// (Plan 08-03) — Delete is a near-clone at the data layer; the only structural
// differences are the target status literal ('deleted') and the audit action
// verb ('delete').
//
// LADM-04 CRITICAL INVARIANT: this is a SOFT-delete. The Car document is NOT
// removed from MongoDB; only Car.status flips to 'deleted'. Plan 08-05's
// Restore can flip the same document back to 'active'. Test 2 below pins this
// invariant via Car.countDocuments({ _id: carId }) post-call.
//
// Uses MongoMemoryReplSet fixture because session.withTransaction() requires
// replica-set mode.
//
// Coverage (per 08-04-PLAN.md Task 3 behavior block + 08-CONTEXT.md D-16):
//   1. happy path: active → deleted (audit row + Car state both correct,
//      reasonCategory='spam')
//   2. **LADM-04 soft-delete invariant**: Car.countDocuments === 1 post-call;
//      doc persists with status='deleted', sellerId + createdAt preserved
//   3. same-state deleted → delete: throws 'already_in_state' + zero audit rows
//      (D-B-1 fast-path)
//   4. cross-state suspended → delete succeeds (D-B open matrix)
//   5. cross-state archived → delete succeeds (D-B open matrix)

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

describe('service.deleteListing (LADM-04)', () => {
  test('happy path active → deleted: audit row + Car state both correct (spam)', async () => {
    const carId = await seedCar();

    const result = await service.deleteListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'spam',
      note: 'confirmed spam listing',
    });

    // Audit row assertions
    const audits = await ListingModerationAction.find({ listingId: carId }).lean();
    expect(audits.length).toBe(1);
    const audit = audits[0];
    expect(audit.action).toBe('delete');
    expect(audit.fromStatus).toBe('active');
    expect(audit.toStatus).toBe('deleted');
    expect(audit.reasonCategory).toBe('spam');
    expect(audit.reasonNote).toBe('confirmed spam listing');
    expect(audit.listingId).toBe(carId);
    expect(audit.sellerUid).toBe('seller-x');
    expect(audit.adminUid).toBe('admin-uid');
    expect(audit.adminEmail).toBe('admin@test.local');

    // Car state assertions — read with the double bypass to defeat both hooks
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('deleted');
    expect(car.moderationReason).toBe('spam');
    expect(car.moderationNote).toBe('confirmed spam listing');
    expect(car.moderatedBy).toBe('admin-uid');
    expect(car.moderatedAt).toBeInstanceOf(Date);

    // Response shape
    expect(result.listing._id).toBe(carId);
    expect(result.listing.status).toBe('deleted');
    expect(result.listing.moderatedBy).toBe('admin-uid');
    expect(result.listing.moderatedAt).toBeInstanceOf(Date);
    expect(result.action.action).toBe('delete');
    expect(result.action.fromStatus).toBe('active');
    expect(result.action.toStatus).toBe('deleted');
    expect(typeof result.action._id).toBe('string');
    expect(result.action.createdAt).toBeInstanceOf(Date);
  });

  test('LADM-04 soft-delete invariant: Car document survives delete-soft', async () => {
    // Seed with explicit, observable fields whose preservation we will assert.
    const fixedCreatedAt = new Date('2026-01-15T12:00:00.000Z');
    const carId = await seedCar({
      sellerId: 'seller-x',
      status: 'active',
      createdAt: fixedCreatedAt,
    });

    // Pre-call: doc exists exactly once
    const preCount = await Car.countDocuments({ _id: carId });
    expect(preCount).toBe(1);

    await service.deleteListing({
      adminUid: 'admin-1',
      adminEmail: 'a@x',
      carId,
      reasonCategory: 'spam',
      note: null,
    });

    // Post-call: doc STILL exists exactly once (LADM-04 critical invariant —
    // delete-soft means tomb status, document survives).
    const postCount = await Car.countDocuments({ _id: carId });
    expect(postCount).toBe(1);

    // Persisted doc has status flipped + original seeded fields preserved.
    // Read with the double bypass so Phase 9's future hide hook + Phase 3's
    // seller-cascade hook both step aside.
    const persisted = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(persisted).not.toBeNull();
    expect(persisted.status).toBe('deleted');
    expect(persisted.sellerId).toBe('seller-x');
    // createdAt preserved (only audit/status fields were updated)
    expect(persisted.createdAt).toEqual(fixedCreatedAt);
  });

  test('same-state deleted → delete: throws already_in_state + zero audit rows', async () => {
    const carId = await seedCar({ status: 'deleted' });

    await expect(service.deleteListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'spam',
      note: null,
    })).rejects.toThrow('already_in_state');

    // No audit row appended on the rejected same-state call (D-B-1 fast-path)
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);

    // Car state unchanged
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('deleted');
  });

  test('cross-state suspended → delete succeeds (D-B open matrix)', async () => {
    const carId = await seedCar({ status: 'suspended' });

    const result = await service.deleteListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'fraud',
      note: 'escalation after suspend review',
    });

    expect(result.action.fromStatus).toBe('suspended');
    expect(result.action.toStatus).toBe('deleted');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('suspended');
    expect(audit.toStatus).toBe('deleted');
    expect(audit.action).toBe('delete');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('deleted');
  });

  test('cross-state archived → delete succeeds (D-B open matrix)', async () => {
    const carId = await seedCar({ status: 'archived' });

    const result = await service.deleteListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      reasonCategory: 'policy_violation',
      note: 'archived seller, content still violates policy',
    });

    expect(result.action.fromStatus).toBe('archived');
    expect(result.action.toStatus).toBe('deleted');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('archived');
    expect(audit.toStatus).toBe('deleted');
    expect(audit.action).toBe('delete');
  });
});
