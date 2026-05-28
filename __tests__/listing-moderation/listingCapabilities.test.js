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

describe('LISTING_STATUS_POLICY + resolveBlockedBuyerActions (LDATA-01)', () => {
  const Car = require('../../src/models/Car');
  const {
    LISTING_STATUS_POLICY,
    resolveBlockedBuyerActions,
  } = require('../../src/moderation/listingCapabilities');

  test('LISTING_STATUS_POLICY keys match Car.status enum (D-19 lock)', () => {
    expect(Car.schema.path('status')).toBeDefined();
    const enumValues = new Set(Car.schema.path('status').enumValues);
    const policyKeys = new Set(Object.keys(LISTING_STATUS_POLICY));
    expect(policyKeys).toEqual(enumValues);
  });

  test('active state has empty buyerBlocked + null banner', () => {
    expect(LISTING_STATUS_POLICY.active.buyerBlocked).toEqual([]);
    expect(LISTING_STATUS_POLICY.active.banner).toBeNull();
  });

  test('suspended state blocks add_to_cart + confirm_booking with warning severity', () => {
    expect(LISTING_STATUS_POLICY.suspended.buyerBlocked).toEqual([
      'add_to_cart',
      'confirm_booking',
    ]);
    expect(LISTING_STATUS_POLICY.suspended.banner.titleKey).toBe('listingBannerSuspendedTitle');
    expect(LISTING_STATUS_POLICY.suspended.banner.bodyKey).toBe('listingBannerSuspendedBody');
    expect(LISTING_STATUS_POLICY.suspended.banner.severity).toBe('warning');
  });

  test('archived state blocks add_to_cart + confirm_booking with neutral severity', () => {
    expect(LISTING_STATUS_POLICY.archived.buyerBlocked).toEqual([
      'add_to_cart',
      'confirm_booking',
    ]);
    expect(LISTING_STATUS_POLICY.archived.banner.titleKey).toBe('listingBannerArchivedTitle');
    expect(LISTING_STATUS_POLICY.archived.banner.bodyKey).toBe('listingBannerArchivedBody');
    expect(LISTING_STATUS_POLICY.archived.banner.severity).toBe('neutral');
  });

  test('deleted state additionally blocks view with destructive severity', () => {
    expect(LISTING_STATUS_POLICY.deleted.buyerBlocked).toEqual([
      'view',
      'add_to_cart',
      'confirm_booking',
    ]);
    expect(LISTING_STATUS_POLICY.deleted.banner.titleKey).toBe('listingBannerDeletedTitle');
    expect(LISTING_STATUS_POLICY.deleted.banner.bodyKey).toBe('listingBannerDeletedBody');
    expect(LISTING_STATUS_POLICY.deleted.banner.severity).toBe('destructive');
  });

  test('resolveBlockedBuyerActions returns the expected list per state', () => {
    expect(resolveBlockedBuyerActions('active')).toEqual([]);
    expect(resolveBlockedBuyerActions('suspended')).toEqual([
      'add_to_cart',
      'confirm_booking',
    ]);
    expect(resolveBlockedBuyerActions('archived')).toEqual([
      'add_to_cart',
      'confirm_booking',
    ]);
    expect(resolveBlockedBuyerActions('deleted')).toEqual([
      'view',
      'add_to_cart',
      'confirm_booking',
    ]);
  });

  test('resolveBlockedBuyerActions returns [] for unknown state (D-14 fallback)', () => {
    expect(resolveBlockedBuyerActions('unknown_state')).toEqual([]);
    expect(resolveBlockedBuyerActions(undefined)).toEqual([]);
    expect(resolveBlockedBuyerActions(null)).toEqual([]);
  });
});
