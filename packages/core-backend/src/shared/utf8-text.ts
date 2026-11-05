import { isUtf8 } from 'node:buffer';

/**
 * The one rule for "is this text": no NUL byte AND valid UTF-8. A NUL-free
 * file that does not decode as UTF-8 is still binary — the decode would be
 * lossy, so text written back could never round-trip the original bytes.
 * Checked on the raw bytes, so a large binary is refused without allocating
 * its decoded string first. Every reader that has to decide "text to render
 * or edit, or bytes to copy as they are" — the fallback text reader, the
 * access-rule writer, the template seeder, the starter packs — reads the
 * policy from here, so a file one treats as text another never treats as
 * bytes.
 */
export function isTextBytes(bytes: Buffer): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

/** The bytes as text when they ARE text by {@link isTextBytes} (BOM kept), else null. */
export function utf8Text(bytes: Buffer): string | null {
  return isTextBytes(bytes) ? bytes.toString('utf8') : null;
}
