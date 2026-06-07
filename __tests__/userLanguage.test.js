// Phase 12 — NI18N-01: PUT /api/users/:uid accepts and persists `language`.
//
// VALIDATION map: NI18N-01 — PUT /api/users/:uid accepts a `language` field
// constrained to the RU/EN enum; an out-of-enum value is rejected/ignored;
// language is not required and defaults to RU for legacy users.
//
// The PUT /api/users/:uid handler lives inline in server.js. Following the
// established Phase-3 acceptance convention (tests do NOT boot server.js — they
// build a minimal Express app that reproduces the handler VERBATIM, backed by an
// in-memory Mongo), this file inlines the exact whitelist + enum guard so the
// integration assertions exercise the same code path without the server.js init
// weight (Stripe / Twilio / S3 / Firebase / Mongo URI).

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
let User;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  User = require('../src/models/User');

  app = express();
  app.use(express.json());

  // VERBATIM reproduction of server.js PUT /api/users/:uid whitelist (NI18N-01).
  app.put('/api/users/:uid', async (req, res) => {
    try {
      const { firstName, lastName, phoneNumber, telegramUsername, avatarUrl, language } = req.body;
      const update = {};
      if (firstName !== undefined) update.firstName = firstName;
      if (lastName !== undefined) update.lastName = lastName;
      if (phoneNumber !== undefined) update.phoneNumber = phoneNumber;
      if (telegramUsername !== undefined) update.telegramUsername = telegramUsername;
      if (avatarUrl !== undefined) update.avatarUrl = avatarUrl;
      if (language !== undefined && ['RU', 'EN'].includes(language)) update.language = language;
      const user = await User.findOneAndUpdate(
        { firebaseUid: req.params.uid },
        update,
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

describe('NI18N-01 user language', () => {
  test('User model carries the language field (Task 2 wiring check)', () => {
    const path = User.schema.path('language');
    expect(path).toBeDefined();
    expect(path.options.enum).toEqual(['RU', 'EN']);
    expect(path.options.default).toBe('RU');
  });

  test('PUT /api/users/:uid with { language: "EN" } persists language = EN', async () => {
    await User.create({ firebaseUid: 'u-en', email: 'u-en@test.local' });

    const res = await request(app)
      .put('/api/users/u-en')
      .send({ language: 'EN' })
      .expect(200);

    expect(res.body.language).toBe('EN');
    const persisted = await User.findOne({ firebaseUid: 'u-en' });
    expect(persisted.language).toBe('EN');
  });

  test('PUT /api/users/:uid with { language: "RU" } persists language = RU', async () => {
    await User.create({ firebaseUid: 'u-ru', email: 'u-ru@test.local', language: 'EN' });

    const res = await request(app)
      .put('/api/users/u-ru')
      .send({ language: 'RU' })
      .expect(200);

    expect(res.body.language).toBe('RU');
  });

  test('PUT /api/users/:uid with an out-of-enum language is rejected/ignored', async () => {
    await User.create({ firebaseUid: 'u-bad', email: 'u-bad@test.local', language: 'RU' });

    const res = await request(app)
      .put('/api/users/u-bad')
      .send({ language: 'FR' })
      .expect(200);

    // The enum guard drops the unknown value — language stays at its prior RU.
    expect(res.body.language).toBe('RU');
    const persisted = await User.findOne({ firebaseUid: 'u-bad' });
    expect(persisted.language).toBe('RU');
  });

  test('language is not required and defaults to RU for legacy users', async () => {
    // A user created without a language gets the schema default.
    const legacy = await User.create({ firebaseUid: 'u-legacy', email: 'u-legacy@test.local' });
    expect(legacy.language).toBe('RU');

    // An update that omits language leaves it untouched (defaults remain).
    const res = await request(app)
      .put('/api/users/u-legacy')
      .send({ firstName: 'Legacy' })
      .expect(200);

    expect(res.body.firstName).toBe('Legacy');
    expect(res.body.language).toBe('RU');
  });
});
