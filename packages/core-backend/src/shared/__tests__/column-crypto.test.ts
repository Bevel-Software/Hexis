import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import { eq, inArray } from 'drizzle-orm';
import {
  IndexOnWrite,
  PII_CIPHERTEXT_PREFIX,
  PII_SEALED_SHAPE_SQL_REGEX,
  SealOnWrite,
  blindIndexText,
  derivePiiKeys,
  encryptedText,
  isEncryptedBlob,
} from '../column-crypto.js';
import { TokenCrypto } from '../token-crypto.js';

const KEY = randomBytes(32).toString('base64');
const keys = derivePiiKeys(KEY);
const otherKeys = derivePiiKeys(randomBytes(32).toString('base64'));

describe('derivePiiKeys: seal / open / read', () => {
  it('round-trips a value through ciphertext', () => {
    const sealed = keys.seal('razvan@bevel.software');
    expect(sealed).not.toContain('razvan');
    expect(sealed.startsWith(PII_CIPHERTEXT_PREFIX)).toBe(true);
    expect(isEncryptedBlob(sealed)).toBe(true);
    expect(keys.read(sealed)).toBe('razvan@bevel.software');
  });

  it('stores the empty string as itself (no unparseable empty-ciphertext blob)', () => {
    expect(keys.seal('')).toBe('');
    expect(keys.read('')).toBe('');
    expect(isEncryptedBlob('')).toBe(false);
  });

  it('is randomized — the same plaintext never encrypts to the same blob', () => {
    expect(keys.seal('alice')).not.toBe(keys.seal('alice'));
  });

  it('passes legacy plaintext through unchanged (pre-backfill rows)', () => {
    expect(keys.read('plain old email@example.com')).toBe('plain old email@example.com');
  });

  it('passes through plaintext that merely resembles ciphertext', () => {
    // Blob-shaped but unprefixed (the legacy TokenCrypto shape) → plaintext.
    const shapeOnly = new TokenCrypto(KEY).encrypt('not-a-pii-blob');
    expect(isEncryptedBlob(shapeOnly)).toBe(false);
    expect(keys.read(shapeOnly)).toBe(shapeOnly);
    // Prefixed but malformed → still not a blob.
    const impostor = `${PII_CIPHERTEXT_PREFIX}abc:def:ghi`;
    expect(isEncryptedBlob(impostor)).toBe(false);
    expect(keys.read(impostor)).toBe(impostor);
  });

  it('the SQL shape regex agrees with isEncryptedBlob on what a sealed value is', () => {
    // The backfill trusts rows matching this regex as sealed and skips them;
    // the app-side check is the authority. Pinned together here so a change
    // to the prefix, IV or tag width in one place fails this test.
    const regex = new RegExp(PII_SEALED_SHAPE_SQL_REGEX);
    for (const plain of ['a@b.co', 'razvan@bevel.software', 'x'.repeat(500)]) {
      const sealed = keys.seal(plain);
      expect(isEncryptedBlob(sealed)).toBe(true);
      expect(regex.test(sealed)).toBe(true);
    }
    for (const unsealed of ['a@b.co', '', `${PII_CIPHERTEXT_PREFIX}abc:def:ghi`, new TokenCrypto(KEY).encrypt('x')]) {
      expect(isEncryptedBlob(unsealed)).toBe(false);
      expect(regex.test(unsealed)).toBe(false);
    }
  });

  it("another key cannot open it: the lenient read hands the blob back, open says so", () => {
    const sealed = keys.seal('secret-person@example.com');
    expect(otherKeys.read(sealed)).toBe(sealed);
    expect(otherKeys.open(sealed)).toEqual({ ok: false });
    expect(keys.open(sealed)).toEqual({ ok: true, plain: 'secret-person@example.com' });
  });

  it('open tells a blob the key does not open from a plaintext shaped like one', () => {
    // A value whose PLAINTEXT is itself a well-formed blob: opened correctly,
    // the result still looks sealed. Only the explicit outcome tells the two
    // apart — the shape of what the lenient read returns cannot.
    const inner = keys.seal('inner@example.com');
    const outer = keys.seal(inner);
    expect(keys.open(outer)).toEqual({ ok: true, plain: inner });
    expect(keys.open('plain@example.com')).toEqual({ ok: true, plain: 'plain@example.com' });
    expect(otherKeys.open(outer)).toEqual({ ok: false });
  });

  it('domain-separates from the raw secrets key via HKDF', () => {
    // The column key is DERIVED from KEY — a TokenCrypto built from the raw
    // KEY itself must not be able to open a PII blob's body.
    const body = keys.seal('secret-person@example.com').slice(PII_CIPHERTEXT_PREFIX.length);
    expect(() => new TokenCrypto(KEY).decrypt(body)).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => derivePiiKeys('too-short')).toThrow();
  });
});

describe('derivePiiKeys: index', () => {
  it('is deterministic and case/whitespace-insensitive', () => {
    expect(keys.index('Alice@Example.com ')).toBe(keys.index('alice@example.com'));
    expect(keys.index('alice@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across values', () => {
    expect(keys.index('a@example.com')).not.toBe(keys.index('b@example.com'));
  });

  it('differs across keys, so one tenant’s index says nothing about another’s', () => {
    expect(otherKeys.index('a@example.com')).not.toBe(keys.index('a@example.com'));
  });
});

/**
 * The column types hold no key: what they hand the driver is a mark for the
 * database handle's connection to replace. Pinned through drizzle itself —
 * the statement a service writes, rendered — because that is where the mark
 * has to survive to.
 */
describe('the column types mark values for the handle', () => {
  const people = pgTable('people', {
    id: uuid('id').primaryKey(),
    email: encryptedText('email').notNull(),
    emailBidx: blindIndexText('email_bidx').notNull(),
  });
  const paramsOf = (clause: unknown) => new PgDialect().sqlToQuery(clause as never).params;

  it('a comparison on an index column binds the address, marked to be indexed', () => {
    const [bound] = paramsOf(eq(people.emailBidx, 'Ada@Example.com'));
    expect(bound).toBeInstanceOf(IndexOnWrite);
    expect((bound as IndexOnWrite).stored(keys)).toBe(keys.index('ada@example.com'));
    expect(paramsOf(inArray(people.emailBidx, ['a@x.co', 'b@x.co'])).every((p) => p instanceof IndexOnWrite)).toBe(true);
  });

  it('a value for an encrypted column is marked to be sealed; the empty string is stored as it is', () => {
    const [bound] = paramsOf(eq(people.email, 'Ada@Example.com'));
    expect(bound).toBeInstanceOf(SealOnWrite);
    expect(keys.read((bound as SealOnWrite).stored(keys))).toBe('Ada@Example.com');
    expect(paramsOf(eq(people.email, ''))).toEqual(['']);
  });

  it('a mark that reaches a connection holding no key refuses to be written', () => {
    // `pg` serialises an object parameter through its `toPostgres`. Anything
    // else here — JSON of the object, say — would store the plaintext.
    const [bound] = paramsOf(eq(people.email, 'Ada@Example.com'));
    expect(() => (bound as SealOnWrite).toPostgres()).toThrow(/holds no key/);
  });

  it('refuses a stored index written back into an index column', () => {
    // Reading the column gives the stored index; writing that back would
    // index the index and the row would answer to no address.
    expect(() => paramsOf(eq(people.emailBidx, keys.index('ada@example.com')))).toThrow(/stored index/);
  });
});
