import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFileReaderRegistry } from '../../workspace/file-readers/file-reader.registry.js';
import { testKbContext, TEST_BRANCH_MODEL } from '../../../__tests__/kb-context.js';
import { EmbedService, type EmbedConfig } from '../embed.service.js';
import {
  EmbedAccessError,
  EmbedLockedError,
  EmbedNodeNotFoundError,
  EmbedTokenError,
} from '../embed.errors.js';
import { EmbedRefParseError } from '../embed-link.js';
import { resolveBeside } from '../embed.service.js';

const KB = 'knowledge-base';
const BRANCH = TEST_BRANCH_MODEL.defaultBranch;
const REPO = 'Data/Thing.md';
const WS = `${KB}/${REPO}`;
const PAGE = '# Thing\n\nWhat it is.\n';

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const SIGNING_KEY = createHmac('sha256', 'test-jwt-secret').update('bevel-embed-token-v1').digest('hex');

function config(overrides: Partial<EmbedConfig> = {}): EmbedConfig {
  return {
    jwtSecret: 'test-jwt-secret',
    embedSharedSecret: 'shh',
    publicFrontendUrl: 'https://hexis.example',
    kbDirName: KB,
    ...overrides,
  };
}

interface Opts {
  canRead?: boolean;
  canWrite?: boolean;
  /** `undefined` = linked to USER; `null` = not linked to anybody. */
  linkedUserId?: string | null;
  acquired?: boolean;
  holderName?: string;
  files?: Record<string, string | Buffer>;
  emailDomainAllowed?: boolean;
  openChangeRequest?: ReturnType<typeof vi.fn>;
  createBranch?: ReturnType<typeof vi.fn>;
  config?: Partial<EmbedConfig>;
  resolveNodeId?: ((id: string) => Promise<string | null>) | null;
}

