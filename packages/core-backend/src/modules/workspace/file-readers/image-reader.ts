import type { FileReader, ReadResult } from './file-reader.js';
import {
  IMAGE_EXTENSIONS,
  IMAGE_MAX_RAW_BYTES,
  imageDimensions,
  imageMimeType,
  imageNote,
  oversizedImageNotice,
} from './image-read.js';

/**
 * FileReader over the image types `read_file` returns as a native MCP image
 * content block (`.svg` is text and stays on the text path). Within the raw
 * cap the read yields the picture itself (base64 + mime + the self-describing
 * note); over it, the honest downscale refusal — see image-read.ts for the
 * cap arithmetic and header-parsing details.
 *
 * No `greppableText`: a picture is never text-searchable. And images stay
 * `textEditable` — the write tools only refuse formats whose reads are lossy
 * EXTRACTIONS (documents); an image read is the real bytes, and image writes
 * were never gated.
 */
export class ImageReader implements FileReader {
  readonly extensions: readonly string[] = IMAGE_EXTENSIONS;
  readonly textEditable = true;

  async read(bytes: Buffer, path: string): Promise<ReadResult> {
    const mime = imageMimeType(path);
    if (bytes.length > IMAGE_MAX_RAW_BYTES) {
      return { kind: 'refusal', message: oversizedImageNotice(path, mime, bytes.length) };
    }
    return {
      kind: 'image',
      data: bytes.toString('base64'),
      mimeType: mime,
      note: imageNote(path, mime, bytes.length, imageDimensions(bytes)),
    };
  }
}
