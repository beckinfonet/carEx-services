// __tests__/moderation/acceptance.test.js
//
// End-to-end acceptance test for ROADMAP Phase 2 Success Criterion #5:
//   "An admin calling any moderation endpoint against their own UID returns
//    400 cannot_moderate_self; suspending/revoking the last active admin
//    returns 400 last_admin_protected; issuing more than 30 moderation actions
//    in 15 minutes from one admin returns 429."
//
// Unlike Plans 02-03..02-05 which call service.* functions in-process, this file
// exercises the FULL middleware chain mounted in a test Express app:
//   verifyIdToken -> requireAdmin -> moderationRateLimiter -> denySelfModeration -> handler
//
// TEST ISOLATION STRATEGY (B-01 / B-02 fix from iteration-2 plan-checker):
//   The moderationRateLimiter is a stateful singleton with an in-memory bucket store
//   (Plan 02-02, D-30). Module-tree resetting (the jest API for re-evaluating require
//   trees per describe block) is forbidden here because re-requiring the moderation
//   router transitively re-requires src/models/User.js, AdminUser.js, ModerationAction.js
//   -- each of which does top-level mongoose.model('Name', schema) with no
//   `mongoose.models.Name ||` guard, which throws OverwriteModelError on the second
//   load against the same mongoose singleton. Instead this file does:
//     1. Build the Express app exactly ONCE in a top-level beforeAll. There is no
//        per-describe app-rebuilder helper.
//     2. In a top-level beforeEach, call moderationRateLimiter.resetKey(key) for each
//        admin uid any test in this file uses -- this clears that admin's bucket without
//        touching the module registry. .resetKey(key) is the documented
//        express-rate-limit v8 API on a limiter instance.
//     3. The key format MUST match rateLimit.js's keyGenerator output -- Plan 02-02 uses
//        `admin:${req.admin.uid}`, so tests must call resetKey(`admin:<uid>`).

// 1. firebase-admin mock -- MUST come before any require of a module that uses
// firebase-admin. Copied verbatim from Plan 02-01's requireAdmin.middleware.test.js.
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

// Models (same registered instance regardless of call site -- Phase 1 D-03).
const User = require('../../src/models/User');
const AdminUser = require('../../src/models/AdminUser');
const ModerationAction = require('../../src/models/ModerationAction');

// Security + router -- required ONCE here. Never re-required via the jest module-tree
// reset API (that would trigger OverwriteModelError on the models -- see header comment).
const { verifyIdToken } = require('../../src/security/verifyIdToken');
const { requireAdmin } = require('../../src/security/requireAdmin');
const moderationRouter = require('../../src/moderation/router');
// B-01 fix: we import the limiter INSTANCE so we can call .resetKey() between tests.
const { moderationRateLimiter } = require('../../src/moderation/rateLimit');

let rs;
let app;

// All admin uids any test in this file touches -- listed here so the top-level
// beforeEach can clear every relevant bucket before each test.
const ALL_TEST_ADMIN_UIDS = [
  'self-mod-admin-uid',            // block 1
  'last-admin-caller-uid',         // block 2 -- admin A
  'last-admin-target-uid',         // block 2 -- admin B
  'rate-limit-admin-a-uid',        // block 3 -- admin A
  'rate-limit-admin-c-uid',        // block 3 -- admin C
];

beforeAll(async () => {
  rs = await startReplSet();
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  // Build the Express app exactly once -- never re-built via the jest module-tree reset API.
  app = express();
  app.use(express.json());
  app.use('/api/admin/moderation', verifyIdToken, requireAdmin, moderationRouter);
});
afterAll(async () => { await stopReplSet(rs); });

// B-01 fix: reset every test admin's rate-limit bucket before each test so the 30-count
// loop in block 3 does not inherit counts from block 1's 4 requests or block 2's 1 request.
// Key format MUST match rateLimit.js's keyGenerator: `admin:${req.admin.uid}` (Plan 02-02).
beforeEach(async () => {
  for (const uid of ALL_TEST_ADMIN_UIDS) {
    moderationRateLimiter.resetKey(`admin:${uid}`);
  }
});

async function resetDb() {
  await User.deleteMany({});
  await AdminUser.deleteMany({});
  try { await ModerationAction.collection.drop(); } catch (_) {}
}

