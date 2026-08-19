import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoreConfig } from '../core-config.js';

/**
 * The public-shape derivation from `DOMAIN`.
 *
 * Setting `DOMAIN` declares "the bundled Caddy `https` profile fronts this
 * deployment": one proxy hop, origins = the domain. The config derives
 * `PUBLIC_BACKEND_URL` / `PUBLIC_FRONTEND_URL` (`https://<DOMAIN>`) and
 * `TRUST_PROXY` (`1`) from it — but only as DEFAULTS: an explicit value for
 * any of the three always wins, so a CDN in front of Caddy or a frontend
 * served elsewhere stays expressible.
 */
const REQUIRED = {
  KB_REPO_URL: 'https://example.com/org/kb.git',
  ADMIN_EMAIL: 'root@example.com',
  ADMIN_PASSWORD: 'sup3r-secret',
  JWT_SECRET: 'test-jwt-secret',
  SECRETS_ENC_KEY: 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=',
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  // A clean slate for the keys under test (a developer .env loaded by
  // dotenv at import time may carry any of them).
  for (const key of [
    'DOMAIN',
    'PUBLIC_BACKEND_URL',
    'PUBLIC_FRONTEND_URL',
    'TRUST_PROXY',
    'NODE_ENV',
    'PORT',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  process.env = saved;
});

describe('CoreConfig — DOMAIN derives the public shape', () => {
  it('DOMAIN alone yields https origins and one proxy hop', () => {
    process.env.DOMAIN = 'bevel.example.com';
    const config = new CoreConfig();
    expect(config.publicBackendUrl).toBe('https://bevel.example.com');
    expect(config.publicFrontendUrl).toBe('https://bevel.example.com');
    expect(config.trustProxy).toBe('1');
  });

  it('explicit PUBLIC_* and TRUST_PROXY always win over DOMAIN', () => {
    // The CDN-in-front-of-Caddy shape: two hops, and a frontend served from
    // somewhere the bundled proxy is not.
    process.env.DOMAIN = 'bevel.example.com';
    process.env.PUBLIC_BACKEND_URL = 'https://api.example.com';
    process.env.PUBLIC_FRONTEND_URL = 'https://app.example.com';
    process.env.TRUST_PROXY = '2';
    const config = new CoreConfig();
    expect(config.publicBackendUrl).toBe('https://api.example.com');
    expect(config.publicFrontendUrl).toBe('https://app.example.com');
    expect(config.trustProxy).toBe('2');
  });

  it('without DOMAIN the defaults are unchanged (dev shape)', () => {
    const config = new CoreConfig();
    expect(config.publicBackendUrl).toBe('http://localhost:3001');
    expect(config.publicFrontendUrl).toBe('http://localhost:5173');
    // Unset means "directly exposed": forwarded headers stay ignored.
    expect(config.trustProxy).toBe('');
  });

  it('without DOMAIN in production, the frontend origin is the backend origin', () => {
    // The backend serves the built SPA — under docker compose (which sets
    // NODE_ENV=production and no PUBLIC_* by default) this is what keeps a
    // bare `up -d` bouncing logins back to the container's own origin.
    process.env.NODE_ENV = 'production';
    const config = new CoreConfig();
    expect(config.publicBackendUrl).toBe('http://localhost:3001');
    expect(config.publicFrontendUrl).toBe('http://localhost:3001');
    expect(config.trustProxy).toBe('');
  });

  it('an explicit production backend origin carries over to the frontend default', () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_BACKEND_URL = 'https://bevel.example.com';
    const config = new CoreConfig();
    expect(config.publicFrontendUrl).toBe('https://bevel.example.com');
  });
});
