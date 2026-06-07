// src/notifications/__tests__/feedCursor.test.js
//
// Phase 12 — Wave 1 (12-04 Task 1). NCEN-02 cursor pagination + NCEN-04
// read-state + NDOM-05 uid-scoping for the GET / feed.
//
// RED→GREEN: 12-01 shipped this as test.todo (router did not exist). 12-04 Task 1
// builds src/notifications/router.js and fills these behaviors.
//
// Harness mirrors src/moderation/__tests__/listingRouter.search.test.js:
//   - The router is mounted behind a STUB auth middleware that sets req.auth.uid.
//     We don't exercise verifyIdToken here (firebase-admin) because Task 1's
//     contract is "every query is uid-scoped from req.auth.uid"; the stub lets us
//     flip the caller uid per-request to prove IDOR isolation.
//   - MongoMemoryReplSet (shared fixture) backs the .lean() reads.
//   - Notifications seeded via Notification.collection.insertOne() so we control
//     createdAt + _id ordering deterministically.

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../../../__tests__/_helpers/mongoReplSet');

const Notification = require('../../models/Notification');
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
  // Stub auth — attaches req.auth.uid from the per-test `currentUid`. The real
  // verifyIdToken is mounted in 12-05; Task 1's contract is the uid-scoping
  // INSIDE the router, which this stub lets us drive directly.
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
  await Notification.deleteMany({});
  currentUid = USER_A;
});

// Direct-insert a notification with controlled createdAt for deterministic order.
async function seedNotification(uid, overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  const now = overrides.createdAt || new Date();
  await Notification.collection.insertOne({
    _id,
    uid,
    kind: 'new_match',
    titleKey: 'notif.new_match.title',
    bodyKey: 'notif.new_match.body',
    params: {},
    data: { deeplink: null, carId: null, searchId: null },
    read: overrides.read ?? false,
    channels: ['in_app'],
    digestPending: false,
    dedupeKey: null,
    createdAt: now,
    ...overrides,
  });
  return { id: _id.toString(), createdAt: now };
}

// Seed N notifications for a uid in ASCENDING createdAt; returns the ids in
// ASCENDING order (the feed returns them DESCENDING).
async function seedMany(uid, n, baseTime = new Date(2024, 0, 1)) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(baseTime.getTime() + i * 1000);
    const seeded = await seedNotification(uid, { createdAt });
    ids.push(seeded.id);
  }
  return ids;
}

