// __tests__/listing-enforcement/hideOnFind.listingStatus.test.js
//
// Phase 9 Plan 09-01 — Wave 0 RED scaffold for LENF-01 (listing-status hide hook).
// Covers VALIDATION rows 09-LENF01-a..d. Real implementation lands in Plan 09-02
// (the pre(/^find/) listing-status hook on Car.js with `includeAllListingStatuses`
// bypass flag per 09-CONTEXT D-01/D-04).
//
// INTENTIONAL RED at end of Plan 09-01: every test.todo here is a contract Plan
// 09-02 must satisfy. Plan 09-02 converts these to real assertions and turns
// this file GREEN.
//
// Harness shape mirrors __tests__/enforcement/hideOnFind.test.js (PATTERNS §9
// analog). MongoMemoryReplSet via __tests__/_helpers/mongoReplSet for any future
// transactional cases (Plan 09-02 may or may not need txn isolation; the harness
// is here for symmetry with the Phase 3 seller-cascade test file).

const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');
const Car = require('../../src/models/Car');
const User = require('../../src/models/User');

let rs;

beforeAll(async () => {
  rs = await startReplSet();
});

afterAll(async () => {
  await stopReplSet(rs);
});

beforeEach(async () => {
  await User.deleteMany({});
  // Use the includeAllUsers bypass so the existing Phase 3 seller-cascade hook
  // doesn't filter out cleanup deletes. The Phase 9 listing-status hook (LENF-01)
  // adds a second bypass `includeAllListingStatuses` that Plan 09-02 lands.
  await Car.deleteMany({ /* no filter */ }).setOptions({
    includeAllUsers: true,
    includeAllListingStatuses: true,
  });
});

// Shared seed: 1 active seller + 4 cars (one per listing status). Uses
// Car.collection.insertOne (Shared Pattern S-9) to bypass save validators AND
// pre(/^find/) hooks during seeding — required because the Phase 9 hide-hook
// (Plan 09-02) will hide non-active listings on every find by default.
async function seedFourStatusListings(sellerUid = 'seller-listing-status-1') {
  await User.create({
    firebaseUid: sellerUid,
    email: 'seller-listing-status@test.local',
    sellerStatus: 'APPROVED',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  const now = new Date();
  await Car.collection.insertMany([
    {
      sellerId: sellerUid,
      makeName: 'Toyota',
      modelName: 'Corolla',
      year: 2020,
      price: 15000,
      listingStatus: 'active',
      status: 'active',
      createdAt: now,
    },
    {
      sellerId: sellerUid,
      makeName: 'Honda',
      modelName: 'Civic',
      year: 2021,
      price: 18000,
      listingStatus: 'active',
      status: 'suspended',
      moderationReason: 'spam',
      createdAt: now,
    },
    {
      sellerId: sellerUid,
      makeName: 'BMW',
      modelName: 'X5',
      year: 2019,
      price: 45000,
      listingStatus: 'active',
      status: 'archived',
      moderationReason: 'inactive_seller',
      createdAt: now,
    },
    {
      sellerId: sellerUid,
      makeName: 'Ford',
      modelName: 'F-150',
      year: 2018,
      price: 25000,
      listingStatus: 'active',
      status: 'deleted',
      moderationReason: 'fraud',
      createdAt: now,
    },
  ]);
}

describe('LENF-01 pre(/^find/) listing-status hide hook (Plan 09-02 contract)', () => {
  // (a) — 09-LENF01-a
  test('Car.find({}) returns zero non-active listings by default (status=active only)', async () => {
    await seedFourStatusListings();
    const all = await Car.find({});
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('active');
  });

  // (b) — 09-LENF01-b
  test('Car.find({}).setOptions({ includeAllListingStatuses: true }) returns all four statuses including deleted', async () => {
    await seedFourStatusListings();
    const all = await Car.find({}).setOptions({ includeAllListingStatuses: true });
    expect(all).toHaveLength(4);
    expect(all.map(c => c.status).sort()).toEqual([
      'active',
      'archived',
      'deleted',
      'suspended',
    ]);
  });

  // (c) — 09-LENF01-c (Pitfall 2 — $and combine for caller-provided status filter)
  test("Car.find({ status: 'deleted' }).setOptions({ includeAllListingStatuses: true }) returns deleted listings — confirms $and combine for caller filter (Pitfall 2)", async () => {
    await seedFourStatusListings();
    const deleted = await Car.find({ status: 'deleted' }).setOptions({
      includeAllListingStatuses: true,
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0].status).toBe('deleted');
  });

  // (d) — 09-LENF01-d (W-2 rename: empty intersection, NOT "filter is preserved")
  test("non-admin querying non-active status: $and-combine produces empty intersection, returns 0 rows (defense in depth)", async () => {
    await seedFourStatusListings();
    // Without the bypass, the hook combines caller's { status: 'deleted' }
    // with the default { status: 'active' } via $and — the intersection
    // [{ status: 'deleted' }, { status: 'active' }] cannot match any doc.
    // Defense in depth: a non-admin (or admin who forgot the bypass) querying
    // a non-active status sees zero rows, never the requested non-active set.
    const naive = await Car.find({ status: 'deleted' });
    expect(naive).toHaveLength(0);
  });
});
