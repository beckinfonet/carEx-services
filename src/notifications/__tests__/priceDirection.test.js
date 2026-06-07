// Phase 12 — Wave 0 scaffold (NSUB-04 price-drop direction check).
//
// Wiring require of the not-yet-built notificationService (guarded; see
// guards.test.js header for the pattern rationale).
//
// VALIDATION map: NSUB-04 — price_drop is emitted ONLY when newPrice < oldPrice.
// A price increase or unchanged price emits nothing.

let notificationService = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  notificationService = require('../notificationService');
} catch (err) {
  moduleLoadError = err;
}

describe('NSUB-04 price-drop direction (Wave 0 scaffold)', () => {
  test('notificationService wiring import is recorded for Wave 1', () => {
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void notificationService;
  });

  test.todo('newPrice < oldPrice → price_drop emitted to watchers');
  test.todo('newPrice > oldPrice → no notification');
  test.todo('newPrice === oldPrice → no notification');
});
