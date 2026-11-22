/**
 * What SHA-256 and SHA-384 share around their compression functions: the
 * padded message going in and the base64 digest coming out. Internal to
 * `hash/`; the package entry exports only the digest functions.
 */

const utf8 = new TextEncoder();

/**
 * A string's UTF-8 bytes padded per FIPS 180-4 for a hash of `blockBytes`
 * blocks (64 for SHA-256, 128 for SHA-384): the message exactly as given
 * (a lone surrogate is U+FFFD, as `TextEncoder` writes it), a 1 bit, zeros,
 * and the message's bit length in the block's last `blockBytes / 8` bytes,
 * making a whole number of blocks. Returned as a big-endian view.
 */
export function paddedMessage(text: string, blockBytes: 64 | 128): DataView {
  const bytes = utf8.encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((Math.floor((bytes.length + blockBytes / 8) / blockBytes) + 1) * blockBytes);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // A string's bit length fits in 64 bits; the higher bytes of a wider length field stay zero.
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  return view;
}

/** 32-bit words, each big-endian, in standard padded base64: the form a Content-Security-Policy hash source takes. */
export function wordsToBase64(words: Uint32Array): string {
  let binary = '';
  for (const word of words) {
    binary += String.fromCharCode(word >>> 24, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  return btoa(binary);
}
