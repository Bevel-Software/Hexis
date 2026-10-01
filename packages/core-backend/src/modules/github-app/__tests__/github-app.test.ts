import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { Database } from '../../database/connection.js';
import { DeploymentSettingsService, SettingsValidationError } from '../../settings/deployment-settings.service.js';
import { GitHubAppClient, GitHubAppError, appJwt, normalizePrivateKey } from '../github-app.client.js';
import { GitHubAppConnection } from '../github-app.connection.js';
import { createGitHubAppRoutes, githubAppManifest } from '../github-app.routes.js';

const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const { privateKey: PEM, publicKey: PUBLIC } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const APP = { appId: '4242', slug: 'hexis-acme', privateKey: PEM, clientId: 'Iv1.abc', clientSecret: 'a-client-secret' };
const APP_ENV = {
  GITHUB_APP_ID: APP.appId,
  GITHUB_APP_SLUG: APP.slug,
  GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
  GITHUB_APP_CLIENT_ID: APP.clientId,
  GITHUB_APP_CLIENT_SECRET: APP.clientSecret,
};

let server: HttpServer | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

/** GitHub, as far as a suite says: what each person can reach, and every call that was made. */
function github(
  world: {
    /** The installations each person reaches. */
    installations?: Record<string, string[]>;
    /** What the INSTALLATION covers. */
    repositories?: string[];
    /** What each PERSON may do in the repositories the installation covers. Default: push, to all of them. */
    theirs?: Record<string, Record<string, 'push' | 'pull'>>;
    down?: boolean;
    /** Accepts the connection and never answers. */
    silent?: boolean;
    tokenLifeMs?: number;
    /** The time GitHub goes by, for a suite that moves the clock. */
    now?: () => number;
  } = {},
) {
  const calls: { method: string; url: string; authorization: string }[] = [];
  let issued = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const covered = () => world.repositories ?? ['acme/kb', 'acme/another'];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', url, authorization: headers.Authorization ?? '' });
    if (world.down) throw new Error('getaddrinfo ENOTFOUND api.github.com');
    if (world.silent) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      });
    }
    const theirRepositories = /\/user\/installations\/(\d+)\/repositories/.exec(url);
    if (theirRepositories) {
      const person = headers.Authorization.replace('Bearer user-token-of-', '');
      if (!(world.installations?.[person] ?? []).includes(theirRepositories[1]!)) return json(404, { message: 'Not Found' });
      const may = world.theirs?.[person] ?? Object.fromEntries(covered().map((name) => [name, 'push' as const]));
      const names = Object.keys(may);
      return json(200, {
        total_count: names.length,
        repositories: names.map((full_name) => ({
          full_name,
          private: true,
          default_branch: 'main',
          permissions: { pull: true, push: may[full_name] === 'push' },
        })),
      });
    }
    if (url.includes('/app-manifests/')) {
      return url.includes('/good-code/')
        ? json(201, { id: 4242, slug: APP.slug, pem: PEM, client_id: APP.clientId, client_secret: APP.clientSecret, owner: { login: 'acme' }, html_url: 'https://github.com/apps/hexis-acme' })
        : json(404, { message: 'Not Found' });
    }
    if (url.endsWith('/login/oauth/access_token')) {
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      return code.startsWith('code-of-') ? json(200, { access_token: `user-token-of-${code.slice(8)}` }) : json(200, { error: 'bad_verification_code' });
    }
    if (url.includes('/user/installations')) {
      const person = headers.Authorization.replace('Bearer user-token-of-', '');
      const ids = world.installations?.[person] ?? [];
      return json(200, { installations: ids.map((id) => ({ id: Number(id), account: { login: `org-of-${id}` }, repository_selection: 'selected' })) });
    }
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
      issued += 1;
      return json(201, {
        token: `installation-token-${issued}`,
        expires_at: new Date((world.now?.() ?? Date.now()) + (world.tokenLifeMs ?? 3_600_000)).toISOString(),
      });
    }
    if (url.includes('/installation/repositories')) {
      const names = covered();
      return json(200, {
        total_count: names.length,
        repositories: names.map((full_name) => ({ full_name, private: true, default_branch: 'main', permissions: { push: true } })),
      });
    }
    return json(404, { message: 'Not Found' });
  }) as typeof fetch;
  return { client: new GitHubAppClient(impl, Date.now, 150), calls, tokensIssued: () => issued };
}

