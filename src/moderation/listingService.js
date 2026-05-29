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

// --- suspendListing (LADM-02) ------------------------------------------
//
// Atomicity contract (D-06, D-08, D-B-1, D-15):
//   1. Defensive arg-check at function top — missing required args → 400
//      invalid_payload (router-level Zod is the first wall; this guard is
//      the second so direct service callers cannot bypass).
//   2. Read current Car OUTSIDE the transaction (fast-path same-state guard
//      per D-B-1). Chains BOTH setOptions bypass flags so the read survives
//      Phase 3's seller-cascade pre(/^find/) hook (Car.js:63-95) AND Phase 9's
//      future listing-status hide hook without retroactive edits (Pitfall 5).
//   3. Open session, enter withTransaction:
//      a. Insert ListingModerationAction FIRST (D-08 audit-then-Car ordering).
//         Array form REQUIRED by Mongoose to accept { session } — single-doc
//         create(doc, { session }) silently drops { session } and lands the
//         audit row OUTSIDE the transaction (Pitfall 2).
//      b. Update Car (status + 4 moderation-stamp fields) with { session }.
//         If updated.matchedCount !== 1 → throw listing_not_found so the
//         transaction aborts (covers TOCTOU between pre-read + update).
//   4. session.endSession() in finally.
//   5. Build the D-02 thin response from in-memory state (no second
//      Car.findById round-trip — every field needed is already known from
//      the $set payload we just committed).
async function suspendListing({ adminUid, adminEmail, carId, reasonCategory, note }) {
  if (!adminUid || !adminEmail || !carId || !reasonCategory) {
    throw new ListingServiceError('invalid_payload');
  }

  // Pre-transaction read: confirm listing exists + detect same-state idempotency
  // violation (D-B-1). Both setOptions flags chained per Pitfall 5.
  const current = await Car.findById(carId)
    .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
    .lean();
  if (!current) {
    throw new ListingServiceError('listing_not_found');
  }
  if (current.status === 'suspended') {
    throw new ListingServiceError('already_in_state');
  }

  const moderatedAt = new Date();
  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Insert audit row FIRST (D-08 ordering). Array form mandatory (Pitfall 2).
      const [action] = await ListingModerationAction.create([{
        listingId: carId,
        sellerUid: current.sellerId,
        adminUid,
        adminEmail,
        action: 'suspend',
        fromStatus: current.status,
        toStatus: 'suspended',
        reasonCategory,
        reasonNote: note ?? null,
        fieldDiff: null,
      }], { session });
      insertedAction = action;

      // 2. Update Car SECOND (D-15 stamp moderationReason/moderationNote/
      //    moderatedBy/moderatedAt alongside the status flip).
      const updated = await Car.updateOne(
        { _id: carId },
        {
          $set: {
            status: 'suspended',
            moderationReason: reasonCategory,
            moderationNote: note ?? null,
            moderatedBy: adminUid,
            moderatedAt,
          },
        },
        { session }
      );
      if (updated.matchedCount !== 1) {
        throw new ListingServiceError('listing_not_found');
      }
    });
  } finally {
    await session.endSession();
  }

  // D-02 thin projection — listing payload carries ONLY the 4 transition-
  // relevant fields, not the full Car doc. action payload carries the 5
  // audit-row identifiers. Both key sets are locked by the test's exact
  // Object.keys() assertion so a future refactor cannot widen the response.
  return {
    listing: {
      _id: carId,
      status: 'suspended',
      moderatedBy: adminUid,
      moderatedAt,
    },
    action: {
      _id: insertedAction._id.toString(),
      action: 'suspend',
      fromStatus: current.status,
      toStatus: 'suspended',
      createdAt: insertedAction.createdAt,
    },
  };
}

// --- archiveListing (LADM-03) ------------------------------------------
//
// Archive is non-punitive (LADM-03 — inactive_seller reason most common).
// Per D-B open matrix, allows transitions from active/suspended/deleted →
// archived. Same-state guard rejects archived → archive.
//
// Body shape is a byte-equivalent mirror of suspendListing above — only the
// target-status literal ('archived') and the audit action verb ('archive')
// differ. Same atomicity contract (D-06, D-08, D-B-1, D-15) applies; see the
// suspendListing comment block for the full step-by-step rationale.
async function archiveListing({ adminUid, adminEmail, carId, reasonCategory, note }) {
  if (!adminUid || !adminEmail || !carId || !reasonCategory) {
    throw new ListingServiceError('invalid_payload');
  }

  // Pre-transaction read: confirm listing exists + detect same-state idempotency
  // violation (D-B-1). Both setOptions flags chained per Pitfall 5.
  const current = await Car.findById(carId)
    .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
    .lean();
  if (!current) {
    throw new ListingServiceError('listing_not_found');
  }
  if (current.status === 'archived') {
    throw new ListingServiceError('already_in_state');
  }

  const moderatedAt = new Date();
  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Insert audit row FIRST (D-08 ordering). Array form mandatory (Pitfall 2).
      const [action] = await ListingModerationAction.create([{
        listingId: carId,
        sellerUid: current.sellerId,
        adminUid,
        adminEmail,
        action: 'archive',
        fromStatus: current.status,
        toStatus: 'archived',
        reasonCategory,
        reasonNote: note ?? null,
        fieldDiff: null,
      }], { session });
      insertedAction = action;

      // 2. Update Car SECOND (D-15 stamp moderationReason/moderationNote/
      //    moderatedBy/moderatedAt alongside the status flip).
      const updated = await Car.updateOne(
        { _id: carId },
        {
          $set: {
            status: 'archived',
            moderationReason: reasonCategory,
            moderationNote: note ?? null,
            moderatedBy: adminUid,
            moderatedAt,
          },
        },
        { session }
      );
      if (updated.matchedCount !== 1) {
        throw new ListingServiceError('listing_not_found');
      }
    });
  } finally {
    await session.endSession();
  }

  // D-02 thin projection — listing payload carries ONLY the 4 transition-
  // relevant fields. action payload carries the 5 audit-row identifiers.
  return {
    listing: {
      _id: carId,
      status: 'archived',
      moderatedBy: adminUid,
      moderatedAt,
    },
    action: {
      _id: insertedAction._id.toString(),
      action: 'archive',
      fromStatus: current.status,
      toStatus: 'archived',
      createdAt: insertedAction.createdAt,
    },
  };
}

