// Phase 12 — Wave 0 scaffold (NDOM-03b actor-exclusion).
//
// Wiring require of the not-yet-built notificationService (guarded so the file is
// collectible in Wave 0; see guards.test.js header for the pattern rationale).
//
// VALIDATION map: NDOM-03b — the actor who caused an event is never notified about
// it (seller editing their own price gets 0 self-notifications).

let notificationService = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  notificationService = require('../notificationService');
} catch (err) {
  moduleLoadError = err;
}

describe('NDOM-03b actor-exclusion (Wave 0 scaffold)', () => {
  test('notificationService wiring import is recorded for Wave 1', () => {
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void notificationService;
  });

  test.todo('subscription.uid === event.actorUid is dropped (seller self-edit → 0 notifs)');
  test.todo('other watchers (uid !== actorUid) still receive the notification');
});
