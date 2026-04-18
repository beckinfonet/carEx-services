// __tests__/moderation/revokeRole.test.js
//
// Plan 02-04 — service.revokeRole() integration tests.
// Covers ADMIN-03, D-08..D-12, D-28 per .planning/phases/02-admin-moderation-endpoints-backend/02-CONTEXT.md.
//
// Three role paths (seller / broker / logistics) + role_not_assigned guards (NONE + PENDING)
// + moderationStatus orthogonality assertion (D-12). Critical D-08 contract: Broker /
// LogisticsPartner profile docs MUST survive revoke (negative assertion in tests 2 + 3).
//
// Uses MongoMemoryReplSet fixture from Plan 02-01 because revokeRole opens a Mongoose
// session.withTransaction() (D-23).

const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');
const service = require('../../src/moderation/service');
const User = require('../../src/models/User');
const AdminUser = require('../../src/models/AdminUser');
const ModerationAction = require('../../src/models/ModerationAction');

// Loose-schema seeds for Broker / LogisticsPartner. Provider docs live inline in
// server.js per Phase 1 D-02; tests do not import server.js. Distinct model names
// per file avoid Mongoose's "cannot overwrite model" error if any other suite has
// registered the canonical Broker / LogisticsPartner models in the same Jest process.
const BrokerSeed = mongoose.models.Broker_testseed_revoke
  || mongoose.model('Broker_testseed_revoke', new mongoose.Schema({}, { strict: false, collection: 'brokers' }));
const LogisticsPartnerSeed = mongoose.models.LogisticsPartner_testseed_revoke
  || mongoose.model('LogisticsPartner_testseed_revoke', new mongoose.Schema({}, { strict: false, collection: 'logistics_partners' }));

let rs;
beforeAll(async () => { rs = await startReplSet(); });
afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await User.deleteMany({});
  await AdminUser.deleteMany({});
  try { await ModerationAction.collection.drop(); } catch (_) {}
  try { await BrokerSeed.collection.drop(); } catch (_) {}
  try { await LogisticsPartnerSeed.collection.drop(); } catch (_) {}
});

async function seedAdminAndActor() {
  await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
  await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
}

