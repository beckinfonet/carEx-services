// Buyer-private fields that must NEVER reach a seller who has not paid to unlock.
const SELLER_HIDDEN_FIELDS = [
  'buyerUid',
  'contactPhone',
  'contactPhoneVerified',
  'telegramUsername',
  'telegramVerified',
];

/**
 * Produce a seller-safe copy of a CarRequest. Strips every contact/owner field
 * and tags the result with `unlocked`. Pure — never mutates the input. Accepts
 * either a Mongoose document (with .toObject()) or a plain/lean object.
 */
function redactForSeller(doc, { unlocked = false } = {}) {
  const obj = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  for (const field of SELLER_HIDDEN_FIELDS) {
    delete obj[field];
  }
  obj.unlocked = unlocked;
  return obj;
}

module.exports = { redactForSeller, SELLER_HIDDEN_FIELDS };
