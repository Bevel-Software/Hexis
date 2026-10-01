import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { joinBranchFor, type IWorkflowService } from '@bevel-software/platform-shared';

import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { testKbContext, TEST_BRANCH_MODEL } from '../../../__tests__/kb-context.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../access-control.interface.js';
import type { IAccessRequestLifecycle } from '../access-requests.contract.js';
import { createAccessRequestRoutes } from '../access-requests.routes.js';
import { ChangeRequestConflictsError } from '../../../shared/domain-errors.js';
import { pendingProposals } from '../../plugins/join-proposals.js';

/**
 * Asking for Can edit or Owner on an item, and what the editors then see.
 *
 * The live workspace is the only place a request can be made, an item the
 * caller cannot read answers as unknown, and nothing here ever reports a
 * request that does not exist.
 */

const KB = 'knowledge-base';
const LIVE = TEST_BRANCH_MODEL.defaultBranch;
const LIVE_WS = workspaceIdForBranch(LIVE);
const RITA = { id: 'u-rita', email: 'rita@x.io', name: 'Rita Oyelaran' };
const FOLDER = 'Research';
const FOLDER_RULES = `${KB}/Research/access.md`;
const NOTE_FILE = 'Research/Notes.md';

const proposalFor = (verb: 'write' | 'owner') => ({
  verb,
  id: `user:${RITA.email}`,
  principal: { kind: 'user' as const, email: RITA.email, displayName: RITA.name },
  label: RITA.name,
});

interface HarnessOpts {
  /** Paths the caller may write (its rules file ⇒ they are an editor). */
  writable?: string[];
  readable?: boolean;
  openCrs?: { number: number; branch: string; state: string }[];
  /** What the caller's branch still proposes — null ⇒ the branch is unreadable. */
  proposals?: ReturnType<typeof proposalFor>[] | null;
  /** Branch names the probe reports as already on origin. */
  existingBranches?: string[];
  lastClosed?: { number: number; state: 'closed' | 'merged' } | null;
  liveRules?: string | null;
  branchRules?: string | null;
  detailBody?: string;
}

