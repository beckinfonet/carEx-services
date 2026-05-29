// __tests__/listing-enforcement/listingDetailStatusAware.test.js
//
// Phase 9 Plan 09-03 — LENF-02 status-aware GET /api/cars/:id contract.
// 6 base D-05/D-07/Pitfall cases (a..f) + 1 authenticated-non-admin case (W-3).
//
// Mounts the PRODUCTION handler `getCarDetailHandler` from server.js (W-6 —
// production/test divergence impossible by construction). Uses the
// firebase-admin mock pattern from PATTERNS §10 analog
// (__tests__/listing-moderation/requireAdmin.listing.middleware.test.js).

// Mock firebase-admin BEFORE requiring any module that uses it.
jest.mock('firebase-admin', () => {
  const verifyIdTokenMock = jest.fn();
  const mock = {
    credential: { cert: jest.fn(() => ({})) },
    initializeApp: jest.fn(),
    auth: jest.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
  };
  mock.__verifyIdTokenMock = verifyIdTokenMock;
  return mock;
});

// Prevent server.js from connecting to a real MongoDB on require — the test
// drives its own in-memory mongoose connection. Setting MONGODB_URI to a
// reachable-but-unused value before require also keeps mongoose.connect from
// throwing synchronously; the test reconnects mongoose to MongoMemoryServer
// in beforeAll.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:0/test';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON =
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON || JSON.stringify({ project_id: 'test' });

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const request = require('supertest');

const admin = require('firebase-admin');
const Car = require('../../src/models/Car');
const User = require('../../src/models/User');
const AdminUser = require('../../src/models/AdminUser');
const { attachAuthIfPresent } = require('../../src/security/attachAuthIfPresent');
const { lookupAdminIfPresent } = require('../../src/security/lookupAdminIfPresent');

// W-6: import the PRODUCTION handler so the test exercises the exact function
// that ships in production. Any divergence between the test response shape
// and the production response shape is impossible by construction.
const { getCarDetailHandler } = require('../../server.js');

let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  // server.js requires open a mongoose.connect to the .env URI; disconnect that
  // (if it tried) and connect to the in-memory server we control.
  try {
    await mongoose.disconnect();
  } catch (_) {
    // not connected
  }
  await mongoose.connect(mongo.getUri());

  app = express();
  app.use(express.json());
  // Mount the PRODUCTION handler with the PRODUCTION middleware chain.
  app.get(
    '/api/cars/:id',
    attachAuthIfPresent,
    lookupAdminIfPresent,
    getCarDetailHandler
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Car.deleteMany({ /* no filter */ }).setOptions({
    includeAllUsers: true,
    includeAllListingStatuses: true,
  });
  await AdminUser.deleteMany({});
  await User.deleteMany({});
  admin.__verifyIdTokenMock.mockReset();
});

// Shared seed helpers.

// Seed an APPROVED + moderation-active seller so the Phase 3 seller-cascade
// hide hook does NOT short-circuit our cars during reads — only the LENF-02
// branch-on-req.admin behaviour is under test here.
async function seedActiveSeller(uid = 'seller-lenf02-1') {
  await User.create({
    firebaseUid: uid,
    email: 'seller-lenf02@test.local',
    sellerStatus: 'APPROVED',
    moderationStatus: { state: 'active', severity: 'none' },
  });
  return uid;
}

// Seed a Car via Car.collection.insertOne (Shared Pattern S-9): bypasses save
// validators AND the pre(/^find/) hide hooks during seeding (writes never
// trigger find middleware).
async function seedCar(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Car.collection.insertOne({
    _id,
    sellerId: 'seller-lenf02-1',
    sellerEmail: 'seller-lenf02@test.local',
    sellerName: 'Seller Name',
    sellerPhone: '+10000000000',
    makeName: 'Honda',
    modelName: 'Civic',
    year: 2021,
    price: 18000,
    description: 'a long description with seller PII flavour text',
    location: 'Almaty',
    mileage: 12345,
    condition: 'used',
    knownIssues: 'none',
    imageUrls: ['https://cdn.example.com/photo-1.jpg', 'https://cdn.example.com/photo-2.jpg'],
    listingStatus: 'active',
    status: 'active',
    createdAt: new Date(),
    ...overrides,
  });
  return _id.toString();
}

