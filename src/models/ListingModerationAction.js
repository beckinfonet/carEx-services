// src/models/ListingModerationAction.js
//
// Append-only audit log for moderation actions taken against vehicle listings
// (Phase 7 v1.1 — LDATA-03). This is a NEW SIBLING collection alongside the
// v1.0 user-moderation `ModerationAction` model — NOT an extension of it.
//
// Why a sibling collection (D-09):
//   1. v1.0 `ModerationAction.targetUid` is `required: true`. Making it
//      optional to also represent listing actions would weaken the v1.0
//      append-only test specificity and the user-mod contract.
//   2. Mixing 5 user-domain action verbs with 5 listing-domain action verbs
//      in a single enum invites copy-paste bugs (a handler writing a user
//      verb on a listing action, or vice versa).
//   3. Parallel collections give clean per-domain indexes, parallel
//      append-only invariants, parallel pre-hook tests, and let admin-history
//      queries split by domain without `$or` discrimination on `targetType`.
//   4. Cross-domain audit views (future MOD2-* CSV export, super-admin audit
//      review) can union the two collections at query time when needed — that
//      is cheap; collapsing a mixed-target collection later is expensive.
//
// Append-only enforcement (D-11) — application-layer guarantee:
//   All six Mongoose mutation/deletion verbs that can touch an EXISTING
//   document throw the same shared `APPEND_ONLY_ERR` Error instance:
//     updateOne, updateMany, findOneAndUpdate,
//     deleteOne, deleteMany, findOneAndDelete.
//   Mongoose rejects the operation before it reaches MongoDB, so callers
//   receive an Error and no write hits the database. This is intentionally
//   a SCHEMA-level guard so that bypassing the future endpoint handlers and
//   calling the model directly still fails closed.
//
//   DB-user-level insert-only privilege (Atlas) is deferred to a future
//   security-hardening milestone (mirrors v1.0 D-17).
//
//   Hash-chain tamper-evidence is also deferred (mirrors v1.0 D-18).

const mongoose = require('mongoose');

const listingModerationActionSchema = new mongoose.Schema({
  // Car._id as string — matches the existing CarEx convention where Car._id
  // travels as a string in mobile payloads and seller-history queries.
  listingId: { type: String, required: true },
  // Firebase uid of the listing owner at action time. Denormalized so the
  // "show me every action taken against this seller's listings" admin query
  // does not require a Listing join on every row.
  sellerUid: { type: String, required: true },
  adminUid: { type: String, required: true },
  // Denormalized for audit-row readability — mirrors v1.0 D-15. Survives
  // the AdminUser doc being deleted later.
  adminEmail: { type: String, required: true },
  action: {
    type: String,
    enum: ['suspend', 'archive', 'delete', 'restore', 'edit'],
    required: true,
  },
  // State-transition record (D-10). Both required so every audit row
  // self-describes the full transition without joining back to the Car doc
  // (which may have moved on by the time the audit is read).
  fromStatus: {
    type: String,
    enum: ['active', 'suspended', 'archived', 'deleted'],
    required: true,
  },
  toStatus: {
    type: String,
    enum: ['active', 'suspended', 'archived', 'deleted'],
    required: true,
  },
  // 5-value reason taxonomy (D-14a). `inactive_seller` was added in v1.1
  // for the Archive action's non-punitive "abandoned seller" intent — single
  // source of truth shared with `Car.moderationReason` from Plan 07-01.
  reasonCategory: {
    type: String,
    enum: ['spam', 'policy_violation', 'fraud', 'inactive_seller', 'other'],
    default: null,
  },
  reasonNote: { type: String, default: null, maxlength: 2000 },
  // Populated only when `action === 'edit'` (LADM-01). Mixed-type so the Edit
  // action can capture arbitrary `Car` field changes (price, description,
  // images, etc.) without gating each Edit on a schema-update PR. Mirrors
  // v1.0 `ModerationAction.fieldDiff` (D-12 + Specifics).
  fieldDiff: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, required: true },
});

// Three audit indexes (D-10) — the three canonical admin query shapes:
//   { listingId, createdAt:-1 } — "show me the moderation history of THIS listing"
//   { adminUid,  createdAt:-1 } — "show me every action THIS admin has taken"
//   { sellerUid, createdAt:-1 } — "show me every action against THIS seller's listings"
listingModerationActionSchema.index({ listingId: 1, createdAt: -1 });
listingModerationActionSchema.index({ adminUid: 1, createdAt: -1 });
listingModerationActionSchema.index({ sellerUid: 1, createdAt: -1 });

// Append-only enforcement (D-11). Single shared Error instance so every
// rejected operation surfaces the same stable message for both audit-log
// readers and the matching jest test file.
const APPEND_ONLY_ERR = new Error('ListingModerationAction is append-only');
listingModerationActionSchema.pre('updateOne', function () { throw APPEND_ONLY_ERR; });
listingModerationActionSchema.pre('updateMany', function () { throw APPEND_ONLY_ERR; });
listingModerationActionSchema.pre('findOneAndUpdate', function () { throw APPEND_ONLY_ERR; });
listingModerationActionSchema.pre('deleteOne', function () { throw APPEND_ONLY_ERR; });
listingModerationActionSchema.pre('deleteMany', function () { throw APPEND_ONLY_ERR; });
listingModerationActionSchema.pre('findOneAndDelete', function () { throw APPEND_ONLY_ERR; });

// Explicit collection name (D-10) — every file in `src/models/` follows this
// pattern. `listing_moderation_actions` is the locked collection name; do NOT
// rely on Mongoose's default plural pluralization.
module.exports = mongoose.model('ListingModerationAction', listingModerationActionSchema, 'listing_moderation_actions');
