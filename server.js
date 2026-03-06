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
      // Use bodyType from body if available, otherwise 'misc'
      const folder = req.body.bodyType ? req.body.bodyType.toLowerCase() : 'misc';
      cb(null, `${folder}/${Date.now().toString()}-${file.originalname}`);
    },
  }),
});

// Car Schema
const carSchema = new mongoose.Schema({
  make: String,
  model: String,
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
});

const Car = mongoose.model('Car', carSchema);

// Vehicle Make/Model Catalog (for search dropdown, no misspellings)
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

// User Schema
const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  firstName: String,
  lastName: String,
  phoneNumber: String,
  telegramUsername: String,
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
  createdAt: { type: Date, default: Date.now, expires: 300 } // Expires in 5 minutes
});
const OTP = mongoose.model('OTP', otpSchema);

// Routes
app.get('/', (req, res) => {
  res.send('CarEx Backend is running');
});

// Get all vehicle makes (alphabetical)
app.get('/api/vehicle-makes', async (req, res) => {
  try {
    const makes = await VehicleMake.find().sort({ name: 1 }).select('name');
    res.json(makes.map(m => m.name));
  } catch (error) {
    console.error('Vehicle makes error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get models for a make
app.get('/api/vehicle-models', async (req, res) => {
  try {
    const { make } = req.query;
    if (!make) return res.status(400).json({ message: 'make query required' });
    const makeDoc = await VehicleMake.findOne({ name: { $regex: new RegExp(`^${String(make).trim()}$`, 'i') } });
    if (!makeDoc) return res.json([]);
    const models = await VehicleModel.find({ makeId: makeDoc._id }).sort({ name: 1 }).select('name');
    res.json(models.map(m => m.name));
  } catch (error) {
    console.error('Vehicle models error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get all cars
app.get('/api/cars', async (req, res) => {
  try {
    const cars = await Car.find().sort({ createdAt: -1 });
    res.json(cars);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- User Routes ---

// Create User (Called after Firebase Signup)
app.post('/api/users', async (req, res) => {
  try {
    const { firebaseUid, email } = req.body;
    // Check if exists
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

// Get User Profile
app.get('/api/users/:uid', async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update User Profile
app.put('/api/users/:uid', async (req, res) => {
  try {
    const { firstName, lastName, phoneNumber, telegramUsername } = req.body;
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { firstName, lastName, phoneNumber, telegramUsername },
      { new: true } // Return updated doc
    );
    res.json(user);
  } catch (error) {
    console.error('Update User Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Request Seller Status
app.post('/api/users/:uid/request-seller', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      {
        sellerStatus: 'PENDING',
        sellerRequestDate: new Date()
      },
      { new: true }
    );
    res.json(user);
  } catch (error) {
    console.error('Request Seller Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Delete User
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

// --- End User Routes ---

// --- OTP Routes ---

// Send OTP
app.post('/api/otp/send', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ message: 'Phone number required' });

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Save to DB (upsert)
    await OTP.findOneAndUpdate(
      { phoneNumber },
      { code, createdAt: new Date() },
      { upsert: true, new: true }
    );

    // In a real app, integrate Twilio/SNS here. #TODO
    // For now, log to console for testing/demo.
    console.log(`[OTP] Code for ${phoneNumber}: ${code}`);

    res.json({ message: 'OTP sent' });
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Verify OTP
app.post('/api/otp/verify', async (req, res) => {
  try {
    const { phoneNumber, code, firebaseUid } = req.body;

    // Check OTP
    const record = await OTP.findOne({ phoneNumber });

    // Backdoor for App Store Review / Testing (Code: 123456)
    const isTestCode = code === '123456';

    if (!isTestCode && (!record || record.code !== code)) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    // Mark user as verified
    if (firebaseUid) {
      await User.findOneAndUpdate(
        { firebaseUid },
        { isPhoneVerified: true, phoneNumber } // Ensure phone is synced
      );
    }

    // Clean up OTP
    if (record) await OTP.deleteOne({ _id: record._id });

    res.json({ message: 'Phone verified successfully' });
  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({ message: error.message });
  }
});

// --- End OTP Routes ---

// Upload and create car
app.post('/api/cars', upload.array('images', 25), async (req, res) => {
  try {
    const {
      make, model, year, price, mileage, fuel, currency, description, bodyType,
      engine, transmission, drivetrain, mpg, condition, knownIssues,
      exteriorColor, interiorColor, interiorMaterial, seats, doors, phoneNumber, telegramUsername
    } = req.body;

    // Map uploaded files to locations
    const imageUrls = req.files ? req.files.map(file => file.location) : [];

    // Parse knownIssues from JSON string if sent as such (multipart/form-data sends arrays as strings sometimes)
    let parsedKnownIssues = [];
    if (knownIssues) {
      try {
        parsedKnownIssues = JSON.parse(knownIssues);
      } catch (e) {
        parsedKnownIssues = [knownIssues];
      }
    }

    // Generate unique Listing ID
    let listingId;
    let isUnique = false;
    while (!isUnique) {
      listingId = `${Math.floor(100 + Math.random() * 900)}-${Math.floor(100 + Math.random() * 900)}`;
      const existing = await Car.findOne({ listingId });
      if (!existing) isUnique = true;
    }

    const newCar = new Car({
      make, model, year, price, mileage, fuel,
      currency: currency || '$',
      description, bodyType, imageUrls,
      engine, transmission, drivetrain, mpg, condition,
      knownIssues: parsedKnownIssues,
      exteriorColor, interiorColor, interiorMaterial,
      seats, doors, phoneNumber, telegramUsername,
      listingId,
    });

    await newCar.save();
    res.status(201).json(newCar);
  } catch (error) {
    console.error('Error creating car:', error);
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
    // Check for AWS Access Denied
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

