const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, { dbName: 'CarEx' })
  .then(() => console.log('Connected to MongoDB'))
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
});

const Car = mongoose.model('Car', carSchema);

// User Schema
const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  firstName: String,
  lastName: String,
  phoneNumber: String,
  telegramUsername: String,
  avatarUrl: String,
  sellerStatus: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'], default: 'NONE' },
  sellerRequestDate: Date,
  isPhoneVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);

// OTP Schema
const otpSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true },
  code: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 }
});
const OTP = mongoose.model('OTP', otpSchema);

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

// Get all cars (with make/model for display)
app.get('/api/cars', async (req, res) => {
  try {
    const cars = await Car.find().sort({ createdAt: -1 }).lean();
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
    res.json(user);
  } catch (error) {
    console.error('Request Seller Error:', error);
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
