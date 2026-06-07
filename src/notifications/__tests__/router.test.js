// Phase 12 — Wave 0 scaffold (NDOM-05 router auth model).
//
// Wiring require of the not-yet-built notification router (guarded; see
// guards.test.js header for the pattern rationale).
//
// VALIDATION map: NDOM-05 — the notification router is mounted behind verifyIdToken
// (NOT requireAdmin); every read/write filters by req.auth.uid (uid from the verified
// token, NEVER req.body.uid / req.params.uid — IDOR guard).

let router = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  router = require('../router');
} catch (err) {
  moduleLoadError = err;
}

describe('NDOM-05 notification router (Wave 0 scaffold)', () => {
  test('router wiring import is recorded for Wave 1', () => {
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void router;
  });

  test.todo('uid is taken from req.auth.uid, never from body/params (IDOR guard)');
  test.todo('router is NOT admin-gated (no requireAdmin); a non-admin token reaches the feed');
  test.todo('a notification belonging to another uid is not returned (ownership filter)');
});
