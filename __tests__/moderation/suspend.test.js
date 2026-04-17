// __tests__/moderation/suspend.test.js
//
// Integration test for service.suspend() (Plan 02-03).
// Uses MongoMemoryReplSet fixture (Plan 02-01) because session.withTransaction()
// requires replica-set mode. Covers D-18/D-19/D-20/D-27/D-28.

const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');
const service = require('../../src/moderation/service');
const User = require('../../src/models/User');
const AdminUser = require('../../src/models/AdminUser');
const ModerationAction = require('../../src/models/ModerationAction');

let rs;

beforeAll(async () => {
  rs = await startReplSet();
});

afterAll(async () => {
  await stopReplSet(rs);
});

beforeEach(async () => {
  await User.deleteMany({});
  await AdminUser.deleteMany({});
  // ModerationAction is append-only at the schema level — drop the collection.
  try {
    await ModerationAction.collection.drop();
  } catch (_) {
    // collection doesn't exist yet — ignore
  }
});

describe('service.suspend (ADMIN-01, D-17..D-20, D-27, D-28)', () => {
  test('happy path: inserts audit row and updates User.moderationStatus atomically', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
    await User.create({ firebaseUid: 'target-1', email: 'target@test.local' });

    const result = await service.suspend({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      targetUid: 'target-1',
      severity: 'feature_limited',
      reasonCategory: 'spam',
      note: 'testing',
    });

    expect(result.ok).toBe(true);
    expect(result.user.moderationStatus.state).toBe('feature_limited');
    expect(result.user.moderationStatus.severity).toBe('feature_limited');
    expect(result.user.moderationStatus.reasonCategory).toBe('spam');
    expect(result.user.moderationStatus.note).toBe('testing');
    expect(result.user.moderationStatus.setByAdminUid).toBe('admin-uid');
    expect(Array.isArray(result.user.moderationStatus.restrictedFeatures)).toBe(true);
    expect(result.user.moderationStatus.restrictedFeatures.length).toBeGreaterThan(0);

    const updated = await User.findOne({ firebaseUid: 'target-1' }).lean();
    expect(updated.moderationStatus.state).toBe('feature_limited');
    expect(updated.moderationStatus.lastActionId.toString()).toBe(result.action._id);

    const audit = await ModerationAction.findOne({ targetUid: 'target-1' }).lean();
    expect(audit.action).toBe('suspend');
    expect(audit.adminUid).toBe('admin-uid');
    expect(audit.adminEmail).toBe('admin@test.local');
    expect(audit.severity).toBe('feature_limited');
  });

  test('re-suspend at different severity: appends new audit row, flips lastActionId', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
    await User.create({ firebaseUid: 'target-1', email: 'target@test.local' });

    const first = await service.suspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', severity: 'feature_limited', reasonCategory: 'spam',
    });
    const second = await service.suspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', severity: 'blocked_with_review', reasonCategory: 'fraud',
    });

    expect(second.user.moderationStatus.state).toBe('blocked_with_review');
    expect(second.action._id).not.toBe(first.action._id);

    const audits = await ModerationAction.find({ targetUid: 'target-1' }).sort({ createdAt: 1 }).lean();
    expect(audits.length).toBe(2);
    expect(audits[0].severity).toBe('feature_limited');
    expect(audits[1].severity).toBe('blocked_with_review');

    const updated = await User.findOne({ firebaseUid: 'target-1' }).lean();
    expect(updated.moderationStatus.lastActionId.toString()).toBe(second.action._id);
  });

  test('re-suspend at identical severity: throws already_at_severity, no state change', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
    await User.create({ firebaseUid: 'target-1', email: 'target@test.local' });

    await service.suspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', severity: 'feature_limited', reasonCategory: 'spam',
    });

    await expect(service.suspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', severity: 'feature_limited', reasonCategory: 'spam',
    })).rejects.toThrow('already_at_severity');

    const audits = await ModerationAction.find({ targetUid: 'target-1' }).lean();
    expect(audits.length).toBe(1); // only the original, no duplicate
  });

  test('last-admin guard: suspending the only active admin rejects with last_admin_protected', async () => {
    // Seed scenario: admin-A (caller, NOT active — explicit moderationStatus),
    // admin-B (target, active — the ONLY active admin).
    await AdminUser.create({ email: 'admin-a@test.local', role: 'admin' });
    await AdminUser.create({ email: 'admin-b@test.local', role: 'admin' });
    await User.create({
      firebaseUid: 'admin-a-uid', email: 'admin-a@test.local',
      moderationStatus: {
        state: 'feature_limited', severity: 'feature_limited',
        reasonCategory: 'other', setByAdminUid: 'self', setAt: new Date(),
        restrictedFeatures: ['create_listing'],
      },
    });
    await User.create({
      firebaseUid: 'admin-b-uid', email: 'admin-b@test.local',
      moderationStatus: { state: 'active', severity: 'none' },
    });

    await expect(service.suspend({
      adminUid: 'admin-a-uid', adminEmail: 'admin-a@test.local',
      targetUid: 'admin-b-uid', severity: 'blocked_with_review', reasonCategory: 'fraud',
    })).rejects.toThrow('last_admin_protected');

    const b = await User.findOne({ firebaseUid: 'admin-b-uid' }).lean();
    expect(b.moderationStatus.state).toBe('active');
    const audits = await ModerationAction.find({ targetUid: 'admin-b-uid' }).lean();
    expect(audits.length).toBe(0); // transaction aborted — no audit row left behind
  });

  test('target not found: throws target_not_found', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
    await expect(service.suspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'ghost-uid', severity: 'feature_limited', reasonCategory: 'spam',
    })).rejects.toThrow('target_not_found');
  });

  test('restrictedFeatures derived from capabilities.js (blocked_with_review → all_writes)', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
    await User.create({ firebaseUid: 'target-1', email: 'target@test.local' });

    const result = await service.suspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', severity: 'blocked_with_review', reasonCategory: 'fraud',
    });

    expect(result.user.moderationStatus.restrictedFeatures).toEqual(['all_writes']);
  });
});
