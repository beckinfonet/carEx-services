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
const { moderationRateLimiter } = require('./rateLimit');
const { dispatchSchema, unsuspendSchema, deleteProfileSchema, editProfileSchema } = require('./schemas');

const router = express.Router();

// SEC-04: Per-admin rate limit applied to EVERY route in this router (including /ping
// and every mutating endpoint). Keyed on req.admin.uid by the limiter (Plan 02-02,
// D-30/D-31/D-32). Mounted HERE — after the app-level verifyIdToken + requireAdmin chain
// at server.js:919 (so req.admin.uid is populated) — and BEFORE any per-route handler.
router.use(moderationRateLimiter);

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
    const body = { error: err.message };
    // D-05 enrichment: when service throws invalid_field with err.fields attached,
    // surface the offending field names so the mobile UI (Phase 5) can name them.
    if (err.message === 'invalid_field' && Array.isArray(err.fields)) {
      body.fields = err.fields;
    }
    return res.status(400).json(body);
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

// DELETE /:targetUid/provider-profile — hard-delete Broker or LogisticsPartner doc
// + strip User.{role}Status='NONE' inside one transaction (Plan 02-05, ADMIN-04).
// Body: { role: 'broker'|'logistics', reasonCategory, note? }. Zod's
// roleEnumProfileDeletable rejects role=seller at parse-time (D-14); service layer also
// throws invalid_role_for_delete defensively. Past orders survive via providerSnapshot
// (D-15) — service NEVER touches service_orders.
router.delete('/:targetUid/provider-profile', denySelfModeration, async (req, res) => {
  const parsed = deleteProfileSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const result = await service.deleteProviderProfile({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      targetUid: req.params.targetUid,
      role: parsed.data.role,
      reasonCategory: parsed.data.reasonCategory,
      note: parsed.data.note,
    });
    return res.json(result);
  } catch (err) {
    return handleServiceError(err, res, 'deleteProviderProfile');
  }
});

// POST /:targetUid/edit-profile — whitelist-filtered profile edit with fieldDiff audit
// (Plan 02-05, ADMIN-05, D-03..D-07). Body: { role, fields: {...}, note? }.
// Two failure modes for unknown fields surface as the SAME 400 envelope (D-05):
//   - Zod .strict() rejects at parse-time → unrecognized_keys issue → invalid_field
//   - Service-layer defensive whitelist throws invalid_field with err.fields attached
// Both paths return { error: 'invalid_field', fields: [...] } so the Phase 5 mobile UI
// can render a single error path.
router.post('/:targetUid/edit-profile', denySelfModeration, async (req, res) => {
  const parsed = editProfileSchema.safeParse(req.body || {});
  if (!parsed.success) {
    // Zod .strict() surfaces unknown keys via the 'unrecognized_keys' issue code on the
    // .fields object. Convert to the D-05 invalid_field shape so router-layer rejection
    // is identical to service-layer rejection (mobile UI gets one error path).
    const issues = parsed.error.issues;
    const unknownIssue = issues.find((i) => i.code === 'unrecognized_keys');
    if (unknownIssue) {
      return res.status(400).json({
        error: 'invalid_field',
        fields: unknownIssue.keys || [],
      });
    }
    return res.status(400).json({ error: 'invalid_payload', issues });
  }
  try {
    const result = await service.editProfile({
      adminUid: req.admin.uid,
      adminEmail: req.admin.email,
      targetUid: req.params.targetUid,
      role: parsed.data.role,
      fields: parsed.data.fields,
      note: parsed.data.note,
    });
    return res.json(result);
  } catch (err) {
    return handleServiceError(err, res, 'editProfile');
  }
});

module.exports = router;
