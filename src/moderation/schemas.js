// src/moderation/schemas.js
//
// Per-action Zod schemas for POST/PATCH/DELETE moderation endpoints.
// Every schema is .strict() (D-05 + D-35) — unknown top-level keys reject.
// Enum values mirror the Mongoose model enums so they cannot drift (D-35).
// Handler pattern per D-36 lives in Plans 02-03..02-05.

const { z } = require('zod');

// Enums — keep in lockstep with User.js / ModerationAction.js.
const reasonCategoryEnum = z.enum(['spam', 'policy_violation', 'fraud', 'other']);
const severityEnum = z.enum(['feature_limited', 'blocked_with_review', 'permanently_banned']);
const roleEnumAll = z.enum(['seller', 'broker', 'logistics']);
const roleEnumProfileDeletable = z.enum(['broker', 'logistics']); // D-14 — seller has no profile doc

const noteField = z.string().max(2000).optional();

// --- Suspend + Revoke dispatch (POST /:targetUid) ---
const suspendSchema = z.object({
  action: z.literal('suspend'),
  severity: severityEnum,
  reasonCategory: reasonCategoryEnum,
  note: noteField,
}).strict();

const revokeRoleSchema = z.object({
  action: z.literal('revoke_role'),
  role: roleEnumAll,
  reasonCategory: reasonCategoryEnum,
  note: noteField,
}).strict();

const dispatchSchema = z.discriminatedUnion('action', [suspendSchema, revokeRoleSchema]);

// --- Unsuspend (PATCH /:targetUid/unsuspend) ---
const unsuspendSchema = z.object({
  note: noteField,
}).strict();

// --- Delete provider profile (DELETE /:targetUid/provider-profile) ---
const deleteProfileSchema = z.object({
  role: roleEnumProfileDeletable,
  reasonCategory: reasonCategoryEnum,
  note: noteField,
}).strict();

// --- Edit provider profile (POST /:targetUid/edit-profile) ---
// Whitelist is narrow (D-03):
//   broker: companyName, phoneNumber, telegramUsername
//   logistics: same + coverageAreas, timelines
// Fields NOT listed → Zod .strict() rejects them → handler returns invalid_field (D-05).
const editProfileBrokerFields = z.object({
  companyName: z.string().min(1).optional(),
  phoneNumber: z.string().optional(),
  telegramUsername: z.string().optional(),
}).strict();

const editProfileLogisticsFields = z.object({
  companyName: z.string().min(1).optional(),
  phoneNumber: z.string().optional(),
  telegramUsername: z.string().optional(),
  coverageAreas: z.array(z.string()).optional(),
  timelines: z.string().optional(),
}).strict();

const editProfileBrokerSchema = z.object({
  role: z.literal('broker'),
  fields: editProfileBrokerFields,
  note: noteField,
}).strict();

const editProfileLogisticsSchema = z.object({
  role: z.literal('logistics'),
  fields: editProfileLogisticsFields,
  note: noteField,
}).strict();

const editProfileSchema = z.discriminatedUnion('role', [editProfileBrokerSchema, editProfileLogisticsSchema]);

module.exports = {
  // enums (exported for handler reuse, e.g. last-admin-guard role check)
  reasonCategoryEnum,
  severityEnum,
  roleEnumAll,
  roleEnumProfileDeletable,
  // per-action schemas
  suspendSchema,
  revokeRoleSchema,
  dispatchSchema,
  unsuspendSchema,
  deleteProfileSchema,
  editProfileBrokerSchema,
  editProfileLogisticsSchema,
  editProfileSchema,
};
