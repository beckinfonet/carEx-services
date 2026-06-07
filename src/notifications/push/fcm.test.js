// Phase 13 — Wave 0 (13-02 Task 2, NPUSH-05).
//
// The real fcm.send fan-out (replacing the Phase-12 no-op stub) must:
//   - pull DeviceToken rows by uid and fan out via firebase-admin
//     sendEachForMulticast;
//   - PRUNE tokens that come back UNREGISTERED / INVALID_ARGUMENT
//     (DeviceToken.deleteOne) and KEEP the good ones counted delivered;
//   - NEVER let one bad token abort the fan-out or throw;
//   - NOT prune on transient/429 errors, and apply a BOUNDED jittered
//     exponential backoff retry (≈3 attempts) for those — never an unbounded loop;
//   - short-circuit to { ok:true, delivered:0 } with NO firebase-admin call when
//     the user has no tokens;
//   - render GENERIC param-free copy (renderGenericPush) and pass ONLY
//     { deeplink } in data — no PII params ever reach the payload.
//
// firebase-admin is mocked at the firebaseAdmin seam (ensureInitialized) and the
// DeviceToken model is mocked — no DB / network in this unit test.

// ── Mocks ────────────────────────────────────────────────────────────────────
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

const { ensureInitialized } = require('../../security/firebaseAdmin');
const { send } = require('./fcm');

// Helper: make DeviceToken.find({uid}).lean() resolve to the given token rows.
function mockTokens(rows) {
  mockFind.mockReturnValue({ lean: () => Promise.resolve(rows) });
}

// A multicast response shaped like firebase-admin's BatchResponse.
function multicastResponse(responses) {
  return {
    successCount: responses.filter((r) => r.success).length,
    failureCount: responses.filter((r) => !r.success).length,
    responses,
  };
}

const errResp = (code) => ({ success: false, error: { code } });
const okResp = () => ({ success: true, messageId: 'mid-' + Math.random() });

beforeEach(() => {
  jest.clearAllMocks();
  mockSendEachForMulticast.mockReset();
  mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
});

describe('NPUSH-05 fcm.send — fan-out, prune, isolation', () => {
  test('no tokens → { ok:true, delivered:0 } without calling firebase-admin', async () => {
    mockTokens([]);
    const result = await send({ uid: 'u1', titleKey: 'price_drop', data: { deeplink: 'carex://listing/c1' } });
    expect(result).toEqual({ ok: true, delivered: 0 });
    expect(mockSendEachForMulticast).not.toHaveBeenCalled();
    expect(ensureInitialized).not.toHaveBeenCalled();
  });

  test('one UNREGISTERED token is pruned; the good token is still delivered (fan-out NOT aborted)', async () => {
    mockTokens([{ token: 'good-tok' }, { token: 'dead-tok' }]);
    mockSendEachForMulticast.mockResolvedValueOnce(multicastResponse([
      okResp(),
      errResp('messaging/registration-token-not-registered'),
    ]));

    const result = await send({ uid: 'u1', titleKey: 'price_drop', data: { deeplink: 'carex://listing/c1' } });

    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(1);
    // dead token pruned, good token NOT pruned.
    expect(mockDeleteOne).toHaveBeenCalledTimes(1);
    expect(mockDeleteOne).toHaveBeenCalledWith({ token: 'dead-tok' });
  });

  test('INVALID_ARGUMENT is pruned; a transient error is NOT pruned and does NOT throw', async () => {
    mockTokens([{ token: 'invalid-tok' }, { token: 'transient-tok' }]);
    // First attempt: invalid (prune) + unavailable (transient → retry).
    mockSendEachForMulticast
      .mockResolvedValueOnce(multicastResponse([
        errResp('messaging/invalid-argument'),
        errResp('messaging/unavailable'),
      ]))
      // Retry attempt only re-sends the transient token; still failing — give up, no throw.
      .mockResolvedValue(multicastResponse([errResp('messaging/unavailable')]));

    const result = await send({ uid: 'u1', titleKey: 'sold', data: { deeplink: 'carex://listing/c1' } });

    expect(result.ok).toBe(true);
    // invalid-tok pruned; transient-tok NEVER pruned.
    const pruned = mockDeleteOne.mock.calls.map((c) => c[0].token);
    expect(pruned).toContain('invalid-tok');
    expect(pruned).not.toContain('transient-tok');
  });

  test('transient/429 triggers BOUNDED retry (≤3 send attempts), never unbounded, never throws', async () => {
    mockTokens([{ token: 'flaky-tok' }]);
    // Always transient — must stop after the bounded attempt cap, not loop forever.
    mockSendEachForMulticast.mockResolvedValue(multicastResponse([errResp('messaging/quota-exceeded')]));

    const result = await send({ uid: 'u1', titleKey: 'booked', data: { deeplink: 'carex://listing/c1' } });

    expect(result.ok).toBe(true);
    expect(mockSendEachForMulticast.mock.calls.length).toBeGreaterThan(1); // a retry happened
    expect(mockSendEachForMulticast.mock.calls.length).toBeLessThanOrEqual(3); // bounded
    expect(mockDeleteOne).not.toHaveBeenCalled(); // transient is NEVER pruned
  });

  test('a prune failure (deleteOne rejects) does NOT abort the fan-out or throw', async () => {
    mockTokens([{ token: 'good-tok' }, { token: 'dead-tok' }]);
    mockSendEachForMulticast.mockResolvedValueOnce(multicastResponse([
      okResp(),
      errResp('messaging/registration-token-not-registered'),
    ]));
    mockDeleteOne.mockRejectedValue(new Error('db down'));

    await expect(
      send({ uid: 'u1', titleKey: 'price_drop', data: { deeplink: 'carex://listing/c1' } }),
    ).resolves.toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
  });
});

