const { redactForSeller, SELLER_HIDDEN_FIELDS } = require('../../src/carRequests/redactForSeller');

const fullDoc = {
  _id: 'r1',
  buyerUid: 'buyer-1',
  makeName: 'Toyota',
  modelName: 'Camry',
  budgetMax: 15000,
  currency: 'KGS',
  status: 'open',
  contactPhone: '+996555111222',
  contactPhoneVerified: true,
  telegramUsername: 'bishkek_cars',
  telegramVerified: false,
};

describe('redactForSeller', () => {
  it('strips every contact + owner field', () => {
    const out = redactForSeller(fullDoc, { unlocked: false });
    for (const f of SELLER_HIDDEN_FIELDS) {
      expect(out[f]).toBeUndefined();
    }
  });

  it('keeps the non-contact fields a seller is allowed to see', () => {
    const out = redactForSeller(fullDoc, { unlocked: false });
    expect(out.makeName).toBe('Toyota');
    expect(out.budgetMax).toBe(15000);
    expect(out.status).toBe('open');
  });

  it('tags the result with the unlocked flag', () => {
    expect(redactForSeller(fullDoc, { unlocked: false }).unlocked).toBe(false);
    expect(redactForSeller(fullDoc, { unlocked: true }).unlocked).toBe(true);
  });

  it('defaults unlocked to false when not provided', () => {
    expect(redactForSeller(fullDoc).unlocked).toBe(false);
  });

  it('accepts a Mongoose doc with toObject()', () => {
    const mongooseLike = { toObject: () => ({ ...fullDoc }) };
    const out = redactForSeller(mongooseLike, { unlocked: false });
    expect(out.contactPhone).toBeUndefined();
    expect(out.makeName).toBe('Toyota');
  });

  it('does not mutate the input object', () => {
    const input = { ...fullDoc };
    redactForSeller(input, { unlocked: false });
    expect(input.contactPhone).toBe('+996555111222');
  });
});
