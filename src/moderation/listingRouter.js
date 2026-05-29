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
// requires — service / schemas / self-moderation middleware.
const service = require('./listingService');
const schemas = require('./listingSchemas');
const { denySelfModerationListing } = require('./denySelfModerationListing');

// Phase 8 Plan 06 (LADM-01): shared multer-S3 upload instance from
// src/uploads/carImages.js. Effective middleware on the Edit route is
// upload.array('images', 25) — D-D-1 mounts multer ONLY on the Edit route.
//
// LAZY-REQUIRED — module-top `require('../uploads/carImages')` triggers
// multer-S3 construction which throws "bucket is required" when
// AWS_BUCKET_NAME isn't set (the case in every existing
// __tests__/listing-moderation/* test that loads listingRouter — e.g. the
// Phase 7 listingModerationRateLimiter test). The require lives inside
// getUpload() so the carImages module is loaded only on first PATCH /:carId
// request (production has AWS creds) while the rest of the router (the 4
// JSON-only routes + /ping) stays loadable in test environments without
// AWS credentials.
let _uploadCache;
function getUpload() {
  if (!_uploadCache) {
    _uploadCache = require('../uploads/carImages').upload;
  }
  return _uploadCache;
}
// Edit-route multipart middleware: delegates to upload.array('images', 25)
// from the lazy-loaded carImages module. Express middleware shape (req, res,
// next) → calling the returned multer middleware closure.
function uploadImages(req, res, next) {
  return getUpload().array('images', 25)(req, res, next);
}

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

// Phase 8 Plan 06 (LADM-01): PATCH /:carId — admin Edit endpoint.
//
// Middleware order is LOAD-BEARING:
//   1. upload.array('images', 25) FIRST — multer parses the multipart body and
//      populates req.body + req.files. Anything downstream that reads req.body
//      (Zod schema, service call) needs multer to have run first. For
//      JSON-only routes (Suspend/Archive/Delete/Restore) multer would only get
//      in the way; D-D-1 mounts multer ONLY on this route.
//   2. denySelfModerationListing SECOND — self-mod check fires AFTER multer.
//      The middleware reads req.params.carId (which Express populates from
//      the route pattern before either middleware runs), not req.body, so
//      the ordering is safe. A self-moderating admin pays the cost of one
//      multipart parse + S3 upload before getting rejected — same cost the
//      seller-PUT pays for the self-PUT case.
//
// Zod unknown-key handling (D-A-1): editListingSchema is .strict() so unknown
// top-level keys produce an `unrecognized_keys` issue with `keys: [...]` on
// the issue itself. Translate to 400 invalid_field with `fields: [...]` so
// the mobile UI can highlight offending fields (mirrors v1.0 router.js:183-212).
// Other Zod failures fall through to 400 invalid_payload with the full issues
// array.
router.patch(
  '/:carId',
  // uploadImages = upload.array('images', 25), lazy-required from
  // ../uploads/carImages to defer multer-S3 construction until
  // production runtime (test envs lack AWS_BUCKET_NAME).
  uploadImages,
  denySelfModerationListing,
  async (req, res) => {
  const parsed = schemas.editListingSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const unknownIssue = parsed.error.issues.find((i) => i.code === 'unrecognized_keys');
    if (unknownIssue) {
      return res.status(400).json({ error: 'invalid_field', fields: unknownIssue.keys || [] });
    }
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const result = await service.editListing({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      carId: req.params.carId,
      fields: parsed.data,
      uploadedFiles: req.files || [],
    });
    return res.json({ ok: true, listing: result.listing, action: result.action });
  } catch (err) {
    return handleListingServiceError(err, res, 'editListing');
  }
});

module.exports = router;
