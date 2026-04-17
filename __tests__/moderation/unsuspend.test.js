// __tests__/moderation/unsuspend.test.js
//
// Integration test for service.unsuspend() (Plan 02-03).
// Uses MongoMemoryReplSet fixture. Covers D-21, D-22.

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
  try {
    await ModerationAction.collection.drop();
  } catch (_) {
    // collection doesn't exist yet — ignore
  }
});

describe('service.unsuspend (ADMIN-02, D-21, D-22)', () => {
  test('happy path: suspended → active, new audit row with action=unsuspend severity=none', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
    await User.create({
      firebaseUid: 'target-1', email: 'target@test.local',
      moderationStatus: {
        state: 'blocked_with_review', severity: 'blocked_with_review',
        reasonCategory: 'fraud', note: 'some prior note',
        setByAdminUid: 'admin-uid', setAt: new Date(),
        restrictedFeatures: ['all_writes'],
      },
    });

    const result = await service.unsuspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1', note: 'appealed successfully',
    });

    expect(result.ok).toBe(true);
    expect(result.user.moderationStatus.state).toBe('active');
    expect(result.user.moderationStatus.severity).toBe('none');
    expect(result.user.moderationStatus.reasonCategory).toBeNull();
    expect(result.user.moderationStatus.note).toBeNull();
    expect(result.user.moderationStatus.restrictedFeatures).toEqual([]);
    expect(result.user.moderationStatus.setByAdminUid).toBe('admin-uid');

    const updated = await User.findOne({ firebaseUid: 'target-1' }).lean();
    expect(updated.moderationStatus.state).toBe('active');
    expect(updated.moderationStatus.lastActionId.toString()).toBe(result.action._id);

    const audit = await ModerationAction.findOne({ targetUid: 'target-1' }).lean();
    expect(audit.action).toBe('unsuspend');
    expect(audit.severity).toBe('none');
    expect(audit.note).toBe('appealed successfully');
    expect(audit.adminUid).toBe('admin-uid');
    expect(audit.adminEmail).toBe('admin@test.local');
  });

  test('not_suspended: unsuspend on already-active user throws not_suspended', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    await User.create({ firebaseUid: 'admin-uid', email: 'admin@test.local' });
    await User.create({
      firebaseUid: 'target-1', email: 'target@test.local',
      moderationStatus: { state: 'active', severity: 'none' },
    });

    await expect(service.unsuspend({
      adminUid: 'admin-uid', adminEmail: 'admin@test.local',
      targetUid: 'target-1',
    })).rejects.toThrow('not_suspended');

    const audits = await ModerationAction.find({ targetUid: 'target-1' }).lean();
    expect(audits.length).toBe(0);
  });
});