describe('NPUSH-08 — payload carries generic copy + only deeplink in data', () => {
  test('renders generic title/body and passes ONLY { deeplink } in data (no PII params)', async () => {
    mockTokens([{ token: 'tok' }]);
    mockSendEachForMulticast.mockResolvedValueOnce(multicastResponse([okResp()]));

    await send({
      uid: 'u1',
      titleKey: 'price_drop',
      lang: 'RU',
      // caller-supplied PII params that MUST NOT reach the payload:
      params: { makeModel: 'Toyota Camry', newPrice: 15000, oldPrice: 20000 },
      data: { deeplink: 'carex://listing/c1', makeModel: 'Toyota Camry', price: '15000' },
    });

    const arg = mockSendEachForMulticast.mock.calls[0][0];
    // notification body/title are the GENERIC param-free copy.
    expect(arg.notification.title).toBe('Цена снизилась');
    expect(arg.notification.body).toBe('Откройте, чтобы посмотреть.');
    // data carries ONLY the deeplink — no makeModel/price leak.
    expect(arg.data).toEqual({ deeplink: 'carex://listing/c1' });
    // serialize the whole payload and assert no PII string slipped through.
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain('Toyota Camry');
    expect(serialized).not.toContain('15000');
    expect(serialized).not.toContain('20000');
  });

  test('renders body in the caller language (EN)', async () => {
    mockTokens([{ token: 'tok' }]);
    mockSendEachForMulticast.mockResolvedValueOnce(multicastResponse([okResp()]));
    await send({ uid: 'u1', titleKey: 'sold', lang: 'EN', data: { deeplink: 'carex://listing/c1' } });
    const arg = mockSendEachForMulticast.mock.calls[0][0];
    expect(arg.notification.title).toBe('Car was sold');
    expect(arg.notification.body).toBe('Open to take a look.');
  });

  test('stays compatible with the existing caller contract fcm.send({ uid, title, data })', async () => {
    // notificationService.js:213 calls send({ uid, title: keys.titleKey, data: target.data }).
    mockTokens([{ token: 'tok' }]);
    mockSendEachForMulticast.mockResolvedValueOnce(multicastResponse([okResp()]));
    const result = await send({ uid: 'u1', title: 'new_match', data: { deeplink: 'carex://search' } });
    expect(result.ok).toBe(true);
    const arg = mockSendEachForMulticast.mock.calls[0][0];
    expect(arg.notification.title).toBe('Новый вариант по поиску');
    expect(arg.data).toEqual({ deeplink: 'carex://search' });
  });
});
