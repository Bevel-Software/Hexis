import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { createAccessRoutes } from '../access.routes.js';
import type { Database } from '../../database/connection.js';
import { usersDbDouble } from './users-db-double.js';

/**
 * A grant to an email with NO ACCOUNT says so, and stays allowed.
 *
 * Under single sign-on an account exists only after the first sign-in, so
 * granting ahead of time is a real use case — nothing here refuses it. What
 * the routes owe the share dialog is the fact: `hasAccount` on every person
 * in the access view and in a suggestion, so the dialog can label the chip
 * and the row "hasn't signed in yet". The three cases the ticket names are
 * each pinned below: a known email, an unknown one, and one that becomes
 * known once that person signs in.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'alice/feature';
const KB = 'knowledge-base';

const KNOWN = { name: 'Alice', email: 'alice@bevel.software' };
const UNKNOWN = { name: 'new.colleague', email: 'new.colleague@company.com' };

async function makeHarness(opts: {
  /** People named in the access rules (whether or not they have an account). */
  granted?: { name: string; email: string }[];
  /** Emails that have SIGNED IN — the `users` table. */
  accounts?: string[];
  /** People the knowledge base knows of, for the suggest route. */
  kbPeople?: { name: string; email: string }[];
  /** Override the users database — to stand in a lookup that is DOWN. */
  db?: Database;
}): Promise<{ server: Server; baseUrl: string; files: Map<string, string> }> {
  const files = new Map<string, string>();
  const granted = opts.granted ?? [];

  const accessControl = {
    canWrite: vi.fn(async () => true),
    canRead: vi.fn(async () => true),
    canDownload: vi.fn(async () => false),
    canOwner: vi.fn(async () => false),
    grantSources: vi.fn(async () => ({ read: [{ kind: 'direct' }] })),
    invalidate: vi.fn(),
    kbPrincipals: vi.fn(async () => ({ roles: [], groups: [], people: opts.kbPeople ?? [] })),
    eligibleWriters: vi.fn(async () => ({ roles: [], users: granted })),
    eligibleReaders: vi.fn(async () => ({ restricted: true, roles: [], users: granted })),
    eligibleOwners: vi.fn(async () => ({ roles: [], users: [] })),
    eligibleDownloaders: vi.fn(async () => ({ roles: [], users: [] })),
  } as unknown as IAccessControl;

  const workspaceService = {
    withPathTurn: async (_id: string, _p: string, op: () => Promise<unknown>) => op(),
    getOrCreateForBranch: vi.fn(async () => ({ id: WS, name: WS, kbDirName: KB })),
    readFile: vi.fn(async (_id: string, wsRel: string) => {
      const v = files.get(wsRel);
      if (v === undefined) {
        const err = new Error(`ENOENT ${wsRel}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    }),
    readFileBinary: vi.fn(async (_id: string, wsRel: string) =>
      Buffer.from(
        await (workspaceService.readFile as (id: string, p: string) => Promise<string>)(_id, wsRel),
        'utf-8',
      ),
    ),
    writeFile: vi.fn(async (_id: string, wsRel: string, content: string) => {
      files.set(wsRel, content);
    }),
  } as unknown as WorkspaceService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;
  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({ acquired: true, lock: {} })),
    releaseLock: vi.fn(async () => undefined),
    releaseLockNoCommit: vi.fn(async () => undefined),
  } as unknown as WorkflowService;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createAccessRoutes(
      accessControl,
      workspaceService,
      authService,
      workflowService,
      { emit: vi.fn() } as unknown as WorkflowEventBus,
      opts.db ?? usersDbDouble(opts.accounts ?? []),
      KB,
    ),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, files };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('a grant to an email with no account', () => {
  let h: Awaited<ReturnType<typeof makeHarness>> | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  const view = async () =>
    fetch(
      `${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access?path=${encodeURIComponent(`${KB}/Sales`)}&kind=folder`,
    );

  const grantRead = (email: string, displayName: string) =>
    fetch(`${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: `${KB}/Sales`,
        kind: 'folder',
        verb: 'read',
        principal: { kind: 'user', email, displayName },
      }),
    });

  it('saves the grant — an email with no account is accepted, written and labelled', async () => {
    // `granted` is the resolver's answer AFTER the splice: the grant route
    // writes the file, and the view it returns comes from the resolver.
    h = await makeHarness({ granted: [UNKNOWN], accounts: [KNOWN.email] });

    const res = await grantRead(UNKNOWN.email, UNKNOWN.name);
    expect(res.status).toBe(200);
    // Written, verbatim, to the same place a known email would be — no
    // refusal, no rewriting, nothing conditional on the account existing.
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain(UNKNOWN.email);

    // And the view that same response returns already carries the label, so
    // the dialog can show it without a second round trip.
    const body = (await res.json()) as {
      readers: { users: { email: string; hasAccount: boolean }[] };
    };
    expect(body.readers.users).toEqual([{ ...UNKNOWN, hasAccount: false }]);
  });

  it('marks a KNOWN email as having an account', async () => {
    h = await makeHarness({ granted: [KNOWN], accounts: [KNOWN.email] });

    const body = (await (await view()).json()) as {
      readers: { users: { email: string; hasAccount: boolean }[] };
      eligible: { users: { email: string; hasAccount: boolean }[] };
    };
    expect(body.readers.users).toEqual([{ ...KNOWN, hasAccount: true }]);
    // Every list the dialog reads says the same thing about the same person.
    expect(body.eligible.users).toEqual([{ ...KNOWN, hasAccount: true }]);
  });

  it('marks an UNKNOWN email as having no account, without dropping them from any list', async () => {
    h = await makeHarness({ granted: [KNOWN, UNKNOWN], accounts: [KNOWN.email] });

    const body = (await (await view()).json()) as {
      readers: { users: { email: string; hasAccount: boolean }[] };
      eligible: { users: { email: string; hasAccount: boolean }[] };
    };
    expect(body.readers.users).toEqual([
      { ...KNOWN, hasAccount: true },
      { ...UNKNOWN, hasAccount: false },
    ]);
    // "Any list" means every list the dialog reads, not just the readers: a
    // regression that filtered account-less people out of the eligible set
    // would hide them from the writers half of the dialog while the readers
    // assertion above still passed.
    expect(body.eligible.users).toEqual([
      { ...KNOWN, hasAccount: true },
      { ...UNKNOWN, hasAccount: false },
    ]);
  });

  it('flips to hasAccount: true once that person signs in — the written grant is byte-identical', async () => {
    // The same grant, made twice: once against a deployment where that person
    // has never signed in, once where they have. The only difference between
    // the two is the `users` row that signing in creates — so the BYTES each
    // one writes to access.md are compared, not assumed: the label is allowed
    // to flip, the grant is not allowed to differ.
    const ACCESS_MD = `${KB}/Sales/access.md`;

    const before = await makeHarness({ granted: [UNKNOWN], accounts: [] });
    h = before;
    expect((await grantRead(UNKNOWN.email, UNKNOWN.name)).status).toBe(200);
    const writtenBefore = before.files.get(ACCESS_MD);
    expect(writtenBefore).toContain(UNKNOWN.email);
    const beforeBody = (await (await view()).json()) as {
      readers: { users: { email: string; hasAccount: boolean }[] };
    };
    expect(beforeBody.readers.users).toEqual([{ ...UNKNOWN, hasAccount: false }]);
    await close(before.server);

    h = await makeHarness({ granted: [UNKNOWN], accounts: [UNKNOWN.email] });
    expect((await grantRead(UNKNOWN.email, UNKNOWN.name)).status).toBe(200);
    // Same address, same file, same bytes — having an account changed nothing
    // about what the grant IS.
    expect(h.files.get(ACCESS_MD)).toBe(writtenBefore);
    const afterBody = (await (await view()).json()) as {
      readers: { users: { email: string; hasAccount: boolean }[] };
    };
    expect(afterBody.readers.users).toEqual([{ ...UNKNOWN, hasAccount: true }]);
  });

  it('still answers the grant when the users lookup is down — the label is omitted, not guessed', async () => {
    // The view is built AFTER the mutation commits. A users table that is
    // unreachable at that instant must not turn a grant that was written into
    // a 500 the caller reads as "it did not save" — the flag is informational,
    // so it goes missing and nothing else does.
    const down = {
      select: () => ({
        from: () => {
          const query = Promise.reject(new Error('users table unavailable')) as Promise<never> & {
            where: () => Promise<never>;
          };
          // The bare-await form is rejected too; swallow its unhandled
          // rejection, the route only reaches the `.where()` branch here.
          query.catch(() => {});
          query.where = () => Promise.reject(new Error('users table unavailable'));
          return query;
        },
      }),
    } as unknown as Parameters<typeof makeHarness>[0]['db'];

    h = await makeHarness({ granted: [UNKNOWN], db: down });

    const res = await grantRead(UNKNOWN.email, UNKNOWN.name);
    expect(res.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain(UNKNOWN.email);

    // No `hasAccount` at all — "the server did not say", which the dialog
    // reads as no label, rather than a false claim that nobody has an account.
    const body = (await res.json()) as {
      readers: { users: { email: string; hasAccount?: boolean }[] };
    };
    expect(body.readers.users).toEqual([UNKNOWN]);
    expect(body.readers.users[0].hasAccount).toBeUndefined();
  });

  it('matches accounts case-insensitively — a grant typed in capitals is still the same person', async () => {
    h = await makeHarness({
      granted: [{ name: 'Alice', email: 'Alice@Bevel.Software' }],
      accounts: [KNOWN.email],
    });

    const body = (await (await view()).json()) as {
      readers: { users: { email: string; hasAccount: boolean }[] };
    };
    expect(body.readers.users[0].hasAccount).toBe(true);
  });

  it('suggest puts the exact address asked for first, so the cap can never hide it', async () => {
    // Twenty-one people all match the query (each filler email CONTAINS the
    // exact one), with the exact match last in union order. The cap is 15, so
    // without exact-first it falls off the end — and a chip labels itself by
    // ABSENCE from this list, which would say "hasn't signed in yet" about
    // somebody who has.
    const EXACT = { name: 'Zoe', email: 'zoe.team@company.com' };
    const crowd = Array.from({ length: 20 }, (_, i) => ({
      name: `Filler ${i}`,
      email: `a${i}.${EXACT.email}`,
    }));
    h = await makeHarness({ kbPeople: [...crowd, EXACT], accounts: [EXACT.email] });

    const body = (await (
      await fetch(
        `${h.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/suggest?q=${encodeURIComponent(EXACT.email)}`,
      )
    ).json()) as { people: { email: string; hasAccount: boolean }[]; accountsKnown?: boolean };

    expect(body.people).toHaveLength(15);
    expect(body.people[0]).toEqual(
      expect.objectContaining({ email: EXACT.email, hasAccount: true }),
    );
    // And the answer says it SPEAKS about accounts, which is the evidence the
    // dialog needs before it labels a free-typed chip at all.
    expect(body.accountsKnown).toBe(true);
  });

  it('suggest marks each person the same way, and withholds nobody', async () => {
    h = await makeHarness({
      kbPeople: [KNOWN, UNKNOWN],
      accounts: [KNOWN.email],
    });

    const suggest = async (q: string) =>
      (await (
        await fetch(
          `${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/suggest?q=${encodeURIComponent(q)}`,
        )
      ).json()) as { people: { email: string; hasAccount: boolean }[] };

    // One character — people are withheld below two (the harvesting guard),
    // and that is unchanged by this ticket.
    expect((await suggest('a')).people).toEqual([]);

    expect((await suggest('alice')).people).toEqual([
      expect.objectContaining({ email: KNOWN.email, hasAccount: true }),
    ]);
    // Named in the knowledge base, never signed in: offered exactly as before,
    // now carrying the fact the chip labels itself with.
    expect((await suggest('colleague')).people).toEqual([
      expect.objectContaining({ email: UNKNOWN.email, hasAccount: false }),
    ]);
  });
});
