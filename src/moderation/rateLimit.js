// src/moderation/rateLimit.js
//
// Per-admin rate limiter mounted at the /api/admin/moderation router level.
// Keyed by req.admin.uid (set by requireAdmin — see Plan 02-01 amendment).
// Window: 15 minutes. Max: 30 requests per window per admin. (D-30, D-31, D-32.)
//
// Why keyed on uid, not IP: a compromised-admin attack would rotate IPs to bypass
// an IP-keyed limiter. SEC-04 is about defending against a single compromised admin
// credential scripting mass-moderation. 30/15min is far above any legitimate human
// operator (see PITFALLS.md §"Security Mistakes" — "rate limit missing on admin moderation").
//
// Memory store — single-instance Railway only (STATE.md blocker — D-33). Horizontal
// scale requires rate-limit-redis swap + Railway Redis add-on.
//
// 429 response shape (D-31):
//   { error: 'rate_limited', retryAfter: <seconds> }
// Plus Retry-After header (standardHeaders: true also sets RateLimit-* headers per RFC 6585).

const rateLimit = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000;  // 15 minutes
const MAX_REQUESTS = 30;

const moderationRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true,    // RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
  legacyHeaders: false,     // no X-RateLimit-* (deprecated)
  keyGenerator: (req) => {
    // Primary key: the verified Firebase uid of the acting admin. Falls back to email
    // if uid is somehow missing (defensive — Plan 02-01 guarantees uid is present, but
    // a future regression must not silently become an anonymous-keyed limiter that
    // treats every caller as the same bucket).
    if (req.admin && req.admin.uid) return `admin:${req.admin.uid}`;
    if (req.admin && req.admin.email) return `admin-email:${req.admin.email}`;
    // Absolute last resort — an unauthenticated request should never reach this middleware
    // (requireAdmin runs upstream), but if it does, bucket all of them together so they
    // can't individually exhaust the limit.
    return 'unauthenticated';
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

module.exports = {
  moderationRateLimiter,
  // Exported for integration tests (Plan 02-06) that need to know the envelope:
  WINDOW_MS,
  MAX_REQUESTS,
};
