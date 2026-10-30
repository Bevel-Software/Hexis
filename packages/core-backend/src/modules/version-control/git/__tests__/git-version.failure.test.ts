import { describe, it, expect, vi } from 'vitest';
import { assertGitVersion } from '../git-version.js';

// Lives in its own file (not git-version.test.ts) because `git-version.ts`
// binds `promisify(execFile)` at module load: the spawn failure must be mocked
// module-wide before that import, which would also break the sibling test that
// runs against the real git binary.
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    _args: readonly string[],
    cb: (err: Error) => void,
  ) => {
    cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
  },
}));

describe('assertGitVersion — git binary missing', () => {
  it('wraps the spawn failure in the "git is required" boot error', async () => {
    await expect(assertGitVersion()).rejects.toThrow(
      /git is required but could not be run: .*ENOENT/,
    );
  });
});
