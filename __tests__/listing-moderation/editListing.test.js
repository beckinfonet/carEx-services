// __tests__/listing-moderation/editListing.test.js
//
// Integration test for listingService.editListing() (Plan 08-06, LADM-01).
//
// Uses MongoMemoryReplSet fixture because session.withTransaction() requires
// replica-set mode. Mirrors suspendListing.test.js shape but exercises the
// fieldDiff + image-merge + lazy makeId/modelId validation surface unique to
// Edit. ALSO locks the D-A-3 stamp distinction: Edit updates
// lastEditedBy/lastEditedAt but NEVER touches moderatedBy/moderatedAt.
//
// Coverage (per 08-06-PLAN.md Task 3 behavior block + 08-CONTEXT.md D-A/D-A-1/
// D-A-2/D-A-3/D-A-4 + D-D + D-06):
//   1. Single-field edit: fieldDiff has one entry, Car updated, lastEditedBy
//      stamped, moderatedBy NOT touched, other fields untouched
//   2. Multi-field edit: fieldDiff has all changed entries
//   3. Image-add (D-D): existingImageUrls + uploaded files → merged after
//   4. Image-remove: existingImageUrls drops a URL, no new uploads
//   5. Image-reorder: existingImageUrls reorders existing URLs
//   6. Empty diff → throws no_changes (D-06)
//   7. Works on suspended listing (D-A-4): audit fromStatus === toStatus === 'suspended'
//   8. Works on archived listing (D-A-4)
//   9. Works on deleted listing (D-A-4)
//  10. makeId/modelId validation OK: lazy VehicleMake/VehicleModel resolution
//      succeeds (Pitfall 7); fieldDiff captures makeId/modelId/makeName/modelName
//  11. Invalid makeId → throws invalid_make (D-A)
//  12. Invalid modelId (valid makeId but wrong make) → throws invalid_model (D-A)
//  13. D-A-3 stamp distinction (LOAD-BEARING): Edit on a previously-moderated
//      Car preserves moderatedBy + moderatedAt exactly; only lastEditedBy +
//      lastEditedAt update
//  14. listing_not_found on ghost ObjectId
//
// Lazy-model registration dance per 08-RESEARCH.md Pitfall 7 — VehicleMake /
// VehicleModel are registered in server.js inline (lines 99-100), not in
// src/models/. Tests register loose-schema variants under the canonical names
// BEFORE requiring the service so editListing's mongoose.model('VehicleMake' /
// 'VehicleModel') resolves.

const mongoose = require('mongoose');
const { startReplSet, stopReplSet } = require('../_helpers/mongoReplSet');

// Pitfall 7 lazy-model registration BEFORE requiring the service. Loose schema
// (strict: false) lets us seed arbitrary fields without locking down VehicleMake/
// VehicleModel shape in test code.
if (!mongoose.models.VehicleMake) {
  mongoose.model('VehicleMake', new mongoose.Schema({}, { strict: false, collection: 'vehicle_makes' }));
}
if (!mongoose.models.VehicleModel) {
  mongoose.model('VehicleModel', new mongoose.Schema({}, { strict: false, collection: 'vehicle_models' }));
}
const VehicleMake = mongoose.model('VehicleMake');
const VehicleModel = mongoose.model('VehicleModel');

const service = require('../../src/moderation/listingService');
const Car = require('../../src/models/Car');
const ListingModerationAction = require('../../src/models/ListingModerationAction');

let rs;

beforeAll(async () => { rs = await startReplSet(); });
afterAll(async () => { await stopReplSet(rs); });

beforeEach(async () => {
  await Car.deleteMany({});
  try { await ListingModerationAction.collection.drop(); } catch (_) { /* may not exist */ }
  try { await VehicleMake.collection.drop(); } catch (_) { /* idem */ }
  try { await VehicleModel.collection.drop(); } catch (_) { /* idem */ }
});

