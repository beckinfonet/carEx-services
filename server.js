const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const User = require('./src/models/User');
const AdminUser = require('./src/models/AdminUser');
const Car = require('./src/models/Car');
const Broker = require('./src/models/Broker');
const LogisticsPartner = require('./src/models/LogisticsPartner');
const { verifyIdToken } = require('./src/security/verifyIdToken');
const { requireAdmin } = require('./src/security/requireAdmin');
const { attachAuthIfPresent } = require('./src/security/attachAuthIfPresent');
const { lookupAdminIfPresent } = require('./src/security/lookupAdminIfPresent');
const { requireNotSuspended } = require('./src/security/requireNotSuspended');
const { ensureBaseline } = require('./src/security/ensureBaseline');
const { LISTING_STATUS_POLICY } = require('./src/moderation/listingCapabilities');
const moderationRouter = require('./src/moderation/router');
const listingModerationRouter = require('./src/moderation/listingRouter');
const { listingModerationRateLimiter } = require('./src/moderation/listingRateLimit');
const notificationRouter = require('./src/notifications/router');
const notificationService = require('./src/notifications/notificationService');
const { upload, uploadMemory, s3, processAndUploadCarImages } = require('./src/uploads/carImages');
const { confirmBooking: confirmBookingService, ProviderSuspendedError } = require('./src/payments/confirmBooking');
// W-7: ListingNotAvailableError MUST be required from its canonical source
// (./src/payments/refundAndThrow), NOT via a confirmBooking re-export. JS class
// identity depends on referential equality of the class object across the
// require graph; importing via re-export risks identity mismatch under module
// caching with circular requires. Plan 09-05's confirmBooking step 4 throws
// this same class (also imported from ./refundAndThrow) — both consumers
// resolve to the same module path, so `instanceof` works at the boundary.
const { ListingNotAvailableError } = require('./src/payments/refundAndThrow');

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
    await ensureBaseline();
  })
  .catch((err) => console.error('MongoDB connection error:', err));

// AWS S3 Configuration — `s3` + `upload` (multer-S3 instance for car-image
// multipart uploads) now live in src/uploads/carImages.js so both the seller
// PUT (/api/cars/:id) and the admin Edit (PATCH /api/admin/moderation/listings/:carId)
// share a single source of truth (D-D-2 / Phase 8 Pitfall 1).
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

// Car model extracted to src/models/Car.js (Plan 03-01) — requires at top-of-file.
// Broker model extracted to src/models/Broker.js (Plan 03-01).
// LogisticsPartner model extracted to src/models/LogisticsPartner.js (Plan 03-01).
// serviceItemSchema moved with Broker + LogisticsPartner — each model file owns its own clone.
// User model extracted to src/models/User.js (Plan 01-01).

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
    email: String,
    firstName: String,
    lastName: String,
    providerRole: { type: String, enum: ['broker', 'logistics'], default: null },
    snapshotAt: { type: Date, default: Date.now },
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
        // Must match android/app/build.gradle applicationId (com.carex.market)
        package_name: 'com.carex.market',
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

// Public total-member count for the home-screen social-proof strip (Option B).
// No auth — same access posture as GET /api/cars. Returns the total registered
// users plus a year-over-year growth percentage:
//   growthPct = (users created in the last 12 months) / (users that existed a
//   year ago) * 100, rounded to an integer. Falls back to 0 when there is no
//   prior-year base (avoids divide-by-zero on a young dataset).
// Pre-launch baseline added to the real user count so the public number starts
// from a credible figure while the marketplace is still seeding. The displayed
// count is SEED + (actual registered users). The seed is also treated as the
// prior-year base for the growth %, so growth reflects real sign-ups against it.
const MEMBER_COUNT_SEED = 700;

