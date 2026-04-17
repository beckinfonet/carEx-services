// __tests__/moderation/editProfile.test.js
//
// Plan 02-05 — service.editProfile() integration tests.
// Covers ADMIN-05, D-03..D-07 per .planning/phases/02-admin-moderation-endpoints-backend/02-CONTEXT.md.
//
// Whitelist (D-03):
//   broker:    companyName, phoneNumber, telegramUsername
//   logistics: same + coverageAreas, timelines
// Anything else → invalid_field (D-05). No-op submit → no_changes (D-06).
// Target must have role APPROVED (D-07).
// fieldDiff stored per-field before/after, changed-only (D-04).
//
// Same canonical-model registration dance as deleteProviderProfile.test.js — service.js
// resolves Broker / LogisticsPartner via mongoose.model('Broker') / ('LogisticsPartner').

const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');

if (!mongoose.models.Broker) {
  mongoose.model('Broker', new mongoose.Schema({}, { strict: false, collection: 'brokers' }));
}
if (!mongoose.models.LogisticsPartner) {
  mongoose.model('LogisticsPartner', new mongoose.Schema({}, { strict: false, collection: 'logistics_partners' }));
}
const Broker = mongoose.model('Broker');
const LogisticsPartner = mongoose.model('LogisticsPartner');

const service = require('../../src/moderation/service');
const User = require('../../src/models/User');
const AdminUser = require('../../src/models/AdminUser');
const ModerationAction = require('../../src/models/ModerationAction');

let rs;
beforeAll(async () => { rs = await startReplSet(); });
afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await User.deleteMany({});
  await AdminUser.deleteMany({});
  try { await ModerationAction.collection.drop(); } catch (_) { /* may not exist yet */ }
  try { await Broker.collection.drop(); } catch (_) { /* idem */ }
  try { await LogisticsPartner.collection.drop(); } catch (_) { /* idem */ }
});

async function seedActor() {
  await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
  await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
}

