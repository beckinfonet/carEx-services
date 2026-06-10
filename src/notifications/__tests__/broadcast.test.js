// Phase 15 — Wave 0 (RED scaffold). Broadcast new-listing notifications.
//
// VALIDATION map (15-VALIDATION.md "Per-Task Verification Map"):
//   Req 1 — "audience excludes actor": broadcast audience = token-holders, actor (seller) never in it.
//   Req 2 — "saved-search wins dedup": a saved-search-matched uid gets new_match only, not a broadcast row.
//   Req 3 — "row + push per recipient": each eligible non-capped uid → 1 Notification row + 1 fcm.send.
//   Req 4 + D-06 — "over cap suppresses push not row": at cap → row written (pushSuppressed:true), no fcm.send.
//   Req 4 / R-01 — "cap counts since bishkek boundary": cap value = user dailyCap (default 3); countDocuments
//                  filter restricted to pushSuppressed:{$ne:true} + createdAt:{$gte:<Bishkek 08:00 boundary>}.
//   Req 5 — "opt-out suppresses; legacy doc enabled": User.find pref filter uses
//           'notificationPrefs.newListingEnabled':{$ne:false} + 'notificationPrefs.muteAll':{$ne:true}.
//   Req 3/7 — "broadcast dedupeKey no collision": broadcast row dedupeKey === `${carId}:new_listing_broadcast`,
//             NOT equal to `${carId}:new_match`.
//
// These tests are RED against the current notificationService.js — `new_listing` today resolves ONLY
// matching saved-searches and NEVER queries the User/DeviceToken collections, never writes a
// `new_listing_broadcast` row, never enforces a per-user cap. 15-02..15-04 add the broadcast branch.
//
// Style: DI dependency-injection mirroring guards.test.js — fcm mocked, in-memory Notification stub,
// pure stubs for DeviceToken / User / Car / matchSavedSearches. NO live DB (no mongodb-memory-server here).

jest.mock('../push/fcm', () => ({ send: jest.fn().mockResolvedValue({ ok: true, delivered: 0 }) }));

const fcm = require('../push/fcm');
const { emit } = require('../notificationService');

const FIXED_NOW = new Date('2026-06-10T12:00:00.000Z'); // afternoon UTC ≈ 18:00 Bishkek, after the morning boundary
const CAR_ID = 'car-1';
const ACTOR = 'seller-1';

// In-memory Notification stub: findOne(dedup), create(docs)→rows, countDocuments(filter)→stubbed cap count.
function makeNotificationStub({ capCountByUid = {} } = {}) {
  const rows = [];
  return {
    rows,
    async findOne(query) {
      const { uid, dedupeKey, read } = query || {};
      return rows.find((r) => r.uid === uid && r.dedupeKey === dedupeKey && (read === undefined || r.read === read)) || null;
    },
    async create(docs) {
      const created = docs.map((d) => ({ read: false, pushSuppressed: false, ...d, _id: rows.length + 1 }));
      rows.push(...created);
      return created;
    },
    // Records every filter the broadcast cap-count uses, so the test can assert the date/pushSuppressed bounds.
    countCalls: [],
    async countDocuments(filter) {
      this.countCalls.push(filter);
      const uid = filter && filter.uid;
      return capCountByUid[uid] || 0;
    },
  };
}

// DeviceToken stub: distinct('uid') = the recipient source of truth (D-02).
function makeDeviceTokenStub(uids) {
  return {
    distinctArg: null,
    async distinct(field) {
      this.distinctArg = field;
      return uids.slice();
    },
  };
}

// User stub: find(filter).select(...).lean() chain. Records the filter + selected projection so
// the pref-allowlist + dailyCap-projection assertions can inspect them.
function makeUserStub(usersByUid) {
  const stub = {
    findFilter: null,
    selectArg: null,
    find(filter) {
      stub.findFilter = filter;
      const chain = {
        select(projection) {
          stub.selectArg = projection;
          return chain;
        },
        async lean() {
          // Apply the pref allowlist filter the implementation passes, so legacy/opted-out
          // docs are honored exactly as the query intends.
          return Object.values(usersByUid).filter((u) => matchesPrefFilter(u, filter));
        },
      };
      return chain;
    },
  };
  return stub;
}

