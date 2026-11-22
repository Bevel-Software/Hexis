import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InternalTokenService } from '../../../__tests__/tool-wiring.js';
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
    t === 'bevel_ok'
      ? { user: { id: 'u-ext', email: 'e@x', name: 'Ext' }, tokenId: 'tk-1', botUserId: null, agentPath: null }
      : t === 'bevel_bot'
        ? { user: { id: 'u-ext', email: 'e@x', name: 'Ext' }, tokenId: 'tk-2', botUserId: 'u-bot', agentPath: null }
        : t === 'bevel_bot_of_gone'
          ? { user: { id: 'u-gone', email: 'g@x', name: 'Gone' }, tokenId: 'tk-3', botUserId: 'u-bot', agentPath: null }
          : null,
} as never;
// Every account is on except `u-off`, which an admin switched off.
const authService = {
  getUserById: async (id: string) => (id === 'u-gone' ? null : { id, email: id === 'u-bot' ? 'ops@agent.hexis' : 'e@x', name: 'N' }),
  isActive: async (id: string) => id !== 'u-off',
} as never;

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
  versionControlService: {} as never,
  events: {} as never,
  kbDirName: 'knowledge-base',
  creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} },
  // A connection made as the bot `u-bot` resolves to the bot's row, the maker kept.
  identities: {
    userOf: async (id: string) => ({ id, email: 'e@x' }),
    bots: {
      resolveConnection: async (maker, choice) =>
        choice.botUserId === 'u-bot'
          ? { kind: 'bot', actor: { id: 'u-bot', email: 'ops@agent.hexis' }, madeBy: maker, bot: { id: 'ops', name: 'Ops' }, platformTools: null }
          : { kind: 'myself' },
    },
  },
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

  it('resolves a connection key made as a bot to the bot, as the hosted middleware does', async () => {
    const ctx = await validateToken('bevel_bot');
    expect(ctx.user.id).toBe('u-bot');
    expect(ctx.user.email).toBe('ops@agent.hexis');
  });

  it('refuses a call made as a bot whose maker cannot be loaded, rather than run it with nobody behind it', async () => {
    const err = await validateToken('bevel_bot_of_gone').catch((e) => e);
    expect(hasHttpStatus(err) && err.status).toBe(401);
    expect((err as Error).message).toMatch(/person who made this connection/);
  });

  it('getFilesystem(branch) builds the filesystem for that branch\'s workspace', async () => {
    const tok = internalToken.mint({ userId: 'u1' });
    const fs = await (await validateToken(tok)).getFilesystem('some/draft');
    expect((await fs.readFile('a.md')).toString()).toBe('hi');
  });

  it('throws a 401 ToolError for a valid internal token whose account was switched off', async () => {
    const err = await validateToken(internalToken.mint({ userId: 'u-off' })).catch((e) => e);
    expect(hasHttpStatus(err) && err.status).toBe(401);
    expect((err as Error).message).toContain('switched off');
  });

  it('throws a 401 ToolError on a bad token and an empty token', async () => {
    for (const bad of ['garbage', 'bevel_nope', '', undefined]) {
      const err = await validateToken(bad as string).catch((e) => e);
      expect(hasHttpStatus(err) && err.status).toBe(401);
    }
  });
});
