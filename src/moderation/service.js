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

// --- revokeRole (ADMIN-03, D-08..D-12) ----------------------------------
//
// Strips User.{role}Status → 'NONE' and writes an audit row inside one transaction.
// Does NOT delete Broker / LogisticsPartner doc (D-08 preservation — provider profile
// stays for historical lookups; read-layer hides revoked roles in Phase 3 ENF-02).
// Does NOT mutate user.moderationStatus (D-12 — revoke is orthogonal to suspension).
// Last-admin guard is SKIPPED per D-28 — admin-ness lives in AdminUser, not in User
// role fields, so revoke_role can never make someone "less of an admin".
const ROLE_FIELD_BY_NAME = {
  seller: 'sellerStatus',
  broker: 'brokerStatus',
  logistics: 'logisticsStatus',
};

async function revokeRole({ adminUid, adminEmail, targetUid, role, reasonCategory, note }) {
  if (!adminUid || !adminEmail || !targetUid || !role || !reasonCategory) {
    throw new Error('revokeRole: adminUid, adminEmail, targetUid, role, reasonCategory are required');
  }

  const roleField = ROLE_FIELD_BY_NAME[role];
  if (!roleField) {
    // Zod at the router should prevent this (roleEnumAll), but defensive at the
    // service boundary so direct service calls (tests, future internal callers)
    // can't bypass the whitelist via the dynamic $set below (T-02-04-06 mitigation).
    throw new Error('invalid_role');
  }

  const target = await User.findOne({ firebaseUid: targetUid }).lean();
  if (!target) throw new Error('target_not_found');

  // D-11: role must be currently APPROVED to be revokable. NONE / PENDING / REJECTED
  // are handled by the legacy approve/reject flow (01-CONTEXT.md D-05), not by
  // moderation. Reject BEFORE opening a transaction so no orphan audit row lands on
  // rejection (Test 4 + 5 assert audits.length === 0 after the throw).
  if (target[roleField] !== 'APPROVED') {
    throw new Error('role_not_assigned');
  }

  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Insert audit row FIRST (consistent with suspend/unsuspend pattern from
      //    Plan 02-03). Array form required for { session } per the writeAction
      //    bypass note at top of file.
      const [action] = await ModerationAction.create([{
        targetUid,
        adminUid,
        adminEmail,
        action: 'revoke_role',
        severity: 'none',
        reasonCategory,
        note: note ?? null,
        roleAffected: role,
      }], { session });
      insertedAction = action;

      // 2. Strip the role. Dynamic field name via $set on whitelisted roleField.
      const updated = await User.updateOne(
        { firebaseUid: targetUid },
        { $set: { [roleField]: 'NONE' } },
        { session }
      );
      if (updated.matchedCount !== 1) throw new Error('target_not_found');

      // 3. EXPLICITLY do NOT touch the Broker / LogisticsPartner document (D-08
      //    preservation — Pitfall 9). EXPLICITLY do NOT touch user.moderationStatus
      //    (D-12 orthogonality). These are negative invariants enforced by Tests
      //    2/3 (provider doc still exists) and Test 6 (moderationStatus unchanged).
    });
  } finally {
    await session.endSession();
  }

  return {
    ok: true,
    user: { [roleField]: 'NONE' },
    action: {
      _id: insertedAction._id.toString(),
      action: insertedAction.action,
      roleAffected: insertedAction.roleAffected,
      createdAt: insertedAction.createdAt,
    },
  };
}

// --- deleteProviderProfile (ADMIN-04, D-13..D-16) -----------------------
//
// Hard-deletes the Broker / LogisticsPartner doc + strips User.{role}Status → 'NONE'
// + appends an audit row, all inside one transaction (D-13). Past orders survive via
// ServiceOrder.providerSnapshot (D-15, populated by Phase 1 D-21..D-24) — this handler
// NEVER touches the service_orders collection (Pitfall 3 mitigation, T-02-05-01).
//
// role='seller' is rejected at the router via Zod's roleEnumProfileDeletable (D-14);
// service-layer also throws invalid_role_for_delete defensively for direct callers.
//
// Last-admin guard NOT applied (D-28 reasoning carries through from revokeRole):
// admin-ness lives in AdminUser, not in Broker/LogisticsPartner profile rows.
const PROFILE_MODEL_BY_ROLE = {
  broker: 'Broker',
  logistics: 'LogisticsPartner',
};

