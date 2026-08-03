import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for per-user accounts: scrypt via node:crypto — memory-hard
 * (unlike sha/hmac), built in (no native bcrypt/argon dependency), async so a
 * login burst doesn't block the event loop.
 *
 * Stored format: `scrypt:N=<cost>,r=<block>,p=<par>:<salt b64url>:<key b64url>`
 * — parameters travel with the hash, so costs can be raised later while old
 * hashes keep verifying (and get re-hashed on next successful login/change).
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Guard rail surfaced by the routes as a 400 — not a silent truncation. */
export const MIN_PASSWORD_LENGTH = 8;

function scryptAsync(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LEN,
      // maxmem must accommodate 128*N*r bytes; default (32 MiB) is exactly at
      // the boundary for N=16384,r=8 — give it headroom.
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

/** Constant-time verify of `password` against a stored {@link hashPassword} string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = /^scrypt:N=(\d+),r=(\d+),p=(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(stored);
  if (!match) return false;
  const [, n, r, p, saltB64, keyB64] = match;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(keyB64, 'base64url');
  try {
    const actual = await scryptAsync(password, salt, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // Absurd parameters (corrupted row / DoS-shaped input) — fail closed.
    return false;
  }
}

/**
 * Constant-time comparison of two plaintext secrets (the env bootstrap-admin
 * check). Pads to a common length so a length mismatch doesn't return early
 * and leak the expected secret's length via timing.
 */
export function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const len = Math.max(a.length, b.length, 1);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && a.length === b.length;
}
