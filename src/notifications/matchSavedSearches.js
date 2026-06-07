// src/notifications/matchSavedSearches.js
//
// NDOM-04: pure saved-search matcher. Given a newly-active Car, return the active
// saved_search Subscriptions whose criteria the car satisfies.
//
// Shape mirrors src/moderation/capabilities.js: a small, dependency-light module
// whose export surface is a pure function. The ONLY I/O is the indexed Subscription
// query, which is INJECTABLE (pass `{ Subscription }` or a `findSavedSearches` fn)
// so unit tests can drive the numeric/ObjectId filtering logic without a DB. Default
// resolution lazily requires the real model (mongoose singleton) so production
// callers just call matchSavedSearches(car).
//
// PITFALL 5 (NDOM-04): criteria.makeId/modelId are ObjectId in the model and
// car.makeId/modelId are ObjectId on the Car. We compare via ObjectId .equals so a
// NAME-STRING makeId (legacy / injected) can NEVER match an ObjectId car — a string
// will not .equals() an ObjectId and is rejected by toObjectIdOrNull. Do not relax
// this to == / String() coercion.
//
// Off the hot path (Pitfall 8): the indexed query narrows by kind+active+make+model;
// numeric-bound + bodyType filtering runs in JS over that small candidate set.

const mongoose = require('mongoose');

// Coerce a value to an ObjectId if (and only if) it is a real 24-byte ObjectId or a
// 24-hex string. A make/model NAME string ('Toyota') returns null → never matches.
function toObjectIdOrNull(value) {
  if (value == null) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  // A 24-char hex string is a valid ObjectId; anything else (a name) is rejected.
  if (typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return null;
}

function objectIdEquals(a, b) {
  const oa = toObjectIdOrNull(a);
  const ob = toObjectIdOrNull(b);
  if (!oa || !ob) return false;
  return oa.equals(ob);
}

// A criteria numeric bound is a wildcard when null/undefined.
function withinLowerBound(min, value) {
  if (min == null) return true;
  return typeof value === 'number' && value >= min;
}
function withinUpperBound(max, value) {
  if (max == null) return true;
  return typeof value === 'number' && value <= max;
}

// JS-side predicate applied to each candidate saved_search subscription.
function carSatisfiesCriteria(car, criteria) {
  if (!criteria) return false;

  // make/model: when the subscription pins an id, it MUST equal the car's id
  // (ObjectId compare). When absent, it is a wildcard.
  if (criteria.makeId != null && !objectIdEquals(criteria.makeId, car.makeId)) return false;
  if (criteria.modelId != null && !objectIdEquals(criteria.modelId, car.modelId)) return false;

  // price bounds (KGS som amounts).
  if (!withinLowerBound(criteria.priceMin, car.price)) return false;
  if (!withinUpperBound(criteria.priceMax, car.price)) return false;

  // year bounds.
  if (!withinLowerBound(criteria.yearMin, car.year)) return false;
  if (!withinUpperBound(criteria.yearMax, car.year)) return false;

  // bodyType: when present, must match exactly.
  if (criteria.bodyType != null && car.bodyType !== criteria.bodyType) return false;

  return true;
}

/**
 * Resolve active saved_search subscriptions matching a car.
 *
 * @param {object} car - a Car-like object with makeId/modelId (ObjectId), price, year, bodyType.
 * @param {object} [deps]
 * @param {object} [deps.Subscription] - the Subscription model (defaults to mongoose singleton).
 * @param {Function} [deps.findSavedSearches] - async (car) => candidate subscriptions[]
 *        (overrides the model query entirely; used for pure unit tests).
 * @returns {Promise<object[]>} matching saved_search subscription documents.
 */
async function matchSavedSearches(car, deps = {}) {
  if (!car) return [];

  let candidates;
  if (typeof deps.findSavedSearches === 'function') {
    candidates = await deps.findSavedSearches(car);
  } else {
    const Subscription = deps.Subscription || mongoose.model('Subscription');
    // Indexed scan: kind + active + criteria make/model. We do NOT push the numeric
    // bounds into the query (they are sparse/optional and the candidate set is small);
    // JS filtering keeps the matcher pure + Pitfall-5-safe (ObjectId compare in JS).
    candidates = await Subscription.find({ kind: 'saved_search', active: true }).lean();
  }

  return (candidates || []).filter((sub) => sub && sub.active !== false && carSatisfiesCriteria(car, sub.criteria));
}

module.exports = matchSavedSearches;
module.exports.carSatisfiesCriteria = carSatisfiesCriteria;
module.exports.objectIdEquals = objectIdEquals;
module.exports.toObjectIdOrNull = toObjectIdOrNull;
