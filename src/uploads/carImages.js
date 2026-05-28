// src/uploads/carImages.js
//
// Shared multer-S3 upload instance used by both server.js seller PUT
// (/api/cars/:id) and listingRouter.js admin Edit
// (PATCH /api/admin/moderation/listings/:carId). Single source of truth —
// D-D-2 / Phase 8 Pitfall 1. Bucket, region, key, and metadata functions are
// byte-identical to the pre-Phase-8 inline construction so seller-PUT S3 keys
// do not change.

const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');

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

module.exports = { upload, s3 };
