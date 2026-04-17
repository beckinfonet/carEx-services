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

describe('STATUS_POLICY + resolveRestrictedFeatures (DATA-04)', () => {
  const User = require('../../src/models/User');
  const { STATUS_POLICY, resolveRestrictedFeatures } = require('../../src/moderation/capabilities');

  test('STATUS_POLICY keys match User.moderationStatus.state enum', () => {
    const statePath = User.schema.path('moderationStatus.state');
    expect(statePath).toBeDefined();
    const schemaEnum = new Set(statePath.enumValues);
    const policyKeys = new Set(Object.keys(STATUS_POLICY));
    expect(policyKeys).toEqual(schemaEnum);
  });

  test("active state grants 'all' capabilities with no banner", () => {
    expect(STATUS_POLICY.active.capabilities).toBe('all');
    expect(STATUS_POLICY.active.banner).toBeNull();
  });

  test('feature_limited blocks the expected 7 tokens', () => {
    expect(STATUS_POLICY.feature_limited.capabilities.blocked).toEqual([
      'create_listing',
      'create_order',
      'contact_seller',
      'request_seller_role',
      'request_broker_role',
      'request_logistics_role',
      'update_profile',
    ]);
    expect(STATUS_POLICY.feature_limited.banner.resolutionHintKey).toBe('moderation.feature_limited.resolution');
    expect(STATUS_POLICY.feature_limited.banner.appealAllowed).toBe(false);
  });

  test('blocked_with_review uses all_writes sentinel and has appealEmail', () => {
    expect(STATUS_POLICY.blocked_with_review.capabilities.blocked).toBe('all_writes');
    expect(STATUS_POLICY.blocked_with_review.banner.appealAllowed).toBe(true);
    expect(STATUS_POLICY.blocked_with_review.banner.appealEmail).toBe('support@carexmarket.com');
  });

  test('permanently_banned uses all_writes sentinel and blocks appeal', () => {
    expect(STATUS_POLICY.permanently_banned.capabilities.blocked).toBe('all_writes');
    expect(STATUS_POLICY.permanently_banned.banner.appealAllowed).toBe(false);
    expect(STATUS_POLICY.permanently_banned.banner.appealEmail).toBeUndefined();
  });

  test('resolveRestrictedFeatures returns [] for active', () => {
    expect(resolveRestrictedFeatures('active')).toEqual([]);
  });

  test('resolveRestrictedFeatures returns the full list for feature_limited', () => {
    expect(resolveRestrictedFeatures('feature_limited')).toEqual([
      'create_listing',
      'create_order',
      'contact_seller',
      'request_seller_role',
      'request_broker_role',
      'request_logistics_role',
      'update_profile',
    ]);
  });

  test('resolveRestrictedFeatures returns [all_writes] sentinel for blocked_with_review and permanently_banned', () => {
    expect(resolveRestrictedFeatures('blocked_with_review')).toEqual(['all_writes']);
    expect(resolveRestrictedFeatures('permanently_banned')).toEqual(['all_writes']);
  });

  test('resolveRestrictedFeatures throws on unknown state', () => {
    expect(() => resolveRestrictedFeatures('banned')).toThrow(/Unknown moderation state/);
  });

  test('every banner titleKey and bodyKey follows moderation.<state>.<field> convention', () => {
    for (const state of ['feature_limited', 'blocked_with_review', 'permanently_banned']) {
      expect(STATUS_POLICY[state].banner.titleKey).toBe(`moderation.${state}.title`);
      expect(STATUS_POLICY[state].banner.bodyKey).toBe(`moderation.${state}.body`);
    }
  });
});
