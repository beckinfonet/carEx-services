const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let mongo;
let app;
let mongoose;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.SUPER_ADMIN_EMAIL = 'super@test.local';
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_BUCKET_NAME = 'test-bucket';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

  mongoose = require('mongoose');

  // server.js connects to Mongo on require() and exports the Express app when
  // `module.exports = { app }` is present (see plan 01-03 STEP 2).
  ({ app } = require(path.resolve(__dirname, '../../server.js')));

  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve) => mongoose.connection.once('connected', resolve));
  }
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('ServiceOrder.providerSnapshot (DATA-03)', () => {
  const ServiceOrder = () => mongoose.model('ServiceOrder');
  const Broker = () => mongoose.model('Broker');
  const LogisticsPartner = () => mongoose.model('LogisticsPartner');
  const User = () => mongoose.model('User');

  beforeEach(async () => {
    // Clean collections between tests so each case starts from a known state.
    await ServiceOrder().deleteMany({});
    await Broker().deleteMany({});
    await LogisticsPartner().deleteMany({});
    await User().deleteMany({});
  });

  test('schema has all 8 expected providerSnapshot fields', () => {
    // Inline nested-object schemas are stored as flat dotted paths
    // (e.g. "providerSnapshot.companyName"). Assert every expected leaf exists.
    const schema = ServiceOrder().schema;
    const expected = [
      'companyName', 'phoneNumber', 'telegramUsername',
      'email', 'firstName', 'lastName', 'providerRole', 'snapshotAt',
    ];
    for (const leaf of expected) {
      const p = schema.path(`providerSnapshot.${leaf}`);
      expect(p).toBeDefined();
    }
    // providerRole must be typed as String with the broker|logistics enum.
    const roleEnum = schema.path('providerSnapshot.providerRole').enumValues;
    expect(roleEnum).toEqual(expect.arrayContaining(['broker', 'logistics']));
    // snapshotAt must be a Date.
    expect(schema.path('providerSnapshot.snapshotAt').instance).toBe('Date');
  });

  test('providerRole enum rejects invalid value', async () => {
    const order = new (ServiceOrder())({
      orderNumber: 'ORD-TEST-AAA',
      buyerUid: 'b1',
      providerUid: 'p1',
      providerType: 'broker',
      providerSnapshot: { providerRole: 'seller' },
    });
    await expect(order.validate()).rejects.toThrow(/providerRole/);
  });

  test('providerRole enum accepts broker and logistics', async () => {
    for (const role of ['broker', 'logistics']) {
      const order = new (ServiceOrder())({
        orderNumber: `ORD-TEST-${role}`,
        buyerUid: 'b1',
        providerUid: 'p1',
        providerType: role,
        providerSnapshot: { providerRole: role },
      });
      await expect(order.validate()).resolves.toBeUndefined();
    }
  });

  test('POST /api/orders populates snapshot from Broker + User lookups (broker path)', async () => {
    await Broker().create({
      ownerUid: 'broker-uid-1',
      companyName: 'Acme Brokerage',
      phoneNumber: '+10000000001',
      telegramUsername: 'acme',
    });
    await User().create({
      firebaseUid: 'broker-uid-1',
      email: 'acme@test.local',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    const res = await request(app).post('/api/orders').send({
      buyerUid: 'buyer-uid-1',
      items: [{
        providerUid: 'broker-uid-1',
        providerType: 'broker',
        // Client-supplied snapshot should be IGNORED — handler resolves server-side.
        providerSnapshot: { companyName: 'stale-from-client', phoneNumber: '000', telegramUsername: 'stale' },
        service: { name: 'inspect', fee: 100, currency: '$' },
      }],
    });

    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(1);
    const snap = res.body.orders[0].providerSnapshot;
    expect(snap.companyName).toBe('Acme Brokerage');       // from Broker, NOT client
    expect(snap.phoneNumber).toBe('+10000000001');         // from Broker
    expect(snap.telegramUsername).toBe('acme');            // from Broker
    expect(snap.email).toBe('acme@test.local');            // from User
    expect(snap.firstName).toBe('Ada');
    expect(snap.lastName).toBe('Lovelace');
    expect(snap.providerRole).toBe('broker');
    expect(snap.snapshotAt).toBeDefined();
  });

  test('POST /api/orders populates snapshot from LogisticsPartner + User lookups (logistics path)', async () => {
    await LogisticsPartner().create({
      ownerUid: 'log-uid-1',
      companyName: 'FastShip',
      phoneNumber: '+10000000002',
      telegramUsername: 'fastship',
    });
    await User().create({
      firebaseUid: 'log-uid-1',
      email: 'fast@test.local',
      firstName: 'Grace',
      lastName: 'Hopper',
    });

    const res = await request(app).post('/api/orders').send({
      buyerUid: 'buyer-uid-2',
      items: [{
        providerUid: 'log-uid-1',
        providerType: 'logistics',
        providerSnapshot: { companyName: 'stale', phoneNumber: '000', telegramUsername: 'stale' },
        service: { name: 'transport', fee: 500, currency: '$' },
      }],
    });

    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(1);
    const snap = res.body.orders[0].providerSnapshot;
    expect(snap.companyName).toBe('FastShip');
    expect(snap.phoneNumber).toBe('+10000000002');
    expect(snap.telegramUsername).toBe('fastship');
    expect(snap.email).toBe('fast@test.local');
    expect(snap.firstName).toBe('Grace');
    expect(snap.lastName).toBe('Hopper');
    expect(snap.providerRole).toBe('logistics');
    expect(snap.snapshotAt).toBeDefined();
  });
});
