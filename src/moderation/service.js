// src/moderation/service.js
//
// Moderation service layer. Each handler opens a Mongoose session and runs the
// audit-row insert + User.moderationStatus (or Broker/LogisticsPartner) mutation
// inside a single session.withTransaction() so the pair is atomic (D-23, D-24).
//
// NOTE: We bypass actions.writeAction() inside transactions because writeAction
// calls ModerationAction.create(singleDoc) which cannot accept { session }. The
// array form (ModerationAction.create([doc], { session })) is required by Mongoose
// to pass options. writeAction() remains the canonical path for any non-transactional
// audit writes; Phase 2 handlers ALWAYS write inside a transaction, so they call
// create() directly with { session }. Audit-ledger integrity is preserved because
// every transactional path here follows the same shape — insert audit inside
// withTransaction(), then the User mutation with lastActionId back-link.

const mongoose = require('mongoose');
const User = require('../models/User');
const AdminUser = require('../models/AdminUser');
const ModerationAction = require('../models/ModerationAction');
const { resolveRestrictedFeatures } = require('./capabilities');

class NotImplementedError extends Error {
  constructor(method) {
    super(`ModerationService.${method} is not yet implemented (Phase 2)`);
    this.name = 'NotImplementedError';
  }
}

// --- suspend ------------------------------------------------------------
//
// Atomicity contract (D-18, D-19, D-20, D-24, D-27, D-28):
//   1. Read current target (outside txn, fast-path 400 for already_at_severity).
//   2. Open session, enter withTransaction:
//      a. Insert ModerationAction audit row (need its _id for lastActionId back-link).
//      b. (SUSPEND ONLY) Last-admin guard: count active admins via AdminUser.email
//         joined to User.moderationStatus.state — if target is a currently-active
//         admin and would-be count drops to 0, throw last_admin_protected.
//      c. Update User.moderationStatus with severity+reason+restrictedFeatures+
//         lastActionId = insertedAction._id.
//   If any step throws, the whole transaction aborts — no orphan audit row, no
//   partial User mutation.
async function suspend({ adminUid, adminEmail, targetUid, severity, reasonCategory, note }) {
  if (!adminUid || !adminEmail || !targetUid || !severity || !reasonCategory) {
    throw new Error('suspend: adminUid, adminEmail, targetUid, severity, reasonCategory are required');
  }

  // Pre-transaction read: confirm target exists + detect re-suspend-same-severity
  // idempotency violation (D-20). Doing this outside the transaction is OK — the
  // transaction still does its own reads/writes atomically; this is just a
  // fast-path 400 so we don't pay the txn cost when the request is a no-op.
  const target = await User.findOne({ firebaseUid: targetUid }).lean();
  if (!target) throw new Error('target_not_found');
  if (
    target.moderationStatus &&
    target.moderationStatus.state === severity &&
    target.moderationStatus.severity === severity
  ) {
    throw new Error('already_at_severity');
  }

  const restrictedFeatures = resolveRestrictedFeatures(severity);
  const setAt = new Date();

  const session = await mongoose.startSession();
  let insertedAction;
  let newModerationStatus;
  try {
    await session.withTransaction(async () => {
      // 1. Insert audit row FIRST (needed for lastActionId back-link per D-18).
      //    Array form is required by Mongoose to accept the { session } option.
      const [action] = await ModerationAction.create([{
        targetUid,
        adminUid,
        adminEmail,
        action: 'suspend',
        severity,
        reasonCategory,
        note: note ?? null,
      }], { session });
      insertedAction = action;

      // 2. Last-admin guard (D-27, D-28) — suspend only. Inside the transaction so
      //    the read + write are isolated as a unit. Query active admins: join
      //    AdminUser.email to User.moderationStatus.state === 'active'.
      const adminEmails = await AdminUser.distinct('email', {}, { session });
      const activeAdminCount = await User.countDocuments({
        email: { $in: adminEmails },
        'moderationStatus.state': 'active',
      }).session(session);

      // If the TARGET is currently counted (active AND admin) AND the count after
      // this suspend would drop to 0, reject. Pre-mutation: target is still in the
      // count, so count - 1 is the post-mutation value we guard on.
      const targetIsActiveAdmin =
        adminEmails.includes(target.email) &&
        (target.moderationStatus ? target.moderationStatus.state === 'active' : true);
      if (targetIsActiveAdmin && activeAdminCount - 1 <= 0) {
        throw new Error('last_admin_protected');
      }

      // 3. Update User.moderationStatus with the new subdoc + back-link to audit row.
      newModerationStatus = {
        state: severity,                            // severity doubles as state (D-17)
        severity,
        reasonCategory,
        note: note ?? null,
        setByAdminUid: adminUid,
        setAt,
        restrictedFeatures,
        lastActionId: action._id,
      };
      const updated = await User.updateOne(
        { firebaseUid: targetUid },
        { $set: { moderationStatus: newModerationStatus } },
        { session }
      );
      if (updated.matchedCount !== 1) {
        throw new Error('target_not_found');
      }
    });
  } finally {
    await session.endSession();
  }

  return {
    ok: true,
    user: { moderationStatus: newModerationStatus },
    action: {
      _id: insertedAction._id.toString(),
      action: insertedAction.action,
      createdAt: insertedAction.createdAt,
    },
  };
}

