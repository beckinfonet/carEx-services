// src/notifications/__tests__/router.test.js
//
// Phase 12 — Wave 1 (12-04 Task 2). Subscription CRUD over the notification
// router (NSUB-01/03, NPRF-01/02) + NDOM-05 auth model (uid from token, NOT
// admin-gated, IDOR-safe).
//
// RED→GREEN: 12-01 shipped this as test.todo (router did not exist). 12-04 Task 2
// adds the /subscriptions endpoints and fills these behaviors.
//
// Harness mirrors src/moderation/__tests__/listingRouter.search.test.js but with
// a STUB auth middleware (sets req.auth.uid from per-test `currentUid`) instead of
// the real verifyIdToken — Task 2's contract is the uid-scoping INSIDE the router,
// and a non-admin (no requireAdmin in the chain) must succeed (NDOM-05). The stub
// also lets us PROVE that a body.uid set to another user's id is ignored.

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../../../__tests__/_helpers/mongoReplSet');

const Subscription = require('../../models/Subscription');
const notificationRouter = require('../router');

const USER_A = 'user-a-uid';
const USER_B = 'user-b-uid';
const MAKE_ID = new mongoose.Types.ObjectId().toString();
const MODEL_ID = new mongoose.Types.ObjectId().toString();

let rs;
let app;
let currentUid;

beforeAll(async () => {
  rs = await startReplSet();

  app = express();
  app.use(express.json());
  // Stub auth — a PLAIN (non-admin) authenticated user. There is NO requireAdmin
  // in this chain, proving the router is not admin-gated (NDOM-05).
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
  await Subscription.deleteMany({});
  currentUid = USER_A;
});

const savedSearchBody = (overrides = {}) => ({
  kind: 'saved_search',
  criteria: { makeId: MAKE_ID, priceMax: 20000 },
  ...overrides,
});

const watchBody = (overrides = {}) => ({
  kind: 'watch',
  carId: 'car-123',
  ...overrides,
});

