const mongoose = require('mongoose');

// Service item sub-schema (logistics-local clone — Broker.js has its own
// independent clone by design; Mongoose treats them as independent
// sub-schemas and keeping each model self-contained avoids cross-file
// coupling). Lifted verbatim from server.js:137-143.
const serviceItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  fee: { type: mongoose.Schema.Types.Mixed, default: 0 },
  currency: { type: String, default: '$' },
}, { _id: false });

// Logistics Partner Schema — lifted verbatim from server.js:163-177 as part
// of Phase 3 Plan 03-01 (ENF-02 model extraction + read-time hide hook).
const logisticsPartnerSchema = new mongoose.Schema({
  ownerUid: { type: String, required: true, unique: true },
  companyName: { type: String, required: true },
  description: String,
  phoneNumber: String,
  telegramUsername: String,
  services: [serviceItemSchema],
  coverageAreas: [String],
  timelines: String,
  paymentOptions: [String],
  avatarUrl: String,
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});
logisticsPartnerSchema.index({ ownerUid: 1 }, { unique: true });

// ENF-02: hide LogisticsPartners whose owner is non-active OR whose
// logisticsStatus is no longer APPROVED. Admin paths + the confirm-booking
// re-check opt out via the bypass flag on setOptions. Default behavior is
// hide-safely.
// The User model is resolved lazily inside the hook (not imported at the
// top of this file) to avoid a potential model-load cycle.
// See 03-CONTEXT.md D-07/D-08 and 03-PATTERNS.md.
logisticsPartnerSchema.pre(/^find/, async function () {
  if (this.getOptions().includeAllUsers) return;
  const User = mongoose.model('User');
  const hiddenUids = await User.distinct('firebaseUid', {
    $or: [
      { 'moderationStatus.state': { $ne: 'active' } },
      { logisticsStatus: { $ne: 'APPROVED' } },
    ],
  });
  // CR-01 fix: preserve the caller's filter on the join key (ownerUid) by
  // AND-ing the $nin hide clause with any existing ownerUid condition.
  // The previous object-literal spread pattern
  //   { ...this.getQuery(), ownerUid: { $nin: hiddenUids } }
  // silently clobbered caller filters like { ownerUid: 'uid-X' } because
  // duplicate keys resolve "last wins" in JS. That broke
  // GET /api/logistics/:uid (LogisticsPartner.findOne({ ownerUid: uid })).
  const currentQuery = this.getQuery();
  const existingClause = currentQuery.ownerUid;
  const nextQuery = { ...currentQuery };
  if (existingClause === undefined) {
    nextQuery.ownerUid = { $nin: hiddenUids };
  } else {
    delete nextQuery.ownerUid;
    nextQuery.$and = [
      ...(currentQuery.$and || []),
      { ownerUid: existingClause },
      { ownerUid: { $nin: hiddenUids } },
    ];
  }
  this.setQuery(nextQuery);
});

module.exports = mongoose.model('LogisticsPartner', logisticsPartnerSchema, 'logistics_partners');
