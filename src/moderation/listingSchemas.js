// src/moderation/listingSchemas.js
//
// Per-action Zod schemas for the 5 listing-moderation PATCH endpoints.
// Every schema is .strict() (D-09 + D-A-1) — unknown top-level keys reject
// at parse time and the router surfaces them as 400 invalid_field
// (Edit) or 400 invalid_payload (Suspend/Archive/Delete/Restore).
//
// Enum values are DERIVED from Mongoose model enums (D-10 enum-drift lock)
// so Zod values cannot drift from Car.schema.path('moderationReason').enumValues.
//
// Differences from v1.0 src/moderation/schemas.js:
//   - 5-value reasonCategoryEnum (adds 'inactive_seller' for Archive intent;
//     v1.0 user-mod is 4-value)
//   - No discriminatedUnion (Phase 8 has 5 dedicated routes, not 1 dispatch)
//   - No severity field (listings have no severity tier — REASON is the
//     only categorical input)
//   - editListingSchema uses BROAD whitelist (D-A) mirroring seller PUT field
//     set, NOT the narrow per-role broker/logistics whitelist
//   - restoreListingSchema has NO reasonCategory (D-C symmetry — Restore is
//     the inverse of moderation; the 5-value taxonomy has no semantic fit)

const { z } = require('zod');
const Car = require('../models/Car');

// Single source of truth for the 5-value reason taxonomy — pulled at module
// load from the Mongoose schema enum so a v1.2+ addition to Car.moderationReason
// automatically widens the Zod enum without a separate Zod patch. D-10.
const REASON_CATEGORIES = Car.schema.path('moderationReason').enumValues;
const reasonCategoryEnum = z.enum(REASON_CATEGORIES);

const noteField = z.string().max(2000).optional();

// --- Suspend / Archive / Delete share the same body shape (D-14) ---
//   reasonCategory: REQUIRED
//   note:           optional, max 2000 chars
const suspendListingSchema = z.object({
  reasonCategory: reasonCategoryEnum,
  note: noteField,
}).strict();

const archiveListingSchema = z.object({
  reasonCategory: reasonCategoryEnum,
  note: noteField,
}).strict();

const deleteListingSchema = z.object({
  reasonCategory: reasonCategoryEnum,
  note: noteField,
}).strict();

// --- Restore (D-C — NO reasonCategory) ---
// Symmetric with v1.0 unsuspend. The 5-value taxonomy describes WHY to moderate;
// Restore is WHY NOT, and the taxonomy has no semantic fit. The audit row's
// adminUid + fromStatus + timestamp already answer "who restored what, when."
const restoreListingSchema = z.object({
  note: noteField,
}).strict();

// --- Edit (D-A broad whitelist) ---
// Mirrors the seller PUT /api/cars/:id field set verbatim (server.js:772-776
// destructure), MINUS the 14 system fields admin cannot edit:
//   _id, sellerId, listingId, createdAt, updatedAt, listingStatus, status,
//   moderationReason, moderationNote, moderatedBy, moderatedAt,
//   lastEditedBy, lastEditedAt, __v.
//
// Per-field validators are PERMISSIVE per D-A-1 — the seller PUT does almost
// no server-side validation, so admin Edit doesn't introduce a stricter
// contract than the seller already operates under. z.coerce.number() handles
// multipart strings → numbers (mirrors seller-PUT parseInt(year) etc. at
// server.js:810). z.union for knownIssues handles both JSON-string and
// array inputs (mirrors server.js:799-804 JSON.parse fallback).
// --- Search (Plan 10-03, LUI-04) ---
// Query schema for GET /api/admin/moderation/listings. .strict() (D-09) so
// unknown query params reject as 400 invalid_payload at parse time — Pitfall
// 10 PII guard depends on this (description / phoneNumber / telegramUsername
// cannot sneak in as `?description=<probe>` against a future widened schema).
//
// `limit` uses z.coerce.number() because query-string values arrive as strings
// (mirrors editListingSchema.year / price / mileage z.coerce.number() pattern
// above for the same reason). Non-numeric input ("foo") rejects per Block 7.
//
// `status` enum mirrors the four-value Car.status taxonomy verbatim — Plan
// 10-03 does NOT re-derive it from Car.schema.path('status').enumValues (the
// REASON_CATEGORIES pattern above) because Car.status is a model-only enum
// that doesn't need cross-handler dynamism. Future status additions widen the
// model AND this schema as part of the same plan.
const searchListingsQuerySchema = z.object({
  status: z.enum(['active', 'suspended', 'archived', 'deleted']).optional(),
  q: z.string().max(128).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
}).strict();

const editListingSchema = z.object({
  // String fields — permissive (matches seller PUT loose schema)
  makeId: z.string().optional(),
  modelId: z.string().optional(),
  trimLevel: z.string().optional(),
  wheelbase: z.string().optional(),
  fuel: z.string().optional(),
  currency: z.string().optional(),
  // WR-07: cap description to prevent abuse (a 10 MB description goes
  // straight into MongoDB and can blow past doc-size limits or balloon DB cost).
  description: z.string().max(10000).optional(),
  bodyType: z.string().optional(),
  engine: z.string().optional(),
  transmission: z.string().optional(),
  drivetrain: z.string().optional(),
  mpg: z.string().optional(),
  condition: z.string().optional(),
  exteriorColor: z.string().optional(),
  interiorColor: z.string().optional(),
  interiorMaterial: z.string().optional(),
  phoneNumber: z.string().optional(),
  telegramUsername: z.string().optional(),
  // Numeric fields — coerce from multipart strings (server.js:810 parseInt pattern)
  year: z.coerce.number().int().nonnegative().optional(),
  price: z.coerce.number().int().nonnegative().optional(),
  mileage: z.coerce.number().int().nonnegative().optional(),
  seats: z.coerce.number().int().nonnegative().optional(),
  doors: z.coerce.number().int().nonnegative().optional(),
  // knownIssues — mirrors seller PUT's JSON-string fallback at server.js:799-804.
  // WR-07: cap both the JSON-string form and the array form to prevent
  // unbounded payloads from ballooning the audit fieldDiff and Car doc.
  knownIssues: z.union([
    z.string().max(20000),
    z.array(z.string().max(500)).max(50),
  ]).optional(),
  // existingImageUrls — JSON-stringified array from multipart per server.js:779-782
  existingImageUrls: z.string().optional(),
}).strict();

module.exports = {
  REASON_CATEGORIES,
  reasonCategoryEnum,
  suspendListingSchema,
  archiveListingSchema,
  deleteListingSchema,
  restoreListingSchema,
  editListingSchema,
  searchListingsQuerySchema,
};