// Evaluate the $ne pref operators the broadcast query is expected to use, against a user doc.
function matchesPrefFilter(user, filter) {
  if (!filter) return true;
  const prefs = (user && user.notificationPrefs) || {};
  const newListing = prefs.newListingEnabled;
  const muteAll = prefs.muteAll;
  // 'notificationPrefs.newListingEnabled': { $ne: false } → absent (undefined) passes; explicit false excluded.
  const nlFilter = filter['notificationPrefs.newListingEnabled'];
  if (nlFilter && '$ne' in nlFilter && newListing === nlFilter.$ne) return false;
  // 'notificationPrefs.muteAll': { $ne: true } → absent passes; explicit true excluded.
  const muteFilter = filter['notificationPrefs.muteAll'];
  if (muteFilter && '$ne' in muteFilter && muteAll === muteFilter.$ne) return false;
  return true;
}

const activeCar = {
  _id: CAR_ID,
  status: 'active',
  price: 14000,
  makeName: 'Toyota',
  modelName: 'Camry',
};

function makeCarStub() {
  return { async findById() { return activeCar; } };
}

// Build a full DI deps bundle for a new_listing broadcast emit.
function makeDeps({
  tokenUids,
  usersByUid,
  ssUids = [], // uids that matchSavedSearches produced a new_match for (dedup source)
  capCountByUid = {},
} = {}) {
  const Notification = makeNotificationStub({ capCountByUid });
  const DeviceToken = makeDeviceTokenStub(tokenUids);
  const User = makeUserStub(usersByUid);
  const Car = makeCarStub();
  // matchSavedSearches returns saved_search subs; emit writes them as new_match rows first.
  const matchSavedSearches = async () =>
    ssUids.map((uid) => ({
      _id: `sub-${uid}`,
      uid,
      kind: 'saved_search',
      active: true,
      criteria: { makeId: 'mk', modelId: 'md' },
    }));
  return { Car, Notification, DeviceToken, User, fcm, matchSavedSearches };
}

function broadcastRows(deps) {
  return deps.Notification.rows.filter((r) => r.dedupeKey === `${CAR_ID}:new_listing_broadcast`);
}

function fcmUids() {
  return fcm.send.mock.calls.map((c) => c[0] && c[0].uid);
}

beforeEach(() => {
  fcm.send.mockClear();
});

