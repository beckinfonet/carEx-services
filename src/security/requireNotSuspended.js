const User = require('../models/User');

/**
 * Factory middleware — gates write routes by the caller's moderationStatus (ENF-01)
 * and, for feature_limited callers, by the requested capability (ENF-04).
 *
 * Usage:
 *   app.post('/api/cars', attachAuthIfPresent, requireNotSuspended('create_listing'), handler);
 *
 * Response matrix (03-CONTEXT D-01, D-15):
 *   - no uid resolvable             -> 404 { error: 'user_not_found' }
 *   - User not found                -> 404 { error: 'user_not_found' }
 *   - state === 'active'            -> next() (sets req.callerUser)
 *   - state === 'feature_limited' &&
 *       requiredCapability in restrictedFeatures
 *                                   -> 403 { error: 'account_suspended', status, reasonCategory, note }
 *   - state === 'feature_limited' && capability not listed
 *                                   -> next() (sets req.callerUser)
 *   - state === 'blocked_with_review'
 *     OR state === 'permanently_banned'
 *                                   -> 403 { error: 'account_suspended', status, reasonCategory, note }
 *
 * Caller-uid resolution (D-03 dual-accept):
 *   1. req.auth?.uid            (from attachAuthIfPresent; non-spoofable)
 *   2. req.body?.sellerId
 *   3. req.body?.buyerUid
 *   4. req.params?.uid
 * Fallback (steps 2-4) logs a one-shot deprecation warning. Phase 6 QUAL-03 removes
 * the fallback + attachAuthIfPresent together.
 *
 * IMPORTANT: the User.findOne MUST opt out of the Plan 03-01 pre(/^find/) hide-hook
 * via the includeAllUsers query-option bypass. Without it, a suspended caller's
 * User doc is hidden from their own self-lookup -> this middleware would 404
 * instead of 403 -> suspension bypass (false negative). See 03-CONTEXT D-07 +
 * threat T-03-02-03.
 *
 * @param {string} requiredCapability - capability token
 *   (e.g., 'create_listing', 'create_order', 'update_profile'). Only checked for
 *   feature_limited callers; blocked_with_review / permanently_banned always 403.
 *   The caller's denormalized restrictedFeatures array is the source of truth
 *   (Phase 1 D-12) — do NOT re-resolve capabilities from the moderation policy.
 */
function requireNotSuspended(requiredCapability) {
  return async function requireNotSuspendedMiddleware(req, res, next) {
    try {
      // Dual-accept uid resolution (D-03) — strict Bearer first, body/params fallback only if req.auth absent.
      let callerUid = req.auth?.uid;
      if (!callerUid) {
        callerUid = req.body?.sellerId || req.body?.buyerUid || req.params?.uid;
        if (callerUid) {
          // TODO(QUAL-03, Phase 6): remove fallback + this warning once mobile wires Bearer.
          // eslint-disable-next-line no-console
          console.warn('[requireNotSuspended] deprecated body-uid fallback used', {
            route: req.originalUrl,
            uid: callerUid,
          });
        }
      }
      if (!callerUid) {
        return res.status(404).json({ error: 'user_not_found' });
      }

      // includeAllUsers bypass is REQUIRED — caller's own User doc would be hidden by
      // the Plan 03-01 pre(/^find/) hook when they are suspended. Without this the
      // middleware would 404 instead of 403 on a suspended caller (false-negative bypass).
      const user = await User.findOne({ firebaseUid: callerUid })
        .select('moderationStatus firebaseUid')
        .setOptions({ includeAllUsers: true })
        .lean();

      if (!user) {
        return res.status(404).json({ error: 'user_not_found' });
      }

      const modStatus = user.moderationStatus || { state: 'active' };
      const { state, reasonCategory = null, note = null, restrictedFeatures = [] } = modStatus;

      if (state === 'active') {
        req.callerUser = user;
        return next();
      }

      if (state === 'feature_limited') {
        if (requiredCapability && restrictedFeatures.includes(requiredCapability)) {
          return res.status(403).json({
            error: 'account_suspended',
            status: state,
            reasonCategory,
            note,
          });
        }
        // feature_limited but this capability is allowed -> continue
        req.callerUser = user;
        return next();
      }

      // blocked_with_review | permanently_banned -> always 403
      return res.status(403).json({
        error: 'account_suspended',
        status: state,
        reasonCategory,
        note,
      });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireNotSuspended };
