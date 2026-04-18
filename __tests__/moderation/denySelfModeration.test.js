// __tests__/moderation/denySelfModeration.test.js
const express = require('express');
const request = require('supertest');
const { denySelfModeration } = require('../../src/moderation/denySelfModeration');

function appWith(req_admin_uid) {
  const app = express();
  app.use(express.json());
  // Inject fake req.admin (simulating requireAdmin output post-Plan-02-01).
  app.use((req, res, next) => {
    req.admin = { uid: req_admin_uid, email: 'admin@test.local', role: 'admin' };
    next();
  });
  app.post('/:targetUid', denySelfModeration, (req, res) => {
    res.json({ passed: true, targetUid: req.params.targetUid });
  });
  return app;
}

describe('denySelfModeration middleware (D-26)', () => {
  let consoleLogSpy;
  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  test('targetUid === admin.uid → 400 cannot_moderate_self', async () => {
    const app = appWith('admin-uid-42');
    const res = await request(app).post('/admin-uid-42').send({ action: 'suspend' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'cannot_moderate_self' });
  });

  test('targetUid !== admin.uid → handler runs (next() invoked)', async () => {
    const app = appWith('admin-uid-42');
    const res = await request(app).post('/other-user').send({ action: 'suspend' });

    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
    expect(res.body.targetUid).toBe('other-user');
  });

  test("no req.admin → pass through (not this middleware's lane)", async () => {
    const app = express();
    app.use(express.json());
    app.post('/:targetUid', denySelfModeration, (req, res) => res.json({ passed: true }));

    const res = await request(app).post('/anyone').send({});
    expect(res.status).toBe(200);
  });

  test('rejected attempt logs to console with admin uid (D-29)', async () => {
    const app = appWith('admin-uid-42');
    await request(app).post('/admin-uid-42').send({ action: 'suspend' });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const loggedMessage = consoleLogSpy.mock.calls[0][0];
    expect(loggedMessage).toMatch(/\[moderation\] denied self-moderation attempt by admin-uid-42 at \d{4}-\d{2}-\d{2}T/);
  });
});
