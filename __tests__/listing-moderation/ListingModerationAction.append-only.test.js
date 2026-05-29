/**
 * Append-only enforcement tests for ListingModerationAction (D-11).
 *
 * Phase 7 invariant (D-11): "Phase 7 tests assert every hook fires" — a
 * deliberate SUPERSET of the v1.0 4-test coverage which was missing
 * `updateMany` and `deleteMany`. The six tests below exercise every
 * Mongoose mutation/deletion verb that can touch an EXISTING document.
 *
 * Six pre-hooks under test:
 *   1. updateOne
 *   2. updateMany
 *   3. findOneAndUpdate
 *   4. deleteOne
 *   5. deleteMany
 *   6. findOneAndDelete
 *
 * Every test asserts on the stable shared error message (D-11) so a future
 * refactor that silently swaps the shared Error instance for per-hook
 * strings would still pass — and a refactor that renames the message would
 * fail all six. The literal message is only spelled out in the assertions
 * below (six matches, one per hook) to keep the grep-verifiable acceptance
 * criterion at exactly six.
 *
 * Test isolation per D-20: each test uses `mongodb-memory-server`; no
 * `server.js` boot. Sibling test namespace `__tests__/listing-moderation/`
 * per D-19.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('LDATA-03: ListingModerationAction — append-only', () => {
  let ListingModerationAction;
  let seedId;

  beforeAll(async () => {
    ListingModerationAction = require('../../src/models/ListingModerationAction');
    const doc = await ListingModerationAction.create({
      listingId: 'car-id-1',
      sellerUid: 'seller-1',
      adminUid: 'a1',
      adminEmail: 'a1@test.local',
      action: 'suspend',
      fromStatus: 'active',
      toStatus: 'suspended',
      reasonCategory: 'spam',
      reasonNote: 'initial',
    });
    seedId = doc._id;
  });

  test('updateOne throws', async () => {
    await expect(
      ListingModerationAction.updateOne({ _id: seedId }, { reasonNote: 'tampered' })
    ).rejects.toThrow('ListingModerationAction is append-only');
  });

  test('updateMany throws', async () => {
    await expect(
      ListingModerationAction.updateMany({ _id: seedId }, { reasonNote: 'tampered' })
    ).rejects.toThrow('ListingModerationAction is append-only');
  });

  test('findOneAndUpdate throws', async () => {
    await expect(
      ListingModerationAction.findOneAndUpdate({ _id: seedId }, { reasonNote: 'tampered' })
    ).rejects.toThrow('ListingModerationAction is append-only');
  });

  test('deleteOne throws', async () => {
    await expect(
      ListingModerationAction.deleteOne({ _id: seedId })
    ).rejects.toThrow('ListingModerationAction is append-only');
  });

  test('deleteMany throws', async () => {
    await expect(
      ListingModerationAction.deleteMany({ _id: seedId })
    ).rejects.toThrow('ListingModerationAction is append-only');
  });

  test('findOneAndDelete throws', async () => {
    await expect(
      ListingModerationAction.findOneAndDelete({ _id: seedId })
    ).rejects.toThrow('ListingModerationAction is append-only');
  });
});
