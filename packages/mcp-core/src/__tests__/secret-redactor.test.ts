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
  it('remembers the credentials a template spells out in full, and nothing public', () => {
    const redactor = new SecretRedactor();
    const template = {
      name: 'n',
      call_template_type: 'mcp',
      auth: { auth_type: 'api_key', api_key: 'auth-key-1234567890', var_name: 'X-Key' },
      config: {
        mcpServers: {
          web: {
            url: 'https://api.example.com/mcp?token=query-token-123456',
            headers: { Authorization: 'Bearer header-token-123456' },
          },
          local: { command: 'node', env: { API_TOKEN: 'env-token-1234567', LOG_LEVEL: 'debugging' } },
        },
      },
    };
    rememberCallCredentials(redactor, template as unknown as CallTemplate);
    expect(
      redactor.redact(
        'https://api.example.com/mcp refused header-token-123456, query-token-123456, env-token-1234567 and auth-key-1234567890 at debugging',
      ),
    ).toBe('https://api.example.com/mcp refused [redacted], [redacted], [redacted] and [redacted] at debugging');
  });
});
