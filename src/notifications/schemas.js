// src/notifications/schemas.js
//
// Zod request schemas for the notification subscription/manage endpoints (S3).
// Mirrors src/moderation/schemas.js discipline:
//   - every object is .strict() so unknown client keys reject (D-35 analog).
//   - enum values are kept in LOCKSTEP with src/models/Subscription.js so they
//     cannot drift (kindEnum / cadenceEnum / eventEnum).
//   - the create payload is a z.discriminatedUnion('kind', [...]) so a
//     saved_search vs watch body is validated against the right field set.
//
// The router (12-04) consumes these; emit() (this plan) consumes the resolved
// Subscription documents, not the request bodies.

const { z } = require('zod');

// Enums — keep in lockstep with src/models/Subscription.js.
const kindEnum = z.enum(['saved_search', 'watch']);
const cadenceEnum = z.enum(['instant', 'daily']);
const eventEnum = z.enum(['price_drop', 'booked', 'sold', 'back_available']);

// Saved-search criteria. ObjectId ids accepted as 24-hex strings (the client sends
// strings; the model casts to ObjectId). All fields optional — absent === wildcard.
// .strict() so a typo'd / injected criteria key (e.g. a name string under makeName)
// rejects rather than silently never-matching (Pitfall 5 defense-in-depth).
const objectIdString = z.string().regex(/^[a-fA-F0-9]{24}$/, 'must be a 24-char hex ObjectId');

const criteriaSchema = z.object({
  makeId: objectIdString.optional(),
  modelId: objectIdString.optional(),
  priceMin: z.number().nonnegative().optional(),
  priceMax: z.number().nonnegative().optional(),
  yearMin: z.number().int().optional(),
  yearMax: z.number().int().optional(),
  bodyType: z.string().min(1).optional(),
}).strict();

// --- saved_search create payload ---
const savedSearchSchema = z.object({
  kind: z.literal('saved_search'),
  criteria: criteriaSchema,
  cadence: cadenceEnum.optional(), // defaults to 'instant' at the model layer
}).strict();

// --- watch create payload ---
const watchSchema = z.object({
  kind: z.literal('watch'),
  carId: z.string().min(1),
  events: z.array(eventEnum).nonempty().optional(), // defaults to all four (D-03)
  cadence: cadenceEnum.optional(),
}).strict();

// Create dispatch — split on kind.
const createSubscriptionSchema = z.discriminatedUnion('kind', [savedSearchSchema, watchSchema]);

// --- device-token register payload (Phase 13 NPUSH-04) ---
// platform enum kept in LOCKSTEP with src/models/DeviceToken.js. .strict() so an
// injected `uid` (or any unknown key) is rejected — uid ALWAYS comes from the
// verified Bearer, never the body (V4 IDOR). appVersion is optional metadata.
const platformEnum = z.enum(['ios', 'android']);

const registerDeviceTokenSchema = z.object({
  token: z.string().min(1),
  platform: platformEnum,
  appVersion: z.string().min(1).optional(),
}).strict();

module.exports = {
  // enums (exported for handler reuse / lockstep assertions)
  kindEnum,
  cadenceEnum,
  eventEnum,
  platformEnum,
  // schemas
  criteriaSchema,
  savedSearchSchema,
  watchSchema,
  createSubscriptionSchema,
  registerDeviceTokenSchema,
};
