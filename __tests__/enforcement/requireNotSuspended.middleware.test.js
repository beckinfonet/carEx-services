// __tests__/enforcement/requireNotSuspended.middleware.test.js
//
// Phase 3 Plan 03-06 — matrix coverage for attachAuthIfPresent +
// requireNotSuspended per 03-CONTEXT D-16.
//
// Six cases (ROADMAP Criterion #1 matrix + Criterion #4 capability selectivity):
//   1. Active user + valid Bearer                              -> 200, req.callerUser populated
//   2. Active user + no Bearer + body.sellerId fallback        -> 200 + deprecation warn logged
//   3. Suspended (blocked_with_review) user + Bearer           -> 403 account_suspended w/ status + reasonCategory + note
//   4. feature_limited + capability IS in restrictedFeatures   -> 403 account_suspended
//   5. feature_limited + capability NOT in restrictedFeatures  -> 200 (capability allowed)
//   6. Bearer resolves to a non-existent firebaseUid            -> 404 user_not_found
//
// TEST ISOLATION: follows the Phase 2 pattern from
// __tests__/moderation/requireAdmin.middleware.test.js — build the Express app
// exactly once in beforeAll; never require server.js; beforeEach clears User
// collection and resets firebase-admin mock. afterEach restores console.warn
// spy (Case 2) so later cases do not inherit the jest.fn silencer.

// 1. firebase-admin mock — MUST come before any require of a module that uses
// firebase-admin (attachAuthIfPresent calls ensureInitialized()).
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
const { attachAuthIfPresent } = require('../../src/security/attachAuthIfPresent');
const { requireNotSuspended } = require('../../src/security/requireNotSuspended');

let rs;
let app;

beforeAll(async () => {
  rs = await startReplSet();
  // Any non-empty value satisfies ensureInitialized(); the real admin.auth() is mocked.
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  app = express();
  app.use(express.json());
  // Two test routes — one with create_listing capability (for feature_limited tests),
  // one with create_order (to prove unblocked capability passes).
  app.post(
    '/test-create-listing',
    attachAuthIfPresent,
    requireNotSuspended('create_listing'),
    (req, res) => res.json({ ok: true, callerUid: req.callerUser?.firebaseUid })
  );
  app.post(
    '/test-create-order',
    attachAuthIfPresent,
    requireNotSuspended('create_order'),
    (req, res) => res.json({ ok: true, callerUid: req.callerUser?.firebaseUid })
  );
});

afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await User.deleteMany({});
  admin.__verifyIdTokenMock.mockReset();
});

describe('requireNotSuspended — 6-case matrix (D-16)', () => {
  test('case 1: active user + valid Bearer -> 200, req.callerUser.firebaseUid matches', async () => {
    const uid = 'active-user-1';
    await User.create({
      firebaseUid: uid,
      email: 'a1@test.local',
      moderationStatus: { state: 'active', severity: 'none' },
    });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid, email: 'a1@test.local' });

    const res = await request(app)
      .post('/test-create-listing')
      .set('Authorization', 'Bearer ok-token')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, callerUid: uid });
  });

  test('case 2: no Bearer + body.sellerId fallback -> 200 + deprecation warning logged exactly once', async () => {
    const uid = 'active-seller-2';
    await User.create({
      firebaseUid: uid,
      email: 'a2@test.local',
      moderationStatus: { state: 'active', severity: 'none' },
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post('/test-create-listing')
        .send({ sellerId: uid });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Assert the deprecation message text (verifier grep hits this literal).
      const firstCallArgs = warnSpy.mock.calls[0];
      expect(firstCallArgs[0]).toContain('deprecated body-uid fallback used');
      expect(firstCallArgs[1]).toMatchObject({ uid });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('case 3: suspended (blocked_with_review) user + Bearer -> 403 account_suspended with full shape', async () => {
    const uid = 'suspended-user-3';
    await User.create({
      firebaseUid: uid,
      email: 's3@test.local',
      moderationStatus: {
        state: 'blocked_with_review',
        severity: 'blocked_with_review',
        reasonCategory: 'policy_violation',
        note: 'spammed listings',
        setByAdminUid: 'admin-uid',
        setAt: new Date(),
      },
    });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid, email: 's3@test.local' });

    const res = await request(app)
      .post('/test-create-listing')
      .set('Authorization', 'Bearer ok-token')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'account_suspended',
      status: 'blocked_with_review',
      reasonCategory: 'policy_violation',
      note: 'spammed listings',
    });
  });

  test('case 4: feature_limited + capability IS in restrictedFeatures -> 403 account_suspended', async () => {
    const uid = 'feature-limited-4';
    await User.create({
      firebaseUid: uid,
      email: 'fl4@test.local',
      moderationStatus: {
        state: 'feature_limited',
        severity: 'feature_limited',
        reasonCategory: 'spam',
        note: 'low-trust user',
        restrictedFeatures: ['create_listing'],
      },
    });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid, email: 'fl4@test.local' });

    const res = await request(app)
      .post('/test-create-listing')
      .set('Authorization', 'Bearer ok-token')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'account_suspended',
      status: 'feature_limited',
      reasonCategory: 'spam',
      note: 'low-trust user',
    });
  });

  test('case 5: feature_limited + capability NOT in restrictedFeatures -> 200 (capability allowed)', async () => {
    const uid = 'feature-limited-5';
    await User.create({
      firebaseUid: uid,
      email: 'fl5@test.local',
      moderationStatus: {
        state: 'feature_limited',
        severity: 'feature_limited',
        reasonCategory: 'spam',
        note: null,
        restrictedFeatures: ['create_listing'], // create_order NOT blocked
      },
    });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid, email: 'fl5@test.local' });

    const res = await request(app)
      .post('/test-create-order')
      .set('Authorization', 'Bearer ok-token')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.callerUid).toBe(uid);
  });

  test('case 6: Bearer resolves to a non-existent firebaseUid -> 404 user_not_found', async () => {
    // NOTE: no User.create for this uid — directory miss.
    const uid = 'no-such-user-6';
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid, email: 'ghost@test.local' });

    const res = await request(app)
      .post('/test-create-listing')
      .set('Authorization', 'Bearer ok-token')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'user_not_found' });
  });
});
