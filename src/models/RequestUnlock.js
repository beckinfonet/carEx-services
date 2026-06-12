const mongoose = require('mongoose');

const requestUnlockSchema = new mongoose.Schema(
  {
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'CarRequest', required: true, index: true },
    sellerUid: { type: String, required: true, index: true },
    paymentIntentId: { type: String, default: null }, // null for a free-mode unlock
    amount: { type: Number, required: true }, // 0 in free mode
    currency: { type: String, default: 'KGS' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Pay once: a seller never unlocks the same request twice.
requestUnlockSchema.index({ requestId: 1, sellerUid: 1 }, { unique: true });

module.exports = mongoose.models.RequestUnlock || mongoose.model('RequestUnlock', requestUnlockSchema);
