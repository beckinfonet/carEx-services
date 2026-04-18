// __tests__/moderation/deleteProviderProfile.test.js
//
// Plan 02-05 — service.deleteProviderProfile() integration tests.
// Covers ADMIN-04, D-13..D-16 per .planning/phases/02-admin-moderation-endpoints-backend/02-CONTEXT.md.
//
// Hard-deletes Broker / LogisticsPartner doc + strips User.{role}Status → 'NONE' inside
// one Mongoose transaction. ServiceOrder.providerSnapshot (Phase 1 D-21..D-24) keeps
// past orders intact — the service NEVER touches service_orders (Pitfall 3).
//
// IMPORTANT: This file registers the CANONICAL Broker / LogisticsPartner / ServiceOrder
// model names BEFORE requiring service.js — service.js does mongoose.model('Broker')
// internally and will pick up whichever model is registered under that name first. This
// keeps the test hermetic (no server.js import) AND lets the production code path resolve
// the same way at runtime.

const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');

if (!mongoose.models.Broker) {
  mongoose.model('Broker', new mongoose.Schema({}, { strict: false, collection: 'brokers' }));
}
if (!mongoose.models.LogisticsPartner) {
  mongoose.model('LogisticsPartner', new mongoose.Schema({}, { strict: false, collection: 'logistics_partners' }));
}
if (!mongoose.models.ServiceOrder) {
  mongoose.model('ServiceOrder', new mongoose.Schema({}, { strict: false, collection: 'service_orders' }));
}
const Broker = mongoose.model('Broker');
const LogisticsPartner = mongoose.model('LogisticsPartner');
const ServiceOrder = mongoose.model('ServiceOrder');

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
  try { await ModerationAction.collection.drop(); } catch (_) { /* collection may not exist yet */ }
  try { await Broker.collection.drop(); } catch (_) { /* idem */ }
  try { await LogisticsPartner.collection.drop(); } catch (_) { /* idem */ }
  try { await ServiceOrder.collection.drop(); } catch (_) { /* idem */ }
});

async function seedAdminAndActor() {
  await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
  await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
}

