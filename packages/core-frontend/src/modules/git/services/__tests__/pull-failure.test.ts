import { describe, it, expect } from 'vitest';
import { describePullFailure, pullFailureDetail, pullFailurePhrase } from '../pull-failure';

/**
 * One sorting of a failed pull serves two readers: the sentence a person
 * sees on the banner, and the phrase the change-request port hands the
 * assistant. Both are checked here against git's own words, so neither can
 * leak them.
 */
describe('a failed pull, sorted by what it was', () => {
  const GIT_WORDS = /uncommitted|working tree|stash|HEAD|merge conflict|fatal|rebase/i;

  it.each([
    ['CONFLICT (content): Merge conflict in Docs/a.md', 'two versions of the same file need to be reconciled', 'changed both here and by a teammate'],
    ['error: cannot pull with rebase: You have unstaged changes. working tree has uncommitted changes', 'there are local changes that need to be sorted out first', 'haven’t been saved to the knowledge base yet'],
    ['fatal: Authentication failed for https://example.com/org/repo', 'a connection or permission problem', 'couldn’t be reached, or refused this deployment'],
    ['fatal: could not resolve host example.com', 'a connection or permission problem', 'couldn’t be reached, or refused this deployment'],
    ['remote: HTTP Basic: Access denied. 403', 'a connection or permission problem', 'couldn’t be reached, or refused this deployment'],
  ])('%s', (raw, phrase, detail) => {
    const err = new Error(raw);
    expect(pullFailurePhrase(err)).toBe(phrase);
    expect(pullFailureDetail(err)).toContain(detail);
    expect(describePullFailure(err)).toMatch(/^Couldn’t get the latest changes\. /);
    for (const said of [pullFailurePhrase(err), describePullFailure(err)]) {
      expect(said).not.toMatch(GIT_WORDS);
      expect(said).not.toContain('example.com');
    }
  });

  it('says only that it failed when the words match nothing it knows', () => {
    const err = new Error('boom');
    expect(pullFailurePhrase(err)).toBe('something unexpected went wrong');
    expect(pullFailureDetail(err)).toBeNull();
    expect(describePullFailure(err)).toBe('Couldn’t get the latest changes.');
  });
});
