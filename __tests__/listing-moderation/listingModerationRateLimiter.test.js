// __tests__/listing-moderation/listingModerationRateLimiter.test.js
//
// LSEC-03 lock for the new /api/admin/moderation/listings prefix.
// Three supertest assertions per 07-PATTERNS.md §11:
//   1. 30-then-429 with retryAfter + Retry-After header (LSEC-03 primary)
//   2. per-admin keying — admin C's bucket independent of admin A's
//   3. D-04 SEPARATE BUCKET PROOF — admin A exhausting the listing bucket
//      does NOT block the same admin on the v1.0 user-mod prefix
//
// Why this file mounts BOTH prefixes on one app: the D-04 invariant ("listing
// and user-mod buckets are independent") is only provable end-to-end if a
// single supertest hits both prefixes with the same admin uid and observes
// the listing one is 429 while the v1.0 one is 200.
//
// IMPORTANT — v1.0 limiter mount: src/moderation/router.js line 53 installs
// `router.use(moderationRateLimiter)` INSIDE the v1.0 user-mod router. We
// therefore mount ONLY verifyIdToken + requireAdmin + moderationRouter at the
// /api/admin/moderation prefix here — re-mounting the v1.0 limiter at app-level
// would double-tick the bucket (429 at request 16 instead of 31) and break the
// D-04 separate-bucket invariant. The new listing limiter mounts at app-level
// because src/moderation/listingRouter.js is dependency-free (D-01).
//
// Test isolation: the rate-limiter's in-memory store carries state across
// tests. beforeEach calls .resetKey() on BOTH limiter singletons for every
// admin uid touched in this file. The v1.0 limiter is the SAME singleton
// whether reached via require('../../src/moderation/rateLimit') here or via
// router.use(moderationRateLimiter) inside moderationRouter — Node's module
// cache is process-wide.

// Mock firebase-admin BEFORE any module that uses it.
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

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const admin = require('firebase-admin');
const { verifyIdToken } = require('../../src/security/verifyIdToken');
const { requireAdmin } = require('../../src/security/requireAdmin');
const listingRouter = require('../../src/moderation/listingRouter');
const {
  listingModerationRateLimiter,
  WINDOW_MS,
  MAX_REQUESTS,
} = require('../../src/moderation/listingRateLimit');
const AdminUser = require('../../src/models/AdminUser');

// v1.0 user-mod surface — imported ONLY for the D-04 separate-bucket test:
//   - moderationRouter: mounted at /api/admin/moderation so admin A can hit
//     /api/admin/moderation/ping to prove the v1.0 bucket is untouched.
//   - moderationRateLimiter (singleton instance): imported so beforeEach can
//     call .resetKey() to ensure the v1.0 bucket starts fresh. The limiter is
//     ALREADY installed inside moderationRouter at router.js:53 — we do NOT
//     re-mount it at app-level (see header comment for the double-tick reason).
const moderationRouter = require('../../src/moderation/router');
const { moderationRateLimiter } = require('../../src/moderation/rateLimit');

const ADMIN_A_UID = 'admin-a-uid';
const ADMIN_A_EMAIL = 'admin-a@test.local';
const ADMIN_C_UID = 'admin-c-uid';
const ADMIN_C_EMAIL = 'admin-c@test.local';

