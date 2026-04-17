#!/usr/bin/env node
// One-off migration. Idempotent. Run: node scripts/migrate-moderation.js
// Backfills User.moderationStatus, ServiceOrder.providerSnapshot, and DATA-01 / DATA-02 indexes.

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/User');
const ModerationAction = require('../src/models/ModerationAction');

async function backfillUsers() {
  const filter = { 'moderationStatus.state': { $exists: false } };
  const patch = {
    $set: {
      moderationStatus: {
        state: 'active',
        severity: 'none',
        reasonCategory: null,
        note: null,
        setByAdminUid: null,
        setAt: null,
        restrictedFeatures: [],
        lastActionId: null,
      },
    },
  };
  const result = await User.updateMany(filter, patch);
  console.log(`[migrate] users backfilled: ${result.modifiedCount}`);
  return result.modifiedCount;
}

async function backfillOrders() {
  // Inline models for Broker, LogisticsPartner, ServiceOrder — they are not extracted yet (D-02).
  // We must access them via mongoose.model(), which requires them to already be registered.
  // server.js registers them on load; the script requires server.js side-effect? NO — that would
  // start the HTTP listener. Instead, define minimal schemas here that point at the same
  // collection names as server.js and use { strict: false } so only the fields we need are
  // touched and existing fields are preserved.
  const LooseSchema = (name, collection) => {
    if (mongoose.models[name]) return mongoose.models[name];
    return mongoose.model(name, new mongoose.Schema({}, { strict: false, collection }));
  };
  const Broker = LooseSchema('Broker_migrate', 'brokers');
  const LogisticsPartner = LooseSchema('LogisticsPartner_migrate', 'logistics_partners');
  const ServiceOrder = LooseSchema('ServiceOrder_migrate', 'service_orders');

  // Select orders whose snapshot is missing any NEW field from D-22.
  const needsBackfill = await ServiceOrder.find({
    $or: [
      { 'providerSnapshot.email': { $exists: false } },
      { 'providerSnapshot.firstName': { $exists: false } },
      { 'providerSnapshot.lastName': { $exists: false } },
      { 'providerSnapshot.providerRole': { $exists: false } },
      { 'providerSnapshot.snapshotAt': { $exists: false } },
    ],
  }).lean();

  let updated = 0;
  let unresolvable = 0;
  for (const order of needsBackfill) {
    const providerUid = order.providerUid;
    const providerType = order.providerType;
    let profile = null;
    if (providerType === 'broker') {
      profile = await Broker.findOne({ ownerUid: providerUid }).lean();
    } else if (providerType === 'logistics') {
      profile = await LogisticsPartner.findOne({ ownerUid: providerUid }).lean();
    }
    const ownerUser = await User.findOne({ firebaseUid: providerUid }).lean();

    if (!profile && !ownerUser) {
      console.warn(`[migrate] order ${order.orderNumber || order._id}: provider ${providerUid} (${providerType}) not resolvable — skipping`);
      unresolvable++;
      continue;
    }

    const existing = order.providerSnapshot || {};
    const merged = {
      companyName: existing.companyName ?? profile?.companyName ?? null,
      phoneNumber: existing.phoneNumber ?? profile?.phoneNumber ?? null,
      telegramUsername: existing.telegramUsername ?? profile?.telegramUsername ?? null,
      email: existing.email ?? ownerUser?.email ?? null,
      firstName: existing.firstName ?? ownerUser?.firstName ?? null,
      lastName: existing.lastName ?? ownerUser?.lastName ?? null,
      providerRole: existing.providerRole ?? providerType ?? null,
      snapshotAt: existing.snapshotAt ?? order.createdAt ?? new Date(),
    };
    await ServiceOrder.updateOne({ _id: order._id }, { $set: { providerSnapshot: merged } });
    updated++;
  }
  console.log(`[migrate] orders backfilled: ${updated}`);
  if (unresolvable > 0) {
    console.error(`[migrate] ${unresolvable} orders could NOT be backfilled (missing provider records). Script will exit non-zero.`);
  }
  return { updated, unresolvable };
}

async function ensureIndexes() {
  // Force creation of declared indexes on both models (D-29 step 3).
  await User.syncIndexes();
  await ModerationAction.syncIndexes();
  console.log('[migrate] indexes synced on users + moderation_actions');
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is required');
  await mongoose.connect(uri, { dbName: 'CarEx' });
  console.log('[migrate] connected');

  const userCount = await backfillUsers();
  const { updated: orderCount, unresolvable } = await backfillOrders();
  await ensureIndexes();

  console.log(`[migrate] DONE — users: ${userCount}, orders: ${orderCount}, unresolvable orders: ${unresolvable}`);
  await mongoose.disconnect();

  if (unresolvable > 0) process.exit(2);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] FAILED:', err);
    process.exit(1);
  });
}

module.exports = { backfillUsers, backfillOrders, ensureIndexes };
