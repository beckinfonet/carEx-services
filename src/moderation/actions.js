// Thin wrapper around the ModerationAction model.
// Enforces the single write path — all audit entries go through writeAction().
// Append-only is enforced at the Mongoose schema level (see models/ModerationAction.js).

const ModerationAction = require('../models/ModerationAction');

async function writeAction(doc) {
  if (!doc || typeof doc !== 'object') {
    throw new Error('writeAction requires an object');
  }
  if (!doc.targetUid || !doc.adminUid || !doc.adminEmail || !doc.action) {
    throw new Error('writeAction: targetUid, adminUid, adminEmail, action are required');
  }
  return ModerationAction.create(doc);
}

module.exports = { writeAction };
