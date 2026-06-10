// Phase 15 — Wave 0 (executable SPEC, GREEN immediately). R-02 / Req 5.
//
// PUT /api/users/:uid must persist `notificationPrefs` — the current server.js handler
// (server.js:542-563) OMITS notificationPrefs from its allowlist (the latent R-02 bug).
//
// Following the established Phase-3/12 acceptance convention (mirrors userLanguage.test.js):
// tests do NOT boot server.js — they build a minimal Express app that reproduces the
// FIXED handler VERBATIM, backed by mongodb-memory-server + the real User model, exercised
// via supertest. Because the inlined handler ALREADY contains the fix, this file is GREEN
// immediately. It is the EXECUTABLE SPEC that 15-02 Task 3's server.js edit must match
// byte-for-byte-in-behavior.
//
// VALIDATION map (15-VALIDATION.md):
//   "persists notificationPrefs" (Req 5) — PUT { notificationPrefs:{ newListingEnabled:false } } persists it.
//   "partial patch does not clobber siblings" (R-02) — dot-path $set, NOT whole-subobject overwrite.
//   "allowlist rejects unknown pref keys" (V5 mass-assignment / T-15-01) — unknown/non-bool keys dropped.
//   "IDOR-safe: keys on req.params.uid, ignores body uid" (V4 / T-15-04) — update keys on the path uid only.

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let User;
let app;

// The allowlisted notificationPrefs keys + their expected types. Booleans accept only
// real booleans; quietHours is an object; dailyCap a number. This is the SPEC 15-02 ships.
const BOOL_PREF_KEYS = ['muteAll', 'savedSearchEnabled', 'watchEnabled', 'newListingEnabled'];

