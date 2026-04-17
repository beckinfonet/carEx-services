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
});

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

module.exports = mongoose.model('Car', carSchema);
