import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretsVaultRoutes } from '../secrets-vault.routes.js';
import { DbSecretsVaultService } from '../db-secrets-vault.service.js';
import { TokenCrypto } from '../../../shared/token-crypto.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { Database } from '../../database/index.js';

/**
 * A value that is empty or only whitespace is refused by each route that
 * saves a key (a person's own, a tool's per-user one, a tool's shared one)
 * and by the one that saves a tool sign-in's client secret. The routes run
 * against the REAL vault service over an in-memory `secrets` table, so a
 * refusal is the vault's own and "nothing was stored" is read from the
 * table, not inferred from the status code. What the refusal leaves behind
 * is read back through `/connect/pending`, the surface the setup banner
 * counts from.
 */

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const WRITER = 'writer@x.com';

const BLANKS: [string, string][] = [
  ['empty', ''],
  ['spaces', '   '],
  ['a tab and a newline', '\t\n '],
  ['a no-break space and an em space', '\u00A0\u2003'],
];

interface StoredRow {
  id: string;
  userId: string | null;
  key: string;
  kind: string;
  label: string | null;
  valueEncrypted: string;
  oauthMeta: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The `secrets` table as the vault's drizzle calls reach it: an upsert on
 * (user, key), the identity both unique indexes give a row, and reads that
 * answer every stored row. This suite has one person, and `statusFor`, which
 * the assertions read through, picks the caller's row and the shared row out
 * by itself. A call the vault makes that this double does not model fails
 * the request, so it cannot pass by being skipped.
 */
function secretsTable() {
  const rows: StoredRow[] = [];
  const read = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) => Promise.resolve([...rows]).then(onF, onR);
    return chain;
  };
  const insert = () => {
    let values!: Omit<StoredRow, 'id' | 'createdAt' | 'updatedAt'>;
    let set: Partial<StoredRow> = {};
    const chain = {
      values: (v: typeof values) => {
        values = v;
        return chain;
      },
      onConflictDoUpdate: (cfg: { set: Partial<StoredRow> }) => {
        set = cfg.set;
        return chain;
      },
      returning: async () => {
        const existing = rows.find((r) => r.userId === values.userId && r.key === values.key);
        if (existing) return [Object.assign(existing, set)];
        const row: StoredRow = { id: `row-${rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...values };
        rows.push(row);
        return [row];
      },
    };
    return chain;
  };
  return { db: { select: read, insert } as unknown as Database, rows };
}

const weather = {
  slug: 'weather',
  name: 'weather',
  path: 'Tools/weather.tool',
  type: 'http' as const,
  variables: [
    { name: 'API_KEY', scope: 'user' as const, label: 'Your key' },
    { name: 'SHARED_KEY', scope: 'admin' as const, label: 'Org key' },
    {
      name: 'SIGNIN',
      scope: 'user' as const,
      label: 'Weather sign-in',
      oauth: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'client-1',
      },
    },
  ],
};

let httpServer: HttpServer | undefined;

/** The routes, signed in as the tool's writer, over a fresh table; the base URL and the table. */
async function serve(): Promise<{ base: string; rows: StoredRow[] }> {
  const { db, rows } = secretsTable();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = 'user-1';
    req.userEmail = WRITER;
    next();
  });
  app.use(
    '/api',
    createSecretsVaultRoutes({
      kb: testKbContext(),
      secretsVault: new DbSecretsVaultService(db, ENC_KEY),
      toolManualService: { listAccessible: async () => [weather] } as unknown as Parameters<
        typeof createSecretsVaultRoutes
      >[0]['toolManualService'],
      accessControl: {
        canRead: async () => true,
        canWrite: async (_ws: string, email: string) => email === WRITER,
      } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['accessControl'],
      connectionProbe: {
        probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
      },
      stateSecret: 'test-secret',
      publicBackendUrl: 'http://localhost:3000',
      publicFrontendUrl: 'http://localhost:5173',
    }),
  );
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { base: `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`, rows };
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

async function send(base: string, method: 'PUT' | 'POST', path: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

interface Pending {
  tools: { slug: string; variables: { name: string; configured: boolean }[] }[];
  toolOAuth: { varName: string; ownerConfigured: boolean }[];
}

async function pending(base: string): Promise<Pending> {
  const res = await fetch(`${base}/api/connect/pending`);
  expect(res.status).toBe(200);
  return (await res.json()) as Pending;
}

const keyRow = (p: Pending, name: string) => p.tools.find((t) => t.slug === 'weather')?.variables.find((v) => v.name === name);

describe('a key that is empty or only whitespace is never saved', () => {
  it.each(BLANKS)('PUT …/vars/:var/user refuses a value that is %s, stores nothing, and the key still needs setting', async (_, value) => {
    const { base, rows } = await serve();
    const res = await send(base, 'PUT', '/secrets/tools/weather/vars/API_KEY/user', { value });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'value is required' });
    expect(rows).toEqual([]);
    expect(keyRow(await pending(base), 'API_KEY')).toMatchObject({ configured: false });
  });

  it.each(BLANKS)('PUT …/vars/:var/admin refuses a value that is %s, stores nothing, and the key still needs setting', async (_, value) => {
    const { base, rows } = await serve();
    const res = await send(base, 'PUT', '/secrets/tools/weather/vars/SHARED_KEY/admin', { value });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'value is required' });
    expect(rows).toEqual([]);
    expect(keyRow(await pending(base), 'SHARED_KEY')).toMatchObject({ configured: false });
  });

  it.each(BLANKS)('POST /secrets/static refuses a value that is %s and stores nothing', async (_, value) => {
    const { base, rows } = await serve();
    const res = await send(base, 'POST', '/secrets/static', { key: 'MY_TOKEN', value });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'value is required' });
    expect(rows).toEqual([]);
  });

  it.each(BLANKS)('PUT …/vars/:var/oauth/admin refuses a client secret that is %s, stores nothing, and the sign-in still waits on it', async (_, clientSecret) => {
    const { base, rows } = await serve();
    const res = await send(base, 'PUT', '/secrets/tools/weather/vars/SIGNIN/oauth/admin', { clientSecret });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'clientSecret is required' });
    expect(rows).toEqual([]);
    expect((await pending(base)).toolOAuth.find((o) => o.varName === 'SIGNIN')).toMatchObject({ ownerConfigured: false });
  });

  it('a real key is saved on either slot, and then counts as set', async () => {
    const { base, rows } = await serve();
    expect((await send(base, 'PUT', '/secrets/tools/weather/vars/API_KEY/user', { value: 'k-user' })).status).toBe(201);
    expect((await send(base, 'PUT', '/secrets/tools/weather/vars/SHARED_KEY/admin', { value: 'k-shared' })).status).toBe(201);
    const crypto = new TokenCrypto(ENC_KEY);
    expect(rows.map((r) => [r.userId, r.key, crypto.decrypt(r.valueEncrypted)])).toEqual([
      ['user-1', 'weather_API_KEY', 'k-user'],
      [null, 'weather_SHARED_KEY', 'k-shared'],
    ]);
    const after = await pending(base);
    expect(keyRow(after, 'API_KEY')).toMatchObject({ configured: true });
    // A shared value that is set is outstanding for nobody, so it leaves the list.
    expect(keyRow(after, 'SHARED_KEY')).toBeUndefined();
  });

  it('a real client secret is saved, and the sign-in then has its registration', async () => {
    const { base, rows } = await serve();
    expect((await send(base, 'PUT', '/secrets/tools/weather/vars/SIGNIN/oauth/admin', { clientSecret: 'cs-123' })).status).toBe(201);
    expect(rows.map((r) => [r.userId, r.key, r.kind])).toEqual([[null, 'weather_SIGNIN', 'oauth']]);
    expect((await pending(base)).toolOAuth.find((o) => o.varName === 'SIGNIN')).toMatchObject({ ownerConfigured: true });
  });
});