// Seed a Car directly via collection.insertOne — bypasses pre-save validators
// + pre(/^find/) seller-cascade hide hook during seeding. Returns _id as a
// string per Phase 7 audit-row contract (ListingModerationAction.js:41).
async function seedCar(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Car.collection.insertOne({
    _id,
    sellerId: 'seller-x',
    status: 'active',
    listingStatus: 'active',
    price: 12000,
    description: 'original description',
    imageUrls: [],
    moderationReason: null,
    moderationNote: null,
    moderatedBy: null,
    moderatedAt: null,
    lastEditedBy: null,
    lastEditedAt: null,
    createdAt: new Date(),
    ...overrides,
  });
  return _id.toString();
}

describe('service.editListing (LADM-01)', () => {
  test('single-field text edit: fieldDiff has one entry, Car updated, lastEditedBy stamped, other fields untouched', async () => {
    const carId = await seedCar({ price: 12000, description: 'original' });

    const result = await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { price: 11500 },
      uploadedFiles: [],
    });

    // fieldDiff captures only the changed field
    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.action).toBe('edit');
    expect(audit.fromStatus).toBe('active');
    expect(audit.toStatus).toBe('active'); // D-A-4: no state change
    expect(audit.reasonCategory).toBeNull();
    expect(audit.fieldDiff).toEqual({ price: { before: 12000, after: 11500 } });

    // Car updated
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.price).toBe(11500);
    expect(car.description).toBe('original'); // other fields untouched
    expect(car.status).toBe('active'); // Edit does NOT transition state

    // D-A-3: lastEditedBy + lastEditedAt stamped
    expect(car.lastEditedBy).toBe('admin-uid');
    expect(car.lastEditedAt).toBeInstanceOf(Date);

    // D-A-3 distinction: moderatedBy + moderatedAt NOT touched (still null from seed)
    expect(car.moderatedBy).toBeNull();
    expect(car.moderatedAt).toBeNull();

    // Response shape
    expect(result.listing._id).toBe(carId);
    expect(result.listing.status).toBe('active');
    expect(result.listing.lastEditedBy).toBe('admin-uid');
    expect(result.listing.lastEditedAt).toBeInstanceOf(Date);
    expect(result.action.action).toBe('edit');
    expect(result.action.fromStatus).toBe('active');
    expect(result.action.toStatus).toBe('active');
  });

  test('multi-field edit: fieldDiff has all changed entries, changeSet applied', async () => {
    const carId = await seedCar({
      price: 12000,
      description: 'old description',
      mileage: 50000,
    });

    const result = await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { price: 11500, description: 'new description', mileage: 55000 },
      uploadedFiles: [],
    });

    expect(result.action.action).toBe('edit');

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fieldDiff.price).toEqual({ before: 12000, after: 11500 });
    expect(audit.fieldDiff.description).toEqual({ before: 'old description', after: 'new description' });
    expect(audit.fieldDiff.mileage).toEqual({ before: 50000, after: 55000 });
    expect(Object.keys(audit.fieldDiff).sort()).toEqual(['description', 'mileage', 'price']);

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.price).toBe(11500);
    expect(car.description).toBe('new description');
    expect(car.mileage).toBe(55000);
  });

  test('image-add (D-D): existingImageUrls preserved + new uploads appended via merge', async () => {
    const carId = await seedCar({ imageUrls: ['s3://existing-a'] });

    await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { existingImageUrls: JSON.stringify(['s3://existing-a']) },
      uploadedFiles: [{ location: 's3://new-b' }],
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fieldDiff.imageUrls).toEqual({
      before: ['s3://existing-a'],
      after: ['s3://existing-a', 's3://new-b'],
    });

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.imageUrls).toEqual(['s3://existing-a', 's3://new-b']);
  });

  test('image-remove: existingImageUrls drops a URL, no new uploads, fieldDiff captures both arrays', async () => {
    const carId = await seedCar({ imageUrls: ['s3://a', 's3://b'] });

    await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { existingImageUrls: JSON.stringify(['s3://a']) },
      uploadedFiles: [],
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fieldDiff.imageUrls).toEqual({
      before: ['s3://a', 's3://b'],
      after: ['s3://a'],
    });

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.imageUrls).toEqual(['s3://a']);
  });

  test('image-reorder: existingImageUrls reorders existing URLs, fieldDiff captures order change', async () => {
    const carId = await seedCar({ imageUrls: ['s3://a', 's3://b'] });

    await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { existingImageUrls: JSON.stringify(['s3://b', 's3://a']) },
      uploadedFiles: [],
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fieldDiff.imageUrls).toEqual({
      before: ['s3://a', 's3://b'],
      after: ['s3://b', 's3://a'],
    });

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.imageUrls).toEqual(['s3://b', 's3://a']);
  });

  test('empty diff → throws no_changes (D-06 / D-A-2: submitting only equal values produces empty fieldDiff)', async () => {
    const carId = await seedCar({ price: 12000 });

    await expect(service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { price: 12000 }, // equals current value
      uploadedFiles: [],
    })).rejects.toThrow('no_changes');

    // No audit row written
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);

    // Car unchanged
    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.price).toBe(12000);
    expect(car.lastEditedBy).toBeNull();
  });

  test('D-A-4 works on suspended listing: audit fromStatus === toStatus === suspended, status preserved', async () => {
    const carId = await seedCar({ status: 'suspended', price: 12000 });

    await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { price: 11500 },
      uploadedFiles: [],
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.action).toBe('edit');
    expect(audit.fromStatus).toBe('suspended');
    expect(audit.toStatus).toBe('suspended');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('suspended'); // Edit does NOT change status
    expect(car.price).toBe(11500);
  });

  test('D-A-4 works on archived listing: audit fromStatus === toStatus === archived', async () => {
    const carId = await seedCar({ status: 'archived', price: 12000 });

    await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { price: 11500 },
      uploadedFiles: [],
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('archived');
    expect(audit.toStatus).toBe('archived');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('archived');
  });

  test('D-A-4 works on deleted listing: audit fromStatus === toStatus === deleted', async () => {
    const carId = await seedCar({ status: 'deleted', price: 12000 });

    await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { price: 11500 },
      uploadedFiles: [],
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fromStatus).toBe('deleted');
    expect(audit.toStatus).toBe('deleted');

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.status).toBe('deleted');
  });

  test('makeId/modelId validation OK (Pitfall 7 lazy resolution): fieldDiff captures id + name fields, makeName/modelName resolved', async () => {
    // Seed with ObjectId-typed _id + makeId — mongoose auto-casts query
    // strings → ObjectIds on the way in (matches production server.js
    // behavior at line 73 where makeId is `Schema.Types.ObjectId, ref:
    // 'VehicleMake'`). Test passes the string form to mirror multipart input.
    const makeId = new mongoose.Types.ObjectId();
    const modelId = new mongoose.Types.ObjectId();
    await VehicleMake.collection.insertOne({
      _id: makeId, name: 'Toyota', slug: 'toyota', isActive: true,
    });
    await VehicleModel.collection.insertOne({
      _id: modelId, makeId, name: 'Corolla', slug: 'corolla', isActive: true,
    });

    const oldMakeId = new mongoose.Types.ObjectId();
    const oldModelId = new mongoose.Types.ObjectId();
    const carId = await seedCar({
      makeId: oldMakeId,
      modelId: oldModelId,
      makeName: 'OldMake',
      modelName: 'OldModel',
    });

    await service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { makeId: makeId.toString(), modelId: modelId.toString() },
      uploadedFiles: [],
    });

    const audit = await ListingModerationAction.findOne({ listingId: carId }).lean();
    expect(audit.fieldDiff.makeId).toBeDefined();
    expect(audit.fieldDiff.modelId).toBeDefined();
    expect(audit.fieldDiff.makeName).toEqual({ before: 'OldMake', after: 'Toyota' });
    expect(audit.fieldDiff.modelName).toEqual({ before: 'OldModel', after: 'Corolla' });

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();
    expect(car.makeName).toBe('Toyota');
    expect(car.modelName).toBe('Corolla');
  });

  test('invalid makeId → throws invalid_make (lazy VehicleMake.findOne returns null)', async () => {
    const carId = await seedCar();
    const ghostMakeId = new mongoose.Types.ObjectId().toString();

    await expect(service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { makeId: ghostMakeId, modelId: new mongoose.Types.ObjectId().toString() },
      uploadedFiles: [],
    })).rejects.toThrow('invalid_make');

    // No audit row written + Car unchanged
    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);
  });

  test('invalid modelId (valid make, model not bound to make) → throws invalid_model', async () => {
    const makeId = new mongoose.Types.ObjectId();
    const otherMakeId = new mongoose.Types.ObjectId();
    const wrongModelId = new mongoose.Types.ObjectId();
    await VehicleMake.collection.insertOne({
      _id: makeId, name: 'Toyota', slug: 'toyota', isActive: true,
    });
    // model bound to a DIFFERENT make
    await VehicleModel.collection.insertOne({
      _id: wrongModelId, makeId: otherMakeId, name: 'NotACorolla', slug: 'not', isActive: true,
    });

    const carId = await seedCar();

    await expect(service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId,
      fields: { makeId: makeId.toString(), modelId: wrongModelId.toString() },
      uploadedFiles: [],
    })).rejects.toThrow('invalid_model');

    const auditCount = await ListingModerationAction.countDocuments({ listingId: carId });
    expect(auditCount).toBe(0);
  });

  test('D-A-3 stamp distinction (LOAD-BEARING): Edit preserves moderatedBy + moderatedAt exactly; updates only lastEditedBy + lastEditedAt', async () => {
    const seedModeratedAt = new Date('2025-01-01T00:00:00.000Z');
    const carId = await seedCar({
      status: 'suspended',
      price: 12000,
      moderatedBy: 'original-admin',
      moderatedAt: seedModeratedAt,
      moderationReason: 'spam',
      moderationNote: 'original moderation note',
    });

    // Wait a beat so post-call lastEditedAt is provably > seedModeratedAt
    await new Promise((r) => setTimeout(r, 10));

    await service.editListing({
      adminUid: 'editing-admin',
      adminEmail: 'editor@test.local',
      carId,
      fields: { price: 11500 },
      uploadedFiles: [],
    });

    const car = await Car.findById(carId)
      .setOptions({ includeAllListingStatuses: true, includeAllUsers: true })
      .lean();

    // moderatedBy + moderatedAt PRESERVED (D-A-3 distinction)
    expect(car.moderatedBy).toBe('original-admin');
    expect(car.moderatedAt.getTime()).toBe(seedModeratedAt.getTime());

    // moderationReason + moderationNote also preserved — Edit isn't a state change
    expect(car.moderationReason).toBe('spam');
    expect(car.moderationNote).toBe('original moderation note');

    // lastEditedBy / lastEditedAt UPDATED to the editing admin
    expect(car.lastEditedBy).toBe('editing-admin');
    expect(car.lastEditedAt).toBeInstanceOf(Date);
    expect(car.lastEditedAt.getTime()).toBeGreaterThan(seedModeratedAt.getTime());

    // Status preserved (Edit does NOT transition state)
    expect(car.status).toBe('suspended');
    // The price was actually changed
    expect(car.price).toBe(11500);
  });

  test('listing_not_found on ghost ObjectId: throws before any audit-row write', async () => {
    const ghostId = new mongoose.Types.ObjectId().toString();

    await expect(service.editListing({
      adminUid: 'admin-uid',
      adminEmail: 'admin@test.local',
      carId: ghostId,
      fields: { price: 11500 },
      uploadedFiles: [],
    })).rejects.toThrow('listing_not_found');

    const auditCount = await ListingModerationAction.countDocuments({ listingId: ghostId });
    expect(auditCount).toBe(0);
  });
});
