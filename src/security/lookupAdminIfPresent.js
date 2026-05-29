// src/security/lookupAdminIfPresent.js
//
// Phase 9 Plan 09-01 — read-only admin-attach middleware (D-08 / RESEARCH §Pattern 5
// Option A). NEVER returns 401 or 403 — unlike the strict requireAdmin sibling
// which gates moderation routes, this middleware merely ANNOTATES req with
// admin metadata when the caller's verified email matches an AdminUser
// document. Plan 09-03 mounts this AFTER attachAuthIfPresent on
// GET /api/cars/:id so the same handler serves both admin and non-admin
// callers, branching the response shape on `!!req.admin`.
//
// Behaviour:
//   1. If req.auth.email is missing → next() (anonymous viewer; non-admin path).
//   2. AdminUser.findOne({ email: lowercase }) lookup.
//      - Hit: req.admin = { uid, role, email }.
//      - Miss or DB error: next() without 403 (fail-safe — caller treated as
//        non-admin and gets the thin payload).
//
// Do NOT mount on /api/admin/* routes — they require strict 401/403 via
// the existing requireAdmin middleware.

const AdminUser = require('../models/AdminUser');

async function lookupAdminIfPresent(req, res, next) {
  if (!req.auth || !req.auth.email) return next();
  try {
    const admin = await AdminUser.findOne({ email: req.auth.email.toLowerCase() }).lean();
    if (admin) {
      req.admin = { uid: req.auth.uid, role: admin.role, email: admin.email };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[lookupAdminIfPresent]', err);
  }
  return next();
}

module.exports = { lookupAdminIfPresent };
