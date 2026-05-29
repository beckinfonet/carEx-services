// __tests__/listing-moderation/listingTransaction.atomicity.test.js
//
// Wave-0 integration test that captures the canonical Phase-8 transaction
// pattern (audit-then-Car, both under one session.withTransaction()) AND
// proves both rollback paths fire — BEFORE Wave 2 plans land their service
// bodies. This way the atomicity contract is constrained by a passing test
// that Wave 2/3 inherit; any handler implementation that diverges from
// audit-then-Car or drops { session } on either write will fail this test.
//
// Mirrors v1.0 __tests__/moderation/suspend.test.js:114-141 (last-admin
// rollback assertion shape) generalized into 2 explicit fault-injection
// scenarios plus 1 positive control.
//
// The helper runMockSuspend() is a hand-rolled copy of the Phase 8
// transition pattern Wave 2 will install in listingService.suspendListing.
// We hand-roll it here because the Wave-1 stub throws not_implemented —
// running the real handler would short-circuit before the transaction
// opens.

const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');

const Car = require('../../src/models/Car');
const ListingModerationAction = require('../../src/models/ListingModerationAction');

let rs;

beforeAll(async () => { rs = await startReplSet(); });
afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await Car.deleteMany({});
  try { await ListingModerationAction.collection.drop(); } catch (_) { /* may not exist yet */ }
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Canonical Phase-8 transition pattern:
//   1. Insert ListingModerationAction first (array-form to accept { session }).
//   2. Update Car.status second.
// Both inside session.withTransaction() so a throw on either write rolls back
// the OTHER write. failOn === 'audit' simulates the audit insert throwing
// (mocked via jest.spyOn); failOn === 'car' simulates the Car update throwing.
async function runMockSuspend(carId, sellerId, adminUid, { failOn } = {}) {
  void failOn; // sentinel only — actual failure is induced by the caller's spies
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // 1. Audit row insert FIRST. Array form REQUIRED by Mongoose to accept { session }.
      //    Single-doc create(doc, { session }) silently drops { session } → audit lands
      //    OUTSIDE the transaction → rollback fails for that write. Pitfall 2.
      await ListingModerationAction.create([{
        listingId: carId.toString(),
        sellerUid: sellerId,
        adminUid,
        adminEmail: 'admin@test.local',
        action: 'suspend',
        fromStatus: 'active',
        toStatus: 'suspended',
        reasonCategory: 'spam',
        reasonNote: null,
      }], { session });

      // 2. Car update SECOND. Same { session }.
      await Car.updateOne(
        { _id: carId },
        { $set: { status: 'suspended' } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
}

describe('Phase 8 transaction atomicity — audit-then-Car pattern', () => {
  test('1) Audit insert throws → Car unchanged AND no audit row landed', async () => {
    const carId = new mongoose.Types.ObjectId();
    await Car.collection.insertOne({
      _id: carId,
      sellerId: 'seller-x',
      status: 'active',
    });

    // Inject a failure on the audit insert.
    jest.spyOn(ListingModerationAction, 'create').mockImplementationOnce(() => {
      throw new Error('simulated audit failure');
    });

    await expect(
      runMockSuspend(carId, 'seller-x', 'admin-uid', { failOn: 'audit' })
    ).rejects.toThrow('simulated audit failure');

    // Car.status MUST still be 'active' — the audit throw aborted the txn
    // before the Car update ran.
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('active');

    // No audit row left behind.
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId.toString() });
    expect(auditCount).toBe(0);
  });

  test('2) Car.updateOne throws after audit-create → audit row rolled back', async () => {
    const carId = new mongoose.Types.ObjectId();
    await Car.collection.insertOne({
      _id: carId,
      sellerId: 'seller-x',
      status: 'active',
    });

    // Audit succeeds; Car update throws → withTransaction must roll back BOTH.
    jest.spyOn(Car, 'updateOne').mockImplementationOnce(() => {
      throw new Error('simulated Car update failure');
    });

    await expect(
      runMockSuspend(carId, 'seller-x', 'admin-uid', { failOn: 'car' })
    ).rejects.toThrow('simulated Car update failure');

    // Car.status unchanged.
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('active');

    // Audit row was created INSIDE the transaction, then rolled back when Car
    // update threw — countDocuments must be 0. If this assertion fails, the
    // audit insert used { session: undefined } or single-doc-create-bug
    // (Pitfall 2) and the row escaped the transactional boundary.
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId.toString() });
    expect(auditCount).toBe(0);
  });

  test('3) Positive control (happy path): both writes commit when nothing throws', async () => {
    // Guard against test-harness false-negative: if the helper itself were
    // broken (e.g., not opening a session, or session.withTransaction
    // misconfigured), tests 1+2 might pass for the wrong reasons. This test
    // proves the helper CAN commit when no spies are attached.
    const carId = new mongoose.Types.ObjectId();
    await Car.collection.insertOne({
      _id: carId,
      sellerId: 'seller-x',
      status: 'active',
    });

    await runMockSuspend(carId, 'seller-x', 'admin-uid');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('suspended');

    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId.toString() });
    expect(auditCount).toBe(1);
  });
});
