// src/notifications/digest.js
//
// Phase 14 NDIG-02 / NDIG-03: the crash-safe daily-digest flush.
//
// runDigest({ now, deps }) is a PURE, directly-callable function — it does NOT
// register the cron (that is Plan 04, which consumes DIGEST_HOUR from here). Tests
// invoke it directly with an injected mock fcm.
//
// FLUSH CONTRACT (RESEARCH A1 / A4 / Pitfall 5 — LOCKED):
//   1. SNAPSHOT + CLAIM: one atomic updateMany stamps digestRunId = runStart.toISOString()
//      on every row matching { digestPending:true, createdAt:{ $lte: runStart } }. A row
//      created AFTER runStart belongs to tomorrow and is excluded. The claim is
//      re-runnable: a later runStart re-stamps leftover rows from a crashed prior run.
//   2. GROUP by uid (plain JS reduce — no $group pipeline).
//   3. Per uid: resolve User.language (default 'RU') and run the HIDE-HOOK re-check —
//      for each row carrying data.carId, a PLAIN Car.findById (NO bypass flags) drops
//      the row if the Car is null or status !== 'active'. Rows with carId === null
//      (saved-search rows) skip the per-car re-check.
//   4. ONE fcm.sendDigest call per uid with count = surviving rows, lang, and
//      data.deeplink 'carex://notifications'.
//   5. On { ok:true } → clear digestPending:false and $unset digestRunId for ONLY that
//      uid's surviving sent ids (per-id). On !ok → leave them digestPending:true so the
//      next morning re-picks them (NO DROP). Each per-uid iteration is wrapped so one
//      user's send failure never aborts the loop.
//
// ============================================================================
// HIDE-HOOK DISCIPLINE — mirrors notificationService.emit() (RESEARCH §Pattern 2).
// The Car re-read uses a PLAIN Car.findById so the Phase 3/9 pre(/^find/) hide-hooks
// APPLY (a suspended/archived/deleted listing — or one whose seller is non-active —
// resolves to null / a non-active doc and is SUPPRESSED). NEVER add the seller/listing
// hide-hook bypass query options (includeAllListingStatuses / includeAllUsers /
// setOptions) to the findById in this file. A grep gate (acceptance criteria) asserts
// ZERO bypass-flag names appear in this source.
// ============================================================================
//
// DOUBLE-SEND TRADEOFF (LOCKED NDIG-02 contract): we guarantee NO DROP and accept the
// rare post-send/pre-clear duplicate (no separate digestSent marker). Single-instance
// Railway; the window is the narrow gap between sendDigest resolving and the clear
// updateMany. Strict zero-duplicate is deferred (pairs with NOTF2-06). No transaction /
// advisory lock — per-doc updateMany atomicity is the design (RESEARCH A1).

const mongoose = require('mongoose');
const defaultFcm = require('./push/fcm');
const { NOTIFICATION_RETENTION_DAYS } = require('../models/Notification');

// The single named fire-time constant (D-01). Plan 04's cron builds its expression
// from this; it lives here as the one retune point. 08:00 Asia/Bishkek.
const DIGEST_HOUR = 8;

// Stale device-token retention (NDIG-05). A token whose lastSeenAt is older than this
// is treated as abandoned and pruned. lastSeenAt is refreshed on EVERY device-token
// register/refresh (router.js:315 — confirmed: the upsert $set always carries
// lastSeenAt: new Date()), so its age is a valid liveness signal (RESEARCH A2). 90 days
// unseen ≈ 3 months — FCM would also reject such a token on the next real send, so this
// is the EXTRA/stale layer, NON-DUPLICATIVE with fcm.send's send-time pruneToken (which
// only removes tokens FCM actively rejects). Same value as the notification retention.
const TOKEN_STALE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// The Notification-Center deeplink (Plan 05 wires this route on mobile).
const DIGEST_DEEPLINK = 'carex://notifications';

/**
 * Crash-safe daily-digest flush. Pure and directly callable (no cron).
 *
 * @param {object} [opts]
 * @param {Date} [opts.now] - the run timestamp; the snapshot bound is createdAt <= now.
 * @param {object} [opts.deps] - injectable models/collaborators for testing:
 *        { Notification, Car, User, fcm } (default to the mongoose models / fcm module).
 * @returns {Promise<{ claimed:number, users:number, sent:number, cleared:number }>}
 */
