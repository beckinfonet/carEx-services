// src/moderation/listingRouter.js
//
// Admin listing-moderation router. Mounted in server.js under
// app.use('/api/admin/moderation/listings', verifyIdToken, requireAdmin, listingModerationRateLimiter, listingModerationRouter)
// so every route below runs AFTER Firebase-idToken verification, AdminUser check,
// AND the listing-prefixed rate-limit bucket (Phase 7 D-03).
//
// DIVERGENCE FROM v1.0 router.js: the rate limiter is mounted at APP LEVEL in
// server.js (D-03), NOT at router level via router.use(). This keeps this file
// dependency-free at the Phase 7 boundary (D-01) — no listingRateLimit import,
// no service import, no schema import, no model import. Real endpoint handlers
// (Edit / Suspend / Archive / Soft-Delete / Restore) arrive in Phase 8 and will
// import their service + schemas modules then; Phase 7 ships only the /ping
// scaffold so the LSEC-01/02/03 acceptance shells can exercise the full
// middleware chain end-to-end before any real handler exists.

const express = require('express');

// Phase 8 Plan 02 (LADM-02): wire the Suspend route. Adds 3 module-level
// requires — service / schemas / self-moderation middleware. NO multer
// `upload` import here: per D-D-1 multer mounts ONLY on the Edit route
// (Plan 08-06 lands `upload` alongside the Edit route).
const service = require('./listingService');
const schemas = require('./listingSchemas');
const { denySelfModerationListing } = require('./denySelfModerationListing');

const router = express.Router();

// Known service-layer error codes that listingService.js throws. Anything
// outside this set bubbles up as 500 internal_error via handleListingServiceError
// (D-03 + Pitfall 1 — keep the registry full so downstream Wave 2/3 plans don't
// have to amend it; they just start throwing the code).
const KNOWN_LISTING_ERRORS = new Set([
  'listing_not_found',           // 08-02 (Suspend) + 08-03..08-06
  'invalid_transition',          // forward-compat per D-B-2; v1.1 never emits — reserved for future restricted-matrix super-admin tier
  'already_in_state',            // 08-02 (Suspend) + 08-03 (Archive)
  'not_moderated',               // 08-05 (Restore) — fires when target is already 'active'
  'invalid_field',               // 08-06 (Edit) — unknown field in admin Edit payload
  'no_changes',                  // 08-06 (Edit) — no-op submit
  'invalid_payload',             // service-level defensive guard (router-level Zod is the first wall)
  'cannot_moderate_own_listing', // denySelfModerationListing middleware
  'invalid_make',                // 08-06 (Edit) — makeId not found
  'invalid_model',               // 08-06 (Edit) — modelId not found
]);

function handleListingServiceError(err, res, tag) {
  // err.code is the canonical signal (set by ListingServiceError constructor);
  // fall back to err.message so a plain Error thrown by accident still hits the
  // KNOWN set lookup with reasonable behavior.
  const code = err.code || err.message;
  if (KNOWN_LISTING_ERRORS.has(code)) {
    const body = { error: code };
    // D-05 enrichment for Edit's invalid_field: surface offending field names
    // so the mobile UI can highlight them.
    if (code === 'invalid_field' && Array.isArray(err.fields)) {
      body.fields = err.fields;
    }
    return res.status(400).json(body);
  }
  // eslint-disable-next-line no-console
  console.error(`[listing-moderation] ${tag} error:`, err);
  return res.status(500).json({ error: 'internal_error', message: err.message });
}

// Phase 7 scaffold route — preserves the v1.0 /ping contract so the
// LSEC-01/02 middleware test and LSEC-03 rate-limit test can drive the full
// auth chain through a real Express route. Returns { ok: true } byte-identical
// to the v1.0 user-mod /ping response.
router.get('/ping', (req, res) => {
  res.json({ ok: true });
});

// Phase 8 Plan 02 (LADM-02): PATCH /:carId/suspend
// Mount order: denySelfModerationListing first (sellerId === adminUid → 400
// cannot_moderate_own_listing), then handler. JSON body only (D-D-1 — multer
// joins on the Edit route only). suspendListingSchema is .strict() so unknown
// top-level keys reject as invalid_payload at parse time.
router.patch('/:carId/suspend', denySelfModerationListing, async (req, res) => {
  const parsed = schemas.suspendListingSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const result = await service.suspendListing({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      carId: req.params.carId,
      reasonCategory: parsed.data.reasonCategory,
      note: parsed.data.note,
    });
    return res.json({ ok: true, listing: result.listing, action: result.action });
  } catch (err) {
    return handleListingServiceError(err, res, 'suspend');
  }
});

// Phase 8 Plan 03 (LADM-03): PATCH /:carId/archive
// Same middleware composition as Suspend (denySelfModerationListing first,
// JSON body only — D-D-1 multer joins only on Edit). archiveListingSchema is
// .strict() so unknown top-level keys reject as invalid_payload at parse time.
// inactive_seller is the canonical Archive reason but schema permits any
// reasonCategory value (D-A-1 — admin discretion; no category-to-action map).
router.patch('/:carId/archive', denySelfModerationListing, async (req, res) => {
  const parsed = schemas.archiveListingSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const result = await service.archiveListing({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      carId: req.params.carId,
      reasonCategory: parsed.data.reasonCategory,
      note: parsed.data.note,
    });
    return res.json({ ok: true, listing: result.listing, action: result.action });
  } catch (err) {
    return handleListingServiceError(err, res, 'archive');
  }
});

// Phase 8 Plan 04 (LADM-04): PATCH /:carId/delete
// Same middleware composition as Suspend/Archive (denySelfModerationListing
// first, JSON body only — D-D-1 multer joins only on Edit). deleteListingSchema
// is .strict() so unknown top-level keys reject as invalid_payload at parse
// time. LADM-04 invariant: this is a SOFT-delete — the service flips
// Car.status to 'deleted'; the document is NOT removed from MongoDB.
router.patch('/:carId/delete', denySelfModerationListing, async (req, res) => {
  const parsed = schemas.deleteListingSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const result = await service.deleteListing({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      carId: req.params.carId,
      reasonCategory: parsed.data.reasonCategory,
      note: parsed.data.note,
    });
    return res.json({ ok: true, listing: result.listing, action: result.action });
  } catch (err) {
    return handleListingServiceError(err, res, 'delete');
  }
});

// Phase 8 Plan 05 (LADM-05): PATCH /:carId/restore
// Same middleware composition as Suspend/Archive/Delete (denySelfModerationListing
// first — D-04 applies even on Restore; admin can't restore their own listing).
// JSON body only (D-D-1 — multer joins only on Edit). restoreListingSchema is
// .strict() and accepts ONLY { note? } — no reasonCategory (D-C symmetry).
// The dispatch object intentionally OMITS any reasonCategory field; the service
// signature has no reasonCategory parameter. Restore on already-active throws
// not_moderated (Pitfall 10 — distinct from the cross-action no-op code).
router.patch('/:carId/restore', denySelfModerationListing, async (req, res) => {
  const parsed = schemas.restoreListingSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const result = await service.restoreListing({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      carId: req.params.carId,
      note: parsed.data.note,
    });
    return res.json({ ok: true, listing: result.listing, action: result.action });
  } catch (err) {
    return handleListingServiceError(err, res, 'restore');
  }
});

module.exports = router;
