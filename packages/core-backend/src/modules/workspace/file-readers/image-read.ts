/**
 * `read_file` image support: which files come back as a native MCP image
 * content block instead of text, the size cap that keeps the encoded payload
 * under what Claude-family clients accept, and the self-describing note that
 * rides beside the image so the transcript still says what was read.
 *
 * Deliberately dependency-free: dimensions are parsed straight from the
 * container headers (PNG/GIF/JPEG) rather than through a native image library.
 * No downscaling in this increment — `sharp` is a heavy native dependency, so
 * an oversized image gets an honest refusal telling the caller to downscale
 * locally or upload a smaller export.
 */
import { fileExtension } from './doc-extract.types.js';

/** The image types `read_file` returns as a native MCP image content block. `.svg` is TEXT and stays on the text path. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  // GIF passes through whole under the same cap; clients render the first frame.
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** The extensions the `ImageReader` registers for — exactly the map above. */
export const IMAGE_EXTENSIONS: readonly string[] = Object.keys(IMAGE_MIME_BY_EXT);

/** Is this a file `read_file` should return as an image? */
export function isImageFile(path: string): boolean {
  return fileExtension(path) in IMAGE_MIME_BY_EXT;
}

/** The MCP mime type for an image path — call only after `isImageFile`. */
export function imageMimeType(path: string): string {
  return IMAGE_MIME_BY_EXT[fileExtension(path)]!;
}

/**
 * Cap on the RAW bytes of an image `read_file` will return.
 *
 * The arithmetic: Claude-family clients reject a base64 image payload around
 * 5 MB encoded (5 * 1024 * 1024 = 5,242,880 chars). Base64 inflates by 4/3,
 * so the raw ceiling for that limit is 5,242,880 * 3/4 = 3,932,160 bytes. We
 * cap at 3.5 MiB raw = 3,670,016 bytes, which encodes to
 * ceil(3,670,016 / 3) * 4 = 4,893,356 base64 chars (~4.67 MiB) — under the
 * reject line with headroom for the JSON envelope the sentinel travels in.
 */
export const IMAGE_MAX_RAW_BYTES = 3.5 * 1024 * 1024; // = 3,670,016

/** Width×height parsed from the container header, when the format makes that cheap. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Best-effort dimensions straight from the header bytes: PNG (IHDR), GIF
 * (logical screen descriptor), JPEG (SOFn scan). WebP is left dimensionless —
 * its three sub-formats (VP8/VP8L/VP8X) each encode size differently, and the
 * note is honest without it. Returns undefined on anything unexpected; never
 * throws (a corrupt image must still be delivered or refused, not 500).
 */
export function imageDimensions(bytes: Buffer): ImageDimensions | undefined {
  try {
    // PNG: 8-byte signature, then the IHDR chunk — width/height at 16/20 (BE).
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    // GIF: "GIF87a"/"GIF89a", then the logical screen size at 6/8 (LE).
    if (bytes.length >= 10 && bytes.toString('latin1', 0, 3) === 'GIF') {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    // JPEG: walk the marker segments to the first SOFn frame header.
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1; // stray fill byte — resync
          continue;
        }
        const marker = bytes[i + 1]!;
        // Standalone markers (no length field): padding, restarts, SOI/EOI.
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2;
          continue;
        }
        // SOFn (C0–CF except the non-frame C4/C8/CC): height at +5, width at +7.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        i += 2 + bytes.readUInt16BE(i + 2);
      }
    }
  } catch {
    // Truncated/corrupt header — the note simply omits dimensions.
  }
  return undefined;
}

/** The one-line note emitted as a text block beside the image, so the transcript names what it shows. */
export function imageNote(path: string, mime: string, sizeBytes: number, dims: ImageDimensions | undefined): string {
  const dimsPart = dims ? `, ${dims.width}×${dims.height} px` : '';
  return `[image: ${path} — ${mime}, ${sizeBytes} bytes${dimsPart}]`;
}

/** The honest refusal for an image over {@link IMAGE_MAX_RAW_BYTES} — returned as the file's text content. */
export function oversizedImageNotice(path: string, mime: string, sizeBytes: number): string {
  return (
    `[${path} is a ${mime} image of ${sizeBytes} bytes — too large to return over MCP. The cap is ` +
    `${IMAGE_MAX_RAW_BYTES} bytes (3.5 MiB) of raw image data, because base64 encoding inflates it by 4/3 and ` +
    'Claude-family clients reject images near 5 MB encoded. Downscale the image locally or upload a smaller ' +
    'export, then read that file instead.]'
  );
}
