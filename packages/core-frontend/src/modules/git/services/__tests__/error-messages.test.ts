import { describe, it, expect } from 'vitest';
import { GitApiError } from '../git.api';
import {
  friendlyGitError,
  parseGitError,
  NO_SHARED_HISTORY_KIND,
  NO_SHARED_HISTORY_RECOVERY_PROMPT,
} from '../error-messages';

describe('friendlyGitError: translates raw backend git messages', () => {
  // The legacy "direct push to protected branch is not allowed" case is
  // retired with the access-at-lock-acquisition refactor: writing to the
  // official versions is allowed wherever the user has path-level access.
  // `direct push` / `committing directly` / `reverting directly` are no
  // longer thrown by the backend; the regex was trimmed accordingly.
  it('rewrites protected-branch "opening a PR from a protected branch" errors', () => {
    const err = new GitApiError(
      403,
      'Branch "target-company-state" is protected — opening a PR from a protected branch is not allowed.',
    );
    expect(friendlyGitError(err)).toBe(
      'You can\'t propose changes from "target-company-state": open the change request from a draft instead.',
    );
  });

  it('rewrites protected-branch "creating a protected branch" errors', () => {
    // The backend throws `ProtectedBranchError` with action "creating a
    // protected branch" when the user tries to make a new branch whose
    // name collides with an official version (the protected set).
    const err = new GitApiError(
      403,
      'Branch "target-company-state" is protected — creating a protected branch is not allowed.',
    );
    expect(friendlyGitError(err)).toBe(
      'The name "target-company-state" is reserved: it\'s an official version.',
    );
  });

  it('rewrites protected-branch "deleting a protected branch" errors', () => {
    // The backend throws `ProtectedBranchError` with action "deleting a
    // protected branch" when the user tries to delete an official version
    // via the delete-branch flow.
    const err = new GitApiError(
      403,
      'Branch "current-company-state" is protected — deleting a protected branch is not allowed.',
    );
    expect(friendlyGitError(err)).toBe(
      '"current-company-state" is an official version and can\'t be deleted.',
    );
  });

  it('falls back to the raw message for shapes it does not recognize', () => {
    const err = new GitApiError(500, 'something completely new went wrong');
    expect(friendlyGitError(err)).toBe('something completely new went wrong');
  });

  it('rewrites raw "no history in common" CLI errors when pre-flight is bypassed', () => {
    const err = new GitApiError(
      500,
      'gh pr create failed: GraphQL: The alice/orphan branch has no history in common with target-company-state',
    );
    const message = friendlyGitError(err);
    expect(message).not.toMatch(/gh pr create/i);
    expect(message).not.toMatch(/graphql/i);
    expect(message).toMatch(/share history/i);
  });

  it('returns the no-shared-history message when the body carries the kind', () => {
    const err = new GitApiError(
      400,
      'The draft "alice/orphan" doesn\'t share history with "target-company-state". …',
      { error: '…', kind: NO_SHARED_HISTORY_KIND, head: 'alice/orphan', base: 'target-company-state' },
    );
    const message = friendlyGitError(err);
    // Renders "Target company state" via protectedBranchDisplayName, not the raw kebab slug.
    expect(message).toMatch(/Target company state/);
    expect(message).not.toMatch(/target-company-state/);
    // No git vocabulary at the rendering boundary — see docs/glossary.md.
    expect(message).not.toMatch(/\bbranch\b/i);
    expect(message).not.toMatch(/\brebase\b/i);
    expect(message).toMatch(/assistant/i);
  });
});

describe('parseGitError: structured form for actionable UIs', () => {
  it('returns kind="plain" for arbitrary errors', () => {
    const info = parseGitError(new Error('oops'));
    expect(info).toEqual({ kind: 'plain', message: 'oops' });
  });

  it('returns kind=no-shared-history with head + base when the body shape matches', () => {
    const err = new GitApiError(
      400,
      'The draft "alice/orphan" doesn\'t share history …',
      { error: '…', kind: NO_SHARED_HISTORY_KIND, head: 'alice/orphan', base: 'target-company-state' },
    );
    const info = parseGitError(err);
    expect(info.kind).toBe(NO_SHARED_HISTORY_KIND);
    if (info.kind === NO_SHARED_HISTORY_KIND) {
      expect(info.head).toBe('alice/orphan');
      expect(info.base).toBe('target-company-state');
      expect(info.message).toMatch(/Target company state/);
    } else {
      throw new Error('expected no-shared-history');
    }
  });

  it('falls back to plain when no-shared-history body is missing head or base', () => {
    const err = new GitApiError(
      400,
      'plain message',
      { error: 'plain message', kind: NO_SHARED_HISTORY_KIND, base: 'target-company-state' },
    );
    expect(parseGitError(err).kind).toBe('plain');
  });
});

describe('cross-package contract', () => {
  it('pins the no-shared-history kind discriminator across packages', () => {
    // The backend's NoSharedHistoryError sets `kind: 'no-shared-history'` in
    // the response payload. Pin the literal so a rename on either side
    // surfaces as a test failure instead of a silent dispatch miss in the UI.
    expect(NO_SHARED_HISTORY_KIND).toBe('no-shared-history');
  });

  it('seeds the chat with a recovery prompt that names both the draft and the target', () => {
    const prompt = NO_SHARED_HISTORY_RECOVERY_PROMPT('alice/orphan', 'target-company-state');
    expect(prompt).toContain('alice/orphan');
    expect(prompt).toContain('target-company-state');
    // Steers the agent toward investigating + recovering, not toward a single
    // canned action that might destroy the user's edits.
    expect(prompt).toMatch(/investigate/i);
  });
});