async function runDigest({ now = new Date(), deps = {} } = {}) {
  const Notification = deps.Notification || mongoose.model('Notification');
  const Car = deps.Car || mongoose.model('Car');
  const User = deps.User || mongoose.model('User');
  const fcm = deps.fcm || defaultFcm;

  const runStart = now instanceof Date ? now : new Date(now);
  const runId = runStart.toISOString();

  // (1) SNAPSHOT + CLAIM — atomic. Stamp this run's id on every pending row created on
  // or before runStart. Re-runnable: leftover rows from a crashed run (still pending,
  // possibly carrying a stale digestRunId) match and are re-stamped.
  await Notification.updateMany(
    { digestPending: true, createdAt: { $lte: runStart } },
    { $set: { digestRunId: runId } },
  );

  // Read the claimed set back (lean — read-only grouping work).
  const claimed = await Notification.find({ digestPending: true, digestRunId: runId }).lean();
  if (!claimed.length) {
    // No flush work, but the same run still owes its retention prune (NDIG-05/NDOM-06):
    // an idle digest morning must still reap 90-day notifications + stale tokens.
    await prune(runStart, deps);
    return { claimed: 0, users: 0, sent: 0, cleared: 0 };
  }

  // (2) GROUP by uid (plain reduce — no $group pipeline).
  const byUid = claimed.reduce((acc, row) => {
    (acc[row.uid] = acc[row.uid] || []).push(row);
    return acc;
  }, {});

  let sent = 0;
  let cleared = 0;

  // (3)-(5) per-uid: hide-hook re-check, one sendDigest, clear-only-sent-ids.
  for (const uid of Object.keys(byUid)) {
    try {
      const rows = byUid[uid];

      // (3) language resolution (default 'RU').
      const user = await User.findOne({ firebaseUid: uid }).lean();
      const lang = (user && user.language) || 'RU';

      // (3) hide-hook re-check — drop rows whose target Car is now null / non-active.
      // Rows without a carId (saved-search) skip the per-car re-check.
      const surviving = [];
      for (const row of rows) {
        const carId = row.data && row.data.carId;
        if (!carId) {
          surviving.push(row);
          continue;
        }
        // PLAIN findById — NO bypass flags (mirror notificationService.emit).
        const car = await Car.findById(carId);
        if (car && car.status === 'active') {
          surviving.push(row);
        }
        // null / non-active → dropped: left digestPending:true (not sent, not lost).
      }

      if (!surviving.length) continue;

      const survivingIds = surviving.map((r) => r._id);

      // (4) ONE sendDigest per uid with the surviving count.
      const result = await fcm.sendDigest({
        uid,
        count: survivingIds.length,
        lang,
        data: { deeplink: DIGEST_DEEPLINK },
      });

      // (5) clear ONLY the sent ids on ok; leave pending on !ok (no drop).
      if (result && result.ok) {
        sent += 1;
        await Notification.updateMany(
          { _id: { $in: survivingIds } },
          { $set: { digestPending: false }, $unset: { digestRunId: '' } },
        );
        cleared += survivingIds.length;
      }
    } catch (err) {
      // One user's failure (e.g. sendDigest reject — should not happen per Plan 02's
      // never-throw contract, but defensively wrapped) must NEVER abort the loop. The
      // rows stay digestPending:true for the next morning's re-run (no drop).
      // eslint-disable-next-line no-console
      console.error('[digest] per-user flush failed for uid:', uid, err && err.message);
    }
  }

  // (6) SAME-RUN RETENTION PRUNE (NDIG-05/NDOM-06) — after the flush, bounded + non-fatal.
  await prune(runStart, deps);

  return { claimed: claimed.length, users: Object.keys(byUid).length, sent, cleared };
}

/**
 * Same-run retention prune (NDIG-05 / NDOM-06). Runs at the END of a digest, AFTER the
 * flush, so the morning cron does double duty. Two date-BOUNDED deletes (never an
 * unconditional deleteMany — T-14-04-01):
 *   1. Notifications older than NOTIFICATION_RETENTION_DAYS (90) by createdAt.
 *   2. DeviceTokens whose lastSeenAt is older than TOKEN_STALE_DAYS (90). This is the
 *      EXTRA/stale layer: fcm.send already prunes FCM-REJECTED tokens at send time
 *      (pruneToken → DeviceToken.deleteOne); this targets tokens that simply went quiet
 *      (lastSeenAt is refreshed on every register/refresh — router.js:315), so the two
 *      are non-duplicative.
 *
 * Wrapped end-to-end: a prune failure is LOGGED but NEVER thrown out of runDigest — a
 * prune error must never block or re-fire the flush.
 */
async function prune(now, deps = {}) {
  const Notification = deps.Notification || mongoose.model('Notification');
  const DeviceToken = deps.DeviceToken || mongoose.model('DeviceToken');
  const at = now instanceof Date ? now : new Date(now);

  try {
    const notifCutoff = new Date(at.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
    // BOUNDED: only rows strictly older than the 90-day cutoff (a fresh row is kept).
    await Notification.deleteMany({ createdAt: { $lt: notifCutoff } });

    const tokenCutoff = new Date(at.getTime() - TOKEN_STALE_DAYS * DAY_MS);
    // BOUNDED: only tokens unseen since before the stale cutoff (a recent token is kept).
    await DeviceToken.deleteMany({ lastSeenAt: { $lt: tokenCutoff } });
  } catch (err) {
    // Non-fatal: a prune error must never escape runDigest (no re-fire, no flush block).
    // eslint-disable-next-line no-console
    console.error('[digest] retention prune failed (non-fatal):', err && err.message);
  }
}

module.exports = { runDigest, prune, DIGEST_HOUR, TOKEN_STALE_DAYS };
