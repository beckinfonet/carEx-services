jest.mock('../../src/carRequests/stripeClient', () => ({
  paymentIntents: { create: jest.fn(), retrieve: jest.fn() },
}));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const stripe = require('../../src/carRequests/stripeClient');

let mongo;
let app;
let VehicleMake;
let User;
let CarRequest;
let RequestUnlock;
let Notification;

let currentUid = 'seller-1';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'CarEx' });

  VehicleMake =
    mongoose.models.VehicleMake ||
    mongoose.model('VehicleMake', new mongoose.Schema({ name: String, isActive: { type: Boolean, default: true } }), 'vehicle_makes');
  User =
    mongoose.models.User ||
    mongoose.model('User', new mongoose.Schema({ firebaseUid: String, sellerStatus: String, language: String, notificationPrefs: {} }));
  CarRequest = require('../../src/models/CarRequest');
  RequestUnlock = require('../../src/models/RequestUnlock');
  Notification = require('../../src/models/Notification');
  await RequestUnlock.syncIndexes(); // ensure the unique index exists in-memory

  const carRequestsRouter = require('../../src/carRequests/router');
  app = express();
  app.use(express.json());
  app.use('/api/car-requests', (req, res, next) => {
    req.auth = { uid: currentUid, email: `${currentUid}@x.com` };
    next();
  }, carRequestsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  currentUid = 'seller-1';
  delete process.env.REQUEST_UNLOCK_ENABLED;
  stripe.paymentIntents.create.mockReset();
  stripe.paymentIntents.retrieve.mockReset();
  await Promise.all([
    CarRequest.deleteMany({}), RequestUnlock.deleteMany({}),
    User.deleteMany({}), VehicleMake.deleteMany({}), Notification.deleteMany({}),
  ]);
});

async function approvedSeller(uid = 'seller-1') {
  return User.create({ firebaseUid: uid, sellerStatus: 'APPROVED', language: 'EN' });
}
async function buyer(uid = 'buyer-1') {
  return User.create({ firebaseUid: uid, language: 'EN' });
}
async function openRequest(overrides = {}) {
  const make = await VehicleMake.create({ name: 'Toyota', isActive: true });
  return CarRequest.create({
    buyerUid: 'buyer-1', makeId: make._id, makeName: 'Toyota', modelName: 'Camry', budgetMax: 15000, currency: 'KGS',
    contactPhone: '+996555111222', contactPhoneVerified: true, telegramUsername: 'bishkek_cars',
    status: 'open', expiresAt: new Date(Date.now() + 1e9), ...overrides,
  });
}

