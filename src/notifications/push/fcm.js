// src/notifications/push/fcm.js
//
// Phase 13 NPUSH-05: real firebase-admin FCM fan-out, replacing the Phase-12
// success-shaped no-op stub.
//
// Contract (stays compatible with notificationService.js:213 —
//   fcm.send({ uid, title: keys.titleKey, data: target.data })):
//   send({ uid, titleKey|title, lang, data })
//     1. Pull DeviceToken rows for the uid (the fan-out source of truth).
//        No tokens → { ok:true, delivered:0 } WITHOUT touching firebase-admin.
//     2. Render GENERIC, param-free push copy via renderGenericPush — NEVER the
//        caller's PII params. Only data.deeplink crosses into the payload
//        (D-07/D-08b: no make/model, price, seller, or location on the lock screen).
//     3. sendEachForMulticast → per-token responses, isolated:
//          - registration-token-not-registered / invalid-argument → PRUNE
//            (DeviceToken.deleteOne), permanently dead.
//          - transient / 429 (unavailable, internal, quota/429, timeout) →
//            BOUNDED jittered exponential backoff retry (≤ MAX_ATTEMPTS) for
//            ONLY the still-transient tokens; never pruned, never an unbounded loop.
//          - any other error → logged, left alone (no prune, no throw).
//        ONE bad token NEVER aborts the fan-out and NEVER throws.
//
// Uses the cached-OAuth admin from src/security/firebaseAdmin.js. Do NOT add
// google-auth-library — firebase-admin manages/caches OAuth internally.

const { ensureInitialized } = require('../../security/firebaseAdmin');
const DeviceToken = require('../../models/DeviceToken');
const { renderGenericPush } = require('../translations');

// Bounded retry budget for transient/429 responses (RESEARCH Open Q3: ≈3 attempts,
// jittered exponential). 1 initial send + up to 2 retries = 3 total attempts.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 100;

// FCM error codes that mean the token is permanently dead → prune.
const PRUNE_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

// FCM error codes that are transient / rate-limited → bounded backoff retry.
const TRANSIENT_CODES = new Set([
  'messaging/unavailable',
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/quota-exceeded',
  'messaging/too-many-requests',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/timeout',
]);

function jitteredBackoff(attempt) {
  // attempt is 1-based for the retry number; exponential with full jitter.
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.floor(Math.random() * ceiling);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Prune one dead token; swallow any DB error so a prune failure never aborts the
// fan-out or surfaces to the caller.
async function pruneToken(token) {
  try {
    await DeviceToken.deleteOne({ token });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[fcm] failed to prune dead token:', err && err.message);
  }
}

/**
 * Fan out an OS push to all of a user's devices.
 *
 * @param {object} args
 * @param {string} args.uid - target user (DeviceToken.find source of truth).
 * @param {string} [args.titleKey] - generic push category key (e.g. 'price_drop').
 * @param {string} [args.title] - alias accepted from the legacy caller contract.
 * @param {'RU'|'EN'} [args.lang='RU'] - render language.
 * @param {object} [args.data] - routing data; ONLY data.deeplink is forwarded.
 * @returns {Promise<{ ok: boolean, delivered: number }>}
 */
async function send({ uid, titleKey, title, lang = 'RU', data = {} } = {}) {
  const rows = await DeviceToken.find({ uid }).lean();
  let tokens = (rows || []).map((r) => r.token).filter(Boolean);
  if (!tokens.length) return { ok: true, delivered: 0 };

  // GENERIC param-free copy ONLY — never the caller's PII params (D-08b).
  const categoryKey = titleKey || title;
  const { title: pushTitle, body } = renderGenericPush(categoryKey, lang);

  // Routing detail only — strip everything except the deeplink.
  const payloadData = data && data.deeplink ? { deeplink: String(data.deeplink) } : {};

  const message = { notification: { title: pushTitle, body }, data: payloadData };

  const admin = ensureInitialized();
  const messaging = admin.messaging();

  let delivered = 0;
  let attempt = 0;

  // Each pass sends to the currently-live `tokens`; transient failures shrink the
  // set to only the still-transient tokens for the next bounded attempt.
  while (tokens.length && attempt < MAX_ATTEMPTS) {
    attempt += 1;

    let resp;
    try {
      // eslint-disable-next-line no-await-in-loop
      resp = await messaging.sendEachForMulticast({ tokens, ...message });
    } catch (err) {
      // A whole-batch failure is treated as transient: back off and retry the
      // same set, bounded by MAX_ATTEMPTS. Never throw out of send().
      // eslint-disable-next-line no-console
      console.error('[fcm] sendEachForMulticast threw:', err && err.message);
      if (attempt >= MAX_ATTEMPTS) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(jitteredBackoff(attempt));
      continue; // retry the same tokens
    }

    const responses = (resp && resp.responses) || [];
    const retryTokens = [];

    for (let i = 0; i < responses.length; i += 1) {
      const r = responses[i];
      const token = tokens[i];
      if (r && r.success) {
        delivered += 1;
        continue;
      }
      const code = r && r.error && r.error.code;
      if (PRUNE_CODES.has(code)) {
        // eslint-disable-next-line no-await-in-loop
        await pruneToken(token);
      } else if (TRANSIENT_CODES.has(code)) {
        retryTokens.push(token); // keep — bounded retry below.
      } else {
        // Unknown error: log and leave the token alone (no prune, no abort).
        // eslint-disable-next-line no-console
        console.error('[fcm] non-retryable token error:', code);
      }
    }

    tokens = retryTokens;
    if (!tokens.length) break;
    if (attempt < MAX_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(jitteredBackoff(attempt));
    }
  }

  return { ok: true, delivered };
}

module.exports = { send };
