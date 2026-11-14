import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { pgErrorCode } from '../pg-error.js';

describe('pgErrorCode', () => {
  const driverError = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

  it('reads the code off the driver error', () => {
    expect(pgErrorCode(driverError())).toBe('55P03');
  });

  it("reads it off a Drizzle query error's cause, where Drizzle puts it", () => {
    expect(pgErrorCode(new DrizzleQueryError('select 1', [], driverError()))).toBe('55P03');
  });

  it('is undefined for anything Postgres did not raise', () => {
    expect(pgErrorCode(new Error('boom'))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode('55P03')).toBeUndefined();
  });
});
