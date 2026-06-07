// Phase 12 — Wave 1 (NDOM-03c dedup + deeplink families).
//
// VALIDATION map:
//   NDOM-03c — dedupeKey = `${carId}:${eventType}`; at most one UNREAD alert per
//     (uid, carId, eventType). 3 rapid edits → 1 row per watcher (T-12-03-03).
//   NCEN-03 — a new_match row's data.deeplink starts with `carex://search` and carries
//     the subscription criteria; a watch-event row's deeplink starts with
//     `carex://listing/` (the two deeplink families are built distinctly at emit time).

const mongoose = require('mongoose');
const { emit } = require('../notificationService');

function makeNotificationStub() {
  const rows = [];
  return {
    rows,
    async findOne({ uid, dedupeKey, read }) {
      return rows.find((r) => r.uid === uid && r.dedupeKey === dedupeKey && r.read === read) || null;
    },
    async create(docs) {
      const created = docs.map((d) => ({ ...d, read: false, _id: rows.length + 1 }));
      rows.push(...created);
      return created;
    },
  };
}

const activeCar = { _id: 'car-1', status: 'active', price: 14000, makeName: 'Toyota', modelName: 'Camry' };
const Car = { async findById() { return activeCar; } };

describe('NDOM-03c dedup', () => {
  test('dedupeKey is set to `${carId}:${eventType}` on the written row', async () => {
    const Notification = makeNotificationStub();
    const Subscription = {
      async find() {
        return [{ _id: 'sub-w', uid: 'watcher-1', kind: 'watch', carId: 'car-1', active: true, events: ['booked'] }];
      },
    };
    await emit({ type: 'booked', carId: 'car-1', actorUid: 'seller-1' }, { Car, Notification, Subscription });
    expect(Notification.rows[0].dedupeKey).toBe('car-1:booked');
  });

  test('3 edits of the same car/event → at most 1 notification per watcher (uid,carId,eventType)', async () => {
    const Notification = makeNotificationStub();
    const Subscription = {
      async find() {
        return [{ _id: 'sub-w', uid: 'watcher-1', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop'] }];
      },
    };
    for (let i = 0; i < 3; i += 1) {
      await emit(
        { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000 - i, newPrice: 15000 - i },
        { Car, Notification, Subscription }
      );
    }
    const watcherRows = Notification.rows.filter((r) => r.uid === 'watcher-1' && r.dedupeKey === 'car-1:price_drop');
    expect(watcherRows).toHaveLength(1);
  });

  test('different eventType for the same car is NOT deduped (separate dedupeKey)', async () => {
    const Notification = makeNotificationStub();
    const Subscription = {
      async find() {
        return [{ _id: 'sub-w', uid: 'watcher-1', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop', 'booked'] }];
      },
    };
    await emit({ type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000, newPrice: 15000 }, { Car, Notification, Subscription });
    await emit({ type: 'booked', carId: 'car-1', actorUid: 'seller-1' }, { Car, Notification, Subscription });
    const keys = Notification.rows.map((r) => r.dedupeKey).sort();
    expect(keys).toEqual(['car-1:booked', 'car-1:price_drop']);
  });
});

describe('NCEN-03 deeplink families built distinctly', () => {
  test('a watch-event row deeplink starts with carex://listing/', async () => {
    const Notification = makeNotificationStub();
    const Subscription = {
      async find() {
        return [{ _id: 'sub-w', uid: 'watcher-1', kind: 'watch', carId: 'car-1', active: true, events: ['sold'] }];
      },
    };
    await emit({ type: 'sold', carId: 'car-1', actorUid: 'seller-1' }, { Car, Notification, Subscription });
    const row = Notification.rows[0];
    expect(row.data.deeplink.startsWith('carex://listing/')).toBe(true);
    expect(row.data.deeplink).toBe('carex://listing/car-1');
    expect(row.data.carId).toBe('car-1');
  });

  test('a new_match row deeplink starts with carex://search and carries subscription criteria', async () => {
    const Notification = makeNotificationStub();
    const makeId = new mongoose.Types.ObjectId();
    const modelId = new mongoose.Types.ObjectId();
    // new_listing resolves via matchSavedSearches — inject a matched saved_search sub.
    const matchedSub = {
      _id: new mongoose.Types.ObjectId(),
      uid: 'searcher-9',
      kind: 'saved_search',
      active: true,
      criteria: { makeId, modelId, priceMax: 20000, yearMin: 2015 },
    };
    const deps = {
      Car: { async findById() { return { _id: 'car-1', status: 'active', price: 14000, year: 2018, makeId, modelId }; } },
      Notification,
      matchSavedSearches: async () => [matchedSub],
    };

    const written = await emit({ type: 'new_listing', carId: 'car-1', actorUid: 'seller-1' }, deps);
    expect(written).toHaveLength(1);
    const row = written[0];
    expect(row.data.deeplink.startsWith('carex://search')).toBe(true);
    expect(row.data.deeplink.startsWith('carex://listing')).toBe(false);
    // criteria round-trips into the query string.
    expect(row.data.deeplink).toContain(`makeId=${makeId.toString()}`);
    expect(row.data.deeplink).toContain(`modelId=${modelId.toString()}`);
    expect(row.data.deeplink).toContain('priceMax=20000');
    expect(row.data.deeplink).toContain('yearMin=2015');
    expect(row.data.searchId).toBe(matchedSub._id.toString());
    expect(row.dedupeKey).toBe('car-1:new_match');
  });
});
