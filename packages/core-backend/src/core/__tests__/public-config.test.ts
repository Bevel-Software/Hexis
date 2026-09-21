import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { publicConfig } from '../public-config.js';

describe('GET /api/config payload', () => {
  const body = publicConfig({ marketplaceGitUrl: 'https://kb.acme.com/git/marketplace.git', mcpUrl: 'https://kb.acme.com/api/mcp' });

  it('advertises the agent-instructions capability, which the local bridge keys on', () => {
    expect(body.agentInstructions).toBe(true);
  });

  /**
   * The local bridge polls `/api/agent/catalog-revision` to notice a manual or
   * a skill changing under a live connection — but only when this says the
   * route is there. It must never probe: an unknown `/api/*` path falls
   * through to the JWT mounts and answers 401, which the bridge reads as a
   * rejected credential.
   */
  it('advertises the catalog-revision capability, on the same terms', () => {
    expect(body.catalogRevision).toBe(true);
  });

  it('carries the branch model and the two addresses it was handed', () => {
    expect(body.branchModel.defaultBranch).toBe(DEFAULT_BRANCH);
    expect(body.branchModel.protectedBranches).toContain(DEFAULT_BRANCH);
    expect(body.mcpUrl).toBe('https://kb.acme.com/api/mcp');
    expect(body.marketplaceGitUrl).toBe('https://kb.acme.com/git/marketplace.git');
    expect(body.kbLayout).toBeDefined();
  });
});