describe('NDOM-05 — router is NOT admin-gated', () => {
  test('a non-admin authenticated caller can POST/GET/PATCH/DELETE their subscriptions', async () => {
    currentUid = USER_A;

    // POST
    const created = await request(app)
      .post('/api/notifications/subscriptions')
      .send(savedSearchBody());
    expect(created.status).toBe(201);
    const id = created.body._id;

    // GET
    const list = await request(app).get('/api/notifications/subscriptions');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    // PATCH
    const patched = await request(app)
      .patch(`/api/notifications/subscriptions/${id}`)
      .send({ cadence: 'daily' });
    expect(patched.status).toBe(200);
    expect(patched.body.cadence).toBe('daily');

    // DELETE
    const deleted = await request(app).delete(`/api/notifications/subscriptions/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(1);
  });
});

describe('POST /subscriptions — create (NSUB-01/03)', () => {
  test('saved_search defaults cadence to instant (NSUB-03)', async () => {
    const res = await request(app)
      .post('/api/notifications/subscriptions')
      .send(savedSearchBody()); // no cadence
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('saved_search');
    expect(res.body.cadence).toBe('instant');
    expect(res.body.uid).toBe(USER_A);
    expect(res.body.active).toBe(true);
  });

  test('watch defaults events to all four (D-03) + cadence instant', async () => {
    const res = await request(app)
      .post('/api/notifications/subscriptions')
      .send(watchBody()); // no events
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('watch');
    expect(res.body.cadence).toBe('instant');
    expect(res.body.events).toHaveLength(4);
    expect([...res.body.events].sort()).toEqual(
      ['back_available', 'booked', 'price_drop', 'sold'],
    );
  });

  test('watch honours an explicit events subset', async () => {
    const res = await request(app)
      .post('/api/notifications/subscriptions')
      .send(watchBody({ events: ['price_drop'] }));
    expect(res.status).toBe(201);
    expect(res.body.events).toEqual(['price_drop']);
  });

  test('unknown criteria key → 400 invalid_payload (.strict())', async () => {
    const res = await request(app)
      .post('/api/notifications/subscriptions')
      .send({ kind: 'saved_search', criteria: { makeName: 'Toyota' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  test('uid in the body is IGNORED — uid comes from the token (IDOR guard)', async () => {
    currentUid = USER_A;
    const res = await request(app)
      .post('/api/notifications/subscriptions')
      .send({ ...savedSearchBody(), uid: USER_B }); // attacker-supplied uid
    // Top-level uid is an unknown key under the .strict() discriminated union →
    // rejected. The sub is NEVER created under USER_B.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');

    const bSubs = await Subscription.find({ uid: USER_B }).lean();
    expect(bSubs).toHaveLength(0);
  });

  test('a created subscription is always owned by the token uid, never a body value', async () => {
    currentUid = USER_A;
    const res = await request(app)
      .post('/api/notifications/subscriptions')
      .send(savedSearchBody());
    expect(res.status).toBe(201);
    const row = await Subscription.findById(res.body._id).lean();
    expect(row.uid).toBe(USER_A);
  });
});

describe('GET /subscriptions — list own active (NPRF-01)', () => {
  test('returns only { uid, active:true } rows for the caller', async () => {
    await Subscription.create({ uid: USER_A, kind: 'watch', carId: 'c1', active: true });
    await Subscription.create({ uid: USER_A, kind: 'watch', carId: 'c2', active: false }); // inactive
    await Subscription.create({ uid: USER_B, kind: 'watch', carId: 'c3', active: true }); // other user

    currentUid = USER_A;
    const res = await request(app).get('/api/notifications/subscriptions');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].carId).toBe('c1');
    expect(res.body.items.every((s) => s.uid === USER_A && s.active === true)).toBe(true);
  });
});

describe('PATCH /subscriptions/:id — edit cadence/events (NPRF-02)', () => {
  test('edits cadence on a saved_search owned by the caller', async () => {
    const sub = await Subscription.create({
      uid: USER_A, kind: 'saved_search', criteria: { makeId: MAKE_ID }, cadence: 'instant',
    });
    currentUid = USER_A;
    const res = await request(app)
      .patch(`/api/notifications/subscriptions/${sub._id}`)
      .send({ cadence: 'daily' });
    expect(res.status).toBe(200);
    expect(res.body.cadence).toBe('daily');
  });

  test("PATCH on another user's id changes 0 rows → 400 subscription_not_found (IDOR)", async () => {
    const sub = await Subscription.create({ uid: USER_B, kind: 'watch', carId: 'c9', cadence: 'instant' });
    currentUid = USER_A; // caller A, sub belongs to B
    const res = await request(app)
      .patch(`/api/notifications/subscriptions/${sub._id}`)
      .send({ cadence: 'daily' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('subscription_not_found');

    const row = await Subscription.findById(sub._id).lean();
    expect(row.cadence).toBe('instant'); // untouched
  });

  test('empty body → 400 invalid_payload (no editable fields)', async () => {
    const sub = await Subscription.create({ uid: USER_A, kind: 'watch', carId: 'c1' });
    currentUid = USER_A;
    const res = await request(app)
      .patch(`/api/notifications/subscriptions/${sub._id}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  test('unknown edit key → 400 invalid_payload (.strict())', async () => {
    const sub = await Subscription.create({ uid: USER_A, kind: 'watch', carId: 'c1' });
    currentUid = USER_A;
    const res = await request(app)
      .patch(`/api/notifications/subscriptions/${sub._id}`)
      .send({ criteria: { makeId: MAKE_ID } }); // criteria not editable
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });
});

describe('DELETE /subscriptions/:id (NPRF-02)', () => {
  test('removes the caller\'s own subscription', async () => {
    const sub = await Subscription.create({ uid: USER_A, kind: 'watch', carId: 'c1' });
    currentUid = USER_A;
    const res = await request(app).delete(`/api/notifications/subscriptions/${sub._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(await Subscription.findById(sub._id).lean()).toBeNull();
  });

  test("DELETE on another user's id removes 0 rows → 400 subscription_not_found (IDOR)", async () => {
    const sub = await Subscription.create({ uid: USER_B, kind: 'watch', carId: 'c1' });
    currentUid = USER_A;
    const res = await request(app).delete(`/api/notifications/subscriptions/${sub._id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('subscription_not_found');
    expect(await Subscription.findById(sub._id).lean()).not.toBeNull(); // survives
  });
});
