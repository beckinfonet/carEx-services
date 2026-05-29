// __tests__/listing-enforcement/listingDetailStatusAware.test.js
//
// Phase 9 Plan 09-01 — Wave 0 RED scaffold for LENF-02 (status-aware GET
// /api/cars/:id). Covers VALIDATION rows 09-LENF02-a..f. Real implementation
// lands in Plan 09-03 (handler-level branch on req.admin per 09-CONTEXT D-08,
// thin payload per D-05, admin badge per D-07).
//
// INTENTIONAL RED at end of Plan 09-01: 6 test.todo entries lock the contract
// Plan 09-03 must satisfy. firebase-admin mock from PATTERNS §10 analog
// (__tests__/listing-moderation/requireAdmin.listing.middleware.test.js) is
// included so Plan 09-03 can flip the test.todo bodies to real supertest cases
// without rewiring the harness.

// Mock firebase-admin BEFORE requiring any module that uses it.
jest.mock('firebase-admin', () => {
  const verifyIdTokenMock = jest.fn();
  const mock = {
    credential: { cert: jest.fn(() => ({})) },
    initializeApp: jest.fn(),
    auth: jest.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
  };
  mock.__verifyIdTokenMock = verifyIdTokenMock;
  return mock;
});

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const request = require('supertest');

const admin = require('firebase-admin');
const Car = require('../../src/models/Car');
const AdminUser = require('../../src/models/AdminUser');

let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  // Minimal Express app — Plan 09-03 mounts the real GET /api/cars/:id handler
  // with attachAuthIfPresent + lookupAdminIfPresent (from Plan 09-01 Task 3) +
  // the status-aware response branch. This scaffold defines `app` so Plan 09-03
  // can swap the handler in without rewriting fixtures.
  app = express();
  app.use(express.json());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Car.deleteMany({ /* no filter */ }).setOptions({
    includeAllUsers: true,
    includeAllListingStatuses: true,
  });
  await AdminUser.deleteMany({});
  admin.__verifyIdTokenMock.mockReset();
});

// Reference unused-import locals to satisfy lint and keep harness wired.
void request;
void app;

describe('LENF-02 status-aware GET /api/cars/:id (Plan 09-03 contract)', () => {
  // (a) — 09-LENF02-a — non-admin suspended → 200 + EXACT D-05 allowlist
  test.todo(
    'non-admin GET on suspended listing returns 200 + EXACT D-05 thin payload allowlist (Object.keys exact match)'
  );

  // (b) — 09-LENF02-b — thin payload absence assertion (PII leak guard)
  test.todo(
    'non-admin thin payload does NOT have sellerEmail/sellerName/sellerPhone/description/moderationNote/mileage/location/condition/knownIssues'
  );

  // (c) — 09-LENF02-c — admin sees full doc + moderationBadge (D-07)
  test.todo(
    'admin GET on suspended listing returns full doc + moderationBadge with the 5 D-07 fields'
  );

  // (d) — 09-LENF02-d — admin viewing active listing has NO moderationBadge (Pitfall 4)
  test.todo(
    'admin GET on active listing returns full doc WITHOUT moderationBadge key (Pitfall 4)'
  );

  // (e) — 09-LENF02-e — non-existent id → 404
  test.todo(
    'GET on non-existent carId returns 404 (preserve existing semantics)'
  );

  // (f) — 09-LENF02-f — malformed id → 404 not 500 (Pitfall 6)
  test.todo(
    'GET on malformed carId (e.g. "not-an-object-id") returns 404 not 500 CastError (Pitfall 6)'
  );
});