function build(opts: Opts = {}) {
  const files: Record<string, string | Buffer> = opts.files ?? { [WS]: PAGE };
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch), kbDirName: KB })),
    readFileBinary: vi.fn(async (_id: string, wsPath: string) => {
      const found = files[wsPath];
      if (found === undefined) {
        const err = new Error(`ENOENT: ${wsPath}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return Buffer.isBuffer(found) ? found : Buffer.from(found, 'utf8');
    }),
    // The mint's existence check: a stat, never a read.
    isFile: vi.fn(async (_id: string, wsPath: string) => files[wsPath] !== undefined),
    writeFile: vi.fn(async () => undefined),
  };
  const accessControl = {
    canRead: vi.fn(async () => opts.canRead ?? true),
    canWrite: vi.fn(async () => opts.canWrite ?? true),
  };
  const authService = {
    getUserById: vi.fn(async () => USER),
    isEmailDomainAllowed: vi.fn(() => opts.emailDomainAllowed ?? true),
  };
  const workflowService = {
    // No live lock: a save takes it. The contention rules themselves are
    // exercised against the real lock in embed.service.lock.test.ts.
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({
      acquired: opts.acquired ?? true,
      lock: { holderName: opts.holderName ?? 'Bob' },
    })),
    heartbeatLock: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
    releaseLockNoCommit: vi.fn(async () => undefined),
    commitChanges: vi.fn(async () => ({ sha: 'deadbee' })),
    openChangeRequest: opts.openChangeRequest ?? vi.fn(async () => ({ number: 42 })),
  };
  const gitService = { createBranch: opts.createBranch ?? vi.fn(async () => ({})) };
  const accountLinks = {
    getUserId: vi.fn(async () => (opts.linkedUserId === undefined ? USER.id : opts.linkedUserId)),
    link: vi.fn(async () => undefined),
    listForUser: vi.fn(async () => [{ atlassianAccountId: 'acc-1', createdAt: new Date(0) }]),
    unlink: vi.fn(async () => true),
  };
  const service = new EmbedService(
    config(opts.config),
    testKbContext({ kbDirName: KB }),
    workspaceService as never,
    accessControl as never,
    authService as never,
    workflowService as never,
    gitService as never,
    accountLinks as never,
    createFileReaderRegistry({ extract: async () => ({ kind: 'text', text: '' }) } as never),
    opts.resolveNodeId ?? null,
  );
  return { service, workspaceService, accessControl, authService, workflowService, gitService, accountLinks };
}

/** The token a mint produced, decoded — so a test can assert on the claims. */
function claimsOf(token: string): Record<string, unknown> {
  return jwt.verify(token, SIGNING_KEY) as Record<string, unknown>;
}

describe('EmbedService: minting', () => {
  it('mints for a Hexis user — the MCP path — and names the embed page', async () => {
    const { service } = build();
    const { token, embedUrl } = await service.mintForUser({ userId: USER.id, reference: REPO });
    expect(embedUrl).toBe(`https://hexis.example/embed?token=${encodeURIComponent(token)}`);
    expect(claimsOf(token)).toMatchObject({
      scope: 'embed',
      kind: 'user',
      sub: USER.id,
      repoRelative: REPO,
    });
  });

  /**
   * The token rides in the tool result and so in the chat transcript;
   * whoever holds it acts on that one file as its user until it expires.
   * One hour (Razvan, 2026-10-09), down from the two the embed used before.
   */
  it('mints a token that lives one hour', async () => {
    const { service } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    const { iat, exp } = claimsOf(token) as { iat: number; exp: number };
    expect(exp - iat).toBe(60 * 60);
  });

  it('mints for an outside account — the connector path, unchanged', async () => {
    const { service } = build();
    const { token } = await service.mintToken({
      accountId: 'acc-1',
      email: 'alice@bevel.software',
      reference: `content: ${KB}/${REPO}#what`,
    });
    expect(claimsOf(token)).toMatchObject({ kind: 'atlassian', sub: 'acc-1', repoRelative: REPO, slug: 'what' });
  });

  it('keeps the token PSEUDONYMOUS — no address, no name', async () => {
    const { service } = build();
    const { token } = await service.mintToken({ accountId: 'acc-1', email: USER.email, reference: REPO });
    expect(JSON.stringify(claimsOf(token))).not.toContain(USER.email);
    expect(JSON.stringify(claimsOf(token))).not.toContain(USER.name);
  });

  it('refuses a reference whose file does not exist, so a dead link fails at mint time', async () => {
    const { service } = build();
    await expect(service.mintForUser({ userId: USER.id, reference: 'Data/Gone.md' })).rejects.toThrow(
      EmbedNodeNotFoundError,
    );
  });

  it('refuses an account whose email domain may not reach the knowledge base', async () => {
    const { service } = build({ emailDomainAllowed: false });
    await expect(
      service.mintToken({ accountId: 'acc-1', email: 'x@elsewhere.test', reference: REPO }),
    ).rejects.toThrow(EmbedAccessError);
  });

  it('refuses a node-id reference when no deployment resolver is registered', async () => {
    const { service } = build();
    await expect(service.mintForUser({ userId: USER.id, reference: 'hx-a-node' })).rejects.toThrow(
      EmbedRefParseError,
    );
  });

  /**
   * `readme` is the copy-link's id shape AND a legal root-level file. The
   * file that is really there wins — `open_page` has just read it by that
   * very path, and core has no id resolver to fall back on.
   */
  it('reads an extensionless root file as the path it is, not as a node id', async () => {
    const { service } = build({ files: { [`${KB}/readme`]: 'hello' } });
    const { token } = await service.mintForUser({ userId: USER.id, reference: 'readme' });
    expect(claimsOf(token)).toMatchObject({ repoRelative: 'readme' });
  });

  it('refuses a separator spelled %2F rather than decoding it into a real one', async () => {
    const { service } = build({ files: { [WS]: PAGE } });
    await expect(service.mintForUser({ userId: USER.id, reference: 'Data%2FThing.md' })).rejects.toThrow(
      EmbedRefParseError,
    );
    await expect(
      service.mintForUser({ userId: USER.id, reference: `https://hexis.example/workspace/main/${KB}/Data%2FThing.md` }),
    ).rejects.toThrow(EmbedRefParseError);
  });

  it('resolves a node-id reference through a deployment resolver when one is', async () => {
    const { service } = build({ resolveNodeId: async () => REPO });
    const { token } = await service.mintForUser({ userId: USER.id, reference: 'hx-a-node' });
    expect(claimsOf(token)).toMatchObject({ repoRelative: REPO });
  });

  it('checks the shared secret in a way that rejects a wrong one and a wrong length', () => {
    const { service } = build();
    expect(service.sharedSecretConfigured()).toBe(true);
    expect(service.verifySharedSecret('shh')).toBe(true);
    expect(service.verifySharedSecret('shhh')).toBe(false);
    expect(service.verifySharedSecret('sh')).toBe(false);
    expect(service.verifySharedSecret(undefined)).toBe(false);
  });

  it('reports the shared-secret mint as unconfigured when no secret is set', () => {
    const { service } = build({ config: { embedSharedSecret: '' } });
    expect(service.sharedSecretConfigured()).toBe(false);
    expect(service.verifySharedSecret('')).toBe(false);
  });
});

