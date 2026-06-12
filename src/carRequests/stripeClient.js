// Single Stripe client for car-request unlocks. Mirrors server.js's singleton.
// The placeholder secret keeps module load safe in test/CI where the env is
// unset; tests mock this module, and the real key is set in prod (Railway).
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

module.exports = stripe;
