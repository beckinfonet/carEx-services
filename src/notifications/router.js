// src/notifications/router.js
//
// Notification domain REST router (Phase 12, NDOM-05 / NCEN-* / NSUB-* / NPRF-*).
//
// Mounted in 12-05 under:
//   app.use('/api/notifications', verifyIdToken, notificationRouter)
// verifyIdToken ONLY — never an admin gate. The notification center is a
// per-user surface every authenticated buyer can reach (NDOM-05), not an
// admin tool.
//
// SECURITY (T-12-04-01 / V4 IDOR): the caller's identity is ALWAYS taken from
// the verified token (`req.auth.uid`). It is NEVER read from the request body
// or route params. Every Mongo filter below includes `uid: req.auth.uid`, so a
// caller can only ever see / mutate their own notifications + subscriptions.
//
// Endpoints:
//   GET    /                   → reverse-chron base64-cursor feed (NCEN-02)
//   GET    /unread-count       → { count } of { uid, read:false } (NCEN-03)
//   PATCH  /:id/read           → mark one read (filter { _id, uid }) (NCEN-04)
//   PATCH  /read-all           → mark all read for { uid } (NCEN-04)
//   POST   /subscriptions      → create (saved_search | watch) (NSUB-01/03)
//   GET    /subscriptions      → list { uid, active:true } (NPRF-01)
//   PATCH  /subscriptions/:id  → edit cadence/events (NPRF-02)
//   DELETE /subscriptions/:id  → delete own subscription (NPRF-02)

const express = require('express');
const Notification = require('../models/Notification');
const Subscription = require('../models/Subscription');
const { createSubscriptionSchema, cadenceEnum, eventEnum } = require('./schemas');

// Base64 {createdAt,_id} cursor helpers — COPIED VERBATIM from
// src/moderation/router.js:27-45 (S1). Deterministic tiebreak on _id for the
// reverse-chron (createdAt DESC, _id DESC) sort; opaque to the mobile client.
function encodeCursor(item) {
  if (!item) return null;
  return Buffer.from(
    JSON.stringify({ createdAt: item.createdAt.toISOString(), _id: item._id.toString() }),
    'utf8',
  ).toString('base64');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed.createdAt || !parsed._id) throw new Error('missing fields');
    return { createdAt: new Date(parsed.createdAt), _id: parsed._id };
  } catch (_err) {
    return undefined; // sentinel — caller emits 400 invalid_cursor
  }
}

const router = express.Router();

// Service errors this module translates to user-facing 400 responses (S4).
// Anything not in this set bubbles up as 500 internal_error.
const KNOWN_USER_ERRORS = new Set([
  'invalid_cursor',           // malformed feed cursor
  'invalid_payload',          // schema gate failure
  'subscription_not_found',   // PATCH/DELETE on a non-existent / non-owned sub
  'not_owner',                // IDOR — id exists but belongs to another uid
]);

function handleServiceError(err, res, tag) {
  if (KNOWN_USER_ERRORS.has(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  // eslint-disable-next-line no-console
  console.error(`[notifications] ${tag} error:`, err);
  return res.status(500).json({ error: 'internal_error', message: err.message });
}

// ───────────────────────────────────────────────────────────────────────────
// GET / — reverse-chron base64-cursor feed (NCEN-02).
// Filter is ALWAYS { uid: req.auth.uid } — a second user's rows can never appear.
// ───────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const uid = req.auth.uid;

    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 100) // DoS clamp (T-12-04-04)
      : 25;

    const cursorRaw = req.query.cursor;
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursor === undefined) {
      return res.status(400).json({ error: 'invalid_cursor' });
    }

    const query = { uid };
    if (cursor) {
      // Strictly after the cursor in (createdAt DESC, _id DESC) order.
      query.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
      ];
    }

    // Fetch limit+1 to detect a next page without a second count() round-trip.
    const rows = await Notification
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;

    return res.status(200).json({ items, nextCursor });
  } catch (err) {
    return handleServiceError(err, res, 'feed');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /unread-count — count of { uid, read:false } (NCEN-03).
// ───────────────────────────────────────────────────────────────────────────
router.get('/unread-count', async (req, res) => {
  try {
    const uid = req.auth.uid;
    const count = await Notification.countDocuments({ uid, read: false });
    return res.status(200).json({ count });
  } catch (err) {
    return handleServiceError(err, res, 'unread-count');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /read-all — mark all of the caller's unread rows read (NCEN-04).
// Declared BEFORE /:id/read so '/read-all' is never captured by the :id param.
// ───────────────────────────────────────────────────────────────────────────
router.patch('/read-all', async (req, res) => {
  try {
    const uid = req.auth.uid;
    const result = await Notification.updateMany(
      { uid, read: false },
      { $set: { read: true } },
    );
    return res.status(200).json({ updated: result.modifiedCount ?? 0 });
  } catch (err) {
    return handleServiceError(err, res, 'read-all');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /:id/read — mark ONE row read (NCEN-04).
// Ownership is enforced via { _id, uid } — a PATCH on another user's id matches
// 0 rows (IDOR guard, T-12-04-01). Returns 404 subscription-style not-found is
// NOT used here; read-state is idempotent, so 0-match returns { updated: 0 }.
// ───────────────────────────────────────────────────────────────────────────
router.patch('/:id/read', async (req, res) => {
  try {
    const uid = req.auth.uid;
    const result = await Notification.updateOne(
      { _id: req.params.id, uid },
      { $set: { read: true } },
    );
    return res.status(200).json({ updated: result.modifiedCount ?? 0 });
  } catch (err) {
    return handleServiceError(err, res, 'read-one');
  }
});

module.exports = router;
