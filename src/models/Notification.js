const mongoose = require('mongoose');

// Notification model (Phase 12 NDOM-01).
//
// Stores i18n KEYS (titleKey/bodyKey) + params — never rendered text — so the
// mobile client localizes at read time via src/notifications/translations.js
// (NI18N-03). One row per delivered in-app notification.
//
// Channels in Phase 12 are ['in_app'] only; Phase 13 adds 'push'. digestPending
// is the Phase 14 daily-digest worker queue flag (no consumer yet in P12).
//
// dedupeKey is a plain String set by notificationService to `${carId}:${eventType}`
// (NDOM-03 dedup — at most one alert per (uid, carId, eventType)).
//
// NDOM-06 RETENTION POLICY: notifications are pruned after NOTIFICATION_RETENTION_DAYS
// (90 days). The policy constant is DEFINED here; the prune cron job RUNS in Phase 14.
// The {uid, createdAt} feed index also serves the prune scan.
const NOTIFICATION_RETENTION_DAYS = 90;

const notificationSchema = new mongoose.Schema({
  uid: { type: String, required: true },
  kind: { type: String, required: true },
  titleKey: { type: String, required: true },
  bodyKey: { type: String, required: true },
  params: { type: mongoose.Schema.Types.Mixed, default: {} },
  data: {
    deeplink: { type: String, default: null },
    carId: { type: String, default: null },
    searchId: { type: String, default: null },
  },
  read: { type: Boolean, default: false },
  channels: { type: [String], default: ['in_app'] },
  digestPending: { type: Boolean, default: false },
  // Phase 14 NDIG-02 crash-safe claim marker. A digest run stamps this with its
  // runStart ISO string when it CLAIMS a digestPending row (sibling to
  // digestPending, NOT a digestSent marker — double-send hardening is intentionally
  // out, see digest.js). A non-null value on a still-digestPending row means a prior
  // run claimed it but crashed before clearing; a later run re-stamps and re-sends it
  // (no drop). It is cleared ($unset) only when the row is successfully sent.
  digestRunId: { type: String, default: null },
  dedupeKey: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

// Feed (reverse-chron list) + serves the NDOM-06 90-day prune scan.
notificationSchema.index({ uid: 1, createdAt: -1 });
// Unread-count query.
notificationSchema.index({ uid: 1, read: 1 });
// Phase 14 daily-digest worker queue.
notificationSchema.index({ digestPending: 1 });
// Dedup lookup (NDOM-03).
notificationSchema.index({ dedupeKey: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
module.exports.NOTIFICATION_RETENTION_DAYS = NOTIFICATION_RETENTION_DAYS;
