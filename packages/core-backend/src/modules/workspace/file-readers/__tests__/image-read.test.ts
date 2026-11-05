import { describe, expect, it } from 'vitest';
import {
  IMAGE_MAX_RAW_BYTES,
  imageDimensions,
  imageMimeType,
  imageNote,
  isImageFile,
  oversizedImageNotice,
} from '../image-read.js';

/** A real, complete 1×1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** A real, complete 1×1 GIF89a. */
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

/** A minimal JPEG prefix: SOI, an APP0 stub, then an SOF0 declaring 4×3. */
function jpegWithSof(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]); // 4-byte segment
  const sof0 = Buffer.alloc(2 + 2 + 5 + 3);
  sof0.set([0xff, 0xc0]); // SOF0 marker
  sof0.writeUInt16BE(sof0.length - 2, 2); // segment length
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

describe('isImageFile / imageMimeType', () => {
  it('covers exactly the five raster extensions, case-insensitively', () => {
    expect(isImageFile('a/b/logo.png')).toBe(true);
    expect(isImageFile('photo.JPG')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('anim.gif')).toBe(true);
    expect(isImageFile('pic.webp')).toBe(true);
    // SVG is TEXT — must flow through the normal text path.
    expect(isImageFile('icon.svg')).toBe(false);
    expect(isImageFile('favicon.ico')).toBe(false);
    expect(isImageFile('image.bmp')).toBe(false);
    expect(isImageFile('doc.pdf')).toBe(false);
  });

  it('maps jpg and jpeg to image/jpeg', () => {
    expect(imageMimeType('a.jpg')).toBe('image/jpeg');
    expect(imageMimeType('a.jpeg')).toBe('image/jpeg');
    expect(imageMimeType('a.png')).toBe('image/png');
  });
});

describe('imageDimensions', () => {
  it('reads PNG IHDR', () => {
    expect(imageDimensions(PNG_1X1)).toEqual({ width: 1, height: 1 });
  });

  it('reads the GIF logical screen descriptor', () => {
    expect(imageDimensions(GIF_1X1)).toEqual({ width: 1, height: 1 });
  });

  it('requires the FULL GIF87a/GIF89a signature — a bare "GIF" prefix parses no dimensions', () => {
    const fake = Buffer.from('GIFFY!\x05\x00\x07\x00 not a gif at all', 'latin1');
    expect(imageDimensions(fake)).toBeUndefined();
  });

  it('walks JPEG segments to the SOF0 frame header', () => {
    expect(imageDimensions(jpegWithSof(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('returns undefined (never throws) for truncated or unknown bytes', () => {
    expect(imageDimensions(Buffer.from([0x89, 0x50]))).toBeUndefined();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
    expect(imageDimensions(Buffer.from('RIFFxxxxWEBP'))).toBeUndefined(); // webp: honestly dimensionless
    expect(imageDimensions(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('cap + notes', () => {
  it('the cap is 3.5 MiB raw, whose base64 stays under the ~5 MB client reject line', () => {
    expect(IMAGE_MAX_RAW_BYTES).toBe(3_670_016);
    const encodedChars = Math.ceil(IMAGE_MAX_RAW_BYTES / 3) * 4;
    expect(encodedChars).toBeLessThan(5 * 1024 * 1024);
  });

  it('imageNote includes dimensions when known and omits them cleanly when not', () => {
    expect(imageNote('a/logo.png', 'image/png', 67, { width: 1, height: 1 })).toBe(
      '[image: a/logo.png — image/png, 67 bytes, 1×1 px]',
    );
    expect(imageNote('p.webp', 'image/webp', 10, undefined)).toBe('[image: p.webp — image/webp, 10 bytes]');
  });

  it('oversizedImageNotice names the file, the cap arithmetic and the way out', () => {
    const notice = oversizedImageNotice('big.png', 'image/png', 9_999_999);
    expect(notice).toContain('big.png');
    expect(notice).toContain('9999999 bytes');
    expect(notice).toContain('3670016 bytes');
    expect(notice).toContain('Downscale');
    expect(notice).toContain('upload a smaller export');
  });
});
