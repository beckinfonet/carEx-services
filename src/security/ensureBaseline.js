const User = require('../models/User');
const Car = require('../models/Car');

/**
 * Startup health check (D-30 / D-17). Runs once after Mongoose connects.
 * Counts users missing moderationStatus AND cars missing status. If either
 * is >0, logs a warning. Does NOT auto-migrate — admin runs
 * `node scripts/migrate-moderation.js` and/or
 * `node scripts/migrate-listing-moderation.js` deliberately.
 */
async function ensureBaseline() {
  try {
    const pending = await User.countDocuments({ 'moderationStatus.state': { $exists: false } });
    if (pending > 0) {
      console.warn(`[Baseline] ${pending} users missing moderationStatus — run: node scripts/migrate-moderation.js`);
    } else {
      console.log('[Baseline] All users have moderationStatus.');
    }
    const pendingListings = await Car.countDocuments({ status: { $exists: false } });
    if (pendingListings > 0) {
      console.warn(`[Baseline] ${pendingListings} listings missing status — run: node scripts/migrate-listing-moderation.js`);
    } else {
      console.log('[Baseline] All listings have status.');
    }
  } catch (err) {
    console.error('[Baseline] Check failed:', err.message);
  }
}

module.exports = { ensureBaseline };
