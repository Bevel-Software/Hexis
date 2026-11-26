import { describe, expect, it } from 'vitest';
import type { CallTemplate } from '@utcp/sdk';
import { SecretRedactor, rememberCallCredentials, rememberCredentialQuery } from '../secret-redactor.js';

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

  it('reads a query name as URLSearchParams does, a malformed escape included', () => {
    const redactor = new SecretRedactor();
    rememberCredentialQuery('https://x.example/mcp?%74oken%FF=ab%FFverysecret-tail', redactor);
    expect(redactor.redact('sent ab%FFverysecret-tail')).toBe('sent [redacted]');
  });

  it('takes out a query credential in both spellings, as sent and as read', () => {
    const redactor = new SecretRedactor();
    rememberCredentialQuery('https://x.example/mcp?region=eu&api_key=a%2Bb%2Fc1234567', redactor);
    expect(redactor.redact('sent a%2Bb%2Fc1234567, read a+b/c1234567, region eu')).toBe(
      'sent [redacted], read [redacted], region eu',
    );
  });
});

describe('rememberCallCredentials', () => {
  it('takes out each of several values substituted into one string, the later one echoed alone', () => {
    const redactor = new SecretRedactor();
    const raw = {
      name: 'n',
      call_template_type: 'mcp',
      config: { mcpServers: { s: { url: 'https://${HOST}/v1/$TOKEN?x=1' } } },
    };
    const processed = { ...raw, config: { mcpServers: { s: { url: 'https://api.example.com/v1/tok-abcdef123456?x=1' } } } };
    rememberCallCredentials(redactor, processed as unknown as CallTemplate, raw as unknown as CallTemplate);
    expect(redactor.redact('refused tok-abcdef123456 at api.example.com')).toBe('refused [redacted] at [redacted]');
  });

  it('takes out what substitution put in, and leaves the public text around it', () => {
    const redactor = new SecretRedactor();
    const raw = {
      name: 'n',
      call_template_type: 'mcp',
      config: { mcpServers: { s: { url: 'https://api.example.com/${TENANT}/mcp' } } },
    };
    const processed = { ...raw, config: { mcpServers: { s: { url: 'https://api.example.com/acme-tenant-01/mcp' } } } };
    rememberCallCredentials(redactor, processed as unknown as CallTemplate, raw as unknown as CallTemplate);
    expect(redactor.redact('https://api.example.com/status refused acme-tenant-01')).toBe(
      'https://api.example.com/status refused [redacted]',
    );
  });
});
