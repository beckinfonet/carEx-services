// Phase 12 — Wave 1 (NDOM-03 emit guards: hide-hook suppression).
//
// VALIDATION map: NDOM-03 — suppress emit for a hidden/suspended/archived listing.
// A PLAIN Car.findById returns null (seller hidden by the pre(/^find/) hook) OR a
// non-active doc → notificationService.emit produces 0 rows (TOCTOU re-check at send
// time; T-12-03-01). emit must NEVER use the includeAllUsers / includeAllListingStatuses
// bypass flags (asserted by source grep + behavior).

// Phase 13: stub the real fcm.send (now hits DeviceToken/Mongo) for these DB-less
// unit tests; transport coverage lives in push/fcm.test.js.
jest.mock('../push/fcm', () => ({ send: jest.fn().mockResolvedValue({ ok: true, delivered: 0 }) }));

const fs = require('fs');
const path = require('path');
const { emit } = require('../notificationService');

// In-memory Notification stub (create returns array form, matching mongoose option API).
function makeNotificationStub() {
  const rows = [];
  return {
    rows,
    async findOne() { return null; },
    async create(docs) {
      const created = docs.map((d) => ({ ...d, _id: rows.length + 1 }));
      rows.push(...created);
      return created;
    },
  };
}

// A Subscription stub that WOULD return a matching watcher (to prove suppression is
// the hide-hook, not an empty target set).
function makeWatchSubStub() {
  return {
    async find() {
      return [{ _id: 'sub1', uid: 'watcher-1', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop'] }];
    },
  };
}

describe('NDOM-03 emit guards — hide-hook suppression', () => {
  test('plain Car.findById null (hidden seller) → emit produces 0 notifications', async () => {
    const Notification = makeNotificationStub();
    const Car = { async findById() { return null; } }; // hide-hook hid the car

    const result = await emit(
      { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000, newPrice: 15000 },
      { Car, Notification, Subscription: makeWatchSubStub() }
    );

    expect(result).toEqual([]);
    expect(Notification.rows).toHaveLength(0);
  });

  test('listing status !== active (suspended/archived) → emit suppressed', async () => {
    const Notification = makeNotificationStub();
    for (const status of ['suspended', 'archived', 'deleted', 'booked']) {
      const Car = { async findById() { return { _id: 'car-1', status, price: 15000 }; } };
      const result = await emit(
        { type: 'booked', carId: 'car-1', actorUid: 'seller-1' },
        { Car, Notification, Subscription: makeWatchSubStub() }
      );
      expect(result).toEqual([]);
    }
    expect(Notification.rows).toHaveLength(0);
  });

  test('active listing with a matching watcher → emit DOES write (suppression is the guard, not a dead path)', async () => {
    const Notification = makeNotificationStub();
    const Car = { async findById() { return { _id: 'car-1', status: 'active', price: 15000, makeName: 'Toyota', modelName: 'Camry' }; } };
    const Subscription = {
      async find() {
        return [{ _id: 'sub1', uid: 'watcher-1', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop'] }];
      },
    };
    const result = await emit(
      { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000, newPrice: 15000 },
      { Car, Notification, Subscription }
    );
    expect(result).toHaveLength(1);
  });

  test('emit pipeline source NEVER passes includeAllUsers / includeAllListingStatuses bypass flags', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'notificationService.js'), 'utf8');
    // Strip the documentation block comment that explains WHY the flags are forbidden,
    // then assert the code never invokes setOptions with the bypass flags.
    expect(src.includes('.setOptions(')).toBe(false);
    // The only mentions of the flag names are in the cautionary header comment; ensure
    // they never appear as a chained call argument (no `{ includeAllUsers` object literal).
    expect(/\{\s*includeAll(Users|ListingStatuses)/.test(src)).toBe(false);
  });
});

// ── Phase 15 — Wave 0 (RED until 15-04) ──────────────────────────────────────
// The broadcast (`new_listing` all-users) branch must sit AFTER the existing
// `if (!visible || visible.status !== 'active') return [];` hide-hook guard and
// reuse the hide-hook'd `visible` Car — it must NOT re-fetch with a bypass flag.
//
//   Req 6 (T-15-03 TOCTOU): a hidden / non-active car → ZERO broadcast rows + ZERO pushes.
//   Req 6 (T-15-bypass): the broadcast branch source contains the literal
//   `new_listing_broadcast` (the branch EXISTS) while the grep gate above STILL
//   matches zero bypass-flag object literals.
//
// These are RED now (no broadcast branch yet) and go GREEN after 15-04. Mirrors
// the DI stub style above (fcm mocked, in-memory Notification stub, no live DB).
describe('Phase 15 — broadcast branch honors hide-hook + grep gate stays green', () => {
  // A DeviceToken stub that WOULD yield a broadcast recipient, proving suppression
  // is the hide-hook (not an empty audience).
  function makeDeviceTokenStub() {
    return { async distinct() { return ['buyer-1']; } };
  }
  // A User stub that WOULD yield an eligible push-enabled recipient.
  function makeUserStub() {
    const chain = { select() { return chain; }, async lean() { return [{ firebaseUid: 'buyer-1', notificationPrefs: {} }]; } };
    return { find() { return chain; } };
  }

  test('hidden / non-active car → 0 broadcast rows AND 0 fcm.send (reuses visible guard, no bypass re-fetch)', async () => {
    for (const carDoc of [null, { _id: 'car-1', status: 'suspended', price: 15000 }, { _id: 'car-1', status: 'archived' }]) {
      const Notification = makeNotificationStub();
      const fcm = require('../push/fcm');
      fcm.send.mockClear();
      const Car = { async findById() { return carDoc; } };

      const result = await emit(
        { type: 'new_listing', carId: 'car-1', actorUid: 'seller-1' },
        { Car, Notification, DeviceToken: makeDeviceTokenStub(), User: makeUserStub(), matchSavedSearches: async () => [] }
      );

      const broadcastRows = Notification.rows.filter((r) => r.dedupeKey === 'car-1:new_listing_broadcast');
      expect(broadcastRows).toHaveLength(0);
      expect(result).toEqual([]);
      expect(fcm.send).not.toHaveBeenCalled();
    }
  });

  test('broadcast branch source contains the `new_listing_broadcast` literal while the bypass-flag grep gate stays green', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'notificationService.js'), 'utf8');
    // Presence: the broadcast branch exists.
    expect(src.includes('new_listing_broadcast')).toBe(true);
    // The pre-existing grep gate MUST still hold with the new branch present.
    expect(src.includes('.setOptions(')).toBe(false);
    expect(/\{\s*includeAll(Users|ListingStatuses)/.test(src)).toBe(false);
  });
});
