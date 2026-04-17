const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let User;
let migrate;
// Loose models matching server.js collection names so the test seeds the same tables the script reads.
let Broker;
let ServiceOrder;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  User = require('../../src/models/User');
  require('../../src/models/ModerationAction'); // register so ensureIndexes can sync it

  Broker = mongoose.model('Broker_testseed', new mongoose.Schema({}, { strict: false, collection: 'brokers' }));
  ServiceOrder = mongoose.model('ServiceOrder_testseed', new mongoose.Schema({}, { strict: false, collection: 'service_orders' }));

  migrate = require('../../scripts/migrate-moderation');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Broker.deleteMany({});
  await ServiceOrder.deleteMany({});
});

describe('migrate-moderation — backfillUsers (DATA-01)', () => {
  test('adds moderationStatus to users missing it', async () => {
    // Bypass Mongoose to simulate legacy docs without moderationStatus.
    await User.collection.insertOne({ firebaseUid: 'legacy-1', email: 'l1@test.local' });
    await User.collection.insertOne({ firebaseUid: 'legacy-2', email: 'l2@test.local' });

    const updated = await migrate.backfillUsers();
    expect(updated).toBe(2);

    const u1 = await User.findOne({ firebaseUid: 'legacy-1' }).lean();
    expect(u1.moderationStatus.state).toBe('active');
    expect(u1.moderationStatus.severity).toBe('none');
    expect(u1.moderationStatus.restrictedFeatures).toEqual([]);
  });

  test('is idempotent on a second run', async () => {
    await User.collection.insertOne({ firebaseUid: 'legacy-3', email: 'l3@test.local' });
    await migrate.backfillUsers();
    const second = await migrate.backfillUsers();
    expect(second).toBe(0);
  });
});

describe('migrate-moderation — backfillOrders (DATA-03)', () => {
  test('backfills email/firstName/lastName/providerRole/snapshotAt on existing orders', async () => {
    await User.create({
      firebaseUid: 'broker-7',
      email: 'b7@test.local',
      firstName: 'Eva',
      lastName: 'Turing',
      moderationStatus: { state: 'active' },
    });
    await Broker.create({ ownerUid: 'broker-7', companyName: 'T-Co', phoneNumber: '+1999', telegramUsername: 't7' });
    await ServiceOrder.create({
      orderNumber: 'ORD-TEST-LEG',
      buyerUid: 'buyer-x',
      providerUid: 'broker-7',
      providerType: 'broker',
      providerSnapshot: { companyName: 'T-Co', phoneNumber: '+1999', telegramUsername: 't7' },
      services: [{ name: 'x', fee: 1, currency: '$', status: 'pending' }],
      status: 'pending',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const { updated, unresolvable } = await migrate.backfillOrders();
    expect(updated).toBe(1);
    expect(unresolvable).toBe(0);

    const order = await ServiceOrder.findOne({ orderNumber: 'ORD-TEST-LEG' }).lean();
    expect(order.providerSnapshot.email).toBe('b7@test.local');
    expect(order.providerSnapshot.firstName).toBe('Eva');
    expect(order.providerSnapshot.lastName).toBe('Turing');
    expect(order.providerSnapshot.providerRole).toBe('broker');
    expect(order.providerSnapshot.snapshotAt).toBeDefined();
    // Existing fields preserved:
    expect(order.providerSnapshot.companyName).toBe('T-Co');
  });

  test('reports unresolvable orders without updating them', async () => {
    await ServiceOrder.create({
      orderNumber: 'ORD-ORPHAN-1',
      buyerUid: 'buyer-y',
      providerUid: 'ghost-uid',
      providerType: 'logistics',
      providerSnapshot: { companyName: 'Unknown' },
      services: [{ name: 'y', fee: 1, currency: '$', status: 'pending' }],
      status: 'pending',
    });
    const { updated, unresolvable } = await migrate.backfillOrders();
    expect(updated).toBe(0);
    expect(unresolvable).toBe(1);
    const order = await ServiceOrder.findOne({ orderNumber: 'ORD-ORPHAN-1' }).lean();
    expect(order.providerSnapshot.email).toBeUndefined();
  });
});

describe('migrate-moderation — ensureIndexes', () => {
  test('creates moderationStatus.state index on users', async () => {
    await migrate.ensureIndexes();
    const indexes = await User.collection.getIndexes();
    const names = Object.keys(indexes);
    expect(names.some((n) => n.includes('moderationStatus.state'))).toBe(true);
  });
});