describe('service.revokeRole (ADMIN-03, D-08..D-12)', () => {
  test('revoke seller: sellerStatus → NONE, audit row appended, moderationStatus untouched', async () => {
    await seedAdminAndActor();
    await User.create({
      firebaseUid: 'target-1', email: 'seller@test.local',
      sellerStatus: 'APPROVED',
      moderationStatus: { state: 'active', severity: 'none' },
    });

    const result = await service.revokeRole({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', role: 'seller', reasonCategory: 'policy_violation',
    });

    expect(result.ok).toBe(true);
    expect(result.user.sellerStatus).toBe('NONE');

    const updated = await User.findOne({ firebaseUid: 'target-1' }).lean();
    expect(updated.sellerStatus).toBe('NONE');
    expect(updated.moderationStatus.state).toBe('active');

    const audit = await ModerationAction.findOne({ targetUid: 'target-1' }).lean();
    expect(audit.action).toBe('revoke_role');
    expect(audit.severity).toBe('none');
    expect(audit.roleAffected).toBe('seller');
    expect(audit.reasonCategory).toBe('policy_violation');
  });

  test('revoke broker: brokerStatus → NONE, Broker doc preserved (D-08)', async () => {
    await seedAdminAndActor();
    await User.create({
      firebaseUid: 'target-2', email: 'broker@test.local',
      brokerStatus: 'APPROVED',
    });
    await BrokerSeed.collection.insertOne({
      ownerUid: 'target-2',
      companyName: 'Acme Brokers',
      phoneNumber: '+10000000',
      status: 'active',
      createdAt: new Date(),
    });

    const result = await service.revokeRole({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-2', role: 'broker', reasonCategory: 'spam',
    });

    expect(result.user.brokerStatus).toBe('NONE');

    const updated = await User.findOne({ firebaseUid: 'target-2' }).lean();
    expect(updated.brokerStatus).toBe('NONE');

    // KEY D-08 ASSERTION: Broker doc MUST still exist after revoke. This is the
    // "preservation for historical lookups" contract from ROADMAP Phase 2 #2.
    const brokerDoc = await BrokerSeed.findOne({ ownerUid: 'target-2' }).lean();
    expect(brokerDoc).not.toBeNull();
    expect(brokerDoc.companyName).toBe('Acme Brokers');
    expect(brokerDoc.phoneNumber).toBe('+10000000');

    const audit = await ModerationAction.findOne({ targetUid: 'target-2' }).lean();
    expect(audit.roleAffected).toBe('broker');
  });

  test('revoke logistics: logisticsStatus → NONE, LogisticsPartner doc preserved (D-08)', async () => {
    await seedAdminAndActor();
    await User.create({
      firebaseUid: 'target-3', email: 'logi@test.local',
      logisticsStatus: 'APPROVED',
    });
    await LogisticsPartnerSeed.collection.insertOne({
      ownerUid: 'target-3',
      companyName: 'Fast Ship',
      timelines: '1-3 days',
      coverageAreas: ['MSK', 'SPB'],
      createdAt: new Date(),
    });

    const result = await service.revokeRole({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-3', role: 'logistics', reasonCategory: 'fraud',
    });

    expect(result.user.logisticsStatus).toBe('NONE');

    const updated = await User.findOne({ firebaseUid: 'target-3' }).lean();
    expect(updated.logisticsStatus).toBe('NONE');

    const logiDoc = await LogisticsPartnerSeed.findOne({ ownerUid: 'target-3' }).lean();
    expect(logiDoc).not.toBeNull();
    expect(logiDoc.companyName).toBe('Fast Ship');
    expect(logiDoc.coverageAreas).toEqual(['MSK', 'SPB']);
  });

  test('role_not_assigned: user has brokerStatus=NONE', async () => {
    await seedAdminAndActor();
    await User.create({
      firebaseUid: 'target-4', email: 'regular@test.local',
      brokerStatus: 'NONE',
    });

    await expect(service.revokeRole({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-4', role: 'broker', reasonCategory: 'spam',
    })).rejects.toThrow('role_not_assigned');

    const audits = await ModerationAction.find({ targetUid: 'target-4' }).lean();
    expect(audits.length).toBe(0);
  });

  test('role_not_assigned: user has brokerStatus=PENDING (not APPROVED)', async () => {
    await seedAdminAndActor();
    await User.create({
      firebaseUid: 'target-5', email: 'pending@test.local',
      brokerStatus: 'PENDING',
    });

    await expect(service.revokeRole({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-5', role: 'broker', reasonCategory: 'other',
    })).rejects.toThrow('role_not_assigned');

    const audits = await ModerationAction.find({ targetUid: 'target-5' }).lean();
    expect(audits.length).toBe(0);
  });

  test('revoke does NOT touch user.moderationStatus (D-12 orthogonality)', async () => {
    await seedAdminAndActor();
    await User.create({
      firebaseUid: 'target-6', email: 'suspended-seller@test.local',
      sellerStatus: 'APPROVED',
      moderationStatus: {
        state: 'feature_limited', severity: 'feature_limited',
        reasonCategory: 'spam', setByAdminUid: 'admin-uid', setAt: new Date(),
        restrictedFeatures: ['create_listing'],
      },
    });

    await service.revokeRole({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-6', role: 'seller', reasonCategory: 'fraud',
    });

    const updated = await User.findOne({ firebaseUid: 'target-6' }).lean();
    expect(updated.sellerStatus).toBe('NONE');
    expect(updated.moderationStatus.state).toBe('feature_limited');         // unchanged
    expect(updated.moderationStatus.severity).toBe('feature_limited');      // unchanged
    expect(updated.moderationStatus.restrictedFeatures).toEqual(['create_listing']); // unchanged
  });
});