async function seedAdmin(email = 'admin@test.local', role = 'admin') {
  await AdminUser.collection.insertOne({ email: email.toLowerCase(), role });
}

describe('LENF-02 status-aware GET /api/cars/:id (Plan 09-03 contract)', () => {
  // (a) — 09-LENF02-a — non-admin suspended -> 200 + EXACT D-05 allowlist
  test('non-admin GET on suspended listing returns 200 + EXACT D-05 thin payload allowlist (Object.keys exact match)', async () => {
    await seedActiveSeller();
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'spam',           // enum (B-1 lock)
      moderationNote: 'troll listing',    // free-text (B-1 lock)
      moderatedBy: 'admin-X',
      moderatedAt: new Date('2026-05-20T12:00:00Z'),
    });

    const res = await request(app).get(`/api/cars/${carId}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['banner', 'carId', 'firstPhotoUrl', 'make', 'model', 'price', 'reasonCategory', 'status', 'title', 'year'].sort()
    );
    // B-1 LOCK: reasonCategory sourced from car.moderationReason (enum).
    expect(res.body.reasonCategory).toBe('spam');
    expect(res.body.status).toBe('suspended');
    expect(res.body.carId).toBe(carId);
    expect(res.body.firstPhotoUrl).toBe('https://cdn.example.com/photo-1.jpg');
    expect(res.body.banner).toEqual({
      titleKey: 'listingBannerSuspendedTitle',
      bodyKey: 'listingBannerSuspendedBody',
      severity: 'warning',
    });
    // Belt-and-braces: explicit absence assertions for the two most sensitive
    // leaks (seller PII + full image array) on the locked thin-payload path.
    expect(res.body).not.toHaveProperty('sellerEmail');
    expect(res.body).not.toHaveProperty('imageUrls');
  });

  // (b) — 09-LENF02-b — thin payload absence assertion (PII leak guard)
  test('non-admin thin payload does NOT have sellerEmail/sellerName/sellerPhone/sellerId/description/moderationNote/moderationReason/moderatedBy/moderatedAt/lastEditedBy/mileage/location/condition/knownIssues/imageUrls (Pitfall 5)', async () => {
    await seedActiveSeller();
    const carId = await seedCar({
      status: 'archived',
      moderationReason: 'inactive_seller',
      moderationNote: 'archived by admin',
      moderatedBy: 'admin-X',
      moderatedAt: new Date('2026-05-20T12:00:00Z'),
    });

    const res = await request(app).get(`/api/cars/${carId}`);

    expect(res.status).toBe(200);
    [
      'sellerEmail',
      'sellerName',
      'sellerPhone',
      'sellerId',
      'description',
      'moderationNote',
      'moderationReason',
      'moderatedBy',
      'moderatedAt',
      'lastEditedBy',
      'mileage',
      'location',
      'condition',
      'knownIssues',
      'imageUrls',
    ].forEach((field) => {
      expect(res.body).not.toHaveProperty(field);
    });
  });

  // (c) — 09-LENF02-c — admin sees full doc + moderationBadge (D-07) +
  //                     B-1 A1-mapping lock (enum + free-text distinct values)
  test('admin GET on suspended listing returns full doc + moderationBadge with the 5 D-07 fields (B-1 A1 mapping locked)', async () => {
    await seedActiveSeller();
    await seedAdmin('admin@test.local', 'admin');
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'spam',           // enum (B-1 lock)
      moderationNote: 'troll listing',    // free-text (B-1 lock)
      moderatedBy: 'admin-X',
      moderatedAt: new Date('2026-05-20T12:00:00Z'),
    });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'admin-1', email: 'admin@test.local' });

    const res = await request(app)
      .get(`/api/cars/${carId}`)
      .set('Authorization', 'Bearer fake-admin-token');

    expect(res.status).toBe(200);
    // Existing full-doc fields preserved (the spread + map path).
    expect(res.body).toHaveProperty('makeName', 'Honda');
    expect(res.body).toHaveProperty('modelName', 'Civic');
    expect(res.body).toHaveProperty('id', carId);
    expect(res.body).toHaveProperty('make', 'Honda');
    expect(res.body).toHaveProperty('model', 'Civic');
    expect(res.body).toHaveProperty('listingStatus', 'active');

    // B-1 LOCK: distinct seed values flow through to distinct badge fields.
    expect(res.body.moderationBadge.reasonCategory).toBe('spam');           // enum
    expect(res.body.moderationBadge.moderationReason).toBe('troll listing'); // free-text

    // W-8 LOCK: moderatedAt asserted with an ISO-date-prefix regex; empty
    // string would NOT pass `expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)`.
    expect(res.body.moderationBadge.moderatedAt).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    );

    // Full badge shape — 5 D-07 keys.
    expect(res.body.moderationBadge).toEqual({
      status: 'suspended',
      reasonCategory: 'spam',
      moderationReason: 'troll listing',
      moderatedBy: 'admin-X',
      moderatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  // (d) — 09-LENF02-d — admin viewing active listing has NO moderationBadge (Pitfall 4)
  test('admin GET on active listing returns full doc WITHOUT moderationBadge key (Pitfall 4 — conditional spread)', async () => {
    await seedActiveSeller();
    await seedAdmin('admin@test.local', 'admin');
    const carId = await seedCar({ status: 'active' });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'admin-1', email: 'admin@test.local' });

    const res = await request(app)
      .get(`/api/cars/${carId}`)
      .set('Authorization', 'Bearer fake-admin-token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('makeName', 'Honda');
    // Pitfall 4: the key itself is absent (not present with `undefined`).
    expect(res.body).not.toHaveProperty('moderationBadge');
  });

  // (e) — 09-LENF02-e — non-existent id -> 404 (existing semantics preserved)
  test('GET on non-existent carId returns 404 with existing message', async () => {
    const ghostId = new mongoose.Types.ObjectId().toString();
    const res = await request(app).get(`/api/cars/${ghostId}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Car not found');
  });

  // (f) — 09-LENF02-f — malformed id -> 404, NOT 500 CastError (Pitfall 6)
  test('GET on malformed carId (e.g. "not-a-valid-object-id") returns 404 not 500 CastError (Pitfall 6)', async () => {
    const res = await request(app).get('/api/cars/not-a-valid-object-id');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Car not found');
    expect(res.body).not.toHaveProperty('error');
  });

  // (g) — W-3 new case — authenticated NON-admin (valid Firebase token, no
  //                     AdminUser doc seeded) is treated as non-admin (D-08).
  test('authenticated non-admin viewing suspended listing receives D-05 thin payload (W-3 — no AdminUser seeded for buyer@test.local)', async () => {
    await seedActiveSeller();
    // Crucially: do NOT seed any AdminUser for 'buyer@test.local'.
    const carId = await seedCar({
      status: 'suspended',
      moderationReason: 'spam',         // B-1 — same enum value as case (a)
      moderationNote: 'troll listing',
      moderatedBy: 'admin-X',
      moderatedAt: new Date('2026-05-20T12:00:00Z'),
    });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'buyer-1', email: 'buyer@test.local' });

    const res = await request(app)
      .get(`/api/cars/${carId}`)
      .set('Authorization', 'Bearer fake-buyer-token');

    expect(res.status).toBe(200);
    // Same D-05 allowlist as the anonymous case — authenticated non-admin
    // falls through to the thin-payload branch.
    expect(Object.keys(res.body).sort()).toEqual(
      ['banner', 'carId', 'firstPhotoUrl', 'make', 'model', 'price', 'reasonCategory', 'status', 'title', 'year'].sort()
    );
    // B-1 LOCK in the authenticated-non-admin path too — proves the enum
    // value flows through regardless of caller auth state.
    expect(res.body.reasonCategory).toBe('spam');
    // Defense in depth: even with a valid token, no moderationBadge leaks.
    expect(res.body).not.toHaveProperty('moderationBadge');
  });
});
