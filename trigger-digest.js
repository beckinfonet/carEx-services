/* eslint-disable no-console */
// Manual debug/ops tool for the daily digest (Phase 14). Kept for on-demand
// verification and debugging — NOT imported by the app and NOT run by the cron.
//
// It (1) seeds one digestPending Notification for a test user, then
// (2) calls runDigest() directly — exactly what the 08:00 Asia/Bishkek cron does —
// so a real digest push fans out to that user's registered devices. Use it to
// reproduce/inspect digest delivery without waiting for the morning cron.
//
// Run with the PROD env injected (Atlas + Firebase creds) via Railway:
//   cd backend-services/carEx-services
//   TEST_EMAIL=you@example.com railway run node trigger-digest.js
//   # or via the npm alias:
//   TEST_EMAIL=you@example.com railway run npm run trigger-digest
//   # or by Firebase UID instead of email:
//   TEST_UID=<firebaseUid> railway run node trigger-digest.js
//
// Flags (env vars):
//   COUNT=3          # how many matches the title should claim (default 1)
//   DIGEST_LANG=RU|EN# override the user's stored language (NOT `LANG` — that is the
//                    #   POSIX shell locale and would leak in as garbage)
//   SEED_ONLY=1      # only insert the pending row, don't run the digest (let the cron do it)
//   FORCE=1          # run even if the user has zero registered device tokens
//
// Safety: only the integer count reaches push copy (PII-safe). Seeds a fresh row
// each run; a successfully-sent row flips digestPending:false and becomes a normal
// feed item, so re-running never double-fires an old row.

const mongoose = require('mongoose');

// Register every model runDigest()/prune() resolve via mongoose.model(...).
// Do NOT require ./server (that boots the HTTP server + the real cron).
const Notification = require('./src/models/Notification');
require('./src/models/Car');
const User = require('./src/models/User');
const DeviceToken = require('./src/models/DeviceToken');

const { runDigest } = require('./src/notifications/digest');

async function main() {
  const { TEST_UID, TEST_EMAIL } = process.env;
  const count = Number(process.env.COUNT || 1);
  const langOverride =
    process.env.DIGEST_LANG && process.env.DIGEST_LANG.toUpperCase();
  const seedOnly = process.env.SEED_ONLY === '1';
  const force = process.env.FORCE === '1';

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI not set — run via `railway run` so prod env is injected.');
  }
  if (!TEST_UID && !TEST_EMAIL) {
    throw new Error('Set TEST_UID=<firebaseUid> or TEST_EMAIL=<email>.');
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'CarEx' });
  console.log('Connected to CarEx.');

  // Resolve the Firebase UID (notification.uid === User.firebaseUid).
  let uid = TEST_UID;
  if (!uid) {
    const user = await User.findOne({ email: TEST_EMAIL }).lean();
    if (!user) throw new Error(`No user with email ${TEST_EMAIL}`);
    uid = user.firebaseUid;
  }
  const user = await User.findOne({ firebaseUid: uid }).lean();
  const lang = langOverride || (user && user.language) || 'RU';
  console.log(`Target uid=${uid}  lang=${lang}  count=${count}`);

  // Precondition: a registered device token must exist or nothing reaches the phone.
  const tokenCount = await DeviceToken.countDocuments({ uid });
  console.log(`Registered device tokens for this uid: ${tokenCount}`);
  if (tokenCount === 0 && !force) {
    throw new Error(
      'No DeviceToken rows for this uid. Open the app on the device, grant push ' +
        'permission, and let it register first. (Re-run with FORCE=1 to seed anyway.)',
    );
  }

  // (1) Seed one digestPending row. carId:null → skips the hide-hook re-check.
  // createdAt is set 1 min in the past so it is <= the runDigest "now" bound.
  const seeded = await Notification.create({
    uid,
    kind: 'new_match',
    titleKey: 'push_new_match',
    bodyKey: 'push_new_match',
    params: {},
    data: { deeplink: null, carId: null, searchId: null },
    digestPending: true,
    createdAt: new Date(Date.now() - 60 * 1000),
  });
  console.log(`Seeded digestPending notification _id=${seeded._id}`);

  if (seedOnly) {
    console.log('SEED_ONLY=1 — row is queued. The 08:00 Asia/Bishkek cron will flush it.');
    await mongoose.disconnect();
    return;
  }

  // (2) Trigger the flush — the same call the cron makes. This sends the real push.
  const result = await runDigest({ now: new Date() });
  console.log('runDigest result:', result);
  console.log(
    result.sent > 0
      ? '✓ Digest sent. Check the device for the push, then tap it (foreground/background/quit).'
      : '⚠ sent=0 — likely no live device token (or all rows dropped). Check tokenCount above.',
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('trigger-digest failed:', err && err.message);
  process.exit(1);
});
