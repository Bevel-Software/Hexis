import { describe, expect, it } from 'vitest';
import { ClassifiedFailure, classifyGitFailure, failureOf } from '../git-connection-check.js';

/**
 * Representative failures, spelled the way they actually reach the classifier:
 * `kb-git.ts` prefixes `git <subcommand> failed: ` onto execFile's message,
 * which is `Command failed: <argv>` followed by git's stderr; the runner
 * prefixes `KB startup step "<name>" failed: ` onto a step's throw.
 */
const gitFailed = (sub: string, url: string, stderr: string) =>
  `git ${sub} failed: Command failed: git -c core.longpaths=true ${sub} ${url}\n${stderr}`;

const URL = 'https://github.com/acme/kb.git';

describe('classifyGitFailure', () => {
  it('credentials rejected', () => {
    expect(
      classifyGitFailure(
        gitFailed('ls-remote', URL, "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/kb.git/'"),
      ).kind,
    ).toBe('credentials-rejected');
    expect(
      classifyGitFailure(
        gitFailed('ls-remote', URL, "fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
      ).kind,
    ).toBe('credentials-rejected');
    expect(
      classifyGitFailure(gitFailed('ls-remote', 'https://gitlab.com/acme/kb.git', 'remote: HTTP Basic: Access denied')).kind,
    ).toBe('credentials-rejected');
  });

  it('repository not found', () => {
    expect(
      classifyGitFailure(
        gitFailed('ls-remote', URL, "remote: Repository not found.\nfatal: repository 'https://github.com/acme/kb.git/' not found"),
      ).kind,
    ).toBe('not-found');
  });

  it('host unreachable', () => {
    expect(
      classifyGitFailure(
        gitFailed('ls-remote', 'https://nope.invalid/kb.git', "fatal: unable to access 'https://nope.invalid/kb.git/': Could not resolve host: nope.invalid"),
      ).kind,
    ).toBe('unreachable');
    expect(
      classifyGitFailure(
        gitFailed('ls-remote', 'https://127.0.0.1:1/kb.git', "fatal: unable to access 'https://127.0.0.1:1/kb.git/': Failed to connect to 127.0.0.1 port 1: Connection refused"),
      ).kind,
    ).toBe('unreachable');
    expect(classifyGitFailure('git clone failed: Command failed: git clone … ETIMEDOUT').kind).toBe('unreachable');
  });

  it('write refused: a token that can read but not push', () => {
    // GitHub, classic token without `repo` write / fine-grained without contents:write.
    expect(
      classifyGitFailure(
        gitFailed('push', 'origin main', "remote: Permission to acme/kb.git denied to x-access-token.\nfatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 403"),
      ).kind,
    ).toBe('write-refused');
    expect(
      classifyGitFailure(
        gitFailed('push', 'origin main', "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 403"),
      ).kind,
    ).toBe('write-refused');
    // A bare 403 on a push is a refused write: ls-remote already accepted these credentials.
    expect(
      classifyGitFailure(gitFailed('push', 'origin main', 'error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403')).kind,
    ).toBe('write-refused');
  });

  it('push refused by host policy: branch protection or a hook', () => {
    expect(
      classifyGitFailure(
        gitFailed('push', 'origin main', 'remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)'),
      ).kind,
    ).toBe('push-refused-by-policy');
    // GitLab says "not allowed to push" too — the policy reading must win.
    expect(
      classifyGitFailure(
        gitFailed('push', 'origin main', 'remote: GitLab: You are not allowed to push code to protected branches on this project.\n ! [remote rejected] main -> main (pre-receive hook declined)'),
      ).kind,
    ).toBe('push-refused-by-policy');
  });

  it('startup step failed, naming the step', () => {
    const failure = classifyGitFailure('KB startup step "groups-to-plugins" failed: Cannot read properties of undefined');
    expect(failure.kind).toBe('step-failed');
    expect(failure.cause).toContain('"groups-to-plugins"');
    expect(classifyGitFailure('KB startup step "template-files" stopped the boot: roles.yaml is not valid YAML').kind).toBe(
      'step-failed',
    );
  });

  it('a step whose own message merely contains a git-ish word is still a step failure', () => {
    expect(classifyGitFailure('KB startup step "template-files" failed: template file not found').kind).toBe('step-failed');
  });

  it('a step that failed in git is classified by what git said', () => {
    expect(
      classifyGitFailure(
        `KB startup step "migrate" failed: ${gitFailed('push', 'origin main', "remote: Permission to acme/kb.git denied to bot.\nfatal: unable to access 'x': The requested URL returned error: 403")}`,
      ).kind,
    ).toBe('write-refused');
  });

  it('unknown, pointing at the server log — not at re-saving or restarting', () => {
    const failure = classifyGitFailure('KB remote is empty and cannot be seeded: no initial Admin was supplied (ADMIN_EMAIL).');
    expect(failure.kind).toBe('unknown');
    expect(failure.cause).toMatch(/server log/i);
    expect(failure.cause).not.toMatch(/sav|restart/i);
  });

  it('does not read status digits out of a URL', () => {
    expect(
      classifyGitFailure(gitFailed('ls-remote', 'https://example.com/acme/403-archive.git', 'fatal: something odd happened')).kind,
    ).toBe('unknown');
  });

  it('does not read status digits out of a port number', () => {
    for (const port of ['401', '403', '404']) {
      for (const sub of ['ls-remote', 'push']) {
        const text = gitFailed(
          sub,
          `https://git.example.com:${port}/kb.git`,
          `fatal: unable to access 'x': Failed to connect to git.example.com port ${port}: Connection refused`,
        );
        expect(classifyGitFailure(text).kind).toBe('unreachable');
      }
    }
  });

  it('never quotes the raw text in the cause', () => {
    const raw = gitFailed('ls-remote', URL, 'fatal: weird-marker-7f3a');
    for (const text of [raw, `KB startup step "s" failed: ${raw}`]) {
      expect(classifyGitFailure(text).cause).not.toContain('weird-marker-7f3a');
    }
  });

  it('failureOf prefers the classification a failure carries over its scrubbed message', () => {
    const carried = classifyGitFailure(gitFailed('push', 'origin main', 'remote: Permission to acme/kb.git denied to bot.'));
    expect(carried.kind).toBe('write-refused');
    expect(failureOf(new ClassifiedFailure('git push failed: *** ***', carried))).toEqual(carried);
    // Anything else is read from its text.
    expect(failureOf(new Error('KB startup step "s" failed: boom')).kind).toBe('step-failed');
    expect(failureOf('Could not resolve host').kind).toBe('unreachable');
  });

  it('every cause is one sentence', () => {
    const samples = [
      'Authentication failed',
      'Repository not found',
      'Could not resolve host',
      'git push failed: Permission to a/b denied',
      'pre-receive hook declined',
      'KB startup step "x" failed: boom',
      'boom',
    ];
    for (const s of samples) {
      const { cause } = classifyGitFailure(s);
      // One terminal full stop, at the end.
      expect(cause.trim().endsWith('.')).toBe(true);
      expect(cause.replace(/\([^)]*\)/g, '').slice(0, -1)).not.toMatch(/\.\s/);
    }
  });
});
