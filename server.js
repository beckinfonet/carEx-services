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
mongoose.connect(process.env.MONGODB_URI)
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

// Routes
app.get('/', (req, res) => {
  res.send('CarEx Backend is running');
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

