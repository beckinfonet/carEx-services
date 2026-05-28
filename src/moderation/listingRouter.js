// src/moderation/listingRouter.js
//
// Admin listing-moderation router. Mounted in server.js under
// app.use('/api/admin/moderation/listings', verifyIdToken, requireAdmin, listingModerationRateLimiter, listingModerationRouter)
// so every route below runs AFTER Firebase-idToken verification, AdminUser check,
// AND the listing-prefixed rate-limit bucket (Phase 7 D-03).
//
// DIVERGENCE FROM v1.0 router.js: the rate limiter is mounted at APP LEVEL in
// server.js (D-03), NOT at router level via router.use(). This keeps this file
// dependency-free at the Phase 7 boundary (D-01) — no listingRateLimit import,
// no service import, no schema import, no model import. Real endpoint handlers
// (Edit / Suspend / Archive / Soft-Delete / Restore) arrive in Phase 8 and will
// import their service + schemas modules then; Phase 7 ships only the /ping
// scaffold so the LSEC-01/02/03 acceptance shells can exercise the full
// middleware chain end-to-end before any real handler exists.

const express = require('express');

const router = express.Router();

// Phase 7 scaffold route — preserves the v1.0 /ping contract so the
// LSEC-01/02 middleware test and LSEC-03 rate-limit test can drive the full
// auth chain through a real Express route. Returns { ok: true } byte-identical
// to the v1.0 user-mod /ping response.
router.get('/ping', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