describe('EmbedService: loading', () => {
  it('answers the file, the default branch and the app address', async () => {
    const { service } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    const view = await service.loadFile(token);
    expect(view).toMatchObject({
      nodeName: 'Thing',
      repoRelative: REPO,
      workspacePath: WS,
      kbDirName: KB,
      branch: BRANCH,
      content: PAGE,
      contentIsText: true,
      linked: true,
      canRead: true,
      canWrite: true,
    });
    expect(view.appUrl).toBe(
      `https://hexis.example/workspace/${encodeURIComponent(BRANCH)}/${KB}/Data/Thing.md`,
    );
  });

  it('carries the heading the agent named, so the view opens there', async () => {
    const { service } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: `${REPO}#what-it-is` });
    const view = await service.loadFile(token);
    expect(view.heading).toBe('what-it-is');
    // The WHOLE page, still: the heading says where to start reading, and a
    // save writes the file the way the app's file page writes it.
    expect(view.content).toBe(PAGE);
    expect(view.appUrl).toContain('#what-it-is');
  });

  /**
   * The embed renders EVERY type the app renders, so the load has to say
   * which ones carry text and which ones are bytes a renderer fetches. The
   * answer comes from the same reader registry `read_file` dispatches on, so
   * it cannot disagree with what a read of the file returns.
   */
  it.each([
    ['markdown', 'Data/Thing.md', true],
    ['an HTML page', 'Pages/Report.html', true],
    ['a CSV', 'Data/rows.csv', true],
    ['an image', 'Shots/diagram.png', false],
    ['a PDF', 'Docs/Report.pdf', false],
    ['a Word document', 'Docs/Spec.docx', false],
  ])('says whether %s is text or bytes', async (_label, repo, isText) => {
    const { service } = build({ files: { [`${KB}/${repo}`]: 'bytes' } });
    const { token } = await service.mintForUser({ userId: USER.id, reference: repo });
    const view = await service.loadFile(token);
    expect(view.contentIsText).toBe(isText);
    // A byte renderer is handed NO content — it reads `/api/embed/raw` under
    // this same token, which keeps a document out of a JSON payload.
    if (!isText) expect(view.content).toBe('');
  });

  it('shows NO content to an identity that does not resolve, but still says so', async () => {
    const { service } = build({ linkedUserId: null });
    const { token } = await service.mintToken({ accountId: 'acc-1', reference: REPO });
    const view = await service.loadFile(token);
    expect(view).toMatchObject({ linked: false, canRead: false, canWrite: false, content: '' });
    expect(view.linkUrl).toContain('/embed/link?token=');
  });

  it('shows NO content to a viewer who may not read the file', async () => {
    const { service } = build({ canRead: false });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    const view = await service.loadFile(token);
    expect(view).toMatchObject({ linked: true, canRead: false, content: '' });
  });

  it('never reports write access without read access', async () => {
    const { service, accessControl } = build({ canRead: false, canWrite: true });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    expect((await service.loadFile(token)).canWrite).toBe(false);
    // And the write question is not even asked once read has said no.
    expect(accessControl.canWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['a garbage token', 'not-a-token'],
    ['a token signed with another key', jwt.sign({ scope: 'embed', kind: 'user', sub: 'u', repoRelative: REPO }, 'other')],
    ['a token with the wrong scope', jwt.sign({ scope: 'session', kind: 'user', sub: 'u', repoRelative: REPO }, SIGNING_KEY)],
    ['a token with no subject', jwt.sign({ scope: 'embed', repoRelative: REPO }, SIGNING_KEY)],
  ])('refuses %s', async (_label, token) => {
    const { service } = build();
    await expect(service.loadFile(token)).rejects.toThrow(EmbedTokenError);
  });

  it('refuses an EXPIRED token', async () => {
    const { service } = build();
    const expired = jwt.sign(
      { scope: 'embed', kind: 'user', sub: USER.id, repoRelative: REPO },
      SIGNING_KEY,
      { expiresIn: -10 },
    );
    await expect(service.loadFile(expired)).rejects.toThrow(EmbedTokenError);
  });

  /**
   * An embed token is derived from the JWT secret with a fixed label, so it
   * cannot be replayed as a session JWT nor the reverse. The derivation is
   * part of the token format: a session token must be refused here.
   */
  it('refuses a token signed with the JWT secret itself', async () => {
    const { service } = build();
    const session = jwt.sign(
      { scope: 'embed', kind: 'user', sub: USER.id, repoRelative: REPO },
      'test-jwt-secret',
    );
    await expect(service.loadFile(session)).rejects.toThrow(EmbedTokenError);
  });

  /**
   * A token minted by the release BEFORE the subject was generalised keyed
   * the identity on `accountId` alone. Those live two hours, so an upgrade
   * would otherwise expire every open Atlassian panel on the spot.
   */
  it('still reads a token from the release before the subject was generalised', async () => {
    const { service, accountLinks } = build();
    const legacy = jwt.sign({ scope: 'embed', accountId: 'acc-legacy', repoRelative: REPO }, SIGNING_KEY);
    const view = await service.loadFile(legacy);
    expect(view.linked).toBe(true);
    expect(accountLinks.getUserId).toHaveBeenCalledWith('acc-legacy');
  });
});

