// src/moderation/listingCapabilities.js
//
// LISTING_STATUS_POLICY — capability map for the 4 Car.status states (LDATA-01).
// Downstream consumers: Phase 9 (read-time hide hooks + cart-add re-verification)
// and Phase 11 (buyer-banner copy via translation-key references). See 07-CONTEXT.md D-14.

const LISTING_STATUS_POLICY = {
  active: {
    buyerBlocked: [],
    banner: null,
  },
  suspended: {
    buyerBlocked: ['add_to_cart', 'confirm_booking'],
    banner: {
      titleKey: 'listingBannerSuspendedTitle',
      bodyKey: 'listingBannerSuspendedBody',
      severity: 'warning',
    },
  },
  archived: {
    buyerBlocked: ['add_to_cart', 'confirm_booking'],
    banner: {
      titleKey: 'listingBannerArchivedTitle',
      bodyKey: 'listingBannerArchivedBody',
      severity: 'neutral',
    },
  },
  deleted: {
    buyerBlocked: ['view', 'add_to_cart', 'confirm_booking'],
    banner: {
      titleKey: 'listingBannerDeletedTitle',
      bodyKey: 'listingBannerDeletedBody',
      severity: 'destructive',
    },
  },
};

/**
 * Resolve the list of blocked buyer actions for a given listing-moderation state.
 * Used by Phase 9's read-time enforcement (cart-add + confirm-booking re-verify).
 *
 * Per 07-CONTEXT.md D-14, this resolver returns `[]` for unknown states (nullish-coalesce
 * fallback) rather than throwing — different rationale from v1.0's `resolveRestrictedFeatures`
 * which throws. Listing state arrives from arbitrary client paths in Phase 9; defensive
 * fallback is preferred over a thrown error that would leak the moderation taxonomy.
 *
 * @param {'active'|'suspended'|'archived'|'deleted'|string} state
 * @returns {string[]} blocked buyer-action tokens; empty array for active or unknown state
 */
function resolveBlockedBuyerActions(state) {
  return LISTING_STATUS_POLICY[state]?.buyerBlocked ?? [];
}

module.exports = { LISTING_STATUS_POLICY, resolveBlockedBuyerActions };
