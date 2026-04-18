// __tests__/moderation/history.test.js
//
// Plan 05-0a — GET /api/admin/moderation/:targetUid/history
//
// Router-level integration test. Follows the harness from acceptance.test.js:
//   firebase-admin is mocked BEFORE any require() that transitively loads it
//   (verifyIdToken.js), then the real verifyIdToken + requireAdmin middleware
//   chain runs against a supertest-driven Express app.
//
// Covers:
//   - 401 when no Bearer token (verifyIdToken gate)
//   - 403 when caller is not an admin (requireAdmin gate)
//   - 200 + items in createdAt DESC order for admin caller
//   - Cursor pagination continues correctly across page boundaries
//   - Final page returns nextCursor === null
//   - 400 on garbage cursor
//   - Respects limit query parameter

// 1. firebase-admin mock — must precede any require() that transitively pulls
// in firebase-admin (verifyIdToken.js). Copied verbatim from acceptance.test.js.
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
const ModerationAction = require('../../src/models/ModerationAction');

const { verifyIdToken } = require('../../src/security/verifyIdToken');
const { requireAdmin } = require('../../src/security/requireAdmin');
const moderationRouter = require('../../src/moderation/router');
const { moderationRateLimiter } = require('../../src/moderation/rateLimit');

const ADMIN_UID = 'history-admin-uid';
const ADMIN_EMAIL = 'history-admin@test.local';
const NON_ADMIN_UID = 'history-non-admin-uid';
const NON_ADMIN_EMAIL = 'history-user@test.local';
const TARGET_UID = 'target-7';

let rs;
let app;

beforeAll(async () => {
  rs = await startReplSet();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  app = express();
  app.use(express.json());
  app.use('/api/admin/moderation', verifyIdToken, requireAdmin, moderationRouter);
});

afterAll(async () => {
  await stopReplSet(rs);
});

beforeEach(async () => {
  await User.deleteMany({});
  await AdminUser.deleteMany({});
  try { await ModerationAction.collection.drop(); } catch (_) { /* may not exist */ }
  admin.__verifyIdTokenMock.mockReset();
  // Reset rate limiter buckets so we don't inherit counts from sibling tests.
  moderationRateLimiter.resetKey(`admin:${ADMIN_UID}`);
  moderationRateLimiter.resetKey(`admin:${NON_ADMIN_UID}`);

  await AdminUser.create({ email: ADMIN_EMAIL, role: 'admin' });
  await User.create({ firebaseUid: ADMIN_UID, email: ADMIN_EMAIL });
  await User.create({ firebaseUid: NON_ADMIN_UID, email: NON_ADMIN_EMAIL });
});

async function seedHistory(count, baseTime = Date.now()) {
  const docs = Array.from({ length: count }, (_, i) => ({
    action: 'suspend',
    severity: 'feature_limited',
    targetUid: TARGET_UID,
    adminUid: ADMIN_UID,
    adminEmail: ADMIN_EMAIL,
    reasonCategory: 'spam',
    note: `row-${i}`,
    createdAt: new Date(baseTime - i * 60_000),
  }));
  await ModerationAction.insertMany(docs);
}

describe('GET /api/admin/moderation/:targetUid/history', () => {
  test('returns 401 when no Bearer token is provided', async () => {
    const res = await request(app).get(`/api/admin/moderation/${TARGET_UID}/history`);
    expect(res.status).toBe(401);
  });

  test('returns 403 when caller is not an admin', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: NON_ADMIN_UID, email: NON_ADMIN_EMAIL });

    const res = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history`)
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(403);
  });

  test('returns 200 + items in createdAt DESC order for admin caller', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
    await seedHistory(5);

    const res = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history`)
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(5);
    for (let i = 1; i < res.body.items.length; i++) {
      const prev = new Date(res.body.items[i - 1].createdAt).getTime();
      const curr = new Date(res.body.items[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  test('paginates via cursor — second page continues where first left off', async () => {
    // Pre-auth for both requests (the mock consumes one per call).
    admin.__verifyIdTokenMock
      .mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL })
      .mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
    await seedHistory(30);

    const page1 = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history?limit=10`)
      .set('Authorization', 'Bearer admin-token');
    expect(page1.body.items.length).toBe(10);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history?limit=10&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('Authorization', 'Bearer admin-token');
    expect(page2.body.items.length).toBe(10);
    expect(page2.body.items[0]._id).not.toBe(page1.body.items[9]._id);
    // Continuity: page 2's first item is older than page 1's last item.
    expect(new Date(page2.body.items[0].createdAt).getTime())
      .toBeLessThanOrEqual(new Date(page1.body.items[9].createdAt).getTime());
  });

  test('final page returns nextCursor === null', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
    await seedHistory(5);

    const res = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history?limit=10`)
      .set('Authorization', 'Bearer admin-token');

    expect(res.body.items.length).toBe(5);
    expect(res.body.nextCursor).toBeNull();
  });

  test('returns 400 on garbage cursor', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });

    const res = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history?cursor=this-is-not-base64-json`)
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cursor');
  });

  test('respects limit parameter', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
    await seedHistory(10);

    const res = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history?limit=5`)
      .set('Authorization', 'Bearer admin-token');

    expect(res.body.items.length).toBe(5);
    expect(res.body.nextCursor).toBeTruthy();
  });

  test('clamps limit to 100 when caller requests more', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
    await seedHistory(120);

    const res = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history?limit=9999`)
      .set('Authorization', 'Bearer admin-token');

    expect(res.body.items.length).toBe(100);
  });

  test('scopes results to the requested targetUid', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });
    await seedHistory(3); // for TARGET_UID
    // Unrelated target — should NOT appear in response.
    await ModerationAction.create({
      action: 'suspend',
      severity: 'feature_limited',
      targetUid: 'other-target',
      adminUid: ADMIN_UID,
      adminEmail: ADMIN_EMAIL,
      reasonCategory: 'spam',
      createdAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/admin/moderation/${TARGET_UID}/history`)
      .set('Authorization', 'Bearer admin-token');

    expect(res.body.items.length).toBe(3);
    for (const item of res.body.items) {
      expect(item.targetUid).toBe(TARGET_UID);
    }
  });
});
