#!/usr/bin/env node
// One-off migration. Idempotent. Run: node scripts/migrate-listing-moderation.js
//
// Phase 7 v1.1 — LDATA-04. Backfills Car.status and creates Phase 7 indexes
// on both `cars` and `listing_moderation_actions` collections so Phase 9 does
// not pay first-query index-build cost in production.
//
// Idempotent (D-18): a second run matches zero docs because the
// `{ status: { $exists: false } }` filter has nothing to match after the first
// run. Pre-existing non-default values (e.g. `status: 'suspended'` written by
// a Phase 8 admin action between two migration runs) are NEVER mutated — the
// `$exists: false` filter only matches docs WITHOUT the field.
//
// Exit codes (Pattern F):
//   0 — success
//   1 — uncaught exception (mongo connect, network, etc.)
//   2 — D-16 invariant failure (cars still missing status after backfill)

require('dotenv').config();
const mongoose = require('mongoose');

const Car = require('../src/models/Car');
const ListingModerationAction = require('../src/models/ListingModerationAction');

async function backfillListings() {
  const filter = { status: { $exists: false } };
  const patch = { $set: { status: 'active' } };
  const result = await Car.updateMany(filter, patch);
  console.log('[migrate-listing] listings backfilled: ' + result.modifiedCount);
  return result.modifiedCount;
}

async function ensureIndexes() {
  // D-15 — force creation of declared indexes on both Phase 7 collections so
  // Phase 9's read-time hide hook + admin "deleted listings" filter view do
  // not pay first-query index-build cost in production.
  await Car.syncIndexes();
  await ListingModerationAction.syncIndexes();
  console.log('[migrate-listing] indexes synced on cars + listing_moderation_actions');
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is required');
  await mongoose.connect(uri, { dbName: 'CarEx' });
  console.log('[migrate-listing] connected');

  const listingsCount = await backfillListings();
  await ensureIndexes();

  // D-16 invariant check — hard merge-gate. Post-migration MUST have zero
  // cars missing the `status` field, otherwise the backfill silently failed
  // and Phase 9's read-time hide hook would treat the field as `undefined`.
  const stillMissing = await Car.countDocuments({ status: { $exists: false } });
  if (stillMissing > 0) {
    console.error('[migrate-listing] FAIL: ' + stillMissing + ' cars still missing status after backfill');
    await mongoose.disconnect();
    process.exit(2);
  }

  console.log('[migrate-listing] DONE — listings backfilled: ' + listingsCount);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate-listing] FAILED:', err);
    process.exit(1);
  });
}

module.exports = { backfillListings, ensureIndexes };
