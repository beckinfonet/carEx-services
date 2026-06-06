// __tests__/uploads/carImages.test.js
//
// Unit tests for the seller-route variant pipeline added 2026-06-06
// (deferred "Fix E"). Mocks the S3 client so no network/credentials are
// needed, but runs sharp for real against a generated image buffer.

const mockSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn((input) => ({ __put: true, input })),
}));

process.env.AWS_BUCKET_NAME = 'test-bucket';
process.env.AWS_REGION = 'us-east-1';

const sharp = require('sharp');
const {
  processAndUploadCarImages,
  resolveFolder,
  sanitizeKeyPart,
} = require('../../src/uploads/carImages');

async function makePng(size = 64) {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 200, g: 50, b: 50 } },
  }).png().toBuffer();
}

const putInputs = () => mockSend.mock.calls.map((c) => c[0].input);

beforeEach(() => {
  mockSend.mockClear();
});

describe('helpers', () => {
  test('resolveFolder allowlists body types and collapses unknown → misc', () => {
    expect(resolveFolder('SUV')).toBe('suv');
    expect(resolveFolder('spaceship')).toBe('misc');
    expect(resolveFolder(undefined)).toBe('misc');
  });

  test('sanitizeKeyPart strips unsafe characters', () => {
    expect(sanitizeKeyPart('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeKeyPart('')).toBe('file');
  });
});

describe('processAndUploadCarImages', () => {
  test('returns [] for no files without touching S3', async () => {
    expect(await processAndUploadCarImages([], 'sedan')).toEqual([]);
    expect(await processAndUploadCarImages(undefined, 'sedan')).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('generates full + thumb JPEG variants per image and uploads both', async () => {
    const buffer = await makePng();
    const result = await processAndUploadCarImages(
      [{ buffer, originalname: 'My Photo.PNG', mimetype: 'image/png' }],
      'sedan',
    );

    expect(result).toHaveLength(1);
    const { full, thumb } = result[0];

    // URL format matches multer-s3 virtual-hosted style + cars/<folder>/ prefix.
    expect(full).toMatch(/^https:\/\/test-bucket\.s3\.us-east-1\.amazonaws\.com\/cars\/sedan\/.+\.jpg$/);
    expect(thumb).toMatch(/-thumb\.jpg$/);
    expect(full).not.toBe(thumb);
    // Sanitized basename carried through (no spaces / original ext).
    expect(full).toContain('my-photo');

    // Two PUTs — one per variant — both JPEG + immutable cache.
    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const input of putInputs()) {
      expect(input.Bucket).toBe('test-bucket');
      expect(input.ContentType).toBe('image/jpeg');
      expect(input.CacheControl).toBe('public, max-age=31536000, immutable');
      expect(Buffer.isBuffer(input.Body)).toBe(true);
    }
  });

  test('preserves order and index alignment across multiple files', async () => {
    const buffer = await makePng();
    const files = [
      { buffer, originalname: 'a.png', mimetype: 'image/png' },
      { buffer, originalname: 'b.png', mimetype: 'image/png' },
    ];
    const result = await processAndUploadCarImages(files, 'suv');
    expect(result).toHaveLength(2);
    expect(result[0].full).toContain('-a.jpg');
    expect(result[1].full).toContain('-b.jpg');
    expect(mockSend).toHaveBeenCalledTimes(4); // 2 variants x 2 files
  });

  test('falls back to a single original upload when sharp cannot decode', async () => {
    const result = await processAndUploadCarImages(
      [{ buffer: Buffer.from('definitely not an image'), originalname: 'broken.jpg', mimetype: 'image/jpeg' }],
      'sedan',
    );
    expect(result).toHaveLength(1);
    // Fallback points both variants at the same uploaded original.
    expect(result[0].full).toBe(result[0].thumb);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
