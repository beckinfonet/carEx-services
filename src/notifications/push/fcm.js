// src/notifications/push/fcm.js
//
// Phase 12 NPRF-07: FCM push transport is a SUCCESS-SHAPED NO-OP STUB in this
// milestone. The in-app notification center (Notification rows) is the guaranteed
// fallback; OS push is wired in Phase 13 (NPUSH-*). emit() calls send() for instant
// cadence so the wiring exists, but it does nothing and always resolves successfully
// so a denied/absent push channel never dead-ends the in-app flow (RESEARCH A4).
//
// Do NOT add firebase-admin messaging or google-auth-library here in Phase 12.

async function send() {
  return { ok: true, delivered: 0, stub: true };
}

module.exports = { send };