describe('service.editProfile (ADMIN-05, D-03..D-07)', () => {
  test('broker single-field change: fieldDiff has one entry, Broker updated, others untouched', async () => {
    await seedActor();
    await User.create({ firebaseUid: 'b-1', email: 'b@test.local', brokerStatus: 'APPROVED' });
    await Broker.collection.insertOne({
      ownerUid: 'b-1', companyName: 'Old', phoneNumber: '+111', telegramUsername: 'old_handle',
      description: 'untouched', status: 'active', createdAt: new Date(),
    });

    const result = await service.editProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'b-1', role: 'broker',
      fields: { companyName: 'New' },
    });

    expect(result.ok).toBe(true);
    expect(result.fieldDiff).toEqual({ companyName: { before: 'Old', after: 'New' } });

    const updatedBroker = await Broker.findOne({ ownerUid: 'b-1' }).lean();
    expect(updatedBroker.companyName).toBe('New');
    expect(updatedBroker.phoneNumber).toBe('+111');             // untouched (not in submission)
    expect(updatedBroker.telegramUsername).toBe('old_handle');  // untouched
    expect(updatedBroker.description).toBe('untouched');        // untouched (whitelist excludes)

    const audit = await ModerationAction.findOne({ targetUid: 'b-1' }).lean();
    expect(audit.action).toBe('edit_profile');
    expect(audit.roleAffected).toBe('broker');
    expect(audit.severity).toBe('none');
    expect(audit.fieldDiff.companyName).toEqual({ before: 'Old', after: 'New' });
  });

  test('broker multi-field change: fieldDiff has all 3 entries', async () => {
    await seedActor();
    await User.create({ firebaseUid: 'b-2', email: 'b2@test.local', brokerStatus: 'APPROVED' });
    await Broker.collection.insertOne({
      ownerUid: 'b-2', companyName: 'A', phoneNumber: '+1', telegramUsername: 'a',
      createdAt: new Date(),
    });

    const result = await service.editProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'b-2', role: 'broker',
      fields: { companyName: 'B', phoneNumber: '+2', telegramUsername: 'b' },
    });

    expect(Object.keys(result.fieldDiff).sort()).toEqual(['companyName', 'phoneNumber', 'telegramUsername']);
    expect(result.fieldDiff.companyName).toEqual({ before: 'A', after: 'B' });
    expect(result.fieldDiff.phoneNumber).toEqual({ before: '+1', after: '+2' });
    expect(result.fieldDiff.telegramUsername).toEqual({ before: 'a', after: 'b' });

    const updated = await Broker.findOne({ ownerUid: 'b-2' }).lean();
    expect(updated.companyName).toBe('B');
    expect(updated.phoneNumber).toBe('+2');
    expect(updated.telegramUsername).toBe('b');
  });

  test('logistics: coverageAreas array diff', async () => {
    await seedActor();
    await User.create({ firebaseUid: 'l-1', email: 'l@test.local', logisticsStatus: 'APPROVED' });
    await LogisticsPartner.collection.insertOne({
      ownerUid: 'l-1', companyName: 'FastShip', coverageAreas: ['MSK'],
      timelines: '1 day', createdAt: new Date(),
    });

    const result = await service.editProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'l-1', role: 'logistics',
      fields: { coverageAreas: ['MSK', 'SPB'], timelines: '1-3 days' },
    });

    expect(result.fieldDiff.coverageAreas.before).toEqual(['MSK']);
    expect(result.fieldDiff.coverageAreas.after).toEqual(['MSK', 'SPB']);
    expect(result.fieldDiff.timelines).toEqual({ before: '1 day', after: '1-3 days' });

    const updated = await LogisticsPartner.findOne({ ownerUid: 'l-1' }).lean();
    expect(updated.coverageAreas).toEqual(['MSK', 'SPB']);
    expect(updated.timelines).toBe('1-3 days');
  });

  test('no_changes: all submitted fields match current values → 400 no_changes, no audit row', async () => {
    await seedActor();
    await User.create({ firebaseUid: 'b-3', email: 'b3@test.local', brokerStatus: 'APPROVED' });
    await Broker.collection.insertOne({
      ownerUid: 'b-3', companyName: 'Acme', phoneNumber: '+1', createdAt: new Date(),
    });

    await expect(service.editProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'b-3', role: 'broker',
      fields: { companyName: 'Acme', phoneNumber: '+1' },
    })).rejects.toThrow('no_changes');

    // No audit row must exist — no_changes is thrown BEFORE the txn opens.
    const audits = await ModerationAction.find({ targetUid: 'b-3' }).lean();
    expect(audits.length).toBe(0);

    // Broker doc untouched.
    const b = await Broker.findOne({ ownerUid: 'b-3' }).lean();
    expect(b.companyName).toBe('Acme');
    expect(b.phoneNumber).toBe('+1');
  });

  test('invalid_field: service defensive check (description not in whitelist)', async () => {
    await seedActor();
    await User.create({ firebaseUid: 'b-4', email: 'b4@test.local', brokerStatus: 'APPROVED' });
    await Broker.collection.insertOne({
      ownerUid: 'b-4', companyName: 'X', createdAt: new Date(),
    });

    let caught;
    try {
      await service.editProfile({
        adminUid: 'admin-uid', adminEmail: 'admin@test.local',
        targetUid: 'b-4', role: 'broker',
        fields: { description: 'hacker content' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toBe('invalid_field');
    expect(caught.fields).toEqual(['description']);

    // No audit row, no Broker mutation.
    const audits = await ModerationAction.find({ targetUid: 'b-4' }).lean();
    expect(audits.length).toBe(0);
    const b = await Broker.findOne({ ownerUid: 'b-4' }).lean();
    expect(b.companyName).toBe('X');
    expect(b.description).toBeUndefined();
  });

  test('role_not_assigned: brokerStatus=NONE → 400 role_not_assigned', async () => {
    await seedActor();
    await User.create({ firebaseUid: 'b-5', email: 'b5@test.local', brokerStatus: 'NONE' });

    await expect(service.editProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'b-5', role: 'broker',
      fields: { companyName: 'X' },
    })).rejects.toThrow('role_not_assigned');

    const audits = await ModerationAction.find({ targetUid: 'b-5' }).lean();
    expect(audits.length).toBe(0);
  });

  test('provider_profile_not_found: brokerStatus=APPROVED but no Broker doc', async () => {
    await seedActor();
    await User.create({ firebaseUid: 'b-6', email: 'b6@test.local', brokerStatus: 'APPROVED' });

    await expect(service.editProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'b-6', role: 'broker',
      fields: { companyName: 'X' },
    })).rejects.toThrow('provider_profile_not_found');
  });

  test('moderationStatus untouched by edit-profile (D-12 orthogonality carry-through)', async () => {
    await seedActor();
    await User.create({
      firebaseUid: 'b-7', email: 'b7@test.local', brokerStatus: 'APPROVED',
      moderationStatus: {
        state: 'feature_limited', severity: 'feature_limited', reasonCategory: 'spam',
        setByAdminUid: 'prev-admin', setAt: new Date(),
        restrictedFeatures: ['create_listing'],
      },
    });
    await Broker.collection.insertOne({
      ownerUid: 'b-7', companyName: 'Y', createdAt: new Date(),
    });

    await service.editProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'b-7', role: 'broker',
      fields: { companyName: 'Z' },
    });

    const u = await User.findOne({ firebaseUid: 'b-7' }).lean();
    expect(u.moderationStatus.state).toBe('feature_limited');
    expect(u.moderationStatus.severity).toBe('feature_limited');
    expect(u.moderationStatus.restrictedFeatures).toEqual(['create_listing']);
    // brokerStatus also untouched — edit doesn't change role state.
    expect(u.brokerStatus).toBe('APPROVED');
  });
});
