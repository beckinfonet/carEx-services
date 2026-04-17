// src/moderation/router.js
//
// Admin moderation router. Mounted in server.js under
// app.use('/api/admin/moderation', verifyIdToken, requireAdmin, moderationRouter)
// so every route below runs AFTER Firebase-idToken verification and AdminUser check.
//
// This plan (02-03) wires two live handlers:
//   POST   /:targetUid             → service.suspend (action='suspend' branch of dispatchSchema)
//   PATCH  /:targetUid/unsuspend   → service.unsuspend
//
// Plan 02-04 fills the action='revoke_role' branch of POST /:targetUid.
// Plan 02-05 adds DELETE /:targetUid/provider-profile and POST /:targetUid/edit-profile.
// Plan 02-06 mounts moderationRateLimiter at the router level + integration test.
// The rate limiter is intentionally NOT wired here — keeps this plan's tests
// parallel-safe against Plan 02-04 / 02-05.

const express = require('express');
const service = require('./service');
const { denySelfModeration } = require('./denySelfModeration');
const { dispatchSchema, unsuspendSchema } = require('./schemas');

const router = express.Router();

// Service errors this module translates to user-facing 400 responses.
// Anything not in this set bubbles up as 500 internal_error.
// Entries marked (Plan 02-04) / (Plan 02-05) are pre-registered so downstream
// plans don't have to amend this set — they just start throwing the error.
const KNOWN_USER_ERRORS = new Set([
  'already_at_severity',       // Plan 02-03
  'not_suspended',             // Plan 02-03
  'last_admin_protected',      // Plan 02-03
  'target_not_found',          // Plan 02-03 (+ others)
  'role_not_assigned',         // Plan 02-04 / 02-05
  'invalid_field',             // Plan 02-05 (edit-profile)
  'no_changes',                // Plan 02-05 (edit-profile)
  'invalid_role_for_delete',   // Plan 02-05
  'provider_profile_not_found', // Plan 02-05 (delete-provider-profile)
]);

function handleServiceError(err, res, tag) {
  if (KNOWN_USER_ERRORS.has(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  // eslint-disable-next-line no-console
  console.error(`[moderation] ${tag} error:`, err);
  return res.status(500).json({ error: 'internal_error', message: err.message });
}

// Scaffold route from Phase 1 — unchanged. Not behind denySelfModeration because
// /ping has no :targetUid param.
router.get('/ping', (req, res) => {
  res.json({ ok: true });
});

// POST /:targetUid — dispatch on body.action. Covers suspend (this plan) and
// revoke_role (Plan 02-04). dispatchSchema (discriminatedUnion on 'action') routes
// to the correct per-action schema; unknown actions reject at parse-time.
router.post('/:targetUid', denySelfModeration, async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    if (parsed.data.action === 'suspend') {
      const result = await service.suspend({
        adminUid: req.admin.uid,
        adminEmail: req.admin.email,
        targetUid: req.params.targetUid,
        severity: parsed.data.severity,
        reasonCategory: parsed.data.reasonCategory,
        note: parsed.data.note,
      });
      return res.json(result);
    }
    if (parsed.data.action === 'revoke_role') {
      const result = await service.revokeRole({
        adminUid: req.admin.uid,
        adminEmail: req.admin.email,
        targetUid: req.params.targetUid,
        role: parsed.data.role,
        reasonCategory: parsed.data.reasonCategory,
        note: parsed.data.note,
      });
      return res.json(result);
    }
    // Unreachable — dispatchSchema enforces the enum.
    return res.status(400).json({ error: 'invalid_payload' });
  } catch (err) {
    return handleServiceError(err, res, 'suspend/dispatch');
  }
});

// PATCH /:targetUid/unsuspend — dedicated route (not in POST dispatch per D-01).
// Body is just { note? } per unsuspendSchema.
router.patch('/:targetUid/unsuspend', denySelfModeration, async (req, res) => {
  const parsed = unsuspendSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const result = await service.unsuspend({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      targetUid: req.params.targetUid,
      note: parsed.data.note,
    });
    return res.json(result);
  } catch (err) {
    return handleServiceError(err, res, 'unsuspend');
  }
});

module.exports = router;