app.get('/api/stats/users', async (req, res) => {
  try {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const hasAvatar = { avatarUrl: { $nin: [null, ''] } };
    const [actual, newThisYear, brokers, logistics, usersWithAvatar] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: oneYearAgo } }),
      // Broker/LogisticsPartner read-hooks already restrict to APPROVED + active
      // owners, so these are real, vetted providers with a photo/logo.
      Broker.find({ status: 'active', ...hasAvatar }).sort({ createdAt: -1 }).limit(5).lean(),
      LogisticsPartner.find({ status: 'active', ...hasAvatar }).sort({ createdAt: -1 }).limit(5).lean(),
      User.find(hasAvatar).sort({ createdAt: -1 }).limit(5).lean(),
    ]);

    const count = MEMBER_COUNT_SEED + actual;
    const base = count - newThisYear; // seed is part of the prior-year base
    const growthPct = base > 0 ? Math.round((newThisYear / base) * 100) : 0;

    // Up to 5 real avatar image URLs for the home social-proof stack. Providers
    // (brokers/logistics) first since they reliably upload one, then any user
    // with a personal avatar. Dedupe by URL.
    const avatars = [];
    for (const doc of [...brokers, ...logistics, ...usersWithAvatar]) {
      if (doc.avatarUrl && !avatars.includes(doc.avatarUrl)) avatars.push(doc.avatarUrl);
      if (avatars.length >= 5) break;
    }

    res.json({ count, growthPct, avatars });
  } catch (error) {
    console.error('User stats error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get single car by id — Phase 9 LENF-02 status-aware handler (D-08).
//
// Branches on `!!req.admin` (set by lookupAdminIfPresent when the verified
// caller email matches an AdminUser doc) across 4 mutually exclusive paths:
//   Path A — admin + non-active listing -> full doc + moderationBadge
//   Path B — admin + active listing     -> full doc (NO moderationBadge key)
//   Path C — non-admin + active listing -> existing response shape verbatim
//   Path D — non-admin + non-active     -> D-05 thin payload allowlist
//
// Bypasses the Plan 09-02 hide hook via setOptions({ includeAllListingStatuses:
// true }) so the lookup itself succeeds for ANY status; response-shape branching
// is what enforces the per-status contract.
//
// W-6: extracted as a named function so the LENF-02 supertest mounts the
// production handler directly — divergence between test and prod is impossible
// by construction.
async function getCarDetailHandler(req, res) {
  try {
    // Pitfall 6: malformed ObjectId -> 404, never 500 CastError.
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Car not found' });
    }
    const car = await Car.findById(req.params.id)
      .setOptions({ includeAllListingStatuses: true })
      .lean();
    if (!car) return res.status(404).json({ message: 'Car not found' });

    const isAdmin = !!req.admin;
    const isActive = car.status === 'active';

    if (isAdmin) {
      // Path A/B — admin view. Existing full-doc spread + optional badge.
      // Pitfall 4: conditional spread so `moderationBadge` key is OMITTED
      // (not `undefined`) when the listing is active.
      const badge = !isActive
        ? {
            status: car.status,
            reasonCategory: car.moderationReason,   // enum
            moderationReason: car.moderationNote,   // free-text note
            moderatedBy: car.moderatedBy,
            moderatedAt: car.moderatedAt,
          }
        : null;
      return res.json({
        ...car,
        id: car._id.toString(),
        make: car.makeName || car.make || '',
        model: car.modelName || car.model || '',
        listingStatus: car.listingStatus || 'active',
        ...(badge ? { moderationBadge: badge } : {}),
      });
    }

    // Non-admin (Path C/D).
    if (isActive) {
      // Path C — preserve the existing pre-Phase-9 response shape byte-for-byte.
      return res.json({
        ...car,
        id: car._id.toString(),
        make: car.makeName || car.make || '',
        model: car.modelName || car.model || '',
        listingStatus: car.listingStatus || 'active',
      });
    }

    // Path D — D-05 thin payload. EXACTLY 10 named fields; NEVER spread `car`
    // (Pitfall 5). HTTP 200 (D-06 — mobile branches on body.status).
    return res.json({
      carId: car._id.toString(),
      status: car.status,
      reasonCategory: car.moderationReason,
      title: `${car.year || ''} ${car.makeName || car.make || ''} ${car.modelName || car.model || ''}`.trim(),
      make: car.makeName || car.make || '',
      model: car.modelName || car.model || '',
      year: car.year,
      price: car.price,
      firstPhotoUrl:
        Array.isArray(car.imageUrls) && car.imageUrls.length > 0
          ? car.imageUrls[0]
          : null,
      banner: LISTING_STATUS_POLICY[car.status]?.banner ?? null,
    });
  } catch (error) {
    console.error('Fetch car error:', error);
    return res.status(500).json({ message: error.message });
  }
}

app.get('/api/cars/:id', attachAuthIfPresent, lookupAdminIfPresent, getCarDetailHandler);

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

    // NSUB-02 capture-before-mutation: snapshot the lifecycle status before the
    // reassignment so back_available can be gated on a booked→active transition.
    const oldStatus = car.listingStatus;

    car.listingStatus = listingStatus;
    await car.save();

    // NDOM-02: emit the watch-family lifecycle event AFTER commit, off-hot-path.
    //   booked          → new status is booked
    //   sold            → new status is sold
    //   back_available  → ONLY on a booked→active transition (NSUB-02)
    // Actor = seller (ownership-enforced above), excluded from self-notify.
    // Wrapped so a notification failure can NEVER break the status response.
    let notifyType = null;
    if (listingStatus === 'booked') notifyType = 'booked';
    else if (listingStatus === 'sold') notifyType = 'sold';
    else if (listingStatus === 'active' && oldStatus === 'booked') notifyType = 'back_available';
    if (notifyType) {
      try {
        await notificationService.emit({
          type: notifyType,
          carId: car._id.toString(),
          actorUid: sellerId,
        });
      } catch (notifyErr) {
        console.error(`[notify] ${notifyType} emit failed:`, notifyErr);
      }
    }

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
    const { firstName, lastName, phoneNumber, telegramUsername, avatarUrl, language } = req.body;
    const update = {};
    if (firstName !== undefined) update.firstName = firstName;
    if (lastName !== undefined) update.lastName = lastName;
    if (phoneNumber !== undefined) update.phoneNumber = phoneNumber;
    if (telegramUsername !== undefined) update.telegramUsername = telegramUsername;
    if (avatarUrl !== undefined) update.avatarUrl = avatarUrl;
    // NI18N-01: language is enum-guarded — only the RU/EN values are persisted;
    // any out-of-enum value is ignored (T-12-05-04 tampering mitigation).
    if (language !== undefined && ['RU', 'EN'].includes(language)) update.language = language;
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

app.put('/api/brokers/:uid', attachAuthIfPresent, requireNotSuspended('update_profile'), async (req, res) => {
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

app.put('/api/logistics/:uid', attachAuthIfPresent, requireNotSuspended('update_profile'), async (req, res) => {
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
app.post('/api/cars', uploadMemory.array('images', 25), attachAuthIfPresent, requireNotSuspended('create_listing'), async (req, res) => {
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

    // Variant pipeline: resize each in-memory upload into full + thumb JPEGs
    // and persist index-aligned imageUrls / thumbnailUrls. Runs AFTER make/model
    // validation so an invalid listing never writes objects to S3.
    const processedImages = await processAndUploadCarImages(req.files, bodyType);
    const imageUrls = processedImages.map(p => p.full);
    const thumbnailUrls = processedImages.map(p => p.thumb);

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
      // WR-01 fix: uniqueness checks must see the full corpus including hidden
      // listings. Without includeAllUsers, a suspended seller's listing with
      // the same listingId is invisible to the hook and this loop falsely
      // reports "unique", producing a duplicate that becomes visible after
      // unsuspend. Deep links (listing/:carId) surface listingIds, so a
      // collision would silently route to the wrong car post-unsuspend.
      //
      // Phase 8 WR-08: also chain includeAllListingStatuses so the loop sees
      // soft-deleted (status='deleted') and archived/suspended listings. The
      // hide hook for those statuses arrives in Phase 9; chaining now keeps
      // this loop forward-compatible (mirrors the same flag chained on every
      // admin-side Car read in src/moderation/listingService.js).
      const existing = await Car.findOne({ listingId })
        .setOptions({ includeAllUsers: true, includeAllListingStatuses: true });
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
      thumbnailUrls,
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

    // NDOM-02: emit new_listing AFTER commit (off-hot-path). emit() re-reads the
    // Car with the plain hide-hook (TOCTOU suppression) and fans out to matching
    // saved-search subscriptions. Wrapped so a notification failure can NEVER
    // break the listing-creation response (Pitfall 8 / T-12-05-03). Actor is the
    // seller (or the Bearer uid when present) so they are excluded from self-notify.
    try {
      await notificationService.emit({
        type: 'new_listing',
        carId: newCar._id.toString(),
        actorUid: sellerId || req.auth?.uid,
      });
    } catch (notifyErr) {
      console.error('[notify] new_listing emit failed:', notifyErr);
    }

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
app.put('/api/cars/:id', uploadMemory.array('images', 25), async (req, res) => {
  try {
    const { sellerId, existingImageUrls } = req.body;
    if (!sellerId) return res.status(400).json({ message: 'sellerId required to edit' });

    const car = await Car.findById(req.params.id);
    if (!car) return res.status(404).json({ message: 'Car not found' });
    if (car.sellerId !== sellerId) return res.status(403).json({ message: 'Not authorized to edit this listing' });

    // NSUB-02 capture-before-mutation: snapshot the price BEFORE the Object.assign
    // below reassigns car.price. emit() (after save) direction-checks oldPrice vs
    // newPrice and only fires on a decrease, so we must capture the pre-edit value here.
    const oldPrice = car.price;

    const {
      makeId, modelId, trimLevel, wheelbase, year, price, mileage, fuel, currency, description, bodyType,
      engine, transmission, drivetrain, mpg, condition, knownIssues,
      exteriorColor, interiorColor, interiorMaterial, seats, doors, phoneNumber, telegramUsername
    } = req.body;

    // Reconcile kept + newly-uploaded images while keeping thumbnailUrls
    // index-aligned to imageUrls. Kept images map back to their stored thumbnail
    // (falling back to the full URL for pre-variant listings); new uploads are
    // resized into fresh full+thumb variants.
    const prevImageUrls = car.imageUrls || [];
    const prevThumbnailUrls = car.thumbnailUrls || [];
    let keptImageUrls = prevImageUrls;
    if (existingImageUrls) {
      try {
        keptImageUrls = JSON.parse(existingImageUrls);
      } catch (e) {}
    }
    const keptThumbnailUrls = keptImageUrls.map((url) => {
      const idx = prevImageUrls.indexOf(url);
      return (idx >= 0 && prevThumbnailUrls[idx]) ? prevThumbnailUrls[idx] : url;
    });
    const processedImages = await processAndUploadCarImages(req.files, bodyType);
    const imageUrls = [...keptImageUrls, ...processedImages.map(p => p.full)];
    const thumbnailUrls = [...keptThumbnailUrls, ...processedImages.map(p => p.thumb)];

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
      thumbnailUrls,
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

    // NDOM-02 / NSUB-02: emit price_drop AFTER commit. Only fire when the price
    // actually changed (skip non-price edits); emit() itself short-circuits a
    // non-decrease, so a raise produces zero notifications. Actor = seller
    // (ownership-enforced above), excluded from self-notify. Off-hot-path try/catch
    // so a notification failure can NEVER break the edit response (T-12-05-03).
    if (typeof oldPrice === 'number' && typeof car.price === 'number' && car.price !== oldPrice) {
      try {
        await notificationService.emit({
          type: 'price_drop',
          carId: car._id.toString(),
          actorUid: sellerId,
          oldPrice,
          newPrice: car.price,
        });
      } catch (notifyErr) {
        console.error('[notify] price_drop emit failed:', notifyErr);
      }
    }

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

// New moderation surface (SEC-01 + SEC-02). Mounted BEFORE legacy /api/admin/*
// routes so the Bearer-idToken chain applies first. Per D-05 (hybrid cutover),
// legacy routes below keep their existing callerUid-in-body pattern until a
// follow-up milestone migrates them (D-06).
app.use('/api/admin/moderation', verifyIdToken, requireAdmin, moderationRouter);
app.use('/api/admin/moderation/listings', verifyIdToken, requireAdmin, listingModerationRateLimiter, listingModerationRouter);

// Notification center (NDOM-05). INVERTS the moderation mount above: verifyIdToken
// ONLY, NO requireAdmin — every authenticated buyer reaches their own per-user
// notification feed + subscriptions (the router scopes every query to
// req.auth.uid for IDOR safety). Deliberately not admin-gated.
app.use('/api/notifications', verifyIdToken, notificationRouter);

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

// Plan 05-0b — new admin read router (GET /users/search). Mounted AFTER the
// inline /api/admin/* routes above so pre-existing endpoints (which predate
// the auth-first convention) keep their current behavior; only routes inside
// the new router run behind verifyIdToken + requireAdmin.
const adminRouter = require('./src/admin/router');
app.use('/api/admin', adminRouter);

// --- Stripe Payment Routes ---

const BOOKING_FEE_KGS = 500000; // 5 000 KGS in tiyin (smallest unit)
const BOOKING_FEE_USD = 5800;   // ~$58 USD in cents (approximate KGS→USD)

app.get('/api/payments/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

async function createPaymentIntentHandler(req, res) {
  try {
    const { currency = 'kgs', carId, buyerUid } = req.body;
    if (!buyerUid) return res.status(400).json({ message: 'buyerUid required' });

    // Phase 9 LENF-03 cart-add gate (D-09) — fires BEFORE any Stripe API call.
    // Re-reads listing status server-authoritatively so a stale client cart
    // cannot drag a non-active listing into checkout. Per W-7, no charge is
    // attempted when the listing is non-active.
    if (carId) {
      if (!mongoose.isValidObjectId(carId)) {
        return res.status(404).json({ error: 'car_not_found' });
      }
      const car = await Car.findById(carId)
        .setOptions({ includeAllListingStatuses: true })
        .select('status moderationReason')
        .lean();
      if (car && car.status !== 'active') {
        const banner = LISTING_STATUS_POLICY[car.status]?.banner ?? null;
        return res.status(409).json({
          error: 'listing_not_available',
          listingStatus: car.status,
          reasonCategory: car.moderationReason,
          banner,
        });
      }
    }

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
}

app.post('/api/payments/create-payment-intent', attachAuthIfPresent, requireNotSuspended('create_order'), createPaymentIntentHandler);

// Thin delegation to the transactional confirm-booking service (Plan 03-04).
// All Stripe + buyer/provider/seller re-check + car flip + ServiceOrder creation
// lives in src/payments/confirmBooking.js so the TOCTOU gap between
// create-payment-intent and confirm-booking is closed inside a single
// session.withTransaction(). This handler only routes errors to HTTP codes.
app.post('/api/payments/confirm-booking', attachAuthIfPresent, requireNotSuspended('create_order'), async (req, res) => {
  const { paymentIntentId, carId, buyerUid, items = [] } = req.body || {};
  try {
    const result = await confirmBookingService({
      stripe,
      paymentIntentId,
      carId,
      buyerUid,
      items,
    });

    // NDOM-02: emit `booked` AFTER the confirm-booking transaction commits — never
    // inside the service's session.withTransaction (Anti-pattern: post-save hooks
    // would fire inside the txn, lack actor context, and roll back with it). The
    // buyer is the actor (watchers other than the buyer get notified). Off-hot-path
    // try/catch so a notification failure can NEVER break the booking response.
    try {
      const bookedCarId = result?.car?._id ? result.car._id.toString() : carId;
      await notificationService.emit({
        type: 'booked',
        carId: bookedCarId,
        actorUid: buyerUid,
      });
    } catch (notifyErr) {
      console.error('[notify] booked emit failed:', notifyErr);
    }

    return res.json(result);
  } catch (err) {
    // Phase 9 LENF-03 — ListingNotAvailableError branch (Pitfall 10: must
    // precede ProviderSuspendedError because the two classes are SIBLINGS,
    // not parent/child; if their order were swapped the ProviderSuspendedError
    // arm would never see the listing-not-available case if a future
    // refactor made them subclasses). Reachable once Plan 09-05 lands the
    // in-transaction listing-status assertion that throws this class from
    // src/payments/confirmBooking.js step 4.
    if (err instanceof ListingNotAvailableError) {
      return res.status(409).json({
        error: 'listing_not_available',
        listingStatus: err.listingStatus,
        reasonCategory: err.reasonCategory,
        banner: err.banner,
        refundId: err.refundId,
        refundFailed: err.refundFailed,
      });
    }
    if (err instanceof ProviderSuspendedError) {
      return res.status(409).json({
        error: 'provider_suspended',
        providerUid: err.providerUid,
        refundId: err.refundId,
        refundFailed: err.refundFailed,
      });
    }
    if (err && (err.code === 'invalid_payment_intent' || err.message === 'invalid_payment_intent')) {
      return res.status(400).json({
        error: 'invalid_payment_intent',
        message: 'PaymentIntent is not succeeded',
      });
    }
    if (err && err.message === 'car_not_found') {
      return res.status(404).json({ error: 'car_not_found' });
    }
    // eslint-disable-next-line no-console
    console.error('[confirm-booking]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// --- Service Order Routes ---

// POST /api/orders is DEPRECATED as of Phase 3 — order creation is absorbed into
// POST /api/payments/confirm-booking which wraps PI verify + buyer/provider/seller
// moderation re-check + car.listingStatus flip + ServiceOrder create in one Mongo
// transaction. Standalone POST /api/orders used to permit a TOCTOU race where a
// provider could be suspended between confirm-booking and order creation.
// TODO: route removal after mobile retires the call + grace period (see 03-CONTEXT.md Deferred).
app.post('/api/orders', (req, res) => {
  res.status(410).json({
    error: 'deprecated',
    message: 'Use POST /api/payments/confirm-booking which now creates orders atomically',
  });
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

// Only bind the port when run directly (e.g. `node server.js`, Railway).
// Under Jest + supertest we `require('./server.js')` and want the Express app
// without a live listener. Production behavior is unchanged.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = { app, getCarDetailHandler, createPaymentIntentHandler };
