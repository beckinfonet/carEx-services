/**
 * Seed script for Vehicle Makes and Models.
 * Tries NHTSA vPIC API first (free, no auth). Falls back to static list if API fails.
 * Run: node seed-vehicle-catalog.js
 */

const mongoose = require('mongoose');
const https = require('https');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI required in .env');
  process.exit(1);
}

const vehicleMakeSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  nhtsaId: Number,
}, { timestamps: true });

const vehicleModelSchema = new mongoose.Schema({
  makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMake', required: true },
  name: { type: String, required: true },
}, { timestamps: true });

vehicleModelSchema.index({ makeId: 1, name: 1 }, { unique: true });

const VehicleMake = mongoose.model('VehicleMake', vehicleMakeSchema);
const VehicleModel = mongoose.model('VehicleModel', vehicleModelSchema);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CarEx/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function seedFromNHTSA() {
  console.log('Fetching makes from NHTSA vPIC API...');
  const makesRes = await fetchJson('https://vpic.nhtsa.dot.gov/api/vehicles/getallmakes?format=json');
  const makes = makesRes.Results || [];
  if (makes.length === 0) throw new Error('No makes from NHTSA');

  console.log(`Found ${makes.length} makes. Seeding...`);
  for (const m of makes) {
    const makeName = (m.Make_Name || '').trim();
    if (!makeName) continue;
    await VehicleMake.findOneAndUpdate(
      { name: makeName },
      { name: makeName, nhtsaId: m.Make_ID },
      { upsert: true }
    );
  }

  const dbMakes = await VehicleMake.find().sort({ name: 1 });
  let modelCount = 0;
  for (const make of dbMakes) {
    if (!make.nhtsaId) continue;
    try {
      const modelsRes = await fetchJson(
        `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeId/${make.nhtsaId}?format=json`
      );
      const models = modelsRes.Results || [];
      for (const mod of models) {
        const modelName = (mod.Model_Name || '').trim();
        if (!modelName) continue;
        await VehicleModel.findOneAndUpdate(
          { makeId: make._id, name: modelName },
          { makeId: make._id, name: modelName },
          { upsert: true }
        );
        modelCount++;
      }
    } catch (e) {
      console.warn(`Skip models for ${make.name}:`, e.message);
    }
  }
  console.log(`Seeded ${dbMakes.length} makes, ${modelCount} models from NHTSA.`);
}

