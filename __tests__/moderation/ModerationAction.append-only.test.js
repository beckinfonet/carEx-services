const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('ModerationAction — append-only', () => {
  let ModerationAction;
  let seedId;

  beforeAll(async () => {
    ModerationAction = require('../../src/models/ModerationAction');
    const doc = await ModerationAction.create({
      targetUid: 't1',
      adminUid: 'a1',
      adminEmail: 'a1@test.local',
      action: 'suspend',
      severity: 'feature_limited',
      reasonCategory: 'spam',
      note: 'initial',
    });
    seedId = doc._id;
  });

  test('updateOne throws', async () => {
    await expect(
      ModerationAction.updateOne({ _id: seedId }, { note: 'tampered' })
    ).rejects.toThrow('ModerationAction is append-only');
  });

  test('findOneAndUpdate throws', async () => {
    await expect(
      ModerationAction.findOneAndUpdate({ _id: seedId }, { note: 'tampered' })
    ).rejects.toThrow('ModerationAction is append-only');
  });

  test('deleteOne throws', async () => {
    await expect(
      ModerationAction.deleteOne({ _id: seedId })
    ).rejects.toThrow('ModerationAction is append-only');
  });

  test('findOneAndDelete throws', async () => {
    await expect(
      ModerationAction.findOneAndDelete({ _id: seedId })
    ).rejects.toThrow('ModerationAction is append-only');
  });
});
