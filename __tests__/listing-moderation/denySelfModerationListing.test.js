// __tests__/listing-moderation/denySelfModerationListing.test.js
//
// Wave-0 middleware unit test for Phase 8 src/moderation/denySelfModerationListing.js (D-04, D-05).
// UNLIKE v1.0 denySelfModeration.test.js (no DB), this middleware FETCHES Car.sellerId
// from MongoDB to discover the listing's owner UID. Uses plain MongoMemoryServer
// (no transactions in this middleware — replica-set fixture is unnecessary here).
//
// Coverage:
//   1. admin === sellerId → 400 cannot_moderate_own_listing + console.warn regex
//   2. admin !== sellerId → next() invoked (200)
//   3. Car not found → 404 listing_not_found (D-04 do-not-leak)
//   4. Edit on moderated (status='deleted') listing passes — middleware does NOT
//      filter on status (D-A-4: Edit valid on any status)

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Car = require('../../src/models/Car');
const { denySelfModerationListing } = require('../../src/moderation/denySelfModerationListing');

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) {
    await mongo.stop();
  }
});

beforeEach(async () => {
  await Car.deleteMany({});
});

function appWith(adminUid) {
  const app = express();
  app.use(express.json());
  // Inject fake req.admin (simulating requireAdmin output).
  app.use((req, res, next) => {
    req.admin = { uid: adminUid, email: 'admin@test.local', role: 'admin' };
    next();
  });
  app.patch('/:carId', denySelfModerationListing, (req, res) => {
    res.json({ passed: true, carId: req.params.carId });
  });
  return app;
}

describe('denySelfModerationListing (D-04, D-05)', () => {
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('admin.uid === Car.sellerId → 400 cannot_moderate_own_listing + console.warn (D-05)', async () => {
    const carId = new mongoose.Types.ObjectId();
    await Car.collection.insertOne({
      _id: carId,
      sellerId: 'admin-uid-42',
      status: 'active',
    });

    const app = appWith('admin-uid-42');
    const res = await request(app).patch(`/${carId.toString()}`).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cannot_moderate_own_listing' });

    // D-05: rejected attempts log to console.warn with adminUid + carId + sellerId + ISO ts.
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const logged = consoleWarnSpy.mock.calls[0][0];
    expect(logged).toMatch(
      /\[listing-moderation\] denied self-moderation attempt by admin-uid-42 on listing .* \(sellerId=admin-uid-42\) at \d{4}-\d{2}-\d{2}T/
    );
  });

  test('admin.uid !== Car.sellerId → next() invoked (handler returns 200)', async () => {
    const carId = new mongoose.Types.ObjectId();
    await Car.collection.insertOne({
      _id: carId,
      sellerId: 'seller-x',
      status: 'active',
    });

    const app = appWith('admin-y');
    const res = await request(app).patch(`/${carId.toString()}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
    expect(res.body.carId).toBe(carId.toString());
    // No console.warn fired on the non-self path.
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  test('Car not found → 404 listing_not_found (D-04 do-not-leak-existence)', async () => {
    // Syntactically valid but absent ObjectId.
    const absent = new mongoose.Types.ObjectId();
    const app = appWith('admin-y');
    const res = await request(app).patch(`/${absent.toString()}`).send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'listing_not_found' });
    // Critical: the response body MUST NOT contain 'cannot_moderate_own_listing'.
    // If middleware collapsed both branches to the self-mod code, an attacker
    // probing for existence would distinguish "listing exists" from "doesn't"
    // based on the response code distribution. D-04 explicitly forbids this.
    expect(JSON.stringify(res.body)).not.toContain('cannot_moderate_own_listing');
  });

  test('Edit on moderated (status=deleted) listing passes middleware (D-A-4)', async () => {
    // Edit can be applied to a listing in ANY status (active/suspended/archived/deleted)
    // per D-A-4. The middleware MUST NOT filter on status — it only enforces the
    // seller-equality rule. If a future plan adds a status filter here, this test
    // breaks immediately.
    const carId = new mongoose.Types.ObjectId();
    await Car.collection.insertOne({
      _id: carId,
      sellerId: 'seller-x',
      status: 'deleted',
    });

    const app = appWith('admin-y');
    const res = await request(app).patch(`/${carId.toString()}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
  });
});
