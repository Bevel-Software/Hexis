import { describe, expect, it } from 'vitest';
import { normalizeRepositoryAddress, sameRepository } from '../remote-url.js';

/**
 * The comparison decides whether a working copy is kept or deleted, so what
 * it must never do is call the SAME repository a different one.
 */
describe('sameRepository', () => {
  it.each([
    ['https://github.com/org/repo', 'https://github.com/org/repo.git'],
    ['https://github.com/org/repo', 'https://github.com/org/repo/'],
    ['https://github.com/org/repo.git/', 'https://github.com/org/repo'],
    ['https://GitHub.com/org/repo', 'https://github.com/org/repo'],
    ['HTTPS://github.com/org/repo', 'https://github.com/org/repo'],
    ['https://x-access-token:secret@github.com/org/repo', 'https://github.com/org/repo'],
    ['  https://github.com/org/repo  ', 'https://github.com/org/repo'],
    ['/srv/git/kb.git', '/srv/git/kb'],
    ['C:\\git\\kb.git\\', 'C:\\git\\kb'],
  ])('%s is %s', (a, b) => {
    expect(sameRepository(a, b)).toBe(true);
  });

  it.each([
    ['https://github.com/org/repo', 'https://github.com/org/other'],
    ['https://github.com/org/repo', 'https://github.com/other/repo'],
    ['https://github.com/org/repo', 'https://gitlab.com/org/repo'],
    ['https://github.com/org/repo', 'https://github.com/org/repo-kb'],
    ['https://github.com/org/Repo', 'https://github.com/org/repo'],
  ])('%s is not %s', (a, b) => {
    expect(sameRepository(a, b)).toBe(false);
  });

  it('never carries a credential into the normalized form', () => {
    expect(normalizeRepositoryAddress('https://user:token@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo',
    );
  });
});