describe('NCEN-02 feed cursor pagination', () => {
  test('first page returns 25 items (default limit) + a base64 nextCursor when more rows exist', async () => {
    await seedMany(USER_A, 30);
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(25);
    expect(res.body.nextCursor).not.toBeNull();
    expect(typeof res.body.nextCursor).toBe('string');
    // nextCursor is valid base64 JSON with createdAt + _id.
    const decoded = JSON.parse(Buffer.from(res.body.nextCursor, 'base64').toString('utf8'));
    expect(decoded).toHaveProperty('createdAt');
    expect(decoded).toHaveProperty('_id');
  });

  test('items come back reverse-chronological (createdAt DESC)', async () => {
    const ascIds = await seedMany(USER_A, 5);
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(200);
    const returnedIds = res.body.items.map((n) => n._id);
    // Newest-first == reverse of insertion (ascending) order.
    expect(returnedIds).toEqual([...ascIds].reverse());
  });

  test('second page (with cursor) continues with no overlap and no skip', async () => {
    const ascIds = await seedMany(USER_A, 30);
    const expectedDesc = [...ascIds].reverse(); // full feed, newest-first

    const p1 = await request(app).get('/api/notifications?limit=10');
    expect(p1.body.items).toHaveLength(10);
    const p1Ids = p1.body.items.map((n) => n._id);
    expect(p1Ids).toEqual(expectedDesc.slice(0, 10));

    const p2 = await request(app).get(
      `/api/notifications?limit=10&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
    );
    expect(p2.body.items).toHaveLength(10);
    const p2Ids = p2.body.items.map((n) => n._id);
    expect(p2Ids).toEqual(expectedDesc.slice(10, 20));

    // No overlap between pages.
    const overlap = p1Ids.filter((id) => p2Ids.includes(id));
    expect(overlap).toHaveLength(0);
  });

  test('cursor stays stable across an inserted (newer) row — no skip/overlap', async () => {
    const base = new Date(2024, 0, 1);
    const ascIds = await seedMany(USER_A, 30, base);
    const expectedDesc = [...ascIds].reverse();

    const p1 = await request(app).get('/api/notifications?limit=10');
    const p1Ids = p1.body.items.map((n) => n._id);

    // Insert a BRAND-NEW row (newer than everything) between page reads. Because
    // the cursor encodes {createdAt,_id}, page 2 continues strictly after the
    // page-1 boundary and the new row (which sorts at the very top) is NOT
    // pulled into page 2 — no skip of the original page-2 rows, no overlap.
    await seedNotification(USER_A, { createdAt: new Date(base.getTime() + 999999) });

    const p2 = await request(app).get(
      `/api/notifications?limit=10&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
    );
    const p2Ids = p2.body.items.map((n) => n._id);
    expect(p2Ids).toEqual(expectedDesc.slice(10, 20));
    expect(p1Ids.filter((id) => p2Ids.includes(id))).toHaveLength(0);
  });

  test('last page returns nextCursor: null when no more rows', async () => {
    await seedMany(USER_A, 5);
    const res = await request(app).get('/api/notifications?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.nextCursor).toBeNull();
  });

  test('limit is clamped to 100 max (DoS guard T-12-04-04)', async () => {
    await seedMany(USER_A, 30);
    const res = await request(app).get('/api/notifications?limit=9999');
    expect(res.status).toBe(200);
    // Only 30 rows exist; clamp doesn't change that, but the query must not throw.
    expect(res.body.items).toHaveLength(30);
    expect(res.body.nextCursor).toBeNull();
  });

  test('malformed/undecodable cursor → 400 invalid_cursor', async () => {
    await seedMany(USER_A, 3);
    const res = await request(app).get('/api/notifications?cursor=not-valid-base64-json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cursor');
  });
});

describe('NDOM-05 feed uid-scoping (IDOR isolation)', () => {
  test("a second user's notifications never appear in the first user's feed", async () => {
    const aIds = await seedMany(USER_A, 5, new Date(2024, 0, 1));
    await seedMany(USER_B, 5, new Date(2024, 5, 1)); // newer, but USER_B's

    currentUid = USER_A;
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    const returnedIds = res.body.items.map((n) => n._id);
    // Exactly USER_A's rows — none of USER_B's, even though they are newer.
    expect(new Set(returnedIds)).toEqual(new Set(aIds));
    expect(res.body.items.every((n) => n.uid === USER_A)).toBe(true);
  });
});

describe('NCEN-03 unread-count', () => {
  test('returns the count of { uid, read:false } for the caller only', async () => {
    await seedNotification(USER_A, { read: false });
    await seedNotification(USER_A, { read: false });
    await seedNotification(USER_A, { read: true });
    await seedNotification(USER_B, { read: false }); // other user — excluded

    currentUid = USER_A;
    const res = await request(app).get('/api/notifications/unread-count');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe('NCEN-04 read-state endpoints', () => {
  test('PATCH /:id/read flips read on a row owned by the caller', async () => {
    const { id } = await seedNotification(USER_A, { read: false });
    currentUid = USER_A;
    const res = await request(app).patch(`/api/notifications/${id}/read`);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const row = await Notification.findById(id).lean();
    expect(row.read).toBe(true);
  });

  test('PATCH /:id/read on another user\'s id changes 0 rows (IDOR guard)', async () => {
    const { id } = await seedNotification(USER_B, { read: false });
    currentUid = USER_A; // caller is A, target row belongs to B
    const res = await request(app).patch(`/api/notifications/${id}/read`);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);

    const row = await Notification.findById(id).lean();
    expect(row.read).toBe(false); // untouched
  });

  test('PATCH /read-all marks all of the caller\'s unread rows read (and no one else\'s)', async () => {
    await seedNotification(USER_A, { read: false });
    await seedNotification(USER_A, { read: false });
    await seedNotification(USER_A, { read: true });
    const { id: bId } = await seedNotification(USER_B, { read: false });

    currentUid = USER_A;
    const res = await request(app).patch('/api/notifications/read-all');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const aUnread = await Notification.countDocuments({ uid: USER_A, read: false });
    expect(aUnread).toBe(0);
    // USER_B's row is untouched.
    const bRow = await Notification.findById(bId).lean();
    expect(bRow.read).toBe(false);
  });
});
