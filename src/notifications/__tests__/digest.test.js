// Phase 14 — Wave 0 scaffold (14-01).
//
// The single test file the whole of Phase 14 extends. Each VALIDATION.md row lands
// here as a `test.todo` placeholder now; downstream tasks (Plans 02/03/04) convert
// each todo into a real assertion against the digest worker (runDigest / sendDigest),
// the crash-safe snapshot/claim/clear flush, the 90-day + stale-token prune, and the
// hide-hook re-check.
//
// DB harness: the in-memory replica-set helper the integration rows will reuse
// (startReplSet/stopReplSet — single-node, just enough for any future session work).
// No withTransaction is used by the digest flush (per-id clear is sufficient), so a
// standalone MongoMemoryServer would also suffice; the replset is wired here so the
// downstream integration todos can adopt it without re-plumbing beforeAll/afterAll.
//
// require.main === module gate (NDIG-01): importing the service/digest module from a
// test MUST NOT start the cron — the scaffold asserts this once the module exists.

// ── firebase-admin + DeviceToken mocks for the sendDigest unit test (NDIG-03) ──
// Mirrors the fcm.test.js harness. These mocks are file-wide but the translation /
// pluralize tests below never touch firebaseAdmin or the DeviceToken model, so they
// are unaffected.
const mockSendEachForMulticast = jest.fn();
const mockMessaging = jest.fn(() => ({ sendEachForMulticast: mockSendEachForMulticast }));

jest.mock('../../security/firebaseAdmin', () => ({
  ensureInitialized: jest.fn(() => ({ messaging: mockMessaging })),
}));

const mockFind = jest.fn();
const mockDeleteOne = jest.fn(() => Promise.resolve({ deletedCount: 1 }));
jest.mock('../../models/DeviceToken', () => ({
  find: (...args) => mockFind(...args),
  deleteOne: (...args) => mockDeleteOne(...args),
}));

const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../../../__tests__/_helpers/mongoReplSet');
const { pluralizeRu, renderDigest } = require('../translations');
const { ensureInitialized } = require('../../security/firebaseAdmin');
const { sendDigest } = require('../push/fcm');

// Helpers mirroring fcm.test.js.
function mockTokens(rows) {
  mockFind.mockReturnValue({ lean: () => Promise.resolve(rows) });
}
function multicastResponse(responses) {
  return {
    successCount: responses.filter((r) => r.success).length,
    failureCount: responses.filter((r) => !r.success).length,
    responses,
  };
}
const okResp = () => ({ success: true, messageId: 'mid-' + Math.random() });
const errResp = (code) => ({ success: false, error: { code } });

let replset;

beforeAll(async () => {
  replset = await startReplSet();
});

afterAll(async () => {
  await stopReplSet(replset);
});

