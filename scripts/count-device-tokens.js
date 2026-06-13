/*
 * Read-only diagnostic: count device tokens by platform.
 *
 * Confirms (or refutes) the "Android gets no push" diagnosis: the morning-digest
 * fan-out is platform-agnostic, so iOS-only delivery means iOS uids have
 * DeviceToken rows and Android uids have ~none. Reports both raw row counts and
 * DISTINCT uid counts per platform (a uid receives the digest if it has >=1 token).
 *
 * Run against prod via Railway (injects MONGODB_URI, no secret handling):
 *   railway run node scripts/count-device-tokens.js
 * Or with an explicit URI:
 *   MONGODB_URI="mongodb+srv://..." node scripts/count-device-tokens.js
 *
 * Read-only: no writes, no deletes.
 */
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is required');
  await mongoose.connect(uri, { dbName: 'CarEx' });
  console.log('[count] connected\n');

  const col = mongoose.connection.collection('devicetokens');

  const total = await col.countDocuments({});
  const android = await col.countDocuments({ platform: 'android' });
  const ios = await col.countDocuments({ platform: 'ios' });
  const other = total - android - ios;

  // Distinct uids that own at least one token per platform — the population that
  // actually receives a digest.
  const androidUids = (await col.distinct('uid', { platform: 'android' })).length;
  const iosUids = (await col.distinct('uid', { platform: 'ios' })).length;

  console.log('=== device token rows by platform ===');
  console.log(`  total   : ${total}`);
  console.log(`  android : ${android}`);
  console.log(`  ios     : ${ios}`);
  if (other) console.log(`  other   : ${other}`);
  console.log('\n=== distinct uids with >=1 token (digest-reachable) ===');
  console.log(`  android : ${androidUids}`);
  console.log(`  ios     : ${iosUids}`);
  console.log('\nExpectation if the diagnosis holds: android ~0, ios > 0.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[count] error:', err.message);
  process.exit(1);
});
