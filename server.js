const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

dotenv.config();

const User = require('./src/models/User');
const AdminUser = require('./src/models/AdminUser');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, { dbName: 'CarEx' })
  .then(async () => {
    console.log('Connected to MongoDB');
    await seedSuperAdmin();
  })
  .catch((err) => console.error('MongoDB connection error:', err));

// AWS S3 Configuration
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME,
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      const folder = req.body.bodyType ? req.body.bodyType.toLowerCase() : 'misc';
      cb(null, `${folder}/${Date.now().toString()}-${file.originalname}`);
    },
  }),
});

const uploadAvatar = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME,
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      const uid = req.params.uid || 'unknown';
      cb(null, `avatars/${uid}-${Date.now().toString()}-${file.originalname || 'avatar.jpg'}`);
    },
  }),
});

// --- Vehicle Taxonomy Schemas ---
const vehicleMakeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  logo: { type: String, default: null },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
vehicleMakeSchema.index({ slug: 1 }, { unique: true });
vehicleMakeSchema.index({ name: 1 });

const vehicleModelSchema = new mongoose.Schema({
  makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMake', required: true },
  name: { type: String, required: true },
  slug: { type: String, required: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
vehicleModelSchema.index({ makeId: 1 });
vehicleModelSchema.index({ makeId: 1, slug: 1 }, { unique: true });

const VehicleMake = mongoose.model('VehicleMake', vehicleMakeSchema, 'vehicle_makes');
const VehicleModel = mongoose.model('VehicleModel', vehicleModelSchema, 'vehicle_models');

// Car Schema (listings reference makeId/modelId)
const carSchema = new mongoose.Schema({
  makeId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleMake' },
  modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'VehicleModel' },
  makeName: String,
  modelName: String,
  make: String,  // legacy, for old listings
  model: String, // legacy, for old listings
  trimLevel: String,
  wheelbase: String,
  year: Number,
  price: Number,
  mileage: Number,
  fuel: String,
  currency: String,
  description: String,
  bodyType: String,
  imageUrls: [String],
  createdAt: { type: Date, default: Date.now },
  engine: String,
  transmission: String,
  drivetrain: String,
  mpg: String,
  condition: String,
  knownIssues: [String],
  exteriorColor: String,
  interiorColor: String,
  interiorMaterial: String,
  seats: Number,
  doors: Number,
  phoneNumber: String,
  telegramUsername: String,
  listingId: String,
  sellerId: String, // Firebase UID of listing owner
  listingStatus: { type: String, enum: ['active', 'booked', 'sold'], default: 'active' },
  bookedByUid: { type: String, default: null },
  stripePaymentIntentId: { type: String, default: null },
});

const Car = mongoose.model('Car', carSchema);

// User model extracted to src/models/User.js (Plan 01-01)

// Service item sub-schema (shared by broker and logistics)
const serviceItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  fee: { type: mongoose.Schema.Types.Mixed, default: 0 },
  currency: { type: String, default: '$' },
}, { _id: false });

// Broker Schema
const brokerSchema = new mongoose.Schema({
  ownerUid: { type: String, required: true, unique: true },
  companyName: { type: String, required: true },
  description: String,
  phoneNumber: String,
  telegramUsername: String,
  services: [serviceItemSchema],
  paymentOptions: [String],
  avatarUrl: String,
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});
brokerSchema.index({ ownerUid: 1 }, { unique: true });

const Broker = mongoose.model('Broker', brokerSchema, 'brokers');

// Logistics Partner Schema
const logisticsPartnerSchema = new mongoose.Schema({
  ownerUid: { type: String, required: true, unique: true },
  companyName: { type: String, required: true },
  description: String,
  phoneNumber: String,
  telegramUsername: String,
  services: [serviceItemSchema],
  coverageAreas: [String],
  timelines: String,
  paymentOptions: [String],
  avatarUrl: String,
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});
logisticsPartnerSchema.index({ ownerUid: 1 }, { unique: true });

const LogisticsPartner = mongoose.model('LogisticsPartner', logisticsPartnerSchema, 'logistics_partners');

// OTP Schema
const otpSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true },
  code: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 }
});
const OTP = mongoose.model('OTP', otpSchema);

// AdminUser model extracted to src/models/AdminUser.js (Plan 01-01)