function getProfileModel(role) {
  const modelName = PROFILE_MODEL_BY_ROLE[role];
  if (!modelName) throw new Error('invalid_role_for_delete');
  // Lazy lookup — server.js registers these at app boot. In test runtime the test
  // file registers loose-schema variants under the canonical names BEFORE require'ing
  // service.js, so this resolves to the test seed model. Either way, the dynamic
  // resolution is bounded by the PROFILE_MODEL_BY_ROLE whitelist (no injection vector).
  return mongoose.model(modelName);
}

async function deleteProviderProfile({ adminUid, adminEmail, targetUid, role, reasonCategory, note }) {
  if (!adminUid || !adminEmail || !targetUid || !role || !reasonCategory) {
    throw new Error('deleteProviderProfile: adminUid, adminEmail, targetUid, role, reasonCategory are required');
  }

  // D-14 defensive guard. Zod (deleteProfileSchema → roleEnumProfileDeletable) rejects
  // role=seller at the router, but service layer must not depend on external validation
  // for correctness. Throw before any DB I/O.
  if (role !== 'broker' && role !== 'logistics') {
    throw new Error('invalid_role_for_delete');
  }

  const ProfileModel = getProfileModel(role);
  const roleField = role === 'broker' ? 'brokerStatus' : 'logisticsStatus';

  const target = await User.findOne({ firebaseUid: targetUid }).lean();
  if (!target) throw new Error('target_not_found');
  if (target[roleField] !== 'APPROVED') {
    // D-13 implicit precondition: only APPROVED providers have a meaningful profile to
    // delete. NONE / PENDING / REJECTED skip the moderation path. Symmetric with
    // revokeRole's pre-txn check; throws BEFORE the session opens so no orphan audit
    // row lands on rejection.
    throw new Error('role_not_assigned');
  }

  const existingProfile = await ProfileModel.findOne({ ownerUid: targetUid }).lean();
  if (!existingProfile) {
    // User claims the role but the profile doc is missing — data-integrity bug. Refuse
    // to create an audit row for a delete that can't actually delete anything. The
    // admin should escalate to ops (the audit ledger should not record phantom deletes).
    throw new Error('provider_profile_not_found');
  }

  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Insert audit row FIRST (consistent with suspend / unsuspend / revokeRole
      //    pattern from Plans 02-03/04). Array form required by Mongoose for { session }.
      const [action] = await ModerationAction.create([{
        targetUid,
        adminUid,
        adminEmail,
        action: 'delete_provider_profile',
        severity: 'none',
        reasonCategory,
        note: note ?? null,
        roleAffected: role,
      }], { session });
      insertedAction = action;

      // 2. Hard-delete provider doc (D-13 step 1). Race-guard via deletedCount === 1.
      const deleteResult = await ProfileModel.deleteOne({ ownerUid: targetUid }, { session });
      if (deleteResult.deletedCount !== 1) {
        // Doc was deleted between our pre-check and the transaction (concurrent admin
        // action). Abort cleanly so withTransaction rolls back the audit row insert.
        throw new Error('provider_profile_not_found');
      }

      // 3. Strip the role on User (D-13 step 2). Without this, User would claim a role
      //    pointing at a non-existent profile — inconsistent state.
      const updated = await User.updateOne(
        { firebaseUid: targetUid },
        { $set: { [roleField]: 'NONE' } },
        { session }
      );
      if (updated.matchedCount !== 1) throw new Error('target_not_found');

      // 4. EXPLICITLY do NOT touch service_orders (D-15, Pitfall 3, T-02-05-01).
      //    Past orders survive via providerSnapshot — that's the whole point of the
      //    Phase 1 denormalization. Negative invariant enforced by Test 1 assertion.
    });
  } finally {
    await session.endSession();
  }

  return {
    ok: true,
    user: { [roleField]: 'NONE' },
    action: {
      _id: insertedAction._id.toString(),
      action: insertedAction.action,
      roleAffected: insertedAction.roleAffected,
      createdAt: insertedAction.createdAt,
    },
  };
}

// --- editProfile (ADMIN-05, D-03..D-07) ---------------------------------
//
// Whitelist-filtered, change-diff-audited edit of Broker / LogisticsPartner identity +
// contact fields. fieldDiff is per-field { before, after }, changed-only (D-04).
// Unknown field → invalid_field (D-05). No-op submit → no_changes (D-06).
// Target must have the role APPROVED (D-07) — edit is for live providers only.
//
// Whitelist runs TWICE (T-02-05-03 mitigation):
//   1. Zod .strict() at the router rejects unknown top-level keys.
//   2. Service-layer EDIT_WHITELIST_BY_ROLE check (defensive against direct callers).
//
// moderationStatus is EXPLICITLY not touched (D-12 carry-through, T-02-05-09): edit is
// identity correction, not a moderation-state change. Test 8 enforces this invariant.
const EDIT_WHITELIST_BY_ROLE = {
  broker: ['companyName', 'phoneNumber', 'telegramUsername'],                                // D-03
  logistics: ['companyName', 'phoneNumber', 'telegramUsername', 'coverageAreas', 'timelines'], // D-03
};