describe('EmbedService: bytes', () => {
  it('serves the embedded file itself', async () => {
    const { service } = build({ files: { [`${KB}/Shots/x.png`]: Buffer.from([1, 2, 3]) } });
    const { token } = await service.mintForUser({ userId: USER.id, reference: 'Shots/x.png' });
    const { bytes, path } = await service.readBytes(token);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(path).toBe('Shots/x.png');
  });

  it('serves a picture beside the page, resolved against the page and re-gated', async () => {
    const { service, accessControl } = build({
      files: { [WS]: PAGE, [`${KB}/Data/assets/shot.png`]: Buffer.from([9]) },
    });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    const { path } = await service.readBytes(token, './assets/shot.png');
    expect(path).toBe('Data/assets/shot.png');
    // The token scopes the view to one page, never to one page's PERMISSIONS:
    // the file actually served is checked on its own.
    expect(accessControl.canRead).toHaveBeenCalledWith(expect.anything(), USER.email, 'Data/assets/shot.png');
  });

  /** The form the embed view sends: a renderer names files by workspace path. */
  it('serves a picture named from the repository root', async () => {
    const { service } = build({
      files: { [WS]: PAGE, [`${KB}/Data/assets/shot.png`]: Buffer.from([9]) },
    });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    const { bytes, path } = await service.readBytes(token, '/Data/assets/shot.png');
    expect(path).toBe('Data/assets/shot.png');
    expect([...bytes]).toEqual([9]);
  });

  it('refuses the outside-the-knowledge-base form the view sends', async () => {
    const { service } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.readBytes(token, '/..')).rejects.toThrow(EmbedAccessError);
  });

  it('refuses a path that climbs out of the repository', async () => {
    const { service } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.readBytes(token, '../../../etc/passwd')).rejects.toThrow(EmbedAccessError);
  });

  it('refuses a path the viewer may not read', async () => {
    const { service } = build({ canRead: false });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.readBytes(token)).rejects.toThrow(EmbedAccessError);
  });
});

