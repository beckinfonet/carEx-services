// Phase 13 — Wave 0 (13-02 Task 1, NPUSH-08 / D-07 / D-08b).
//
// The SEPARATE generic push copy set (push_* keys) must:
//   - keep strict RU/EN parity (every push_* key present in both, vice versa);
//   - carry a category-specific TITLE + ONE canonical generic BODY per category
//     (D-07/D-08), for all five categories;
//   - contain ZERO interpolation tokens — no {makeModel}/{price}/{newPrice}/
//     {oldPrice}/ANY {...} placeholder — so make/model/price/seller/location can
//     NEVER reach the lock screen (D-08b PII hard-ban);
//   - render param-free via renderGenericPush(key, lang) → { title, body }.
//
// This MIRRORS the existing parity scanner in
// __tests__/notification-translations-parity.test.js and ADDS the no-PII-token
// assertion that is the heart of NPUSH-08.

const TRANSLATIONS = require('../src/notifications/translations');
const { renderGenericPush } = require('../src/notifications/translations');

// The five instant-notification categories (Phase 12 set; no new categories — D-defer).
const PUSH_CATEGORIES = ['new_match', 'price_drop', 'booked', 'sold', 'back_available'];
const PUSH_KEYS = PUSH_CATEGORIES.map((c) => `push_${c}`);

// Any {param} placeholder. The push set must contain NONE of these.
const ANY_TOKEN = /\{[^}]+\}/;
// The specific in-app PII tokens that are HARD-BANNED from push (D-08b).
const BANNED_TOKENS = ['{makeModel}', '{price}', '{newPrice}', '{oldPrice}'];

// Collect every push_* leaf string (title + body) for a language block.
function pushLeaves(langBlock) {
  const out = {};
  for (const key of Object.keys(langBlock)) {
    if (!key.startsWith('push_')) continue;
    const entry = langBlock[key];
    out[`${key}.title`] = entry.title;
    out[`${key}.body`] = entry.body;
  }
  return out;
}

const ru = pushLeaves(TRANSLATIONS.RU);
const en = pushLeaves(TRANSLATIONS.EN);

describe('NPUSH-08 generic push copy — parity', () => {
  test('every push_* key present in RU is present in EN, and vice versa', () => {
    const ruKeys = Object.keys(ru).sort();
    const enKeys = Object.keys(en).sort();
    expect(ruKeys).toEqual(enKeys);
  });

  test('all five categories have a push_* entry (RU and EN)', () => {
    for (const key of PUSH_KEYS) {
      expect(TRANSLATIONS.RU[key]).toBeDefined();
      expect(TRANSLATIONS.EN[key]).toBeDefined();
      // category-specific title + generic body, both non-empty strings.
      expect(typeof TRANSLATIONS.RU[key].title).toBe('string');
      expect(TRANSLATIONS.RU[key].title.trim().length).toBeGreaterThan(0);
      expect(typeof TRANSLATIONS.RU[key].body).toBe('string');
      expect(TRANSLATIONS.RU[key].body.trim().length).toBeGreaterThan(0);
      expect(typeof TRANSLATIONS.EN[key].title).toBe('string');
      expect(TRANSLATIONS.EN[key].title.trim().length).toBeGreaterThan(0);
      expect(typeof TRANSLATIONS.EN[key].body).toBe('string');
      expect(TRANSLATIONS.EN[key].body.trim().length).toBeGreaterThan(0);
    }
  });

  test('every push_* value is a non-empty string', () => {
    for (const [, v] of Object.entries({ ...ru, ...en })) {
      expect(typeof v).toBe('string');
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });

  test('category-specific TITLES differ across categories (not a single app-name line) — D-08', () => {
    const ruTitles = PUSH_KEYS.map((k) => TRANSLATIONS.RU[k].title);
    expect(new Set(ruTitles).size).toBe(PUSH_KEYS.length);
    const enTitles = PUSH_KEYS.map((k) => TRANSLATIONS.EN[k].title);
    expect(new Set(enTitles).size).toBe(PUSH_KEYS.length);
  });

  test('ONE canonical generic BODY per category — identical body text across the set (D-07)', () => {
    const ruBodies = new Set(PUSH_KEYS.map((k) => TRANSLATIONS.RU[k].body));
    expect(ruBodies.size).toBe(1);
    const enBodies = new Set(PUSH_KEYS.map((k) => TRANSLATIONS.EN[k].body));
    expect(enBodies.size).toBe(1);
  });
});

describe('NPUSH-08 / D-08b — push copy carries NO PII interpolation tokens', () => {
  test('no push_* title or body contains ANY {...} placeholder', () => {
    for (const [key, v] of Object.entries({ ...ru, ...en })) {
      expect(`${key}: ${v}`).not.toMatch(ANY_TOKEN);
    }
  });

  test('no push_* copy contains the banned in-app PII tokens', () => {
    for (const [key, v] of Object.entries({ ...ru, ...en })) {
      for (const banned of BANNED_TOKENS) {
        expect(`${key}: ${v}`).not.toContain(banned);
      }
    }
  });

  test('no push_* copy contains a KGS amount, seller identity, or location term', () => {
    // The generic bodies must not embed currency or identifying nouns.
    for (const [key, v] of Object.entries({ ...ru, ...en })) {
      expect(`${key}: ${v}`).not.toMatch(/сом|som|руб|₽/i);
    }
  });
});

describe('renderGenericPush — param-free render path', () => {
  test('returns { title, body } strings for each category in RU and EN', () => {
    for (const lang of ['RU', 'EN']) {
      for (const cat of PUSH_CATEGORIES) {
        const out = renderGenericPush(`push_${cat}`, lang);
        expect(typeof out.title).toBe('string');
        expect(typeof out.body).toBe('string');
        expect(out.title.trim().length).toBeGreaterThan(0);
        expect(out.body.trim().length).toBeGreaterThan(0);
        // and the rendered output ALSO carries no interpolation token.
        expect(out.title).not.toMatch(ANY_TOKEN);
        expect(out.body).not.toMatch(ANY_TOKEN);
      }
    }
  });

  test('accepts the bare category key (without push_ prefix) too', () => {
    const out = renderGenericPush('price_drop', 'RU');
    expect(out.title).toBe(TRANSLATIONS.RU.push_price_drop.title);
    expect(out.body).toBe(TRANSLATIONS.RU.push_price_drop.body);
  });

  test('falls back to RU for an unknown/absent language', () => {
    const out = renderGenericPush('push_sold', 'DE');
    expect(out.title).toBe(TRANSLATIONS.RU.push_sold.title);
  });

  test('throws on an unknown push key', () => {
    expect(() => renderGenericPush('push_does_not_exist', 'RU')).toThrow();
  });
});
