// src/notifications/__tests__/deviceTokens.test.js
//
// Phase 13 — Wave 0 (13-02 Task 3, NPUSH-04 backend half).
//
// Device-token register/unregister routes on the notification router. The uid is
// ALWAYS derived from the verified Bearer (req.auth.uid), NEVER from the body or
// params (V4 IDOR). Harness mirrors router.test.js: a STUB auth middleware sets
// req.auth.uid from per-test `currentUid` so we can prove a body-supplied uid is
// ignored and that another user's token deletes 0 rows.

const express = require('express');
const request = require('supertest');
const { startReplSet, stopReplSet } = require('../../../__tests__/_helpers/mongoReplSet');

const DeviceToken = require('../../models/DeviceToken');
const notificationRouter = require('../router');

const USER_A = 'user-a-uid';
const USER_B = 'user-b-uid';

let rs;
let app;
let currentUid;

beforeAll(async () => {
  rs = await startReplSet();
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { uid: currentUid, email: `${currentUid}@test.local` };
    next();
  });
  app.use('/api/notifications', notificationRouter);
});

afterAll(async () => {
  await stopReplSet(rs);
});

beforeEach(async () => {
  await DeviceToken.deleteMany({});
  currentUid = USER_A;
});

describe('POST /device-tokens — register (NPUSH-04, IDOR-safe)', () => {
  test('upserts a DeviceToken with uid = req.auth.uid', async () => {
    currentUid = USER_A;
    const res = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'tok-1', platform: 'ios', appVersion: '1.2.3' });
    expect(res.status).toBe(201);

    const row = await DeviceToken.findOne({ token: 'tok-1' }).lean();
    expect(row).not.toBeNull();
    expect(row.uid).toBe(USER_A);
    expect(row.platform).toBe('ios');
    expect(row.appVersion).toBe('1.2.3');
  });

  test('a body-supplied uid never takes effect — rejected by .strict(), 0 rows under USER_B (IDOR)', async () => {
    // The schema is .strict(): an attacker-supplied top-level `uid` is an unknown
    // key and the request is rejected outright (mirrors the subscription IDOR
    // guard). Either way, uid can ONLY ever come from the verified Bearer — a row
    // is NEVER created under another user's uid.
    currentUid = USER_A;
    const res = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'tok-2', platform: 'android', uid: USER_B }); // attacker-supplied uid
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');

    const bRows = await DeviceToken.find({ uid: USER_B }).lean();
    expect(bRows).toHaveLength(0);
  });

  test('a clean register always stamps uid from the token, never a body value', async () => {
    currentUid = USER_A;
    const res = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'tok-2b', platform: 'android' });
    expect(res.status).toBe(201);
    const row = await DeviceToken.findOne({ token: 'tok-2b' }).lean();
    expect(row.uid).toBe(USER_A);
  });

  test('re-POSTing the same token upserts (no duplicate; unique token honored)', async () => {
    currentUid = USER_A;
    await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'tok-dup', platform: 'ios', appVersion: '1.0.0' });
    const second = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'tok-dup', platform: 'ios', appVersion: '2.0.0' });
    expect(second.status).toBe(201);

    const rows = await DeviceToken.find({ token: 'tok-dup' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].appVersion).toBe('2.0.0'); // updated, not duplicated
  });

  test('a token registered by user A re-registered by user B reassigns to B (unique token, upsert)', async () => {
    currentUid = USER_A;
    await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'shared-device', platform: 'ios' });

    currentUid = USER_B; // same physical device, new login
    const res = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'shared-device', platform: 'ios' });
    expect(res.status).toBe(201);

    const rows = await DeviceToken.find({ token: 'shared-device' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].uid).toBe(USER_B);
  });

  test('invalid platform → 400 invalid_payload', async () => {
    const res = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'tok-x', platform: 'windows' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  test('missing token → 400 invalid_payload', async () => {
    const res = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ platform: 'ios' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  test('unknown extra key → 400 invalid_payload (.strict())', async () => {
    const res = await request(app)
      .post('/api/notifications/device-tokens')
      .send({ token: 'tok-y', platform: 'ios', sneaky: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });
});

describe('DELETE /device-tokens — unregister (NPUSH-04, IDOR-safe)', () => {
  test('removes ONLY rows matching { uid: req.auth.uid, token }', async () => {
    await DeviceToken.create({ uid: USER_A, token: 'a-tok', platform: 'ios' });
    currentUid = USER_A;

    const res = await request(app)
      .delete('/api/notifications/device-tokens/a-tok');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(await DeviceToken.findOne({ token: 'a-tok' }).lean()).toBeNull();
  });

  test("another user's token deletes 0 rows (IDOR-safe)", async () => {
    await DeviceToken.create({ uid: USER_B, token: 'b-tok', platform: 'android' });
    currentUid = USER_A; // caller A trying to delete B's token

    const res = await request(app)
      .delete('/api/notifications/device-tokens/b-tok');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
    // B's token survives.
    expect(await DeviceToken.findOne({ token: 'b-tok' }).lean()).not.toBeNull();
  });

  test('deleting a non-existent token is idempotent (0 rows, no error)', async () => {
    currentUid = USER_A;
    const res = await request(app)
      .delete('/api/notifications/device-tokens/ghost-tok');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
  });
});
