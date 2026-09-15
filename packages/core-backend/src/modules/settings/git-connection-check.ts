/**
 * What went wrong between this deployment and its git host, in the terms an
 * admin can act on.
 *
 * ONE classifier for every place that talks to the KB remote on the admin's
 * behalf: the connection check (Test connection, and the save that proves the
 * connection first) and the setup-time KB startup phase. Two tables of git
 * wordings drift — a host that changes its phrasing gets learned in one and
 * misread in the other — so there is exactly one, here.
 *
 * The raw text is an INPUT, never an output: a `cause` is a fixed sentence per
 * kind (the one exception is a startup step's own name, which is code, not
 * git output). What git actually said belongs in the server log.
 */

export type GitFailureKind =
  | 'credentials-rejected'
  | 'not-found'
  | 'unreachable'
  | 'write-refused'
  | 'push-refused-by-policy'
  | 'step-failed'
  | 'unknown';

export interface GitFailure {
  kind: GitFailureKind;
  /** One sentence: what to do about it. */
  cause: string;
}

const CAUSES: Record<Exclude<GitFailureKind, 'step-failed'>, string> = {
  'credentials-rejected':
    'The host rejected the credentials — check the access token, and that the token username matches the host (GitHub x-access-token, GitLab oauth2, Bitbucket x-token-auth).',
  'not-found':
    'There is no repository at that address, or the token cannot see it — check the repository address and that the token has access to that repository.',
  unreachable:
    "This server could not reach the git host — check the repository address and this server's network access to that host, then retry.",
  'write-refused':
    'The token can read the repository but not write to it — grant it write (push) access to the repository, then retry.',
  'push-refused-by-policy':
    "A branch protection rule or hook on the repository refused the initialization push — allow the deployment's account to push to the protected branches, then retry.",
  unknown:
    'The knowledge base could not be initialized for a reason not listed here — the server log has the full error.',
};

function stepFailed(step: string): GitFailure {
  return {
    kind: 'step-failed',
    cause: `The startup step "${step}" failed — the server log has its error; fix what it names, then retry.`,
  };
}

/**
 * How the startup runner prefixes a failure it attributes to a step
 * (`kb-startup-runner.ts`): a throw, or a declared `stopBoot`.
 */
const STEP_PREFIX = /KB startup step "([^"]+)" (?:failed|stopped the boot): ([\s\S]*)/;

/** How `kb-git.ts` prefixes a failed git invocation: `git <subcommand> failed: …`. */
const GIT_PREFIX = /^git \S+ failed:/;

/**
 * Classify a failure from its (already redacted) text.
 *
 * Order is load-bearing. Refusals that NAME a policy or a permission are read
 * before the generic status codes they arrive with — GitHub answers a
 * read-only token's push with a 403 that would otherwise read as "bad
 * credentials", and GitLab's protected-branch refusal also says "not allowed
 * to push".
 */
export function classifyGitFailure(text: string): GitFailure {
  let body = text;
  const step = STEP_PREFIX.exec(text);
  if (step) {
    // A step that failed IN GIT is classified by what git said — that cause is
    // the more actionable one. A step that failed on its own terms is named;
    // its message is prose we cannot promise to read correctly.
    if (!GIT_PREFIX.test(step[2]!.trimStart())) return stepFailed(step[1]!);
    body = step[2]!;
  }

  // A status number proves nothing from inside a URL — `/acme/404-notes.git`
  // or a port carries the digits with no refusal having happened, and a failed
  // command's message quotes its whole argv. Words still count wherever they
  // appear; digits only outside URLs.
  const m = body.replace(/\bhttps?:\/\/\S+/gi, ' ');
  const isPush = /\bgit push failed\b/i.test(m);

  if (
    /pre-receive hook declined|hook declined|protected branch|GH006|GH013|\[remote rejected\]/i.test(m)
  ) {
    return known('push-refused-by-policy');
  }
  if (
    /Permission to \S+ denied|write access to repository not granted|not allowed to push|push access denied/i.test(m) ||
    // A 403 on a PUSH: the phase got past `ls-remote` with these credentials,
    // so the host knows who this is and is refusing the write, not the login.
    (isPush && /\b403\b/.test(m))
  ) {
    return known('write-refused');
  }
  if (/Authentication failed|could not read Username|invalid credentials|HTTP Basic: Access denied|\b40[13]\b/i.test(m)) {
    return known('credentials-rejected');
  }
  if (/not found|repository .* does not exist|\b404\b/i.test(m)) {
    return known('not-found');
  }
  if (
    /timed out|ETIMEDOUT|could not resolve host|Failed to connect|Connection refused|ECONNREFUSED|Network is unreachable|SSL|certificate|unable to access/i.test(m)
  ) {
    return known('unreachable');
  }
  return known('unknown');
}

function known(kind: Exclude<GitFailureKind, 'step-failed'>): GitFailure {
  return { kind, cause: CAUSES[kind] };
}