describe('EmbedService: saving as a writer', () => {
  it('writes to the default branch and releases the lock, which commits', async () => {
    const { service, workspaceService, workflowService } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await service.acquireLock(token);
    await service.save(token, 'new text');
    expect(workflowService.acquireLock).toHaveBeenCalledWith(
      encodeURIComponent(BRANCH),
      BRANCH,
      WS,
      expect.objectContaining({ id: USER.id }),
    );
    expect(workspaceService.writeFile).toHaveBeenCalledWith(encodeURIComponent(BRANCH), WS, 'new text');
    expect(workflowService.releaseLock).toHaveBeenCalledWith(
      encodeURIComponent(BRANCH),
      BRANCH,
      WS,
      expect.objectContaining({ id: USER.id }),
    );
  });

  it('names the holder when somebody else has the lock', async () => {
    const { service } = build({ acquired: false, holderName: 'Bob' });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    expect(await service.acquireLock(token)).toEqual({ acquired: false, holderName: 'Bob' });
  });

  /**
   * A frame hidden past the lock's TTL can come back to find the file taken.
   * Its Save must not land: written first and refused at the release, the
   * text would sit on disk under the OTHER editor's lock, for their next
   * commit to publish.
   */
  it('writes nothing when the viewer no longer holds the lock', async () => {
    const { service, workspaceService, workflowService } = build({ acquired: false, holderName: 'Bob' });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.save(token, 'x')).rejects.toThrow(EmbedLockedError);
    await expect(service.save(token, 'x')).rejects.toThrow('Bob');
    expect(workspaceService.writeFile).not.toHaveBeenCalled();
    expect(workflowService.releaseLock).not.toHaveBeenCalled();
  });

  /**
   * The lock is let go on the SERVER at that moment, not left to the view's
   * cancel or the TTL: a frame that is gone, or a host that never delivers
   * the refusal, would otherwise keep the file shut to the writers who still
   * have access.
   */
  it('refuses to keep a lock alive for a viewer who lost write access, and releases it', async () => {
    const { service, accessControl, workflowService } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    accessControl.canWrite.mockResolvedValue(false);
    await expect(service.heartbeat(token)).rejects.toThrow(EmbedAccessError);
    expect(workflowService.heartbeatLock).not.toHaveBeenCalled();
    expect(workflowService.releaseLockNoCommit).toHaveBeenCalledWith(
      expect.any(String),
      BRANCH,
      `${KB}/${REPO}`,
      expect.objectContaining({ id: USER.id }),
    );
    expect(workflowService.releaseLock).not.toHaveBeenCalled();
  });

  it('releases the lock WITHOUT committing when the write fails, and rethrows', async () => {
    const { service, workspaceService, workflowService } = build();
    workspaceService.writeFile.mockRejectedValueOnce(new Error('disk full'));
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.save(token, 'x')).rejects.toThrow('disk full');
    expect(workflowService.releaseLockNoCommit).toHaveBeenCalled();
    expect(workflowService.releaseLock).not.toHaveBeenCalled();
  });

  it('refuses Edit and Save to a viewer without write access', async () => {
    const { service, workspaceService } = build({ canWrite: false });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.acquireLock(token)).rejects.toThrow(EmbedAccessError);
    await expect(service.save(token, 'x')).rejects.toThrow(EmbedAccessError);
    expect(workspaceService.writeFile).not.toHaveBeenCalled();
  });

  it('refuses to save text over bytes that are not text, and says so in the load', async () => {
    // A PNG under a markdown name: the fallback reader is text-editable, but
    // what it answers for these bytes is a refusal, not the file's text.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const { service, workspaceService } = build({ files: { [WS]: png } });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    const view = await service.loadFile(token);
    expect(view.contentIsText).toBe(false);
    expect(view.canWrite).toBe(false);
    await expect(service.save(token, '# replaced')).rejects.toThrow(EmbedAccessError);
    expect(workspaceService.writeFile).not.toHaveBeenCalled();
  });

  it('refuses to edit as an identity that does not resolve', async () => {
    const { service } = build({ linkedUserId: null });
    const { token } = await service.mintToken({ accountId: 'acc-1', reference: REPO });
    await expect(service.acquireLock(token)).rejects.toThrow(EmbedAccessError);
  });
});

