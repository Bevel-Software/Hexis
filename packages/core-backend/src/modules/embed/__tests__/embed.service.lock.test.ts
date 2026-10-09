import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { FileLockService } from '../../workflow/file-lock.service.js';
import { makeFakeLockDb, type FakeLockDb } from '../../workflow/__tests__/fake-file-lock-db.js';
import { createFileReaderRegistry } from '../../workspace/file-readers/file-reader.registry.js';
import type { DocExtractOutcome, DocExtractService } from '../../workspace/file-readers/doc-extract.service.js';
import { makeRolesYamlWriteValidator } from '../../access-model/roles-yaml-guard.js';
import { testKbContext, TEST_BRANCH_MODEL } from '../../../__tests__/kb-context.js';
import { EmbedService } from '../embed.service.js';
import { EmbedLockedError } from '../embed.errors.js';

/**
 * Edit and Save against the REAL lock.
 *
 * The rest of the service suite stubs `acquireLock`, and a stub answers
 * whatever it was told to. That is how a Save that re-acquired the writer's
 * own lock shipped: the stub said yes, while `FileLockService.acquire` is
 * strict on purpose and refuses a live lock even to its own holder (an agent
 * shares the human's user id, and must not steal their edit). On a real boot
 * every Save from the embed answered 409 against the writer's own Edit lock.
 *
 * So the lock half of the workflow service here is the real `FileLockService`
 * over the in-memory `file_locks` table the workflow suites use — the
 * contention rules come from the code that enforces them.
 */

const KB = 'knowledge-base';
const BRANCH = TEST_BRANCH_MODEL.defaultBranch;
const WS_ID = encodeURIComponent(BRANCH);
const REPO = 'Data/Thing.md';
const WS = `${KB}/${REPO}`;

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };
const BOB: AuthUser = { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', name: 'Bob' };

let fake: FakeLockDb;
let locks: FileLockService;

/** The extraction service the reader registry takes, typed against its contract; no document is read here. */
function noDocExtract(): DocExtractService {
  const extract = async (): Promise<DocExtractOutcome> => ({
    ok: false,
    message: 'this suite reads no document-format file',
  });
  return { extract } satisfies Pick<DocExtractService, 'extract'> as DocExtractService;
}

function build() {
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch), kbDirName: KB })),
    readFileBinary: vi.fn(async () => Buffer.from('# Thing\n', 'utf8')),
    isFile: vi.fn(async () => true),
    writeFile: vi.fn(async () => undefined),
    withPathTurn: vi.fn(async (_id: string, _wsPath: string, op: () => Promise<unknown>) => op()),
  };
  // The lock verbs go straight to the real service; release drops the row as
  // the real `releaseLock` does once it has enqueued the commit.
  const workflowService = {
    getLock: vi.fn((id: string, branch: string, path: string) => locks.get(id, branch, path)),
    acquireLock: vi.fn((id: string, branch: string, path: string, user: AuthUser) =>
      locks.acquire(id, branch, path, user),
    ),
    heartbeatLock: vi.fn((id: string, branch: string, path: string, user: AuthUser) =>
      locks.heartbeat(id, branch, path, user),
    ),
    releaseLock: vi.fn((id: string, branch: string, path: string, user: AuthUser) =>
      locks.release(id, branch, path, user),
    ),
    releaseLockNoCommit: vi.fn((id: string, branch: string, path: string, user: AuthUser) =>
      locks.release(id, branch, path, user),
    ),
  };
  const service = new EmbedService(
    { jwtSecret: 's', embedSharedSecret: '', publicFrontendUrl: 'https://hexis.example', kbDirName: KB },
    testKbContext({ kbDirName: KB }),
    workspaceService as never,
    { canRead: async () => true, canWrite: async () => true } as never,
    { getUserById: async (id: string) => (id === ALICE.id ? ALICE : BOB), isEmailDomainAllowed: () => true } as never,
    workflowService as never,
    { createBranch: async () => ({}) } as never,
    { getUserId: async () => null } as never,
    createFileReaderRegistry(noDocExtract()),
    makeRolesYamlWriteValidator(KB),
  );
  return { service, workspaceService, workflowService };
}

beforeEach(() => {
  fake = makeFakeLockDb();
  locks = new FileLockService(fake.db);
});

