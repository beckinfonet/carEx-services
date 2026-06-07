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
const mongoose = require('mongoose');
const { z } = require('zod');
const Notification = require('../models/Notification');
const Subscription = require('../models/Subscription');
const DeviceToken = require('../models/DeviceToken');
const { createSubscriptionSchema, registerDeviceTokenSchema, cadenceEnum, eventEnum } = require('./schemas');

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
  'invalid_object_id',        // malformed :id route param (cast guard)
]);

// All four watch events (D-03). A watch create that omits `events` subscribes to
// the full set so a follower never silently misses a price_drop/booked/sold/etc.
const ALL_WATCH_EVENTS = eventEnum.options.slice();

// Validate a route :id param as a Mongo ObjectId BEFORE building a filter, so a
// garbage id throws a clean 400 instead of a CastError 500.
function assertObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error('invalid_object_id');
    throw err;
  }
}

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

// ───────────────────────────────────────────────────────────────────────────
// Subscription CRUD (NSUB-01/03, NPRF-01/02).
//
// All subscription routes are uid-scoped from the token. POST forces
// uid = req.auth.uid server-side and IGNORES any body uid (IDOR guard,
// T-12-04-01). PATCH/DELETE filter { _id, uid } so a caller can only touch
// their own subscriptions.
// ───────────────────────────────────────────────────────────────────────────

// Inline edit schema (NPRF-02). The mobile manage screen only edits cadence
// (saved_search) or events (watch). .strict() rejects unknown keys; at least one
// editable field must be present. uid/kind/criteria/carId are immutable post-create.
const editSubscriptionSchema = z.object({
  cadence: cadenceEnum.optional(),
  events: z.array(eventEnum).nonempty().optional(),
}).strict().refine(
  (body) => body.cadence !== undefined || body.events !== undefined,
  { message: 'no editable fields provided' },
);

// POST /subscriptions — create a saved_search or watch subscription.
router.post('/subscriptions', async (req, res) => {
  const parsed = createSubscriptionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const uid = req.auth.uid; // server-side identity ONLY — body uid is ignored.
    const data = parsed.data;

    const doc = { uid, kind: data.kind, cadence: data.cadence || 'instant' };
    if (data.kind === 'saved_search') {
      doc.criteria = data.criteria;
    } else {
      // watch — default events to all four (D-03) when omitted.
      doc.carId = data.carId;
      doc.events = data.events && data.events.length ? data.events : ALL_WATCH_EVENTS.slice();
    }

    const created = await Subscription.create(doc);
    return res.status(201).json(created.toObject());
  } catch (err) {
    return handleServiceError(err, res, 'create-subscription');
  }
});

// GET /subscriptions — list the caller's ACTIVE subscriptions (NPRF-01).
router.get('/subscriptions', async (req, res) => {
  try {
    const uid = req.auth.uid;
    const items = await Subscription
      .find({ uid, active: true })
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ items });
  } catch (err) {
    return handleServiceError(err, res, 'list-subscriptions');
  }
});

// PATCH /subscriptions/:id — edit cadence/events on the caller's own sub (NPRF-02).
// Filter { _id, uid } — a PATCH on another user's id matches 0 rows (IDOR).
router.patch('/subscriptions/:id', async (req, res) => {
  const parsed = editSubscriptionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    assertObjectId(req.params.id);
    const uid = req.auth.uid;

    const $set = {};
    if (parsed.data.cadence !== undefined) $set.cadence = parsed.data.cadence;
    if (parsed.data.events !== undefined) $set.events = parsed.data.events;

    const updated = await Subscription.findOneAndUpdate(
      { _id: req.params.id, uid },
      { $set },
      { new: true },
    ).lean();

    if (!updated) {
      // Either no such id, or it belongs to another uid (IDOR) — same opaque 400
      // either way so a caller cannot probe for the existence of others' ids.
      throw new Error('subscription_not_found');
    }
    return res.status(200).json(updated);
  } catch (err) {
    return handleServiceError(err, res, 'edit-subscription');
  }
});

// DELETE /subscriptions/:id — remove the caller's own subscription (NPRF-02).
// Hard delete; the past notification rows it produced are NOT touched. Filter
// { _id, uid } so another user's id deletes 0 rows (IDOR).
router.delete('/subscriptions/:id', async (req, res) => {
  try {
    assertObjectId(req.params.id);
    const uid = req.auth.uid;

    const result = await Subscription.deleteOne({ _id: req.params.id, uid });
    if (result.deletedCount === 0) {
      throw new Error('subscription_not_found');
    }
    return res.status(200).json({ deleted: result.deletedCount });
  } catch (err) {
    return handleServiceError(err, res, 'delete-subscription');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Device-token register / unregister (Phase 13 NPUSH-04).
//
// Same auth model as the subscription routes: mounted under verifyIdToken (NOT
// admin-gated), and uid is ALWAYS req.auth.uid — NEVER read from body/params
// (V4 IDOR). The PushService (mobile) consumes these; uid travels in the Bearer.
// ───────────────────────────────────────────────────────────────────────────

// POST /device-tokens — register (upsert) the caller's device token.
// `token` is globally unique on the model; an upsert reassigns it to the current
// uid (a re-login on the same device moves the row, never duplicates it).
router.post('/device-tokens', async (req, res) => {
  const parsed = registerDeviceTokenSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const uid = req.auth.uid; // server-side identity ONLY — body uid is ignored.
    const { token, platform, appVersion } = parsed.data;

    const set = { uid, platform, lastSeenAt: new Date() };
    if (appVersion !== undefined) set.appVersion = appVersion;

    // Upsert on the unique token. setDefaultsOnInsert seeds createdAt on first write.
    await DeviceToken.updateOne(
      { token },
      { $set: set, $setOnInsert: { token } },
      { upsert: true, setDefaultsOnInsert: true },
    );

    return res.status(201).json({ registered: true });
  } catch (err) {
    return handleServiceError(err, res, 'register-device-token');
  }
});

// DELETE /device-tokens/:token — unregister the caller's own token.
// Filter ALWAYS includes uid: req.auth.uid so another user's token deletes 0
// rows (IDOR-safe). Idempotent: a non-existent / non-owned token returns 0.
router.delete('/device-tokens/:token', async (req, res) => {
  try {
    const uid = req.auth.uid;
    const token = req.params.token;
    const result = await DeviceToken.deleteOne({ uid, token });
    return res.status(200).json({ deleted: result.deletedCount ?? 0 });
  } catch (err) {
    return handleServiceError(err, res, 'unregister-device-token');
  }
});

module.exports = router;