describe('EmbedService: proposing as a non-writer', () => {
  it('commits to the viewer OWN suggestions branch and opens a change request', async () => {
    const { service, workspaceService, workflowService, gitService } = build({ canWrite: false });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    const result = await service.propose(token, 'proposed text');

    const branch = 'suggestions/alice-u-1/knowledge';
    expect(gitService.createBranch).toHaveBeenCalledWith(encodeURIComponent(BRANCH), branch, BRANCH);
    expect(workspaceService.writeFile).toHaveBeenCalledWith(encodeURIComponent(branch), WS, 'proposed text');
    /**
     * COMMITTED, and committed BEFORE the request is opened.
     *
     * `writeFile` only puts bytes on disk. Without this the branch head never
     * moved, and the request opened against a tree identical to its base:
     * `changedFiles: 0`, `headSha === baseSha`, and a reviewer told "this pull
     * request has no file changes to approve" about a proposal sitting
     * uncommitted on disk. Found on a real boot, not by a stub.
     */
    expect(workflowService.commitChanges).toHaveBeenCalledWith(
      encodeURIComponent(branch),
      expect.objectContaining({ id: USER.id }),
      expect.stringContaining(REPO),
      // Scoped to this one path: the suggestions branch carries everything
      // this person has proposed, and a bare commit would sweep another
      // in-flight write of theirs in under this message.
      [WS],
    );
    expect(workflowService.commitChanges.mock.invocationCallOrder[0]).toBeLessThan(
      workflowService.openChangeRequest.mock.invocationCallOrder[0],
    );
    expect(workflowService.openChangeRequest).toHaveBeenCalledWith(
      encodeURIComponent(branch),
      expect.objectContaining({ id: USER.id }),
      { sourceBranch: branch, targetBranch: BRANCH, title: 'Changes from Alice. Knowledge' },
    );
    expect(result).toEqual({ branch, number: 42, url: 'https://hexis.example/change-requests/42' });
  });

  it('touches NOTHING on the default branch — no lock, no write there', async () => {
    const { service, workspaceService, workflowService } = build({ canWrite: false });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await service.propose(token, 'proposed text');
    expect(workflowService.acquireLock).not.toHaveBeenCalled();
    expect(workspaceService.writeFile).not.toHaveBeenCalledWith(
      encodeURIComponent(BRANCH),
      expect.anything(),
      expect.anything(),
    );
  });

  it('reuses an existing suggestions branch rather than failing on it', async () => {
    const createBranch = vi.fn(async () => {
      throw new Error('a branch named "suggestions/alice-u-1/knowledge" already exists');
    });
    const { service, workflowService } = build({ canWrite: false, createBranch });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.propose(token, 'x')).resolves.toMatchObject({ number: 42 });
    expect(workflowService.openChangeRequest).toHaveBeenCalled();
  });

  /**
   * The person's one open Knowledge request already covers this branch — which
   * is the state `propose` is trying to reach, not a failure. The refusal
   * names it, so the view points at it.
   */
  it('adopts the request that already covers the branch', async () => {
    const duplicate = Object.assign(new Error('An open change request already exists (#7).'), {
      status: 409,
      payload: { kind: 'duplicate-change-request', existingNumber: 7 },
      existingNumber: 7,
    });
    const openChangeRequest = vi.fn(async () => {
      throw duplicate;
    });
    const { service } = build({ canWrite: false, openChangeRequest });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.propose(token, 'x')).resolves.toMatchObject({
      number: 7,
      url: 'https://hexis.example/change-requests/7',
    });
  });

  it('refuses to propose on a file the viewer may not read', async () => {
    const { service, workspaceService } = build({ canRead: false });
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.propose(token, 'x')).rejects.toThrow(EmbedAccessError);
    expect(workspaceService.writeFile).not.toHaveBeenCalled();
  });
});

