const User = require('../models/User');

/**
 * Startup health check (D-30). Runs once after Mongoose connects.
 * Counts users missing moderationStatus. If >0, logs a warning.
 * Does NOT auto-migrate — admin runs `node scripts/migrate-moderation.js` deliberately.
 */
async function ensureBaseline() {
  try {
    const pending = await User.countDocuments({ 'moderationStatus.state': { $exists: false } });
    if (pending > 0) {
      console.warn(`[Baseline] ${pending} users missing moderationStatus — run: node scripts/migrate-moderation.js`);
    } else {
      console.log('[Baseline] All users have moderationStatus.');
    }
  } catch (err) {
    console.error('[Baseline] Check failed:', err.message);
  }
}

module.exports = { ensureBaseline };
