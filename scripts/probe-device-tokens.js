/*
 * Read-only diagnostic: validate every device token against FCM with a DRY-RUN send.
 *
 * dryRun:true asks FCM to validate the token + our service-account credentials and
 * return the exact per-token verdict WITHOUT delivering any real notification. This
 * distinguishes the two remaining "Android gets nothing" causes once we know Android
 * tokens exist:
 *   - per-token ERROR (e.g. messaging/registration-token-not-registered → stale token;
 *     messaging/mismatched-credential / messaging/sender-id-mismatch → project/sender
 *     mismatch) ⇒ send-level failure.
 *   - per-token SUCCESS for Android ⇒ FCM accepts them; the notification is delivered
 *     but not DISPLAYED on-device ⇒ a notification-channel / rendering issue, not backend.
 *
 * Reuses the same admin init (FIREBASE_SERVICE_ACCOUNT_JSON) and the same message shape
 * as src/notifications/push/fcm.js fanOut: { notification, data }.
 *
 * Run against prod via Railway (injects MONGODB_URI + FIREBASE_SERVICE_ACCOUNT_JSON):
 *   railway run node scripts/probe-device-tokens.js
 *
 * Read-only + dryRun: writes nothing to the DB, delivers nothing to devices.
 */
const mongoose = require('mongoose');
const { ensureInitialized } = require('../src/security/firebaseAdmin');

const mask = (t) => (t && t.length > 16 ? `…${t.slice(-12)}` : t);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is required');
  await mongoose.connect(uri, { dbName: 'CarEx' });
  console.log('[probe] mongo connected');

  const admin = ensureInitialized();
  console.log('[probe] firebase-admin initialized; project:', (admin.app().options.credential.projectId) || '(unknown)');

  const col = mongoose.connection.collection('devicetokens');
  const rows = await col.find({}, { projection: { token: 1, platform: 1, uid: 1, appVersion: 1 } }).toArray();
  console.log(`[probe] ${rows.length} tokens total\n`);

  if (!rows.length) {
    await mongoose.disconnect();
    return;
  }

  const tokens = rows.map((r) => r.token);
  const message = {
    notification: { title: 'CarEx', body: 'dry-run validation (not delivered)' },
    data: { probe: '1' },
  };

  const messaging = admin.messaging();
  const resp = await messaging.sendEachForMulticast({ tokens, ...message }, /* dryRun */ true);

  console.log('=== per-token FCM verdict (dry-run, nothing delivered) ===');
  resp.responses.forEach((r, i) => {
    const row = rows[i];
    const tag = `${row.platform.padEnd(7)} uid=${row.uid} ${mask(row.token)} v${row.appVersion || '?'}`;
    if (r.success) {
      console.log(`  OK    ${tag}  msgId=${r.messageId}`);
    } else {
      console.log(`  FAIL  ${tag}  ${r.error && r.error.code} — ${r.error && r.error.message}`);
    }
  });

  // Per-platform summary
  const summary = {};
  resp.responses.forEach((r, i) => {
    const p = rows[i].platform;
    summary[p] = summary[p] || { ok: 0, fail: 0, codes: {} };
    if (r.success) summary[p].ok += 1;
    else {
      summary[p].fail += 1;
      const c = (r.error && r.error.code) || 'unknown';
      summary[p].codes[c] = (summary[p].codes[c] || 0) + 1;
    }
  });
  console.log('\n=== summary by platform ===');
  Object.entries(summary).forEach(([p, s]) => {
    console.log(`  ${p}: ${s.ok} ok, ${s.fail} fail ${s.fail ? JSON.stringify(s.codes) : ''}`);
  });
  console.log(`\n  successCount=${resp.successCount} failureCount=${resp.failureCount}`);
  console.log('\nRead: Android FAIL ⇒ send-level (stale/credential). Android OK ⇒ on-device display/channel issue.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[probe] error:', err && err.message);
  process.exit(1);
});
