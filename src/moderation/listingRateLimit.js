// src/moderation/listingRateLimit.js
//
// Per-admin rate limiter for the listing-moderation surface.
// Mounted at the /api/admin/moderation/listings prefix at app level in server.js
// (see Phase 7 D-03), AFTER verifyIdToken + requireAdmin so req.admin.uid is
// populated when keyGenerator runs.
//
// Window: 15 minutes. Max: 30 requests per window per admin. (Phase 7 D-04,
// inherits the LSEC-03 budget from the v1.0 user-mod limiter.)
//
// SEPARATE COUNTER BUCKET from the v1.0 user-mod limiter per Phase 7 D-04.
// Key prefix is applied on req.admin.uid (see keyGenerator below). Sharing the
// bucket would let listing actions starve user-mod actions and vice versa, and
// the 429 telemetry would be ambiguous during incident response. Listing volume
// may legitimately be higher than user-mod volume — independent budgets keep
// the two surfaces observable and prevent cross-domain throughput contamination.
//
// Why keyed on uid, not IP: a compromised-admin attack would rotate IPs to bypass
// an IP-keyed limiter. LSEC-03 is about defending against a single compromised admin
// credential scripting mass-moderation. 30/15min is far above any legitimate human
// operator. (Same rationale as v1.0 user-mod — Phase 2 D-30/D-31/D-32.)
//
// Memory store — single-instance Railway only. Horizontal scale requires
// rate-limit-redis swap + Railway Redis add-on (deferred to v1.2+).
//
// 429 response shape (Phase 7 D-06 — BYTE-IDENTICAL to v1.0 user-mod limiter so
// the existing mobile apiClient 429 interceptor handles new routes without
// modification): JSON body { error: <code>, retryAfter: <seconds> } plus the
// Retry After header (standardHeaders: true also sets RateLimit-* headers per RFC 6585).

const rateLimit = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000;  // 15 minutes
const MAX_REQUESTS = 30;

const listingModerationRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true,    // RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
  legacyHeaders: false,     // no X-RateLimit-* (deprecated)
  keyGenerator: (req) => {
    // Primary key: the verified Firebase uid of the acting admin, prefixed to
    // keep this bucket SEPARATE from the v1.0 user-mod limiter
    // (Phase 7 D-04 separate-bucket invariant). All three fallback tiers MUST
    // carry the prefix — dropping it from any tier under an auth-degradation
    // path would silently collapse this bucket into the v1.0 one and break D-04.
    if (req.admin && req.admin.uid) return `listing-admin:${req.admin.uid}`;
    if (req.admin && req.admin.email) return `listing-admin-email:${req.admin.email}`;
    // Absolute last resort — an unauthenticated request should never reach this
    // middleware (requireAdmin runs upstream), but if it does, bucket all of
    // them together under the listing-prefixed bucket so they can't individually
    // exhaust the limit.
    return 'listing-unauthenticated';
  },
  handler: (req, res /*, next, options */) => {
    const resetTimeMs = req.rateLimit && req.rateLimit.resetTime
      ? req.rateLimit.resetTime - Date.now()
      : WINDOW_MS;
    const retryAfter = Math.max(0, Math.ceil(resetTimeMs / 1000));
    res
      .status(429)
      .set('Retry-After', String(retryAfter))
      .json({ error: 'rate_limited', retryAfter });
  },
});

module.exports = { listingModerationRateLimiter, WINDOW_MS, MAX_REQUESTS };
