// __tests__/moderation/schemas.test.js
const {
  suspendSchema,
  revokeRoleSchema,
  dispatchSchema,
  unsuspendSchema,
  deleteProfileSchema,
  editProfileBrokerSchema,
  editProfileLogisticsSchema,
  editProfileSchema,
} = require('../../src/moderation/schemas');

describe('moderation schemas (.strict() mode, D-34..D-37)', () => {
  describe('suspendSchema', () => {
    test('accepts well-formed suspend body', () => {
      const res = suspendSchema.safeParse({
        action: 'suspend',
        severity: 'feature_limited',
        reasonCategory: 'spam',
        note: 'testing',
      });
      expect(res.success).toBe(true);
    });

    test('rejects unknown top-level key (strict mode)', () => {
      const res = suspendSchema.safeParse({
        action: 'suspend',
        severity: 'feature_limited',
        reasonCategory: 'spam',
        foo: 'bar',
      });
      expect(res.success).toBe(false);
      expect(res.error.issues.some(i => i.code === 'unrecognized_keys')).toBe(true);
    });

    test('rejects severity not in enum', () => {
      const res = suspendSchema.safeParse({
        action: 'suspend',
        severity: 'warning',      // not an enum member
        reasonCategory: 'spam',
      });
      expect(res.success).toBe(false);
    });

    test('rejects note longer than 2000 chars', () => {
      const res = suspendSchema.safeParse({
        action: 'suspend',
        severity: 'feature_limited',
        reasonCategory: 'spam',
        note: 'x'.repeat(2001),
      });
      expect(res.success).toBe(false);
    });
  });

  describe('dispatchSchema (discriminatedUnion on action)', () => {
    test('routes action:suspend to suspendSchema', () => {
      const res = dispatchSchema.safeParse({
        action: 'suspend',
        severity: 'blocked_with_review',
        reasonCategory: 'fraud',
      });
      expect(res.success).toBe(true);
      expect(res.data.action).toBe('suspend');
    });

    test('routes action:revoke_role to revokeRoleSchema', () => {
      const res = dispatchSchema.safeParse({
        action: 'revoke_role',
        role: 'broker',
        reasonCategory: 'policy_violation',
      });
      expect(res.success).toBe(true);
      expect(res.data.action).toBe('revoke_role');
    });

    test('rejects unknown action value', () => {
      const res = dispatchSchema.safeParse({ action: 'ban_forever', reasonCategory: 'spam' });
      expect(res.success).toBe(false);
    });
  });

  describe('unsuspendSchema', () => {
    test('accepts empty body (note is optional)', () => {
      expect(unsuspendSchema.safeParse({}).success).toBe(true);
    });

    test('rejects unknown key', () => {
      expect(unsuspendSchema.safeParse({ severity: 'feature_limited' }).success).toBe(false);
    });
  });

  describe('deleteProfileSchema (D-14 — broker/logistics only)', () => {
    test('accepts role=broker', () => {
      expect(deleteProfileSchema.safeParse({ role: 'broker', reasonCategory: 'spam' }).success).toBe(true);
    });

    test('accepts role=logistics', () => {
      expect(deleteProfileSchema.safeParse({ role: 'logistics', reasonCategory: 'fraud' }).success).toBe(true);
    });

    test('rejects role=seller (no profile doc)', () => {
      expect(deleteProfileSchema.safeParse({ role: 'seller', reasonCategory: 'spam' }).success).toBe(false);
    });
  });

  describe('editProfileBrokerSchema (whitelist D-03)', () => {
    test('accepts companyName + phoneNumber + telegramUsername', () => {
      const res = editProfileBrokerSchema.safeParse({
        role: 'broker',
        fields: { companyName: 'Acme', phoneNumber: '+10000000', telegramUsername: 'acme' },
      });
      expect(res.success).toBe(true);
    });

    test('rejects description (not in whitelist)', () => {
      const res = editProfileBrokerSchema.safeParse({
        role: 'broker',
        fields: { description: 'new description' },
      });
      expect(res.success).toBe(false);
      expect(res.error.issues.some(i => i.code === 'unrecognized_keys')).toBe(true);
    });

    test('rejects services array (not in whitelist)', () => {
      const res = editProfileBrokerSchema.safeParse({
        role: 'broker',
        fields: { services: [{ name: 'x' }] },
      });
      expect(res.success).toBe(false);
    });

    test('rejects avatarUrl (not in whitelist)', () => {
      const res = editProfileBrokerSchema.safeParse({
        role: 'broker',
        fields: { avatarUrl: 'https://...' },
      });
      expect(res.success).toBe(false);
    });
  });

  describe('editProfileLogisticsSchema (whitelist D-03 — broker fields + coverageAreas + timelines)', () => {
    test('accepts coverageAreas array + timelines string', () => {
      const res = editProfileLogisticsSchema.safeParse({
        role: 'logistics',
        fields: {
          companyName: 'Fast Ship',
          coverageAreas: ['MSK', 'SPB'],
          timelines: '1-3 days',
        },
      });
      expect(res.success).toBe(true);
    });

    test('rejects description (not in whitelist — same guard as broker)', () => {
      const res = editProfileLogisticsSchema.safeParse({
        role: 'logistics',
        fields: { description: 'x' },
      });
      expect(res.success).toBe(false);
    });

    test('rejects coverageAreas as non-array', () => {
      const res = editProfileLogisticsSchema.safeParse({
        role: 'logistics',
        fields: { coverageAreas: 'MSK' },
      });
      expect(res.success).toBe(false);
    });
  });

  describe('editProfileSchema (discriminatedUnion on role)', () => {
    test('routes role:broker to broker schema', () => {
      const res = editProfileSchema.safeParse({
        role: 'broker',
        fields: { companyName: 'Acme' },
      });
      expect(res.success).toBe(true);
    });

    test('routes role:logistics to logistics schema', () => {
      const res = editProfileSchema.safeParse({
        role: 'logistics',
        fields: { timelines: '1 day' },
      });
      expect(res.success).toBe(true);
    });
  });
});
