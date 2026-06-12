const mongoose = require('mongoose');

const carRequestSchema = new mongoose.Schema(
  {
    buyerUid: { type: String, required: true, index: true },
    makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMake', required: true },
    modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleModel', default: null },
    makeName: { type: String, required: true },
    modelName: { type: String, default: null },
    yearMin: { type: Number, default: null },
    yearMax: { type: Number, default: null },
    budgetMin: { type: Number, default: null },
    budgetMax: { type: Number, required: true },
    currency: { type: String, default: 'KGS' },
    exteriorColor: { type: String, default: null },
    interiorColor: { type: String, default: null },
    interiorMaterial: { type: String, default: null },
    engine: { type: String, default: null },
    fuel: { type: String, default: null },
    note: { type: String, default: null, maxlength: 2000 },
    contactPhone: { type: String, required: true },
    contactPhoneVerified: { type: Boolean, default: false },
    telegramUsername: { type: String, default: null },
    telegramVerified: { type: Boolean, default: false },
    status: { type: String, enum: ['open', 'closed', 'expired'], default: 'open', index: true },
    expiresAt: { type: Date, required: true },
    unlockCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

carRequestSchema.index({ status: 1, makeId: 1 });
carRequestSchema.index({ buyerUid: 1, createdAt: -1 });

module.exports = mongoose.models.CarRequest || mongoose.model('CarRequest', carRequestSchema);
