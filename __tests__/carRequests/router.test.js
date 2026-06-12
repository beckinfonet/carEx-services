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
let currentUid = 'buyer-1';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'CarEx' });

  // Register the catalog + user models the router depends on.
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
      })
    );
  CarRequest = require('../../src/models/CarRequest');

  const carRequestsRouter = require('../../src/carRequests/router');

  app = express();
  app.use(express.json());
  // Fake auth: inject req.auth from the mutable currentUid.
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
  currentUid = 'buyer-1';
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

async function seedVerifiedBuyer(uid = 'buyer-1', phone = '+996555111222') {
  return User.create({ firebaseUid: uid, email: `${uid}@x.com`, phoneNumber: phone, isPhoneVerified: true });
}

describe('POST /api/car-requests', () => {
  it('creates a request for a verified buyer and derives contactPhone server-side', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer('buyer-1', '+996555111222');

    const res = await request(app)
      .post('/api/car-requests')
      .send({ makeId: make._id.toString(), budgetMax: 15000, telegramUsername: '@bishkek' });

    expect(res.status).toBe(201);
    expect(res.body.buyerUid).toBe('buyer-1');
    expect(res.body.makeName).toBe('Toyota');
    expect(res.body.contactPhone).toBe('+996555111222');
    expect(res.body.contactPhoneVerified).toBe(true);
    expect(res.body.telegramUsername).toBe('bishkek');
    expect(res.body.status).toBe('open');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects when the buyer has not verified their phone (403)', async () => {
    const { make } = await seedCatalog();
    await User.create({ firebaseUid: 'buyer-1', email: 'b@x.com', phoneNumber: '+996555111222', isPhoneVerified: false });

    const res = await request(app)
      .post('/api/car-requests')
      .send({ makeId: make._id.toString(), budgetMax: 15000 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('phone_not_verified');
  });

  it('rejects an invalid makeId (400)', async () => {
    await seedVerifiedBuyer();
    const res = await request(app)
      .post('/api/car-requests')
      .send({ makeId: new mongoose.Types.ObjectId().toString(), budgetMax: 15000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_make');
  });

  it('rejects a modelId that does not belong to the make (400)', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const otherModel = await VehicleModel.create({ makeId: new mongoose.Types.ObjectId(), name: 'Civic' });
    const res = await request(app)
      .post('/api/car-requests')
      .send({ makeId: make._id.toString(), modelId: otherModel._id.toString(), budgetMax: 15000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_model');
  });

  it('rejects a missing budgetMax (400 validation)', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const res = await request(app)
      .post('/api/car-requests')
      .send({ makeId: make._id.toString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.details).toContain('budgetMax must be a positive number');
  });
});

describe('GET /api/car-requests/mine', () => {
  it('returns only the caller\'s requests, newest first, with full contact', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer('buyer-1', '+996555111222');
    await seedVerifiedBuyer('buyer-2', '+996555999888');

    await CarRequest.create({
      buyerUid: 'buyer-2', makeId: make._id, makeName: 'Toyota', budgetMax: 9000,
      contactPhone: '+996555999888', contactPhoneVerified: true, expiresAt: new Date(Date.now() + 1e9),
    });
    await CarRequest.create({
      buyerUid: 'buyer-1', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      contactPhone: '+996555111222', contactPhoneVerified: true, expiresAt: new Date(Date.now() + 1e9),
    });

    const res = await request(app).get('/api/car-requests/mine');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].buyerUid).toBe('buyer-1');
    expect(res.body[0].contactPhone).toBe('+996555111222');
  });
});

describe('PUT /api/car-requests/:id', () => {
  it('updates own request fields', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const doc = await CarRequest.create({
      buyerUid: 'buyer-1', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      contactPhone: '+996555111222', contactPhoneVerified: true, expiresAt: new Date(Date.now() + 1e9),
    });
    const res = await request(app)
      .put(`/api/car-requests/${doc._id}`)
      .send({ makeId: make._id.toString(), budgetMax: 20000, note: 'low mileage only' });
    expect(res.status).toBe(200);
    expect(res.body.budgetMax).toBe(20000);
    expect(res.body.note).toBe('low mileage only');
  });

  it('refuses to update another buyer\'s request (404)', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const doc = await CarRequest.create({
      buyerUid: 'buyer-2', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      contactPhone: '+996555999888', contactPhoneVerified: true, expiresAt: new Date(Date.now() + 1e9),
    });
    const res = await request(app)
      .put(`/api/car-requests/${doc._id}`)
      .send({ makeId: make._id.toString(), budgetMax: 20000 });
    expect(res.status).toBe(404);
  });

  it('refuses to edit a closed request (409)', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const doc = await CarRequest.create({
      buyerUid: 'buyer-1', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      contactPhone: '+996555111222', contactPhoneVerified: true, status: 'closed',
      expiresAt: new Date(Date.now() + 1e9),
    });
    const res = await request(app)
      .put(`/api/car-requests/${doc._id}`)
      .send({ makeId: make._id.toString(), budgetMax: 20000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('request_not_editable');
  });

  it('resets previously-set optional fields when omitted on edit', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const doc = await CarRequest.create({
      buyerUid: 'buyer-1', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      budgetMin: 8000, note: 'old note', contactPhone: '+996555111222',
      contactPhoneVerified: true, status: 'open', expiresAt: new Date(Date.now() + 1e9),
    });
    const res = await request(app)
      .put(`/api/car-requests/${doc._id}`)
      .send({ makeId: make._id.toString(), budgetMax: 20000 });
    expect(res.status).toBe(200);
    expect(res.body.budgetMin).toBeNull();
    expect(res.body.note).toBeNull();
  });
});

describe('PATCH /api/car-requests/:id/close', () => {
  it('sets status to closed for the owner', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const doc = await CarRequest.create({
      buyerUid: 'buyer-1', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      contactPhone: '+996555111222', contactPhoneVerified: true, expiresAt: new Date(Date.now() + 1e9),
    });
    const res = await request(app).patch(`/api/car-requests/${doc._id}/close`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
  });
});

describe('DELETE /api/car-requests/:id', () => {
  it('deletes the owner\'s request', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const doc = await CarRequest.create({
      buyerUid: 'buyer-1', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      contactPhone: '+996555111222', contactPhoneVerified: true, expiresAt: new Date(Date.now() + 1e9),
    });
    const res = await request(app).delete(`/api/car-requests/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await CarRequest.findById(doc._id)).toBeNull();
  });

  it('refuses to delete another buyer\'s request (404)', async () => {
    const { make } = await seedCatalog();
    await seedVerifiedBuyer();
    const doc = await CarRequest.create({
      buyerUid: 'buyer-2', makeId: make._id, makeName: 'Toyota', budgetMax: 12000,
      contactPhone: '+996555999888', contactPhoneVerified: true, expiresAt: new Date(Date.now() + 1e9),
    });
    const res = await request(app).delete(`/api/car-requests/${doc._id}`);
    expect(res.status).toBe(404);
    expect(await CarRequest.findById(doc._id)).not.toBeNull();
  });
});
