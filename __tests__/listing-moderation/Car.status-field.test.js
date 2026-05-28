const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let Car;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Car = require('../../src/models/Car');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('Car.status (LDATA-01 + D-07 + D-08)', () => {
  test('defaults status to "active" on new car', () => {
    const c = new Car({ sellerId: 'seller-1' });
    expect(c.status).toBe('active');
    expect(c.moderationReason).toBeNull();
    expect(c.moderationNote).toBeNull();
    expect(c.moderatedBy).toBeNull();
    expect(c.moderatedAt).toBeNull();
    expect(c.lastEditedBy).toBeNull();
    expect(c.lastEditedAt).toBeNull();
  });

  test('status enum accepts the four moderation states', async () => {
    for (const s of ['active', 'suspended', 'archived', 'deleted']) {
      const c = new Car({ sellerId: `seller-${s}`, status: s });
      await expect(c.validate()).resolves.toBeUndefined();
    }
  });

  test('status enum rejects invalid value', async () => {
    const c = new Car({ sellerId: 'seller-1', status: 'banned' });
    await expect(c.validate()).rejects.toThrow(/status/);
  });

  test('moderationReason enum accepts all five values incl. inactive_seller (D-14a)', async () => {
    for (const r of ['spam', 'policy_violation', 'fraud', 'inactive_seller', 'other']) {
      const c = new Car({ sellerId: `seller-${r}`, moderationReason: r });
      await expect(c.validate()).resolves.toBeUndefined();
    }
  });

  test('moderationReason enum rejects invalid value', async () => {
    const c = new Car({ sellerId: 'seller-1', moderationReason: 'flagged' });
    await expect(c.validate()).rejects.toThrow(/moderationReason/);
  });

  test('moderationNote rejects strings over 2000 chars', async () => {
    const c = new Car({ sellerId: 'seller-1', moderationNote: 'x'.repeat(2001) });
    await expect(c.validate()).rejects.toThrow(/moderationNote/);
  });

  test('D-08 lock: listingStatus (lifecycle) and status (moderation) are distinct with disjoint enums except for shared default', () => {
    const listingStatusEnum = Car.schema.path('listingStatus').enumValues;
    const statusEnum = Car.schema.path('status').enumValues;

    // listingStatus is exactly the lifecycle enum
    expect(new Set(listingStatusEnum)).toEqual(new Set(['active', 'booked', 'sold']));

    // status is exactly the moderation enum
    expect(new Set(statusEnum)).toEqual(new Set(['active', 'suspended', 'archived', 'deleted']));

    // The overlap is exactly ['active'] — the intentional shared default per D-08
    const overlap = listingStatusEnum.filter((v) => statusEnum.includes(v));
    expect(overlap).toEqual(['active']);
  });
});
