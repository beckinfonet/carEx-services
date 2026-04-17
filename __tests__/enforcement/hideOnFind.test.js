// __tests__/enforcement/hideOnFind.test.js
//
// Phase 3 Plan 03-06 — pre(/^find/) hide-hook matrix for Car, Broker,
// LogisticsPartner (03-CONTEXT D-05..D-09 + ROADMAP Criterion #2).
//
// What this file proves:
//   a. Suspending the owner (moderationStatus.state='blocked_with_review')
//      removes the owned doc from find()/findById() results.
//   b. Unsuspending the owner (state='active') restores the doc without any
//      data mutation on the owned doc itself — the pre-suspend listingStatus /
//      status / active flags are preserved round-trip.
//   c. Revoking the owner's role (xStatus='NONE') removes the owned doc from
//      results even when moderationStatus is active — the role join is the
//      second gate in the pre-hook's $or filter.
//   d. The setOptions({ includeAllUsers: true }) bypass returns the doc
//      regardless of owner state — the admin/service opt-out mechanism.
//   e. findById picks up the hook (D-09: `/^find/` matches findById too),
//      returning null on a suspended-owner doc without the bypass.
//
// No HTTP layer — pure Mongoose-level integration test, hits real Mongo via
// the shared MongoMemoryReplSet harness from Phase 2 Plan 02-01.

const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');
const User = require('../../src/models/User');
const Car = require('../../src/models/Car');
const Broker = require('../../src/models/Broker');
const LogisticsPartner = require('../../src/models/LogisticsPartner');

let rs;

beforeAll(async () => { rs = await startReplSet(); });
afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await User.deleteMany({});
  await Car.deleteMany({ /* no filter */ }).setOptions({ includeAllUsers: true });
  await Broker.deleteMany({ /* no filter */ }).setOptions({ includeAllUsers: true });
  await LogisticsPartner.deleteMany({ /* no filter */ }).setOptions({ includeAllUsers: true });
});

// deleteMany triggers a pre(/^find/) style hook in Mongoose? Actually deleteMany
// uses a different middleware family and does NOT match /^find/. The above is
// therefore equivalent to unfiltered deleteMany({}). Kept the setOptions for
// symmetry with the read path; it is a no-op on deletes.

// ============================================================================
// Block 1 — Car hide-hook matrix (seller join via sellerId, role gate via sellerStatus)
// ============================================================================
describe('Car pre(/^find/) hide-hook matrix (ROADMAP Criterion #2 — Car)', () => {
  const SELLER_UID = 'seller-car-1';

  async function seedActiveSellerWithCar() {
    await User.create({
      firebaseUid: SELLER_UID,
      email: 'seller@test.local',
      sellerStatus: 'APPROVED',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    const car = await Car.create({
      sellerId: SELLER_UID,
      makeName: 'Toyota',
      modelName: 'Corolla',
      year: 2020,
      price: 15000,
      listingStatus: 'active',
    });
    return car;
  }

  test('active seller -> Car.find({}) returns 1 result', async () => {
    await seedActiveSellerWithCar();
    const found = await Car.find({});
    expect(found).toHaveLength(1);
    expect(found[0].sellerId).toBe(SELLER_UID);
  });

  test('suspend seller -> Car.find({}) returns []; owned car unchanged in DB (zero mutation)', async () => {
    const car = await seedActiveSellerWithCar();

    // Sanity: listingStatus was 'active' pre-suspend.
    expect(car.listingStatus).toBe('active');

    // Suspend the seller — no mutation to Car documents anywhere.
    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );

    // Public read: hook hides the car.
    const publicFound = await Car.find({});
    expect(publicFound).toHaveLength(0);

    // Admin re-fetch WITH bypass: the raw car doc still has listingStatus='active'
    // (zero mutation proof for ROADMAP Criterion #2).
    const raw = await Car.findById(car._id).setOptions({ includeAllUsers: true });
    expect(raw).not.toBeNull();
    expect(raw.listingStatus).toBe('active');
    expect(raw.sellerId).toBe(SELLER_UID);
  });

  test('unsuspend seller -> Car.find({}) returns 1 again with same _id and unchanged listingStatus', async () => {
    const car = await seedActiveSellerWithCar();

    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );
    expect(await Car.find({})).toHaveLength(0);

    // Restore to active.
    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { 'moderationStatus.state': 'active' } }
    );

    const found = await Car.find({});
    expect(found).toHaveLength(1);
    expect(found[0]._id.toString()).toBe(car._id.toString());
    expect(found[0].listingStatus).toBe('active');  // round-trip preserved
  });

  test('revoke sellerStatus to NONE -> Car.find({}) returns [] even with active moderationStatus', async () => {
    await seedActiveSellerWithCar();

    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { sellerStatus: 'NONE' } }
    );
    const found = await Car.find({});
    expect(found).toHaveLength(0);
  });

  test('includeAllUsers bypass returns the car regardless of seller state', async () => {
    await seedActiveSellerWithCar();

    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { 'moderationStatus.state': 'permanently_banned', sellerStatus: 'NONE' } }
    );

    // Without bypass: hidden.
    expect(await Car.find({})).toHaveLength(0);
    // With bypass: visible.
    const bypassed = await Car.find({}).setOptions({ includeAllUsers: true });
    expect(bypassed).toHaveLength(1);
    expect(bypassed[0].sellerId).toBe(SELLER_UID);
  });

  test('findById on suspended-seller car returns null (D-09 — /^find/ covers findById)', async () => {
    const car = await seedActiveSellerWithCar();

    await User.updateOne(
      { firebaseUid: SELLER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );

    const found = await Car.findById(car._id);  // no bypass
    expect(found).toBeNull();
  });
});

