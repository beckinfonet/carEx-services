// Phase 12 — Wave 0 scaffold (NI18N-03 backend translation parity).
//
// Mirrors the mobile __tests__/translation-parity.test.ts harness (set-equality,
// non-empty leaf, placeholder-token parity) for the NEW backend translations map
// src/notifications/translations.js. Currency must read as KGS som (NI18N-03 /
// audience-tone memory), never ruble.
//
// Wiring require of the not-yet-built translations map (guarded so the file is
// collectible in Wave 0; Wave 1 builds translations.js and flips the todos to real
// set-equality + som assertions).

let TRANSLATIONS = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  TRANSLATIONS = require('../src/notifications/translations');
} catch (err) {
  moduleLoadError = err;
}

describe('NI18N-03 backend notification translations parity (Wave 0 scaffold)', () => {
  test('translations wiring import is recorded for Wave 1', () => {
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void TRANSLATIONS;
  });

  // Set-equality (NOT a hardcoded key count) per S7(b).
  test.todo('RU and EN key sets are identical (set-equality)');
  test.todo('every value is a non-empty string');
  test.todo('placeholder tokens ({param}) are identical across RU and EN per key');
  // KGS som currency assertion (NI18N-03) — Kyrgyzstan audience uses som / сом / KGS,
  // never ruble. This todo names the assertion that Wave 1 must implement.
  test.todo('currency strings render KGS som (сом / KGS), never ruble');
});