describe('service.deleteProviderProfile (ADMIN-04, D-13..D-16)', () => {
  test('broker happy path: Broker hard-deleted, brokerStatus=NONE, ServiceOrder intact', async () => {
    await seedAdminAndActor();
    await User.create({ firebaseUid: 'broker-1', email: 'b@test.local', brokerStatus: 'APPROVED' });
    await Broker.collection.insertOne({
      ownerUid: 'broker-1', companyName: 'Acme', phoneNumber: '+10000000',
      status: 'active', createdAt: new Date(),
    });
    // Past order with populated providerSnapshot — must survive untouched (D-15).
    await ServiceOrder.collection.insertOne({
      orderId: 'ORD-001', buyerUid: 'buyer-1',
      items: [{ providerUid: 'broker-1', providerType: 'broker' }],
      providerSnapshot: {
        companyName: 'Acme', phoneNumber: '+10000000', email: 'b@test.local',
        providerRole: 'broker', snapshotAt: new Date(),
      },
      createdAt: new Date(),
    });

    const result = await service.deleteProviderProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'broker-1', role: 'broker', reasonCategory: 'fraud', note: 'confirmed',
    });

    expect(result.ok).toBe(true);
    expect(result.user.brokerStatus).toBe('NONE');

    const brokerDoc = await Broker.findOne({ ownerUid: 'broker-1' }).lean();
    expect(brokerDoc).toBeNull(); // hard-deleted

    const u = await User.findOne({ firebaseUid: 'broker-1' }).lean();
    expect(u.brokerStatus).toBe('NONE');

    const audit = await ModerationAction.findOne({ targetUid: 'broker-1' }).lean();
    expect(audit.action).toBe('delete_provider_profile');
    expect(audit.roleAffected).toBe('broker');
    expect(audit.severity).toBe('none');
    expect(audit.reasonCategory).toBe('fraud');
    expect(audit.note).toBe('confirmed');

    // KEY D-15 ASSERTION: ServiceOrder UNTOUCHED — past orders survive via providerSnapshot.
    const order = await ServiceOrder.findOne({ orderId: 'ORD-001' }).lean();
    expect(order).not.toBeNull();
    expect(order.providerSnapshot.companyName).toBe('Acme');
    expect(order.providerSnapshot.phoneNumber).toBe('+10000000');
  });

  test('logistics happy path: LogisticsPartner hard-deleted, logisticsStatus=NONE', async () => {
    await seedAdminAndActor();
    await User.create({ firebaseUid: 'logi-1', email: 'l@test.local', logisticsStatus: 'APPROVED' });
    await LogisticsPartner.collection.insertOne({
      ownerUid: 'logi-1', companyName: 'FastShip', timelines: '1-3 days',
      status: 'active', createdAt: new Date(),
    });

    const result = await service.deleteProviderProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'logi-1', role: 'logistics', reasonCategory: 'spam',
    });

    expect(result.ok).toBe(true);
    expect(result.user.logisticsStatus).toBe('NONE');

    const doc = await LogisticsPartner.findOne({ ownerUid: 'logi-1' }).lean();
    expect(doc).toBeNull();

    const u = await User.findOne({ firebaseUid: 'logi-1' }).lean();
    expect(u.logisticsStatus).toBe('NONE');

    const audit = await ModerationAction.findOne({ targetUid: 'logi-1' }).lean();
    expect(audit.action).toBe('delete_provider_profile');
    expect(audit.roleAffected).toBe('logistics');
  });

  test('role_not_assigned: brokerStatus=NONE → 400 role_not_assigned', async () => {
    await seedAdminAndActor();
    await User.create({ firebaseUid: 'target-1', email: 'x@test.local', brokerStatus: 'NONE' });

    await expect(service.deleteProviderProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', role: 'broker', reasonCategory: 'spam',
    })).rejects.toThrow('role_not_assigned');

    const audits = await ModerationAction.find({ targetUid: 'target-1' }).lean();
    expect(audits.length).toBe(0);
  });

  test('provider_profile_not_found: User claims role but no Broker doc exists', async () => {
    await seedAdminAndActor();
    await User.create({ firebaseUid: 'orphan-1', email: 'o@test.local', brokerStatus: 'APPROVED' });
    // No Broker doc inserted — data-integrity edge case.

    await expect(service.deleteProviderProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'orphan-1', role: 'broker', reasonCategory: 'other',
    })).rejects.toThrow('provider_profile_not_found');

    // brokerStatus must NOT be mutated and NO audit row must exist (thrown before txn).
    const u = await User.findOne({ firebaseUid: 'orphan-1' }).lean();
    expect(u.brokerStatus).toBe('APPROVED');
    const audits = await ModerationAction.find({ targetUid: 'orphan-1' }).lean();
    expect(audits.length).toBe(0);
  });

  test('role=seller rejected at service layer (D-14 defensive)', async () => {
    await seedAdminAndActor();
    await User.create({ firebaseUid: 'seller-1', email: 's@test.local', sellerStatus: 'APPROVED' });

    await expect(service.deleteProviderProfile({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'seller-1', role: 'seller', reasonCategory: 'spam',
    })).rejects.toThrow('invalid_role_for_delete');
  });

  test('transaction rollback: if audit write fails, Broker doc must NOT be deleted', async () => {
    await seedAdminAndActor();
    await User.create({ firebaseUid: 'broker-2', email: 'b2@test.local', brokerStatus: 'APPROVED' });
    await Broker.collection.insertOne({
      ownerUid: 'broker-2', companyName: 'Acme2', phoneNumber: '+2', status: 'active', createdAt: new Date(),
    });

    // Monkey-patch ModerationAction.create to throw — proves audit-failure rolls back the txn.
    const originalCreate = ModerationAction.create;
    ModerationAction.create = jest.fn().mockRejectedValueOnce(new Error('simulated audit failure'));

    try {
      await expect(service.deleteProviderProfile({
        adminUid: 'admin-uid', adminEmail: 'admin@test.local',
        targetUid: 'broker-2', role: 'broker', reasonCategory: 'fraud',
      })).rejects.toThrow('simulated audit failure');
    } finally {
      ModerationAction.create = originalCreate;
    }

    // Transaction must have rolled back — Broker still present, brokerStatus still APPROVED.
    const brokerDoc = await Broker.findOne({ ownerUid: 'broker-2' }).lean();
    expect(brokerDoc).not.toBeNull();
    const u = await User.findOne({ firebaseUid: 'broker-2' }).lean();
    expect(u.brokerStatus).toBe('APPROVED');
  });

  // Test 7 (W-03 fix per plan-checker): proves rollback when a step LATER than Broker.deleteOne fails.
  // Test 6 covers the audit-first ordering (audit throws before any mutation runs). The service
  // body does ModerationAction.create THEN Broker.deleteOne THEN User.updateOne — if updateOne
  // throws, withTransaction must roll back the deleteOne. This is the more common real-world
  // rollback case and is required evidence for threat T-02-05-02.
  test('rolls back Broker.deleteOne when User.updateOne throws later in the transaction', async () => {
    await seedAdminAndActor();
    await User.create({ firebaseUid: 'broker-3', email: 'b3@test.local', brokerStatus: 'APPROVED' });
    await Broker.collection.insertOne({
      ownerUid: 'broker-3', companyName: 'AcmeRollback', phoneNumber: '+3', status: 'active', createdAt: new Date(),
    });

    // Monkey-patch User.updateOne to throw on the next call — this fires AFTER ModerationAction.create
    // AND AFTER Broker.deleteOne inside the transaction. The throw must cause withTransaction to
    // abort and roll back the Broker delete. jest.spyOn auto-restores via spy.mockRestore().
    const updateOneSpy = jest.spyOn(User, 'updateOne').mockRejectedValueOnce(new Error('mid-txn fail'));

    try {
      await expect(service.deleteProviderProfile({
        adminUid: 'admin-uid', adminEmail: 'admin@test.local',
        targetUid: 'broker-3', role: 'broker', reasonCategory: 'fraud',
      })).rejects.toThrow('mid-txn fail');
    } finally {
      updateOneSpy.mockRestore();
    }

    // KEY ASSERTION: Broker doc must still exist with its original fields — proves the
    // Broker.deleteOne was rolled back when User.updateOne failed later in the transaction.
    const survivor = await Broker.findOne({ ownerUid: 'broker-3' }).lean();
    expect(survivor).not.toBeNull();
    expect(survivor.companyName).toBe('AcmeRollback');
    expect(survivor.phoneNumber).toBe('+3');

    // brokerStatus must also remain APPROVED (unchanged by the aborted transaction).
    const u = await User.findOne({ firebaseUid: 'broker-3' }).lean();
    expect(u.brokerStatus).toBe('APPROVED');

    // No audit row committed for the rolled-back action.
    const audits = await ModerationAction.find({ targetUid: 'broker-3' }).lean();
    expect(audits.length).toBe(0);
  });
});
