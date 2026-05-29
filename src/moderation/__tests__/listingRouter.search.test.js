// src/moderation/__tests__/listingRouter.search.test.js
//
// Plan 10-03 (LUI-04) — integration tests for the new
// GET /api/admin/moderation/listings endpoint.
//
// RED gate: Task 1 lands this file BEFORE the GET route is mounted on
// listingRouter.js. Every test below MUST fail (Express returns 404 — no
// route at `/`). Task 2 (schema + service) keeps the failure mode, then
// Task 3 (router.get('/') handler) flips the suite to GREEN.
//
// Coverage (8 behavior blocks per 10-03-PLAN.md):
//   Block 1 — auth chain: missing Bearer 401 / admin 200 / non-admin 403
//   Block 2 — response shape: empty DB returns { rows: [], nextCursor: null }
//   Block 3 — hide-hook bypass (Pitfall 4 / T-10-04): all 4 statuses visible
//   Block 4 — status filter: ?status=<state> returns only matching rows
//   Block 5 — cursor pagination: limit+1 hasMore + nextCursor round-trip
//   Block 6 — q whitelist (Pitfall 10 / T-10-03): make/model/listingId only,
//             NEVER description/phoneNumber/telegramUsername (PII guard)
//   Block 7 — Zod .strict(): invalid_state / non-numeric limit / unknown key
//   Block 8 — invalid cursor: returns { rows: [], nextCursor: null } defensively
//
// Test harness mirrors __tests__/listing-moderation/requireAdmin.listing.middleware.test.js:
//   - jest.mock('firebase-admin') BEFORE any require so the real verifyIdToken
//     chain (verifyIdToken → requireAdmin → listingRouter) can run end-to-end
//     under control of `admin.__verifyIdTokenMock.mockResolvedValue(...)`.
//   - MongoMemoryReplSet because Phase 9 Car hooks run on every find and the
//     route uses `.lean()` reads; standalone MongoMemoryServer would work for
//     reads-only tests but the replica-set fixture matches the production-
//     adjacent shape used by the Phase 8 service-level tests.
//   - Cars seeded via Car.collection.insertOne() to bypass model-level
//     validators + the pre(/^find/) hide hooks during seeding (mirror
//     __tests__/listing-moderation/suspendListing.test.js seedCar helper).

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
const { startReplSet, stopReplSet } = require('../../../__tests__/_helpers/mongoReplSet');

const admin = require('firebase-admin');
const { verifyIdToken } = require('../../security/verifyIdToken');
const { requireAdmin } = require('../../security/requireAdmin');
const listingRouter = require('../listingRouter');
const Car = require('../../models/Car');
const AdminUser = require('../../models/AdminUser');

const ADMIN_UID = 'admin-uid-search';
const ADMIN_EMAIL = 'admin-search@test.local';
const NON_ADMIN_UID = 'plain-user-uid';
const NON_ADMIN_EMAIL = 'plain-user@test.local';

let rs;
let app;

beforeAll(async () => {
  rs = await startReplSet();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });
  await AdminUser.create({ email: ADMIN_EMAIL, role: 'admin' });

  app = express();
  app.use(express.json());
  // Same chain as server.js:925 EXCEPT for the listing rate-limiter — we omit
  // it here so cursor-pagination loops (Block 5) and Zod cases (Block 7) cannot
  // accidentally hit a 429. The full limiter chain is covered by the dedicated
  // listingModerationRateLimiter.test.js sibling file.
  app.use('/api/admin/moderation/listings', verifyIdToken, requireAdmin, listingRouter);
});

afterAll(async () => {
  await stopReplSet(rs);
});

beforeEach(async () => {
  admin.__verifyIdTokenMock.mockReset();
  await Car.deleteMany({});
});

// Helper — direct-insert a Car so the pre(/^find/) seller-cascade hook and
// listing-status hide hook (which Block 3 explicitly stresses) don't fire on
// seeding. Returns the inserted _id string.
async function seedCar(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  const now = new Date();
  await Car.collection.insertOne({
    _id,
    sellerId: 'seller-x',
    status: 'active',
    listingStatus: 'active',
    makeName: 'GenericMake',
    modelName: 'GenericModel',
    year: 2020,
    price: 10000,
    imageUrls: [],
    createdAt: now,
    ...overrides,
  });
  return { id: _id.toString(), createdAt: overrides.createdAt || now };
}

function mockAdmin() {
  admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_UID, email: ADMIN_EMAIL });
}
function mockNonAdmin() {
  admin.__verifyIdTokenMock.mockResolvedValue({ uid: NON_ADMIN_UID, email: NON_ADMIN_EMAIL });
}

