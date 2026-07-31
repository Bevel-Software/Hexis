/**
 * Cross-platform filename validation. A name that passes here must be writable
 * as-is on Windows (NTFS), macOS (APFS), and Linux (ext4) — so the same
 * workspace can round-trip between dev machines, the backend container, and
 * any user's local clone without `git checkout` failing on a forbidden name.
 *
 * Used by:
 *  - frontend: gate the create / rename inputs in FileExplorer
 *  - backend: reject API requests at the workspace service boundary
 *  - agent prompt: the same rules are described to the LLM so it picks valid
 *    names when authoring KB files
 *
 * Keep this file dependency-free — both bundle targets import it directly.
 */

/** Windows-reserved device names. Case-insensitive; the bare name AND
 *  `<name>.<ext>` are both reserved (e.g. `NUL.txt` is invalid on Windows). */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Characters Windows forbids in any filename component. `/` is the path
 *  separator on Unix, included for the same reason. `\` is also a path
 *  separator on Windows. Control chars (0x00–0x1F) are rejected separately. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

/** Per-component byte limit: NTFS = 255 UTF-16 units, ext4 = 255 bytes,
 *  APFS = 255 UTF-8 bytes. Use UTF-8 bytes — the strictest of the three. */
const MAX_NAME_BYTES = 255;

const utf8 = new TextEncoder();

/**
 * Validate a single path component (file or folder name — no `/`, no `\`).
 * Returns `null` if valid, or a short reason string suitable for surfacing
 * in a UI error or API 400 body.
 */
export function validateFilename(name: string): string | null {
  if (typeof name !== 'string') return 'Name is required';
  if (name.length === 0) return 'Name cannot be empty';
  if (name !== name.trim()) return 'Name cannot start or end with whitespace';
  if (name === '.' || name === '..') return 'Name cannot be "." or ".."';

  if (FORBIDDEN_CHARS.test(name)) {
    return 'Name cannot contain any of these characters: < > : " / \\ | ? *';
  }

  // Windows trims trailing dots and spaces silently — a name ending in either
  // becomes a different filename on disk, breaking sync between OSes.
  if (name.endsWith('.') || name.endsWith(' ')) {
    return 'Name cannot end with a "." or a space';
  }

  // Windows reserved device names — match `NAME` and `NAME.ext`, case-insensitive.
  const stem = name.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    return `"${name}" is a reserved system name on Windows`;
  }

  if (utf8.encode(name).length > MAX_NAME_BYTES) {
    return `Name is too long (max ${MAX_NAME_BYTES} bytes)`;
  }

  return null;
}

/**
 * Validate a workspace-relative path: a `/`-separated string of components.
 * Each component is checked with {@link validateFilename}. Backslashes are
 * rejected outright — the workspace API uses `/` everywhere and accepting
 * `\` would round-trip differently on Windows vs the Linux container.
 */
export function validateRelativePath(relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return 'Path is required';
  }
  if (relativePath.includes('\\')) {
    return 'Path cannot contain "\\" — use "/" as the separator';
  }
  // Strip a single leading `./` so callers that build paths from a base dir
  // (`./<name>`) don't get a spurious "." segment rejection.
  const normalized = relativePath.replace(/^\.\//, '');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return 'Path is required';
  for (const segment of segments) {
    const reason = validateFilename(segment);
    if (reason) return `Invalid path segment "${segment}": ${reason}`;
  }
  return null;
}

/**
 * Throwing wrapper for the backend service layer — keeps call sites a single
 * line and produces a clear `Error` the route handler can surface as a 400.
 */
export function assertValidRelativePath(relativePath: string): void {
  const reason = validateRelativePath(relativePath);
  if (reason) throw new Error(`Invalid path: ${reason}`);
}
