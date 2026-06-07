// Phase 12 — Wave 0 scaffold (NI18N-01 PUT /api/users/:uid accepts language).
//
// Wiring require of the User model (which already exists — Task 2 added the
// language enum field) so this scaffold's import is satisfied at collect time.
// The PUT /api/users/:uid handler edit (whitelisting `language`) lands in a later
// plan; the integration assertions stay as test.todo until then.
//
// VALIDATION map: NI18N-01 — PUT /api/users/:uid accepts a `language` field
// constrained to the RU/EN enum; an out-of-enum value is rejected/ignored.

const User = require('../src/models/User');

describe('NI18N-01 user language (Wave 0 scaffold)', () => {
  test('User model carries the language field (Task 2 wiring check)', () => {
    const path = User.schema.path('language');
    expect(path).toBeDefined();
    expect(path.options.enum).toEqual(['RU', 'EN']);
    expect(path.options.default).toBe('RU');
  });

  test.todo('PUT /api/users/:uid with { language: "EN" } persists language = EN');
  test.todo('PUT /api/users/:uid with an out-of-enum language is rejected/ignored');
  test.todo('language is not required and defaults to RU for legacy users');
});
