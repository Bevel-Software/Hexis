import { describe, it, expect } from 'vitest';
import { resolveDatabaseUrl } from '../core-config.js';

/**
 * The connection string is composed HERE rather than in docker-compose, where
 * it needed a nested interpolated default that deployment UIs mis-parse. Two
 * things follow that are worth pinning.
 */
describe('resolveDatabaseUrl', () => {
  it('uses an explicit DATABASE_URL over the parts', () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: 'postgresql://me:pw@managed.example.com:5432/prod',
        POSTGRES_USER: 'ignored',
        POSTGRES_HOST: 'db',
      } as NodeJS.ProcessEnv),
    ).toBe('postgresql://me:pw@managed.example.com:5432/prod');
  });

  it('builds from the parts when none is given', () => {
    expect(
      resolveDatabaseUrl({
        POSTGRES_USER: 'alice',
        POSTGRES_PASSWORD: 's3cret',
        POSTGRES_DB: 'kb',
        POSTGRES_HOST: 'db',
      } as NodeJS.ProcessEnv),
    ).toBe('postgresql://alice:s3cret@db:5432/kb');
  });

  /** `localhost` suits `pnpm dev`; compose passes the service name instead. */
  it('defaults to a local Postgres', () => {
    expect(resolveDatabaseUrl({} as NodeJS.ProcessEnv)).toBe(
      'postgresql://bevel:bevel@localhost:5432/bevel',
    );
  });

  /**
   * The reason code beats shell interpolation for this. A password with `@`,
   * `/` or `:` in it produced an unparseable URL — and the resulting failure
   * named the host or the database, never the password that broke it.
   */
  it('encodes credentials that would otherwise break the URL', () => {
    const url = resolveDatabaseUrl({
      POSTGRES_USER: 'user@corp',
      POSTGRES_PASSWORD: 'p@ss:w/rd',
      POSTGRES_DB: 'kb',
      POSTGRES_HOST: 'db',
    } as NodeJS.ProcessEnv);
    // Parseable, and every part survives the round trip intact.
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('db');
    expect(decodeURIComponent(parsed.username)).toBe('user@corp');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:w/rd');
    expect(decodeURIComponent(parsed.pathname.slice(1))).toBe('kb');
  });

  it('honours a non-default port', () => {
    expect(
      resolveDatabaseUrl({ POSTGRES_HOST: 'db', POSTGRES_PORT: '6432' } as NodeJS.ProcessEnv),
    ).toBe('postgresql://bevel:bevel@db:6432/bevel');
  });

  /** Blank is not a value — an empty variable must not win over the parts. */
  it('treats a blank DATABASE_URL as absent', () => {
    expect(
      resolveDatabaseUrl({ DATABASE_URL: '   ', POSTGRES_HOST: 'db' } as NodeJS.ProcessEnv),
    ).toBe('postgresql://bevel:bevel@db:5432/bevel');
  });
});
