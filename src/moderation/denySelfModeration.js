// src/moderation/denySelfModeration.js
//
// Express middleware. Rejects moderation actions where the target UID equals the acting
// admin's UID (D-26). Runs AFTER requireAdmin (needs req.admin.uid), BEFORE the handler.
// Applied PER-ROUTE (not router-wide) because future non-mutating routes in the moderation
// namespace (e.g., Phase 5 history GET) should NOT carry this guard.
//
// 400 response shape (D-10 family):
//   { error: 'cannot_moderate_self' }
//
// Rejected attempts are logged to stdout with admin uid + timestamp (D-29 — audit log is
// reserved for SUCCESSFUL state changes, not for rejected attempts).

function denySelfModeration(req, res, next) {
  const targetUid = req.params && req.params.targetUid;
  const adminUid = req.admin && req.admin.uid;

  // Defensive: if either is missing, fall through. Upstream middleware (requireAdmin)
  // is responsible for guaranteeing req.admin.uid; the route definition is responsible
  // for the :targetUid param. This middleware only enforces the equality rule.
  if (!targetUid || !adminUid) {
    return next();
  }

  if (targetUid === adminUid) {
    // D-29: log-only, NOT ModerationAction.create. Audit ledger is for state changes.
    // eslint-disable-next-line no-console
    console.log(`[moderation] denied self-moderation attempt by ${adminUid} at ${new Date().toISOString()}`);
    return res.status(400).json({ error: 'cannot_moderate_self' });
  }

  return next();
}

module.exports = { denySelfModeration };
