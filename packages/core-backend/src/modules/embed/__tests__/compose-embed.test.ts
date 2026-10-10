import { describe, expect, it, vi } from 'vitest';
import { testKbContext, TEST_BRANCH_MODEL } from '../../../__tests__/kb-context.js';
import { makeRolesYamlWriteValidator } from '../../access-model/roles-yaml-guard.js';
import { createFileReaderRegistry } from '../../workspace/file-readers/file-reader.registry.js';
import type { DocExtractOutcome, DocExtractService } from '../../workspace/file-readers/doc-extract.service.js';
import { composeEmbedService, type EmbedComposition } from '../compose-embed.js';
import { EmbedRefParseError } from '../embed-link.js';

const KB = 'knowledge-base';
const BRANCH = TEST_BRANCH_MODEL.defaultBranch;
const REPO = 'Data/Thing.md';
const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };

/** The composition root's deps, as mocks: enough to mint and to say who is looking. */
function deps(): EmbedComposition {
  const extract = async (): Promise<DocExtractOutcome> => ({ ok: false, message: 'no documents here' });
  return {
    config: { jwtSecret: 'test-jwt-secret', embedSharedSecret: '', publicFrontendUrl: 'https://hexis.example', kbDirName: KB },
    kb: testKbContext({ kbDirName: KB }),
    workspaceService: {
      getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch), kbDirName: KB })),
      isFile: vi.fn(async (_id: string, wsPath: string) => wsPath === `${KB}/${REPO}`),
      readFileBinary: vi.fn(async () => Buffer.from('# Thing\n')),
      writeFile: vi.fn(async () => undefined),
      withPathTurn: vi.fn(async (_id: string, _p: string, op: () => Promise<unknown>) => op()),
    },
    accessControl: { canRead: vi.fn(async () => true), canWrite: vi.fn(async () => true) } as never,
    authService: { getUserById: vi.fn(async () => USER), isEmailDomainAllowed: () => true, isActive: async () => true },
    workflowService: {} as never,
    gitService: {} as never,
    accountLinks: { getUserId: async () => null, link: async () => undefined, listForUser: async () => [], unlink: async () => true },
    readers: createFileReaderRegistry({ extract } satisfies Pick<DocExtractService, 'extract'> as DocExtractService),
    validateWrite: makeRolesYamlWriteValidator(KB),
  };
}

/**
 * The composition root is the one place the distribution's ports reach the
 * embed. Pinned here through that composition, not by handing the service a
 * resolver directly: a node-id reference resolves through the port when one
 * is registered, and is refused when none is — which is what a core-only
 * deployment ships.
 */
describe('composeEmbedService', () => {
  // The app's copy-link form: the full address of a node, which is its id.
  const NODE_LINK = `https://hexis.example/workspace/${encodeURIComponent(BRANCH)}/abc-123`;

  it('resolves a node-id reference through the registered port, and mints for the file it names', async () => {
    const embedNodeIdResolver = vi.fn(async (id: string) => (id === 'abc-123' ? REPO : null));
    const service = composeEmbedService(deps(), { embedNodeIdResolver });
    const { token } = await service.mintForUser({ userId: USER.id, reference: NODE_LINK });
    expect(embedNodeIdResolver).toHaveBeenCalledWith('abc-123');
    expect((await service.viewerOf(token)).repoRelative).toBe(REPO);
    // An id the graph does not know is refused as a dead reference.
    await expect(service.mintForUser({ userId: USER.id, reference: 'nope-1' })).rejects.toThrow(EmbedRefParseError);
  });

  it('refuses a node-id reference when no port is registered — core has no graph', async () => {
    const service = composeEmbedService(deps(), {});
    await expect(service.mintForUser({ userId: USER.id, reference: NODE_LINK })).rejects.toThrow(EmbedRefParseError);
    // A path reference is untouched by the absence of a resolver.
    const { token } = await service.mintForUser({ userId: USER.id, reference: REPO });
    expect((await service.viewerOf(token)).repoRelative).toBe(REPO);
  });
});
