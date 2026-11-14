import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MIN_GIT_VERSION,
  parseGitVersion,
  assertSupportedGitVersion,
  assertGitVersion,
} from '../git-version.js';

describe('the git version floor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the major/minor out of the shapes git actually prints', () => {
    expect(parseGitVersion('git version 2.39.5\n')).toEqual([2, 39]);
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)\n')).toEqual([2, 39]);
    expect(parseGitVersion('git version 2.45.1.windows.1\n')).toEqual([2, 45]);
    expect(parseGitVersion('git version 3.0\n')).toEqual([3, 0]);
    expect(parseGitVersion('not git at all')).toBeNull();
  });

  it('rejects a git too old for --no-write-fetch-head', () => {
    const [major, minor] = MIN_GIT_VERSION;
    expect(() => assertSupportedGitVersion(`git version ${major}.${minor - 1}.0`))
      .toThrow(/git 2\.29 or newer is required, found 2\.28/);
    expect(() => assertSupportedGitVersion('git version 1.9.5')).toThrow(/required/);
  });

  it('accepts the floor itself and anything newer', () => {
    const [major, minor] = MIN_GIT_VERSION;
    expect(() => assertSupportedGitVersion(`git version ${major}.${minor}.0`)).not.toThrow();
    expect(() => assertSupportedGitVersion('git version 2.39.5')).not.toThrow();
    expect(() => assertSupportedGitVersion('git version 3.0.0')).not.toThrow();
  });

  // A git build with an unusual version banner is far more likely than one
  // older than 2.29, so an unreadable string must not take down the boot.
  it('warns but does not block boot on an unreadable version string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSupportedGitVersion('some vendored git\n')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  // The real binary on any machine that can run this suite is well past the
  // floor; this pins the wiring (spawn + parse) rather than the version.
  it('passes against the git installed on this machine', async () => {
    await expect(assertGitVersion()).resolves.toBeUndefined();
  });
});
