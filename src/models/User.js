const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  firstName: String,
  lastName: String,
  phoneNumber: String,
  telegramUsername: String,
  avatarUrl: String,
  sellerStatus: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'], default: 'NONE' },
  sellerRequestDate: Date,
  brokerStatus: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'], default: 'NONE' },
  brokerRequestDate: Date,
  logisticsStatus: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'], default: 'NONE' },
  logisticsRequestDate: Date,
  isPhoneVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  // Phase 12 NI18N-01: user's preferred language. Additive — no migration; absent
  // docs read as 'RU' via the default.
  language: { type: String, enum: ['RU', 'EN'], default: 'RU' },
  // Phase 12 NPRF-03/04 plumbing: preference DEFAULTS land here now (D-16); the
  // quiet-hours + daily-cap ENFORCEMENT runs in Phase 14. Mirrors the inline
  // moderationStatus subdoc shape below.
  notificationPrefs: {
    muteAll: { type: Boolean, default: false },
    savedSearchEnabled: { type: Boolean, default: true },
    watchEnabled: { type: Boolean, default: true },
    // Phase 15 D-11 / Req 5: broadcast new-listing opt-out toggle. Default ON
    // (opt-out semantics) — absent docs read as enabled via the default, and the
    // broadcast branch keys on `{ $ne: false }` so legacy docs are eligible.
    newListingEnabled: { type: Boolean, default: true },
    // Slice 3: buyer is notified when a seller unlocks their request contact.
    // Default ON (opt-out) — absent docs read as enabled via `!== false` gating.
    requestUnlockEnabled: { type: Boolean, default: true },
    quietHours: {
      start: { type: String, default: '22:00' },
      end: { type: String, default: '08:00' },
    },
    dailyCap: { type: Number, default: 3 },
  },
  moderationStatus: {
    state: { type: String, enum: ['active', 'feature_limited', 'blocked_with_review', 'permanently_banned'], default: 'active', required: true },
    severity: { type: String, enum: ['none', 'feature_limited', 'blocked_with_review', 'permanently_banned'], default: 'none' },
    reasonCategory: { type: String, enum: ['spam', 'policy_violation', 'fraud', 'other'], default: null },
    note: { type: String, default: null, maxlength: 2000 },
    setByAdminUid: { type: String, default: null },
    setAt: { type: Date, default: null },
    restrictedFeatures: { type: [String], default: [] },
    lastActionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ModerationAction', default: null },
  },
});

userSchema.index({ 'moderationStatus.state': 1 });
userSchema.index({ 'moderationStatus.state': 1, 'moderationStatus.reasonCategory': 1 });

module.exports = mongoose.model('User', userSchema);
