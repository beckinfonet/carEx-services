const { getUnlockPrice } = require('../../src/carRequests/unlockPrice');

describe('getUnlockPrice', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('defaults to 500 KGS when no env is set', () => {
    delete process.env.REQUEST_UNLOCK_PRICE;
    delete process.env.REQUEST_UNLOCK_CURRENCY;
    expect(getUnlockPrice()).toEqual({ amount: 500, currency: 'KGS' });
  });

  it('reads the env override', () => {
    process.env.REQUEST_UNLOCK_PRICE = '1200';
    process.env.REQUEST_UNLOCK_CURRENCY = 'USD';
    expect(getUnlockPrice()).toEqual({ amount: 1200, currency: 'USD' });
  });

  it('falls back to the default amount when the env value is invalid', () => {
    process.env.REQUEST_UNLOCK_PRICE = 'not-a-number';
    delete process.env.REQUEST_UNLOCK_CURRENCY;
    expect(getUnlockPrice()).toEqual({ amount: 500, currency: 'KGS' });
  });

  it('falls back to the default amount when the env value is non-positive', () => {
    process.env.REQUEST_UNLOCK_PRICE = '0';
    expect(getUnlockPrice().amount).toBe(500);
  });
});

const { isPaywallEnabled } = require('../../src/carRequests/unlockPrice');

describe('isPaywallEnabled', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults to false when the env is unset', () => {
    delete process.env.REQUEST_UNLOCK_ENABLED;
    expect(isPaywallEnabled()).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    process.env.REQUEST_UNLOCK_ENABLED = 'true';
    expect(isPaywallEnabled()).toBe(true);
  });

  it('is false for any other truthy-looking value', () => {
    process.env.REQUEST_UNLOCK_ENABLED = '1';
    expect(isPaywallEnabled()).toBe(false);
    process.env.REQUEST_UNLOCK_ENABLED = 'yes';
    expect(isPaywallEnabled()).toBe(false);
  });
});
