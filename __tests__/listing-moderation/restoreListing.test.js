// __tests__/listing-moderation/restoreListing.test.js
//
// Integration test for listingService.restoreListing() (Plan 08-05, LADM-05).
//
// Near-clone of suspendListing.test.js (Plan 08-02), with intentional Restore-
// specific divergences:
//   - Service payload is { adminUid, adminEmail, carId, note } — NO reasonCategory
//     (D-C symmetry — Restore body has only an optional note).
//   - Target status is 'active' (not 'suspended'/'archived'/'deleted').
//   - Audit action is 'restore'; audit.reasonCategory must be null (D-C).
//   - Car.moderationReason + Car.moderationNote MUST be CLEARED to null after
//     a successful restore (D-C-1 clear-on-restore — live Car reflects current
//     state; audit log retains historical reason).
//   - Car.moderatedBy + Car.moderatedAt MUST update to the restoring admin +
//     the new timestamp (D-C-2 — Restore IS a state change).
//   - not_moderated rejection on already-active (Pitfall 10 — DISTINCT code
//     from already_in_state; semantics: "you can't restore an active listing
//     because it isn't moderated").
//
// LADM-05 history-preservation invariant: prior audit rows must NEVER be edited
// or removed by Restore. Restore APPENDS a new row; the historical chain stays
// intact. Test 5 below seeds one prior 'suspend' audit row, captures its _id,
// runs Restore, and asserts the original row is byte-identical post-call AND a
// new 'restore' row has been appended (countDocuments === 2).
//
// Uses MongoMemoryReplSet fixture because session.withTransaction() requires
// replica-set mode.
//
// Coverage (per 08-05-PLAN.md Task 3 behavior block + 08-CONTEXT.md D-C / D-C-1 /
// D-C-2 / D-03 / Pitfall 10 + 08-PATTERNS.md §12):
//   1. happy path suspended → active (audit + Car state + D-C-1 clear + D-C-2 update)
//   2. happy path archived → active
//   3. happy path deleted → active
//   4. not_moderated rejection on already-active (Pitfall 10 — distinct code)
//   5. LADM-05 history preservation — prior audit rows untouched, new row appended
//   6. listing_not_found on ghost ObjectId
//   7. Response shape D-02 thin projection (5+5 keys, no extras)

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

