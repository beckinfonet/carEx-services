const STATUS_POLICY = {
  active: {
    capabilities: 'all',
    banner: null,
  },
  feature_limited: {
    capabilities: {
      blocked: [
        'create_listing',
        'create_order',
        'contact_seller',
        'request_seller_role',
        'request_broker_role',
        'request_logistics_role',
        'update_profile',
      ],
    },
    banner: {
      titleKey: 'moderation.feature_limited.title',
      bodyKey: 'moderation.feature_limited.body',
      appealAllowed: false,
      resolutionHintKey: 'moderation.feature_limited.resolution',
    },
  },
  blocked_with_review: {
    capabilities: { blocked: 'all_writes' },
    banner: {
      titleKey: 'moderation.blocked_with_review.title',
      bodyKey: 'moderation.blocked_with_review.body',
      appealAllowed: true,
      appealEmail: 'support@carexmarket.com',
    },
  },
  permanently_banned: {
    capabilities: { blocked: 'all_writes' },
    banner: {
      titleKey: 'moderation.permanently_banned.title',
      bodyKey: 'moderation.permanently_banned.body',
      appealAllowed: false,
    },
  },
};

/**
 * Resolve the list of restricted feature tokens for a given moderation state.
 * Used by Phase 2's moderation service when writing user.moderationStatus.restrictedFeatures (D-12).
 *
 * @param {'active'|'feature_limited'|'blocked_with_review'|'permanently_banned'} state
 * @returns {string[]} restricted feature tokens; empty array if state is 'active';
 *                    the sentinel ['all_writes'] for blocked_with_review / permanently_banned
 */
function resolveRestrictedFeatures(state) {
  const entry = STATUS_POLICY[state];
  if (!entry) throw new Error(`Unknown moderation state: ${state}`);
  if (entry.capabilities === 'all') return [];
  if (entry.capabilities.blocked === 'all_writes') return ['all_writes'];
  if (Array.isArray(entry.capabilities.blocked)) return [...entry.capabilities.blocked];
  throw new Error(`Malformed STATUS_POLICY entry for state: ${state}`);
}

module.exports = { STATUS_POLICY, resolveRestrictedFeatures };
