import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '../secret-redactor.js';

describe('SecretRedactor', () => {
  it('takes out a whole value and, in the same text, a masked head of it', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-1234567890abcdef');
    expect(redactor.redact('key sk-live-1234567890abcdef, shown as sk-live-1234… in the log')).toBe(
      'key [redacted], shown as [redacted]… in the log',
    );
  });

  it('matches a short value only where it stands alone', () => {
    const redactor = new SecretRedactor();
    redactor.remember('us');
    expect(redactor.redact('region us, status 401 for users')).toBe('region [redacted], status 401 for users');
  });
});
