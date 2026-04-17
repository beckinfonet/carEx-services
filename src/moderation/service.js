// Stub module. Real implementations land in Phase 2.
// Signatures locked here so Phase 2 planners have a stable contract.

class NotImplementedError extends Error {
  constructor(method) {
    super(`ModerationService.${method} is not yet implemented (Phase 2)`);
    this.name = 'NotImplementedError';
  }
}

async function suspend({ adminUid, targetUid, severity, reasonCategory, note }) {
  throw new NotImplementedError('suspend');
}

async function unsuspend({ adminUid, targetUid, note }) {
  throw new NotImplementedError('unsuspend');
}

async function revokeRole({ adminUid, targetUid, role, reasonCategory, note }) {
  throw new NotImplementedError('revokeRole');
}

async function deleteProviderProfile({ adminUid, targetUid, role, reasonCategory, note }) {
  throw new NotImplementedError('deleteProviderProfile');
}

async function editProfile({ adminUid, targetUid, role, fieldDiff, note }) {
  throw new NotImplementedError('editProfile');
}

module.exports = { suspend, unsuspend, revokeRole, deleteProviderProfile, editProfile, NotImplementedError };
