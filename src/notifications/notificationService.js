// src/notifications/notificationService.js
//
// NDOM-03: the notification emit() engine. This is the SECURITY-CRITICAL layer.
//
// ============================================================================
// HIDE-HOOK INVERSION — READ THIS BEFORE TOUCHING emit() (RESEARCH §Pattern 2)
// ============================================================================
// Everywhere ELSE in this codebase, admin/system code reads Cars WITH the hide-hook
// bypass query options (set via the query options API) to SEE hidden listings.
// emit() does the
// OPPOSITE: it uses a PLAIN `Car.findById(carId)` so the Phase 3/9 pre(/^find/)
// hide-hooks APPLY. If the listing's seller is non-active / not APPROVED, or the
// listing's status !== 'active' (suspended/archived/deleted), the plain findById
// returns null (or a non-active doc) and emit() SUPPRESSES the notification. This is
// a TOCTOU re-check at send time: the car may have been hidden between the triggering
// event and emit (Pitfall 1 / T-12-03-01).
//
// THEREFORE: NEVER add the seller/listing-status hide-hook bypass options to the
// findById in this file. A grep gate (acceptance criteria) asserts ZERO bypass flag
// names appear in this source file.
// ============================================================================
//
// emit(event) guard sequence:
//   (a) hide-hook re-read   — plain Car.findById; suppress on null/non-active.
//   (b) target resolution   — new_listing → matchSavedSearches; watch events →
//                             Subscription.find({kind:'watch',carId,active:true})
//                             filtered by the sub's `events` array.
//   (c) actor-exclusion     — drop subs where sub.uid === event.actorUid (T-12-03-02).
//   (d) price-direction     — price_drop only proceeds when newPrice < oldPrice.
//   (e) dedup               — dedupeKey = `${carId}:${eventType}`; at most one unread
//                             row per (uid, carId, eventType) (T-12-03-03).
//
// Each written Notification row carries titleKey/bodyKey/params (NOT rendered text,
// T-12-03-05) and a routable data.deeplink (see buildDeeplink).

const mongoose = require('mongoose');
const defaultMatchSavedSearches = require('./matchSavedSearches');
const defaultFcm = require('./push/fcm');

// Watch event families (per-car follow). new_listing is the saved-search family.
const WATCH_EVENTS = ['price_drop', 'booked', 'sold', 'back_available'];

// Resolve a mongoose query OR a test stub. Production models return a Query with
// .lean(); injected unit-test stubs may return a plain value/Promise. This keeps the
// service production-correct (uses .lean()) while staying DB-free in unit tests.
async function resolveQuery(maybeQuery) {
  const q = await maybeQuery;
  if (q && typeof q.lean === 'function') return q.lean();
  return q;
}

// Map an emit event type to the i18n title/body keys stored on the Notification row.
const KEYS_BY_EVENT = {
  new_listing: { titleKey: 'new_match', bodyKey: 'new_match' },
  price_drop: { titleKey: 'price_drop', bodyKey: 'price_drop' },
  booked: { titleKey: 'booked', bodyKey: 'booked' },
  sold: { titleKey: 'sold', bodyKey: 'sold' },
  back_available: { titleKey: 'back_available', bodyKey: 'back_available' },
};

// Build the makeModel param from a car for the notification body.
function makeModelLabel(car) {
  const make = car.makeName || car.make || '';
  const model = car.modelName || car.model || '';
  return `${make} ${model}`.trim();
}

// WATCH-family deeplink → CarDetails. Routes to the single car.
//   carex://listing/:carId   (maps to App.tsx linking `CarDetails: 'listing/:carId'`)
function buildWatchDeeplink(carId) {
  return `carex://listing/${carId}`;
}

// NEW_MATCH deeplink → SearchResults, carrying the SUBSCRIPTION's saved-search
// criteria (not the single car) so the tap lands on the filtered results.
//   carex://search?makeId=...&modelId=...&priceMin=...  (maps to App.tsx `SearchResults: 'search'`)
// Only non-null criteria fields are encoded; 12-08's tap handler reconstructs
// { initialQuery, initialFilters } from these discrete params.
function buildSearchDeeplink(criteria) {
  const params = new URLSearchParams();
  if (!criteria) return 'carex://search';
  const fields = ['makeId', 'modelId', 'priceMin', 'priceMax', 'yearMin', 'yearMax', 'bodyType'];
  for (const f of fields) {
    const v = criteria[f];
    if (v != null && v !== '') params.set(f, String(v));
  }
  const qs = params.toString();
  return qs ? `carex://search?${qs}` : 'carex://search';
}

