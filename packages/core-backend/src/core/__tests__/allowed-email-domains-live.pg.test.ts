import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createCoreServer,
  createCoreServices,
  defaultKbTemplateDir,
  defaultStarterPacksDir,
  stopCore,
  type TenantConfig,
} from '../../index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../__tests__/pg-scratch.js';

/**
 * The SSO domain allow-list, saved on the Deployment page of the production
 * composition, governs the very next SSO sign-in of the same running server:
 * no restart, and the save does not claim one. The auth service is the one
 * every SSO provider hands its sign-in to (`loginWithSso`).
 */
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
}, PG_TEST_TIMEOUT);
afterAll(dropScratchDatabases, PG_TEST_TIMEOUT);

async function startPlatform() {
  const root = await mkdtemp(join(tmpdir(), 'allowed-domains-live-'));
  stops.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const repository = join(root, 'repository');
  await cp(defaultKbTemplateDir(), repository, { recursive: true });
  await writeFile(join(repository, 'roles.yaml'), 'roles:\n  Admin:\n    - admin@example.com\n');
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: repository });
  await git(['init', '-q', '-b', 'main']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=admin@example.com', 'commit', '-qm', 'Seed test knowledge base']);

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stops.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: TenantConfig = {
    port, databaseUrl: await scratchDatabaseUrl('hexis_allowed_domains'), dbSchema: 'public', nodeEnv: 'test',
    tenantId: 'bevel', externalApiKeyPrefix: 'bevel_', internalTokenPrefix: 'bevel-internal_',
    uploadTokenPrefix: 'bevel-upload_', mcpOAuthTokenPrefix: 'bevel-mcp_',
    workspacesRoot: join(root, 'workspaces'), backupsRoot: join(root, 'backups'),
    spillRoot: join(root, 'spills'), agentUploadsRoot: join(root, 'uploads'), docExtractCacheRoot: join(root, 'extracts'),
    jwtSecret: 'allowed-domains-test-secret', adminEmail: 'admin@example.com', adminPassword: 'test-password',
    oidcIssuerUrl: '', oidcClientId: '', oidcClientSecret: '', oidcScopes: 'openid', oidcProviderLabel: 'SSO',
    kbRepoUrl: repository, kbDirName: 'knowledge-base', gitUsername: '', gitToken: '',
    kbTemplateDir: defaultKbTemplateDir(), starterPacksDir: defaultStarterPacksDir(),
    updateCheckEnabled: false, loginPasswordEnabled: true, allowedEmailDomains: [],
    secretsEncKey: randomBytes(32).toString('base64'), internalTokenSecret: 'allowed-domains-internal-secret',
    embedSharedSecret: '', trustProxy: '', gitTimeoutMs: 30_000,
    publicBackendUrl: baseUrl, publicFrontendUrl: baseUrl, configuredPublicFrontendUrl: baseUrl,
    settingsEnv: { KB_REPO_URL: repository, DEFAULT_BRANCH: 'main', PROTECTED_BRANCHES: 'main' },
  };
  const core = await createCoreServices(config, { mirrorSharedBindings: false });
  stops.push(() => stopCore(core));
  const app = await createCoreServer(core, {}, { boot: false });
  server.on('request', app);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };
  /** A save from the Deployment page, as the admin. */
  const save = async (settings: Record<string, string>) => {
    const res = await fetch(`${baseUrl}/api/setup/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 400)).toBe(200);
    return JSON.parse(text) as { restartRequired: boolean };
  };
  return { core, save };
}

describe.skipIf(!PG_ADMIN_URL)('the SSO domain allow-list, saved on a running server', () => {
  it(
    'refuses an outsider at the next SSO sign-in after narrowing, and admits again after clearing, with no restart',
    async () => {
      const { core, save } = await startPlatform();
      // Before any list: the provider's word is enough.
      await expect(core.authService.loginWithSso('carol@email.com', 'Carol')).resolves.toBeTruthy();

      expect(await save({ allowedEmailDomains: 'example.org' })).toMatchObject({ restartRequired: false });
      await expect(core.authService.loginWithSso('alicesmith@email.com', 'Alice')).rejects.toThrow(
        /domain is not allowed/i,
      );
      // An account that already exists is refused the same way: the list is what decides.
      await expect(core.authService.loginWithSso('carol@email.com', 'Carol')).rejects.toThrow(/domain is not allowed/i);
      await expect(core.authService.loginWithSso('bob@example.org', 'Bob')).resolves.toBeTruthy();

      expect(await save({ allowedEmailDomains: 'Email.COM , example.org' })).toMatchObject({ restartRequired: false });
      await expect(core.authService.loginWithSso('alicesmith@email.com', 'Alice')).resolves.toBeTruthy();

      // Erasing the field clears the list: everyone the provider authenticates is admitted again.
      await save({ allowedEmailDomains: 'example.org' });
      await save({ allowedEmailDomains: '' });
      expect(core.settings.resolve('allowedEmailDomains')).toBe('');
      await expect(core.authService.loginWithSso('alicesmith@email.com', 'Alice')).resolves.toBeTruthy();
    },
    PG_TEST_TIMEOUT,
  );
});
