import { describe, it, expect, afterEach } from 'vitest';
import {
  configureMarketplaceGitUrl,
  marketplaceCommands,
  marketplaceGitUrl,
  resetMarketplaceGitUrlForTests,
  withConnectionKey,
} from '../marketplace-url';

afterEach(() => resetMarketplaceGitUrlForTests());

describe('marketplace git url', () => {
  it('uses the server\'s address, with any credential stripped', () => {
    configureMarketplaceGitUrl('https://user:hunter2@kb.acme.com/git/marketplace.git');
    expect(marketplaceGitUrl()).toBe('https://kb.acme.com/git/marketplace.git');
  });

  it('falls back to the origin when the server sends nothing usable', () => {
    configureMarketplaceGitUrl(undefined);
    expect(marketplaceGitUrl()).toBe(`${window.location.origin}/git/marketplace.git`);
    configureMarketplaceGitUrl('javascript:alert(1)');
    expect(marketplaceGitUrl()).toBe(`${window.location.origin}/git/marketplace.git`);
  });

  it('puts the connection key in the URL the way git sends it', () => {
    configureMarketplaceGitUrl('https://kb.acme.com/git/marketplace.git');
    expect(withConnectionKey('bevel_abc')).toBe('https://key:bevel_abc@kb.acme.com/git/marketplace.git');
    const cmds = marketplaceCommands('bevel_abc');
    expect(cmds.claude).toBe(
      'claude plugin marketplace add https://key:bevel_abc@kb.acme.com/git/marketplace.git && claude plugin install hexis-all@hexis',
    );
    expect(cmds.codex).toBe('codex plugin marketplace add https://key:bevel_abc@kb.acme.com/git/marketplace.git');
    expect(cmds.skills).toBe('npx skills add https://key:bevel_abc@kb.acme.com/git/marketplace.git --all -y');
  });
});
