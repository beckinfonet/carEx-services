// Phase 12 — Wave 0 scaffold (NDOM-03c dedup).
//
// Wiring require of the not-yet-built notificationService (guarded; see
// guards.test.js header for the pattern rationale).
//
// VALIDATION map: NDOM-03c — dedupeKey = `${carId}:${eventType}`; at most one alert
// per (uid, carId, eventType). 3 rapid edits → ≤1 alert per watcher.

let notificationService = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  notificationService = require('../notificationService');
} catch (err) {
  moduleLoadError = err;
}

describe('NDOM-03c dedup (Wave 0 scaffold)', () => {
  test('notificationService wiring import is recorded for Wave 1', () => {
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void notificationService;
  });

  test.todo('dedupeKey is set to `${carId}:${eventType}`');
  test.todo('3 edits of the same car/event → at most 1 notification per watcher (uid,carId,eventType)');
  test.todo('different eventType for the same car is NOT deduped (separate dedupeKey)');
});
