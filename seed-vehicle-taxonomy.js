/**
 * CarEx Vehicle Taxonomy Seed Script
 * Populates vehicle_makes and vehicle_models collections.
 * Run: node seed-vehicle-taxonomy.js [--drop]
 *
 * Use --drop to drop vehicle_makes and vehicle_models before seeding.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI required in .env');
  process.exit(1);
}

const DROP_FIRST = process.argv.includes('--drop');

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

const TAXONOMY = [
  { make: 'BMW', models: ['1 series', '2 series', '3 series', '4 series', '5 series', '6 series', '7 series', '8 series', 'GT Gran turismo', '1M', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X3M', 'X4M', 'X5M', 'X6M', 'XM', 'Z3', 'Z4', 'Z8', 'i3', 'i4', 'i5', 'i7', 'i8', 'ix1', 'ix2', 'ix3', 'iX'] },
  { make: 'Mercedes-Benz', models: ['A-Class', 'B-Class', 'C-Class', 'CL-Class', 'CLA-Class', 'CLE-Cass', 'CLK-Class', 'CLS-Class', 'E-Class', 'EQA', 'EQB', 'EQC', 'EQE', 'EQS', 'G-Class', 'GL-Class', 'GLA-Class', 'GLB-Class', 'GLC-Class', 'GLE-Class', 'GLK-Class', 'GLS-Class', 'M-Class', 'R-Class', 'S-Class', 'SL-Class', 'SLC-Class', 'SLK-Class', 'SLR', 'SLS AMG', 'AMG GT', 'SEL/SEC', 'V-Class', 'SPRINTER'] },
  { make: 'Audi', models: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q2', 'Q3', 'Q5', 'Q7', 'Q8', 'R8', 'RS3', 'RS4', 'RS5', 'RS6', 'RS7', 'RS8', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'SQ5', 'SQ7', 'SQ8', 'TTRS', 'TTS', 'TT', 'E-Tron', 'E-Tron GT', 'RS E-Tron GT', 'Q4 E-Tron', 'Q6 E-Tron', 'Q8 E-Tron', 'SQ6 E-Tron', 'SQ8 E-Tron'] },
  { make: 'Porsche', models: ['718', '911', 'Macan', 'Boxster', 'Carrera GT', 'Cayman', 'Cayenne', 'Taycan', 'Panamera'] },
  { make: 'Mini', models: ['Cooper', 'Cooper Convertible', 'Coupe', 'Roadster', 'AceMan', 'CountryMan', 'ClubMan', 'PaceMan'] },
  { make: 'Volkswagen', models: ['Tiguan', 'Golf', 'Arteon', 'Jetta', 'Passat', 'Touareg', 'CC', 'iD4', 'iD5', 'Beetle', 'Sirocco', 'Atlas', 'Tyroc', 'Phaeton', 'Polo'] },
  { make: 'Volvo', models: ['C30', 'C40', 'C70', 'EX30', 'EX40', 'S40', 'S60', 'S70', 'S80', 'S90', 'V40', 'V50', 'V60', 'V70', 'V90', 'XC40', 'XC60', 'XC70', 'XC90'] },
  { make: 'Lexus', models: ['CT200h', 'ES', 'GS', 'GX', 'iS', 'LC', 'LM', 'LS', 'LX', 'NX', 'RC', 'RX', 'RZ', 'SC', 'UX'] },
  { make: 'Toyota', models: ['4Runner', '86', 'C-HR', 'FJ-cruiser', 'RAV4', 'bB', 'iQ', 'Land cruiser', 'Supra', 'Sienna', 'Avalon', 'Alphard', 'Camry', 'Corolla', 'Crown', 'Tacoma', 'Tundra', 'Prius', 'Highlander'] },
  { make: 'Honda', models: ['CR-V', 'CR-Z', 'HR-V', 'N-Box', 'N-ONE', 'S660', 'Legend', 'Ridgeline', 'StepWagon', 'Civic', 'Accord', 'Odyssey', 'Pilot'] },
  { make: 'Nissan', models: ['Leaf', 'Maxima', 'Murano', 'Sentra', 'Skyline', 'Altima', 'X-Trail', 'Juke', 'Qashqai', 'Cube', 'Titan', 'Tiana', 'Pathfinder', 'Frontier', '370Z', 'GT-R', 'NV'] },
  { make: 'Mitsubishi', models: ['Lancer', 'Lancer Evolution', 'Montero', 'Outlander', 'Eclipse', 'Pajero'] },
  { make: 'Tesla', models: ['Model 3', 'Model S', 'Model X', 'Model Y', 'Cybertruck'] },
  { make: 'Ford', models: ['E-Series', 'F150', 'F250', 'F350', 'GT', 'S-Max', 'Ranger', 'Mustang', 'Mondeo', 'Bronco', 'Escape', 'Explorer', 'Expedition', 'Eco Sports', 'Cougar', 'Taurus', 'Transit', 'Focus', 'Fusion'] },
  { make: 'Jeep', models: ['CJ', 'Gladiator', 'Wrangler', 'Renegade', 'Avenger', 'Cherokee', 'Commander', 'Compass', 'Patriot'] },
  { make: 'Cadillac', models: ['ATS-V', 'ATS', 'CT4', 'CT5', 'CT5-V', 'CT6', 'CT6-V', 'CTS', 'CTS-V', 'SRX', 'STS', 'XT4', 'XT5', 'XT6', 'XTS', 'Lyric', 'Escalade'] },
  { make: 'Lincoln', models: ['MKC', 'MKS', 'MKT', 'MKX', 'MKZ', 'Navigator', 'Nautilus', 'Aviator', 'Continental', 'Corsair'] },
  { make: 'Maserati', models: ['Gran Cabrio', 'Gran Turismo', 'Ghibli', 'Grecale', 'Levante', 'Quattroporte', 'MC20'] },
  { make: 'Jaguar', models: ['E-PACE', 'E-TYPE', 'F-PACE', 'F-TYPE', 'I-PACE', 'S-TYPE', 'X-TYPE', 'XE', 'XF', 'XJ-6', 'XJ-8', 'XJ-C', 'XJR', 'XJS', 'XJ', 'XK', 'XK8', 'XKR'] },
  { make: 'Land Rover', models: ['Discovery Sport', 'Discovery', 'Defender', 'RangeRover Velar', 'RangeRover Sport', 'RangeRover Evoque', 'RangeRover', 'Freelander'] },
  { make: 'Ferrari', models: ['12Chilindri', '296', '308', '328', '348', '360', '456', '458', '488', '512 TR', '550', '575M', '599', '612', '812', '849', 'F12 Berlinetta', 'F355', 'F40', 'F430', 'F50', 'F8', 'FF', 'GTC4 Lusso', 'SF90', 'LaFerrari', 'Rome', 'Amalfi', 'Enzo Ferrari', 'California', 'Portofino', 'PurosanCrab'] },
  { make: 'Lamborghini', models: ['Gallardo', 'Diablo', 'Revuelto', 'Leventon', 'Murcielago', 'Aventador', 'Huracan', 'Urus', 'Jalpa', 'Temerario'] },
  { make: 'McLaren', models: ['540C', '570GT', '570S', '600LT', '650S', '675LT', '720S', '750S', '765LT', 'GT', 'MP4-12C', 'Atura', 'Senna'] },
  { make: 'Maybach', models: ['57', '57s', '62', '62s', '57 Zeppelin', '62 Zeppelin', '62s Lendlet'] },
  { make: 'Bentley', models: ['Mulsanne', 'Bentayga', 'Brooklands', 'Arnazi', 'Azur', 'Eight', 'Continental', 'Flying Spur'] },
  { make: 'Rolls-Royce', models: ['Ghost', 'Dawn', 'Race', 'Silver Spur', 'Specter', 'Cullinan', 'Cornish', 'Phantom'] },
  { make: 'Dodge', models: ['Nitro', 'Dakota', 'Durango', 'Ramban', 'RAM Pickup', 'Magnum', 'Viper', 'Van', 'Avenger', 'Intrepid', 'Charger', 'Challenger', 'Caravan', 'Grand Caravan', 'Caliber'] },
  { make: 'GMC', models: ['Ventura', 'Savannah', 'Safari', 'Sonoma', 'Sierra', 'Yukon', 'Jimmy', 'Canyon', 'Terrain', 'Hummer EV'] },
  { make: 'Subaru', models: ['BRZ', 'R1', 'SVX', 'Legacy', 'Levorg', 'Outback', 'Impreza', 'Forester'] },
  { make: 'BYD', models: ['E6', 'Ato 3', 'Sea Lion 7', 'Seal'] },
  { make: 'Hyundai', models: ['Grandeur', 'SantaFe', 'Avante', 'Sonata', 'Palisade', 'Tucson', 'i30', 'Max Cruz', 'Venue', 'Veracruz', 'Veloster', 'Starex', 'Staria', 'Aslan', 'Ionic 5', 'Ionic 6', 'Ionic 9', 'Accent', 'Genesis', 'Casper', 'Kona', 'Porter'] },
  { make: 'Genesis', models: ['EQ900', 'G70', 'G80', 'G90', 'GV60', 'GV70', 'GV80'] },
  { make: 'Kia', models: ['Carnival', 'Sorento', 'Sportage', 'Morning', 'Ray', 'K3', 'K5', 'K7', 'K8', 'K9', 'EV3', 'EV4', 'EV5', 'EV6', 'EV9', 'Niro', 'Mohave', 'Seltos', 'Stonic', 'Stinger', 'Soul', 'Carens', 'Tasman', 'Forte', 'Pride', 'Bongo'] },
  { make: 'Chevrolet', models: ['Spark', 'Trax', 'Malibu', 'Orlando', 'Cruz', 'Trailblazer', 'Damas', 'Bolt', 'Equinox', 'Impala', 'Camaro', 'Colorado', 'Traverse', 'Tahoe', 'Labo'] },
  { make: 'Samsung', models: ['QM3', 'QM5', 'QM6', 'SM3', 'SM5', 'SM6', 'SM7', 'XM3', 'Grand Coleos', 'Master', 'Scenic', 'Joe', 'Capture', 'Clio', 'Twizy', 'Arcana'] },
  { make: 'KG Mobility', models: ['Rexton', 'Tivolli', 'Korando', 'Torres', 'Chairman', 'Actyon', 'Musso'] },
];

async function main() {
  await mongoose.connect(MONGODB_URI, { dbName: 'CarEx' });
  console.log('Connected to MongoDB');

  if (DROP_FIRST) {
    await mongoose.connection.db.collection('vehicle_models').drop().catch(() => {});
    await mongoose.connection.db.collection('vehicle_makes').drop().catch(() => {});
    console.log('Dropped vehicle_makes and vehicle_models.');
  }

  let makeCount = 0;
  let modelCount = 0;

  for (const { make: makeName, models } of TAXONOMY) {
    const makeSlug = toSlug(makeName);
    const make = await VehicleMake.create({ name: makeName, slug: makeSlug, isActive: true });
    makeCount++;

    for (const modelName of models) {
      const modelSlug = toSlug(modelName);
      await VehicleModel.create({ makeId: make._id, name: modelName, slug: modelSlug, isActive: true });
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
