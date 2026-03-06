/**
 * CarEx Vehicle Taxonomy Seed Script
 * Populates vehicle_makes and vehicle_models collections.
 * Run: node seed-vehicle-taxonomy.js
 *
 * Drop existing collections first if starting fresh:
 *   db.vehicle_makes.drop()
 *   db.vehicle_models.drop()
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI required in .env');
  process.exit(1);
}

function toSlug(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

const vehicleMakeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  logo: { type: String, default: null },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const vehicleModelSchema = new mongoose.Schema({
  makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMake', required: true },
  name: { type: String, required: true },
  slug: { type: String, required: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const VehicleMake = mongoose.model('VehicleMake', vehicleMakeSchema, 'vehicle_makes');
const VehicleModel = mongoose.model('VehicleModel', vehicleModelSchema, 'vehicle_models');

// Popular Japanese, Korean, German, American brands
const TAXONOMY = {
  Honda: ['Accord', 'Civic', 'CR-V', 'HR-V', 'Pilot', 'Passport', 'Odyssey', 'Ridgeline', 'Fit'],
  Toyota: ['Camry', 'Corolla', 'RAV4', 'Highlander', '4Runner', 'Tacoma', 'Tundra', 'Sienna', 'Prius', 'Land Cruiser'],
  Nissan: ['Altima', 'Maxima', 'Sentra', 'Rogue', 'Murano', 'Pathfinder', 'Frontier', 'Titan', 'Leaf'],
  Mazda: ['Mazda3', 'Mazda6', 'CX-5', 'CX-50', 'CX-9', 'CX-90', 'MX-5 Miata'],
  Subaru: ['Impreza', 'Legacy', 'WRX', 'Crosstrek', 'Forester', 'Outback', 'Ascent'],
  Mitsubishi: ['Outlander', 'Mirage', 'Eclipse Cross'],
  Lexus: ['ES', 'IS', 'NX', 'RX', 'GX', 'LX'],
  Acura: ['Integra', 'TLX', 'MDX', 'RDX'],
  Infiniti: ['Q50', 'QX50', 'QX60', 'QX80'],
  Hyundai: ['Elantra', 'Sonata', 'Tucson', 'Santa Fe', 'Palisade', 'Kona', 'Ioniq 5', 'Ioniq 6'],
  Kia: ['Forte', 'K5', 'Sorento', 'Sportage', 'Telluride', 'Seltos', 'Soul', 'EV6', 'Carnival'],
  Genesis: ['G70', 'G80', 'G90', 'GV60', 'GV70', 'GV80'],
  BMW: ['3 Series', '5 Series', 'X3', 'X5', 'X7', 'i4', 'iX'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'GLC', 'GLE', 'GLS'],
  Audi: ['A4', 'A6', 'Q5', 'Q7', 'e-tron'],
  Volkswagen: ['Jetta', 'Passat', 'Golf', 'GTI', 'Tiguan', 'Atlas', 'ID.4'],
  Porsche: ['911', 'Cayenne', 'Macan', 'Taycan'],
  Ford: ['F-150', 'Mustang', 'Explorer', 'Bronco', 'Escape', 'Edge', 'Ranger', 'Maverick'],
  Chevrolet: ['Silverado', 'Tahoe', 'Suburban', 'Equinox', 'Camaro', 'Corvette', 'Malibu'],
  GMC: ['Sierra', 'Yukon', 'Acadia', 'Terrain'],
  Jeep: ['Wrangler', 'Grand Cherokee', 'Cherokee', 'Compass', 'Gladiator'],
  Dodge: ['Challenger', 'Charger', 'Durango'],
  Tesla: ['Model 3', 'Model S', 'Model X', 'Model Y', 'Cybertruck'],
  Cadillac: ['CT4', 'CT5', 'Escalade', 'XT4', 'XT5', 'XT6'],
};

async function main() {
  await mongoose.connect(MONGODB_URI, { dbName: 'CarEx' });
  console.log('Connected to MongoDB');

  let makeCount = 0;
  let modelCount = 0;

  for (const [makeName, models] of Object.entries(TAXONOMY)) {
    const makeSlug = toSlug(makeName);
    const make = await VehicleMake.findOneAndUpdate(
      { slug: makeSlug },
      { name: makeName, slug: makeSlug, isActive: true },
      { upsert: true, new: true }
    );
    makeCount++;

    for (const modelName of models) {
      const modelSlug = toSlug(modelName);
      await VehicleModel.findOneAndUpdate(
        { makeId: make._id, slug: modelSlug },
        { makeId: make._id, name: modelName, slug: modelSlug, isActive: true },
        { upsert: true }
      );
      modelCount++;
    }
  }

  console.log(`Seeded ${makeCount} makes, ${modelCount} models.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
