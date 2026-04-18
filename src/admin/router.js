// src/admin/router.js
//
// Plan 05-0b — Admin read router. Currently hosts exactly one route,
// GET /users/search (full path after mount: /api/admin/users/search).
// Mounted in server.js AFTER the existing inline /api/admin/* routes so the
// pre-existing endpoints (which predate this repo's auth-first convention)
// keep their current behavior and only our new route runs behind the
// verifyIdToken + requireAdmin chain.
//
// Deviation from Plan 05-0b (documented here intentionally):
//   - Plan references `verifyIdToken` from src/middleware/auth and
//     `getAdminStatus` from src/middleware/admin. This repo actually ships
//     the middleware at src/security/verifyIdToken.js and
//     src/security/requireAdmin.js. We import from those real paths and
//     call the repo's middleware name (`requireAdmin`), which is the
//     functional equivalent of the plan's `getAdminStatus`.
//
// Search contract (locked by 05-CONTEXT D-16.2, mobile Plan 05-03):
//   Response envelope: { users: SearchUserItem[], nextCursor: string | null }
//   Cursor shape mirrors Plan 05-0a's history cursor for mobile consistency.

const express = require('express');
const { verifyIdToken } = require('../security/verifyIdToken');
const { requireAdmin } = require('../security/requireAdmin');
const User = require('../models/User');
const AdminUser = require('../models/AdminUser');

const router = express.Router();

// Defence against ReDoS: `escapeRegex` below strips every regex metacharacter
// before passing a user-supplied substring to mongo $regex. The remaining cost
// is a single bounded collection scan, capped by limit+1.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cursor helpers — same base64(JSON({createdAt, _id})) shape as 05-0a so
// mobile code has exactly one cursor format to reason about.
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

const ALLOWED_ROLES = new Set(['buyer', 'seller', 'broker', 'logistics', 'admin']);
const ALLOWED_STATES = new Set([
  'active',
  'feature_limited',
  'blocked_with_review',
  'permanently_banned',
]);
const MAX_Q_LEN = 128;

// Explicit projection — backend-only fields (passwords, tokens, etc.) are NEVER
// listed here, so they can never leak in the response.
const PROJECTION = {
  firebaseUid: 1,
  email: 1,
  firstName: 1,
  lastName: 1,
  sellerStatus: 1,
  brokerStatus: 1,
  logisticsStatus: 1,
  'moderationStatus.state': 1,
  'moderationStatus.severity': 1,
  'moderationStatus.reasonCategory': 1,
  createdAt: 1,
};

// Load the admin-email roster used by the admin-role and buyer-role filters.
// AdminUser is the authoritative admin store in this repo (see requireAdmin);
// the User collection has no isAdmin field. Result is a Set of lowercased
// emails for O(1) membership checks.
async function loadAdminEmailsLower() {
  const rows = await AdminUser.find({}, { email: 1 }).lean();
  return new Set(rows.map((r) => String(r.email || '').toLowerCase()));
}

router.get('/users/search', verifyIdToken, requireAdmin, async (req, res) => {
  try {
    const { q: qRaw, role, state, cursor: cursorRaw } = req.query;
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;

    // ---- validation ----
    if (qRaw !== undefined && typeof qRaw !== 'string') {
      return res.status(400).json({ error: 'invalid_q' });
    }
    if (qRaw && qRaw.length > MAX_Q_LEN) {
      return res.status(400).json({ error: 'q_too_long' });
    }
    if (role !== undefined && !ALLOWED_ROLES.has(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }
    if (state !== undefined && !ALLOWED_STATES.has(state)) {
      return res.status(400).json({ error: 'invalid_state' });
    }

    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursor === undefined) {
      return res.status(400).json({ error: 'invalid_cursor' });
    }

    // ---- query construction ----
    const filter = {};
    const andClauses = [];

    if (qRaw && qRaw.trim().length > 0) {
      const escaped = escapeRegex(qRaw.trim());
      // Email substring (case-insensitive) OR Firebase UID prefix.
      filter.$or = [
        { email: { $regex: escaped, $options: 'i' } },
        { firebaseUid: { $regex: '^' + escaped } },
      ];
    }

    if (role === 'admin' || role === 'buyer') {
      const adminEmails = await loadAdminEmailsLower();
      if (role === 'admin') {
        if (adminEmails.size === 0) {
          return res.status(200).json({ users: [], nextCursor: null });
        }
        // Match User whose email (case-insensitive) is in the admin roster.
        andClauses.push({
          $or: Array.from(adminEmails).map((e) => ({
            email: new RegExp('^' + escapeRegex(e) + '$', 'i'),
          })),
        });
      } else {
        // "Buyer" = no approved provider role AND email NOT in admin roster.
        andClauses.push(
          { $or: [{ brokerStatus: { $ne: 'APPROVED' } }, { brokerStatus: { $exists: false } }] },
          { $or: [{ sellerStatus: { $ne: 'APPROVED' } }, { sellerStatus: { $exists: false } }] },
          { $or: [{ logisticsStatus: { $ne: 'APPROVED' } }, { logisticsStatus: { $exists: false } }] },
        );
        if (adminEmails.size > 0) {
          andClauses.push({
            $nor: Array.from(adminEmails).map((e) => ({
              email: new RegExp('^' + escapeRegex(e) + '$', 'i'),
            })),
          });
        }
      }
    } else if (role === 'broker') {
      filter.brokerStatus = 'APPROVED';
    } else if (role === 'seller') {
      filter.sellerStatus = 'APPROVED';
    } else if (role === 'logistics') {
      filter.logisticsStatus = 'APPROVED';
    }

    if (state) {
      filter['moderationStatus.state'] = state;
    }

    if (cursor) {
      andClauses.push({
        $or: [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
        ],
      });
    }

    if (andClauses.length > 0) {
      filter.$and = andClauses;
    }

    const rows = await User
      .find(filter, PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    // Rename firebaseUid -> localId to match mobile's SearchUserItem shape.
    const users = items.map((u) => {
      const { firebaseUid, _id, ...rest } = u;
      return { localId: firebaseUid || (_id ? _id.toString() : null), ...rest };
    });

    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;

    return res.status(200).json({ users, nextCursor });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[GET /api/admin/users/search] error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
