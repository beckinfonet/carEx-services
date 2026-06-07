// Phase 12 — Wave 0 scaffold (NDOM-04 saved-search matching).
//
// Wiring require of the not-yet-built matchSavedSearches pure module (guarded; see
// guards.test.js header for the pattern rationale).
//
// VALIDATION map: NDOM-04 — matchSavedSearches is a pure function matching a new
// listing against active saved_search subscriptions by ObjectId make/model +
// numeric bounds + bodyType (Pitfall 5: ids are ObjectId, NOT name strings).

let matchSavedSearches = null;
let moduleLoadError = null;
try {
  // eslint-disable-next-line global-require
  matchSavedSearches = require('../matchSavedSearches');
} catch (err) {
  moduleLoadError = err;
}

describe('NDOM-04 matchSavedSearches (Wave 0 scaffold)', () => {
  test('matchSavedSearches wiring import is recorded for Wave 1', () => {
    expect(moduleLoadError === null || moduleLoadError.code === 'MODULE_NOT_FOUND').toBe(true);
    void matchSavedSearches;
  });

  test.todo('matches when criteria.makeId/modelId (ObjectId) equal the listing make/model');
  test.todo('does NOT match when makeId is a name string (Pitfall 5 regression guard)');
  test.todo('respects priceMin/priceMax numeric bounds');
  test.todo('respects yearMin/yearMax numeric bounds');
  test.todo('respects bodyType filter');
  test.todo('only considers active saved_search subscriptions');
});