describe('GET /api/admin/moderation/listings', () => {
  // ─────────────────────────────────────────────────────────────────────
  // Block 1 — auth chain (T-10-01 mitigation)
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 1 — auth chain', () => {
    test('missing Bearer → 401 unauthenticated', async () => {
      const res = await request(app).get('/api/admin/moderation/listings');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'unauthenticated',
        message: 'Missing or invalid idToken',
      });
    });

    test('admin Bearer → 200 with envelope shape', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('rows');
      expect(res.body).toHaveProperty('nextCursor');
    });

    test('non-admin Bearer → 403 unauthorized', async () => {
      mockNonAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'unauthorized',
        message: 'Admin access required',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Block 2 — response shape on empty DB
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 2 — response shape', () => {
    test('empty DB → { rows: [], nextCursor: null }', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rows)).toBe(true);
      expect(res.body.rows).toHaveLength(0);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Block 3 — hide-hook bypass (T-10-04 mitigation)
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 3 — hide-hook bypass', () => {
    test('admin GET without status filter returns ALL 4 status rows', async () => {
      // Seed 4 distinct rows. Without setOptions({ includeAllListingStatuses: true })
      // the Phase 9 hide hook silently filters to only the active row.
      await seedCar({ status: 'active', makeName: 'A', createdAt: new Date(2024, 0, 1) });
      await seedCar({ status: 'suspended', makeName: 'B', createdAt: new Date(2024, 0, 2) });
      await seedCar({ status: 'archived', makeName: 'C', createdAt: new Date(2024, 0, 3) });
      await seedCar({ status: 'deleted', makeName: 'D', createdAt: new Date(2024, 0, 4) });

      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings')
        .set('Authorization', 'Bearer ok-token');

      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(4);
      const statuses = res.body.rows.map((r) => r.status).sort();
      expect(statuses).toEqual(['active', 'archived', 'deleted', 'suspended']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Block 4 — status filter
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 4 — status filter', () => {
    beforeEach(async () => {
      await seedCar({ status: 'active', makeName: 'Active1' });
      await seedCar({ status: 'suspended', makeName: 'Susp1' });
      await seedCar({ status: 'archived', makeName: 'Arch1' });
      await seedCar({ status: 'deleted', makeName: 'Del1' });
    });

    test.each(['active', 'suspended', 'archived', 'deleted'])(
      '?status=%s returns ONLY rows matching that status',
      async (status) => {
        mockAdmin();
        const res = await request(app)
          .get(`/api/admin/moderation/listings?status=${status}`)
          .set('Authorization', 'Bearer ok-token');
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(1);
        expect(res.body.rows[0].status).toBe(status);
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // Block 5 — cursor pagination
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 5 — cursor pagination', () => {
    test('limit=2 paginates 5 rows in 3 pages with final nextCursor=null', async () => {
      // Sequential createdAt so sort { createdAt: -1, _id: -1 } is deterministic.
      // We seed in ASCENDING createdAt order; result rows come back DESCENDING.
      for (let i = 1; i <= 5; i++) {
        await seedCar({ makeName: `Row${i}`, createdAt: new Date(2024, 0, i) });
      }

      mockAdmin();

      // Page 1
      const p1 = await request(app)
        .get('/api/admin/moderation/listings?limit=2')
        .set('Authorization', 'Bearer ok-token');
      expect(p1.status).toBe(200);
      expect(p1.body.rows).toHaveLength(2);
      expect(p1.body.nextCursor).not.toBeNull();
      expect(typeof p1.body.nextCursor).toBe('string');

      // Page 2 — use cursor from page 1
      const p2 = await request(app)
        .get(`/api/admin/moderation/listings?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
        .set('Authorization', 'Bearer ok-token');
      expect(p2.status).toBe(200);
      expect(p2.body.rows).toHaveLength(2);
      expect(p2.body.nextCursor).not.toBeNull();

      // Page 3 (final) — only 1 row remains; nextCursor MUST be null.
      const p3 = await request(app)
        .get(`/api/admin/moderation/listings?limit=2&cursor=${encodeURIComponent(p2.body.nextCursor)}`)
        .set('Authorization', 'Bearer ok-token');
      expect(p3.status).toBe(200);
      expect(p3.body.rows).toHaveLength(1);
      expect(p3.body.nextCursor).toBeNull();

      // All 5 distinct rows seen across pages
      const allIds = [...p1.body.rows, ...p2.body.rows, ...p3.body.rows].map((r) => r._id);
      expect(new Set(allIds).size).toBe(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Block 6 — q whitelist (T-10-03 PII guard)
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 6 — q whitelist (PII guard)', () => {
    let seededId;

    beforeEach(async () => {
      const seeded = await seedCar({
        makeName: 'Toyota',
        modelName: 'Camry',
        description: 'unique_telltale_string_xyz',
        phoneNumber: '555-0101',
        telegramUsername: 'secret_handle',
        listingId: 'AB12CD34',
      });
      seededId = seeded.id;
      await seedCar({ makeName: 'Honda', modelName: 'Civic' });
    });

    test('q=Toyota returns the Toyota row (makeName match)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?q=Toyota')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].makeName).toBe('Toyota');
    });

    test('q=Camry returns the Toyota row (modelName match)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?q=Camry')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].modelName).toBe('Camry');
    });

    test('q=AB12 returns the row whose listingId starts with AB12 (prefix match)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?q=AB12')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]._id).toBe(seededId);
    });

    test('q=unique_telltale_string_xyz returns 0 rows (description NOT searchable)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?q=unique_telltale_string_xyz')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0);
    });

    test('q=555 returns 0 rows (phoneNumber NOT searchable — PII guard)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?q=555')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0);
    });

    test('q=secret_handle returns 0 rows (telegramUsername NOT searchable — PII guard)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?q=secret_handle')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Block 7 — Zod .strict() validation
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 7 — Zod .strict()', () => {
    test('?status=invalid_state → 400 invalid_payload', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?status=invalid_state')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_payload');
    });

    test('?limit=foo → 400 invalid_payload (z.coerce.number rejects non-numerics)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?limit=foo')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_payload');
    });

    test('?unknown=field → 400 invalid_payload (.strict() rejects unknown keys)', async () => {
      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?unknown=field')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_payload');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Block 8 — invalid cursor defensive empty
  // ─────────────────────────────────────────────────────────────────────
  describe('Block 8 — invalid cursor', () => {
    test('?cursor=garbage → { rows: [], nextCursor: null } (defensive)', async () => {
      // Seed something so the empty result is provably from the cursor
      // rejection, not from an empty DB.
      await seedCar();
      await seedCar();

      mockAdmin();
      const res = await request(app)
        .get('/api/admin/moderation/listings?cursor=garbage')
        .set('Authorization', 'Bearer ok-token');
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });
  });
});
