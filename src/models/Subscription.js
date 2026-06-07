const mongoose = require('mongoose');

// Subscription model (Phase 12 NDOM-01 / NDOM-04 / NSUB-*).
//
// Two kinds (lockstep with src/notifications/schemas.js kindEnum):
//   - 'saved_search': criteria-based match against new listings (NDOM-04).
//   - 'watch':        per-car follow keyed on carId (price_drop/booked/sold/back_available).
//
// PITFALL 5 GUARD (NDOM-04): criteria.makeId and criteria.modelId MUST be
// Schema.Types.ObjectId because Car.makeId/modelId are ObjectId (VERIFIED Car.js:11-12).
// Storing the make/model NAME strings here would NEVER match a Car ObjectId, silently
// breaking matchSavedSearches. Do not "simplify" these to String.
const subscriptionSchema = new mongoose.Schema({
  uid: { type: String, required: true },
  kind: { type: String, enum: ['saved_search', 'watch'], required: true },
  criteria: {
    makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMake', default: null },
    modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleModel', default: null },
    priceMin: { type: Number, default: null },
    priceMax: { type: Number, default: null },
    yearMin: { type: Number, default: null },
    yearMax: { type: Number, default: null },
    bodyType: { type: String, default: null },
  },
  carId: { type: String, default: null }, // watch stores car._id as a string
  cadence: { type: String, enum: ['instant', 'daily'], default: 'instant' }, // NSUB-03 / D-10
  events: { type: [String], default: [] }, // watch create writes all four (D-03)
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// Saved-search match scan (NDOM-04): kind + active + indexed criteria ids.
subscriptionSchema.index({ kind: 1, active: 1, 'criteria.makeId': 1, 'criteria.modelId': 1 });
// Watch lookup by car (watch-event emit).
subscriptionSchema.index({ kind: 1, carId: 1, active: 1 });
// Manage-my-subscriptions list.
subscriptionSchema.index({ uid: 1, active: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
