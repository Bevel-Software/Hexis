import { describe, it, expect } from 'vitest';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { changeAuthorName } from '../utils/author';

/** Only the two author fields matter here; the rest of the summary is noise. */
function cr(appAuthorName?: string): PullRequestSummary {
  return {
    number: 1,
    title: 't',
    author: { login: 'user-42ee38e1c062', name: 'Bevel Bot' },
    appAuthor: appAuthorName === undefined ? undefined : { name: appAuthorName },
    branch: 'b',
    base: 'main',
    state: 'open',
    createdAt: '',
    touchedNodePaths: [],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '',
  } as unknown as PullRequestSummary;
}

describe('changeAuthorName', () => {
  it('prefers the resolved app user', () => {
    expect(changeAuthorName(cr('Olga Martin'))).toBe('Olga Martin');
  });

  it('never falls back to the service account', () => {
    // `author` is the shared account that physically opened the PR — its login
    // is an opaque `user-<hash>` and its name is the robot's.
    expect(changeAuthorName(cr(undefined))).toBe('Someone');
    expect(changeAuthorName(cr(undefined))).not.toContain('user-');
    expect(changeAuthorName(cr(undefined))).not.toBe('Bevel Bot');
  });

  it('treats a blank name as absent', () => {
    // Otherwise the compare view's blocked banner reads
    // "files changed after ⎵ wrote this".
    expect(changeAuthorName(cr(''))).toBe('Someone');
    expect(changeAuthorName(cr('   '))).toBe('Someone');
    expect(changeAuthorName(cr('\t\n'))).toBe('Someone');
  });

  it('trims padding, so a first name is still a first name', () => {
    // Callers take `split(' ')[0]`, which on '  Olga' would be ''.
    expect(changeAuthorName(cr('  Olga Martin '))).toBe('Olga Martin');
    expect(changeAuthorName(cr('  Olga Martin ')).split(' ')[0]).toBe('Olga');
  });
});
