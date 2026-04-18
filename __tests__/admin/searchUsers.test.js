// __tests__/admin/searchUsers.test.js
//
// Plan 05-0b — GET /api/admin/users/search
//
// Router-level integration test. Same firebase-admin mock / real middleware
// pattern as the moderation history tests, but mounts the full adminRouter +
// its required middleware chain.
//
// Covers: admin gate (401 / 403 / 200), email substring, UID prefix match,
// role filter (each of the 5 allowlist values), state filter, combined
// filters (AND semantics), ReDoS safety, validation 400s
// (q_too_long / invalid_role / invalid_state / invalid_cursor),
// cursor pagination round-trip.

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
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');
const admin = require('firebase-admin');

const User = require('../../src/models/User');
const AdminUser = require('../../src/models/AdminUser');

const adminRouter = require('../../src/admin/router');

const ADMIN_UID = 'search-admin-uid';
const ADMIN_EMAIL = 'search-admin@test.local';
const NON_ADMIN_UID = 'search-non-admin-uid';
const NON_ADMIN_EMAIL = 'search-user@test.local';

let rs;
let app;

beforeAll(async () => {
  rs = await startReplSet();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  app = express();
  app.use(express.json());
  // Mount exactly as server.js does — adminRouter carries its own per-route
  // verifyIdToken + requireAdmin (Plan 05-0b structure).
  app.use('/api/admin', adminRouter);
});

afterAll(async () => {
  await stopReplSet(rs);
});

beforeEach(async () => {
  await User.deleteMany({});
  await AdminUser.deleteMany({});
  admin.__verifyIdTokenMock.mockReset();

  await AdminUser.create({ email: ADMIN_EMAIL, role: 'admin' });
});

async function seedUsers() {
  // createdAt spread guarantees deterministic sort order across filter tests.
  const baseTime = Date.now();
  await User.insertMany([
    {
      firebaseUid: ADMIN_UID,
      email: ADMIN_EMAIL,
      isAdmin: true,
      moderationStatus: { state: 'active' },
      createdAt: new Date(baseTime - 1000),
    },
    {
      firebaseUid: 'broker-uid',
      email: 'alice.broker@example.com',
      brokerStatus: 'APPROVED',
      moderationStatus: { state: 'active' },
      createdAt: new Date(baseTime - 2000),
    },
    {
      firebaseUid: 'logistics-uid',
      email: 'bob.logi@example.com',
      logisticsStatus: 'APPROVED',
      moderationStatus: { state: 'feature_limited' },
      createdAt: new Date(baseTime - 3000),
    },
    {
      firebaseUid: 'seller-uid',
      email: 'carol.sale@example.com',
      sellerStatus: 'APPROVED',
      moderationStatus: { state: 'active' },
      createdAt: new Date(baseTime - 4000),
    },
    {
      firebaseUid: 'buyer-uid',
      email: 'dave.buyer@example.com',
      moderationStatus: { state: 'blocked_with_review' },
      createdAt: new Date(baseTime - 5000),
    },
  ]);
}

function mockAdminToken() {
  admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
}

describe('GET /api/admin/users/search', () => {
  test('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/admin/users/search');
    expect(res.status).toBe(401);
  });

  test('returns 403 when caller is not an admin', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: NON_ADMIN_UID, email: NON_ADMIN_EMAIL });
    const res = await request(app)
      .get('/api/admin/users/search')
      .set('Authorization', 'Bearer non-admin-token');
    expect(res.status).toBe(403);
  });

  test('returns 200 + all users for empty query (admin caller)', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBe(5);
    expect(res.body.users[0].localId).toBeDefined();
  });

  test('q matches email substring case-insensitively', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?q=ALICE')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].email).toBe('alice.broker@example.com');
  });

  test('q matches Firebase UID prefix', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?q=broker-')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].localId).toBe('broker-uid');
  });

  test('role=broker narrows to APPROVED brokers only', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?role=broker')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].localId).toBe('broker-uid');
  });

  test('role=admin narrows to admins only', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?role=admin')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].localId).toBe(ADMIN_UID);
  });

  test('role=seller narrows to APPROVED sellers only', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?role=seller')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].localId).toBe('seller-uid');
  });

  test('role=logistics narrows to APPROVED logistics only', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?role=logistics')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].localId).toBe('logistics-uid');
  });

  test('role=buyer excludes provider roles and admins', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?role=buyer')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].localId).toBe('buyer-uid');
  });

  test('state filter narrows to matching moderation state', async () => {
    mockAdminToken();
    await seedUsers();
    const res = await request(app)
      .get('/api/admin/users/search?state=feature_limited')
      .set('Authorization', 'Bearer admin-token');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].localId).toBe('logistics-uid');
  });

  test('combined role + state filters AND together', async () => {
    admin.__verifyIdTokenMock
      .mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL })
      .mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
    await seedUsers();

    const matchRes = await request(app)
      .get('/api/admin/users/search?role=logistics&state=feature_limited')
      .set('Authorization', 'Bearer admin-token');
    expect(matchRes.body.users.length).toBe(1);
    expect(matchRes.body.users[0].localId).toBe('logistics-uid');

    const noMatch = await request(app)
      .get('/api/admin/users/search?role=broker&state=feature_limited')
      .set('Authorization', 'Bearer admin-token');
    expect(noMatch.body.users.length).toBe(0);
  });

  test('q with regex special chars is escaped (ReDoS-safe)', async () => {
    mockAdminToken();
    await seedUsers();
    // Classic catastrophic-backtrack payload. With escapeRegex it becomes a
    // literal string match — zero matches, and no backtrack hang.
    const evilQ = '(a+)+$';
    const start = Date.now();
    const res = await request(app)
      .get(`/api/admin/users/search?q=${encodeURIComponent(evilQ)}`)
      .set('Authorization', 'Bearer admin-token');
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    expect(res.body.users.length).toBe(0);
  });

  test('returns 400 when q exceeds 128 chars', async () => {
    mockAdminToken();
    const longQ = 'a'.repeat(129);
    const res = await request(app)
      .get(`/api/admin/users/search?q=${longQ}`)
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('q_too_long');
  });

  test('returns 400 on invalid role', async () => {
    mockAdminToken();
    const res = await request(app)
      .get('/api/admin/users/search?role=superhero')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_role');
  });

  test('returns 400 on invalid state', async () => {
    mockAdminToken();
    const res = await request(app)
      .get('/api/admin/users/search?state=on_holiday')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_state');
  });

  test('cursor pagination round-trips', async () => {
    admin.__verifyIdTokenMock
      .mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL })
      .mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });

    const baseTime = Date.now();
    const docs = Array.from({ length: 30 }, (_, i) => ({
      firebaseUid: `u${String(i).padStart(3, '0')}`,
      email: `u${i}@example.com`,
      moderationStatus: { state: 'active' },
      createdAt: new Date(baseTime - i * 1000),
    }));
    await User.insertMany(docs);

    const page1 = await request(app)
      .get('/api/admin/users/search?limit=10')
      .set('Authorization', 'Bearer admin-token');
    expect(page1.body.users.length).toBe(10);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/admin/users/search?limit=10&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('Authorization', 'Bearer admin-token');
    expect(page2.body.users.length).toBe(10);
    expect(page2.body.users[0].localId).not.toBe(page1.body.users[9].localId);
  });

  test('returns 400 on garbage cursor', async () => {
    mockAdminToken();
    const res = await request(app)
      .get('/api/admin/users/search?cursor=garbage')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cursor');
  });
});
