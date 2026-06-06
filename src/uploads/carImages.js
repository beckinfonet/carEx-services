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

// VARIANT PIPELINE (2026-06-06, deferred "Fix E" from
// .planning/debug/resolved/listing-images-blank-android.md): the seller
// create/edit routes now generate two sized JPEG variants per image at upload
// time — a ~400px `thumb` for feed/list cards and a ~1600px `full` for the
// detail gallery — instead of serving one full-resolution original to every
// surface. This module therefore exposes TWO upload paths that deliberately
// share the same CR-02 hardening (MIME allowlist, size/count limits, key
// sanitization):
//   - `upload`        (multer-S3, streams original straight to S3) — used by the
//                     admin Edit route + avatar config. UNCHANGED; its
//                     `file.location`/`file.key` invariants and WR-01 orphan
//                     cleanup must not regress.
//   - `uploadMemory`  (memory storage) + `processAndUploadCarImages()` — used by
//                     the seller POST/PUT routes, which resize with sharp before
//                     writing variants to S3.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const sharp = require('sharp');
const crypto = require('crypto');

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

// Resolve the body-type folder prefix against the allowlist; unknown → 'misc'.
function resolveFolder(bodyType) {
  const raw = bodyType ? String(bodyType).toLowerCase() : 'misc';
  return ALLOWED_BODY_TYPES.has(raw) ? raw : 'misc';
}

// CR-02 limits — shared by both upload paths. 10 MB per file is well above the
// largest expected car-listing photo from a phone camera. Files cap aligns with
// the router's upload.array('images', 25).
const UPLOAD_LIMITS = {
  fileSize: 10 * 1024 * 1024,
  files: 25,
};

// CR-02 fileFilter — MIME allowlist. Anything that isn't an image is rejected
// before any byte is buffered or hits S3. Shared by both upload paths.
function imageFileFilter(req, file, cb) {
  if (!ALLOWED_IMAGE_MIME.test(file.mimetype || '')) {
    return cb(new Error('Only image uploads are allowed'));
  }
  return cb(null, true);
}

const upload = multer({
  limits: UPLOAD_LIMITS,
  fileFilter: imageFileFilter,
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
      const folder = resolveFolder(req.body && req.body.bodyType);

      // Filename — strip extension, sanitize basename, reattach safe extension.
      const baseRaw = String(file.originalname || '').replace(/\.[a-z0-9]+$/i, '');
      const safeBase = sanitizeKeyPart(baseRaw);
      const ext = safeExtension(file.originalname);

      cb(null, `cars/${folder}/${Date.now().toString()}-${safeBase}${ext}`);
    },
  }),
});

// ---------------------------------------------------------------------------
// Variant pipeline (seller create/edit routes)
// ---------------------------------------------------------------------------

// In-memory multer for the seller POST/PUT routes. Same CR-02 fileFilter +
// limits as `upload`, but it buffers each file so sharp can resize it before we
// write the variants to S3 ourselves. Does NOT populate file.location/file.key.
const uploadMemory = multer({
  limits: UPLOAD_LIMITS,
  fileFilter: imageFileFilter,
  storage: multer.memoryStorage(),
});

// Variant specs. `full` is the detail-gallery image; `thumb` is the feed/list
// card image. Both are re-encoded to JPEG (q + progressive) so a single decode
// path serves every input MIME, and capped with `withoutEnlargement` so we never
// upscale a small source.
const VARIANTS = {
  full: { width: 1600, height: 1600, quality: 82, suffix: '' },
  thumb: { width: 400, height: 400, quality: 70, suffix: '-thumb' },
};

const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

// Build the public virtual-hosted-style S3 URL for a key — matches the format
// multer-s3 returns in file.location, so stored URLs are consistent across both
// upload paths.
function publicS3Url(key) {
  const bucket = process.env.AWS_BUCKET_NAME;
  const region = process.env.AWS_REGION;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

async function putJpeg(key, buffer) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg',
    CacheControl: CACHE_CONTROL_IMMUTABLE,
  }));
  return publicS3Url(key);
}

// Resize one in-memory file into { full, thumb } S3 URLs.
//
// Resilience: if sharp cannot decode a particular source (e.g. a HEIC the build
// of libvips wasn't compiled for), we fall back to uploading the ORIGINAL buffer
// once and pointing both variants at it — the upload still succeeds, the image
// still renders, it just isn't shrunk. A single bad image must never fail the
// whole listing create/edit.
async function processOneFile(file, folder) {
  const baseRaw = String(file.originalname || '').replace(/\.[a-z0-9]+$/i, '');
  const safeBase = sanitizeKeyPart(baseRaw);
  // Collision-hardened key stem: timestamp + random bytes + sanitized basename.
  const stem = `cars/${folder}/${Date.now().toString()}-${crypto.randomBytes(6).toString('hex')}-${safeBase}`;

  try {
    const [fullBuf, thumbBuf] = await Promise.all([
      sharp(file.buffer)
        .rotate() // honor EXIF orientation before stripping metadata
        .resize({ width: VARIANTS.full.width, height: VARIANTS.full.height, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: VARIANTS.full.quality, progressive: true, mozjpeg: true })
        .toBuffer(),
      sharp(file.buffer)
        .rotate()
        .resize({ width: VARIANTS.thumb.width, height: VARIANTS.thumb.height, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: VARIANTS.thumb.quality, progressive: true, mozjpeg: true })
        .toBuffer(),
    ]);

    const [full, thumb] = await Promise.all([
      putJpeg(`${stem}${VARIANTS.full.suffix}.jpg`, fullBuf),
      putJpeg(`${stem}${VARIANTS.thumb.suffix}.jpg`, thumbBuf),
    ]);
    return { full, thumb };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Image variant generation failed; uploading original as fallback:', err && err.message);
    const ext = safeExtension(file.originalname) || '.jpg';
    const key = `${stem}${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/octet-stream',
      CacheControl: CACHE_CONTROL_IMMUTABLE,
    }));
    const url = publicS3Url(key);
    return { full: url, thumb: url };
  }
}

// Process an array of in-memory multer files into ordered { full, thumb } URL
// pairs. Order is preserved so callers can build index-aligned imageUrls /
// thumbnailUrls arrays.
async function processAndUploadCarImages(files, bodyType) {
  if (!files || !files.length) return [];
  const folder = resolveFolder(bodyType);
  return Promise.all(files.map((file) => processOneFile(file, folder)));
}

module.exports = {
  upload,
  uploadMemory,
  s3,
  ALLOWED_BODY_TYPES,
  sanitizeKeyPart,
  resolveFolder,
  processAndUploadCarImages,
};
