// __tests__/_helpers/mongoReplSet.js
//
// Shared fixture for Phase 2 tests that exercise mongoose session.withTransaction().
// Standalone MongoMemoryServer does NOT support transactions — Mongo rejects with
// "Transaction numbers are only allowed on a replica set member or mongos".
// MongoMemoryReplSet starts a single-node replica set in-memory (count: 1) which is
// just enough for Mongoose to open a session and commit.
//
// Usage:
//   const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');
//   let rs;
//   beforeAll(async () => { rs = await startReplSet(); });
//   afterAll(async () => { await stopReplSet(rs); });
//
// Per 02-CONTEXT.md D-25 + D-39 and 02-PATTERNS.md §"Key absent patterns" item 5.

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

async function startReplSet() {
  const replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replset.getUri());
  return replset;
}

async function stopReplSet(replset) {
  await mongoose.disconnect();
  if (replset) {
    await replset.stop();
  }
}

module.exports = { startReplSet, stopReplSet };
