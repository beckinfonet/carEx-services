// __tests__/listing-moderation/migrate-listing-moderation.test.js
//
// Phase 7 v1.1 — LDATA-04. Proves the migration substrate works in-tree
// before it lands in production. Seeds 10 Car docs (7 missing status via
// raw-driver insert to bypass Mongoose defaults + 3 pre-suspended), runs
// the exported backfillListings() and ensureIndexes() functions directly
// (NEVER main() — that calls process.exit() and would kill jest), and
// asserts D-16 invariants + D-18 idempotency + both index-creation paths.
//
// Test isolation (D-20): builds nothing more than a MongoMemoryServer +
// model imports. Does NOT boot server.js — same pattern as v1.0 D-36 /
// Phase 5 Plan 05-10.
//
// Cleanup contract: Car.deleteMany({}) is fine (no append-only hooks),
// but ListingModerationAction has 6 append-only pre-hooks installed by
// Plan 07-02, including pre('deleteMany') which throws
// 'ListingModerationAction is append-only'. We bypass Mongoose entirely
// via `.collection.deleteMany()` (the underlying native driver Collection
// has no awareness of Mongoose middleware) — this is the documented
// escape hatch and the only safe cleanup path.

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let Car;
let ListingModerationAction;
let migrate;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Car = require('../../src/models/Car');
  // Register so ensureIndexes() can sync it via mongoose.model('ListingModerationAction').
  require('../../src/models/ListingModerationAction');
  ListingModerationAction = mongoose.model('ListingModerationAction');
  migrate = require('../../scripts/migrate-listing-moderation');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  // Car has no append-only hooks (Plan 07-01) — Mongoose-level deleteMany is fine.
  await Car.deleteMany({});
  // ListingModerationAction has 6 append-only pre-hooks (Plan 07-02 D-11).
  // Mongoose-level deleteMany() would throw 'ListingModerationAction is append-only'.
  // .collection.deleteMany() uses the native MongoDB driver and bypasses Mongoose
  // middleware entirely — documented escape hatch.
  await ListingModerationAction.collection.deleteMany({});
});

describe('migrate-listing-moderation — backfillListings (LDATA-04)', () => {
  test('backfills 7 docs missing status, leaves 3 pre-suspended docs untouched, post-count equals pre-count (D-16)', async () => {
    // Seed 7 docs missing the `status` field via the raw MongoDB driver — Mongoose's
    // schema defaults would otherwise inject status:'active' at insert time and we
    // would lose the ability to simulate legacy (pre-Phase-7) documents.
    await Car.collection.insertOne({ sellerId: 'seller-0', makeName: 'Toyota', modelName: 'Camry' });
    await Car.collection.insertOne({ sellerId: 'seller-1', makeName: 'Toyota', modelName: 'Camry' });
    await Car.collection.insertOne({ sellerId: 'seller-2', makeName: 'Toyota', modelName: 'Camry' });
    await Car.collection.insertOne({ sellerId: 'seller-3', makeName: 'Toyota', modelName: 'Camry' });
    await Car.collection.insertOne({ sellerId: 'seller-4', makeName: 'Toyota', modelName: 'Camry' });
    await Car.collection.insertOne({ sellerId: 'seller-5', makeName: 'Toyota', modelName: 'Camry' });
    await Car.collection.insertOne({ sellerId: 'seller-6', makeName: 'Toyota', modelName: 'Camry' });
    // Seed 3 docs that already carry a non-default status — D-18 idempotency
    // requires these to be left untouched by the backfill.
    await Car.collection.insertOne({ sellerId: 'seller-7', makeName: 'Honda', modelName: 'Civic', status: 'suspended' });
    await Car.collection.insertOne({ sellerId: 'seller-8', makeName: 'Honda', modelName: 'Civic', status: 'suspended' });
    await Car.collection.insertOne({ sellerId: 'seller-9', makeName: 'Honda', modelName: 'Civic', status: 'suspended' });

    const preCount = await Car.countDocuments({});
    expect(preCount).toBe(10);

    const updated = await migrate.backfillListings();
    expect(updated).toBe(7);

    // D-16 hard invariants — these MUST hold or the migration silently broke.
    const postCount = await Car.countDocuments({});
    expect(postCount).toBe(preCount);
    const stillMissing = await Car.countDocuments({ status: { $exists: false } });
    expect(stillMissing).toBe(0);

    // D-18 idempotency proof — the 3 pre-suspended docs MUST remain at 'suspended',
    // never reset to 'active'.
    const suspended = await Car.countDocuments({ status: 'suspended' });
    expect(suspended).toBe(3);
    const active = await Car.countDocuments({ status: 'active' });
    expect(active).toBe(7);
  });

  test('is idempotent on a second run (D-18) — returns 0 modified', async () => {
    await Car.collection.insertOne({ sellerId: 'seller-x', makeName: 'Ford', modelName: 'F-150' });
    const first = await migrate.backfillListings();
    expect(first).toBe(1);
    // Second run — the $exists:false filter matches zero docs because the first
    // run set status:'active' on every previously-missing doc.
    const second = await migrate.backfillListings();
    expect(second).toBe(0);
  });
});

describe('migrate-listing-moderation — ensureIndexes', () => {
  test('creates the { status: 1 } and { sellerId: 1, status: 1 } indexes on cars', async () => {
    await migrate.ensureIndexes();
    const indexes = await Car.collection.getIndexes();
    const names = Object.keys(indexes);
    // Single-field { status: 1 } — declared via `index: true` on the schema field.
    expect(names.some((n) => n.includes('status') && !n.includes('sellerId'))).toBe(true);
    // Compound { sellerId: 1, status: 1 } — declared via carSchema.index() call.
    expect(names.some((n) => n.includes('sellerId') && n.includes('status'))).toBe(true);
  });

  test('creates the three audit indexes on listing_moderation_actions', async () => {
    await migrate.ensureIndexes();
    const auditIndexes = await ListingModerationAction.collection.getIndexes();
    const auditNames = Object.keys(auditIndexes);
    // D-10: three canonical admin query shapes.
    expect(auditNames.some((n) => n.includes('listingId') && n.includes('createdAt'))).toBe(true);
    expect(auditNames.some((n) => n.includes('adminUid') && n.includes('createdAt'))).toBe(true);
    expect(auditNames.some((n) => n.includes('sellerUid') && n.includes('createdAt'))).toBe(true);
  });
});
