const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Mock firebase-admin BEFORE requiring any module that uses it.
// Keeps the middleware test isolated from a real Firebase project/service account.
jest.mock('firebase-admin', () => {
  const verifyIdTokenMock = jest.fn();
  const mock = {
    credential: { cert: jest.fn(() => ({})) },
    initializeApp: jest.fn(),
    auth: jest.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
  };
  // Expose the inner mock so tests can control it.
  mock.__verifyIdTokenMock = verifyIdTokenMock;
  return mock;
});

const admin = require('firebase-admin');
const { verifyIdToken } = require('../../src/security/verifyIdToken');
const { requireAdmin } = require('../../src/security/requireAdmin');
const router = require('../../src/moderation/router');
const AdminUser = require('../../src/models/AdminUser');

let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Any non-empty value satisfies ensureInitialized(); the real admin.auth() is mocked.
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

  app = express();
  app.use(express.json());
  app.use('/api/admin/moderation', verifyIdToken, requireAdmin, router);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  admin.__verifyIdTokenMock.mockReset();
  await AdminUser.deleteMany({});
});

describe('/api/admin/moderation/ping (SEC-01 + SEC-02)', () => {
  test('no Authorization header → 401 unauthenticated', async () => {
    const res = await request(app).get('/api/admin/moderation/ping');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated', message: 'Missing or invalid idToken' });
  });

  test('malformed Authorization header → 401 unauthenticated', async () => {
    const res = await request(app).get('/api/admin/moderation/ping').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
  });

  test('invalid Bearer token (verifyIdToken throws) → 401 unauthenticated', async () => {
    admin.__verifyIdTokenMock.mockRejectedValueOnce(new Error('invalid signature'));
    const res = await request(app).get('/api/admin/moderation/ping').set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated', message: 'Missing or invalid idToken' });
  });

  test('valid idToken but email not an AdminUser → 403 unauthorized', async () => {
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'u1', email: 'notadmin@test.local' });
    const res = await request(app).get('/api/admin/moderation/ping').set('Authorization', 'Bearer ok-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unauthorized', message: 'Admin access required' });
  });

  test('valid admin idToken → 200 { ok: true }', async () => {
    await AdminUser.create({ email: 'admin@test.local', role: 'admin' });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'u2', email: 'admin@test.local' });
    const res = await request(app).get('/api/admin/moderation/ping').set('Authorization', 'Bearer ok-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('email case-insensitive match → 200', async () => {
    await AdminUser.create({ email: 'case@test.local', role: 'superadmin' });
    admin.__verifyIdTokenMock.mockResolvedValueOnce({ uid: 'u3', email: 'CASE@TEST.LOCAL' });
    const res = await request(app).get('/api/admin/moderation/ping').set('Authorization', 'Bearer ok-token');
    expect(res.status).toBe(200);
  });
});
