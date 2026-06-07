// Phase 12 — Wave 1 (NDOM-03b actor-exclusion).
//
// VALIDATION map: NDOM-03b — the actor who caused an event is never notified about
// it (seller editing their own price gets 0 self-notifications; T-12-03-02). Other
// watchers (uid !== actorUid) still receive the notification.

// Phase 13: stub the real fcm.send (now hits DeviceToken/Mongo) for these DB-less
// unit tests; transport coverage lives in push/fcm.test.js.
jest.mock('../push/fcm', () => ({ send: jest.fn().mockResolvedValue({ ok: true, delivered: 0 }) }));

const { emit } = require('../notificationService');

function makeNotificationStub() {
  const rows = [];
  return {
    rows,
    async findOne({ uid, dedupeKey }) {
      return rows.find((r) => r.uid === uid && r.dedupeKey === dedupeKey && r.read === false) || null;
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

describe('NDOM-03b actor-exclusion', () => {
  test('subscription.uid === event.actorUid is dropped (seller self-edit → 0 self-notifs)', async () => {
    const Notification = makeNotificationStub();
    // The seller (seller-1) is ALSO a watcher of their own car.
    const Subscription = {
      async find() {
        return [{ _id: 'sub-self', uid: 'seller-1', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop'] }];
      },
    };

    // Seller edits their own price 3 times.
    for (let i = 0; i < 3; i += 1) {
      await emit(
        { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000 - i, newPrice: 15000 - i },
        { Car, Notification, Subscription }
      );
    }

    const selfNotifs = Notification.rows.filter((r) => r.uid === 'seller-1');
    expect(selfNotifs).toHaveLength(0);
  });

  test('other watchers (uid !== actorUid) still receive the notification', async () => {
    const Notification = makeNotificationStub();
    const Subscription = {
      async find() {
        return [
          { _id: 'sub-self', uid: 'seller-1', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop'] },
          { _id: 'sub-watcher', uid: 'watcher-2', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop'] },
        ];
      },
    };

    const written = await emit(
      { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000, newPrice: 15000 },
      { Car, Notification, Subscription }
    );

    expect(written).toHaveLength(1);
    expect(written[0].uid).toBe('watcher-2');
    expect(Notification.rows.some((r) => r.uid === 'seller-1')).toBe(false);
  });
});
