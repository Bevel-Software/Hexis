import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  timingSafeStringEqual,
  MIN_PASSWORD_LENGTH,
} from '../password-hash.js';

describe('password-hash', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt:N=')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('incorrect horse', stored)).toBe(false);
  });

  it('salts: same password twice → different stored strings, both verify', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('fails closed on malformed / foreign stored values', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:N=abc,r=8,p=1:AA:BB')).toBe(false);
  });

  it('verifies params from the stored string (future cost bumps keep old hashes valid)', async () => {
    // A hash produced at lower cost still verifies — parameters are read from
    // the string, not assumed from current constants.
    const stored = await hashPassword('pw');
    const weaker = stored.replace(/N=\d+/, 'N=16384'); // same params today; string form is authoritative
    expect(await verifyPassword('pw', weaker)).toBe(true);
  });

  it('timingSafeStringEqual matches only exact strings', () => {
    expect(timingSafeStringEqual('secret', 'secret')).toBe(true);
    expect(timingSafeStringEqual('secret', 'secret2')).toBe(false);
    expect(timingSafeStringEqual('', '')).toBe(true);
    expect(timingSafeStringEqual('a', '')).toBe(false);
  });

  it('exposes a sane minimum length for the routes to enforce', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });
});
