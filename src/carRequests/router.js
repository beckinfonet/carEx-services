const express = require('express');
const mongoose = require('mongoose');
const CarRequest = require('../models/CarRequest');
const { validateRequestInput } = require('./validateRequestInput');
const { getUnlockPrice } = require('./unlockPrice');
const { redactForSeller } = require('./redactForSeller');

const router = express.Router();

const REQUEST_TTL_DAYS = 30;

function getMake() {
  return mongoose.model('VehicleMake');
}
function getModel() {
  return mongoose.model('VehicleModel');
}
function getUser() {
  // Lazy lookup so tests can register their own slim User schema before
  // requiring this router (avoids OverwriteModelError from src/models/User.js).
  if (!mongoose.models.User) {
    require('../models/User');
  }
  return mongoose.model('User');
}

// Resolve + validate make/model. Returns { error, makeDoc, modelDoc }.
async function resolveMakeModel(makeId, modelId) {
  if (!mongoose.isValidObjectId(makeId)) return { error: 'invalid_make' };
  const makeDoc = await getMake().findOne({ _id: makeId, isActive: true }).lean();
  if (!makeDoc) return { error: 'invalid_make' };

  let modelDoc = null;
  if (modelId) {
    if (!mongoose.isValidObjectId(modelId)) return { error: 'invalid_model' };
    modelDoc = await getModel().findOne({ _id: modelId, makeId: makeDoc._id, isActive: true }).lean();
    if (!modelDoc) return { error: 'invalid_model' };
  }
  return { makeDoc, modelDoc };
}

// Load the caller and require APPROVED seller status. Returns the user or null.
async function getApprovedSeller(uid) {
  if (!uid) return null;
  const user = await getUser().findOne({ firebaseUid: uid }).lean();
  if (!user || user.sellerStatus !== 'APPROVED') return null;
  return user;
}

