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
