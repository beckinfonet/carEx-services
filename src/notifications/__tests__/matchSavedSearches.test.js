// Phase 12 — Wave 1 (NDOM-04 saved-search matching).
//
// VALIDATION map: NDOM-04 — matchSavedSearches is a pure function matching a new
// listing against active saved_search subscriptions by ObjectId make/model +
// numeric bounds + bodyType (Pitfall 5: ids are ObjectId, NOT name strings).
//
// These cases drive the matcher via the injectable `findSavedSearches` dep so the
// numeric/ObjectId filtering logic is exercised with zero DB I/O (pure-export
// discipline, capabilities.js analog).

const mongoose = require('mongoose');
const matchSavedSearches = require('../matchSavedSearches');

const makeA = new mongoose.Types.ObjectId();
const makeB = new mongoose.Types.ObjectId();
const modelA = new mongoose.Types.ObjectId();
const modelB = new mongoose.Types.ObjectId();

// A representative new listing.
const car = {
  _id: new mongoose.Types.ObjectId(),
  makeId: makeA,
  modelId: modelA,
  price: 15000,
  year: 2018,
  bodyType: 'sedan',
};

// Helper: build a saved_search subscription with the given criteria.
function sub(criteria, extra = {}) {
  return { _id: new mongoose.Types.ObjectId(), kind: 'saved_search', active: true, criteria, ...extra };
}

// Inject the candidate set directly (the model query is replaced).
function withCandidates(...subs) {
  return { findSavedSearches: async () => subs };
}

describe('NDOM-04 matchSavedSearches', () => {
  test('matches when criteria.makeId/modelId (ObjectId) equal the listing make/model', async () => {
    const match = sub({ makeId: makeA, modelId: modelA });
    const result = await matchSavedSearches(car, withCandidates(match));
    expect(result.map((s) => s._id.toString())).toEqual([match._id.toString()]);
  });

  test('does NOT match when makeId is a name string (Pitfall 5 regression guard)', async () => {
    // Legacy/injected criteria storing a make NAME instead of an ObjectId must never
    // match an ObjectId car.makeId.
    const nameStringSub = sub({ makeId: 'Toyota', modelId: 'Camry' });
    const result = await matchSavedSearches(car, withCandidates(nameStringSub));
    expect(result).toEqual([]);
  });

  test('does NOT match a different make/model', async () => {
    const otherMake = sub({ makeId: makeB, modelId: modelB });
    const result = await matchSavedSearches(car, withCandidates(otherMake));
    expect(result).toEqual([]);
  });

  test('respects priceMin/priceMax numeric bounds', async () => {
    const inRange = sub({ makeId: makeA, modelId: modelA, priceMin: 10000, priceMax: 20000 });
    const tooHigh = sub({ makeId: makeA, modelId: modelA, priceMax: 14000 });
    const tooLow = sub({ makeId: makeA, modelId: modelA, priceMin: 16000 });
    const result = await matchSavedSearches(car, withCandidates(inRange, tooHigh, tooLow));
    expect(result.map((s) => s._id.toString())).toEqual([inRange._id.toString()]);
  });

  test('absent priceMax does not filter the upper bound (wildcard)', async () => {
    const noUpper = sub({ makeId: makeA, modelId: modelA, priceMin: 1000 }); // priceMax absent
    const result = await matchSavedSearches(car, withCandidates(noUpper));
    expect(result).toHaveLength(1);
  });

  test('respects yearMin/yearMax numeric bounds', async () => {
    const inRange = sub({ makeId: makeA, modelId: modelA, yearMin: 2015, yearMax: 2020 });
    const tooOld = sub({ makeId: makeA, modelId: modelA, yearMax: 2017 });
    const tooNew = sub({ makeId: makeA, modelId: modelA, yearMin: 2019 });
    const result = await matchSavedSearches(car, withCandidates(inRange, tooOld, tooNew));
    expect(result.map((s) => s._id.toString())).toEqual([inRange._id.toString()]);
  });

  test('respects bodyType filter', async () => {
    const matchBody = sub({ makeId: makeA, modelId: modelA, bodyType: 'sedan' });
    const wrongBody = sub({ makeId: makeA, modelId: modelA, bodyType: 'suv' });
    const result = await matchSavedSearches(car, withCandidates(matchBody, wrongBody));
    expect(result.map((s) => s._id.toString())).toEqual([matchBody._id.toString()]);
  });

  test('absent criteria fields are wildcards (empty criteria matches any car)', async () => {
    const wildcard = sub({});
    const result = await matchSavedSearches(car, withCandidates(wildcard));
    expect(result).toHaveLength(1);
  });

  test('only considers active saved_search subscriptions', async () => {
    const inactive = sub({ makeId: makeA, modelId: modelA }, { active: false });
    const result = await matchSavedSearches(car, withCandidates(inactive));
    expect(result).toEqual([]);
  });

  test('returns [] for a null car', async () => {
    const result = await matchSavedSearches(null, withCandidates(sub({})));
    expect(result).toEqual([]);
  });
});
