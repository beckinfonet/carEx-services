// Phase 12 — Wave 0 scaffold (NCEN-02 cursor pagination).
//
// Wiring require of the not-yet-built notification router (guarded; see
// guards.test.js header for the pattern rationale). The base64 {createdAt,_id}
// cursor helpers are copied verbatim from src/moderation/router.js in Wave 1.
//
// VALIDATION map: NCEN-02 — base64-encoded {createdAt,_id} cursor; reverse-chron
// pages do not overlap or skip; a malformed cursor returns 400 invalid_cursor.

let router = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  router = require('../router');
} catch (err) {
  moduleLoadError = err;
}

describe('NCEN-02 feed cursor pagination (Wave 0 scaffold)', () => {
  test('router wiring import is recorded for Wave 1', () => {
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void router;
  });

  test.todo('first page returns limit items + a base64 nextCursor');
  test.todo('second page (with cursor) continues reverse-chron with no overlap/skip');
  test.todo('last page returns nextCursor: null when no more rows');
  test.todo('malformed/undecodable cursor → 400 invalid_cursor');
});