// --- unsuspend ----------------------------------------------------------
//
// Atomicity contract (D-21, D-22, D-24):
//   1. Read current target (outside txn, fast-path 400 for not_suspended).
//   2. Open session, enter withTransaction:
//      a. Insert ModerationAction audit row with action='unsuspend' severity='none'.
//      b. Update User.moderationStatus to active state (severity='none',
//         reasonCategory=null, note=null, restrictedFeatures=[]) with lastActionId
//         pointing at the new audit row.
//   Last-admin guard is NOT applied (D-28): unsuspend can only INCREASE active admin
//   count, never decrease it.
async function unsuspend({ adminUid, adminEmail, targetUid, note }) {
  if (!adminUid || !adminEmail || !targetUid) {
    throw new Error('unsuspend: adminUid, adminEmail, targetUid are required');
  }

  const target = await User.findOne({ firebaseUid: targetUid }).lean();
  if (!target) throw new Error('target_not_found');

  const currentState = target.moderationStatus ? target.moderationStatus.state : 'active';
  if (currentState === 'active') {
    throw new Error('not_suspended');
  }

  const setAt = new Date();
  const session = await mongoose.startSession();
  let insertedAction;
  let newModerationStatus;
  try {
    await session.withTransaction(async () => {
      const [action] = await ModerationAction.create([{
        targetUid,
        adminUid,
        adminEmail,
        action: 'unsuspend',
        severity: 'none',
        reasonCategory: null,
        note: note ?? null,
      }], { session });
      insertedAction = action;

      newModerationStatus = {
        state: 'active',
        severity: 'none',
        reasonCategory: null,
        note: null,
        setByAdminUid: adminUid,
        setAt,
        restrictedFeatures: [],
        lastActionId: action._id,
      };
      const updated = await User.updateOne(
        { firebaseUid: targetUid },
        { $set: { moderationStatus: newModerationStatus } },
        { session }
      );
      if (updated.matchedCount !== 1) throw new Error('target_not_found');
    });
  } finally {
    await session.endSession();
  }

  return {
    ok: true,
    user: { moderationStatus: newModerationStatus },
    action: {
      _id: insertedAction._id.toString(),
      action: insertedAction.action,
      createdAt: insertedAction.createdAt,
    },
  };
}

// --- stubs still owned by Plans 02-04 and 02-05 -------------------------
// Signatures locked in Phase 1; bodies filled by the plans listed below.

async function revokeRole(/* { adminUid, adminEmail, targetUid, role, reasonCategory, note } */) {
  throw new NotImplementedError('revokeRole');
}

async function deleteProviderProfile(/* { adminUid, adminEmail, targetUid, role, reasonCategory, note } */) {
  throw new NotImplementedError('deleteProviderProfile');
}

async function editProfile(/* { adminUid, adminEmail, targetUid, role, fieldDiff, note } */) {
  throw new NotImplementedError('editProfile');
}

module.exports = { suspend, unsuspend, revokeRole, deleteProviderProfile, editProfile, NotImplementedError };
