const { ensureInitialized } = require('./firebaseAdmin');

/**
 * Express middleware. Parses `Authorization: Bearer <idToken>`, verifies via firebase-admin,
 * attaches req.auth = { uid, email, claims }. Returns 401 with the standard body on failure.
 *
 * 401 shape per D-10:
 *   { error: 'unauthenticated', message: 'Missing or invalid idToken' }
 */
async function verifyIdToken(req, res, next) {
  const header = req.header('authorization') || req.header('Authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'unauthenticated', message: 'Missing or invalid idToken' });
  }
  try {
    const admin = ensureInitialized();
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    req.auth = { uid: decoded.uid, email: decoded.email, claims: decoded };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthenticated', message: 'Missing or invalid idToken' });
  }
}

module.exports = { verifyIdToken };