// ============================================================================
// Block 2 — Broker hide-hook matrix (owner join via ownerUid, role gate via brokerStatus)
// ============================================================================
describe('Broker pre(/^find/) hide-hook matrix (ROADMAP Criterion #2 — Broker)', () => {
  const OWNER_UID = 'owner-broker-1';

  async function seedActiveBroker() {
    await User.create({
      firebaseUid: OWNER_UID,
      email: 'broker@test.local',
      brokerStatus: 'APPROVED',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    const broker = await Broker.create({
      ownerUid: OWNER_UID,
      companyName: 'Acme Brokers',
      phoneNumber: '+10000000',
      status: 'active',
    });
    return broker;
  }

  test('active owner -> Broker.find({}) returns 1', async () => {
    await seedActiveBroker();
    expect(await Broker.find({})).toHaveLength(1);
  });

  test('suspend owner -> Broker.find({}) hides; bypass still sees doc with status unchanged', async () => {
    const broker = await seedActiveBroker();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );
    expect(await Broker.find({})).toHaveLength(0);

    const raw = await Broker.findById(broker._id).setOptions({ includeAllUsers: true });
    expect(raw).not.toBeNull();
    expect(raw.status).toBe('active');  // zero mutation round-trip
    expect(raw.companyName).toBe('Acme Brokers');
  });

  test('unsuspend owner -> Broker.find({}) returns 1 again with unchanged status', async () => {
    const broker = await seedActiveBroker();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );
    expect(await Broker.find({})).toHaveLength(0);

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'active' } }
    );

    const found = await Broker.find({});
    expect(found).toHaveLength(1);
    expect(found[0]._id.toString()).toBe(broker._id.toString());
    expect(found[0].status).toBe('active');
  });

  test('revoke brokerStatus to NONE -> Broker.find({}) returns []', async () => {
    await seedActiveBroker();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { brokerStatus: 'NONE' } }
    );
    expect(await Broker.find({})).toHaveLength(0);
  });

  test('includeAllUsers bypass returns the broker regardless of owner state', async () => {
    await seedActiveBroker();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'permanently_banned', brokerStatus: 'NONE' } }
    );

    expect(await Broker.find({})).toHaveLength(0);
    const bypassed = await Broker.find({}).setOptions({ includeAllUsers: true });
    expect(bypassed).toHaveLength(1);
    expect(bypassed[0].ownerUid).toBe(OWNER_UID);
  });

  test('findOne on suspended-owner broker returns null (D-09)', async () => {
    await seedActiveBroker();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );

    const found = await Broker.findOne({ ownerUid: OWNER_UID });
    expect(found).toBeNull();
  });
});

// ============================================================================
// Block 3 — LogisticsPartner hide-hook matrix (owner join via ownerUid, role gate via logisticsStatus)
// ============================================================================
describe('LogisticsPartner pre(/^find/) hide-hook matrix (ROADMAP Criterion #2 — Logistics)', () => {
  const OWNER_UID = 'owner-logistics-1';

  async function seedActiveLogistics() {
    await User.create({
      firebaseUid: OWNER_UID,
      email: 'logistics@test.local',
      logisticsStatus: 'APPROVED',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    const partner = await LogisticsPartner.create({
      ownerUid: OWNER_UID,
      companyName: 'Fast Haul',
      phoneNumber: '+10000001',
      status: 'active',
    });
    return partner;
  }

  test('active owner -> LogisticsPartner.find({}) returns 1', async () => {
    await seedActiveLogistics();
    expect(await LogisticsPartner.find({})).toHaveLength(1);
  });

  test('suspend owner -> hides; bypass still sees doc with status unchanged (zero mutation)', async () => {
    const partner = await seedActiveLogistics();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );
    expect(await LogisticsPartner.find({})).toHaveLength(0);

    const raw = await LogisticsPartner.findById(partner._id).setOptions({ includeAllUsers: true });
    expect(raw).not.toBeNull();
    expect(raw.status).toBe('active');
    expect(raw.companyName).toBe('Fast Haul');
  });

  test('unsuspend owner -> returns 1 again with unchanged status', async () => {
    const partner = await seedActiveLogistics();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'blocked_with_review' } }
    );
    expect(await LogisticsPartner.find({})).toHaveLength(0);

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'active' } }
    );

    const found = await LogisticsPartner.find({});
    expect(found).toHaveLength(1);
    expect(found[0]._id.toString()).toBe(partner._id.toString());
    expect(found[0].status).toBe('active');
  });

  test('revoke logisticsStatus to NONE -> LogisticsPartner.find({}) returns []', async () => {
    await seedActiveLogistics();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { logisticsStatus: 'NONE' } }
    );
    expect(await LogisticsPartner.find({})).toHaveLength(0);
  });

  test('includeAllUsers bypass returns the partner regardless of owner state', async () => {
    await seedActiveLogistics();

    await User.updateOne(
      { firebaseUid: OWNER_UID },
      { $set: { 'moderationStatus.state': 'permanently_banned', logisticsStatus: 'NONE' } }
    );

    expect(await LogisticsPartner.find({})).toHaveLength(0);
    const bypassed = await LogisticsPartner.find({}).setOptions({ includeAllUsers: true });
    expect(bypassed).toHaveLength(1);
    expect(bypassed[0].ownerUid).toBe(OWNER_UID);
  });
});
