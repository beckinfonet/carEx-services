// Phase 12 — Wave 1 (NSUB-04 price-drop direction check).
//
// VALIDATION map: NSUB-04 — price_drop is emitted ONLY when newPrice < oldPrice.
// A price increase or unchanged price emits nothing.

// Phase 13: stub the real fcm.send (now hits DeviceToken/Mongo) for these DB-less
// unit tests; transport coverage lives in push/fcm.test.js.
jest.mock('../push/fcm', () => ({ send: jest.fn().mockResolvedValue({ ok: true, delivered: 0 }) }));

const { emit } = require('../notificationService');

function makeNotificationStub() {
  const rows = [];
  return {
    rows,
    async findOne() { return null; },
    async create(docs) {
      const created = docs.map((d) => ({ ...d, read: false, _id: rows.length + 1 }));
      rows.push(...created);
      return created;
    },
  };
}

const activeCar = { _id: 'car-1', status: 'active', price: 15000, makeName: 'Toyota', modelName: 'Camry' };
const Car = { async findById() { return activeCar; } };
const Subscription = {
  async find() {
    return [{ _id: 'sub-w', uid: 'watcher-1', kind: 'watch', carId: 'car-1', active: true, events: ['price_drop'] }];
  },
};

describe('NSUB-04 price-drop direction', () => {
  test('newPrice < oldPrice → price_drop emitted to watchers', async () => {
    const Notification = makeNotificationStub();
    const written = await emit(
      { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000, newPrice: 15000 },
      { Car, Notification, Subscription }
    );
    expect(written).toHaveLength(1);
    expect(written[0].uid).toBe('watcher-1');
  });

  test('newPrice > oldPrice → no notification', async () => {
    const Notification = makeNotificationStub();
    const written = await emit(
      { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 15000, newPrice: 20000 },
      { Car, Notification, Subscription }
    );
    expect(written).toEqual([]);
    expect(Notification.rows).toHaveLength(0);
  });

  test('newPrice === oldPrice → no notification', async () => {
    const Notification = makeNotificationStub();
    const written = await emit(
      { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 15000, newPrice: 15000 },
      { Car, Notification, Subscription }
    );
    expect(written).toEqual([]);
    expect(Notification.rows).toHaveLength(0);
  });

  test('price_drop emit body params carry oldPrice/newPrice for KGS-som rendering', async () => {
    const Notification = makeNotificationStub();
    await emit(
      { type: 'price_drop', carId: 'car-1', actorUid: 'seller-1', oldPrice: 20000, newPrice: 15000 },
      { Car, Notification, Subscription }
    );
    expect(Notification.rows[0].params.oldPrice).toBe(20000);
    expect(Notification.rows[0].params.newPrice).toBe(15000);
  });
});