function settingsWith(env: Record<string, string> = {}) {
  const rows = new Map<string, { value: string; encrypted: boolean }>();
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({
      values: (row: { key: string; value: string; encrypted: boolean }) => ({
        onConflictDoUpdate: () => {
          rows.set(row.key, { value: row.value, encrypted: row.encrypted });
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  return { settings: new DeploymentSettingsService(db, ENC_KEY, undefined, { env }), rows };
}

/** A deployment's GitHub routes, and a browser that keeps its cookies and does not follow redirects. */
function deployment(opts: { env?: Record<string, string>; world?: Parameters<typeof github>[0]; admin?: boolean; complete?: boolean } = {}) {
  const { settings, rows } = settingsWith(opts.env);
  const hub = github(opts.world);
  const connection = new GitHubAppConnection({
    read: (key) => settings.resolve(key),
    sourceOf: (key) => settings.sourceOf(key),
    client: hub.client,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userEmail = 'root@example.com';
    req.userId = 'user-1';
    next();
  });
  app.use(
    '/api',
    createGitHubAppRoutes({
      settings,
      connection,
      adminAccess: { isAdmin: async () => opts.admin ?? true } as IAdminAccessService,
      publicBackendUrl: 'https://kb.acme.test',
      publicFrontendUrl: 'https://kb.acme.test',
      isComplete: () => opts.complete ?? false,
      client: hub.client,
    }),
  );
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar = new Map<string, string>();
  const go = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      redirect: 'manual',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, value = ''] = pair!.split('=');
      if (!value || /Expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name!);
      else jar.set(name!, value);
    }
    return res;
  };
  const stateOf = (location: string | null) => new URL(location!).searchParams.get('state')!;
  return { go, settings, rows, connection, hub, stateOf, jar };
}

describe('the JWT an app presents as itself', () => {
  it('is signed with the app key, names the app, and is good for minutes', () => {
    const now = Date.parse('2026-09-29T10:00:00Z');
    const [header, claims, signature] = appJwt(APP, now).split('.');
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).end().verify(PUBLIC, signature!, 'base64url')).toBe(true);
    const read = JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8')) as { iss: string; iat: number; exp: number };
    expect(read.iss).toBe('4242');
    // Issued a minute back, for a clock that runs ahead of GitHub's.
    expect(read.iat).toBe(now / 1000 - 60);
    expect(read.exp - now / 1000).toBeLessThanOrEqual(600);
  });

  it.each([
    ['as issued', PEM],
    ['with its line breaks written out, as an environment file holds it', PEM.replace(/\n/g, '\\n')],
    ['in base64', Buffer.from(PEM).toString('base64')],
  ])('reads the key %s', (_how, key) => {
    expect(normalizePrivateKey(key).trim()).toBe(PEM.trim());
    expect(() => appJwt({ appId: '1', privateKey: key })).not.toThrow();
  });

  it('says the key could not be read, without quoting it', () => {
    const err = (() => {
      try {
        appJwt({ appId: '1', privateKey: 'not-a-key-but-a-secret' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(GitHubAppError);
    expect((err as Error).message).not.toContain('not-a-key-but-a-secret');
  });
});

describe('what the settings keep for the deployment itself', () => {
  it('refuses them from a save, the way it refuses a setting that does not exist', async () => {
    const { settings } = settingsWith();
    for (const key of ['githubInstallationId', 'githubAppId', 'githubAppPrivateKey', 'githubAppStateTag']) {
      const err = await settings.save({ [key]: '42' }, 'user-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SettingsValidationError);
      expect((err as SettingsValidationError).problems).toEqual({ [key]: 'Unknown setting.' });
      expect(settings.resolve(key)).toBe('');
    }
  });

  it('never tells the setup screen about them', () => {
    const { settings } = settingsWith(APP_ENV);
    const told = settings.describe().map((s) => s.key);
    expect(told).toContain('githubRepository');
    expect(told.filter((key) => key.startsWith('githubApp') || key.startsWith('githubInstallation'))).toEqual([]);
  });

  it('stores the key it was issued encrypted', async () => {
    const { settings, rows } = settingsWith();
    await settings.record({ githubAppPrivateKey: PEM, githubAppId: '4242' }, null);
    expect(rows.get('githubAppPrivateKey')).toMatchObject({ encrypted: true });
    expect(rows.get('githubAppPrivateKey')!.value).not.toContain('PRIVATE KEY');
    expect(settings.resolve('githubAppPrivateKey')).toBe(PEM.trim());
  });
});

describe('GitHubAppConnection: the token git presents', () => {
  function connected(world: Parameters<typeof github>[0] = {}, clock = { now: Date.now() }) {
    const values: Record<string, string> = {
      ...Object.fromEntries(Object.entries(APP).map(([k, v]) => [`githubApp${k[0]!.toUpperCase()}${k.slice(1)}`, v])),
      githubAppId: APP.appId,
      githubInstallationId: '77',
      githubRepository: 'acme/kb',
      githubRepositoriesPermitted: 'acme/kb',
    };
    world.now = () => clock.now;
    const hub = github(world);
    const connection = new GitHubAppConnection({
      read: (key) => values[key] ?? '',
      sourceOf: () => 'stored',
      client: hub.client,
      now: () => clock.now,
    });
    return { connection, hub, values, clock };
  }

  it('has none until it is asked for, then the one GitHub issued for the installation', async () => {
    const { connection, hub } = connected();
    expect(connection.token()).toBeNull();
    await connection.prepare();
    expect(connection.token()).toBe('installation-token-1');
    expect(hub.calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://api.github.com/app/installations/77/access_tokens' });
    expect(connection.url()).toBe('https://github.com/acme/kb.git');
    expect(connection.answered()).toBe(true);
  });

  /** What a renewal started in the background has come to. */
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

  it('asks nothing while the one in hand has time to spare', async () => {
    const { connection, hub, clock } = connected();
    await connection.prepare();
    await connection.prepare();
    clock.now += 45 * 60_000;
    await connection.prepare();
    expect(hub.tokensIssued()).toBe(1);
  });

  /**
   * This runs before every git call, the ones that never leave the disk
   * included. A token that is still good is not a reason to wait.
   */
  it('renews one that is close to running out without making the call wait', async () => {
    const world: Parameters<typeof github>[0] = {};
    const { connection, hub, clock } = connected(world);
    await connection.prepare();
    clock.now += 51 * 60_000;
    // GitHub stops answering: a call that waited would wait for the deadline.
    world.silent = true;
    const started = Date.now();
    await connection.prepare();
    expect(Date.now() - started).toBeLessThan(100);
    expect(connection.token()).toBe('installation-token-1');
    world.silent = false;
    await new Promise((resolve) => setTimeout(resolve, 200));

    // And once GitHub answers, the next call carries the new one.
    clock.now += 10_000;
    await connection.prepare();
    await settled();
    expect(hub.tokensIssued()).toBe(2);
    expect(connection.token()).toBe('installation-token-2');
  });

  it('gives a request to GitHub a deadline of its own', async () => {
    const { connection } = connected({ silent: true });
    const started = Date.now();
    await expect(connection.prepare()).rejects.toBeInstanceOf(GitHubAppError);
    // The suite's client is given 150 ms; left to the platform it is minutes.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(connection.token()).toBeNull();
  });

  it('remembers that GitHub gave none, for a while that grows, and asks nothing inside it', async () => {
    const world: Parameters<typeof github>[0] = { down: true };
    const { connection, hub, clock } = connected(world);
    await expect(connection.prepare()).rejects.toBeInstanceOf(GitHubAppError);
    expect(hub.calls).toHaveLength(1);

    // Every git call in the meantime goes ahead at once, with no token.
    for (let i = 0; i < 20; i += 1) await connection.prepare();
    expect(hub.calls).toHaveLength(1);
    expect(connection.token()).toBeNull();

    // Five seconds the first time, ten the second.
    clock.now += 5_001;
    await expect(connection.prepare()).rejects.toBeInstanceOf(GitHubAppError);
    expect(hub.calls).toHaveLength(2);
    clock.now += 5_001;
    await connection.prepare();
    expect(hub.calls).toHaveLength(2);
    clock.now += 5_000;
    await expect(connection.prepare()).rejects.toBeInstanceOf(GitHubAppError);
    expect(hub.calls).toHaveLength(3);

    // GitHub is back: the next ask gets a token, and nothing is remembered.
    world.down = false;
    clock.now += 20_001;
    await connection.prepare();
    expect(connection.token()).toBe('installation-token-1');
  });

  it('asks whatever it remembers when an admin is waiting on the answer', async () => {
    const world: Parameters<typeof github>[0] = { down: true };
    const { connection, hub } = connected(world);
    await expect(connection.prepare()).rejects.toBeInstanceOf(GitHubAppError);
    await expect(connection.prepare({ asked: true })).rejects.toBeInstanceOf(GitHubAppError);
    expect(hub.calls).toHaveLength(2);
    world.down = false;
    await connection.prepare({ asked: true });
    expect(connection.token()).toBe('installation-token-1');
  });

  it('asks once for every git call that arrives while it is renewing', async () => {
    const { connection, hub } = connected();
    await Promise.all([connection.prepare(), connection.prepare(), connection.prepare()]);
    expect(hub.tokensIssued()).toBe(1);
  });

  it('never presents a token that has run out', async () => {
    const { connection, clock } = connected({ tokenLifeMs: 60_000 });
    await connection.prepare();
    clock.now += 61_000;
    expect(connection.token()).toBeNull();
  });

  it('never presents one installation its token to another', async () => {
    const { connection, values, hub } = connected();
    await connection.prepare();
    values.githubInstallationId = '88';
    expect(connection.token()).toBeNull();
    await connection.prepare();
    expect(hub.calls.at(-1)!.url).toContain('/installations/88/');
    expect(connection.token()).toBe('installation-token-2');
  });

  it('keeps the token it has when GitHub will not renew it', async () => {
    const world: Parameters<typeof github>[0] = {};
    const { connection, clock } = connected(world);
    await connection.prepare();
    world.down = true;
    clock.now += 55 * 60_000;
    await connection.prepare();
    await settled();
    expect(connection.token()).toBe('installation-token-1');
  });
});

describe('GitHubAppConnection: what the deployment may be pointed at', () => {
  function connected(permitted: string, installationFrom: 'env' | 'stored' = 'stored', world: Parameters<typeof github>[0] = {}) {
    const values: Record<string, string> = {
      githubAppId: APP.appId,
      githubAppSlug: APP.slug,
      githubAppPrivateKey: APP.privateKey,
      githubAppClientId: APP.clientId,
      githubAppClientSecret: APP.clientSecret,
      githubInstallationId: '77',
      githubRepositoriesPermitted: permitted,
    };
    const hub = github(world);
    return new GitHubAppConnection({
      read: (key) => values[key] ?? '',
      sourceOf: (key) => (key === 'githubInstallationId' ? installationFrom : 'stored'),
      client: hub.client,
    });
  }

  it('is what the person who connected it could push to, whatever case it is written in', () => {
    const connection = connected('acme/kb\nAcme/Website');
    expect(connection.permits('acme/kb')).toBe(true);
    expect(connection.permits('ACME/website')).toBe(true);
    expect(connection.permits('acme/secrets')).toBe(false);
    expect(connection.permits('acme/kb-private')).toBe(false);
    expect(connection.permits('')).toBe(false);
  });

  it('is nothing when nobody was shown to be able to push to anything', () => {
    expect(connected('').permits('acme/kb')).toBe(false);
  });

  it('is everything the installation reaches when the operator supplied the installation', () => {
    expect(connected('', 'env').permits('acme/anything')).toBe(true);
  });

  it('lists what the installation covers AND the person could push to, never the rest', async () => {
    const world = { repositories: ['acme/kb', 'acme/payroll', 'acme/secrets'] };
    expect((await connected('acme/kb\nacme/gone-since', 'stored', world).repositories()).repositories.map((r) => r.fullName)).toEqual([
      'acme/kb',
    ]);
    expect((await connected('', 'env', world).repositories()).repositories.map((r) => r.fullName)).toEqual([
      'acme/kb',
      'acme/payroll',
      'acme/secrets',
    ]);
  });

  it('asks GitHub nothing while there is no app or no installation', async () => {
    const hub = github();
    const connection = new GitHubAppConnection({ read: () => '', sourceOf: () => 'unset', client: hub.client });
    await connection.prepare();
    expect(hub.calls).toEqual([]);
    expect(connection.answered()).toBe(false);
    expect(connection.registeredBy()).toBeNull();
  });
});

describe('registering a deployment its own GitHub App', () => {
  it('asks for the contents of the repositories it is installed on, and nothing else', () => {
    const manifest = githubAppManifest('https://kb.acme.test', 'https://kb.acme.test');
    expect(manifest).toMatchObject({
      name: 'Hexis kb.acme.test',
      public: false,
      default_permissions: { contents: 'write', metadata: 'read' },
      default_events: [],
      redirect_url: 'https://kb.acme.test/api/setup/github-app/registered',
      callback_urls: ['https://kb.acme.test/api/setup/github-app/callback'],
      request_oauth_on_install: true,
    });
    expect(manifest).not.toHaveProperty('hook_attributes');
    const long = githubAppManifest('https://x.test', 'https://a-very-long-host-name.knowledge.example.test');
    expect(String(long.name).length).toBeLessThanOrEqual(34);
  });

  it('hands the browser the manifest and where to post it, for a person or an organisation', async () => {
    const { go, stateOf, jar } = deployment();
    const personal = (await (await go('/api/setup/github-app/manifest', { method: 'POST', body: '{}' })).json()) as { action: string; manifest: unknown };
    expect(personal.action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    expect(stateOf(personal.action)).toBe(decodeURIComponent(jar.get('hexis_github_state')!));
    const org = (await (await go('/api/setup/github-app/manifest', { method: 'POST', body: JSON.stringify({ organization: 'acme-inc' }) })).json()) as { action: string };
    expect(org.action).toMatch(/^https:\/\/github\.com\/organizations\/acme-inc\/settings\/apps\/new\?state=/);
    const bad = await go('/api/setup/github-app/manifest', { method: 'POST', body: JSON.stringify({ organization: 'acme/../evil' }) });
    expect(bad.status).toBe(400);
  });

  it('keeps what GitHub issued and goes straight on to installing the app', async () => {
    const { go, stateOf, settings, connection, rows } = deployment();
    const { action } = (await (await go('/api/setup/github-app/manifest', { method: 'POST', body: '{}' })).json()) as { action: string };
    const back = await go(`/api/setup/github-app/registered?code=good-code&state=${encodeURIComponent(stateOf(action))}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toMatch(/^https:\/\/github\.com\/apps\/hexis-acme\/installations\/new\?state=/);
    expect(connection.credentials()).toMatchObject({ appId: '4242', slug: 'hexis-acme', clientId: 'Iv1.abc' });
    expect(connection.registeredBy()).toBe('setup');
    expect(rows.get('githubAppPrivateKey')?.encrypted).toBe(true);
    expect(rows.get('githubAppClientSecret')?.encrypted).toBe(true);
    expect(settings.resolve('githubAppSlug')).toBe('hexis-acme');
  });

  it('spends the state on every return, however the return ends', async () => {
    for (const query of ['code=good-code', 'code=stale', '']) {
      const { go, stateOf, jar } = deployment();
      const { action } = (await (await go('/api/setup/github-app/manifest', { method: 'POST', body: '{}' })).json()) as { action: string };
      const state = stateOf(action);
      const back = await go(`/api/setup/github-app/registered?${query}&state=${encodeURIComponent(state)}`);
      // Going on to install is a round trip of its own, with a state of its own.
      const kept = jar.get('hexis_github_state');
      expect(kept === undefined || decodeURIComponent(kept) !== state, query).toBe(true);
      if (!back.headers.get('location')!.startsWith('https://github.com/')) expect(kept, query).toBeUndefined();
      server?.close();
      server = null;
    }
  });

  it('starts nothing from a link: what starts a round trip is a POST', async () => {
    const { go, jar } = deployment({ env: APP_ENV });
    const followed = await go('/api/setup/github-app/install');
    expect(followed.status).toBe(404);
    expect(jar.size).toBe(0);
  });

  it('registers nothing for a browser that was not sent, or a code GitHub does not know', async () => {
    const { go, stateOf, connection } = deployment();
    const stranger = await go('/api/setup/github-app/registered?code=good-code&state=made-up');
    expect(stranger.headers.get('location')).toBe('https://kb.acme.test/?github=state');
    const { action } = (await (await go('/api/setup/github-app/manifest', { method: 'POST', body: '{}' })).json()) as { action: string };
    const unknown = await go(`/api/setup/github-app/registered?code=stale&state=${encodeURIComponent(stateOf(action))}`);
    expect(unknown.headers.get('location')).toBe('https://kb.acme.test/?github=refused');
    expect(connection.credentials()).toBeNull();
  });

  it('offers no registration to a deployment whose operator supplied the app', async () => {
    const { go, connection } = deployment({ env: APP_ENV });
    expect(connection.registeredBy()).toBe('environment');
    expect((await go('/api/setup/github-app/manifest', { method: 'POST', body: '{}' })).status).toBe(409);
    const status = (await (await go('/api/setup/github-app')).json()) as Record<string, unknown>;
    expect(status).toEqual({
      registeredBy: 'environment',
      app: { slug: 'hexis-acme', url: 'https://github.com/apps/hexis-acme' },
      installation: null,
      repository: null,
    });
  });
});

describe('installing the app, and whose installation it is', () => {
  const world = { installations: { ada: ['77'], mallory: ['99'] } };

  async function sentToInstall(d: ReturnType<typeof deployment>) {
    const out = await d.go('/api/setup/github-app/install', { method: 'POST', body: '{}' });
    const { url } = (await out.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/github\.com\/apps\/hexis-acme\/installations\/new\?state=/);
    return d.stateOf(url);
  }
  const cameBackAs = (d: ReturnType<typeof deployment>, person: string, state: string, installation = '77') =>
    d.go(`/api/setup/github-app/callback?code=code-of-${person}&installation_id=${installation}&setup_action=install&state=${encodeURIComponent(state)}`);

  it('records the installation, and what the person who connected it can push to', async () => {
    const d = deployment({ env: APP_ENV, world });
    const state = await sentToInstall(d);
    const back = await cameBackAs(d, 'ada', state);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=connected');
    expect(d.settings.resolve('githubInstallationId')).toBe('77');
    expect(d.settings.resolve('githubInstallationAccount')).toBe('org-of-77');
    expect(d.settings.resolve('githubRepositoriesPermitted').split('\n')).toEqual(['acme/another', 'acme/kb']);
    // The state is spent with the round trip.
    expect(d.jar.has('hexis_github_state')).toBe(false);
  });

  /**
   * GitHub counts an installation among a person's when they can READ one
   * repository it covers. Organisation X installed the app for its own
   * workspace; Eve, who may read X's handbook, opens a workspace of her own
   * and comes back naming X's installation. The installation's token reads
   * and writes everything X gave the app. What Eve may point her workspace
   * at is what her own account could push to: nothing.
   */
  it('gives someone who can only read what the installation covers nothing at all', async () => {
    const d = deployment({
      env: APP_ENV,
      world: {
        installations: { eve: ['77'] },
        repositories: ['x/handbook', 'x/payroll', 'x/secrets'],
        theirs: { eve: { 'x/handbook': 'pull' } },
      },
    });
    const state = await sentToInstall(d);
    const back = await cameBackAs(d, 'eve', state);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=nothing-to-write');
    expect(d.settings.resolve('githubInstallationId')).toBe('');
    expect(d.settings.resolve('githubRepositoriesPermitted')).toBe('');
    // No token for the installation was ever asked for, so nothing of X's was listed.
    expect(d.hub.tokensIssued()).toBe(0);
    expect((await d.go('/api/setup/github-app/repositories')).status).toBe(409);
  });

  it('offers someone who can push to one repository that one, and nothing else the installation covers', async () => {
    const d = deployment({
      env: APP_ENV,
      world: {
        installations: { bo: ['77'] },
        repositories: ['x/docs', 'x/handbook', 'x/payroll'],
        theirs: { bo: { 'x/docs': 'push', 'x/handbook': 'pull' } },
      },
    });
    const state = await sentToInstall(d);
    expect((await cameBackAs(d, 'bo', state)).headers.get('location')).toBe('https://kb.acme.test/?github=connected');
    expect(d.settings.resolve('githubRepositoriesPermitted')).toBe('x/docs');
    const listed = (await (await d.go('/api/setup/github-app/repositories')).json()) as { repositories: { fullName: string }[] };
    expect(listed.repositories.map((r) => r.fullName)).toEqual(['x/docs']);
    expect(d.connection.permits('x/payroll')).toBe(false);
    expect(d.connection.permits('x/handbook')).toBe(false);
  });

  it('brings what may be connected up to date when GitHub is connected again', async () => {
    const theirs: Record<string, Record<string, 'push' | 'pull'>> = { ada: { 'acme/kb': 'push' } };
    const d = deployment({ env: APP_ENV, world: { installations: { ada: ['77'] }, theirs } });
    await cameBackAs(d, 'ada', await sentToInstall(d));
    expect(d.settings.resolve('githubRepositoriesPermitted')).toBe('acme/kb');
    theirs.ada = { 'acme/another': 'push' };
    await cameBackAs(d, 'ada', await sentToInstall(d));
    expect(d.settings.resolve('githubRepositoriesPermitted')).toBe('acme/another');
  });

  /**
   * With one app serving many deployments, the number on the address is the
   * only thing between a deployment and another organisation's repositories.
   * Mallory installs the app on her own account, then comes back naming Ada's.
   */
  it('refuses an installation the person cannot reach, whatever the address says', async () => {
    const d = deployment({ env: APP_ENV, world });
    const state = await sentToInstall(d);
    const back = await d.go(`/api/setup/github-app/callback?code=code-of-mallory&installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=not-yours');
    expect(d.settings.resolve('githubInstallationId')).toBe('');
    expect(d.hub.tokensIssued()).toBe(0);
  });

  it.each([
    ['no sign-in came back with it', 'installation_id=77&setup_action=install', 'refused'],
    ['GitHub does not know the sign-in', 'code=made-up&installation_id=77&setup_action=install', 'refused'],
    ['the installation is not a number', 'code=code-of-ada&installation_id=77%2F..%2F99&setup_action=install', 'refused'],
    ['it was only requested of an owner', 'code=code-of-ada&installation_id=77&setup_action=request', 'requested'],
  ])('records nothing when %s', async (_why, query, outcome) => {
    const d = deployment({ env: APP_ENV, world });
    const state = await sentToInstall(d);
    const back = await d.go(`/api/setup/github-app/callback?${query}&state=${encodeURIComponent(state)}`);
    expect(back.headers.get('location')).toBe(`https://kb.acme.test/?github=${outcome}`);
    expect(d.settings.resolve('githubInstallationId')).toBe('');
  });

  it('records nothing for a browser that was not sent', async () => {
    const d = deployment({ env: APP_ENV, world });
    const back = await d.go('/api/setup/github-app/callback?code=code-of-ada&installation_id=77&setup_action=install&state=made-up');
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=state');
    expect(d.settings.resolve('githubInstallationId')).toBe('');
    expect(d.hub.calls).toEqual([]);
  });

  it('says GitHub could not be reached, when that is what happened', async () => {
    const d = deployment({ env: APP_ENV, world: { ...world, down: true } });
    const state = await sentToInstall(d);
    const back = await d.go(`/api/setup/github-app/callback?code=code-of-ada&installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=unreachable');
  });

  it('comes back to the Deployment page on a deployment that is set up', async () => {
    const d = deployment({ env: APP_ENV, world, complete: true });
    const state = await sentToInstall(d);
    const back = await d.go(`/api/setup/github-app/callback?code=code-of-ada&installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/deployment?github=connected');
  });

  it('puts the tag of a host that serves several deployments in front of the state', async () => {
    const d = deployment({ env: { ...APP_ENV, GITHUB_APP_STATE_TAG: 'acme' }, world });
    const state = await sentToInstall(d);
    expect(state).toMatch(/^acme\.[A-Za-z0-9_-]{20,}$/);
    const back = await d.go(`/api/setup/github-app/callback?code=code-of-ada&installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=connected');
  });
});

describe('the repositories an installation reaches', () => {
  it('lists them by name, with the installation token', async () => {
    const d = deployment({ env: { ...APP_ENV, GITHUB_APP_INSTALLATION_ID: '77' }, world: { repositories: ['acme/zeta', 'acme/kb'] } });
    const res = await d.go('/api/setup/github-app/repositories');
    expect(await res.json()).toEqual({
      repositories: [
        { fullName: 'acme/kb', private: true, defaultBranch: 'main', writable: true },
        { fullName: 'acme/zeta', private: true, defaultBranch: 'main', writable: true },
      ],
      more: false,
    });
    expect(d.hub.calls.at(-1)!.authorization).toBe('Bearer installation-token-1');
  });

  it('asks for the connection first on a deployment that has none', async () => {
    const d = deployment({ env: APP_ENV });
    expect((await d.go('/api/setup/github-app/repositories')).status).toBe(409);
    expect(d.hub.calls).toEqual([]);
  });

  it('says so when GitHub cannot be reached', async () => {
    const d = deployment({ env: { ...APP_ENV, GITHUB_APP_INSTALLATION_ID: '77' }, world: { down: true } });
    const res = await d.go('/api/setup/github-app/repositories');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not be reached/);
  });
});

/**
 * Installing comes back once. With the app installed, the address that
 * installs it opens the installation's settings on GitHub, and GitHub sends
 * nobody back from there: a repository added on that page was reached by the
 * app and never offered. So what may be connected is read again by a sign-in
 * alone, which comes back with a code and names no installation.
 */
describe('reading again what may be connected', () => {
  async function sentTo(d: ReturnType<typeof deployment>, path: string) {
    const out = await d.go(path, { method: 'POST', body: '{}' });
    const { url } = (await out.json()) as { url: string };
    return { url, state: d.stateOf(url) };
  }
  const installedAs = async (d: ReturnType<typeof deployment>, person: string) => {
    const { state } = await sentTo(d, '/api/setup/github-app/install');
    await d.go(`/api/setup/github-app/callback?code=code-of-${person}&installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`);
  };
  const signedInAs = (d: ReturnType<typeof deployment>, person: string, state: string) =>
    d.go(`/api/setup/github-app/callback?code=code-of-${person}&state=${encodeURIComponent(state)}`);

  it('sends the browser to sign in with the app, and nowhere that installs anything', async () => {
    const d = deployment({ env: APP_ENV });
    const { url } = await sentTo(d, '/api/setup/github-app/refresh');
    const address = new URL(url);
    expect(`${address.origin}${address.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(address.searchParams.get('client_id')).toBe(APP.clientId);
    expect(address.searchParams.get('state')).toBeTruthy();
    expect(d.hub.calls).toEqual([]);
  });

  it('offers a repository that was added to the installation on GitHub since', async () => {
    const world = {
      installations: { ada: ['77'] },
      repositories: ['acme/kb'],
      theirs: { ada: { 'acme/kb': 'push' as const } } as Record<string, Record<string, 'push' | 'pull'>>,
    };
    const d = deployment({ env: APP_ENV, world });
    await installedAs(d, 'ada');
    const listed = async () =>
      ((await (await d.go('/api/setup/github-app/repositories')).json()) as { repositories: { fullName: string }[] }).repositories.map((r) => r.fullName);
    expect(await listed()).toEqual(['acme/kb']);

    // Added on the installation's settings page, from which nobody is sent back.
    world.repositories = ['acme/kb', 'acme/handbook'];
    world.theirs = { ada: { 'acme/kb': 'push', 'acme/handbook': 'push' } };
    // The app reaches it, and it is not offered: it was not there when Ada connected.
    expect(await listed()).toEqual(['acme/kb']);

    const { state } = await sentTo(d, '/api/setup/github-app/refresh');
    const back = await signedInAs(d, 'ada', state);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=refreshed');
    expect(await listed()).toEqual(['acme/handbook', 'acme/kb']);
    expect(d.settings.resolve('githubInstallationId')).toBe('77');
    expect(d.jar.has('hexis_github_state')).toBe(false);
  });

  it('is asked of the person who came back, about the installation the deployment has', async () => {
    const d = deployment({ env: APP_ENV, world: { installations: { ada: ['77'], mallory: ['99'] } } });
    await installedAs(d, 'ada');
    const before = d.settings.resolve('githubRepositoriesPermitted');
    const { state } = await sentTo(d, '/api/setup/github-app/refresh');
    // Mallory reaches another installation of the app, and not this one.
    const back = await signedInAs(d, 'mallory', state);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=not-yours');
    expect(d.settings.resolve('githubInstallationId')).toBe('77');
    expect(d.settings.resolve('githubRepositoriesPermitted')).toBe(before);
  });

  it('keeps what was permitted when the person who came back can push to nothing', async () => {
    const world = {
      installations: { ada: ['77'], rita: ['77'] },
      theirs: { rita: { 'acme/kb': 'pull' as const } } as Record<string, Record<string, 'push' | 'pull'>>,
    };
    const d = deployment({ env: APP_ENV, world });
    await installedAs(d, 'ada');
    const before = d.settings.resolve('githubRepositoriesPermitted');
    const { state } = await sentTo(d, '/api/setup/github-app/refresh');
    const back = await signedInAs(d, 'rita', state);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=nothing-to-write');
    expect(d.settings.resolve('githubRepositoriesPermitted')).toBe(before);
  });

  /**
   * Someone without the right to install asked an owner, who approved it
   * later in a browser of their own: the app is installed, and this
   * deployment was never told. A sign-in finds it.
   */
  it('finds an installation this browser never came back from, when there is one', async () => {
    const d = deployment({ env: APP_ENV, world: { installations: { ada: ['77'] } } });
    const { state } = await sentTo(d, '/api/setup/github-app/refresh');
    const back = await signedInAs(d, 'ada', state);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=refreshed');
    expect(d.settings.resolve('githubInstallationId')).toBe('77');
    expect(d.settings.resolve('githubRepositoriesPermitted').split('\n')).toEqual(['acme/another', 'acme/kb']);
  });

  it('chooses none of several, and says there is none when there is none', async () => {
    const several = deployment({ env: APP_ENV, world: { installations: { ada: ['77', '78'] } } });
    let trip = await sentTo(several, '/api/setup/github-app/refresh');
    expect((await signedInAs(several, 'ada', trip.state)).headers.get('location')).toBe('https://kb.acme.test/?github=several');
    expect(several.settings.resolve('githubInstallationId')).toBe('');

    const none = deployment({ env: APP_ENV, world: { installations: {} } });
    trip = await sentTo(none, '/api/setup/github-app/refresh');
    expect((await signedInAs(none, 'ada', trip.state)).headers.get('location')).toBe('https://kb.acme.test/?github=not-installed');
    expect(none.settings.resolve('githubInstallationId')).toBe('');
  });

  it('reads nothing for a browser that was not sent, and refuses an installation that is not a number', async () => {
    const d = deployment({ env: APP_ENV, world: { installations: { ada: ['77'] } } });
    expect((await signedInAs(d, 'ada', 'made-up')).headers.get('location')).toBe('https://kb.acme.test/?github=state');
    const { state } = await sentTo(d, '/api/setup/github-app/refresh');
    const back = await d.go(`/api/setup/github-app/callback?code=code-of-ada&installation_id=7x7&state=${encodeURIComponent(state)}`);
    expect(back.headers.get('location')).toBe('https://kb.acme.test/?github=refused');
    expect(d.hub.calls).toEqual([]);
  });

  it('is not offered to a deployment that has no app', async () => {
    const d = deployment();
    expect((await d.go('/api/setup/github-app/refresh', { method: 'POST', body: '{}' })).status).toBe(409);
    expect(d.jar.size).toBe(0);
  });
});

describe('who these routes answer', () => {
  it('answers admins only, and starts nothing for anyone else', async () => {
    const d = deployment({ env: APP_ENV, admin: false });
    for (const [method, path] of [
      ['GET', '/api/setup/github-app'],
      ['POST', '/api/setup/github-app/manifest'],
      ['POST', '/api/setup/github-app/install'],
      ['POST', '/api/setup/github-app/refresh'],
      ['GET', '/api/setup/github-app/callback?code=code-of-ada&installation_id=77&state=x'],
      ['GET', '/api/setup/github-app/repositories'],
    ] as const) {
      expect((await d.go(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status, path).toBe(403);
    }
    expect(d.hub.calls).toEqual([]);
    expect(d.jar.size).toBe(0);
  });
});
