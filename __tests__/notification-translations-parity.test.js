// Phase 12 — Wave 1 (NI18N-03 backend translation parity).
//
// Mirrors the mobile __tests__/translation-parity.test.ts harness (set-equality,
// non-empty leaf, placeholder-token parity) for the backend translations map
// src/notifications/translations.js. Currency must read as KGS som (NI18N-03 /
// audience-tone memory), never ruble.

const TRANSLATIONS = require('../src/notifications/translations');
const { render } = require('../src/notifications/translations');

// Flatten a language block into a { 'key.leaf': value } map of leaf strings.
function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

// Extract {param} placeholder tokens from a template string, sorted.
function tokens(str) {
  return (str.match(/\{(\w+)\}/g) || []).sort();
}

const ru = flatten(TRANSLATIONS.RU);
const en = flatten(TRANSLATIONS.EN);

describe('NI18N-03 backend notification translations parity', () => {
  test('RU and EN key sets are identical (set-equality)', () => {
    const ruKeys = Object.keys(ru).sort();
    const enKeys = Object.keys(en).sort();
    expect(ruKeys).toEqual(enKeys);
  });

  test('every value is a non-empty string', () => {
    for (const [, v] of Object.entries({ ...ru, ...en })) {
      expect(typeof v).toBe('string');
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });

  test('placeholder tokens ({param}) are identical across RU and EN per key', () => {
    for (const key of Object.keys(ru)) {
      expect(tokens(ru[key])).toEqual(tokens(en[key]));
    }
  });

  test('currency strings render KGS som (сом / som), never ruble', () => {
    const priceKeys = ['price_drop', 'new_match'];
    for (const lang of ['RU', 'EN']) {
      for (const key of priceKeys) {
        const { body } = render(lang, key, {
          makeModel: 'Toyota Camry',
          price: 15000,
          oldPrice: 20000,
          newPrice: 15000,
        });
        expect(body).not.toMatch(/руб|₽|ruble|rouble/i);
      }
    }
    // RU renders сом, EN renders som.
    expect(render('RU', 'price_drop', { makeModel: 'X', oldPrice: 20000, newPrice: 15000 }).body).toContain('сом');
    expect(render('EN', 'price_drop', { makeModel: 'X', oldPrice: 20000, newPrice: 15000 }).body).toContain('som');
  });

  test('render interpolates makeModel and som-formatted prices', () => {
    const { body } = render('EN', 'price_drop', { makeModel: 'Toyota Camry', oldPrice: 20000, newPrice: 15000 });
    expect(body).toContain('Toyota Camry');
    expect(body).toContain('15 000 som');
    expect(body).toContain('20 000 som');
  });
});
