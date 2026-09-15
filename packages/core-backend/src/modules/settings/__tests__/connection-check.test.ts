import { describe, expect, it } from 'vitest';
import {
  checkRepositoryConnection,
  classifyReadFailure,
  classifyWriteFailure,
  type GitRunner,
} from '../connection-check.js';

const CONNECTION = {
  url: 'https://github.com/acme/kb.git',
  token: 'ghp_verysecret',
  username: 'x-access-token',
};

/** How execFile reports a failed git: the command line, then git's stderr. */
const gitError = (stderr: string) => new Error(`Command failed: git ...\n${stderr}`);

/**
 * A fake git: `ls-remote` answers with `listing` (or throws), the scratch
 * `init` succeeds, and the dry-run `push` answers with `push` (or throws).
 * Records every call so a test can see what was — and was not — asked.
 */
function fakeGit(opts: { listing?: string | Error; push?: string | Error }) {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push(args);
    const answer = args.includes('ls-remote')
      ? (opts.listing ?? '')
      : args.includes('push')
        ? (opts.push ?? '')
        : '';
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { run, calls };
}

/**
 * The write probe's whole premise: a host that lets git into receive-pack
 * answers the deletion of an absent ref with "remote ref does not exist" —
 * that is a YES — while a host refusing the push side says so at that door.
 * Mixing the two up either refuses every working token or saves read-only ones.
 */
