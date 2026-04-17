const mongoose = require('mongoose');

// Service item sub-schema (broker-local clone — LogisticsPartner.js has its
// own independent clone by design; Mongoose treats them as independent
// sub-schemas and keeping each model self-contained avoids cross-file
// coupling). Lifted verbatim from server.js:137-143.
const serviceItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  fee: { type: mongoose.Schema.Types.Mixed, default: 0 },
  currency: { type: String, default: '$' },
}, { _id: false });

// Broker Schema — lifted verbatim from server.js:146-158 as part of
// Phase 3 Plan 03-01 (ENF-02 model extraction + read-time hide hook).
const brokerSchema = new mongoose.Schema({
  ownerUid: { type: String, required: true, unique: true },
  companyName: { type: String, required: true },
  description: String,
  phoneNumber: String,
  telegramUsername: String,
  services: [serviceItemSchema],
  paymentOptions: [String],
  avatarUrl: String,
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});
brokerSchema.index({ ownerUid: 1 }, { unique: true });

// ENF-02: hide Brokers whose owner is non-active OR whose brokerStatus is
// no longer APPROVED. Admin paths + the confirm-booking re-check opt out
// via the bypass flag on setOptions. Default behavior is hide-safely.
// The User model is resolved lazily inside the hook (not imported at the
// top of this file) to avoid a potential model-load cycle.
// See 03-CONTEXT.md D-07/D-08 and 03-PATTERNS.md.
brokerSchema.pre(/^find/, async function () {
  if (this.getOptions().includeAllUsers) return;
  const User = mongoose.model('User');
  const hiddenUids = await User.distinct('firebaseUid', {
    $or: [
      { 'moderationStatus.state': { $ne: 'active' } },
      { brokerStatus: { $ne: 'APPROVED' } },
    ],
  });
  this.setQuery({ ...this.getQuery(), ownerUid: { $nin: hiddenUids } });
});

module.exports = mongoose.model('Broker', brokerSchema, 'brokers');