describe('service.restoreListing (LADM-05)', () => {
  test('happy path suspended → active: audit row + Car state + D-C-1 clear + D-C-2 update', async () => {
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'spam',
      moderationNote: 'original suspend note',
      moderatedBy: 'admin-original',
      moderatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await service.restoreListing({
      adminUid: 'admin-restorer',
      adminEmail: 'restorer@test.local',
      carId,
      note: 'appeal accepted',
    });

    // Audit row assertions (D-C — reasonCategory: null on Restore)
    const audits = await ListingModerationAction.find({ listingId: carId }).lean();
    expect(audits.length).toBe(1);
    const audit = audits[0];
    expect(audit.action).toBe('restore');
    expect(audit.fromStatus).toBe('suspended');
    expect(audit.toStatus).toBe('active');
    expect(audit.reasonCategory).toBeNull();
    expect(audit.reasonNote).toBe('appeal accepted');
    expect(audit.listingId).toBe(carId);
    expect(audit.sellerUid).toBe('seller-x');
    expect(audit.adminUid).toBe('admin-restorer');
    expect(audit.adminEmail).toBe('restorer@test.local');

    // Car state assertions — read with the double bypass to defeat both hooks
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('active');
    // D-C-1: moderationReason + moderationNote CLEARED to null on Restore
    expect(car.moderationReason).toBeNull();
    expect(car.moderationNote).toBeNull();
    // D-C-2: moderatedBy + moderatedAt UPDATED to the restoring admin
    expect(car.moderatedBy).toBe('admin-restorer');
    expect(car.moderatedAt).toBeInstanceOf(Date);
    // moderatedAt must NOT be the original suspend timestamp (fresh Date)
    expect(car.moderatedAt.getTime()).not.toBe(new Date('2026-01-01T00:00:00.000Z').getTime());

    // Response shape
    expect(result.listing._id).toBe(carId);
    expect(result.listing.status).toBe('active');
    expect(result.listing.moderatedBy).toBe('admin-restorer');
    expect(result.listing.moderatedAt).toBeInstanceOf(Date);
    expect(result.action.action).toBe('restore');
    expect(result.action.fromStatus).toBe('suspended');
    expect(result.action.toStatus).toBe('active');
    expect(typeof result.action._id).toBe('string');
    expect(result.action.createdAt).toBeInstanceOf(Date);
  });

  test('happy path archived → active (audit fromStatus=archived; D-C-1 clear)', async () => {
    const carId = await seedCar({
      status: 'archived',
      moderationReason: 'inactive_seller',
      moderationNote: 'seller went dormant',
      moderatedBy: 'admin-original',
      moderatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await service.restoreListing({
      adminUid: 'admin-restorer',
      adminEmail: 'restorer@test.local',
      carId,
      note: null,
    });

    expect(result.action.fromStatus).toBe('archived');
    expect(result.action.toStatus).toBe('active');
    expect(result.action.action).toBe('restore');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('archived');
    expect(audit.action).toBe('restore');
    expect(audit.reasonCategory).toBeNull();
    expect(audit.reasonNote).toBeNull();

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('active');
    expect(car.moderationReason).toBeNull();
    expect(car.moderationNote).toBeNull();
    expect(car.moderatedBy).toBe('admin-restorer');
  });

  test('happy path deleted → active (audit fromStatus=deleted; soft-deleted doc restorable)', async () => {
    // Plan 08-04 leaves the document in MongoDB with status='deleted'.
    // Plan 08-05 Restore MUST be able to find and flip it back to 'active'.
    const carId = await seedCar({
      status: 'deleted',
      moderationReason: 'spam',
      moderationNote: 'soft-deleted by admin',
      moderatedBy: 'admin-original',
      moderatedAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    const result = await service.restoreListing({
      adminUid: 'admin-restorer',
      adminEmail: 'restorer@test.local',
      carId,
      note: 'false positive on spam classifier',
    });

    expect(result.action.fromStatus).toBe('deleted');
    expect(result.action.toStatus).toBe('active');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('deleted');
    expect(audit.action).toBe('restore');
    expect(audit.reasonCategory).toBeNull();
    expect(audit.reasonNote).toBe('false positive on spam classifier');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('active');
    expect(car.moderationReason).toBeNull();
    expect(car.moderationNote).toBeNull();
    expect(car.moderatedBy).toBe('admin-restorer');
  });

  test('not_moderated: Restore on already-active throws not_moderated (NOT already_in_state — Pitfall 10)', async () => {
    // Pitfall 10 — distinct semantics: already_in_state is the cross-action
    // no-op (Suspend on suspended, Archive on archived, Delete on deleted);
    // not_moderated is the Restore-specific case ("you can't restore an
    // active listing because it isn't moderated"). Two distinct codes for two
    // distinct semantic situations.
    const carId = await seedCar({ status: 'active' });

    await expect(service.restoreListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      note: null,
    })).rejects.toThrow('not_moderated');

    // No audit row appended on the rejected already-active call (same
    // fast-path discipline as same-state guards on Suspend/Archive/Delete)
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);

    // Car state unchanged
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('active');
  });

  test('LADM-05 history preservation: prior audit row byte-identical, new restore row appended', async () => {
    // Seed a Car that was previously suspended, AND seed ONE prior audit row
    // representing the original suspend. Then call Restore and assert:
    //   (a) the original 'suspend' row is byte-identical after Restore (same
    //       _id, same action, same reasonCategory, same createdAt) — proving
    //       that history is NEVER rewritten (LADM-05 acceptance criterion).
    //   (b) a NEW row with action='restore' has been appended, so total
    //       countDocuments({ listingId }) === 2.
    //
    // This is the test-layer enforcement of LADM-05 "history never rewritten"
    // — Phase 7's 6 append-only pre-hooks on ListingModerationAction are the
    // schema-layer enforcement; this test proves the discipline holds at the
    // integration layer too.
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'spam',
      moderationNote: 'original note',
      moderatedBy: 'admin-original',
      moderatedAt: new Date('2026-01-10T00:00:00.000Z'),
    });

    const originalSuspendCreatedAt = new Date('2026-01-10T00:00:00.000Z');
    const insertResult = await ListingModerationAction.collection.insertOne({
      listingId: carId,
      sellerUid: 'seller-x',
      adminUid: 'admin-original',
      adminEmail: 'orig@x',
      action: 'suspend',
      fromStatus: 'active',
      toStatus: 'suspended',
      reasonCategory: 'spam',
      reasonNote: 'original note',
      fieldDiff: null,
      createdAt: originalSuspendCreatedAt,
    });
    const originalRowId = insertResult.insertedId;

    // Sanity: exactly 1 row before Restore
    const preCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(preCount).toBe(1);

    await service.restoreListing({
      adminUid: 'admin-new',
      adminEmail: 'new@x',
      carId,
      note: null,
    });

    // Post-call: exactly 2 rows (original suspend + new restore)
    const postCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(postCount).toBe(2);

    // (a) Original 'suspend' row byte-identical — _id round-trip + all fields
    const originalAfter = await ListingModerationAction.collection.findOne({ _id: originalRowId });
    expect(originalAfter).not.toBeNull();
    expect(originalAfter.action).toBe('suspend');
    expect(originalAfter.fromStatus).toBe('active');
    expect(originalAfter.toStatus).toBe('suspended');
    expect(originalAfter.reasonCategory).toBe('spam');
    expect(originalAfter.reasonNote).toBe('original note');
    expect(originalAfter.adminUid).toBe('admin-original');
    expect(originalAfter.adminEmail).toBe('orig@x');
    expect(originalAfter.createdAt).toEqual(originalSuspendCreatedAt);

    // (b) New 'restore' row appended with reasonCategory: null (D-C)
    const restoreRow = await ListingModerationAction.findOne({
      listingId: carId,
      action: 'restore',
    }).lean();
    expect(restoreRow).not.toBeNull();
    expect(restoreRow.fromStatus).toBe('suspended');
    expect(restoreRow.toStatus).toBe('active');
    expect(restoreRow.reasonCategory).toBeNull();
    expect(restoreRow.adminUid).toBe('admin-new');
  });

  test('listing_not_found on ghost ObjectId', async () => {
    const ghostId = new mongoose.Types.ObjectId().toString();

    await expect(service.restoreListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId: ghostId,
      note: null,
    })).rejects.toThrow('listing_not_found');
  });

  test('Response shape: D-02 thin projection — exactly 4+5 keys, no extras', async () => {
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'fraud',
      moderationNote: 'prior note',
      moderatedBy: 'admin-original',
      moderatedAt: new Date('2026-01-04T00:00:00.000Z'),
    });

    const result = await service.restoreListing({
      adminUid: 'admin-restorer',
      adminEmail: 'restorer@test.local',
      carId,
      note: null,
    });

    // listing payload: exactly 4 keys — _id, status, moderatedBy, moderatedAt
    expect(Object.keys(result.listing).sort()).toEqual(
      ['_id', 'moderatedAt', 'moderatedBy', 'status']
    );
    // action payload: exactly 5 keys — _id, action, createdAt, fromStatus, toStatus
    expect(Object.keys(result.action).sort()).toEqual(
      ['_id', 'action', 'createdAt', 'fromStatus', 'toStatus']
    );
    // Negative shape — no description / imageUrls / price / moderationReason /
    // moderationNote leak through (D-C-1 cleared fields must NOT show up)
    expect(result.listing).not.toHaveProperty('description');
    expect(result.listing).not.toHaveProperty('imageUrls');
    expect(result.listing).not.toHaveProperty('price');
    expect(result.listing).not.toHaveProperty('moderationReason');
    expect(result.listing).not.toHaveProperty('moderationNote');
  });
});
