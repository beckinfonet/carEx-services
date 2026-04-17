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
