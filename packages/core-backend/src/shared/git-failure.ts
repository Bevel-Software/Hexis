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

/** What a failure's text is the answer to, when the caller knows. */
export interface GitFailureContext {
  /**
   * `write`: the text answers a push. The startup phase's own pushes say so in
   * their `git push failed:` prefix; the connection check's dry-run push says
   * so here. Either way the repository was just READ with these credentials,
   * so a bare 403 or 404, or a generic "denied" / "forbidden", is the host
   * refusing the write — not a missing repository, not a bad login.
   */
  operation?: 'read' | 'write';
}

/**
 * Classify a failure from its text. Raw text is safe here — none of it reaches
 * the result — and is the better input where a caller holds it: a scrub
 * replacing a token that happens to spell part of git's wording would change
 * the reading.
 *
 * Order is load-bearing:
 *  1. Refusals that NAME a policy, then a permission, come first — GitHub
 *     answers a read-only token's push with a 403 that would otherwise read as
 *     "bad credentials", and GitLab's protected-branch refusal also says "not
 *     allowed to push".
 *  2. Authentication failures come before the generic refusals of a write: a
 *     public repository reads anonymously, so a push is where a made-up token
 *     is first presented, and "the host rejected the token" is not "grant it a
 *     permission". GitLab's auth failure says "Access denied", which a write's
 *     generic "denied" would otherwise claim.
 *  3. Then a write's generic refusals, a missing repository, and an
 *     unreachable host — "unable to access" last, because a refusal arrives
 *     wrapped in it.
 */
export function classifyGitFailure(text: string, context: GitFailureContext = {}): GitFailure {
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
  // command's message quotes its whole argv — nor from curl's own
  // `Failed to connect to <host> port 403`. Words still count wherever they
  // appear; digits only outside URLs and port numbers.
  const m = body.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bport \d+/gi, ' ');
  const isWrite = context.operation === 'write' || /\bgit push failed\b/i.test(m);

  if (
    /pre-receive hook declined|hook declined|protected branch|GH006|GH013|\[remote rejected\]/i.test(m)
  ) {
    return known('push-refused-by-policy');
  }
  // Each host's own words for "this token may not push": GitHub classic and
  // fine-grained, GitLab, Bitbucket, Azure DevOps.
  if (
    /Permission to \S+ denied|write access to repository not granted|not allowed to push|push access denied|lack one or more required privilege scopes|GenericContribute/i.test(
      m,
    )
  ) {
    return known('write-refused');
  }
  if (
    /Authentication failed|could not read Username|could not read Password|Invalid username or (?:token|password)|invalid credentials|HTTP Basic: Access denied|\b401\b/i.test(
      m,
    ) ||
    // On a read a 403 is the login refused; on a write the host already knows
    // who this is (see below).
    (!isWrite && /\b403\b/.test(m))
  ) {
    return known('credentials-rejected');
  }
  // A write refused in no host's particular words: these credentials just
  // read the repository, so it exists and the login worked.
  if (isWrite && /\b40[34]\b|\bdenied\b|forbidden|not found/i.test(m)) {
    return known('write-refused');
  }
  if (/not found|repository .* does not exist|\b404\b/i.test(m)) {
    return known('not-found');
  }
  if (
    /timed out|ETIMEDOUT|could not resolve host|Failed to connect|Connection refused|ECONNREFUSED|Network is unreachable|SSL|\bTLS\b|certificate|unable to access/i.test(
      m,
    )
  ) {
    return known('unreachable');
  }
  return known('unknown');
}

function known(kind: Exclude<GitFailureKind, 'step-failed'>): GitFailure {
  return { kind, cause: CAUSES[kind] };
}

/**
 * A failure whose message is already scrubbed for the log, carrying the
 * classification read from the text BEFORE the scrub.
 *
 * Scrubbing and classifying both want the raw text, and they cannot share it
 * in order: a scrub is free to rewrite the very words the classifier reads (a
 * token that spells `connect` turns "Failed to connect" into something else),
 * while carrying the raw text on to wherever classification happens would put
 * the secret into every error that travels. So the place that holds the raw
 * text does both, once, and only the scrubbed message and the fixed-sentence
 * classification leave it.
 */
export class ClassifiedFailure extends Error {
  constructor(
    message: string,
    readonly failure: GitFailure,
  ) {
    super(message);
    this.name = 'ClassifiedFailure';
  }
}

/** The classification a failure carries, else one read from its message. */
export function failureOf(err: unknown): GitFailure {
  if (err instanceof ClassifiedFailure) return err.failure;
  return classifyGitFailure(err instanceof Error ? err.message : String(err));
}
