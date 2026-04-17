const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let User;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  User = require('../../src/models/User');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('User.moderationStatus (DATA-01)', () => {
  test('defaults state to "active" on new user', () => {
    const u = new User({ firebaseUid: 'u1', email: 'u1@test.local' });
    expect(u.moderationStatus.state).toBe('active');
    expect(u.moderationStatus.severity).toBe('none');
    expect(u.moderationStatus.reasonCategory).toBeNull();
    expect(u.moderationStatus.note).toBeNull();
    expect(u.moderationStatus.setByAdminUid).toBeNull();
    expect(u.moderationStatus.setAt).toBeNull();
    expect(u.moderationStatus.restrictedFeatures).toEqual([]);
    expect(u.moderationStatus.lastActionId).toBeNull();
  });

  test('state enum rejects invalid value', async () => {
    const u = new User({ firebaseUid: 'u2', email: 'u2@test.local', moderationStatus: { state: 'banned' } });
    await expect(u.validate()).rejects.toThrow(/state/);
  });

  test('state enum accepts all four severity states', async () => {
    for (const s of ['active', 'feature_limited', 'blocked_with_review', 'permanently_banned']) {
      const u = new User({ firebaseUid: `u-${s}`, email: `${s}@test.local`, moderationStatus: { state: s } });
      await expect(u.validate()).resolves.toBeUndefined();
    }
  });

  test('reasonCategory enum rejects invalid value', async () => {
    const u = new User({ firebaseUid: 'u3', email: 'u3@test.local', moderationStatus: { reasonCategory: 'invalid_reason' } });
    await expect(u.validate()).rejects.toThrow(/reasonCategory/);
  });

  test('note rejects strings over 2000 chars', async () => {
    const u = new User({ firebaseUid: 'u4', email: 'u4@test.local', moderationStatus: { note: 'x'.repeat(2001) } });
    await expect(u.validate()).rejects.toThrow(/note/);
  });

  test('lastActionId accepts an ObjectId ref', async () => {
    const oid = new mongoose.Types.ObjectId();
    const u = new User({ firebaseUid: 'u5', email: 'u5@test.local', moderationStatus: { lastActionId: oid } });
    await expect(u.validate()).resolves.toBeUndefined();
    expect(u.moderationStatus.lastActionId.toString()).toBe(oid.toString());
  });
});
