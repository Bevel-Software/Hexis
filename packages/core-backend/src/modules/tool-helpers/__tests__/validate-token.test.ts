import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolValidator } from '../validate-token.js';
import { hasHttpStatus } from '../tool.contract.js';

/**
 * `validateToken` is the framework-agnostic SDK entry: bearer token → full
 * `ToolContext`, fusing the shared verify core with the context resolver. These
 * tests pin that contract (the same one a marketplace plugin will code against).
 */

const internalToken = new InternalTokenService({ secret: 'test-secret' });
const externalApiKeyService = {
  looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === 'bevel_ok' ? { user: { id: 'u-ext', email: 'e@x', name: 'Ext' }, tokenId: 'tk-1' } : null,
} as never;
const authService = { getUserById: async (id: string) => ({ id, email: 'e@x', name: 'N' }) } as never;

let tempDir = '';
const workspaceService = {
  getWorkspacePath: async () => tempDir,
  getOrCreateForUser: async () => ({ id: 'ext-ws' }),
} as never;

const validateToken = createToolValidator({
  externalApiKeyService,
  internalTokenService: internalToken,
  authService,
  workspaceService,
  workflowService: {} as never,
  events: {} as never,
  kbDirName: 'knowledge-base',
  creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} },
});

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'validate-token-'));
  await writeFile(join(tempDir, 'a.md'), 'hi');
});
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('validateToken (tool-author SDK entry)', () => {
  it('resolves an internal token to a write-scoped identity context (no workspace bound)', async () => {
    const tok = internalToken.mint({ userId: 'u1' });
    const ctx = await validateToken(tok);
    expect(ctx).toMatchObject({ source: 'internal', scope: 'write' });
    expect(ctx.user.id).toBe('u1');
  });

  it('resolves an external connection key to a write-scoped identity context', async () => {
    const ctx = await validateToken('bevel_ok');
    expect(ctx).toMatchObject({ source: 'external', scope: 'write' });
    expect(ctx.user.id).toBe('u-ext');
  });

  it('getFilesystem(branch) builds the filesystem for that branch\'s workspace', async () => {
    const tok = internalToken.mint({ userId: 'u1' });
    const fs = await (await validateToken(tok)).getFilesystem('some/draft');
    expect((await fs.readFile('a.md')).toString()).toBe('hi');
  });

  it('throws a 401 ToolError on a bad token and an empty token', async () => {
    for (const bad of ['garbage', 'bevel_nope', '', undefined]) {
      const err = await validateToken(bad as string).catch((e) => e);
      expect(hasHttpStatus(err) && err.status).toBe(401);
    }
  });
});