// --- deleteListing (LADM-04) -------------------------------------------
//
// LADM-04 SOFT-DELETE: document survives. This handler MUST NOT call any of
// Mongoose's document-removal APIs on the Car model (the *.delete*One,
// *.delete*Many, *.findOne*AndDelete family). The document remains in
// MongoDB with status='deleted' so Plan 08-05's restoreListing can flip it
// back to 'active'. The pre(/^find/) hide hook Phase 9 will land filters
// non-active listings from public reads; admin reads bypass via
// .setOptions({ includeAllListingStatuses: true }).
//
// Body shape is a byte-equivalent mirror of suspendListing/archiveListing
// above — only the target-status literal ('deleted') and the audit action
// verb ('delete') differ. Same atomicity contract (D-06, D-08, D-B-1, D-15)
// applies; see the suspendListing comment block for the full step-by-step
// rationale.
async function deleteListing({ adminUid, adminEmail, carId, reasonCategory, note }) {
  if (!adminUid || !adminEmail || !carId || !reasonCategory) {
    throw new ListingServiceError('invalid_payload');
  }

  // Pre-transaction read: confirm listing exists + detect same-state idempotency
  // violation (D-B-1). Both setOptions flags chained per Pitfall 5.
  const current = await Car.findById(carId)
    .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
    .lean();
  if (!current) {
    throw new ListingServiceError('listing_not_found');
  }
  if (current.status === 'deleted') {
    throw new ListingServiceError('already_in_state');
  }

  const moderatedAt = new Date();
  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Insert audit row FIRST (D-08 ordering). Array form mandatory (Pitfall 2).
      const [action] = await ListingModerationAction.create([{
        listingId: carId,
        sellerUid: current.sellerId,
        adminUid,
        adminEmail,
        action: 'delete',
        fromStatus: current.status,
        toStatus: 'deleted',
        reasonCategory,
        reasonNote: note ?? null,
        fieldDiff: null,
      }], { session });
      insertedAction = action;

      // 2. Update Car SECOND (D-15 stamp moderationReason/moderationNote/
      //    moderatedBy/moderatedAt alongside the status flip). SOFT-DELETE:
      //    Car.updateOne ONLY — NO call to any Mongoose document-removal API
      //    on Car anywhere in this function (LADM-04 invariant).
      const updated = await Car.updateOne(
        { _id: carId },
        {
          $set: {
            status: 'deleted',
            moderationReason: reasonCategory,
            moderationNote: note ?? null,
            moderatedBy: adminUid,
            moderatedAt,
          },
        },
        { session }
      );
      if (updated.matchedCount !== 1) {
        throw new ListingServiceError('listing_not_found');
      }
    });
  } finally {
    await session.endSession();
  }

  // D-02 thin projection — listing payload carries ONLY the 4 transition-
  // relevant fields. action payload carries the 5 audit-row identifiers.
  return {
    listing: {
      _id: carId,
      status: 'deleted',
      moderatedBy: adminUid,
      moderatedAt,
    },
    action: {
      _id: insertedAction._id.toString(),
      action: 'delete',
      fromStatus: current.status,
      toStatus: 'deleted',
      createdAt: insertedAction.createdAt,
    },
  };
}

