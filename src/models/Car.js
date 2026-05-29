// CAUTION (Phase 7 v1.1): This model has TWO independent status fields that both default to 'active'.
//   - listingStatus: 'active' | 'booked' | 'sold'                         — seller-side lifecycle (booking flow)
//   - status:        'active' | 'suspended' | 'archived' | 'deleted'      — admin-side moderation (LDATA-01)
// Do NOT conflate. Phase 7 D-08, 07-CONTEXT.md.
const mongoose = require('mongoose');

// Car Schema (listings reference makeId/modelId)
// Lifted verbatim from server.js:95-133 as part of Phase 3 Plan 03-01
// (ENF-02 model extraction + read-time hide hook).
const carSchema = new mongoose.Schema({
  makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMake' },
  modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleModel' },
  makeName: String,
  modelName: String,
  make: String,  // legacy, for old listings
  model: String, // legacy, for old listings
  trimLevel: String,
  wheelbase: String,
  year: Number,
  price: Number,
  mileage: Number,
  fuel: String,
  currency: String,
  description: String,
  bodyType: String,
  imageUrls: [String],
  createdAt: { type: Date, default: Date.now },
  engine: String,
  transmission: String,
  drivetrain: String,
  mpg: String,
  condition: String,
  knownIssues: [String],
  exteriorColor: String,
  interiorColor: String,
  interiorMaterial: String,
  seats: Number,
  doors: Number,
  phoneNumber: String,
  telegramUsername: String,
  listingId: String,
  sellerId: String, // Firebase UID of listing owner
  listingStatus: { type: String, enum: ['active', 'booked', 'sold'], default: 'active' },
  bookedByUid: { type: String, default: null },
  stripePaymentIntentId: { type: String, default: null },
  status: { type: String, enum: ['active', 'suspended', 'archived', 'deleted'], default: 'active', required: true, index: true },
  moderationReason: { type: String, enum: ['spam', 'policy_violation', 'fraud', 'inactive_seller', 'other'], default: null },
  moderationNote: { type: String, default: null, maxlength: 2000 },
  moderatedBy: { type: String, default: null },           // Firebase uid of admin
  moderatedAt: { type: Date, default: null },
  lastEditedBy: { type: String, default: null },          // Firebase uid of admin (LADM-01)
  lastEditedAt: { type: Date, default: null },
});

carSchema.index({ sellerId: 1, status: 1 });

// ENF-02: hide Cars whose seller is non-active OR no longer APPROVED.
// Admin paths + the confirm-booking re-check opt out via the bypass flag on
// setOptions. Default behavior is hide-safely.
// The User model is resolved lazily inside the hook (not imported at the top
// of this file) to avoid a potential model-load cycle.
// See 03-CONTEXT.md D-07/D-08 and 03-PATTERNS.md.
carSchema.pre(/^find/, async function () {
  if (this.getOptions().includeAllUsers) return;
  const User = mongoose.model('User');
  const hiddenUids = await User.distinct('firebaseUid', {
    $or: [
      { 'moderationStatus.state': { $ne: 'active' } },
      { sellerStatus: { $ne: 'APPROVED' } },
    ],
  });
  // CR-01 fix: preserve the caller's filter on the join key (sellerId) by
  // AND-ing the $nin hide clause with any existing sellerId condition.
  // The previous object-literal spread pattern
  //   { ...this.getQuery(), sellerId: { $nin: hiddenUids } }
  // silently clobbered caller filters like { sellerId: 'uid-X' } because
  // duplicate keys resolve "last wins" in JS. That broke
  // GET /api/cars?sellerId=X (my-listings view).
  const currentQuery = this.getQuery();
  const existingClause = currentQuery.sellerId;
  const nextQuery = { ...currentQuery };
  if (existingClause === undefined) {
    nextQuery.sellerId = { $nin: hiddenUids };
  } else {
    // Preserve caller's sellerId filter AND apply the hide $nin via $and so
    // neither clause clobbers the other.
    delete nextQuery.sellerId;
    nextQuery.$and = [
      ...(currentQuery.$and || []),
      { sellerId: existingClause },
      { sellerId: { $nin: hiddenUids } },
    ];
  }
  this.setQuery(nextQuery);
});

// Phase 9 LENF-01: hide non-active listings from public reads by default.
// Bypass via setOptions with the per-call admin opt-out flag (see the short-
// circuit check below) for admin/Phase 10 paths. Sibling to the seller-cascade
// hook above (D-04: orthogonal — each bypass flag short-circuits its own
// filter independently). CR-01-equivalent $and-combine preserves caller's
// status filter (Pitfall 2 — admin querying status='deleted' must work with
// the bypass flag set).
carSchema.pre(/^find/, function () {
  if (this.getOptions().includeAllListingStatuses) return;
  const currentQuery = this.getQuery();
  const existingClause = currentQuery.status;
  const nextQuery = { ...currentQuery };
  if (existingClause === undefined) {
    nextQuery.status = 'active';
  } else {
    delete nextQuery.status;
    nextQuery.$and = [
      ...(currentQuery.$and || []),
      { status: existingClause },
      { status: 'active' },
    ];
  }
  this.setQuery(nextQuery);
});

module.exports = mongoose.model('Car', carSchema);