function valuesEqual(a, b) {
  // Deep equal via JSON stringify — handles primitive strings AND coverageAreas string
  // arrays. Nulls / undefined are treated as equal ("absent" is absent regardless of
  // representation). Cost is O(n) on tiny n (T-02-05-08 accepted).
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function editProfile({ adminUid, adminEmail, targetUid, role, fields, note }) {
  if (!adminUid || !adminEmail || !targetUid || !role || !fields) {
    throw new Error('editProfile: adminUid, adminEmail, targetUid, role, fields are required');
  }

  const whitelist = EDIT_WHITELIST_BY_ROLE[role];
  if (!whitelist) throw new Error('invalid_role');

  // D-05 defensive whitelist check at the service boundary. Throw BEFORE any DB read so
  // direct callers cannot waste a round-trip on a bogus field set. err.fields carries
  // the offending names so the router can surface them in the 400 body.
  const submittedKeys = Object.keys(fields);
  const unknownFields = submittedKeys.filter((k) => !whitelist.includes(k));
  if (unknownFields.length > 0) {
    const err = new Error('invalid_field');
    err.fields = unknownFields;
    throw err;
  }

  const roleField = role === 'broker' ? 'brokerStatus' : 'logisticsStatus';
  const target = await User.findOne({ firebaseUid: targetUid }).lean();
  if (!target) throw new Error('target_not_found');
  // D-07: edit only on APPROVED providers. PENDING / REJECTED / NONE belong to the
  // approve-flow path, not moderation. Throws BEFORE the txn opens (no orphan audit row).
  if (target[roleField] !== 'APPROVED') throw new Error('role_not_assigned');

  const ProfileModel = getProfileModel(role); // reuses Task 1's whitelist-bounded helper
  const currentProfile = await ProfileModel.findOne({ ownerUid: targetUid }).lean();
  if (!currentProfile) throw new Error('provider_profile_not_found');

  // D-04 + D-06: compute fieldDiff, changed-only. Filter out keys where submitted equals
  // current (covers no-op single-field AND no-op multi-field submissions). If fieldDiff
  // ends up empty, throw no_changes BEFORE the txn opens — no audit row leaks.
  const fieldDiff = {};
  const changeSet = {};
  for (const key of submittedKeys) {
    const before = currentProfile[key];
    const after = fields[key];
    if (!valuesEqual(before, after)) {
      fieldDiff[key] = { before: before ?? null, after };
      changeSet[key] = after;
    }
  }
  if (Object.keys(fieldDiff).length === 0) {
    throw new Error('no_changes');
  }

  const session = await mongoose.startSession();
  let insertedAction;
  try {
    await session.withTransaction(async () => {
      // 1. Audit row first (consistent with suspend/unsuspend/revokeRole/delete pattern).
      const [action] = await ModerationAction.create([{
        targetUid,
        adminUid,
        adminEmail,
        action: 'edit_profile',
        severity: 'none',
        reasonCategory: null,
        note: note ?? null,
        roleAffected: role,
        fieldDiff,
      }], { session });
      insertedAction = action;

      // 2. Apply the changeSet (whitelist-filtered + changed-only — never touches the
      //    excluded fields like description / avatarUrl / paymentOptions / services /
      //    status / ownerUid).
      const updated = await ProfileModel.updateOne(
        { ownerUid: targetUid },
        { $set: changeSet },
        { session }
      );
      if (updated.matchedCount !== 1) throw new Error('provider_profile_not_found');

      // 3. EXPLICITLY do NOT mutate user.moderationStatus (D-12 orthogonality carry,
      //    T-02-05-09). Edit corrects identity; suspension state is governed elsewhere.
    });
  } finally {
    await session.endSession();
  }

  return {
    ok: true,
    fieldDiff,
    action: {
      _id: insertedAction._id.toString(),
      action: insertedAction.action,
      roleAffected: insertedAction.roleAffected,
      createdAt: insertedAction.createdAt,
    },
  };
}

module.exports = { suspend, unsuspend, revokeRole, deleteProviderProfile, editProfile, NotImplementedError };
