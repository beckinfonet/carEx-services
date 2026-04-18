const { ensureInitialized } = require('./firebaseAdmin');

// TODO(QUAL-03, Phase 6): remove this module; revert all five gated routes to strict
// verifyIdToken once mobile wires Bearer on every call. See 03-CONTEXT.md D-03/D-04.

/**
 * Express middleware — dual-accept fork of verifyIdToken (Phase 3 D-03/D-04).
 *
 * Behaviour diverges from strict verifyIdToken on ONE branch only:
 *   - No Authorization header / non-Bearer header → next() (no 401).
 *     requireNotSuspended then falls back to req.body.sellerId / buyerUid / req.params.uid.
 *
 * All other branches match verifyIdToken verbatim:
 *   - Valid Bearer → req.auth = { uid, email, claims } → next().
 *   - Bearer-present-but-malformed/expired/revoked → 401 { error: 'unauthenticated',
 *     message: 'Missing or invalid idToken' }.
 *
 * Do NOT mount on admin routes — they require strict 401 via verifyIdToken (D-04).
 */
async function attachAuthIfPresent(req, res, next) {
  const header = req.header('authorization') || req.header('Authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    return next();  // dual-accept: no Bearer -> requireNotSuspended falls back to body/params uid
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

module.exports = { attachAuthIfPresent };