describe('classifyWriteFailure — a receive-pack refusal vs "remote ref does not exist"', () => {
  it('reads "remote ref does not exist" as write access', () => {
    const text =
      "error: unable to delete 'hexis-write-check-1a2b': remote ref does not exist\n" +
      "error: failed to push some refs to 'https://github.com/acme/kb.git'";
    expect(classifyWriteFailure(text)).toBe('writable');
  });

  it.each([
    [
      'GitHub classic',
      "remote: Permission to acme/kb.git denied to octocat.\nfatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 403",
    ],
    [
      'GitHub fine-grained',
      "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 403",
    ],
    [
      'GitLab',
      "remote: You are not allowed to push code to this project.\nfatal: unable to access 'https://gitlab.com/acme/kb.git/': The requested URL returned error: 403",
    ],
    ['Azure DevOps', "remote: TF401027: You need the Git 'GenericContribute' permission to perform this action."],
    ['a bare 403', "fatal: unable to access 'https://git.example.com/kb.git/': The requested URL returned error: 403"],
  ])('reads a receive-pack refusal (%s) as read-only', (_host, text) => {
    expect(classifyWriteFailure(text)).toBe('read-only');
  });

  /**
   * A public repository reads anonymously, so the push is where a token is
   * first presented — a made-up one fails THERE, and that is bad credentials,
   * not a permission to grant.
   */
  it.each([
    [
      'GitHub invalid token',
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/Bevel-Software/Hexis.git/'",
    ],
    ['a bare 401', "fatal: unable to access 'https://git.example.com/kb.git/': The requested URL returned error: 401"],
    ['no credential offered', "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
  ])('reads an authentication failure at push (%s) as credentials, not read-only', (_case, text) => {
    expect(classifyWriteFailure(text)).toBe('credentials');
  });

  it('keeps an unreachable host unreachable, not read-only', () => {
    expect(
      classifyWriteFailure("fatal: unable to access 'https://x/': Could not resolve host: x"),
    ).toBe('unreachable');
    expect(classifyWriteFailure('Error: Command failed: git push — timed out')).toBe('unreachable');
  });
});

describe('classifyReadFailure', () => {
  it('tells credentials, a missing repository and an unreachable host apart', () => {
    expect(
      classifyReadFailure("fatal: Authentication failed for 'https://github.com/acme/kb.git/'"),
    ).toBe('credentials');
    expect(
      classifyReadFailure("fatal: unable to access 'https://h/': The requested URL returned error: 403"),
    ).toBe('credentials');
    expect(classifyReadFailure("remote: Repository not found.\nfatal: repository 'https://h/' not found")).toBe(
      'not-found',
    );
    expect(classifyReadFailure("fatal: unable to access 'https://h/': Could not resolve host: h")).toBe(
      'unreachable',
    );
    expect(
      classifyReadFailure("fatal: unable to access 'https://h/': SSL certificate problem: self signed certificate"),
    ).toBe('unreachable');
  });
});

describe('checkRepositoryConnection', () => {
  it('is connected when the token reads and the dry-run push gets in', async () => {
    const git = fakeGit({
      listing: 'ref: refs/heads/main\tHEAD\nabc\tHEAD\nabc\trefs/heads/main\ndef\trefs/heads/dev\n',
      push: gitError("error: unable to delete 'hexis-write-check-x': remote ref does not exist"),
    });
    const result = await checkRepositoryConnection(CONNECTION, git.run);
    expect(result).toEqual({ outcome: 'connected', branches: ['main', 'dev'], defaultBranch: 'main', empty: false });
    // `--heads` would drop the HEAD symref, and with it the default branch.
    const listing = git.calls.find((args) => args.includes('ls-remote'))!;
    expect(listing).toContain('--symref');
    expect(listing).not.toContain('--heads');
    expect(listing.slice(-2)).toEqual(['HEAD', 'refs/heads/*']);
    // The write probe is a DRY RUN deleting a scratch ref — never a real push.
    const push = git.calls.find((args) => args.includes('push'))!;
    expect(push).toContain('--dry-run');
    expect(push.at(-1)).toMatch(/^:refs\/heads\/hexis-write-check-[0-9a-f]+$/);
    expect(push).toContain(CONNECTION.url);
  });

  it('counts an empty repository as connected', async () => {
    const git = fakeGit({ listing: '', push: gitError("error: unable to delete 'x': remote ref does not exist") });
    expect(await checkRepositoryConnection(CONNECTION, git.run)).toMatchObject({
      outcome: 'connected',
      empty: true,
      branches: [],
    });
  });

  it('is read-only when the host refuses the push side, naming the permission to grant', async () => {
    const git = fakeGit({
      listing: 'abc\trefs/heads/main\n',
      push: gitError('remote: Write access to repository not granted.\nfatal: ... error: 403'),
    });
    const result = await checkRepositoryConnection(CONNECTION, git.run);
    expect(result.outcome).toBe('read-only');
    if (result.outcome !== 'read-only') return;
    expect(result.field).toBe('gitToken');
    expect(result.error).toMatch(/Contents: Read and write/);
  });

  it('is rejected as bad credentials when a public repository reads but the push fails authentication', async () => {
    const git = fakeGit({
      // Anonymous read of a public repository: the token was never asked for.
      listing: 'abc\trefs/heads/main\n',
      push: gitError(
        "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/acme/kb.git/'",
      ),
    });
    const result = await checkRepositoryConnection(CONNECTION, git.run);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'credentials', field: 'gitToken' });
    if (result.outcome === 'rejected') {
      expect(result.error).toMatch(/rejected those credentials/);
      expect(result.error).not.toMatch(/Read and write/);
    }
  });

  it('is rejected, against the token, when the read is refused — and never tries to write', async () => {
    const git = fakeGit({ listing: gitError("fatal: Authentication failed for 'https://github.com/acme/kb.git/'") });
    const result = await checkRepositoryConnection(CONNECTION, git.run);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'credentials', field: 'gitToken' });
    expect(git.calls.some((args) => args.includes('push'))).toBe(false);
  });

  it('is rejected, against the address, when the host cannot be reached', async () => {
    const git = fakeGit({ listing: gitError("fatal: unable to access 'https://h/': Could not resolve host: h") });
    const result = await checkRepositoryConnection(CONNECTION, git.run);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'unreachable', field: 'kbRepoUrl' });
    if (result.outcome === 'rejected') expect(result.error).toMatch(/could not reach that host/i);
  });

  /** How execFile reports its own timeout: SIGTERM, and nothing about time in the message. */
  it('is rejected as unreachable when git is killed by the timeout', async () => {
    const killed = Object.assign(new Error('Command failed: git ls-remote\n'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
    });
    const git = fakeGit({ listing: killed });
    const result = await checkRepositoryConnection(CONNECTION, git.run);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'unreachable', field: 'kbRepoUrl' });
  });

  it('rejects a URL carrying credentials against the address, in the rule’s words, without running git', async () => {
    const git = fakeGit({ listing: '' });
    const result = await checkRepositoryConnection(
      { ...CONNECTION, url: 'https://u:secret@github.com/acme/kb.git' },
      git.run,
    );
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'invalid-address', field: 'kbRepoUrl' });
    if (result.outcome === 'rejected') {
      expect(result.error).toMatch(/Remove the username and token from the URL/);
    }
    expect(git.calls).toEqual([]);
  });

  it('never quotes the token back, even in an unrecognised failure', async () => {
    const git = fakeGit({ listing: gitError(`something odd happened near ${CONNECTION.token}`) });
    const result = await checkRepositoryConnection(CONNECTION, git.run);
    expect(JSON.stringify(result)).not.toContain(CONNECTION.token);
  });

  it('keeps the token out of argv', async () => {
    const git = fakeGit({ listing: '', push: '' });
    await checkRepositoryConnection(CONNECTION, git.run);
    expect(JSON.stringify(git.calls)).not.toContain(CONNECTION.token);
  });
});