// Resolve the targets for an event:
//   - new_listing → matched saved_search subs (each carries its own criteria deeplink)
//   - watch event → active watch subs for the car whose events[] includes the type
// Returns [{ sub, deeplink, data }] target descriptors.
async function resolveTargets(event, car, deps) {
  const eventType = event.type;

  if (eventType === 'new_listing') {
    const matchSavedSearches = deps.matchSavedSearches || defaultMatchSavedSearches;
    const subs = await matchSavedSearches(car, deps);
    return subs.map((sub) => ({
      sub,
      eventType: 'new_match', // saved-search hits are surfaced as new_match
      deeplink: buildSearchDeeplink(sub.criteria),
      data: {
        deeplink: buildSearchDeeplink(sub.criteria),
        carId: null,
        searchId: sub._id ? sub._id.toString() : null,
      },
    }));
  }

  if (WATCH_EVENTS.includes(eventType)) {
    const Subscription = deps.Subscription || mongoose.model('Subscription');
    const carId = event.carId;
    const watchSubs = await resolveQuery(Subscription.find({ kind: 'watch', carId, active: true }));
    return (watchSubs || [])
      .filter((sub) => Array.isArray(sub.events) && sub.events.includes(eventType))
      .map((sub) => ({
        sub,
        eventType,
        deeplink: buildWatchDeeplink(carId),
        data: {
          deeplink: buildWatchDeeplink(carId),
          carId: String(carId),
          searchId: null,
        },
      }));
  }

  return [];
}

/**
 * Emit notifications for a domain event.
 *
 * Event shapes:
 *   { type:'new_listing', carId, actorUid }
 *   { type:'price_drop',  carId, actorUid, oldPrice, newPrice }  // only if newPrice < oldPrice
 *   { type:'booked',      carId, actorUid }
 *   { type:'sold',        carId, actorUid }
 *   { type:'back_available', carId, actorUid }
 *
 * @param {object} event
 * @param {object} [deps] - injectable models/collaborators for testing:
 *        { Car, Subscription, Notification, matchSavedSearches, fcm }
 * @returns {Promise<object[]>} the Notification rows written (for assertions/observability).
 */
async function emit(event, deps = {}) {
  if (!event || !event.type) throw new Error('emit: event.type is required');

  const Car = deps.Car || mongoose.model('Car');
  const Notification = deps.Notification || mongoose.model('Notification');
  const fcm = deps.fcm || defaultFcm;
  const eventType = event.type;
  const carId = event.carId;

  // (d) price-direction: short-circuit a non-decrease BEFORE any reads/writes (NSUB-04).
  if (eventType === 'price_drop') {
    if (!(typeof event.newPrice === 'number' && typeof event.oldPrice === 'number' && event.newPrice < event.oldPrice)) {
      return [];
    }
  }

  // (a) hide-hook re-read — PLAIN findById, NO bypass flags. Suppress if hidden /
  //     non-active (TOCTOU; T-12-03-01).
  const visible = await Car.findById(carId);
  if (!visible || visible.status !== 'active') return [];

  // (b) resolve targets.
  const targets = await resolveTargets(event, visible, deps);

  // (c) actor-exclusion — never notify the actor who caused the event (T-12-03-02).
  const filtered = targets.filter((t) => t.sub && t.sub.uid && t.sub.uid !== event.actorUid);

  const makeModel = makeModelLabel(visible);
  const written = [];

  for (const target of filtered) {
    const uid = target.sub.uid;
    const rowEventType = target.eventType;
    const dedupeKey = `${carId}:${rowEventType}`;

    // (e) dedup — at most one UNREAD row per (uid, carId, eventType) (T-12-03-03).
    const existing = await resolveQuery(Notification.findOne({ uid, dedupeKey, read: false }));
    if (existing) continue;

    const params = { makeModel };
    if (eventType === 'price_drop') {
      params.oldPrice = event.oldPrice;
      params.newPrice = event.newPrice;
    } else if (rowEventType === 'new_match') {
      params.price = visible.price;
    }

    const keys = KEYS_BY_EVENT[eventType] || KEYS_BY_EVENT[rowEventType] || { titleKey: rowEventType, bodyKey: rowEventType };

    const cadence = target.sub.cadence || 'instant';

    const [row] = await Notification.create([{
      uid,
      kind: target.sub.kind,
      titleKey: keys.titleKey,
      bodyKey: keys.bodyKey,
      params,
      data: target.data,
      dedupeKey,
      digestPending: cadence === 'daily', // daily-cadence plumbing (delivery: Phase 14)
    }]);

    // instant cadence → fire the (no-op stub) push channel; daily → queued via digestPending.
    if (cadence === 'instant') {
      await fcm.send({ uid, title: keys.titleKey, data: target.data });
    }

    written.push(row);
  }

  return written;
}

module.exports = { emit, buildWatchDeeplink, buildSearchDeeplink, resolveTargets, WATCH_EVENTS };
