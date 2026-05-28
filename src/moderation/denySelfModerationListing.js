// src/moderation/denySelfModerationListing.js
//
// Express middleware. Listing-specific variant of v1.0 denySelfModeration.js
// (D-04). Reads req.params.carId → Car.findById(carId).setOptions({
// includeAllListingStatuses: true, includeAllUsers: true }).select('sellerId')
// → if car.sellerId === req.admin.uid, returns 400 cannot_moderate_own_listing.
//
// Differences from v1.0 sibling:
//   - v1.0 compares param-to-param (req.params.targetUid === req.admin.uid)
//     because the target's UID IS the URL param. Phase 8 must FETCH the Car
//     to discover sellerId — the listing's owner UID is not in the URL.
//   - async (does a DB read) vs. v1.0 sync.
//   - Car not found → 404 listing_not_found (D-04 explicit: do NOT leak
//     existence by always returning the self-mod code).
//   - Read chains BOTH setOptions bypass flags (Phase 9 forward-compat for
//     the listing-status hide hook + existing seller-cascade hook bypass) so
//     admin can moderate listings regardless of seller or listing state.
//
// Mounted PER-ROUTE on all 5 listing-moderation routes uniformly (Edit + 4
// transitions, INCLUDING Restore — admin cannot restore their own listing
// after another admin moderated it; same conflict-of-interest as v1.0).
//
// Rejected attempts are logged via console.warn (D-05). Audit log
// (ListingModerationAction) is reserved for SUCCESSFUL state changes.

const Car = require('../models/Car');

async function denySelfModerationListing(req, res, next) {
  const carId = req.params && req.params.carId;
  const adminUid = req.admin && req.admin.uid;

  // Defensive: if either is missing, fall through. Upstream middleware
  // (requireAdmin) is responsible for guaranteeing req.admin.uid; the route
  // definition is responsible for the :carId param. This middleware only
  // enforces the seller-equality rule.
  if (!carId || !adminUid) {
    return next();
  }

  try {
    // Cheap projection — only need sellerId to compare. BOTH setOptions
    // bypass flags chained so this read survives the existing seller-cascade
    // hide hook (Car.js:63-95) AND the future Phase 9 listing-status hide
    // hook without retroactive edits.
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .select('sellerId')
      .lean();

    // D-04: do not leak existence by returning the self-mod code.
    // 404 listing_not_found is the explicit branch.
    if (!car) {
      return res.status(404).json({ error: 'listing_not_found' });
    }

    if (car.sellerId === adminUid) {
      // D-05: log-only, NOT ListingModerationAction.create. Audit ledger is
      // for successful state changes, not rejected attempts.
      // eslint-disable-next-line no-console
      console.warn(
        `[listing-moderation] denied self-moderation attempt by ${adminUid} on listing ${carId} (sellerId=${car.sellerId}) at ${new Date().toISOString()}`
      );
      return res.status(400).json({ error: 'cannot_moderate_own_listing' });
    }

    return next();
  } catch (err) {
    // Unexpected DB failure — log and 500 so the caller knows it was not an
    // auth/policy decision. Do NOT pass to next(err) — keeping the response
    // shape uniform with the 400/404 branches (the handler chain expects
    // this middleware to either next() or terminate the response itself).
    // eslint-disable-next-line no-console
    console.error('[denySelfModerationListing] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = { denySelfModerationListing };
