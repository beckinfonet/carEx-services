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

/**
 * Seller-safe copy of an UNLOCKED request: keeps the contact fields the seller
 * paid for, strips only the internal buyerUid, tags unlocked:true. Pure — never
 * mutates the input. Accepts a Mongoose doc (.toObject()) or a plain/lean object.
 */
function revealForSeller(doc) {
  const obj = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj.buyerUid;
  obj.unlocked = true;
  return obj;
}

module.exports = { redactForSeller, revealForSeller, SELLER_HIDDEN_FIELDS };