describe('Phase 15 broadcast new-listing — audience / dedup / cap / opt-out / copy', () => {
  test('audience excludes actor', async () => {
    // seller-1 HAS a token but must never be a broadcast recipient; a non-seller token-holder IS.
    const deps = makeDeps({
      tokenUids: [ACTOR, 'buyer-1'],
      usersByUid: {
        [ACTOR]: { firebaseUid: ACTOR, notificationPrefs: {} },
        'buyer-1': { firebaseUid: 'buyer-1', notificationPrefs: {} },
      },
    });
    await emit({ type: 'new_listing', carId: CAR_ID, actorUid: ACTOR, now: FIXED_NOW }, deps);

    const rows = broadcastRows(deps);
    const rowUids = rows.map((r) => r.uid);
    expect(rowUids).toContain('buyer-1');
    expect(rowUids).not.toContain(ACTOR);
    expect(fcmUids()).toContain('buyer-1');
    expect(fcmUids()).not.toContain(ACTOR);
  });

  test('saved-search wins dedup', async () => {
    // buyer-1 got a saved-search match → must get exactly ONE notification (new_match), NOT a second broadcast row.
    const deps = makeDeps({
      tokenUids: ['buyer-1', 'buyer-2'],
      usersByUid: {
        'buyer-1': { firebaseUid: 'buyer-1', notificationPrefs: {} },
        'buyer-2': { firebaseUid: 'buyer-2', notificationPrefs: {} },
      },
      ssUids: ['buyer-1'],
    });
    await emit({ type: 'new_listing', carId: CAR_ID, actorUid: ACTOR, now: FIXED_NOW }, deps);

    const buyer1Rows = deps.Notification.rows.filter((r) => r.uid === 'buyer-1');
    expect(buyer1Rows).toHaveLength(1);
    expect(buyer1Rows[0].dedupeKey).toBe(`${CAR_ID}:new_match`);
    // buyer-2 had no saved search → gets the broadcast row.
    const buyer2Broadcast = broadcastRows(deps).filter((r) => r.uid === 'buyer-2');
    expect(buyer2Broadcast).toHaveLength(1);
  });

  test('row + push per recipient', async () => {
    const deps = makeDeps({
      tokenUids: ['buyer-1'],
      usersByUid: { 'buyer-1': { firebaseUid: 'buyer-1', notificationPrefs: {} } },
    });
    await emit({ type: 'new_listing', carId: CAR_ID, actorUid: ACTOR, now: FIXED_NOW }, deps);

    const rows = broadcastRows(deps).filter((r) => r.uid === 'buyer-1');
    expect(rows).toHaveLength(1);
    const calls = fcm.send.mock.calls.filter((c) => c[0] && c[0].uid === 'buyer-1');
    expect(calls).toHaveLength(1);
    const arg = calls[0][0];
    expect(arg.titleKey).toBe('new_listing');
    expect(arg.data).toMatchObject({ deeplink: 'carex://search' });
  });

  test('over cap suppresses push not row', async () => {
    // buyer-1 is already at/over cap → broadcast ROW still created (pushSuppressed:true) but NO fcm.send.
    const deps = makeDeps({
      tokenUids: ['buyer-1'],
      usersByUid: { 'buyer-1': { firebaseUid: 'buyer-1', notificationPrefs: { dailyCap: 3 } } },
      capCountByUid: { 'buyer-1': 3 },
    });
    await emit({ type: 'new_listing', carId: CAR_ID, actorUid: ACTOR, now: FIXED_NOW }, deps);

    const rows = broadcastRows(deps).filter((r) => r.uid === 'buyer-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].pushSuppressed).toBe(true);
    expect(fcmUids()).not.toContain('buyer-1');
  });

  test('cap counts since bishkek boundary', async () => {
    // The eligible-user query selects dailyCap; the cap-count filter is restricted to
    // pushSuppressed:{$ne:true} AND createdAt:{$gte:<Bishkek 08:00 boundary>}.
    const deps = makeDeps({
      tokenUids: ['buyer-1'],
      usersByUid: { 'buyer-1': { firebaseUid: 'buyer-1', notificationPrefs: { dailyCap: 5 } } },
    });
    await emit({ type: 'new_listing', carId: CAR_ID, actorUid: ACTOR, now: FIXED_NOW }, deps);

    // dailyCap must be in the User projection.
    expect(JSON.stringify(deps.User.selectArg)).toMatch(/dailyCap/);

    // The cap countDocuments filter must bound by pushSuppressed and a createdAt boundary.
    const capFilters = deps.Notification.countCalls;
    expect(capFilters.length).toBeGreaterThan(0);
    const f = capFilters[0];
    expect(f.pushSuppressed).toEqual({ $ne: true });
    expect(f.createdAt && f.createdAt.$gte).toBeInstanceOf(Date);

    // Boundary = most-recent 08:00 Asia/Bishkek (UTC+6) on/before FIXED_NOW.
    // FIXED_NOW = 2026-06-10T12:00:00Z → Bishkek 18:00 on 2026-06-10 → boundary = 2026-06-10T02:00:00Z (08:00 +06).
    const boundary = f.createdAt.$gte;
    expect(boundary.toISOString()).toBe('2026-06-10T02:00:00.000Z');
  });

  test('opt-out suppresses; legacy doc enabled', async () => {
    // legacy-1: notificationPrefs field absent entirely → treated as ENABLED (gets a broadcast).
    // opted-out: newListingEnabled:false → excluded. muted: muteAll:true → excluded.
    const deps = makeDeps({
      tokenUids: ['legacy-1', 'opted-out', 'muted'],
      usersByUid: {
        'legacy-1': { firebaseUid: 'legacy-1' }, // no notificationPrefs at all
        'opted-out': { firebaseUid: 'opted-out', notificationPrefs: { newListingEnabled: false } },
        muted: { firebaseUid: 'muted', notificationPrefs: { muteAll: true } },
      },
    });
    await emit({ type: 'new_listing', carId: CAR_ID, actorUid: ACTOR, now: FIXED_NOW }, deps);

    // The pref filter must use the $ne operators on the two pref dot-paths.
    expect(deps.User.findFilter['notificationPrefs.newListingEnabled']).toEqual({ $ne: false });
    expect(deps.User.findFilter['notificationPrefs.muteAll']).toEqual({ $ne: true });

    const rowUids = broadcastRows(deps).map((r) => r.uid);
    expect(rowUids).toContain('legacy-1');
    expect(rowUids).not.toContain('opted-out');
    expect(rowUids).not.toContain('muted');
  });

  test('broadcast dedupeKey no collision', async () => {
    const deps = makeDeps({
      tokenUids: ['buyer-1'],
      usersByUid: { 'buyer-1': { firebaseUid: 'buyer-1', notificationPrefs: {} } },
    });
    await emit({ type: 'new_listing', carId: CAR_ID, actorUid: ACTOR, now: FIXED_NOW }, deps);

    const rows = broadcastRows(deps);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].dedupeKey).toBe(`${CAR_ID}:new_listing_broadcast`);
    expect(rows[0].dedupeKey).not.toBe(`${CAR_ID}:new_match`);
  });
});
