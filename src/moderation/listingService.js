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
// Phase 8 status (post-Plan 06): all 5 handlers shipped. Wave 1 scaffold
// throws have been replaced — suspendListing (08-02), archiveListing (08-03),
// deleteListing (08-04), restoreListing (08-05), editListing (08-06). The
// handler shape is locked: each accepts { adminUid, adminEmail, carId, ... }
// and returns { listing, action } per D-02. Wave-2/3 plans cannot re-export
// or rename these handlers.
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

// Pitfall 7 lazy-model resolution helper. VehicleMake and VehicleModel are
// inlined in server.js (lines 99-100), NOT extracted to src/models/. Using
// mongoose.model('Name') at call time defers resolution until first invocation
// — by which point server.js has registered them at boot, OR a test has
// registered loose-schema variants under the canonical names (Pitfall 7).
// Same pattern as v1.0 src/moderation/service.js's getProfileModel (lines
// 307-320) which lazy-resolves Broker / LogisticsPartner.
function getVehicleModels() {
  return {
    VehicleMake: mongoose.model('VehicleMake'),
    VehicleModel: mongoose.model('VehicleModel'),
  };
}

// Module-scope whitelist of editable keys to drive the fieldDiff loop. This is
// the Edit-side mirror of editListingSchema in listingSchemas.js — the schema
// is the router-layer wall (Zod .strict() rejects unknown top-level keys); this
// list scopes the service-layer iteration so a future plan that broadens the
// schema does NOT silently start diffing system fields like sellerId/_id.
// existingImageUrls is handled separately (it's an INPUT for the image-merge,
// not a Car field). imageUrls is handled separately too (computed via merge).
const EDIT_DIFF_KEYS = [
  'makeId', 'modelId', 'trimLevel', 'wheelbase',
  'year', 'price', 'mileage',
  'fuel', 'currency', 'description', 'bodyType',
  'engine', 'transmission', 'drivetrain', 'mpg', 'condition',
  'knownIssues',
  'exteriorColor', 'interiorColor', 'interiorMaterial',
  'seats', 'doors',
  'phoneNumber', 'telegramUsername',
];

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

