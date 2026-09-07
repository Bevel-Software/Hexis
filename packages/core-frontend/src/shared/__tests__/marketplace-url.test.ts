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

  it('shows a placeholder verbatim — never percent-encoded into something that looks like a key', () => {
    configureMarketplaceGitUrl('https://kb.acme.com/git/marketplace.git');
    expect(withConnectionKey('<external-api-key>')).toBe(
      'https://key:<external-api-key>@kb.acme.com/git/marketplace.git',
    );
    expect(marketplaceCommands('<external-api-key>').claude).not.toContain('%3C');
  });

  it('keeps a real key byte for byte — tenant prefix plus base64url, with its dashes and underscores', () => {
    configureMarketplaceGitUrl('https://kb.acme.com/git/marketplace.git');
    const key = 'corestaging_Ab-9_x2C9-Nmm_ic';
    expect(withConnectionKey(key)).toBe(`https://key:${key}@kb.acme.com/git/marketplace.git`);
  });

  it('keeps a non-default port in the remote', () => {
    configureMarketplaceGitUrl('http://localhost:3000/git/marketplace.git');
    expect(withConnectionKey('bevel_abc')).toBe('http://key:bevel_abc@localhost:3000/git/marketplace.git');
  });
});
