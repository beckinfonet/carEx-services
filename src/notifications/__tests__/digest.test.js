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

const { startReplSet, stopReplSet } = require('../../../__tests__/_helpers/mongoReplSet');
const { pluralizeRu, renderDigest } = require('../translations');

let replset;

beforeAll(async () => {
  replset = await startReplSet();
});

afterAll(async () => {
  await stopReplSet(replset);
});

describe('Phase 14 daily digest', () => {
  // ── Scheduling & gating (NDIG-01 / NDIG-04) ──────────────────────────────────
  // SC1 — importing the service in a test starts NO scheduler; runDigest is callable
  // directly (no open cron handle, no fcm call on import).
  test.todo('NDIG-01 cron gate: importing the module under Jest starts no scheduler (require.main===module)');
  // SC1 — cron expression built from DIGEST_HOUR is `0 8 * * *` with timezone Asia/Bishkek.
  test.todo('NDIG-04 DIGEST_HOUR/timezone: cron expr is "0 8 * * *" with timezone Asia/Bishkek');

  // ── Digest bundling (NDIG-03) ────────────────────────────────────────────────
  // SC2 — 3 daily matches + 2 cap-overflow → exactly ONE push with count=5.
  test.todo('NDIG-03 one-push-count: 5 digestPending rows for one uid → sendDigest called once with count:5');

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

  // ── Crash safety (NDIG-02) ───────────────────────────────────────────────────
  // SC3 — crash mid-run → no double-send, no drop (per-id clear of only sent rows).
  test.todo('NDIG-02 crash no-double-send: user-B send throws after A clears → A cleared, B still pending; re-run sends B, not A');
  // SC3 — snapshot bound createdAt <= runStart excludes mid-run new rows.
  test.todo('NDIG-02 snapshot bound: a row with createdAt > runStart is not in the batch');

  // ── Retention / prune (NDIG-05 / NDOM-06) ────────────────────────────────────
  // SC4 — 90-day notifications pruned (91d deleted, 89d kept).
  test.todo('NDIG-05/NDOM-06 90-day prune: 91d-old notification deleted, 89d-old kept');
  // SC4 — stale device tokens pruned, non-duplicative with the send-time prune.
  test.todo('NDIG-05 stale-token prune: stale lastSeenAt token deleted, fresh token kept');

  // ── Hide-hook re-check (SC4 / NDIG-03) ───────────────────────────────────────
  // SC4 — listing hidden overnight is excluded from the count and not sent.
  test.todo('SC4 hide-hook re-check: digestPending row whose Car is now non-active is excluded and not sent');
});
