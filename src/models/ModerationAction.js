const mongoose = require('mongoose');

const moderationActionSchema = new mongoose.Schema({
  targetUid: { type: String, required: true },
  adminUid: { type: String, required: true },
  adminEmail: { type: String, required: true },
  action: { type: String, enum: ['suspend', 'unsuspend', 'revoke_role', 'delete_provider_profile', 'edit_profile'], required: true },
  severity: { type: String, enum: ['none', 'feature_limited', 'blocked_with_review', 'permanently_banned'], default: 'none' },
  reasonCategory: { type: String, enum: ['spam', 'policy_violation', 'fraud', 'other'], default: null },
  note: { type: String, default: null, maxlength: 2000 },
  roleAffected: { type: String, enum: ['seller', 'broker', 'logistics', null], default: null },
  fieldDiff: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, required: true },
});
moderationActionSchema.index({ targetUid: 1, createdAt: -1 });
moderationActionSchema.index({ adminUid: 1, createdAt: -1 });

// Append-only enforcement (D-17):
const APPEND_ONLY_ERR = new Error('ModerationAction is append-only');
moderationActionSchema.pre('updateOne', function () { throw APPEND_ONLY_ERR; });
moderationActionSchema.pre('updateMany', function () { throw APPEND_ONLY_ERR; });
moderationActionSchema.pre('findOneAndUpdate', function () { throw APPEND_ONLY_ERR; });
moderationActionSchema.pre('deleteOne', function () { throw APPEND_ONLY_ERR; });
moderationActionSchema.pre('deleteMany', function () { throw APPEND_ONLY_ERR; });
moderationActionSchema.pre('findOneAndDelete', function () { throw APPEND_ONLY_ERR; });

module.exports = mongoose.model('ModerationAction', moderationActionSchema, 'moderation_actions');
