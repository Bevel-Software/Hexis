import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from '../config.js';

const KEY = 'bevel_abc123';

describe('resolveConfig', () => {
  it('reads --url/--key, and accepts both = and space forms', () => {
    expect(resolveConfig(['--url', 'https://x.example', '--key', KEY], {})).toEqual({
      baseUrl: 'https://x.example',
      connectionKey: KEY,
    });
    expect(resolveConfig([`--url=https://x.example`, `--key=${KEY}`], {})).toEqual({
      baseUrl: 'https://x.example',
      connectionKey: KEY,
    });
    expect(resolveConfig(['-u', 'https://x.example', '-k', KEY], {})).toEqual({
      baseUrl: 'https://x.example',
      connectionKey: KEY,
    });
  });

  it('falls back to the environment, which is how MCP clients pass config', () => {
    expect(resolveConfig([], { HEXIS_URL: 'https://x.example', HEXIS_CONNECTION_KEY: KEY })).toEqual({
      baseUrl: 'https://x.example',
      connectionKey: KEY,
    });
    expect(resolveConfig([], { BEVEL_URL: 'https://x.example', BEVEL_CONNECTION_KEY: KEY })).toEqual({
      baseUrl: 'https://x.example',
      connectionKey: KEY,
    });
  });

  it('lets a flag win over the environment', () => {
    const config = resolveConfig(['--url', 'https://flag.example'], {
      HEXIS_URL: 'https://env.example',
      HEXIS_CONNECTION_KEY: KEY,
    });
    expect(config.baseUrl).toBe('https://flag.example');
  });

  it('strips trailing slashes so path joining cannot double up', () => {
    expect(resolveConfig(['--url', 'https://x.example///', '--key', KEY]).baseUrl).toBe('https://x.example');
  });

  it('keeps a base path, for a deployment mounted under one', () => {
    expect(resolveConfig(['--url', 'https://x.example/hexis', '--key', KEY]).baseUrl).toBe(
      'https://x.example/hexis',
    );
  });

  it('trims a pasted key — copy buttons and shell quoting add whitespace', () => {
    expect(resolveConfig(['--url', 'https://x.example', '--key', `  ${KEY}\n`]).connectionKey).toBe(KEY);
  });

  it('names the missing piece rather than failing generically', () => {
    expect(() => resolveConfig([], {})).toThrow(/Missing the workspace URL/);
    expect(() => resolveConfig(['--url', 'https://x.example'], {})).toThrow(/Missing the connection key/);
    expect(() => resolveConfig([], {})).toThrow(ConfigError);
  });

  it('refuses a URL that is not http(s) — including scheme smuggling', () => {
    expect(() => resolveConfig(['--url', 'notaurl', '--key', KEY])).toThrow(/not a valid URL/);
    expect(() => resolveConfig(['--url', 'javascript:alert(1)', '--key', KEY])).toThrow(/must be an http/);
    expect(() => resolveConfig(['--url', 'file:///etc/passwd', '--key', KEY])).toThrow(/must be an http/);
  });
});
