import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StaticTenantSource, tenantConfigFrom, tenantHostEnv, type TenantHostSettings } from '../static-tenant-source.js';

const settings: TenantHostSettings = {
  databaseUrl: 'postgresql://u:p@db:5432/hexis',
  port: 3001,
  nodeEnv: 'production',
  trustProxy: '1',
  workspacesRoot: path.resolve('/srv/hexis/workspaces'),
  kbTemplateDir: '/srv/hexis/template',
  gitTimeoutMs: 120_000,
  ontologySessionBlock: true,
  updateCheckEnabled: false,
  masterKey: 'a-master-key-that-is-long-enough-to-count-as-random',
};

const acme = { slug: 'acme-2', hosts: ['Acme.example.test:443', 'acme.internal'], adminEmail: 'Owner@Acme.test' };

describe('tenantConfigFrom', () => {
  it('names the schema, the folders and the credential prefixes after the slug, so two tenants never share one', () => {
    const config = tenantConfigFrom(acme, settings);
    expect(config.dbSchema).toBe('t_acme_2');
    expect(config.tenantId).toBe('acme2');
    expect(config.externalApiKeyPrefix).toBe('acme2_');
    expect(config.workspacesRoot).toBe(path.resolve('/srv/hexis/workspaces/acme-2'));
    expect(config.backupsRoot).toBe(path.resolve('/srv/hexis/backups/acme-2'));
    expect(config.spillRoot).toBe(path.resolve('/srv/hexis/tool-chain-spills/acme-2'));
    expect(config.docExtractCacheRoot).toBe(path.resolve('/srv/hexis/doc-extract-cache/acme-2'));
    expect(config.loopbackBaseUrl).toBe('http://127.0.0.1:3001/_tenant/acme-2');
  });

  it('takes the public address from the first host, and the process facts from the host settings', () => {
    const config = tenantConfigFrom(acme, settings);
    expect(config.publicBackendUrl).toBe('https://acme.example.test');
    expect(config.publicFrontendUrl).toBe('https://acme.example.test');
    expect(config.configuredPublicFrontendUrl).toBe('https://acme.example.test');
    expect(config.adminEmail).toBe('owner@acme.test');
    expect(config).toMatchObject({ port: 3001, nodeEnv: 'production', trustProxy: '1', databaseUrl: settings.databaseUrl });
  });

  it('derives the three secrets from the master key, differently per tenant', () => {
    const a = tenantConfigFrom(acme, settings);
    const b = tenantConfigFrom({ ...acme, slug: 'globex', hosts: ['globex.example.test'] }, settings);
    expect(Buffer.from(a.secretsEncKey, 'base64')).toHaveLength(32);
    expect(a.jwtSecret).not.toBe(b.jwtSecret);
    expect(a).toEqual(tenantConfigFrom(acme, settings));
  });

  it('turns password login on exactly when a bootstrap password is given, unless told otherwise', () => {
    expect(tenantConfigFrom(acme, settings).loginPasswordEnabled).toBe(false);
    expect(tenantConfigFrom({ ...acme, adminPassword: 'pw' }, settings).loginPasswordEnabled).toBe(true);
    expect(tenantConfigFrom({ ...acme, adminPassword: 'pw', loginPassword: false }, settings).loginPasswordEnabled).toBe(false);
    expect(() => tenantConfigFrom({ ...acme, loginPassword: true }, settings)).toThrow(/adminPassword/);
  });

  it('refuses a record that would name something wrong', () => {
    expect(() => tenantConfigFrom({ ...acme, slug: 'Acme' }, settings)).toThrow(/slug/);
    expect(() => tenantConfigFrom({ ...acme, hosts: [] }, settings)).toThrow(/host/);
    expect(() => tenantConfigFrom({ ...acme, adminEmail: 'nobody' }, settings)).toThrow(/adminEmail/);
    expect(() => tenantConfigFrom({ ...acme, gitUsername: 'x"; rm -rf /; #' }, settings)).toThrow(/gitUsername/);
    expect(() => tenantConfigFrom({ ...acme, tenantId: 'ac-me' }, settings)).toThrow(/tenantId/);
    expect(() => tenantConfigFrom({ ...acme, dbSchema: 'Public' }, settings)).toThrow(/schema name/);
    expect(() => tenantConfigFrom({ ...acme, publicBackendUrl: 'not a url' }, settings)).toThrow(/publicBackendUrl/);
  });
});

