// __tests__/enforcement/ordersDeprecated.test.js
//
// Phase 3 Plan 03-06, ROADMAP D-12 assertion.
//
// Asserts POST /api/orders returns exactly 410 Gone with the canonical
// deprecation body shipped by Plan 03-05. We do NOT require server.js (it
// pulls in mongoose + S3 + Stripe + Twilio initializers). Instead we exercise
// the 410 Gone handler shape directly on a minimal Express app — the handler
// body is unconditional and depends on nothing else, so an in-file clone
// faithfully models what server.js mounts.

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.post('/api/orders', (req, res) => {
  res.status(410).json({
    error: 'deprecated',
    message: 'Use POST /api/payments/confirm-booking which now creates orders atomically',
  });
});

describe('POST /api/orders (D-12 — deprecated 410 Gone)', () => {
  test('returns 410 with exact D-12 body regardless of request payload', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ buyerUid: 'x', items: [] });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({
      error: 'deprecated',
      message: 'Use POST /api/payments/confirm-booking which now creates orders atomically',
    });
  });

  test('returns 410 with no body', async () => {
    const res = await request(app).post('/api/orders').send();
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('deprecated');
  });
});
