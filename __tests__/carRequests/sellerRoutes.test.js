const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let app;
let VehicleMake;
let VehicleModel;
let User;
let CarRequest;

// Mutable auth identity the fake middleware injects per-test.
let currentUid = 'seller-1';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'CarEx' });

  VehicleMake =
    mongoose.models.VehicleMake ||
    mongoose.model(
      'VehicleMake',
      new mongoose.Schema({ name: String, slug: String, isActive: { type: Boolean, default: true } }),
      'vehicle_makes'
    );
  VehicleModel =
    mongoose.models.VehicleModel ||
    mongoose.model(
      'VehicleModel',
      new mongoose.Schema({
        makeId: mongoose.Schema.Types.ObjectId,
        name: String,
        isActive: { type: Boolean, default: true },
      }),
      'vehicle_models'
    );
  User =
    mongoose.models.User ||
    mongoose.model(
      'User',
      new mongoose.Schema({
        firebaseUid: String,
        email: String,
        phoneNumber: String,
        isPhoneVerified: Boolean,
        sellerStatus: String,
      })
    );
  CarRequest = require('../../src/models/CarRequest');

  const carRequestsRouter = require('../../src/carRequests/router');

  app = express();
  app.use(express.json());
  app.use('/api/car-requests', (req, res, next) => {
    req.auth = { uid: currentUid, email: `${currentUid}@example.com` };
    next();
  }, carRequestsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  currentUid = 'seller-1';
  await CarRequest.deleteMany({});
  await User.deleteMany({});
  await VehicleMake.deleteMany({});
  await VehicleModel.deleteMany({});
});

async function seedCatalog() {
  const make = await VehicleMake.create({ name: 'Toyota', slug: 'toyota', isActive: true });
  const model = await VehicleModel.create({ makeId: make._id, name: 'Camry', isActive: true });
  return { make, model };
}

async function seedApprovedSeller(uid = 'seller-1') {
  return User.create({ firebaseUid: uid, email: `${uid}@x.com`, sellerStatus: 'APPROVED' });
}

async function seedOpenRequest(make, overrides = {}) {
  return CarRequest.create({
    buyerUid: 'buyer-1',
    makeId: make._id,
    makeName: 'Toyota',
    budgetMax: 15000,
    currency: 'KGS',
    contactPhone: '+996555111222',
    contactPhoneVerified: true,
    telegramUsername: 'bishkek_cars',
    status: 'open',
    expiresAt: new Date(Date.now() + 1e9),
    ...overrides,
  });
}

describe('GET /api/car-requests (seller browse)', () => {
  it('returns open requests with contact redacted + unlockPrice for an approved seller', async () => {
    const { make } = await seedCatalog();
    await seedApprovedSeller('seller-1');
    await seedOpenRequest(make);

    const res = await request(app).get('/api/car-requests');

    expect(res.status).toBe(200);
    expect(res.body.unlockPrice).toBe(500);
    expect(res.body.currency).toBe('KGS');
    expect(res.body.requests).toHaveLength(1);
    const r = res.body.requests[0];
    expect(r.makeName).toBe('Toyota');
    expect(r.budgetMax).toBe(15000);
    expect(r.unlocked).toBe(false);
    expect(r.contactPhone).toBeUndefined();
    expect(r.buyerUid).toBeUndefined();
    expect(r.telegramUsername).toBeUndefined();
    expect(r.contactPhoneVerified).toBeUndefined();
  });

  it('rejects a caller who is not an approved seller (403)', async () => {
    const { make } = await seedCatalog();
    await User.create({ firebaseUid: 'seller-1', email: 'x@x.com', sellerStatus: 'NONE' });
    await seedOpenRequest(make);

    const res = await request(app).get('/api/car-requests');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_approved_seller');
  });

  it('excludes closed and expired requests', async () => {
    const { make } = await seedCatalog();
    await seedApprovedSeller('seller-1');
    await seedOpenRequest(make); // open
    await seedOpenRequest(make, { status: 'closed' });
    await seedOpenRequest(make, { expiresAt: new Date(Date.now() - 1000) }); // expired

    const res = await request(app).get('/api/car-requests');
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
  });

  it("excludes the caller's own requests", async () => {
    const { make } = await seedCatalog();
    await seedApprovedSeller('seller-1');
    await seedOpenRequest(make, { buyerUid: 'seller-1' }); // own
    await seedOpenRequest(make, { buyerUid: 'buyer-9' }); // someone else's

    const res = await request(app).get('/api/car-requests');
    expect(res.body.requests).toHaveLength(1);
    // buyerUid is redacted, so assert via the surviving count only.
  });

  it('filters by makeId', async () => {
    const { make } = await seedCatalog();
    const otherMake = await VehicleMake.create({ name: 'Honda', slug: 'honda', isActive: true });
    await seedApprovedSeller('seller-1');
    await seedOpenRequest(make);
    await seedOpenRequest(otherMake, { makeName: 'Honda' });

    const res = await request(app).get(`/api/car-requests?makeId=${make._id}`);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].makeName).toBe('Toyota');
  });

  it('filters by minBudget (budgetMax >= minBudget)', async () => {
    const { make } = await seedCatalog();
    await seedApprovedSeller('seller-1');
    await seedOpenRequest(make, { budgetMax: 8000 });
    await seedOpenRequest(make, { budgetMax: 20000 });

    const res = await request(app).get('/api/car-requests?minBudget=10000');
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].budgetMax).toBe(20000);
  });
});

describe('GET /api/car-requests/:id (seller detail)', () => {
  it('returns a redacted request + unlockPrice for an approved seller', async () => {
    const { make } = await seedCatalog();
    await seedApprovedSeller('seller-1');
    const doc = await seedOpenRequest(make);

    const res = await request(app).get(`/api/car-requests/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.body.unlockPrice).toBe(500);
    expect(res.body.request.makeName).toBe('Toyota');
    expect(res.body.request.unlocked).toBe(false);
    expect(res.body.request.contactPhone).toBeUndefined();
    expect(res.body.request.buyerUid).toBeUndefined();
  });

  it('rejects a non-approved seller (403)', async () => {
    const { make } = await seedCatalog();
    await User.create({ firebaseUid: 'seller-1', email: 'x@x.com', sellerStatus: 'PENDING' });
    const doc = await seedOpenRequest(make);

    const res = await request(app).get(`/api/car-requests/${doc._id}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown id', async () => {
    await seedApprovedSeller('seller-1');
    const res = await request(app).get(`/api/car-requests/${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-open request', async () => {
    const { make } = await seedCatalog();
    await seedApprovedSeller('seller-1');
    const doc = await seedOpenRequest(make, { status: 'closed' });
    const res = await request(app).get(`/api/car-requests/${doc._id}`);
    expect(res.status).toBe(404);
  });

  it('does not collide with GET /mine (route ordering)', async () => {
    // /mine is a buyer route returning an array; it must not be captured by /:id.
    await seedApprovedSeller('seller-1');
    const res = await request(app).get('/api/car-requests/mine');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