// ============================================================================
// BLOCK 1 -- cannot_moderate_self on all 4 mutating routes (D-26, Criterion #5 part 1)
// ============================================================================
describe('Criterion #5 part 1: cannot_moderate_self (all 4 mutating routes)', () => {
  const ADMIN_UID = 'self-mod-admin-uid';
  const ADMIN_EMAIL = 'selfmod-admin@test.local';

  beforeEach(async () => {
    await resetDb();
    await AdminUser.create({ email: ADMIN_EMAIL, role: 'admin' });
    await User.create({
      firebaseUid: ADMIN_UID,
      email: ADMIN_EMAIL,
      brokerStatus: 'APPROVED',   // needed so edit-profile / delete-provider-profile reach denySelfModeration (not role_not_assigned)
      moderationStatus: { state: 'active', severity: 'none' },
    });
    admin.__verifyIdTokenMock.mockReset();
  });

  test('POST /:targetUid (suspend) where targetUid === admin.uid -> 400 cannot_moderate_self', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });

    const res = await request(app)
      .post(`/api/admin/moderation/${ADMIN_UID}`)
      .set('Authorization', 'Bearer ok-token')
      .send({ action: 'suspend', severity: 'feature_limited', reasonCategory: 'spam' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cannot_moderate_self' });

    // No mutation, no audit row.
    const updated = await User.findOne({ firebaseUid: ADMIN_UID }).lean();
    expect(updated.moderationStatus.state).toBe('active');
    const audits = await ModerationAction.find({ targetUid: ADMIN_UID }).lean();
    expect(audits.length).toBe(0);
  });

  test('PATCH /:targetUid/unsuspend where targetUid === admin.uid -> 400 cannot_moderate_self', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });

    const res = await request(app)
      .patch(`/api/admin/moderation/${ADMIN_UID}/unsuspend`)
      .set('Authorization', 'Bearer ok-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cannot_moderate_self' });
  });

  test('DELETE /:targetUid/provider-profile where targetUid === admin.uid -> 400 cannot_moderate_self', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });

    const res = await request(app)
      .delete(`/api/admin/moderation/${ADMIN_UID}/provider-profile`)
      .set('Authorization', 'Bearer ok-token')
      .send({ role: 'broker', reasonCategory: 'fraud' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cannot_moderate_self' });
  });

  test('POST /:targetUid/edit-profile where targetUid === admin.uid -> 400 cannot_moderate_self', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_UID, email: ADMIN_EMAIL });

    const res = await request(app)
      .post(`/api/admin/moderation/${ADMIN_UID}/edit-profile`)
      .set('Authorization', 'Bearer ok-token')
      .send({ role: 'broker', fields: { companyName: 'X' } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cannot_moderate_self' });
  });
});

// ============================================================================
// BLOCK 2 -- last_admin_protected through the wired router (D-27, D-28, Criterion #5 part 2)
// ============================================================================
describe('Criterion #5 part 2: last_admin_protected (wired router)', () => {
  const ADMIN_A_UID = 'last-admin-caller-uid';
  const ADMIN_A_EMAIL = 'admin-a-last@test.local';
  const ADMIN_B_UID = 'last-admin-target-uid';
  const ADMIN_B_EMAIL = 'admin-b-last@test.local';

  // No local app or per-describe rebuilder helper -- the shared top-level `app` is used.
  // The top-level beforeEach has already reset this admin pair's rate-limit buckets via resetKey().
  beforeEach(async () => {
    await resetDb();
    // Two AdminUsers in the AdminUser collection.
    await AdminUser.create({ email: ADMIN_A_EMAIL, role: 'admin' });
    await AdminUser.create({ email: ADMIN_B_EMAIL, role: 'admin' });
    // Admin A is the caller and is NOT active (e.g., previously suspended for some reason
    // outside this flow) -- so the only ACTIVE admin is admin B, the target.
    await User.create({
      firebaseUid: ADMIN_A_UID,
      email: ADMIN_A_EMAIL,
      moderationStatus: {
        state: 'feature_limited', severity: 'feature_limited',
        reasonCategory: 'other', setByAdminUid: 'system', setAt: new Date(),
        restrictedFeatures: ['create_listing'],
      },
    });
    await User.create({
      firebaseUid: ADMIN_B_UID,
      email: ADMIN_B_EMAIL,
      moderationStatus: { state: 'active', severity: 'none' },
    });
    admin.__verifyIdTokenMock.mockReset();
  });

  test('suspending the only active admin via wired POST /:targetUid returns 400 last_admin_protected', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: ADMIN_A_UID, email: ADMIN_A_EMAIL });

    const res = await request(app)
      .post(`/api/admin/moderation/${ADMIN_B_UID}`)
      .set('Authorization', 'Bearer ok-token')
      .send({ action: 'suspend', severity: 'blocked_with_review', reasonCategory: 'fraud' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'last_admin_protected' });

    // State preservation: admin B still active, transaction rolled back -> no audit row.
    const b = await User.findOne({ firebaseUid: ADMIN_B_UID }).lean();
    expect(b.moderationStatus.state).toBe('active');
    const audits = await ModerationAction.find({ targetUid: ADMIN_B_UID }).lean();
    expect(audits.length).toBe(0);
  });
});

