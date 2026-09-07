import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { publicConfig } from '../public-config.js';

describe('GET /api/config payload', () => {
  const body = publicConfig({ marketplaceGitUrl: 'https://kb.acme.com/git/marketplace.git', mcpUrl: 'https://kb.acme.com/api/mcp' });

  it('advertises the agent-instructions capability, which the local bridge keys on', () => {
    expect(body.agentInstructions).toBe(true);
  });

  it('carries the branch model and the two addresses it was handed', () => {
    expect(body.branchModel.defaultBranch).toBe(DEFAULT_BRANCH);
    expect(body.branchModel.protectedBranches).toContain(DEFAULT_BRANCH);
    expect(body.mcpUrl).toBe('https://kb.acme.com/api/mcp');
    expect(body.marketplaceGitUrl).toBe('https://kb.acme.com/git/marketplace.git');
    expect(body.kbLayout).toBeDefined();
  });
});