describe('EmbedService: account links', () => {
  it('links the token account to the signed-in user', async () => {
    const { service, accountLinks } = build();
    const { token } = await service.mintToken({ accountId: 'acc-9', reference: REPO });
    await service.linkAccount(token, 'u-2');
    expect(accountLinks.link).toHaveBeenCalledWith('acc-9', 'u-2');
  });

  it('refuses to re-point a token that already names a Hexis user', async () => {
    const { service, accountLinks } = build();
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    await expect(service.linkAccount(token, 'u-2')).rejects.toThrow(EmbedAccessError);
    expect(accountLinks.link).not.toHaveBeenCalled();
  });

  it('lists and unlinks a user own links', async () => {
    const { service, accountLinks } = build();
    expect(await service.listLinkedAccounts('u-1')).toEqual([
      { atlassianAccountId: 'acc-1', createdAt: 0 },
    ]);
    expect(await service.unlinkAccount('u-1', 'acc-1')).toBe(true);
    expect(accountLinks.unlink).toHaveBeenCalledWith('u-1', 'acc-1');
  });
});

describe('resolveBeside', () => {
  it.each([
    ['a sibling', 'Data/Thing.md', 'shot.png', 'Data/shot.png'],
    ['a child folder', 'Data/Thing.md', './assets/shot.png', 'Data/assets/shot.png'],
    ['one level up', 'Data/Deep/Thing.md', '../shot.png', 'Data/shot.png'],
    ['a repo-absolute path', 'Data/Thing.md', '/Other/shot.png', 'Other/shot.png'],
    ['a percent-encoded name', 'Data/Thing.md', 'a%20shot.png', 'Data/a shot.png'],
  ])('resolves %s', (_label, from, path, expected) => {
    expect(resolveBeside(from, path)).toBe(expected);
  });

  it.each([
    ['traversal past the root', 'Data/Thing.md', '../../../etc/passwd'],
    ['a control character', 'Data/Thing.md', 'a\nb.png'],
    ['a malformed escape', 'Data/Thing.md', '%zz.png'],
    ['a path that resolves to nothing', 'Thing.md', './'],
  ])('refuses %s', (_label, from, path) => {
    expect(resolveBeside(from, path)).toBeNull();
  });

  /**
   * `./` beside a file in a folder resolves to the FOLDER, which is not a
   * file. Nothing downstream is fooled — the read fails with the same
   * not-found a missing file gives — and it stays inside the repository,
   * which is the property this function is responsible for.
   */
  it('stays inside the repository even when a path names a folder', () => {
    expect(resolveBeside('Data/Deep/Thing.md', './')).toBe('Data/Deep');
    expect(resolveBeside('Data/Deep/Thing.md', '../')).toBe('Data');
  });
});