let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  await AdminUser.create({ email: ADMIN_A_EMAIL, role: 'admin' });
  await AdminUser.create({ email: ADMIN_C_EMAIL, role: 'admin' });

  app = express();
  app.use(express.json());

  // New listing-mod chain (Phase 7 D-03) — limiter at APP level because
  // listingRouter.js is dependency-free (D-01) and does NOT install its own
  // limiter. Middleware order is load-bearing: verifyIdToken → requireAdmin →
  // listingModerationRateLimiter → listingRouter (so req.admin.uid is set
  // when keyGenerator runs).
  app.use(
    '/api/admin/moderation/listings',
    verifyIdToken,
    requireAdmin,
    listingModerationRateLimiter,
    listingRouter,
  );

  // v1.0 user-mod chain — limiter is ALREADY installed inside moderationRouter
  // at src/moderation/router.js:53 via router.use(moderationRateLimiter).
  // DO NOT add moderationRateLimiter to this app.use() line — double-mounting
  // would tick the bucket TWICE per request and break the D-04 separate-bucket
  // invariant (admin would hit 429 at request 16 instead of 31).
  app.use('/api/admin/moderation', verifyIdToken, requireAdmin, moderationRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(() => {
  // Limiter state carries across tests (in-memory store); reset every key any
  // test touches. Key prefixes MUST match the keyGenerator output:
  //   - listing limiter: `listing-admin:<uid>`
  //   - v1.0 limiter:    `admin:<uid>`
  listingModerationRateLimiter.resetKey(`listing-admin:${ADMIN_A_UID}`);
  listingModerationRateLimiter.resetKey(`listing-admin:${ADMIN_C_UID}`);
  moderationRateLimiter.resetKey(`admin:${ADMIN_A_UID}`);
  admin.__verifyIdTokenMock.mockReset();
});

describe('listingModerationRateLimiter — LSEC-03 + D-04', () => {
  test('30 successful pings from admin A, the 31st returns 429 with retryAfter + Retry-After header', async () => {
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_A_UID, email: ADMIN_A_EMAIL });

    for (let i = 0; i < 30; i++) {
      const r = await request(app)
        .get('/api/admin/moderation/listings/ping')
        .set('Authorization', 'Bearer ok-token');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    }

    const blocked = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Bearer ok-token');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(typeof blocked.body.retryAfter).toBe('number');
    expect(blocked.body.retryAfter).toBeGreaterThanOrEqual(0);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    // Sanity: the limiter's documented budget didn't silently widen.
    expect(MAX_REQUESTS).toBe(30);
    expect(WINDOW_MS).toBe(15 * 60 * 1000);
  }, 60_000);

  test('per-admin keying: admin C succeeds after admin A exhausts the listing bucket', async () => {
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_A_UID, email: ADMIN_A_EMAIL });
    for (let i = 0; i < 30; i++) {
      const r = await request(app)
        .get('/api/admin/moderation/listings/ping')
        .set('Authorization', 'Bearer ok-token');
      expect(r.status).toBe(200);
    }
    const aBlocked = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Bearer ok-token');
    expect(aBlocked.status).toBe(429);

    // Switch to admin C — different uid → independent bucket (D-04 / D-31 carry-forward).
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_C_UID, email: ADMIN_C_EMAIL });
    const cRes = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Bearer ok-token');
    expect(cRes.status).toBe(200);
    expect(cRes.body).toEqual({ ok: true });
  }, 60_000);

  test('separate buckets: admin A exhausting listing bucket does NOT block same admin on user-mod prefix (D-04)', async () => {
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_A_UID, email: ADMIN_A_EMAIL });

    // Exhaust the LISTING bucket.
    for (let i = 0; i < 30; i++) {
      const r = await request(app)
        .get('/api/admin/moderation/listings/ping')
        .set('Authorization', 'Bearer ok-token');
      expect(r.status).toBe(200);
    }
    const listingBlocked = await request(app)
      .get('/api/admin/moderation/listings/ping')
      .set('Authorization', 'Bearer ok-token');
    expect(listingBlocked.status).toBe(429);

    // The SAME admin A hits the v1.0 user-mod /ping — the v1.0 bucket
    // (`admin:<uid>`) is untouched, so this must return 200. If the buckets
    // were shared (or if we'd double-mounted the v1.0 limiter at app level),
    // this would 429 instead.
    const userModRes = await request(app)
      .get('/api/admin/moderation/ping')
      .set('Authorization', 'Bearer ok-token');
    expect(userModRes.status).toBe(200);
    expect(userModRes.body).toEqual({ ok: true });
  }, 60_000);
});
