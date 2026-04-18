const AdminUser = require('../models/AdminUser');

/**
 * Express middleware. Requires verifyIdToken upstream (reads req.auth.email).
 * Looks up AdminUser by email (case-insensitive), attaches req.admin = { role, email }.
 *
 * 403 shape per D-10:
 *   { error: 'unauthorized', message: 'Admin access required' }
 */
async function requireAdmin(req, res, next) {
  if (!req.auth || !req.auth.email) {
    return res.status(403).json({ error: 'unauthorized', message: 'Admin access required' });
  }
  const admin = await AdminUser.findOne({ email: req.auth.email.toLowerCase() }).lean();
  if (!admin) {
    return res.status(403).json({ error: 'unauthorized', message: 'Admin access required' });
  }
  req.admin = { uid: req.auth.uid, role: admin.role, email: admin.email };
  return next();
}

module.exports = { requireAdmin };
