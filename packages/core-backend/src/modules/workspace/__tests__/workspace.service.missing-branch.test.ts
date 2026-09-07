import { describe, expect, it } from 'vitest';
import { isMissingRemoteBranchFailure } from '../workspace.service.js';

/**
 * The one line that decides whether a failed bootstrap is "this branch does
 * not exist" (410, the browser says so) or "something is wrong" (500). Git's
 * two wordings for a missing ref are matched; an unreachable host or a
 * refused credential must NOT be, or a deployment outage would read as
 * "your branch is gone".
 */
describe('isMissingRemoteBranchFailure', () => {
  it('recognises both of git’s wordings for a ref origin does not have', () => {
    expect(
      isMissingRemoteBranchFailure(
        "Command failed: git clone -b sync-test/conflict-2 https://[REDACTED]@github.com/x/y.git /w\nfatal: Remote branch sync-test/conflict-2 not found in upstream origin",
      ),
    ).toBe(true);
    expect(isMissingRemoteBranchFailure("fatal: couldn't find remote ref refs/heads/ali/x")).toBe(true);
  });

  it('does not mistake an unreachable host or a refused credential for a missing branch', () => {
    expect(
      isMissingRemoteBranchFailure("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"),
    ).toBe(false);
    expect(isMissingRemoteBranchFailure('remote: Invalid username or password.\nfatal: Authentication failed')).toBe(false);
    expect(isMissingRemoteBranchFailure('fatal: repository not found')).toBe(false);
  });
});
