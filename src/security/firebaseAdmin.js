const admin = require('firebase-admin');

let initialized = false;

/**
 * Lazy-initialize firebase-admin once. Uses FIREBASE_SERVICE_ACCOUNT_JSON env var
 * containing the stringified JSON from the Google Cloud console (D-07).
 * Throws a helpful error if the env var is missing or malformed so misconfig is loud.
 */
function ensureInitialized() {
  if (initialized) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON env var is not set. See .env.example.');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
  }
  admin.initializeApp({ credential: admin.credential.cert(parsed) });
  initialized = true;
  return admin;
}

module.exports = { admin, ensureInitialized };