// POST /api/car-requests — create
router.post('/', async (req, res) => {
  try {
    const buyerUid = req.auth && req.auth.uid;
    if (!buyerUid) return res.status(401).json({ error: 'unauthorized' });

    const buyer = await getUser().findOne({ firebaseUid: buyerUid }).lean();
    if (!buyer) return res.status(404).json({ error: 'user_not_found' });
    if (!buyer.isPhoneVerified || !buyer.phoneNumber) {
      return res.status(403).json({ error: 'phone_not_verified' });
    }

    const { errors, value } = validateRequestInput(req.body);
    if (errors.length) return res.status(400).json({ error: 'validation_error', details: errors });

    const { error, makeDoc, modelDoc } = await resolveMakeModel(value.makeId, value.modelId);
    if (error) return res.status(400).json({ error });

    const doc = await CarRequest.create({
      ...value,
      makeId: makeDoc._id,
      modelId: modelDoc ? modelDoc._id : null,
      makeName: makeDoc.name,
      modelName: modelDoc ? modelDoc.name : null,
      buyerUid,
      contactPhone: buyer.phoneNumber,
      contactPhoneVerified: true,
      telegramVerified: false,
      currency: 'KGS',
      status: 'open',
      expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

    return res.status(201).json(doc.toObject());
  } catch (err) {
    console.error('[car-requests] create error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/car-requests/mine — caller's own requests
router.get('/mine', async (req, res) => {
  try {
    const buyerUid = req.auth && req.auth.uid;
    if (!buyerUid) return res.status(401).json({ error: 'unauthorized' });
    const rows = await CarRequest.find({ buyerUid }).sort({ createdAt: -1 }).lean();
    return res.json(rows);
  } catch (err) {
    console.error('[car-requests] mine error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/car-requests — seller browse of OPEN, non-expired requests (contact redacted)
router.get('/', async (req, res) => {
  try {
    const callerUid = req.auth && req.auth.uid;
    if (!callerUid) return res.status(401).json({ error: 'unauthorized' });

    const seller = await getApprovedSeller(callerUid);
    if (!seller) return res.status(403).json({ error: 'not_approved_seller' });

    const filter = {
      status: 'open',
      expiresAt: { $gt: new Date() },
      buyerUid: { $ne: callerUid }, // never surface the seller's own requests
    };
    if (req.query.makeId && mongoose.isValidObjectId(req.query.makeId)) {
      filter.makeId = req.query.makeId;
    }
    if (req.query.modelId && mongoose.isValidObjectId(req.query.modelId)) {
      filter.modelId = req.query.modelId;
    }
    const minBudget = Number(req.query.minBudget);
    if (Number.isFinite(minBudget) && minBudget > 0) {
      filter.budgetMax = { $gte: minBudget };
    }

    const rows = await CarRequest.find(filter).sort({ createdAt: -1 }).lean();
    const { amount, currency } = getUnlockPrice();
    // No RequestUnlock model until Slice 3 — every row is locked for now.
    const requests = rows.map((r) => redactForSeller(r, { unlocked: false }));
    return res.json({ unlockPrice: amount, currency, requests });
  } catch (err) {
    console.error('[car-requests] browse error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Helper: load a request the caller owns, or null.
async function findOwned(id, buyerUid) {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await CarRequest.findById(id);
  if (!doc || doc.buyerUid !== buyerUid) return null;
  return doc;
}

// PUT /api/car-requests/:id — edit own
router.put('/:id', async (req, res) => {
  try {
    const buyerUid = req.auth && req.auth.uid;
    if (!buyerUid) return res.status(401).json({ error: 'unauthorized' });

    const doc = await findOwned(req.params.id, buyerUid);
    if (!doc) return res.status(404).json({ error: 'not_found' });
    if (doc.status !== 'open') return res.status(409).json({ error: 'request_not_editable' });

    const { errors, value } = validateRequestInput(req.body);
    if (errors.length) return res.status(400).json({ error: 'validation_error', details: errors });

    const { error, makeDoc, modelDoc } = await resolveMakeModel(value.makeId, value.modelId);
    if (error) return res.status(400).json({ error });

    // Apply editable fields. Contact + ownership + lifecycle are NOT editable here.
    doc.makeId = makeDoc._id;
    doc.modelId = modelDoc ? modelDoc._id : null;
    doc.makeName = makeDoc.name;
    doc.modelName = modelDoc ? modelDoc.name : null;
    doc.budgetMax = value.budgetMax;
    doc.budgetMin = value.budgetMin ?? null;
    doc.yearMin = value.yearMin ?? null;
    doc.yearMax = value.yearMax ?? null;
    doc.exteriorColor = value.exteriorColor ?? null;
    doc.interiorColor = value.interiorColor ?? null;
    doc.interiorMaterial = value.interiorMaterial ?? null;
    doc.engine = value.engine ?? null;
    doc.fuel = value.fuel ?? null;
    doc.note = value.note ?? null;
    doc.telegramUsername = value.telegramUsername ?? null;

    await doc.save();
    return res.json(doc.toObject());
  } catch (err) {
    console.error('[car-requests] update error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// PATCH /api/car-requests/:id/close — mark found-it / close
router.patch('/:id/close', async (req, res) => {
  try {
    const buyerUid = req.auth && req.auth.uid;
    if (!buyerUid) return res.status(401).json({ error: 'unauthorized' });
    const doc = await findOwned(req.params.id, buyerUid);
    if (!doc) return res.status(404).json({ error: 'not_found' });
    doc.status = 'closed';
    await doc.save();
    return res.json(doc.toObject());
  } catch (err) {
    console.error('[car-requests] close error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// DELETE /api/car-requests/:id — delete own
router.delete('/:id', async (req, res) => {
  try {
    const buyerUid = req.auth && req.auth.uid;
    if (!buyerUid) return res.status(401).json({ error: 'unauthorized' });
    const doc = await findOwned(req.params.id, buyerUid);
    if (!doc) return res.status(404).json({ error: 'not_found' });
    await doc.deleteOne();
    return res.json({ ok: true });
  } catch (err) {
    console.error('[car-requests] delete error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/car-requests/:id — seller detail (contact redacted; no unlocks until Slice 3)
router.get('/:id', async (req, res) => {
  try {
    const callerUid = req.auth && req.auth.uid;
    if (!callerUid) return res.status(401).json({ error: 'unauthorized' });

    const seller = await getApprovedSeller(callerUid);
    if (!seller) return res.status(403).json({ error: 'not_approved_seller' });

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'not_found' });
    }
    const doc = await CarRequest.findById(req.params.id).lean();
    if (!doc || doc.status !== 'open') return res.status(404).json({ error: 'not_found' });

    const { amount, currency } = getUnlockPrice();
    const requestOut = redactForSeller(doc, { unlocked: false });
    return res.json({ unlockPrice: amount, currency, request: requestOut });
  } catch (err) {
    console.error('[car-requests] detail error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

module.exports = router;
