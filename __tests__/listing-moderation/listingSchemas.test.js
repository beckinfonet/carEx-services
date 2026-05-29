// __tests__/listing-moderation/listingSchemas.test.js
//
// Wave-0 unit tests for Phase 8 src/moderation/listingSchemas.js (D-09 + D-10 + D-A + D-C).
// No DB — pure Zod safeParse assertions. Mirrors __tests__/moderation/schemas.test.js
// shape with listing-domain renames + Phase-8-specific contracts:
//   - 5-value REASON_CATEGORIES derived from Car.schema (D-10 enum-drift lock)
//   - .strict() rejects unknown top-level keys on all 5 schemas
//   - restoreListingSchema does NOT accept reasonCategory (D-C symmetry)
//   - editListingSchema rejects system fields (status, moderatedBy, etc.)
//   - editListingSchema coerces multipart number-strings to numbers

const {
  REASON_CATEGORIES,
  suspendListingSchema,
  archiveListingSchema,
  deleteListingSchema,
  restoreListingSchema,
  editListingSchema,
} = require('../../src/moderation/listingSchemas');
const Car = require('../../src/models/Car');

describe('listingSchemas — REASON_CATEGORIES derivation lock (D-10)', () => {
  test('REASON_CATEGORIES is byte-identical to Car.schema.path("moderationReason").enumValues', () => {
    // Single-source-of-truth lock — if Car.js widens the moderationReason enum
    // (e.g., adds 'duplicate'), this test naturally tracks the new shape because
    // both sides re-derive from the same Mongoose schema path at module load.
    expect(JSON.stringify(REASON_CATEGORIES)).toBe(
      JSON.stringify(Car.schema.path('moderationReason').enumValues)
    );
  });

  test('REASON_CATEGORIES equals the v1.1 5-value taxonomy', () => {
    expect(REASON_CATEGORIES).toEqual([
      'spam', 'policy_violation', 'fraud', 'inactive_seller', 'other',
    ]);
  });
});

describe('suspendListingSchema (.strict(), D-14)', () => {
  test('accepts well-formed suspend body', () => {
    const res = suspendListingSchema.safeParse({
      reasonCategory: 'spam',
      note: 'observed pattern',
    });
    expect(res.success).toBe(true);
  });

  test('rejects missing reasonCategory (REQUIRED per D-14)', () => {
    const res = suspendListingSchema.safeParse({ note: 'forgot reason' });
    expect(res.success).toBe(false);
  });

  test('rejects unknown top-level key (.strict() proof)', () => {
    const res = suspendListingSchema.safeParse({
      reasonCategory: 'spam', note: 'x', foo: 'bar',
    });
    expect(res.success).toBe(false);
    expect(res.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });

  test('rejects note longer than 2000 chars', () => {
    const res = suspendListingSchema.safeParse({
      reasonCategory: 'spam', note: 'x'.repeat(2001),
    });
    expect(res.success).toBe(false);
  });
});

describe('archiveListingSchema (.strict(), D-14)', () => {
  test('accepts well-formed archive body', () => {
    const res = archiveListingSchema.safeParse({
      reasonCategory: 'inactive_seller',
    });
    expect(res.success).toBe(true);
  });

  test('rejects unknown top-level key (.strict() proof)', () => {
    const res = archiveListingSchema.safeParse({
      reasonCategory: 'inactive_seller', extraField: 1,
    });
    expect(res.success).toBe(false);
  });

  test('rejects missing reasonCategory', () => {
    const res = archiveListingSchema.safeParse({ note: 'x' });
    expect(res.success).toBe(false);
  });
});

describe('deleteListingSchema (.strict(), D-14)', () => {
  test('accepts well-formed delete body', () => {
    const res = deleteListingSchema.safeParse({
      reasonCategory: 'fraud', note: 'confirmed by buyer report',
    });
    expect(res.success).toBe(true);
  });

  test('rejects unknown top-level key (.strict() proof)', () => {
    const res = deleteListingSchema.safeParse({
      reasonCategory: 'fraud', sneaky: true,
    });
    expect(res.success).toBe(false);
  });

  test('rejects missing reasonCategory', () => {
    const res = deleteListingSchema.safeParse({});
    expect(res.success).toBe(false);
  });
});

describe('restoreListingSchema (.strict(), D-C)', () => {
  test('accepts { note }', () => {
    const res = restoreListingSchema.safeParse({ note: 'appeal granted' });
    expect(res.success).toBe(true);
  });

  test('accepts empty body (note is optional)', () => {
    const res = restoreListingSchema.safeParse({});
    expect(res.success).toBe(true);
  });

  test('rejects reasonCategory (D-C symmetry — Restore has no reason taxonomy fit)', () => {
    // Restore is the INVERSE of moderation; the 5-value taxonomy describes
    // "why moderate" and has no semantic role on Restore. .strict() rejection
    // is the schema-level lock for D-C. If this passes, a future plan added
    // reasonCategory to restoreListingSchema and broke the contract.
    const res = restoreListingSchema.safeParse({ reasonCategory: 'spam' });
    expect(res.success).toBe(false);
    expect(res.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });
});

describe('editListingSchema (.strict(), D-A broad whitelist)', () => {
  test('accepts narrow well-formed edit body', () => {
    const res = editListingSchema.safeParse({
      price: 12000, description: 'updated copy',
    });
    expect(res.success).toBe(true);
  });

  test('coerces string number from multipart (D-A-1 permissive validators)', () => {
    // multer multipart body parsing surfaces all fields as strings; z.coerce.number()
    // mirrors the seller PUT's parseInt(year) pattern (server.js:810).
    const res = editListingSchema.safeParse({ price: '12000' });
    expect(res.success).toBe(true);
    expect(res.data.price).toBe(12000);
  });

  test('rejects unknown field with unrecognized_keys + keys: ["foo"]', () => {
    const res = editListingSchema.safeParse({ foo: 'bar' });
    expect(res.success).toBe(false);
    const unrecognized = res.error.issues.find((i) => i.code === 'unrecognized_keys');
    expect(unrecognized).toBeDefined();
    expect(unrecognized.keys).toEqual(['foo']);
  });

  test('rejects system field status (admin cannot directly mutate Car.status via Edit)', () => {
    // Edit is content-correction (D-A-3); Car.status changes through Suspend/Archive/Delete/Restore.
    // .strict() rejection of `status` is the schema-level lock — even though the field
    // exists on Car.js:46, admins cannot bypass the state-transition handlers via Edit.
    const res = editListingSchema.safeParse({ status: 'suspended' });
    expect(res.success).toBe(false);
    const unrecognized = res.error.issues.find((i) => i.code === 'unrecognized_keys');
    expect(unrecognized).toBeDefined();
    expect(unrecognized.keys).toContain('status');
  });

  test('rejects system field moderatedBy (audit metadata)', () => {
    const res = editListingSchema.safeParse({ moderatedBy: 'attacker-uid' });
    expect(res.success).toBe(false);
    const unrecognized = res.error.issues.find((i) => i.code === 'unrecognized_keys');
    expect(unrecognized).toBeDefined();
    expect(unrecognized.keys).toContain('moderatedBy');
  });
});