// Fallback: comprehensive static list (Japanese, Korean, German, American + common)
const STATIC_MAKES_MODELS = {
  Acura: ['ILX', 'Integra', 'MDX', 'NSX', 'RDX', 'RLX', 'TLX', 'TL'],
  Audi: ['A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q3', 'Q5', 'Q7', 'Q8', 'e-tron', 'TT', 'R8'],
  BMW: ['2 Series', '3 Series', '4 Series', '5 Series', '7 Series', '8 Series', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'Z4', 'i3', 'i4', 'iX'],
  Buick: ['Enclave', 'Encore', 'Envision', 'LaCrosse', 'Regal'],
  Cadillac: ['CT4', 'CT5', 'Escalade', 'XT4', 'XT5', 'XT6', 'Lyriq'],
  Chevrolet: ['Camaro', 'Corvette', 'Equinox', 'Malibu', 'Silverado', 'Suburban', 'Tahoe', 'Trailblazer', 'Traverse', 'Trax', 'Blazer', 'Bolt'],
  Dodge: ['Challenger', 'Charger', 'Durango', 'Hornet'],
  Ford: ['Bronco', 'Bronco Sport', 'Escape', 'Edge', 'Explorer', 'Expedition', 'F-150', 'Mustang', 'Ranger', 'Transit', 'Maverick', 'Fusion'],
  Genesis: ['G70', 'G80', 'G90', 'GV60', 'GV70', 'GV80'],
  GMC: ['Acadia', 'Canyon', 'Hummer EV', 'Sierra', 'Terrain', 'Yukon'],
  Honda: ['Accord', 'Civic', 'CR-V', 'HR-V', 'Pilot', 'Passport', 'Odyssey', 'Ridgeline', 'Fit', 'Insight'],
  Hyundai: ['Accent', 'Elantra', 'Sonata', 'Tucson', 'Santa Fe', 'Palisade', 'Kona', 'Venue', 'Ioniq 5', 'Ioniq 6', 'Genesis'],
  Infiniti: ['Q50', 'Q60', 'QX50', 'QX55', 'QX60', 'QX80'],
  Jaguar: ['E-PACE', 'F-PACE', 'F-TYPE', 'I-PACE', 'XE', 'XF', 'XJ'],
  Jeep: ['Compass', 'Renegade', 'Cherokee', 'Grand Cherokee', 'Wrangler', 'Gladiator', 'Wagoneer'],
  Kia: ['Forte', 'Optima', 'K5', 'Sorento', 'Sportage', 'Telluride', 'Seltos', 'Soul', 'Niro', 'EV6', 'Carnival'],
  'Land Rover': ['Defender', 'Discovery', 'Range Rover', 'Range Rover Sport', 'Range Rover Velar', 'Range Rover Evoque'],
  Lexus: ['ES', 'IS', 'LS', 'RC', 'LC', 'NX', 'RX', 'GX', 'LX', 'UX', 'RZ'],
  Mazda: ['Mazda3', 'Mazda6', 'CX-3', 'CX-30', 'CX-5', 'CX-50', 'CX-9', 'CX-90', 'MX-5 Miata'],
  'Mercedes-Benz': ['A-Class', 'C-Class', 'E-Class', 'S-Class', 'CLA', 'CLS', 'GLA', 'GLB', 'GLC', 'GLE', 'GLS', 'G-Class', 'EQS', 'EQE'],
  Mitsubishi: ['Mirage', 'Outlander', 'Outlander Sport', 'Eclipse Cross'],
  Nissan: ['Altima', 'Maxima', 'Sentra', 'Versa', 'Leaf', 'Ariya', 'Kicks', 'Rogue', 'Murano', 'Pathfinder', 'Armada', 'Frontier', 'Titan', 'Z'],
  Porsche: ['718', '911', 'Panamera', 'Cayenne', 'Macan', 'Taycan'],
  Subaru: ['Impreza', 'Legacy', 'WRX', 'BRZ', 'Crosstrek', 'Forester', 'Outback', 'Ascent', 'Solterra'],
  Suzuki: ['Swift', 'Vitara', 'S-Cross', 'Jimny'],
  Tesla: ['Model 3', 'Model S', 'Model X', 'Model Y', 'Cybertruck'],
  Toyota: ['Camry', 'Corolla', 'Avalon', 'Prius', 'Yaris', 'GR86', 'Supra', 'C-HR', 'RAV4', 'Highlander', '4Runner', 'Sequoia', 'Land Cruiser', 'Tacoma', 'Tundra', 'Sienna', 'bZ4X'],
  Volkswagen: ['Jetta', 'Passat', 'Arteon', 'Golf', 'GTI', 'ID.4', 'Taos', 'Tiguan', 'Atlas', 'Atlas Cross Sport'],
  Volvo: ['S60', 'S90', 'V60', 'V90', 'XC40', 'XC60', 'XC90', 'C40', 'EX90'],
};

async function seedFromStatic() {
  console.log('Using static make/model list (NHTSA unavailable)...');
  for (const [makeName, models] of Object.entries(STATIC_MAKES_MODELS)) {
    const make = await VehicleMake.findOneAndUpdate(
      { name: makeName },
      { name: makeName },
      { upsert: true, new: true }
    );
    for (const modelName of models) {
      await VehicleModel.findOneAndUpdate(
        { makeId: make._id, name: modelName },
        { makeId: make._id, name: modelName },
        { upsert: true }
      );
    }
  }
  const makeCount = await VehicleMake.countDocuments();
  const modelCount = await VehicleModel.countDocuments();
  console.log(`Seeded ${makeCount} makes, ${modelCount} models from static list.`);
}

async function main() {
  await mongoose.connect(MONGODB_URI, { dbName: 'CarEx' });
  console.log('Connected to MongoDB');

  try {
    await seedFromNHTSA();
  } catch (e) {
    console.warn('NHTSA seed failed:', e.message);
    await seedFromStatic();
  }

  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
