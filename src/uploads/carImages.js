// src/uploads/carImages.js
//
// Shared multer-S3 upload instance used by both server.js seller PUT
// (/api/cars/:id) and listingRouter.js admin Edit
// (PATCH /api/admin/moderation/listings/:carId). Single source of truth —
// D-D-2 / Phase 8 Pitfall 1.
//
// CR-02 hardening (was: previously interpolated unvalidated req.body.bodyType
// and file.originalname directly into the S3 key, exposing namespace
// collision, path-traversal-like key pollution, and stored-XSS via
// non-image uploads under public-read buckets):
//
//   1. MIME allowlist via fileFilter — only image/* whitelisted MIME types
//      pass; HTML/JS/etc. are rejected before any S3 write.
//   2. Size + count limits — 10 MB per file, 25 files per request (matches
//      the existing upload.array('images', 25) router cap).
//   3. ALLOWED_BODY_TYPES allowlist — folder prefix must be one of the
//      known body types; anything else is coerced to 'misc'. Blocks
//      cross-folder writes (e.g., into avatars/) and path-traversal-like
//      strings.
//   4. Filename sanitization — basename + extension derived from
//      file.originalname are stripped of path separators, control chars,
//      and anything not [a-z0-9-] to keep S3 keys flat and predictable.
//   5. Key prefix locked to `cars/` so admin-edit uploads cannot collide
//      with other features that use other bucket prefixes (avatars/, etc.).
//
// NOTE: The seller-PUT path shares this exact module per D-D-2, so the
// hardening applies to both. The key format CHANGES from
// `{bodyType}/{ts}-{originalname}` to
// `cars/{sanitizedBodyType-or-misc}/{ts}-{sanitizedName}{sanitizedExt}` —
// historical objects are not migrated; new objects use the new prefix.
// Existing imageUrls on stored Car docs are absolute S3 URLs so prior
// listings continue to resolve.

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

// Allowlist of body-type folder prefixes. Anything else collapses to 'misc'.
// Keep flat (no nesting) and lowercase-only.
const ALLOWED_BODY_TYPES = new Set([
  'sedan', 'suv', 'truck', 'coupe', 'hatchback', 'wagon',
  'van', 'convertible', 'misc',
]);

// MIME allowlist — image types only. multer-S3 uses the client-declared
// Content-Type header for file.mimetype, which is spoofable, but combined
// with multerS3.AUTO_CONTENT_TYPE the bucket-side Content-Type will be
// inferred from the stream rather than from a possibly-malicious extension.
const ALLOWED_IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|gif)$/i;

// Strip anything that could become an S3 path component or control char.
// Lowercase, [a-z0-9-] only, max 64 chars. Empty input → 'file'.
function sanitizeKeyPart(s) {
  const cleaned = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'file';
}

// Pull lowercase extension from a filename (e.g., '.jpg'). Returns '' if no
// recognizable ext or if the ext is suspicious (not [a-z0-9], > 8 chars).
function safeExtension(originalname) {
  const m = String(originalname || '').match(/\.([a-z0-9]{1,8})$/i);
  return m ? `.${m[1].toLowerCase()}` : '';
}

const upload = multer({
  // CR-02 limits — 10 MB per file is well above the largest expected
  // car-listing photo from a phone camera. Files cap aligns with the
  // router's upload.array('images', 25).
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 25,
  },
  // CR-02 fileFilter — MIME allowlist. Anything that isn't an image is
  // rejected before any byte hits S3.
  fileFilter: function (req, file, cb) {
    if (!ALLOWED_IMAGE_MIME.test(file.mimetype || '')) {
      return cb(new Error('Only image uploads are allowed'));
    }
    return cb(null, true);
  },
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME,
    // multerS3.AUTO_CONTENT_TYPE infers Content-Type from the file stream
    // (magic bytes) rather than trusting the client-declared header — defeats
    // the "rename .html to .jpg and serve as image/jpeg" XSS attempt.
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      // Folder prefix — strict allowlist; unknown body types collapse to 'misc'.
      const rawFolder = req.body && req.body.bodyType
        ? String(req.body.bodyType).toLowerCase()
        : 'misc';
      const folder = ALLOWED_BODY_TYPES.has(rawFolder) ? rawFolder : 'misc';

      // Filename — strip extension, sanitize basename, reattach safe extension.
      const baseRaw = String(file.originalname || '').replace(/\.[a-z0-9]+$/i, '');
      const safeBase = sanitizeKeyPart(baseRaw);
      const ext = safeExtension(file.originalname);

      cb(null, `cars/${folder}/${Date.now().toString()}-${safeBase}${ext}`);
    },
  }),
});

module.exports = { upload, s3, ALLOWED_BODY_TYPES, sanitizeKeyPart };
