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
  // DIAG 2026-04-20: temporary — remove after prod auth debug concludes. #prod-debug
  // Logs header length + 14-char prefix only (never full token); JWT header prefix
  // like "Bearer eyJhbGc" is non-secret. Scope: only verifyIdToken-gated routes fire.
  console.log(
    '[verifyIdToken]',
    req.method,
    req.originalUrl,
    'auth-header:',
    header
      ? `present(len=${header.length}, prefix="${header.slice(0, 14)}")`
      : 'ABSENT',
  );
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