// ============================================================================
// BLOCK 3 -- 429 rate_limited at the 31st request + per-admin keying (Criterion #5 part 3)
// ============================================================================
describe('Criterion #5 part 3: rate_limited on 31st action, per-admin keying', () => {
  const ADMIN_A_UID = 'rate-limit-admin-a-uid';
  const ADMIN_A_EMAIL = 'rate-a@test.local';
  const ADMIN_C_UID = 'rate-limit-admin-c-uid';
  const ADMIN_C_EMAIL = 'rate-c@test.local';

  // Uses the shared top-level `app`. The top-level beforeEach has already called
  // moderationRateLimiter.resetKey('admin:' + <uid>) for both ADMIN_A_UID and
  // ADMIN_C_UID -- so admin A starts each test with a fresh 30-count bucket (enabling
  // both the 30-then-429 test AND the per-admin-keying test to start clean).
  beforeEach(async () => {
    await resetDb();
    await AdminUser.create({ email: ADMIN_A_EMAIL, role: 'admin' });
    await AdminUser.create({ email: ADMIN_C_EMAIL, role: 'admin' });
    // Both admins are active (so last-admin guard never fires -- we need 31 successful
    // suspend calls without tripping any other guard except rate-limit).
    await User.create({
      firebaseUid: ADMIN_A_UID, email: ADMIN_A_EMAIL,
      moderationStatus: { state: 'active', severity: 'none' },
    });
    await User.create({
      firebaseUid: ADMIN_C_UID, email: ADMIN_C_EMAIL,
      moderationStatus: { state: 'active', severity: 'none' },
    });
    // 35 non-admin target users -- suspend the first 30 from admin A, then the 31st
    // triggers 429, then a single call from admin C on target-31 should still succeed
    // (fresh bucket, per-admin keying).
    for (let i = 0; i < 35; i++) {
      await User.create({
        firebaseUid: `rl-target-${i}`,
        email: `rl-target-${i}@test.local`,
        moderationStatus: { state: 'active', severity: 'none' },
      });
    }
    admin.__verifyIdTokenMock.mockReset();
  });

  test('30 successful suspends from admin A, the 31st returns 429 with retryAfter + Retry-After header', async () => {
    // Every call from admin A resolves the same token.
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_A_UID, email: ADMIN_A_EMAIL });

    // 30 successful suspend calls, rotating targets.
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post(`/api/admin/moderation/rl-target-${i}`)
        .set('Authorization', 'Bearer ok-token')
        .send({ action: 'suspend', severity: 'feature_limited', reasonCategory: 'spam' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }

    // 31st request -- must return 429 rate_limited.
    const res = await request(app)
      .post(`/api/admin/moderation/rl-target-30`)
      .set('Authorization', 'Bearer ok-token')
      .send({ action: 'suspend', severity: 'feature_limited', reasonCategory: 'spam' });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(typeof res.body.retryAfter).toBe('number');
    expect(res.body.retryAfter).toBeGreaterThanOrEqual(0);
    // Retry-After header must be a non-negative integer (seconds).
    expect(res.headers['retry-after']).toMatch(/^\d+$/);

    // Exactly 30 successful audit rows exist (the 31st should NOT have written one).
    const audits = await ModerationAction.find({ adminUid: ADMIN_A_UID }).lean();
    expect(audits.length).toBe(30);
  }, 60_000);   // suspended 30 times through the full transaction path -- give this some headroom

  test('per-admin keying: admin C is not rate-limited even after admin A exhausts the bucket', async () => {
    // First: exhaust admin A's bucket. (Same as prior test's 31-request loop but condensed --
    // only care about filling the bucket here, not the 429 specifically.)
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_A_UID, email: ADMIN_A_EMAIL });
    for (let i = 0; i < 30; i++) {
      const r = await request(app)
        .post(`/api/admin/moderation/rl-target-${i}`)
        .set('Authorization', 'Bearer ok-token')
        .send({ action: 'suspend', severity: 'feature_limited', reasonCategory: 'spam' });
      expect(r.status).toBe(200);
    }

    // Sanity: admin A's next call is 429 (confirms bucket is full).
    const aBlocked = await request(app)
      .post(`/api/admin/moderation/rl-target-30`)
      .set('Authorization', 'Bearer ok-token')
      .send({ action: 'suspend', severity: 'feature_limited', reasonCategory: 'spam' });
    expect(aBlocked.status).toBe(429);

    // Now switch to admin C -- different uid, independent bucket per D-31.
    admin.__verifyIdTokenMock.mockResolvedValue({ uid: ADMIN_C_UID, email: ADMIN_C_EMAIL });

    const cRes = await request(app)
      .post(`/api/admin/moderation/rl-target-31`)
      .set('Authorization', 'Bearer ok-token')
      .send({ action: 'suspend', severity: 'feature_limited', reasonCategory: 'spam' });

    expect(cRes.status).toBe(200);
    expect(cRes.body.ok).toBe(true);
  }, 60_000);
});
