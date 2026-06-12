const mongoose = require('mongoose');

function getUser() {
  if (!mongoose.models.User) require('../models/User');
  return mongoose.model('User');
}
function getNotification() {
  if (!mongoose.models.Notification) require('../models/Notification');
  return mongoose.model('Notification');
}

/**
 * Notify a request's buyer that a seller unlocked their contact. 1:1 (not the
 * car-watch emit() fan-out). Gated by the buyer's prefs — muteAll and
 * requestUnlockEnabled both default ON (a missing field is treated as enabled).
 * Push is best-effort: a push failure is swallowed so the row still lands.
 * Returns the Notification row, or null if suppressed / buyer unknown.
 *
 * @param {object} request - the CarRequest (needs buyerUid, makeName, modelName)
 * @param {object} [deps] - { User, Notification, fcm } injectable for tests
 */
async function notifyRequestUnlocked(request, deps = {}) {
  const User = deps.User || getUser();
  const Notification = deps.Notification || getNotification();

  const buyer = await User.findOne({ firebaseUid: request.buyerUid })
    .select('firebaseUid notificationPrefs language')
    .lean();
  if (!buyer) return null;

  const prefs = buyer.notificationPrefs || {};
  if (prefs.muteAll === true) return null;
  if (prefs.requestUnlockEnabled === false) return null;

  const makeModel = request.modelName ? `${request.makeName} ${request.modelName}` : request.makeName;
  const deeplink = 'carex://my-requests';

  const [row] = await Notification.create([
    {
      uid: request.buyerUid,
      kind: 'request_unlock',
      titleKey: 'request_unlock',
      bodyKey: 'request_unlock',
      params: { makeModel },
      data: { deeplink, carId: null },
    },
  ]);

  try {
    const fcm = deps.fcm || require('../notifications/push/fcm');
    await fcm.send({
      uid: request.buyerUid,
      title: 'request_unlock',
      lang: buyer.language === 'EN' ? 'EN' : 'RU',
      data: { deeplink },
    });
  } catch (e) {
    console.error('[car-requests] unlock push failed:', e.message);
  }

  return row;
}

module.exports = { notifyRequestUnlocked };