describe('StaticTenantSource', () => {
  const source = new StaticTenantSource(
    [acme, { slug: 'globex', hosts: ['globex.example.test'], adminEmail: 'o@globex.test' }],
    settings,
  );

  it('resolves a host however it is spelled: case, port, trailing dot', async () => {
    for (const host of ['acme.example.test', 'ACME.example.test', 'acme.example.test:3001', 'acme.internal.']) {
      expect((await source.resolveByHost(host))?.slug, host).toBe('acme-2');
    }
    expect((await source.resolveByHost('globex.example.test'))?.slug).toBe('globex');
    expect(await source.resolveByHost('nobody.example.test')).toBeNull();
  });

  it('describes a tenant by slug, and only a known one', async () => {
    expect((await source.describe('globex'))?.config.dbSchema).toBe('t_globex');
    expect(await source.describe('nobody')).toBeNull();
    expect(source.slugs).toEqual(['acme-2', 'globex']);
  });

  it('refuses two tenants claiming one host, or one slug listed twice', () => {
    expect(() => new StaticTenantSource([acme, { ...acme, slug: 'other' }], settings)).toThrow(/claimed by both/);
    expect(() => new StaticTenantSource([acme, { ...acme, hosts: ['x.test'] }], settings)).toThrow(/listed twice/);
  });

  describe('fromFile', () => {
    let dir: string;
    afterEach(async () => {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    });

    it('reads the tenants file', async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tenants-'));
      const file = path.join(dir, 'tenants.json');
      await fs.writeFile(file, JSON.stringify({ tenants: [acme] }));
      const fromFile = await StaticTenantSource.fromFile(file, settings);
      expect((await fromFile.resolveByHost('acme.internal'))?.slug).toBe('acme-2');
    });

    it('names the file when it is not JSON or not a tenants list', async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tenants-'));
      const file = path.join(dir, 'tenants.json');
      await fs.writeFile(file, '{ nope');
      await expect(StaticTenantSource.fromFile(file, settings)).rejects.toThrow(/not valid JSON/);
      await fs.writeFile(file, JSON.stringify({ tenants: 'x' }));
      await expect(StaticTenantSource.fromFile(file, settings)).rejects.toThrow(/"tenants" array/);
    });
  });
});

describe('tenantHostEnv', () => {
  it('reads the host facts from the same variables a single-tenant deployment uses, plus the host\'s own', () => {
    const env = tenantHostEnv({
      TENANTS_FILE: '/etc/hexis/tenants.json',
      TENANT_MASTER_KEY: 'a-master-key-that-is-long-enough-to-count-as-random',
      TENANT_IDLE_MINUTES: '5',
      DATABASE_URL: 'postgresql://u:p@db:5432/hexis',
      PORT: '4000',
      DOMAIN: 'hexis.example.test',
      WORKSPACES_ROOT: '/data/workspaces',
    });
    expect(env).toMatchObject({
      tenantsFile: '/etc/hexis/tenants.json',
      idleMinutes: 5,
      databaseUrl: 'postgresql://u:p@db:5432/hexis',
      port: 4000,
      trustProxy: '1',
      workspacesRoot: '/data/workspaces',
    });
  });

  it('is not a host without a tenants file, and refuses one without a master key', () => {
    expect(tenantHostEnv({ DATABASE_URL: 'postgresql://x' }).tenantsFile).toBeNull();
    expect(() => tenantHostEnv({ TENANTS_FILE: '/x.json', DATABASE_URL: 'postgresql://x' })).toThrow(/TENANT_MASTER_KEY/);
  });
});
