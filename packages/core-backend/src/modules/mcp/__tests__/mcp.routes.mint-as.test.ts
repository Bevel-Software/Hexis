import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeMountedRoutes, mountMcpRoutes } from './mcp-routes-harness.js';

/**
 * POST /mcp/external-api-keys reads "Connect as" exactly as the consent step
 * does (`connectAsAsked`). A dialog from before bots names its choice as
 * `agentPath`: read as absent it would mint a key as Myself, with the
 * person's whole access, while the person chose an agent. It is refused and
 * nothing is minted.
 */

afterEach(async () => {
  await closeMountedRoutes();
  vi.restoreAllMocks();
});

async function mount() {
  const mint = vi.fn(async (_userId: string, label: string, kind: object) => ({ id: 'tok-1', label, kind, plaintext: 'bevel_x' }));
  const actAs = vi.fn(async (email: string, bot: string) =>
    email === 'dana@acme.com' && bot === 'release-helper' ? { id: 'bot-row-1' } : null,
  );
  const baseUrl = await mountMcpRoutes({ externalApiKeyService: { mint }, agents: { actAs } });
  const post = (body: unknown) =>
    fetch(`${baseUrl}/api/mcp/external-api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-email': 'dana@acme.com' },
      body: JSON.stringify(body),
    });
  return { post, mint, actAs };
}

describe('minting a connection key: Connect as', () => {
  it('refuses a body that names its choice as agentPath, and mints nothing', async () => {
    const { post, mint } = await mount();
    const res = await post({ label: 'laptop', agentPath: 'Agents/release.agent' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'That bot is not one you can connect as. Choose Myself or one of the bots listed.',
    });
    expect(mint).not.toHaveBeenCalled();
  });

  it('refuses agentPath even beside a bot the person may act as', async () => {
    const { post, mint } = await mount();
    const res = await post({ label: 'laptop', bot: 'release-helper', agentPath: 'Agents/release.agent' });
    expect(res.status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
  });

  it('mints as Myself when no bot is named, or a blank one', async () => {
    const { post, mint, actAs } = await mount();
    expect((await post({ label: 'a' })).status).toBe(200);
    expect((await post({ label: 'b', bot: '  ' })).status).toBe(200);
    expect((await post({ label: 'c', bot: null })).status).toBe(200);
    expect(mint.mock.calls.map((c) => c[2])).toEqual([{}, {}, {}]);
    expect(actAs).not.toHaveBeenCalled();
  });

  it('mints as the bot the person may act as, named trimmed', async () => {
    const { post, mint, actAs } = await mount();
    expect((await post({ label: 'a', bot: ' release-helper ' })).status).toBe(200);
    expect(actAs).toHaveBeenCalledWith('dana@acme.com', 'release-helper');
    expect(mint).toHaveBeenCalledWith('user-A', 'a', { botUserId: 'bot-row-1' });
  });

  it('refuses a bot the person may not act as, and a choice that is not a string', async () => {
    const { post, mint } = await mount();
    expect((await post({ label: 'a', bot: 'someone-else' })).status).toBe(400);
    expect((await post({ label: 'a', bot: 7 })).status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
  });
});
