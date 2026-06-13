const { validateRequestInput } = require('../../src/carRequests/validateRequestInput');

describe('validateRequestInput', () => {
  const validBody = { makeId: '64b000000000000000000001', budgetMax: 15000 };

  it('accepts a minimal valid body (make + budgetMax)', () => {
    const { errors, value } = validateRequestInput(validBody);
    expect(errors).toEqual([]);
    expect(value.budgetMax).toBe(15000);
  });

  it('rejects a missing makeId', () => {
    const { errors } = validateRequestInput({ budgetMax: 15000 });
    expect(errors).toContain('makeId is required');
  });

  it('rejects a non-positive budgetMax', () => {
    const { errors } = validateRequestInput({ makeId: validBody.makeId, budgetMax: 0 });
    expect(errors).toContain('budgetMax must be a positive number');
  });

  it('rejects budgetMin greater than budgetMax', () => {
    const { errors } = validateRequestInput({ ...validBody, budgetMin: 20000 });
    expect(errors).toContain('budgetMin cannot exceed budgetMax');
  });

  it('rejects yearMin greater than yearMax', () => {
    const { errors } = validateRequestInput({ ...validBody, yearMin: 2020, yearMax: 2015 });
    expect(errors).toContain('yearMin cannot exceed yearMax');
  });

  it('strips a leading @ from telegramUsername', () => {
    const { value } = validateRequestInput({ ...validBody, telegramUsername: '@bishkek_cars' });
    expect(value.telegramUsername).toBe('bishkek_cars');
  });

  it('coerces numeric strings for budget/year', () => {
    const { value } = validateRequestInput({ makeId: validBody.makeId, budgetMax: '15000', yearMin: '2015' });
    expect(value.budgetMax).toBe(15000);
    expect(value.yearMin).toBe(2015);
  });

  it('drops unknown fields', () => {
    const { value } = validateRequestInput({ ...validBody, hackerField: 'x' });
    expect(value.hackerField).toBeUndefined();
  });

  it('defaults currency to KGS when absent', () => {
    const { value } = validateRequestInput(validBody);
    expect(value.currency).toBe('KGS');
  });

  it('accepts and uppercases a USD currency', () => {
    const { errors, value } = validateRequestInput({ ...validBody, currency: 'usd' });
    expect(errors).toEqual([]);
    expect(value.currency).toBe('USD');
  });

  it('coerces an unrecognized currency to KGS', () => {
    const { errors, value } = validateRequestInput({ ...validBody, currency: 'EUR' });
    expect(errors).toEqual([]);
    expect(value.currency).toBe('KGS');
  });
});