describe('the real lock is strict', () => {
  /** The premise the regression broke on — pinned, so nobody "relies" on the opposite again. */
  it('refuses a live lock even to its own holder', async () => {
    expect((await locks.acquire(WS_ID, BRANCH, WS, ALICE)).acquired).toBe(true);
    expect((await locks.acquire(WS_ID, BRANCH, WS, ALICE)).acquired).toBe(false);
  });
});

describe('Edit then Save, as the writer does it', () => {
  it('saves under the lock Edit took, then releases it', async () => {
    const { service, workspaceService } = build();
    const { token } = await service.mintForUser({ userId: ALICE.id, reference: REPO });

    expect(await service.acquireLock(token)).toEqual({ acquired: true });
    await service.heartbeat(token);
    await expect(service.save(token, 'new text')).resolves.toBeUndefined();

    expect(workspaceService.writeFile).toHaveBeenCalledWith(WS_ID, WS, 'new text');
    // Released, so the file is free for the next editor.
    expect(await locks.get(WS_ID, BRANCH, WS)).toBeNull();
  });

  it('can Edit and Save again straight after', async () => {
    const { service, workspaceService } = build();
    const { token } = await service.mintForUser({ userId: ALICE.id, reference: REPO });
    await service.acquireLock(token);
    await service.save(token, 'first');
    await service.acquireLock(token);
    await service.save(token, 'second');
    expect(workspaceService.writeFile).toHaveBeenLastCalledWith(WS_ID, WS, 'second');
  });
});

describe('a Save whose lock is not the viewer own', () => {
  it('is refused, names the holder, writes nothing and leaves their lock alone', async () => {
    await locks.acquire(WS_ID, BRANCH, WS, BOB);
    const { service, workspaceService } = build();
    const { token } = await service.mintForUser({ userId: ALICE.id, reference: REPO });

    const save = service.save(token, 'x');
    await expect(save).rejects.toThrow(EmbedLockedError);
    await expect(service.save(token, 'x')).rejects.toThrow('Bob');
    expect(workspaceService.writeFile).not.toHaveBeenCalled();
    expect((await locks.get(WS_ID, BRANCH, WS))?.holderUserId).toBe(BOB.id);
  });

  /** A frame hidden past the TTL comes back to a free file: it takes the lock again and saves. */
  it('takes a lapsed lock back when nobody else took the file', async () => {
    const { service, workspaceService } = build();
    const { token } = await service.mintForUser({ userId: ALICE.id, reference: REPO });
    const past = new Date(Date.now() - 60_000);
    fake.seed({
      workspaceId: WS_ID,
      branch: BRANCH,
      path: WS,
      holderUserId: ALICE.id,
      holderName: ALICE.name,
      mode: 'edit',
      acquiredAt: past,
      lastHeartbeatAt: past,
      expiresAt: past,
    });
    await expect(service.save(token, 'back')).resolves.toBeUndefined();
    expect(workspaceService.writeFile).toHaveBeenCalledWith(WS_ID, WS, 'back');
  });

  it('is refused when the lapsed lock was taken by somebody else', async () => {
    const { service, workspaceService } = build();
    const { token } = await service.mintForUser({ userId: ALICE.id, reference: REPO });
    await service.acquireLock(token);
    // Alice's lock lapses, and Bob takes the file.
    const past = new Date(Date.now() - 60_000);
    fake.seed({
      workspaceId: WS_ID,
      branch: BRANCH,
      path: WS,
      holderUserId: ALICE.id,
      holderName: ALICE.name,
      mode: 'edit',
      acquiredAt: past,
      lastHeartbeatAt: past,
      expiresAt: past,
    });
    expect((await locks.acquire(WS_ID, BRANCH, WS, BOB)).acquired).toBe(true);

    await expect(service.save(token, 'stale')).rejects.toThrow(EmbedLockedError);
    expect(workspaceService.writeFile).not.toHaveBeenCalled();
  });

  it('does not treat a coordination hold under the same id as write possession', async () => {
    await locks.acquire(WS_ID, BRANCH, WS, ALICE, { coordination: true });
    const { service, workspaceService } = build();
    const { token } = await service.mintForUser({ userId: ALICE.id, reference: REPO });
    await expect(service.save(token, 'x')).rejects.toThrow(EmbedLockedError);
    expect(workspaceService.writeFile).not.toHaveBeenCalled();
  });
});
