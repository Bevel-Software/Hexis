/**
 * The bytes as text when they ARE text — strict UTF-8, BOM kept, no NUL —
 * else null. The one rule for every reader that has to decide "text to
 * render, or bytes to copy as they are": the template seeder and the
 * starter packs read it from here, so a file one treats as text the other
 * never treats as bytes.
 */
export function utf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