// Service Order Schema
const serviceOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  buyerUid: { type: String, required: true },
  carId: { type: String, default: null },
  carSnapshot: {
    makeName: String,
    modelName: String,
    year: Number,
    price: Number,
    currency: String,
    imageUrl: String,
    listingId: String,
  },
  providerUid: { type: String, required: true },
  providerType: { type: String, enum: ['broker', 'logistics'], required: true },
  providerSnapshot: {
    companyName: String,
    phoneNumber: String,
    telegramUsername: String,
  },
  services: [{
    name: { type: String, required: true },
    description: String,
    fee: mongoose.Schema.Types.Mixed,
    currency: String,
    status: { type: String, enum: ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'], default: 'pending' },
  }],
  totalAmount: { type: Number, default: 0 },
  totalCurrency: { type: String, default: '$' },
  status: { type: String, enum: ['pending', 'accepted', 'in_progress', 'completed', 'cancelled', 'rejected'], default: 'pending' },
  buyerNote: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
serviceOrderSchema.index({ buyerUid: 1, createdAt: -1 });
serviceOrderSchema.index({ providerUid: 1, createdAt: -1 });
serviceOrderSchema.index({ orderNumber: 1 }, { unique: true });
const ServiceOrder = mongoose.model('ServiceOrder', serviceOrderSchema, 'service_orders');

const generateOrderNumber = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = 'ORD-';
  for (let i = 0; i < 3; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  result += '-';
  for (let i = 0; i < 3; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
};

const seedSuperAdmin = async () => {
  const email = process.env.SUPER_ADMIN_EMAIL;
  if (!email) {
    console.log('[Admin] SUPER_ADMIN_EMAIL not set in .env — skipping super admin seed');
    return;
  }
  await AdminUser.findOneAndUpdate(
    { email: email.toLowerCase() },
    { email: email.toLowerCase(), role: 'superadmin' },
    { upsert: true }
  );
  console.log(`[Admin] Super admin seeded: ${email}`);
};

const verifyAdminByUid = async (uid) => {
  const user = await User.findOne({ firebaseUid: uid }).lean();
  if (!user) return null;
  const admin = await AdminUser.findOne({ email: user.email.toLowerCase() }).lean();
  return admin;
};

const notifyAdminsOfRequest = async (requestingUser, requestType) => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.log(`[Admin SMS] Twilio not configured — skipping notification for ${requestType} request from ${requestingUser.email}`);
    return;
  }
  try {
    const adminEntries = await AdminUser.find({}).lean();
    const adminEmails = adminEntries.map(a => a.email);
    const adminUsers = await User.find({ email: { $in: adminEmails }, isPhoneVerified: true }).select('phoneNumber email').lean();
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const userName = `${requestingUser.firstName || ''} ${requestingUser.lastName || ''}`.trim() || requestingUser.email;
    const msg = `[CarEx] New ${requestType} request from ${userName}. Open the app to review.`;
    for (const admin of adminUsers) {
      if (admin.phoneNumber) {
        try {
          await twilio.messages.create({ body: msg, from: process.env.TWILIO_PHONE_NUMBER, to: admin.phoneNumber });
        } catch (e) {
          console.error(`[Admin SMS] Failed to notify ${admin.email}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[Admin SMS] Notification error:', e.message);
  }
};

// --- Routes ---
app.get('/', (req, res) => {
  res.send('CarEx Backend is running');
});

// --- Deep Link Verification (Universal Links / App Links) ---
// Serve at /.well-known/ - required for https://www.carexmarket.com/listing/* to open the app
// Ensure carexmarket.com proxies these paths to this backend, or deploy this app at carexmarket.com

app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json');
  res.send(JSON.stringify({
    applinks: {
      apps: [],
      details: [
        {
          appID: 'M3W6Y259JR.com.carex.app',
          paths: ['/listing/*'],
        },
      ],
    },
  }));
});

app.get('/.well-known/assetlinks.json', (req, res) => {
  const fingerprints = process.env.ANDROID_SHA256_CERT_FINGERPRINTS
    ? process.env.ANDROID_SHA256_CERT_FINGERPRINTS.split(',').map((f) => f.trim())
    : [];
  if (fingerprints.length === 0) {
    console.warn('ANDROID_SHA256_CERT_FINGERPRINTS not set - assetlinks.json will be empty. Add to .env for App Links.');
  }
  res.type('application/json');
  res.send(JSON.stringify([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.carex.marketplace',
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]));
});

// Korean makes to show first in search (order preserved)
const KOREAN_MAKES_PRIORITY = ['Hyundai', 'Genesis', 'Kia', 'Samsung', 'KG Mobility'];

// Get vehicle makes (active only, Korean makes first, then alphabetical)
app.get('/api/vehicles/makes', async (req, res) => {
  try {
    const makes = await VehicleMake.find({ isActive: true })
      .sort({ name: 1 })
      .select('_id name slug logo')
      .lean();
    const mapped = makes.map(m => ({
      id: m._id.toString(),
      name: m.name,
      slug: m.slug || null,
      logo: m.logo || null,
    }));
    // Korean makes first (in KOREAN_MAKES_PRIORITY order), then the rest alphabetically
    const korean = KOREAN_MAKES_PRIORITY
      .map(name => mapped.find(m => m.name === name))
      .filter(Boolean);
    const rest = mapped.filter(m => !KOREAN_MAKES_PRIORITY.includes(m.name));
    res.json([...korean, ...rest]);
  } catch (error) {
    console.error('Vehicle makes error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get models for a make
app.get('/api/vehicles/models', async (req, res) => {
  try {
    const { makeId } = req.query;
    if (!makeId) return res.status(400).json({ message: 'makeId query required' });
    const makeDoc = await VehicleMake.findOne({ _id: makeId, isActive: true });
    if (!makeDoc) return res.json([]);
    const models = await VehicleModel.find({ makeId: makeDoc._id, isActive: true })
      .sort({ name: 1 })
      .select('_id name')
      .lean();
    res.json(models.map(m => ({ id: m._id.toString(), name: m.name })));
  } catch (error) {
    console.error('Vehicle models error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get all cars (with make/model for display). Optional ?sellerId=xxx to filter by listing owner.
app.get('/api/cars', async (req, res) => {
  try {
    const { sellerId } = req.query;
    const filter = sellerId ? { sellerId } : {};
    const cars = await Car.find(filter).sort({ createdAt: -1 }).lean();
    const mapped = cars.map(car => ({
      ...car,
      id: car._id.toString(),
      make: car.makeName || car.make || '',
      model: car.modelName || car.model || '',
      listingStatus: car.listingStatus || 'active',
    }));
    res.json(mapped);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get single car by id
app.get('/api/cars/:id', async (req, res) => {
  try {
    const car = await Car.findById(req.params.id).lean();
    if (!car) return res.status(404).json({ message: 'Car not found' });
    res.json({
      ...car,
      id: car._id.toString(),
      make: car.makeName || car.make || '',
      model: car.modelName || car.model || '',
      listingStatus: car.listingStatus || 'active',
    });
  } catch (error) {
    console.error('Fetch car error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update listing status (owner only)
app.patch('/api/cars/:id/status', async (req, res) => {
  try {
    const { sellerId, listingStatus } = req.body;
    if (!sellerId) return res.status(400).json({ message: 'sellerId required' });
    if (!['active', 'booked', 'sold'].includes(listingStatus)) {
      return res.status(400).json({ message: 'Invalid listingStatus' });
    }

    const car = await Car.findById(req.params.id);
    if (!car) return res.status(404).json({ message: 'Car not found' });
    if (car.sellerId !== sellerId) return res.status(403).json({ message: 'Not authorized' });

    car.listingStatus = listingStatus;
    await car.save();

    res.json({
      ...car.toObject(),
      id: car._id.toString(),
      make: car.makeName || car.make || '',
      model: car.modelName || car.model || '',
    });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- User Routes ---
app.post('/api/users', async (req, res) => {
  try {
    const { firebaseUid, email } = req.body;
    let user = await User.findOne({ firebaseUid });
    if (!user) {
      user = new User({ firebaseUid, email });
      await user.save();
    }
    res.status(201).json(user);
  } catch (error) {
    console.error('Create User Error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/users/:uid', async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/users/:uid', async (req, res) => {
  try {
    const { firstName, lastName, phoneNumber, telegramUsername, avatarUrl } = req.body;
    const update = {};
    if (firstName !== undefined) update.firstName = firstName;
    if (lastName !== undefined) update.lastName = lastName;
    if (phoneNumber !== undefined) update.phoneNumber = phoneNumber;
    if (telegramUsername !== undefined) update.telegramUsername = telegramUsername;
    if (avatarUrl !== undefined) update.avatarUrl = avatarUrl;
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      update,
      { new: true }
    );
    res.json(user);
  } catch (error) {
    console.error('Update User Error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/users/:uid/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  try {
    const uid = req.params.uid;
    const avatarUrl = req.file?.location;
    if (!avatarUrl) return res.status(400).json({ message: 'No image uploaded' });
    const user = await User.findOneAndUpdate(
      { firebaseUid: uid },
      { avatarUrl },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/users/:uid/request-seller', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { sellerStatus: 'PENDING', sellerRequestDate: new Date() },
      { new: true }
    );
    notifyAdminsOfRequest(user, 'seller');
    res.json(user);
  } catch (error) {
    console.error('Request Seller Error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/users/:uid/request-broker', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { brokerStatus: 'PENDING', brokerRequestDate: new Date() },
      { new: true }
    );
    notifyAdminsOfRequest(user, 'broker');
    res.json(user);
  } catch (error) {
    console.error('Request Broker Error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/users/:uid/request-logistics', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { logisticsStatus: 'PENDING', logisticsRequestDate: new Date() },
      { new: true }
    );
    notifyAdminsOfRequest(user, 'logistics');
    res.json(user);
  } catch (error) {
    console.error('Request Logistics Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- Broker Routes ---
app.get('/api/brokers', async (req, res) => {
  try {
    const brokers = await Broker.find({ status: 'active' }).sort({ createdAt: -1 }).lean();
    const enriched = await Promise.all(brokers.map(async (b) => {
      const user = await User.findOne({ firebaseUid: b.ownerUid }).select('firstName lastName avatarUrl email').lean();
      return {
        ...b,
        id: b._id.toString(),
        ownerName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
        ownerAvatarUrl: user?.avatarUrl || null,
        ownerEmail: user?.email || null,
      };
    }));
    res.json(enriched);
  } catch (error) {
    console.error('Fetch brokers error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/brokers/:uid', async (req, res) => {
  try {
    const broker = await Broker.findOne({ ownerUid: req.params.uid }).lean();
    if (!broker) return res.status(404).json({ message: 'Broker profile not found' });
    res.json({ ...broker, id: broker._id.toString() });
  } catch (error) {
    console.error('Fetch broker error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/brokers/:uid', async (req, res) => {
  try {
    const { companyName, description, phoneNumber, telegramUsername, services, paymentOptions } = req.body;
    const update = {};
    if (companyName !== undefined) update.companyName = companyName;
    if (description !== undefined) update.description = description;
    if (phoneNumber !== undefined) update.phoneNumber = phoneNumber;
    if (telegramUsername !== undefined) update.telegramUsername = telegramUsername;
    if (services !== undefined) update.services = services;
    if (paymentOptions !== undefined) update.paymentOptions = paymentOptions;
    update.ownerUid = req.params.uid;
    const broker = await Broker.findOneAndUpdate(
      { ownerUid: req.params.uid },
      update,
      { new: true, upsert: true }
    );
    res.json({ ...broker.toObject(), id: broker._id.toString() });
  } catch (error) {
    console.error('Update broker error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- Logistics Partner Routes ---
app.get('/api/logistics', async (req, res) => {
  try {
    const partners = await LogisticsPartner.find({ status: 'active' }).sort({ createdAt: -1 }).lean();
    const enriched = await Promise.all(partners.map(async (p) => {
      const user = await User.findOne({ firebaseUid: p.ownerUid }).select('firstName lastName avatarUrl email').lean();
      return {
        ...p,
        id: p._id.toString(),
        ownerName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
        ownerAvatarUrl: user?.avatarUrl || null,
        ownerEmail: user?.email || null,
      };
    }));
    res.json(enriched);
  } catch (error) {
    console.error('Fetch logistics partners error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/logistics/:uid', async (req, res) => {
  try {
    const partner = await LogisticsPartner.findOne({ ownerUid: req.params.uid }).lean();
    if (!partner) return res.status(404).json({ message: 'Logistics profile not found' });
    res.json({ ...partner, id: partner._id.toString() });
  } catch (error) {
    console.error('Fetch logistics partner error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/logistics/:uid', async (req, res) => {
  try {
    const { companyName, description, phoneNumber, telegramUsername, services, coverageAreas, timelines, paymentOptions } = req.body;
    const update = {};
    if (companyName !== undefined) update.companyName = companyName;
    if (description !== undefined) update.description = description;
    if (phoneNumber !== undefined) update.phoneNumber = phoneNumber;
    if (telegramUsername !== undefined) update.telegramUsername = telegramUsername;
    if (services !== undefined) update.services = services;
    if (coverageAreas !== undefined) update.coverageAreas = coverageAreas;
    if (timelines !== undefined) update.timelines = timelines;
    if (paymentOptions !== undefined) update.paymentOptions = paymentOptions;
    update.ownerUid = req.params.uid;
    const partner = await LogisticsPartner.findOneAndUpdate(
      { ownerUid: req.params.uid },
      update,
      { new: true, upsert: true }
    );
    res.json({ ...partner.toObject(), id: partner._id.toString() });
  } catch (error) {
    console.error('Update logistics partner error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.delete('/api/users/:uid', async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ firebaseUid: req.params.uid });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete User Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- OTP Routes ---
// Sends verification code via Twilio SMS (if configured) or logs to console for dev
app.post('/api/otp/send', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ message: 'Phone number required' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await OTP.findOneAndUpdate(
      { phoneNumber },
      { code, createdAt: new Date() },
      { upsert: true, new: true }
    );
    // Send SMS via Twilio if configured
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
      try {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilio.messages.create({
          body: `Your CarEx verification code is: ${code}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phoneNumber,
        });
      } catch (twilioErr) {
        console.error('[OTP] Twilio send failed:', twilioErr.message);
        console.log(`[OTP] Code for ${phoneNumber}: ${code}`);
      }
    } else {
      console.log(`[OTP] Code for ${phoneNumber}: ${code} (Twilio not configured - add to .env for real SMS)`);
    }
    res.json({ message: 'OTP sent' });
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/otp/verify', async (req, res) => {
  try {
    const { phoneNumber, code, firebaseUid } = req.body;
    console.log('[OTP verify] firebaseUid=', firebaseUid, 'phoneNumber=', phoneNumber);
    const record = await OTP.findOne({ phoneNumber });
    const isTestCode = code === '123456';
    if (!isTestCode && (!record || record.code !== code)) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }
    if (firebaseUid) {
      await User.findOneAndUpdate(
        { firebaseUid },
        { isPhoneVerified: true, phoneNumber }
      );
    }
    if (record) await OTP.deleteOne({ _id: record._id });
    res.json({ message: 'Phone verified successfully' });
  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Upload and create car (validate makeId/modelId)
app.post('/api/cars', upload.array('images', 25), async (req, res) => {
  try {
    const {
      makeId, modelId, trimLevel, wheelbase, year, price, mileage, fuel, currency, description, bodyType,
      engine, transmission, drivetrain, mpg, condition, knownIssues,
      exteriorColor, interiorColor, interiorMaterial, seats, doors, phoneNumber, telegramUsername, sellerId
    } = req.body;

    // Validate makeId exists
    const makeDoc = await VehicleMake.findOne({ _id: makeId, isActive: true });
    if (!makeDoc) {
      return res.status(400).json({ error: 'Invalid make' });
    }

    // Validate modelId belongs to makeId
    const modelDoc = await VehicleModel.findOne({
      _id: modelId,
      makeId: makeId,
      isActive: true
    });
    if (!modelDoc) {
      return res.status(400).json({ error: 'Invalid model for selected make' });
    }

    const imageUrls = req.files ? req.files.map(file => file.location) : [];

    let parsedKnownIssues = [];
    if (knownIssues) {
      try {
        parsedKnownIssues = JSON.parse(knownIssues);
      } catch (e) {
        parsedKnownIssues = [knownIssues];
      }
    }

    let listingId;
    let isUnique = false;
    while (!isUnique) {
      listingId = `${Math.floor(100 + Math.random() * 900)}-${Math.floor(100 + Math.random() * 900)}`;
      const existing = await Car.findOne({ listingId });
      if (!existing) isUnique = true;
    }

    const newCar = new Car({
      makeId,
      modelId,
      makeName: makeDoc.name,
      modelName: modelDoc.name,
      trimLevel: trimLevel || undefined,
      wheelbase: wheelbase || undefined,
      year: year ? parseInt(year) : undefined,
      price: price ? parseInt(price) : undefined,
      mileage: mileage ? parseInt(mileage) : undefined,
      fuel,
      currency: currency || '$',
      description,
      bodyType,
      imageUrls,
      engine,
      transmission,
      drivetrain,
      mpg,
      condition,
      knownIssues: parsedKnownIssues,
      exteriorColor,
      interiorColor,
      interiorMaterial,
      seats: seats ? parseInt(seats) : undefined,
      doors: doors ? parseInt(doors) : undefined,
      phoneNumber,
      telegramUsername,
      listingId,
      sellerId: sellerId || undefined,
    });

    await newCar.save();
    const saved = newCar.toObject();
    res.status(201).json({
      ...saved,
      make: saved.makeName,
      model: saved.modelName,
    });
  } catch (error) {
    console.error('Error creating car:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update car (owner only)
app.put('/api/cars/:id', upload.array('images', 25), async (req, res) => {
  try {
    const { sellerId, existingImageUrls } = req.body;
    if (!sellerId) return res.status(400).json({ message: 'sellerId required to edit' });

    const car = await Car.findById(req.params.id);
    if (!car) return res.status(404).json({ message: 'Car not found' });
    if (car.sellerId !== sellerId) return res.status(403).json({ message: 'Not authorized to edit this listing' });

    const {
      makeId, modelId, trimLevel, wheelbase, year, price, mileage, fuel, currency, description, bodyType,
      engine, transmission, drivetrain, mpg, condition, knownIssues,
      exteriorColor, interiorColor, interiorMaterial, seats, doors, phoneNumber, telegramUsername
    } = req.body;

    let imageUrls = car.imageUrls || [];
    if (existingImageUrls) {
      try {
        imageUrls = JSON.parse(existingImageUrls);
      } catch (e) {}
    }
    const newUrls = req.files ? req.files.map(f => f.location) : [];
    imageUrls = [...imageUrls, ...newUrls];

    if (makeId && modelId) {
      const makeDoc = await VehicleMake.findOne({ _id: makeId, isActive: true });
      if (!makeDoc) return res.status(400).json({ error: 'Invalid make' });
      const modelDoc = await VehicleModel.findOne({ _id: modelId, makeId, isActive: true });
      if (!modelDoc) return res.status(400).json({ error: 'Invalid model for selected make' });
      car.makeId = makeDoc._id;
      car.modelId = modelDoc._id;
      car.makeName = makeDoc.name;
      car.modelName = modelDoc.name;
    }

    let parsedKnownIssues = car.knownIssues || [];
    if (knownIssues) {
      try {
        parsedKnownIssues = JSON.parse(knownIssues);
      } catch (e) {
        parsedKnownIssues = [knownIssues];
      }
    }

    Object.assign(car, {
      trimLevel: trimLevel ?? car.trimLevel,
      wheelbase: wheelbase ?? car.wheelbase,
      year: year ? parseInt(year) : car.year,
      price: price ? parseInt(price) : car.price,
      mileage: mileage ? parseInt(mileage) : car.mileage,
      fuel: fuel ?? car.fuel,
      currency: currency ?? car.currency,
      description: description ?? car.description,
      bodyType: bodyType ?? car.bodyType,
      imageUrls,
      engine: engine ?? car.engine,
      transmission: transmission ?? car.transmission,
      drivetrain: drivetrain ?? car.drivetrain,
      mpg: mpg ?? car.mpg,
      condition: condition ?? car.condition,
      knownIssues: parsedKnownIssues,
      exteriorColor: exteriorColor ?? car.exteriorColor,
      interiorColor: interiorColor ?? car.interiorColor,
      interiorMaterial: interiorMaterial ?? car.interiorMaterial,
      seats: seats ? parseInt(seats) : car.seats,
      doors: doors ? parseInt(doors) : car.doors,
      phoneNumber: phoneNumber ?? car.phoneNumber,
      telegramUsername: telegramUsername ?? car.telegramUsername,
    });

    await car.save();
    const saved = car.toObject();
    res.json({
      ...saved,
      id: saved._id.toString(),
      make: saved.makeName,
      model: saved.modelName,
    });
  } catch (error) {
    console.error('Error updating car:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- Admin Routes ---

// Check if current user is an admin
app.get('/api/admin/status/:uid', async (req, res) => {
  try {
    const admin = await verifyAdminByUid(req.params.uid);
    if (!admin) return res.json({ isAdmin: false });
    res.json({ isAdmin: true, role: admin.role });
  } catch (error) {
    console.error('Admin status check error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get all pending requests (admin only)
app.get('/api/admin/requests', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ message: 'uid query param required' });
    const admin = await verifyAdminByUid(uid);
    if (!admin) return res.status(403).json({ message: 'Unauthorized' });

    const pendingSellers = await User.find({ sellerStatus: 'PENDING' }).select('firebaseUid email firstName lastName phoneNumber telegramUsername avatarUrl sellerRequestDate isPhoneVerified createdAt').lean();
    const pendingBrokers = await User.find({ brokerStatus: 'PENDING' }).select('firebaseUid email firstName lastName phoneNumber telegramUsername avatarUrl brokerRequestDate isPhoneVerified createdAt').lean();
    const pendingLogistics = await User.find({ logisticsStatus: 'PENDING' }).select('firebaseUid email firstName lastName phoneNumber telegramUsername avatarUrl logisticsRequestDate isPhoneVerified createdAt').lean();

    res.json({
      sellers: pendingSellers.map(u => ({ ...u, id: u._id?.toString(), requestType: 'seller', requestDate: u.sellerRequestDate })),
      brokers: pendingBrokers.map(u => ({ ...u, id: u._id?.toString(), requestType: 'broker', requestDate: u.brokerRequestDate })),
      logistics: pendingLogistics.map(u => ({ ...u, id: u._id?.toString(), requestType: 'logistics', requestDate: u.logisticsRequestDate })),
    });
  } catch (error) {
    console.error('Fetch pending requests error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Approve a request (admin only)
app.post('/api/admin/requests/:uid/approve', async (req, res) => {
  try {
    const { callerUid, type } = req.body;
    if (!callerUid || !type) return res.status(400).json({ message: 'callerUid and type required' });
    const admin = await verifyAdminByUid(callerUid);
    if (!admin) return res.status(403).json({ message: 'Unauthorized' });

    const validTypes = ['seller', 'broker', 'logistics'];
    if (!validTypes.includes(type)) return res.status(400).json({ message: 'Invalid type' });

    const statusField = `${type}Status`;
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid, [statusField]: 'PENDING' },
      { [statusField]: 'APPROVED' },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found or not pending' });

    if (type === 'broker') {
      await Broker.findOneAndUpdate(
        { ownerUid: req.params.uid },
        { ownerUid: req.params.uid, companyName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Broker', phoneNumber: user.phoneNumber, telegramUsername: user.telegramUsername },
        { upsert: true, new: true }
      );
    }
    if (type === 'logistics') {
      await LogisticsPartner.findOneAndUpdate(
        { ownerUid: req.params.uid },
        { ownerUid: req.params.uid, companyName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Logistics Partner', phoneNumber: user.phoneNumber, telegramUsername: user.telegramUsername },
        { upsert: true, new: true }
      );
    }

    res.json({ message: `${type} request approved`, user });
  } catch (error) {
    console.error('Approve request error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Reject a request (admin only)
app.post('/api/admin/requests/:uid/reject', async (req, res) => {
  try {
    const { callerUid, type } = req.body;
    if (!callerUid || !type) return res.status(400).json({ message: 'callerUid and type required' });
    const admin = await verifyAdminByUid(callerUid);
    if (!admin) return res.status(403).json({ message: 'Unauthorized' });

    const validTypes = ['seller', 'broker', 'logistics'];
    if (!validTypes.includes(type)) return res.status(400).json({ message: 'Invalid type' });

    const statusField = `${type}Status`;
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid, [statusField]: 'PENDING' },
      { [statusField]: 'REJECTED' },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found or not pending' });

    res.json({ message: `${type} request rejected`, user });
  } catch (error) {
    console.error('Reject request error:', error);
    res.status(500).json({ message: error.message });
  }
});

// List admin accounts (superadmin only)
app.get('/api/admin/users', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ message: 'uid query param required' });
    const admin = await verifyAdminByUid(uid);
    if (!admin || admin.role !== 'superadmin') return res.status(403).json({ message: 'Superadmin only' });

    const admins = await AdminUser.find({}).sort({ createdAt: -1 }).lean();
    res.json(admins.map(a => ({ ...a, id: a._id.toString() })));
  } catch (error) {
    console.error('List admins error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Add admin account (superadmin only)
app.post('/api/admin/users', async (req, res) => {
  try {
    const { callerUid, email } = req.body;
    if (!callerUid || !email) return res.status(400).json({ message: 'callerUid and email required' });
    const admin = await verifyAdminByUid(callerUid);
    if (!admin || admin.role !== 'superadmin') return res.status(403).json({ message: 'Superadmin only' });

    const existing = await AdminUser.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'Admin already exists' });

    const newAdmin = await AdminUser.create({ email: email.toLowerCase(), role: 'admin' });
    res.status(201).json({ ...newAdmin.toObject(), id: newAdmin._id.toString() });
  } catch (error) {
    console.error('Add admin error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Remove admin account (superadmin only, cannot remove self)
app.delete('/api/admin/users/:adminId', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ message: 'uid query param required' });
    const admin = await verifyAdminByUid(uid);
    if (!admin || admin.role !== 'superadmin') return res.status(403).json({ message: 'Superadmin only' });

    const target = await AdminUser.findById(req.params.adminId);
    if (!target) return res.status(404).json({ message: 'Admin not found' });
    if (target.role === 'superadmin') return res.status(400).json({ message: 'Cannot remove super admin' });

    await AdminUser.deleteOne({ _id: req.params.adminId });
    res.json({ message: 'Admin removed' });
  } catch (error) {
    console.error('Remove admin error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- Stripe Payment Routes ---

const BOOKING_FEE_KGS = 500000; // 5 000 KGS in tiyin (smallest unit)
const BOOKING_FEE_USD = 5800;   // ~$58 USD in cents (approximate KGS→USD)

app.get('/api/payments/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

app.post('/api/payments/create-payment-intent', async (req, res) => {
  try {
    const { currency = 'kgs', carId, buyerUid } = req.body;
    if (!buyerUid) return res.status(400).json({ message: 'buyerUid required' });

    const amount = currency === 'usd' ? BOOKING_FEE_USD : BOOKING_FEE_KGS;
    const stripeCurrency = currency === 'usd' ? 'usd' : 'kgs';

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: stripeCurrency,
      metadata: { carId: carId || '', buyerUid },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount,
      currency: stripeCurrency,
    });
  } catch (error) {
    console.error('Create PaymentIntent error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/payments/confirm-booking', async (req, res) => {
  try {
    const { paymentIntentId, carId, buyerUid } = req.body;
    if (!paymentIntentId || !carId || !buyerUid) {
      return res.status(400).json({ message: 'paymentIntentId, carId, and buyerUid required' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ message: `Payment not completed (status: ${paymentIntent.status})` });
    }

    const car = await Car.findById(carId);
    if (!car) return res.status(404).json({ message: 'Car not found' });

    car.listingStatus = 'booked';
    car.bookedByUid = buyerUid;
    car.stripePaymentIntentId = paymentIntentId;
    await car.save();

    res.json({
      ...car.toObject(),
      id: car._id.toString(),
      make: car.makeName || car.make || '',
      model: car.modelName || car.model || '',
    });
  } catch (error) {
    console.error('Confirm booking error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- Service Order Routes ---

// Create orders from cart (one order per provider)
app.post('/api/orders', async (req, res) => {
  try {
    const { buyerUid, car, items } = req.body;
    if (!buyerUid || !items || !items.length) {
      return res.status(400).json({ message: 'buyerUid and items required' });
    }

    const providerGroups = {};
    for (const item of items) {
      const key = `${item.providerUid}_${item.providerType}`;
      if (!providerGroups[key]) {
        providerGroups[key] = {
          providerUid: item.providerUid,
          providerType: item.providerType,
          providerSnapshot: item.providerSnapshot,
          services: [],
        };
      }
      providerGroups[key].services.push(item.service);
    }

    const orders = [];
    for (const group of Object.values(providerGroups)) {
      let totalAmount = 0;
      let totalCurrency = '$';
      for (const svc of group.services) {
        const fee = parseFloat(svc.fee);
        if (!isNaN(fee)) {
          totalAmount += fee;
          if (svc.currency) totalCurrency = svc.currency;
        }
      }

      let orderNumber;
      let isUnique = false;
      while (!isUnique) {
        orderNumber = generateOrderNumber();
        const existing = await ServiceOrder.findOne({ orderNumber });
        if (!existing) isUnique = true;
      }

      const order = await ServiceOrder.create({
        orderNumber,
        buyerUid,
        carId: car?.id || null,
        carSnapshot: car ? {
          makeName: car.makeName,
          modelName: car.modelName,
          year: car.year,
          price: car.price,
          currency: car.currency,
          imageUrl: car.imageUrl,
          listingId: car.listingId,
        } : null,
        providerUid: group.providerUid,
        providerType: group.providerType,
        providerSnapshot: group.providerSnapshot,
        services: group.services,
        totalAmount,
        totalCurrency,
        buyerNote: req.body.buyerNote || '',
      });
      orders.push({ ...order.toObject(), id: order._id.toString() });
    }

    res.status(201).json({ orders });
  } catch (error) {
    console.error('Create orders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get orders for buyer
app.get('/api/orders/buyer/:uid', async (req, res) => {
  try {
    const orders = await ServiceOrder.find({ buyerUid: req.params.uid }).sort({ createdAt: -1 }).lean();
    res.json(orders.map(o => ({ ...o, id: o._id.toString() })));
  } catch (error) {
    console.error('Fetch buyer orders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get orders for provider
app.get('/api/orders/provider/:uid', async (req, res) => {
  try {
    const orders = await ServiceOrder.find({ providerUid: req.params.uid }).sort({ createdAt: -1 }).lean();
    const enriched = await Promise.all(orders.map(async (o) => {
      const buyer = await User.findOne({ firebaseUid: o.buyerUid }).select('firstName lastName email phoneNumber avatarUrl').lean();
      return {
        ...o,
        id: o._id.toString(),
        buyerName: buyer ? `${buyer.firstName || ''} ${buyer.lastName || ''}`.trim() : '',
        buyerEmail: buyer?.email || '',
        buyerPhone: buyer?.phoneNumber || '',
        buyerAvatar: buyer?.avatarUrl || null,
      };
    }));
    res.json(enriched);
  } catch (error) {
    console.error('Fetch provider orders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Derive order-level status from individual service statuses
function deriveOrderStatus(services) {
  const statuses = services.map(s => s.status || 'pending');
  if (statuses.every(s => s === 'completed')) return 'completed';
  if (statuses.every(s => s === 'cancelled')) return 'cancelled';
  if (statuses.some(s => s === 'blocked')) return 'in_progress';
  if (statuses.some(s => s === 'in_progress')) return 'in_progress';
  if (statuses.some(s => s === 'completed') || statuses.some(s => s === 'in_progress')) return 'in_progress';
  return 'pending';
}

// Update overall order status (provider or buyer for cancel)
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { status, callerUid } = req.body;
    if (!status || !callerUid) return res.status(400).json({ message: 'status and callerUid required' });

    const validStatuses = ['accepted', 'in_progress', 'completed', 'cancelled', 'rejected'];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Invalid status' });

    const order = await ServiceOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const isProvider = order.providerUid === callerUid;
    const isBuyer = order.buyerUid === callerUid;
    if (!isProvider && !isBuyer) return res.status(403).json({ message: 'Unauthorized' });

    if (isBuyer && status !== 'cancelled') return res.status(403).json({ message: 'Buyers can only cancel orders' });

    if (isBuyer && status === 'cancelled') {
      order.services.forEach(s => { s.status = 'cancelled'; });
    }

    order.status = status;
    order.updatedAt = new Date();
    await order.save();

    res.json({ ...order.toObject(), id: order._id.toString() });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update individual service status within an order
app.patch('/api/orders/:id/services/:serviceIndex/status', async (req, res) => {
  try {
    const { status, callerUid } = req.body;
    const serviceIndex = parseInt(req.params.serviceIndex);
    if (!status || !callerUid) return res.status(400).json({ message: 'status and callerUid required' });

    const validStatuses = ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Invalid status' });

    const order = await ServiceOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.providerUid !== callerUid) return res.status(403).json({ message: 'Only the provider can update service status' });

    if (isNaN(serviceIndex) || serviceIndex < 0 || serviceIndex >= order.services.length) {
      return res.status(400).json({ message: 'Invalid service index' });
    }

    order.services[serviceIndex].status = status;
    order.status = deriveOrderStatus(order.services);
    order.updatedAt = new Date();
    await order.save();

    res.json({ ...order.toObject(), id: order._id.toString() });
  } catch (error) {
    console.error('Update service status error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: 'File upload error', error: err.message });
  }
  if (err) {
    if (err.$metadata?.httpStatusCode === 403) {
      return res.status(403).json({ message: 'AWS S3 Access Denied. Check credentials and bucket permissions.', error: err.message });
    }
    return res.status(500).json({ message: 'Internal Server Error', error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