// --- restoreListing (LADM-05) ------------------------------------------
//
// Inverse transition — flips a moderated listing (suspended/archived/deleted)
// back to 'active'. Body shape mirrors suspendListing/archiveListing/
// deleteListing above, with these intentional Restore-specific divergences:
//
//   - Signature has NO reasonCategory (D-C — Restore body is { note? } only).
//     Symmetric with v1.0 unsuspend (Phase 2 D-21): the 5-value taxonomy
//     describes WHY moderate; Restore is WHY NOT, and the taxonomy has no
//     semantic fit. Audit-row adminUid + fromStatus + timestamp already
//     answer "who restored what, when."
//
//   - Same-state guard becomes NOT_MODERATED, NOT the cross-action no-op
//     code. Pitfall 10: Restore on already-active throws not_moderated; the
//     cross-action no-op code (used by Suspend/Archive/Delete when their
//     target is already in their target state) is reserved for those three
//     handlers. Distinct codes for distinct semantics — not_moderated is the
//     Restore-specific case ("you can't restore an active listing because it
//     isn't moderated"). Mobile UI surfaces different copy for each.
//
//   - Audit row carries reasonCategory: null (D-C). The historical reason
//     lives on the prior 'suspend'/'archive'/'delete' audit row that this
//     Restore is undoing; the audit chain is append-only (Phase 7 pre-hooks
//     prevent any in-handler bug from editing prior rows).
//
//   - Car $set has FIVE fields: status:'active' (target), moderationReason:
//     null (D-C-1 clear), moderationNote: null (D-C-1 clear), moderatedBy:
//     adminUid (D-C-2 update), moderatedAt: new Date() (D-C-2 update).
//     D-C-1 rationale: those two fields describe the *current* moderation
//     state; once the listing is 'active' they should not show stale
//     "suspended-for-spam" copy on the listing-detail screen. The audit row
//     preserves the historical reason; the live Car doc reflects only the
//     current state. Future readers: do NOT "optimize" by preserving the
//     prior reason fields — the test layer locks this.
//     D-C-2 rationale: moderatedBy/moderatedAt point at the most recent
//     status changer (Restore IS a state change). For "who suspended this
//     last", consult the audit chain.
//
// Same atomicity contract (D-06, D-08, D-B-1, D-15) applies; see the
// suspendListing comment block for the full step-by-step rationale.
async function restoreListing({ adminUid, adminEmail, carId, note }) {
  // Defensive arg-check — NO reasonCategory required for Restore (D-C).
  if (!adminUid || !adminEmail || !carId) {
    throw new ListingServiceError('invalid_payload');
  }

  // Pre-transaction read: confirm listing exists + detect already-active
  // (Pitfall 10) BEFORE opening a session. Both setOptions flags chained
  // per Pitfall 5 (Phase 3 seller-cascade hook + Phase 9 listing-status hook
  // bypass — admin can restore a deleted/archived/suspended listing even
  // when its seller is suspended).
  const current = await Car.findById(carId)
    .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
    .lean();
  if (!current) {
    throw new ListingServiceError('listing_not_found');
  }
  // Pitfall 10: Restore on already-active throws not_moderated; the
  // cross-action no-op code (used by Suspend/Archive/Delete same-state) is
  // reserved for those three handlers. Distinct codes for distinct semantics
  // — not_moderated is the Restore-specific case.
  if (current.status === 'active') {
    throw new ListingServiceError('not_moderated');
  }

  const moderatedAt = new Date();
  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Insert audit row FIRST (D-08 ordering). Array form mandatory
      //    (Pitfall 2). reasonCategory: null per D-C — the historical reason
      //    lives on the prior audit row; this row records the inverse event.
      const [action] = await ListingModerationAction.create([{
        listingId: carId,
        sellerUid: current.sellerId,
        adminUid,
        adminEmail,
        action: 'restore',
        fromStatus: current.status,
        toStatus: 'active',
        reasonCategory: null,
        reasonNote: note ?? null,
        fieldDiff: null,
      }], { session });
      insertedAction = action;

      // 2. Update Car SECOND. Five fields:
      //    - status: 'active'             — target
      //    - moderationReason: null       — D-C-1 clear-on-restore
      //    - moderationNote: null         — D-C-1 clear-on-restore
      //    - moderatedBy: adminUid        — D-C-2 update (restoring admin)
      //    - moderatedAt: <fresh Date>    — D-C-2 update (restore timestamp)
      //    Do NOT "optimize" by preserving prior moderationReason/
      //    moderationNote — the test layer locks D-C-1, and stale reason
      //    text on an active listing leaks moderation history into public
      //    surfaces.
      const updated = await Car.updateOne(
        { _id: carId },
        {
          $set: {
            status: 'active',
            moderationReason: null,
            moderationNote: null,
            moderatedBy: adminUid,
            moderatedAt,
          },
        },
        { session }
      );
      if (updated.matchedCount !== 1) {
        throw new ListingServiceError('listing_not_found');
      }
    });
  } finally {
    await session.endSession();
  }

  // D-02 thin projection — listing payload carries ONLY the 4 transition-
  // relevant fields. action payload carries the 5 audit-row identifiers.
  // listing.moderatedBy === adminUid (restoring admin, NOT the prior
  // moderator) and listing.moderatedAt === fresh Date (NOT the prior
  // suspend/archive/delete timestamp) — D-C-2 surfaces here.
  return {
    listing: {
      _id: carId,
      status: 'active',
      moderatedBy: adminUid,
      moderatedAt,
    },
    action: {
      _id: insertedAction._id.toString(),
      action: 'restore',
      fromStatus: current.status,
      toStatus: 'active',
      createdAt: insertedAction.createdAt,
    },
  };
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
