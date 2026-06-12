const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { notifyRequestUnlocked } = require('../../src/carRequests/notifyUnlock');

let mongo;
let User;
let Notification;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'CarEx' });
  User =
    mongoose.models.User ||
    mongoose.model('User', new mongoose.Schema({ firebaseUid: String, language: String, notificationPrefs: {} }));
  Notification = require('../../src/models/Notification');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Notification.deleteMany({});
});

const request = { _id: new mongoose.Types.ObjectId(), buyerUid: 'buyer-1', makeName: 'Toyota', modelName: 'Camry' };

it('writes a Notification row and calls push for an opted-in buyer', async () => {
  await User.create({ firebaseUid: 'buyer-1', language: 'EN' }); // no prefs => default on
  const fcm = { send: jest.fn().mockResolvedValue({ ok: true, delivered: 0 }) };

  const row = await notifyRequestUnlocked(request, { fcm });

  expect(row).not.toBeNull();
  expect(row.uid).toBe('buyer-1');
  expect(row.titleKey).toBe('request_unlock');
  expect(row.params.makeModel).toBe('Toyota Camry');
  expect(row.data.deeplink).toBe('carex://my-requests');
  expect(fcm.send).toHaveBeenCalledWith(
    expect.objectContaining({ uid: 'buyer-1', title: 'request_unlock', lang: 'EN' })
  );
  expect(await Notification.countDocuments({ uid: 'buyer-1' })).toBe(1);
});

it('suppresses when the buyer muted all notifications', async () => {
  await User.create({ firebaseUid: 'buyer-1', notificationPrefs: { muteAll: true } });
  const fcm = { send: jest.fn() };
  const row = await notifyRequestUnlocked(request, { fcm });
  expect(row).toBeNull();
  expect(fcm.send).not.toHaveBeenCalled();
  expect(await Notification.countDocuments({})).toBe(0);
});

it('suppresses when requestUnlockEnabled is explicitly false', async () => {
  await User.create({ firebaseUid: 'buyer-1', notificationPrefs: { requestUnlockEnabled: false } });
  const row = await notifyRequestUnlocked(request, { fcm: { send: jest.fn() } });
  expect(row).toBeNull();
});

it('returns null for an unknown buyer', async () => {
  const row = await notifyRequestUnlocked(request, { fcm: { send: jest.fn() } });
  expect(row).toBeNull();
});

it('still writes the row when push throws (best-effort push)', async () => {
  await User.create({ firebaseUid: 'buyer-1' });
  const fcm = { send: jest.fn().mockRejectedValue(new Error('no creds')) };
  const row = await notifyRequestUnlocked(request, { fcm });
  expect(row).not.toBeNull();
  expect(await Notification.countDocuments({ uid: 'buyer-1' })).toBe(1);
});