// Build the dot-path $set update from an allowlisted, type-checked notificationPrefs body.
// Mass-assignment (T-15-01) defense: only known keys, type-checked, become dot-paths.
function buildPrefUpdate(notificationPrefs) {
  const update = {};
  if (!notificationPrefs || typeof notificationPrefs !== 'object') return update;
  for (const key of BOOL_PREF_KEYS) {
    if (typeof notificationPrefs[key] === 'boolean') {
      update[`notificationPrefs.${key}`] = notificationPrefs[key];
    }
  }
  if (typeof notificationPrefs.dailyCap === 'number') {
    update['notificationPrefs.dailyCap'] = notificationPrefs.dailyCap;
  }
  if (notificationPrefs.quietHours && typeof notificationPrefs.quietHours === 'object') {
    if (typeof notificationPrefs.quietHours.start === 'string') {
      update['notificationPrefs.quietHours.start'] = notificationPrefs.quietHours.start;
    }
    if (typeof notificationPrefs.quietHours.end === 'string') {
      update['notificationPrefs.quietHours.end'] = notificationPrefs.quietHours.end;
    }
  }
  return update;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  // SPEC NOTE: 15-02 adds `notificationPrefs.newListingEnabled` (default true) to User.js.
  // The real User.js schema does NOT yet carry it (Mongoose strict mode would drop the
  // dot-path write), so this spec registers the FORWARD User schema 15-02 ships — exactly
  // as the inlined handler below is the forward handler 15-02 ships. Both are the
  // executable spec 15-02 Task 3 (server.js) + the User.js schema edit must reproduce.
  const userSchema = new mongoose.Schema({
    firebaseUid: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    firstName: String,
    lastName: String,
    phoneNumber: String,
    telegramUsername: String,
    avatarUrl: String,
    language: { type: String, enum: ['RU', 'EN'], default: 'RU' },
    notificationPrefs: {
      muteAll: { type: Boolean, default: false },
      savedSearchEnabled: { type: Boolean, default: true },
      watchEnabled: { type: Boolean, default: true },
      newListingEnabled: { type: Boolean, default: true }, // ← 15-02 addition (default ON / opt-out)
      quietHours: {
        start: { type: String, default: '22:00' },
        end: { type: String, default: '08:00' },
      },
      dailyCap: { type: Number, default: 3 },
    },
  });
  // Distinct model/collection name avoids colliding with the real `User` model if a
  // sibling test in the same Jest worker already registered it (which would shadow this
  // forward schema). The collection is isolated per-test by afterEach deleteMany.
  User = mongoose.models.UserPrefsSpec || mongoose.model('UserPrefsSpec', userSchema, 'usersprefsspec');

  app = express();
  app.use(express.json());

  // VERBATIM reproduction of the FIXED server.js PUT /api/users/:uid handler that 15-02 ships.
  // Adds notificationPrefs to the allowlist via dot-path $set (preserves siblings) + type-check.
  app.put('/api/users/:uid', async (req, res) => {
    try {
      const { firstName, lastName, phoneNumber, telegramUsername, avatarUrl, language, notificationPrefs } = req.body;
      const update = {};
      if (firstName !== undefined) update.firstName = firstName;
      if (lastName !== undefined) update.lastName = lastName;
      if (phoneNumber !== undefined) update.phoneNumber = phoneNumber;
      if (telegramUsername !== undefined) update.telegramUsername = telegramUsername;
      if (avatarUrl !== undefined) update.avatarUrl = avatarUrl;
      if (language !== undefined && ['RU', 'EN'].includes(language)) update.language = language;
      // R-02 / T-15-01: allowlisted, type-checked, dot-path $set — never a whole-subobject overwrite.
      Object.assign(update, buildPrefUpdate(notificationPrefs));
      const user = await User.findOneAndUpdate(
        { firebaseUid: req.params.uid }, // IDOR-safe: keys on the PATH uid, body uid is never used (T-15-04).
        { $set: update },
        { new: true }
      );
      res.json(user);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await User.deleteMany({});
});

describe('Req 5 / R-02 — PUT /api/users/:uid persists notificationPrefs', () => {
  test('persists notificationPrefs', async () => {
    await User.create({ firebaseUid: 'u-1', email: 'u-1@test.local' });

    const res = await request(app)
      .put('/api/users/u-1')
      .send({ notificationPrefs: { newListingEnabled: false } })
      .expect(200);

    expect(res.body.notificationPrefs.newListingEnabled).toBe(false);
    const persisted = await User.findOne({ firebaseUid: 'u-1' });
    expect(persisted.notificationPrefs.newListingEnabled).toBe(false);
  });

  test('partial patch does not clobber siblings', async () => {
    // Seed with savedSearchEnabled:true; patch only newListingEnabled → savedSearchEnabled STAYS true.
    await User.create({
      firebaseUid: 'u-2',
      email: 'u-2@test.local',
      notificationPrefs: { savedSearchEnabled: true, watchEnabled: true },
    });

    await request(app)
      .put('/api/users/u-2')
      .send({ notificationPrefs: { newListingEnabled: false } })
      .expect(200);

    const persisted = await User.findOne({ firebaseUid: 'u-2' });
    expect(persisted.notificationPrefs.newListingEnabled).toBe(false);
    expect(persisted.notificationPrefs.savedSearchEnabled).toBe(true); // sibling untouched
    expect(persisted.notificationPrefs.watchEnabled).toBe(true); // sibling untouched
  });

  test('allowlist rejects unknown pref keys', async () => {
    // T-15-01 mass-assignment: `hacked` is not a known key; muteAll given a non-boolean → both dropped.
    await User.create({ firebaseUid: 'u-3', email: 'u-3@test.local' });

    await request(app)
      .put('/api/users/u-3')
      .send({ notificationPrefs: { hacked: 'x', muteAll: 'not-a-bool' } })
      .expect(200);

    const persisted = await User.findOne({ firebaseUid: 'u-3' });
    expect(persisted.notificationPrefs.hacked).toBeUndefined();
    // muteAll falls back to its schema default (false), NOT the injected string.
    expect(persisted.notificationPrefs.muteAll).toBe(false);
  });

  test('IDOR-safe: keys on req.params.uid, ignores body uid', async () => {
    // T-15-04: PUT /api/users/u-1 with body { uid:'u-2' } must update u-1 only; u-2 untouched.
    await User.create({ firebaseUid: 'u-1', email: 'u-1@test.local' });
    await User.create({
      firebaseUid: 'u-2',
      email: 'u-2@test.local',
      notificationPrefs: { newListingEnabled: true },
    });

    await request(app)
      .put('/api/users/u-1')
      .send({ uid: 'u-2', firebaseUid: 'u-2', notificationPrefs: { newListingEnabled: false } })
      .expect(200);

    const target = await User.findOne({ firebaseUid: 'u-1' });
    const other = await User.findOne({ firebaseUid: 'u-2' });
    expect(target.notificationPrefs.newListingEnabled).toBe(false); // path uid updated
    expect(other.notificationPrefs.newListingEnabled).toBe(true); // body uid ignored — untouched
  });
});