// --- editListing (LADM-01) ---------------------------------------------
//
// Edit is the only Phase 8 handler that diverges structurally from the
// transition handlers above: NO status change (D-A-4 — works on any status),
// computes per-field { before, after } fieldDiff (D-A-2), validates makeId/
// modelId via lazy mongoose.model('VehicleMake' / 'VehicleModel') (Pitfall 7),
// and stamps lastEditedBy / lastEditedAt but NEVER moderatedBy / moderatedAt
// (D-A-3 distinction — Edit is content-correction, NOT a state change).
//
// Four-section body:
//   A. Pre-transaction read (D-A-4 — applies to ANY status, no same-state
//      guard, no not_moderated guard).
//   B. makeId / modelId lazy validation (mirror server.js:787-796).
//   C. fieldDiff + changeSet computation (mirror v1.0 service.js:438-530
//      editProfile pattern + image-merge per server.js:778-785).
//   D. Empty-diff guard (D-06 — no_changes) + atomic transaction.
//
// Atomicity contract (D-06, D-08) preserved: audit-row insert THEN Car
// updateOne, both with { session }. fieldDiff + audit row + Car field-set
// update all commit-or-rollback together.
async function editListing({ adminUid, adminEmail, carId, fields, uploadedFiles }) {
  // Defensive arg-check at function top — direct service callers cannot bypass.
  if (!adminUid || !adminEmail || !carId || !fields) {
    throw new ListingServiceError('invalid_payload');
  }

  // ====================================================================
  // Section A — Pre-transaction read + status irrelevance (D-A-4).
  // ====================================================================
  // Edit applies to ANY status — admin may correct content on a moderated
  // listing without restoring it first. Audit row uses fromStatus === toStatus
  // = current.status. NO same-state guard, NO not_moderated guard here.
  // Both setOptions flags chained per Pitfall 5 (defeats Phase 3
  // seller-cascade hook + Phase 9 listing-status hook bypass — admin can edit
  // a deleted listing whose seller is suspended).
  const current = await Car.findById(carId)
    .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
    .lean();
  if (!current) {
    throw new ListingServiceError('listing_not_found');
  }

  // ====================================================================
  // Section B — makeId / modelId lazy validation (D-A, server.js:787-796).
  // ====================================================================
  // Mirror seller-PUT validation EXACTLY. Lazy mongoose.model() per Pitfall 7
  // — these models are registered inline in server.js at boot, not extracted
  // to src/models/. Calling getVehicleModels() at this point lets tests
  // pre-register loose-schema variants under the canonical names before
  // requiring this module.
  //
  // Re-resolved makeName / modelName feed the changeSet so the denormalized
  // copies on Car stay consistent (mirrors server.js:792-795). Admin cannot
  // send makeName/modelName directly — they're derived from the validated docs.
  let resolvedMakeName, resolvedModelName;
  if (fields.makeId) {
    const { VehicleMake } = getVehicleModels();
    const makeDoc = await VehicleMake.findOne({ _id: fields.makeId, isActive: true }).lean();
    if (!makeDoc) {
      throw new ListingServiceError('invalid_make');
    }
    resolvedMakeName = makeDoc.name;
  }
  if (fields.modelId && fields.makeId) {
    const { VehicleModel } = getVehicleModels();
    // Explicit ObjectId cast on the makeId filter — the production schema
    // (server.js:73) declares makeId as `Schema.Types.ObjectId, ref:
    // 'VehicleMake'` which auto-casts query strings; loose-schema tests do
    // not. Casting here makes the query work identically in both modes.
    // mongoose.isValidObjectId guards against a malformed string surfacing
    // as a Mongoose CastError 500 instead of our intended 400 invalid_model.
    if (!mongoose.isValidObjectId(fields.makeId) || !mongoose.isValidObjectId(fields.modelId)) {
      throw new ListingServiceError('invalid_model');
    }
    const makeIdAsOid = new mongoose.Types.ObjectId(fields.makeId);
    const modelDoc = await VehicleModel.findOne({
      _id: fields.modelId,
      makeId: makeIdAsOid,
      isActive: true,
    }).lean();
    if (!modelDoc) {
      throw new ListingServiceError('invalid_model');
    }
    resolvedModelName = modelDoc.name;
  }
  // NOTE: modelId without makeId — seller PUT only re-resolves when BOTH are
  // present (server.js:787 `if (makeId && modelId)`). Edit mirrors this: a
  // modelId-only payload passes through as a raw fieldDiff entry without
  // re-validation. Stricter validation would be an asymmetry vs. the seller
  // PUT — and D-A-1 forbids that.

  // ====================================================================
  // Section C — fieldDiff + changeSet computation (D-A-2, image-merge D-D).
  // ====================================================================
  // Per-field { before, after } changed-only diff. EDIT_DIFF_KEYS scopes the
  // iteration; submitted-but-equal keys filter out so the diff is
  // changed-only (D-A-2). For arrays (knownIssues, imageUrls), JSON.stringify
  // equality covers reorder + add + remove uniformly.
  const fieldDiff = {};
  const changeSet = {};

  for (const key of EDIT_DIFF_KEYS) {
    if (fields[key] === undefined) continue;
    let before = current[key];
    let after = fields[key];

    // knownIssues: mirror server.js:799-804 JSON-string fallback. Schema
    // accepts either string (multipart JSON-stringified array) or array. The
    // seller PUT falls back to [knownIssues] when JSON.parse fails — we
    // mirror that exact fallback.
    if (key === 'knownIssues' && typeof after === 'string') {
      try {
        after = JSON.parse(after);
      } catch (_e) {
        after = [after];
      }
    }

    // Compare with JSON.stringify for arrays / objects; direct === for scalars.
    const beforeNormalized = before ?? null;
    const beforeJson = Array.isArray(beforeNormalized) || (beforeNormalized && typeof beforeNormalized === 'object')
      ? JSON.stringify(beforeNormalized)
      : null;
    const afterJson = Array.isArray(after) || (after && typeof after === 'object')
      ? JSON.stringify(after)
      : null;

    let changed;
    if (beforeJson !== null || afterJson !== null) {
      changed = JSON.stringify(beforeNormalized) !== JSON.stringify(after);
    } else {
      changed = before !== after;
    }

    if (changed) {
      fieldDiff[key] = { before: before ?? null, after };
      changeSet[key] = after;
    }
  }

  // If makeId was re-resolved, ALSO record makeName fieldDiff + changeSet
  // entry — denormalized name follows the id (server.js:794 pattern).
  if (resolvedMakeName !== undefined && resolvedMakeName !== current.makeName) {
    fieldDiff.makeName = { before: current.makeName ?? null, after: resolvedMakeName };
    changeSet.makeName = resolvedMakeName;
  }
  if (resolvedModelName !== undefined && resolvedModelName !== current.modelName) {
    fieldDiff.modelName = { before: current.modelName ?? null, after: resolvedModelName };
    changeSet.modelName = resolvedModelName;
  }

  // Image-merge (D-D, mirror server.js:778-785 seller-PUT pattern, with the
  // CR-01/WR-06 hardening: validate parse result is an Array of strings BEFORE
  // entering the transaction. Diverges from the seller-PUT swallow-on-error
  // because:
  //   1. Seller-PUT's swallow silently keeps current images even when the
  //      seller intended to remove some — right-to-erasure / GDPR removal
  //      flows depend on this being explicit, not silent.
  //   2. Non-array JSON (e.g., '"foo"' or 'null' or '{}') corrupts
  //      Car.imageUrls — `[...string]` spreads characters into the array,
  //      `[...null]` throws TypeError INSIDE the transaction, etc.
  // Both vectors fixed by throwing invalid_payload before opening a session.
  const newUrls = (uploadedFiles || []).map((f) => f.location);
  let keptUrls = current.imageUrls || [];
  if (fields.existingImageUrls !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(fields.existingImageUrls);
    } catch (_e) {
      throw new ListingServiceError('invalid_payload');
    }
    if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === 'string')) {
      throw new ListingServiceError('invalid_payload');
    }
    keptUrls = parsed;
  }
  const mergedImageUrls = [...keptUrls, ...newUrls];
  const currentImageUrls = current.imageUrls || [];
  if (JSON.stringify(currentImageUrls) !== JSON.stringify(mergedImageUrls)) {
    fieldDiff.imageUrls = { before: currentImageUrls, after: mergedImageUrls };
    changeSet.imageUrls = mergedImageUrls;
  }

  // ====================================================================
  // Section D — Empty-diff guard (D-06) + atomic transaction.
  // ====================================================================
  if (Object.keys(fieldDiff).length === 0) {
    throw new ListingServiceError('no_changes');
  }

  const lastEditedAt = new Date();
  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Audit row FIRST (D-08 ordering). Array form mandatory (Pitfall 2).
      //    action='edit' + fieldDiff populated + reasonCategory:null.
      //    fromStatus === toStatus === current.status (D-A-4 — Edit does NOT
      //    transition state; the audit row's discriminator is the populated
      //    fieldDiff + action:'edit').
      const [action] = await ListingModerationAction.create([{
        listingId: carId,
        sellerUid: current.sellerId,
        adminUid,
        adminEmail,
        action: 'edit',
        fromStatus: current.status,
        toStatus: current.status,
        reasonCategory: null,
        reasonNote: null,
        fieldDiff,
      }], { session });
      insertedAction = action;

      // 2. Update Car SECOND with the changeSet + D-A-3 stamps.
      //
      //    D-A-3: Edit stamps lastEditedBy/lastEditedAt but NEVER touches
      //    moderatedBy/moderatedAt. moderatedBy reflects last status change
      //    (suspend/archive/delete/restore); lastEditedBy reflects last admin
      //    content edit. Distinct semantics — the test layer locks this
      //    (editListing.test.js test 13).
      const updated = await Car.updateOne(
        { _id: carId },
        {
          $set: {
            ...changeSet,
            lastEditedBy: adminUid,
            lastEditedAt,
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

  // D-02 thin projection — Edit-specific fields (lastEditedBy + lastEditedAt)
  // populated; moderatedBy + moderatedAt taken from `current` (Edit does NOT
  // touch them per D-A-3). Other handlers omit lastEditedBy/lastEditedAt
  // because only Edit stamps them.
  return {
    listing: {
      _id: carId,
      status: current.status,
      moderatedBy: current.moderatedBy ?? null,
      moderatedAt: current.moderatedAt ?? null,
      lastEditedBy: adminUid,
      lastEditedAt,
    },
    action: {
      _id: insertedAction._id.toString(),
      action: 'edit',
      fromStatus: current.status,
      toStatus: current.status,
      createdAt: insertedAction.createdAt,
    },
  };
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
