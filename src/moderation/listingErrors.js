// src/moderation/listingErrors.js
//
// Service-layer error class for listing moderation. Used by listingService.js
// to throw stable error codes that listingRouter.js maps to 400 responses via
// KNOWN_LISTING_ERRORS (Phase 8 D-12 — cleanup over v1.0's err.message
// string-matching pattern).
//
// Shape mirrors src/payments/confirmBooking.js:31 (ProviderSuspendedError):
// class extends Error with a stable `code` field, so router error-mapping
// discriminates known codes from generic Errors without parsing err.message.
//
// Edit-specific extension: when service throws ListingServiceError('invalid_field'),
// it may also attach err.fields = [...] (mirroring v1.0 service.js:451-454)
// so handleListingServiceError can surface the offending field names in the
// 400 body. The base class does not require fields; it is attached ad-hoc.

class ListingServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ListingServiceError';
    this.code = code;
  }
}

module.exports = { ListingServiceError };
