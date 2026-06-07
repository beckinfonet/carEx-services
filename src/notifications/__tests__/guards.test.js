// Phase 12 — Wave 0 scaffold (NDOM-03 emit guards: hide-hook suppression).
//
// Mirrors the Phase 5 Wave-0 pattern: the wiring `require` of the not-yet-built
// target module is the load-bearing part. Because notificationService.js does not
// exist yet, a top-level require would crash jest COLLECTION (not just fail a test).
// To keep this file collectible and reporting test.todo (the intended Wave-0 RED
// state), the require is guarded — it records whether the module resolved so Wave-1
// can flip these todos to real assertions once notificationService.js lands.
//
// VALIDATION map: NDOM-03 — suppress emit for a hidden/suspended/archived listing
// (plain Car.findById returns null → notificationService.emit produces 0 rows).

let notificationService = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  notificationService = require('../notificationService');
} catch (err) {
  moduleLoadError = err; // expected in Wave 0 (module not built yet)
}

describe('NDOM-03 emit guards — hide-hook suppression (Wave 0 scaffold)', () => {
  test('notificationService wiring import is recorded for Wave 1', () => {
    // Documents the intended import target. In Wave 0 the module may not yet exist;
    // Wave 1 builds it and removes this scaffold guard.
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void notificationService;
  });

  test.todo('plain Car.findById null (hidden seller) → emit produces 0 notifications');
  test.todo('listing status !== active (suspended/archived) → emit suppressed');
  test.todo('emit pipeline NEVER passes includeAllUsers / includeAllListingStatuses bypass flags');
});