describe('Phase 14 daily digest', () => {
  // ── Scheduling & gating (NDIG-01 / NDIG-04) — REAL assertions (Plan 04 Task 2) ─
  // The cron lives in server.js, gated by `require.main === module`. A unit test cannot
  // easily run server.js as a CLI entrypoint, so these rows assert the source contract:
  // the schedule call is INSIDE the gate (never module top-level) and its expression +
  // options derive from DIGEST_HOUR / Asia/Bishkek. The `require('./server') starts no
  // scheduler` behavior is additionally proven by the plan's `node -e` verify step.
  describe('NDIG-01 / NDIG-04 cron registration in server.js', () => {
    const fs = require('fs');
    const path = require('path');
    const serverSrc = fs.readFileSync(path.join(__dirname, '../../../server.js'), 'utf8');
    const { DIGEST_HOUR } = require('../digest');

    test('NDIG-01: cron.schedule is registered INSIDE the require.main === module gate (not top-level)', () => {
      expect(serverSrc).toContain('cron.schedule');
      const gateIdx = serverSrc.indexOf('require.main === module');
      const cronIdx = serverSrc.indexOf('cron.schedule');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(cronIdx).toBeGreaterThan(gateIdx); // schedule call comes after the gate opens
      // The schedule call must sit within the gate block, before its closing brace +
      // module.exports — i.e. before the exports line that follows the gate.
      const exportsIdx = serverSrc.indexOf('module.exports = { app');
      expect(cronIdx).toBeLessThan(exportsIdx);
    });

    test('NDIG-04: cron expression derives from DIGEST_HOUR (0 8 * * *) with timezone Asia/Bishkek + noOverlap', () => {
      expect(DIGEST_HOUR).toBe(8);
      expect(serverSrc).toMatch(/0 \$\{DIGEST_HOUR\} \* \* \*|0 8 \* \* \*/);
      expect(serverSrc).toContain("timezone: 'Asia/Bishkek'");
      expect(serverSrc).toContain('noOverlap');
      expect(serverSrc).toContain('runDigest');
    });
  });

  // ── Digest bundling (NDIG-03) ────────────────────────────────────────────────
  // SC2 — 3 daily matches + 2 cap-overflow → exactly ONE push with count=5.
  describe('NDIG-03 sendDigest one-push-count', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockSendEachForMulticast.mockReset();
      mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
    });

    test('sendDigest is exported alongside send', () => {
      const fcm = require('../push/fcm');
      expect(typeof fcm.sendDigest).toBe('function');
      expect(typeof fcm.send).toBe('function');
    });

    test('5 digestPending rows for one uid → ONE sendEachForMulticast with the count=5 RU title, only { deeplink } in data', async () => {
      mockTokens([{ token: 'tok-a' }, { token: 'tok-b' }]);
      mockSendEachForMulticast.mockResolvedValueOnce(multicastResponse([okResp(), okResp()]));

      const result = await sendDigest({
        uid: 'u1',
        count: 5,
        lang: 'RU',
        data: { deeplink: 'carex://notifications' },
      });

      // Exactly one fan-out call carrying ALL of the uid's tokens.
      expect(mockSendEachForMulticast).toHaveBeenCalledTimes(1);
      const arg = mockSendEachForMulticast.mock.calls[0][0];
      expect(arg.tokens).toEqual(['tok-a', 'tok-b']);

      // Title is the RU машин-form for 5 with the integer count interpolated.
      const expectedTitle = renderDigest('RU', 5).title;
      expect(arg.notification.title).toBe(expectedTitle);
      expect(arg.notification.title).toContain('5');
      expect(arg.notification.title).toContain('машин');

      // PII guarantee (T-14-02-01): data carries ONLY the deeplink — no count/uid/carId.
      expect(arg.data).toEqual({ deeplink: 'carex://notifications' });
      expect(Object.keys(arg.data)).toEqual(['deeplink']);
      const serialized = JSON.stringify(arg);
      expect(serialized).not.toContain('"uid"');
      expect(serialized).not.toContain('"count"');
      expect(serialized).not.toContain('"carId"');

      expect(result).toEqual({ ok: true, delivered: 2 });
    });

    test('zero device tokens → { ok:true, delivered:0 } with no firebase-admin call', async () => {
      mockTokens([]);
      const result = await sendDigest({ uid: 'u-empty', count: 3, lang: 'RU' });
      expect(result).toEqual({ ok: true, delivered: 0 });
      expect(mockSendEachForMulticast).not.toHaveBeenCalled();
      expect(ensureInitialized).not.toHaveBeenCalled();
    });

    test('a PRUNE_CODES error on a token prunes it and never throws', async () => {
      mockTokens([{ token: 'good' }, { token: 'dead' }]);
      mockSendEachForMulticast.mockResolvedValueOnce(multicastResponse([
        okResp(),
        errResp('messaging/registration-token-not-registered'),
      ]));

      await expect(
        sendDigest({ uid: 'u1', count: 2, lang: 'RU', data: { deeplink: 'carex://notifications' } }),
      ).resolves.toEqual({ ok: true, delivered: 1 });

      expect(mockDeleteOne).toHaveBeenCalledTimes(1);
      expect(mockDeleteOne).toHaveBeenCalledWith({ token: 'dead' });
    });
  });

  // ── Localization boundary (D-04) — REAL assertions (Task 2). ─────────────────
  describe('D-04 pluralizeRu boundaries', () => {
    // Standard Russian 3-form rule:
    //   mod10===1 && mod100!==11 → one
    //   mod10 in 2..4 && (mod100<12 || mod100>14) → few
    //   else → many  (covers 0, 5..20, the 11..14 teen exception, etc.)
    const FORMS = ['one', 'few', 'many'];

    test.each([
      [0, 'many'],
      [1, 'one'],
      [2, 'few'],
      [3, 'few'],
      [4, 'few'],
      [5, 'many'],
      [6, 'many'],
      [11, 'many'],
      [12, 'many'],
      [13, 'many'],
      [14, 'many'],
      [20, 'many'],
      [21, 'one'],
      [22, 'few'],
      [23, 'few'],
      [24, 'few'],
      [25, 'many'],
      [101, 'one'],
      [111, 'many'],
      [114, 'many'],
      [121, 'one'],
    ])('pluralizeRu(%i) → %s form', (n, expected) => {
      expect(pluralizeRu(n, FORMS)).toBe(expected);
    });

    // Rendered RU digest_title must read grammatically per count.
    test.each([
      [1, 'машина'],
      [3, 'машины'],
      [4, 'машины'],
      [5, 'машин'],
      [11, 'машин'],
      [14, 'машин'],
      [21, 'машина'],
      [22, 'машины'],
      [0, 'машин'],
    ])('RU digest_title for count %i contains the noun form "%s"', (count, nounForm) => {
      const title = renderDigest('RU', count).title;
      expect(title).toContain(String(count));
      expect(title).toContain(nounForm);
    });

    // EN uses simple singular/plural.
    test('EN digest_title is singular for 1 and plural for >1', () => {
      const one = renderDigest('EN', 1).title;
      const many = renderDigest('EN', 2).title;
      expect(one).toContain('1');
      expect(one).toMatch(/match\b/);
      expect(one).not.toMatch(/matches/);
      expect(many).toContain('2');
      expect(many).toMatch(/matches/);
    });

    // T-14-01-01: only the integer count is interpolated — no other param leaks.
    test('renderDigest interpolates only the count (no PII params)', () => {
      const { title } = renderDigest('RU', 5);
      expect(title).toContain('5');
      expect(title).not.toMatch(/\{[a-zA-Z]+\}/); // no leftover unfilled tokens
    });
  });

  // ── runDigest crash-safe flush (NDIG-02 / NDIG-03 / SC4) — REAL integration ──
  // These rows use the in-memory replica set + real Notification/Car/User models and
  // an injected mock fcm.sendDigest. runDigest is invoked DIRECTLY (no cron) per SC1.
  describe('runDigest flush (NDIG-02 / NDIG-03 / SC4)', () => {
    const { runDigest, DIGEST_HOUR } = require('../digest');
    const Notification = require('../../models/Notification');
    const User = require('../../models/User');
    const Car = require('../../models/Car');

    // Seed an active car so the hide-hook re-check passes by default.
    async function makeCar(overrides = {}) {
      const car = await Car.create({
        make: 'Toyota',
        model: 'Camry',
        year: 2020,
        price: 10000,
        sellerId: new mongoose.Types.ObjectId().toString(),
        status: 'active',
        ...overrides,
      });
      return car;
    }

    async function makeUser(uid, lang = 'RU') {
      return User.create({
        firebaseUid: uid,
        email: `${uid}@example.com`,
        language: lang,
      });
    }

    function pendingRow(uid, extra = {}) {
      return {
        uid,
        kind: 'saved_search',
        titleKey: 'new_match',
        bodyKey: 'new_match',
        params: {},
        data: { deeplink: 'carex://notifications', carId: null, searchId: null },
        digestPending: true,
        ...extra,
      };
    }

    beforeEach(async () => {
      await Promise.all([
        Notification.deleteMany({}),
        User.deleteMany({}),
        Car.deleteMany({}),
      ]);
    });

    test('DIGEST_HOUR is 8 and runDigest is directly callable (no cron)', () => {
      expect(DIGEST_HOUR).toBe(8);
      expect(typeof runDigest).toBe('function');
    });

    test('NDIG-03 one-push-count: 5 digestPending rows for one uid → ONE sendDigest with count=5, all cleared', async () => {
      await makeUser('u1', 'RU');
      await Notification.insertMany(Array.from({ length: 5 }, () => pendingRow('u1')));

      const sendDigest = jest.fn().mockResolvedValue({ ok: true, delivered: 1 });
      await runDigest({ now: new Date(), deps: { fcm: { sendDigest } } });

      expect(sendDigest).toHaveBeenCalledTimes(1);
      const arg = sendDigest.mock.calls[0][0];
      expect(arg.uid).toBe('u1');
      expect(arg.count).toBe(5);
      expect(arg.lang).toBe('RU');
      expect(arg.data).toEqual({ deeplink: 'carex://notifications' });

      const remaining = await Notification.countDocuments({ uid: 'u1', digestPending: true });
      expect(remaining).toBe(0);
      const stamped = await Notification.countDocuments({ uid: 'u1', digestRunId: { $ne: null } });
      expect(stamped).toBe(0); // digestRunId $unset on successful clear
    });

    test('NDIG-02 snapshot bound: a row created AFTER runStart is not claimed/sent/cleared', async () => {
      await makeUser('u1', 'RU');
      const runStart = new Date('2026-06-07T08:00:00.000Z');
      // One row before runStart (in batch), one after (tomorrow's row).
      await Notification.create(pendingRow('u1', { createdAt: new Date(runStart.getTime() - 60_000) }));
      const future = await Notification.create(
        pendingRow('u1', { createdAt: new Date(runStart.getTime() + 60_000) }),
      );

      const sendDigest = jest.fn().mockResolvedValue({ ok: true, delivered: 1 });
      await runDigest({ now: runStart, deps: { fcm: { sendDigest } } });

      expect(sendDigest).toHaveBeenCalledTimes(1);
      expect(sendDigest.mock.calls[0][0].count).toBe(1); // only the pre-runStart row

      const futureRow = await Notification.findById(future._id).lean();
      expect(futureRow.digestPending).toBe(true); // untouched
      expect(futureRow.digestRunId).toBeNull(); // never claimed
    });

    test('NDIG-02 crash no-double-send/no-drop: B-send throws after A cleared → A cleared, B retained; re-run sends B not A', async () => {
      await makeUser('a', 'RU');
      await makeUser('b', 'RU');
      await Notification.insertMany([pendingRow('a'), pendingRow('a'), pendingRow('b')]);

      // First run: A succeeds, B throws (simulated crash on B's send).
      const failingSend = jest.fn(async ({ uid }) => {
        if (uid === 'b') throw new Error('simulated crash on B');
        return { ok: true, delivered: 1 };
      });
      await runDigest({ now: new Date(), deps: { fcm: { sendDigest: failingSend } } });

      // A cleared; B still pending (no drop). One user's failure did not abort the loop.
      expect(await Notification.countDocuments({ uid: 'a', digestPending: true })).toBe(0);
      expect(await Notification.countDocuments({ uid: 'b', digestPending: true })).toBe(1);

      // Re-run: only B is re-picked; A is NOT re-sent (no double-send for cleared user).
      const secondSend = jest.fn().mockResolvedValue({ ok: true, delivered: 1 });
      await runDigest({ now: new Date(), deps: { fcm: { sendDigest: secondSend } } });

      expect(secondSend).toHaveBeenCalledTimes(1);
      expect(secondSend.mock.calls[0][0].uid).toBe('b');
      expect(await Notification.countDocuments({ digestPending: true })).toBe(0);
    });

    test('NDIG-02 re-claimable: a leftover row claimed by a crashed prior run is re-stamped and sent', async () => {
      await makeUser('c', 'RU');
      // Simulate a crashed prior run: row is digestPending AND already carries a stale digestRunId.
      await Notification.create(pendingRow('c', { digestRunId: 'stale-prior-run-id' }));

      const sendDigest = jest.fn().mockResolvedValue({ ok: true, delivered: 1 });
      await runDigest({ now: new Date(), deps: { fcm: { sendDigest } } });

      expect(sendDigest).toHaveBeenCalledTimes(1);
      expect(sendDigest.mock.calls[0][0].count).toBe(1);
      expect(await Notification.countDocuments({ uid: 'c', digestPending: true })).toBe(0);
    });

    test('SC4 hide-hook re-check: a watch-family row whose Car is now non-active is excluded from the count and not sent', async () => {
      await makeUser('u1', 'RU');
      const activeCar = await makeCar({ status: 'active' });
      const hiddenCar = await makeCar({ status: 'suspended' });
      const deletedCarId = new mongoose.Types.ObjectId().toString(); // no Car doc → null

      await Notification.insertMany([
        pendingRow('u1', { kind: 'watch', data: { deeplink: 'carex://notifications', carId: activeCar._id.toString(), searchId: null } }),
        pendingRow('u1', { kind: 'watch', data: { deeplink: 'carex://notifications', carId: hiddenCar._id.toString(), searchId: null } }),
        pendingRow('u1', { kind: 'watch', data: { deeplink: 'carex://notifications', carId: deletedCarId, searchId: null } }),
      ]);

      const sendDigest = jest.fn().mockResolvedValue({ ok: true, delivered: 1 });
      await runDigest({ now: new Date(), deps: { fcm: { sendDigest } } });

      // Only the active-car row survives the hide-hook re-check.
      expect(sendDigest).toHaveBeenCalledTimes(1);
      expect(sendDigest.mock.calls[0][0].count).toBe(1);

      // Sent (surviving) row cleared; dropped rows stay digestPending:true (not sent, not lost).
      const pending = await Notification.countDocuments({ uid: 'u1', digestPending: true });
      expect(pending).toBe(2); // the suspended + the null-car rows
    });

    test('language resolution: a row for an EN user passes lang=EN to sendDigest', async () => {
      await makeUser('en-user', 'EN');
      await Notification.create(pendingRow('en-user'));

      const sendDigest = jest.fn().mockResolvedValue({ ok: true, delivered: 1 });
      await runDigest({ now: new Date(), deps: { fcm: { sendDigest } } });

      expect(sendDigest).toHaveBeenCalledTimes(1);
      expect(sendDigest.mock.calls[0][0].lang).toBe('EN');
    });

    test('!ok send leaves the rows digestPending (no clear, no drop)', async () => {
      await makeUser('u1', 'RU');
      await Notification.insertMany([pendingRow('u1'), pendingRow('u1')]);

      const sendDigest = jest.fn().mockResolvedValue({ ok: false, delivered: 0 });
      await runDigest({ now: new Date(), deps: { fcm: { sendDigest } } });

      expect(sendDigest).toHaveBeenCalledTimes(1);
      // Not cleared — next morning re-picks (no drop).
      expect(await Notification.countDocuments({ uid: 'u1', digestPending: true })).toBe(2);
    });
  });

  // ── Retention / prune (NDIG-05 / NDOM-06) — REAL integration (Task 1, Plan 04) ─
  // The same runDigest run prunes notifications older than 90 days and device tokens
  // whose lastSeenAt has gone stale (the EXTRA layer beyond fcm.send's send-time
  // pruneToken — see digest.js). The file mocks ../../models/DeviceToken for the
  // sendDigest unit tests above, so the prune rows inject the REAL models via deps.
  describe('prune (NDIG-05 / NDOM-06)', () => {
    const { runDigest } = require('../digest');
    const Notification = require('../../models/Notification');
    const RealDeviceToken = jest.requireActual('../../models/DeviceToken');
    const { NOTIFICATION_RETENTION_DAYS } = require('../../models/Notification');

    const DAY = 24 * 60 * 60 * 1000;
    const noopFcm = { sendDigest: jest.fn().mockResolvedValue({ ok: true, delivered: 1 }) };

    beforeEach(async () => {
      await Promise.all([Notification.deleteMany({}), RealDeviceToken.deleteMany({})]);
      noopFcm.sendDigest.mockClear();
    });

    test('NDIG-05/NDOM-06 90-day prune: a 91d-old notification is deleted, an 89d-old is kept', async () => {
      const now = new Date('2026-06-07T08:00:00.000Z');
      // Boundary rows around NOTIFICATION_RETENTION_DAYS (90). Not digestPending — pure
      // retention rows that the flush ignores but the prune must reap by age.
      const old91 = await Notification.create({
        uid: 'ret', kind: 'saved_search', titleKey: 'new_match', bodyKey: 'new_match',
        createdAt: new Date(now.getTime() - 91 * DAY),
      });
      const fresh89 = await Notification.create({
        uid: 'ret', kind: 'saved_search', titleKey: 'new_match', bodyKey: 'new_match',
        createdAt: new Date(now.getTime() - 89 * DAY),
      });

      await runDigest({ now, deps: { fcm: noopFcm, DeviceToken: RealDeviceToken } });

      expect(await Notification.findById(old91._id)).toBeNull(); // 91d > 90 → pruned
      expect(await Notification.findById(fresh89._id)).not.toBeNull(); // 89d < 90 → kept
      // The retention threshold is the model constant (not a magic number).
      expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
    });

    test('NDIG-05 stale-token prune: a stale-lastSeenAt token is deleted, a fresh token is kept', async () => {
      const now = new Date('2026-06-07T08:00:00.000Z');
      const stale = await RealDeviceToken.create({
        uid: 'ret', token: 'stale-tok', platform: 'ios',
        lastSeenAt: new Date(now.getTime() - 200 * DAY), // unseen ~6.5 months
      });
      const fresh = await RealDeviceToken.create({
        uid: 'ret', token: 'fresh-tok', platform: 'ios',
        lastSeenAt: new Date(now.getTime() - 1 * DAY), // seen yesterday
      });

      await runDigest({ now, deps: { fcm: noopFcm, DeviceToken: RealDeviceToken } });

      expect(await RealDeviceToken.findById(stale._id)).toBeNull(); // stale → pruned
      expect(await RealDeviceToken.findById(fresh._id)).not.toBeNull(); // fresh → kept
    });

    test('T-14-04-01: both prune deleteMany calls carry a date-bounded filter (no unconditional delete)', async () => {
      const now = new Date('2026-06-07T08:00:00.000Z');
      const notifSpy = jest.spyOn(Notification, 'deleteMany');
      const tokenSpy = jest.spyOn(RealDeviceToken, 'deleteMany');

      await runDigest({ now, deps: { fcm: noopFcm, DeviceToken: RealDeviceToken } });

      // The notification prune call (the flush itself never deletes notifications).
      const notifCall = notifSpy.mock.calls.find(
        (c) => c[0] && c[0].createdAt && c[0].createdAt.$lt,
      );
      expect(notifCall).toBeTruthy();
      expect(notifCall[0].createdAt.$lt).toBeInstanceOf(Date);

      const tokenCall = tokenSpy.mock.calls.find(
        (c) => c[0] && c[0].lastSeenAt && c[0].lastSeenAt.$lt,
      );
      expect(tokenCall).toBeTruthy();
      expect(tokenCall[0].lastSeenAt.$lt).toBeInstanceOf(Date);

      notifSpy.mockRestore();
      tokenSpy.mockRestore();
    });

    test('prune failure is non-fatal: a throwing prune does not throw out of runDigest', async () => {
      const now = new Date('2026-06-07T08:00:00.000Z');
      // A DeviceToken stub whose deleteMany rejects — prune must swallow it.
      const ExplodingTokens = {
        deleteMany: jest.fn().mockRejectedValue(new Error('boom')),
      };
      await expect(
        runDigest({ now, deps: { fcm: noopFcm, DeviceToken: ExplodingTokens } }),
      ).resolves.toBeDefined();
    });
  });
});
