// __tests__/listing-moderation/requireAdmin.listing.middleware.test.js
//
// LSEC-01 + LSEC-02 lock for the new /api/admin/moderation/listings prefix.
// Mirrors __tests__/moderation/requireAdmin.middleware.test.js verbatim shape;
// all paths swapped to the listing prefix per Phase 7 D-19. The minimal app
// in beforeAll INTENTIONALLY does NOT mount the listing rate-limit middleware
// so the 401/403/200 cases here can't accidentally trip a 429. The full
// limiter-in-chain behaviour is exercised by the sibling rate-limit supertest
// file (LSEC-03 — see 07-PATTERNS.md §11).
//
// 401/403 response envelopes are byte-identical to the v1.0 user-mod surface
// per Phase 7 D-06 — the mobile apiClient interceptor (v1.0 Plan 04-06)
// distinguishes by `error` code only, so the new prefix is handled without
// mobile-side change.

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Mock firebase-admin BEFORE requiring any module that uses it.
// Keeps the middleware test isolated from a real Firebase project/service account.
jest.mock('firebase-admin', () => {
  const verifyIdTokenMock = jest.fn();
  const mock = {
    credential: { cert: jest.fn(() => ({})) },
    initializeApp: jest.fn(),
    auth: jest.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
  };
  // Expose the inner mock so tests can control it.
  mock.__verifyIdTokenMock = verifyIdTokenMock;
  return mock;
});

const admin = require('firebase-admin');
const { verifyIdToken } = require('../../src/security/verifyIdToken');
const { requireAdmin } = require('../../src/security/requireAdmin');
const listingRouter = require('../../src/moderation/listingRouter');
const AdminUser = require('../../src/models/AdminUser');

let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Any non-empty value satisfies ensureInitialized(); the real admin.auth() is mocked.
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  app = express();
  app.use(express.json());
  // NOTE: listing rate-limit middleware intentionally NOT in this chain per
  // 07-PATTERNS.md §12 — keeps the 401/403/200 cases from accidentally hitting
  // a 429. LSEC-03 rate-limit chain is covered in the sibling test file.
  app.use('/api/admin/moderation/listings', verifyIdToken, requireAdmin, listingRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  admin.__verifyIdTokenMock.mockReset();
  await AdminUser.deleteMany({});
});

describe('/api/admin/moderation/listings/ping (LSEC-01 + LSEC-02)', () => {
  test('no Authorization header → 401 unauthenticated', async () => {
    const res = await request(app).get('/api/admin/moderation/listings/ping');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated', message: 'Missing or invalid idToken' });
  });

  test('malformed Authorization header → 401 unauthenticated', async () => {
    const res = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated', message: 'Missing or invalid idToken' });
  });

  test('invalid Bearer token (verifyIdToken throws) → 401 unauthenticated', async () => {
    admin.__verifyIdTokenMock.mockRejectedValueOnce(new Error('invalid signature'));
    const res = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated', message: 'Missing or invalid idToken' });
  });

  test('valid idToken but email not an AdminUser → 403 unauthorized', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'u1', email: 'notadmin@test.local' });
    const res = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Bearer ok-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unauthorized', message: 'Admin access required' });
  });

  test('valid admin idToken → 200 { ok: true }', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'u2', email: 'admin@test.local' });
    const res = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Bearer ok-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('req.admin.uid propagates from requireAdmin into the route handler (LSEC-03 prerequisite)', async () => {
    // Confirms the rate-limiter's keyGenerator will see a populated uid when the
    // full chain runs (Task 2 of plan 07-05). Install a passthrough route
    // mid-chain that captures req.admin so we can assert its shape.
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({
      uid: 'admin-uid-from-token',
      email: 'admin@test.local',
    });

    const spyApp = express();
    spyApp.use(express.json());
    spyApp.get(
      '/api/admin/moderation/listings/spy',
      verifyIdToken,
      requireAdmin,
      (req, res) => {
        res.json({ admin: req.admin });
      },
    );

    const res = await request(spyApp)
      .get('/api/admin/moderation/listings/spy')
      .set('Authorization', 'Bearer ok-token');

    expect(res.status).toBe(200);
    expect(res.body.admin).toEqual({
      uid: 'admin-uid-from-token',
      role: 'admin',
      email: 'admin@test.local',
    });
  });
});
