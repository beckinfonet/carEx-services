const mongoose = require('mongoose');

// DeviceToken model (Phase 12 NDOM-01).
//
// DEFINED NOW, POPULATED PHASE 13. There is no write/read path for device tokens
// in Phase 12 — FCM push transport (and the token-registration endpoint that fills
// this collection) lands in Phase 13 (RESEARCH OQ#1 / A1). The model exists now so
// NDOM-01 ("three notification-domain models") is satisfied literally and the schema
// contract is locked before the push work begins.
//
// `token` is globally UNIQUE (one device token maps to exactly one row regardless of
// uid — a re-registered token updates rather than duplicates).
const deviceTokenSchema = new mongoose.Schema({
  uid: { type: String, required: true },
  token: { type: String, required: true, unique: true },
  platform: { type: String, enum: ['ios', 'android'], required: true },
  appVersion: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
});

// Lookup all tokens for a user (Phase 13 send fan-out).
deviceTokenSchema.index({ uid: 1 });

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