describe('POST /:id/unlock (free path)', () => {
  it('reveals contact, records the unlock, bumps count, notifies the buyer', async () => {
    await approvedSeller();
    await buyer();
    const doc = await openRequest();

    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock`);
    expect(res.status).toBe(200);
    expect(res.body.request.unlocked).toBe(true);
    expect(res.body.request.contactPhone).toBe('+996555111222');
    expect(res.body.request.telegramUsername).toBe('bishkek_cars');
    expect(res.body.request.buyerUid).toBeUndefined();

    const unlock = await RequestUnlock.findOne({ requestId: doc._id, sellerUid: 'seller-1' });
    expect(unlock.amount).toBe(0);
    expect(unlock.paymentIntentId).toBeNull();
    expect((await CarRequest.findById(doc._id)).unlockCount).toBe(1);
    expect(await Notification.countDocuments({ uid: 'buyer-1', titleKey: 'request_unlock' })).toBe(1);
  });

  it('is idempotent — second unlock reveals again without double-count or second record', async () => {
    await approvedSeller();
    await buyer();
    const doc = await openRequest();
    await request(app).post(`/api/car-requests/${doc._id}/unlock`);
    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock`);
    expect(res.status).toBe(200);
    expect(res.body.request.contactPhone).toBe('+996555111222');
    expect(await RequestUnlock.countDocuments({ requestId: doc._id, sellerUid: 'seller-1' })).toBe(1);
    expect((await CarRequest.findById(doc._id)).unlockCount).toBe(1);
  });

  it('rejects a non-approved seller (403)', async () => {
    await User.create({ firebaseUid: 'seller-1', sellerStatus: 'NONE' });
    const doc = await openRequest();
    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock`);
    expect(res.status).toBe(403);
  });

  it('returns 409 payment_required when the paywall is ON and not yet unlocked', async () => {
    process.env.REQUEST_UNLOCK_ENABLED = 'true';
    await approvedSeller();
    const doc = await openRequest();
    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('payment_required');
  });
});

describe('Stripe path', () => {
  beforeEach(() => { process.env.REQUEST_UNLOCK_ENABLED = 'true'; });

  it('payment-intent returns a client secret with the server amount', async () => {
    await approvedSeller();
    const doc = await openRequest();
    stripe.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_1', client_secret: 'pi_1_secret' });

    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock/payment-intent`);
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe('pi_1_secret');
    expect(res.body.paymentIntentId).toBe('pi_1');
    expect(res.body.amount).toBe(500);
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, metadata: expect.objectContaining({ requestId: String(doc._id), sellerUid: 'seller-1' }) })
    );
  });

  it('payment-intent short-circuits when already unlocked', async () => {
    await approvedSeller();
    const doc = await openRequest();
    await RequestUnlock.create({ requestId: doc._id, sellerUid: 'seller-1', amount: 0, currency: 'KGS' });
    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock/payment-intent`);
    expect(res.status).toBe(200);
    expect(res.body.alreadyUnlocked).toBe(true);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('confirm reveals + records + notifies on a succeeded, matching intent', async () => {
    await approvedSeller();
    await buyer();
    const doc = await openRequest();
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_9', status: 'succeeded', amount: 500,
      metadata: { requestId: String(doc._id), sellerUid: 'seller-1' },
    });

    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock/confirm`).send({ paymentIntentId: 'pi_9' });
    expect(res.status).toBe(200);
    expect(res.body.request.contactPhone).toBe('+996555111222');
    const unlock = await RequestUnlock.findOne({ requestId: doc._id, sellerUid: 'seller-1' });
    expect(unlock.paymentIntentId).toBe('pi_9');
    expect(unlock.amount).toBe(500);
    expect(await Notification.countDocuments({ uid: 'buyer-1', titleKey: 'request_unlock' })).toBe(1);
  });

  it('confirm rejects an unsucceeded intent (402)', async () => {
    await approvedSeller();
    const doc = await openRequest();
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_x', status: 'requires_payment_method', metadata: {} });
    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock/confirm`).send({ paymentIntentId: 'pi_x' });
    expect(res.status).toBe(402);
  });

  it('confirm rejects a metadata mismatch (400)', async () => {
    await approvedSeller();
    const doc = await openRequest();
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_z', status: 'succeeded', amount: 500, metadata: { requestId: 'other', sellerUid: 'seller-1' },
    });
    const res = await request(app).post(`/api/car-requests/${doc._id}/unlock/confirm`).send({ paymentIntentId: 'pi_z' });
    expect(res.status).toBe(400);
  });
});

describe('GET /:id reveal + paywallEnabled', () => {
  it('reveals contact for a seller who already unlocked', async () => {
    await approvedSeller();
    const doc = await openRequest();
    await RequestUnlock.create({ requestId: doc._id, sellerUid: 'seller-1', amount: 0, currency: 'KGS' });
    const res = await request(app).get(`/api/car-requests/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.body.paywallEnabled).toBe(false);
    expect(res.body.request.unlocked).toBe(true);
    expect(res.body.request.contactPhone).toBe('+996555111222');
  });

  it('stays redacted for a seller who has not unlocked', async () => {
    await approvedSeller();
    const doc = await openRequest();
    const res = await request(app).get(`/api/car-requests/${doc._id}`);
    expect(res.body.request.unlocked).toBe(false);
    expect(res.body.request.contactPhone).toBeUndefined();
  });
});
