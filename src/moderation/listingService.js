// src/moderation/listingService.js
//
// Moderation service layer for LISTINGS (Phase 8). Each handler opens a
// Mongoose session and runs the audit-row insert + Car mutation inside a
// single session.withTransaction() so the pair is atomic (D-06, D-08).
//
// NOTE: We use ListingModerationAction.create([doc], { session }) — array
// form — because Mongoose's single-doc create(doc, { session }) silently
// ignores { session }, which would land the audit row OUTSIDE the
// transaction (Pitfall 2). Same idiom as v1.0 src/moderation/service.js.
//
// Wave 1 SCAFFOLDING: Each of the 5 exported handlers throws
// ListingServiceError('not_implemented'). Wave 2 plans (Suspend / Archive /
// Delete / Restore) and Wave 3 plan (Edit) replace the bodies with real
// implementations — they do not re-export or rename these handlers.
//
// Handler signatures match D-02's response shape contract:
//   { ok, listing: {...}, action: {...} }
//
// Per D-01:
//   - suspendListing/archiveListing/deleteListing accept { reasonCategory, note? }
//   - restoreListing accepts { note? } (no reasonCategory per D-C)
//   - editListing accepts { fields, uploadedFiles } per D-D multipart shape

const mongoose = require('mongoose');
const Car = require('../models/Car');
const ListingModerationAction = require('../models/ListingModerationAction');
const { ListingServiceError } = require('./listingErrors');

// Wave 1 placeholder bodies — Wave 2/3 plans fill these. The transaction
// pattern Wave 2/3 must follow lives in v1.0 src/moderation/service.js
// (`suspend` ~line 42-134 for transitions; `editProfile` ~line 438-530 for
// fieldDiff). Phase 8 specifics:
//   1. Read current Car with .setOptions({ includeAllListingStatuses: true })
//      OUTSIDE the transaction for fast-path same-state guard (D-B-1).
//   2. Open session, withTransaction:
//      a. Insert ListingModerationAction with { session } via array-form create.
//      b. Update Car (status + audit-stamp fields) with { session }.
//   3. session.endSession() in finally.

async function editListing({ adminUid, adminEmail, carId, fields, uploadedFiles }) {
  // Wave 3 (LADM-01) will implement. Reads current Car, computes per-field
  // { before, after } changed-only fieldDiff (D-A-2), validates makeId/modelId
  // if changed (server.js:787-796 pattern), stamps lastEditedBy/lastEditedAt
  // (D-A-3), writes audit row with action='edit' + fieldDiff.
  void adminUid; void adminEmail; void carId; void fields; void uploadedFiles;
  throw new ListingServiceError('not_implemented');
}

async function suspendListing({ adminUid, adminEmail, carId, reasonCategory, note }) {
  // Wave 2 (LADM-02) will implement. Same-state guard (D-B-1) → audit row
  // with action='suspend', fromStatus=<current>, toStatus='suspended',
  // reasonCategory required → Car.status='suspended' + moderation* fields.
  void adminUid; void adminEmail; void carId; void reasonCategory; void note;
  throw new ListingServiceError('not_implemented');
}

async function archiveListing({ adminUid, adminEmail, carId, reasonCategory, note }) {
  // Wave 2 (LADM-03) will implement. Same shape as suspendListing with
  // toStatus='archived', action='archive'.
  void adminUid; void adminEmail; void carId; void reasonCategory; void note;
  throw new ListingServiceError('not_implemented');
}

async function deleteListing({ adminUid, adminEmail, carId, reasonCategory, note }) {
  // Wave 2 (LADM-04) will implement. SOFT-delete only — Car doc stays in DB;
  // status='deleted', action='delete'. Test invariant: Car.countDocuments({_id})
  // is still 1 after the operation.
  void adminUid; void adminEmail; void carId; void reasonCategory; void note;
  throw new ListingServiceError('not_implemented');
}

async function restoreListing({ adminUid, adminEmail, carId, note }) {
  // Wave 2 (LADM-05) will implement. Inverse transition — toStatus='active',
  // action='restore', reasonCategory: null (D-C). Clears Car.moderationReason
  // + Car.moderationNote (D-C-1). Updates Car.moderatedBy/moderatedAt to the
  // restoring admin (D-C-2). not_moderated 400 if already-active.
  void adminUid; void adminEmail; void carId; void note;
  throw new ListingServiceError('not_implemented');
}

// Touch mongoose + the audit/Car models so the require() above isn't elided
// by a future tree-shaker; Wave 2/3 will exercise them via withTransaction().
// This is a no-op at runtime and provides a single grep-stable surface for
// "what does this module depend on?".
void mongoose; void Car; void ListingModerationAction;

module.exports = {
  editListing,
  suspendListing,
  archiveListing,
  deleteListing,
  restoreListing,
};