async function makeHarness(opts: HarnessOpts = {}) {
  const {
    writable = [],
    readable = true,
    openCrs = [],
    proposals = [],
    existingBranches = [],
    lastClosed = null,
    liveRules = '---\n---\nwrite:\n  - Ed <ed@x.io>\n',
    branchRules = null,
    detailBody = '',
  } = opts;

  const absent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const onOrigin = new Set(existingBranches);
  const opened: unknown[] = [];
  const written: { path: string; text: string }[] = [];

  const workflow = {
    listChangeRequestsAuthoredBy: vi.fn(async () => openCrs),
    listChangeRequests: vi.fn(async () => openCrs),
    // The ref list FOLLOWS create and delete, as origin's does: a probe that
    // ignored them would let the recut pass on a route that never cut anything.
    listBranches: vi.fn(async () =>
      [...onOrigin].map((name) => ({ name, isDefault: false, isProtected: false })),
    ),
    deleteBranch: vi.fn(async (_ws: string, name: string) => {
      onOrigin.delete(name);
    }),
    createBranch: vi.fn(async (_ws: string, name: string) => {
      onOrigin.add(name);
      return { name, isDefault: false, isProtected: false };
    }),
    commitChanges: vi.fn(async () => null),
    openChangeRequest: vi.fn(async (_ws: string, _u: unknown, input: unknown) => {
      opened.push(input);
      return { number: 77 };
    }),
    latestClosedChangeRequest: vi.fn(async () => lastClosed),
    getChangeRequest: vi.fn(async (n: number) => ({ number: n, state: 'open' })),
    getChangeRequestDetail: vi.fn(async () => ({ body: detailBody })),
  } as unknown as IWorkflowService;

  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: workspaceIdForBranch(branch) })),
    readFile: vi.fn(async (wsId: string, p: string) => {
      const text = wsId === LIVE_WS ? liveRules : branchRules;
      if (text === null) throw absent;
      void p;
      return text;
    }),
    writeFile: vi.fn(async (_ws: string, p: string, text: string) => {
      written.push({ path: p, text });
    }),
    readFileBinary: vi.fn(async () => Buffer.from('---\n---\nhello\n')),
  } as unknown as WorkspaceService;

  const accessControl = {
    canRead: vi.fn(async () => readable),
    canWrite: vi.fn(async (_ws: string, _e: string, p: string) => writable.includes(p)),
    kbPrincipals: vi.fn(async () => ({ roles: [], groups: [], plugins: [] })),
    invalidate: vi.fn(),
  } as unknown as IAccessControl;

  const lifecycle = {
    proposalsOn: vi.fn(async () => proposals),
    list: vi.fn(async () => [
      {
        number: 77,
        branch: joinBranchFor(RITA.email, FOLDER),
        requesterName: RITA.name,
        createdAt: '2026-01-01T00:00:00.000Z',
        proposals: proposals ?? [],
      },
    ]),
    reconcile: vi.fn(async () => true),
  } as unknown as IAccessRequestLifecycle;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = RITA.id;
    next();
  });
  app.use(
    '/api',
    createAccessRequestRoutes({
      accessControl,
      workspaceService,
      authService: { getUserById: async () => RITA } as unknown as AuthService,
      workflow,
      lifecycle,
      kb: testKbContext({ kbDirName: KB }),
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api/workspace`;
  return { server, base, workflow, workspaceService, accessControl, lifecycle, opened, written };
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const folderBody = { path: `${KB}/${FOLDER}`, kind: 'folder', level: 'write' };

describe('POST /workspace/:id/access/request', () => {
  let server: Server | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('opens one change request titled after the item, proposing exactly the level asked for', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, {
      ...folderBody,
      level: 'owner',
      note: 'I maintain these pages now',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'pending', number: 77, level: 'owner' });
    expect(h.opened).toEqual([
      expect.objectContaining({
        sourceBranch: joinBranchFor(RITA.email, FOLDER),
        targetBranch: LIVE,
        title: 'Access request: Research',
      }),
    ]);
    // The rules file it splices is the FOLDER's access.md, and nothing else.
    expect(h.written.map((w) => w.path)).toEqual([FOLDER_RULES]);
    expect(h.written[0].text).toContain('owner:');
    expect(h.written[0].text).toContain(RITA.email);
  });

  it("names the person, the level, the path and the note in the description", async () => {
    const h = await makeHarness();
    server = h.server;
    await post(`${h.base}/${LIVE_WS}/access/request`, { ...folderBody, note: 'I run this now' });
    const { description } = h.opened[0] as { description: string };
    // What a reader SEES: markdown consumes the backslashes the escaping put
    // in, so the assertion reads the description the way the renderer does.
    const rendered = description.replace(/\\(.)/g, '$1');
    expect(rendered).toContain(RITA.name);
    expect(rendered).toContain(RITA.email);
    expect(rendered).toContain('Can edit');
    expect(rendered).toContain('Research');
    expect(rendered).toContain('I run this now');
  });

  it('escapes the note, so nothing in it renders as a heading, a link or an image', async () => {
    const h = await makeHarness();
    server = h.server;
    await post(`${h.base}/${LIVE_WS}/access/request`, {
      ...folderBody,
      note: '# Big\n![x](http://tracker/pixel)',
    });
    const { description } = h.opened[0] as { description: string };
    expect(description).not.toMatch(/^> # Big$/m);
    expect(description).toContain('\\#');
    expect(description).toContain('\\!\\[x\\]\\(http://tracker/pixel\\)');
  });

  it('a file request splices the FILE\'s own rules — the folder is untouched', async () => {
    const h = await makeHarness({ liveRules: '---\n---\nnotes\n' });
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, {
      path: `${KB}/${NOTE_FILE}`,
      kind: 'file',
      level: 'write',
    });
    expect(res.status).toBe(200);
    expect(h.written.map((w) => w.path)).toEqual([`${KB}/${NOTE_FILE}`]);
  });

  it('writes a file proposal the request reader can actually read back', async () => {
    // The seam that broke on staging: the opener wrote one grant into a node's
    // frontmatter as a scalar, and the reader parsed it with the folder
    // grammar, which rejects a scalar and so found no grants at all. Every
    // file request then looked finished and was closed on the editors' first
    // listing. Asserting the WRITE alone could never catch that — the write
    // was always right — so assert the round trip.
    const live = '---\nnodeType: "[Note](../NodeTypes/Note.md)"\n---\n# Notes\n';
    const h = await makeHarness({ liveRules: live });
    server = h.server;
    await post(`${h.base}/${LIVE_WS}/access/request`, {
      path: `${KB}/${NOTE_FILE}`,
      kind: 'file',
      level: 'owner',
    });

    const onBranch = h.written[0].text;
    expect(pendingProposals(onBranch, live, NOTE_FILE, 'file')).toEqual([
      expect.objectContaining({ verb: 'owner', id: `user:${RITA.email}` }),
    ]);
  });

  it('answers with the OPEN request instead of opening a second one', async () => {
    const branch = joinBranchFor(RITA.email, FOLDER);
    const h = await makeHarness({ openCrs: [{ number: 31, branch, state: 'open' }] });
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);
    expect(await res.json()).toMatchObject({ number: 31 });
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
  });

  it('splices onto the LIVE rules, so a request after a decline asks for one level only', async () => {
    // The branch still carries the declined `write` — that is how the dialog
    // knows to say "wasn't accepted". A fresh Owner request must not ask for
    // both.
    const h = await makeHarness({
      liveRules: '---\n---\nwrite:\n  - Ed <ed@x.io>\n',
      branchRules: `---\n---\nwrite:\n  - Ed <ed@x.io>\n  - ${RITA.name} <${RITA.email}>\n`,
    });
    server = h.server;
    await post(`${h.base}/${LIVE_WS}/access/request`, { ...folderBody, level: 'owner' });
    const text = h.written[0].text;
    expect(text).toContain('owner:');
    // Rita appears once, under owner — the declined write proposal is gone.
    expect(text.match(new RegExp(RITA.email, 'g'))).toHaveLength(1);
  });

  it('refuses every workspace but the live one', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await post(`${h.base}/${workspaceIdForBranch('rita/draft')}/access/request`, folderBody);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'not-live-workspace' });
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('answers as unknown for an item the caller cannot read', async () => {
    const h = await makeHarness({ readable: false });
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);
    expect(res.status).toBe(404);
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses an editor — they have the dialog, not a request', async () => {
    const h = await makeHarness({ writable: [`${FOLDER}/access.md`] });
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'already-writable' });
  });

  it('refuses a file that cannot carry rules, and names the folder that governs it', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, {
      path: `${KB}/Research/Deck.pdf`,
      kind: 'file',
      level: 'write',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'folder-governs', folder: FOLDER });
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
  });

  it('refuses a level that is not Can edit or Owner, and a note over 500 characters', async () => {
    const h = await makeHarness();
    server = h.server;
    expect((await post(`${h.base}/${LIVE_WS}/access/request`, { ...folderBody, level: 'read' })).status).toBe(400);
    expect(
      (await post(`${h.base}/${LIVE_WS}/access/request`, { ...folderBody, note: 'x'.repeat(501) })).status,
    ).toBe(400);
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });
});

describe('GET /workspace/:id/access/request — what the requester is told', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  const status = (h: { base: string }, kind = 'folder') =>
    fetch(`${h.base}/${LIVE_WS}/access/request?path=${encodeURIComponent(`${KB}/${FOLDER}`)}&kind=${kind}`);

  it('reports the open request, taking the level off the REQUEST rather than the branch', async () => {
    // The branch is where the proposal lives, but a clone whose refs are
    // seconds stale cannot read a branch cut moments ago. "Requested: Owner"
    // is a promise about a request, so it is answered from the request — here
    // the branch is deliberately unreadable and the line is still right.
    const branch = joinBranchFor(RITA.email, FOLDER);
    const h = await makeHarness({
      openCrs: [{ number: 31, branch, state: 'open' }],
      proposals: null,
      detailBody: '<!--hexis:access-request-level:owner-->\nRita asked for Owner.',
    });
    server = h.server;
    expect(await (await status(h)).json()).toEqual({ state: 'pending', level: 'owner', number: 31 });
  });

  it("calls a request with no level recorded on it Can edit — the skill button's only level", async () => {
    const branch = joinBranchFor(RITA.email, FOLDER);
    const h = await makeHarness({
      openCrs: [{ number: 31, branch, state: 'open' }],
      detailBody: 'Opened before the level was recorded.',
    });
    server = h.server;
    expect(await (await status(h)).json()).toMatchObject({ state: 'pending', level: 'write' });
  });

  it('says nothing is outstanding when the branch cannot be read — never that a request was refused', async () => {
    // A read that failed proves nothing. Showing the control is recoverable;
    // telling somebody their request was turned down when nobody turned it
    // down is not.
    const h = await makeHarness({ proposals: null, lastClosed: { number: 31, state: 'closed' } });
    server = h.server;
    expect(await (await status(h)).json()).toEqual({ state: 'none' });
  });

  it('reports a closed request whose proposal is still unmet as not accepted', async () => {
    const h = await makeHarness({
      proposals: [proposalFor('write')],
      lastClosed: { number: 31, state: 'closed' },
    });
    server = h.server;
    expect(await (await status(h)).json()).toEqual({ state: 'not-accepted', level: 'write', number: 31 });
  });

  it('reports nothing outstanding once the proposal is met — a settled request never reads as declined', async () => {
    // Nothing unmet on the branch: the request was accepted, or the access
    // arrived another way, and its branch is gone.
    const h = await makeHarness({ proposals: [], lastClosed: { number: 31, state: 'closed' } });
    server = h.server;
    expect(await (await status(h)).json()).toEqual({ state: 'none' });
  });

  it('reports nothing when the person never asked', async () => {
    const h = await makeHarness({ proposals: [], lastClosed: null });
    server = h.server;
    expect(await (await status(h)).json()).toEqual({ state: 'none' });
  });
});

describe('the editors\' side', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  const listUrl = (base: string) =>
    `${base}/${LIVE_WS}/access/requests?path=${encodeURIComponent(`${KB}/${FOLDER}`)}&kind=folder`;

  it('lists the item\'s open requests for an editor, with the note read back as plain text', async () => {
    const h = await makeHarness({
      writable: [`${FOLDER}/access.md`],
      proposals: [proposalFor('owner')],
      detailBody:
        'x\n\n<!--hexis:access-request-note-->\n> I maintain these pages now\n<!--/hexis:access-request-note-->\n',
    });
    server = h.server;
    const body = await (await fetch(listUrl(h.base))).json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ number: 77, note: 'I maintain these pages now' });
  });

  it('answers [] to everyone who is not an editor, rather than a 403', async () => {
    const h = await makeHarness({ proposals: [proposalFor('write')] });
    server = h.server;
    const res = await fetch(listUrl(h.base));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
    expect(h.lifecycle.list).not.toHaveBeenCalled();
  });

  it('reconciles one request for an editor, and hides the route from everyone else', async () => {
    const h = await makeHarness({ writable: [`${FOLDER}/access.md`] });
    server = h.server;
    const body = { path: `${KB}/${FOLDER}`, kind: 'folder' };
    const ok = await post(`${h.base}/${LIVE_WS}/access/requests/77/reconcile`, body);
    expect(await ok.json()).toEqual({ closed: true });

    const h2 = await makeHarness();
    const denied = await post(`${h2.base}/${LIVE_WS}/access/requests/77/reconcile`, body);
    expect(denied.status).toBe(404);
    await new Promise<void>((r) => h2.server.close(() => r()));
  });
});

describe('which request a branch IS', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('a skill folder request from the dialog is the SAME request as the skill page\'s button', async () => {
    // Both name the branch from (person, folder path) — the skill route and
    // this one give `joinBranchFor` the same key — so the second surface
    // finds the first's request instead of opening a rival.
    const skillFolder = 'Skills/Eng/deploy';
    const h = await makeHarness();
    server = h.server;
    await post(`${h.base}/${LIVE_WS}/access/request`, {
      path: `${KB}/${skillFolder}`,
      kind: 'folder',
      level: 'write',
    });
    expect(h.opened[0]).toMatchObject({
      sourceBranch: joinBranchFor(RITA.email, skillFolder),
    });
  });

  it('does not follow the item when it is renamed — the request stays where it was opened', async () => {
    // The branch is named from the path the request was made about. After a
    // rename the new path names a different branch, so the open request is
    // not this item's; it stays in Change requests for you, to be declined.
    const h = await makeHarness({ writable: ['Archive/Research/access.md'] });
    server = h.server;
    expect(joinBranchFor(RITA.email, FOLDER)).not.toBe(joinBranchFor(RITA.email, 'Archive/Research'));
    await fetch(
      `${h.base}/${LIVE_WS}/access/requests?path=${encodeURIComponent(`${KB}/Archive/Research`)}&kind=folder`,
    );
    // The listing is keyed on the path asked about, never on the old one.
    expect(h.lifecycle.list).toHaveBeenCalledWith(
      'Archive/Research',
      { path: 'Archive/Research', kind: 'folder' },
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('a branch left over from an answered request', () => {
  let server: Server | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  const stale = joinBranchFor(RITA.email, FOLDER);

  it('is CUT AGAIN from live before the new proposal goes on it', async () => {
    // Opening a change request merges live into its source branch. A branch
    // still standing here was answered long ago, on a base that may predate
    // every edit since — and the moment live has touched the same rules file
    // (an editor granting anyone anything on this item does exactly that)
    // that merge conflicts. The person asking would be told to resolve
    // conflicts on an internal branch they cannot reach, for good. Recutting
    // from live makes live the merge base, so there is nothing to conflict.
    const h = await makeHarness({ existingBranches: [stale] });
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);

    expect(res.status).toBe(200);
    expect(h.workflow.deleteBranch).toHaveBeenCalledWith(LIVE_WS, stale, expect.anything());
    expect(h.workflow.createBranch).toHaveBeenCalledWith(LIVE_WS, stale, LIVE);
    // Order matters: recut first, THEN write the proposal onto it.
    const deleted = (h.workflow.deleteBranch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const written = (h.workspaceService.writeFile as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(deleted).toBeLessThan(written);
  });

  it('is left alone when there is no branch to recut', async () => {
    const h = await makeHarness();
    server = h.server;
    await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);
    expect(h.workflow.deleteBranch).not.toHaveBeenCalled();
    expect(h.workflow.createBranch).toHaveBeenCalledWith(LIVE_WS, stale, LIVE);
  });

  it('still opens the request when the recut fails, rather than refusing the person', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await makeHarness({ existingBranches: [stale] });
    (h.workflow.deleteBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('the branch could not be removed'),
    );
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);
    expect(res.status).toBe(200);
    expect(h.workflow.openChangeRequest).toHaveBeenCalled();
  });

  it('answers with the rival request when one opened while the recut was under way', async () => {
    // `deleteBranch` refuses a branch with an open change request. That
    // refusal is the guard: somebody else's click got there first, and one
    // request is what they both get.
    const h = await makeHarness({ existingBranches: [stale] });
    let listings = 0;
    (h.workflow.listChangeRequests as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      listings++ === 0 ? [] : [{ number: 55, branch: stale, state: 'open' }],
    );
    (h.workflow.deleteBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Branch has an open change request (#55).'),
    );
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);
    expect(await res.json()).toMatchObject({ number: 55 });
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('answers a re-send with the level the OPEN request asks for, not the one just sent', async () => {
    // Two tabs: the second sends Can edit while an Owner request is open.
    // Answering with what was typed would put "Requested: Can edit" over a
    // request asking for Owner.
    const h = await makeHarness({
      openCrs: [{ number: 31, branch: stale, state: 'open' }],
      detailBody: '<!--hexis:access-request-level:owner-->',
    });
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, { ...folderBody, level: 'write' });
    expect(await res.json()).toEqual({ ok: true, state: 'pending', number: 31, level: 'owner' });
  });

  it('records the level on the request itself, so it can be read back', async () => {
    const h = await makeHarness();
    server = h.server;
    await post(`${h.base}/${LIVE_WS}/access/request`, { ...folderBody, level: 'owner' });
    const { description } = h.opened[0] as { description: string };
    expect(description).toContain('<!--hexis:access-request-level:owner-->');
  });
});

describe('what a failed send tells the person', () => {
  let server: Server | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('never asks a reader to resolve conflicts on a branch they have never heard of', async () => {
    // The dialog shows the server's reason verbatim, so the reason has to be
    // something the person can act on. "Resolve on
    // reader2/join-artest3-04i7dr4-0nxlotq and try again" is not.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await makeHarness();
    (h.workflow.openChangeRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ChangeRequestConflictsError(joinBranchFor(RITA.email, FOLDER), LIVE, [
        `${FOLDER}/access.md`,
      ]),
    );
    server = h.server;
    const res = await post(`${h.base}/${LIVE_WS}/access/request`, folderBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('The rules changed while your request was being sent. Try again.');
    expect(JSON.stringify(body)).not.toContain('join-');
  });
});
