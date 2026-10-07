/**
 * Shared error-text sanitizer for the pending-commits failure pipeline.
 *
 * Two consumers — both forward error text outside of trust boundaries:
 *
 *   - `pending-commits.worker.ts` writes `lastError` into the database
 *     (`pending_commits.last_error`) and logs the same string to stdout.
 *   - the recovery-agent runner (an enterprise `RecoveryAgentRunner` impl,
 *     e.g. `modules/agent/background-recovery-agent.runner.ts`) interpolates
 *     the message into an LLM prompt that hits OpenAI.
 *
 * Git surfaces credentialed URLs verbatim in stderr (`fatal: unable to
 * access 'https://x-access-token:ghp_…@github.com/…'`), and the underlying
 * `git push` shell-out can also yield `Authorization: Bearer …` headers
 * when remote helpers are involved. We strip the obvious patterns and clip
 * the result so a runaway stack trace can't blow past prompt budgets.
 *
 * Intentional non-goals: this is best-effort regex masking, not a full
 * secret-detection pipeline. We're catching the formats we actually see;
 * a determined attacker could still smuggle a credential through, but the
 * worker doesn't see attacker-controlled error text in the first place.
 */

/** Truncation cap for prompts / DB column. ~200 chars keeps prompts tight. */
const MAX_LEN = 200;

const REDACTIONS: Array<readonly [RegExp, string]> = [
  // `https://user:pass@host/…` and the GitHub-specific `x-access-token:…@`
  // form `git push` prints. Keep the scheme + host so the message still
  // hints at what was being talked to.
  [/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
  // `Authorization: Bearer <token>` headers (proxy / smart-http output).
  [/(authorization:\s*bearer\s+)\S+/gi, '$1[REDACTED]'],
  // `token=<value>` / `secret=<value>` / `api_key=<value>` style params.
  [/((?:token|secret|api[_-]?key|access[_-]?token|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]'],
  // Bare hex blobs long enough to be tokens (≥32 chars). Catches `ghp_*`
  // *after* the `token=` mask above strips obvious labels — this one is
  // the fallback for unlabelled hex secrets.
  [/[a-f0-9]{32,}/gi, '[REDACTED]'],
  // Anything that looks like a GitHub PAT / fine-grained PAT prefix.
  [/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED]'],
];

/**
 * Normalise an unknown thrown value into a single-line string with secrets
 * masked and length capped. Safe to log, persist, or interpolate into an
 * LLM prompt. `maxLen` raises the cap for text a person reads in full (a
 * gate refusal naming every file it waits on runs well past a prompt line).
 */
export function sanitizeError(err: unknown, opts: { maxLen?: number } = {}): string {
  // Only a finite positive whole cap overrides: NaN / Infinity would disable
  // truncation, and zero or less would slice into a malformed result.
  const maxLen =
    Number.isSafeInteger(opts.maxLen) && (opts.maxLen as number) > 0 ? (opts.maxLen as number) : MAX_LEN;
  const raw = err instanceof Error ? err.message : String(err);
  // Collapse newlines + control chars so the result is a single line. Stack
  // traces are deliberately dropped — `err.message` is the meaningful part;
  // the stack would be over-budget after truncation anyway.
  let out = raw.replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > maxLen) {
    out = out.slice(0, maxLen - 1) + '…';
  }
  return out;
}

/**
 * What a person reads about a failed push or pull: one of a few fixed
 * sentences, chosen from the git failure but never quoting it.
 *
 * `sanitizeError` masks secrets but still returns the host's own words —
 * `remote: Internal Server Error`, a git `fatal:` line, a URL — and those must
 * not reach the browser (the sync banner, a route's answer). The raw text
 * belongs in the server log, which is where the banner already sends whoever
 * can act on it. Order matters: an auth failure also reads "unable to access",
 * and a permission refusal is told apart from a rejected credential.
 */
export function describeSyncFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/authentication failed|could not read username|invalid username or password|returned error: 401/i.test(raw)) {
    return "The repository host did not accept this server's credentials.";
  }
  // Credentials the host accepted but that may not write here — a 403, a
  // "Permission to … denied", a token scoped to other repositories (GitHub
  // answers those "Repository not found"). Replacing the credential is the
  // wrong fix; granting it push access is the right one.
  if (/permission (to .* )?denied|returned error: 403|write access .* not granted|repository not found/i.test(raw)) {
    return "The repository host did not give this server's credentials permission to push here.";
  }
  if (/could not resolve host|failed to connect|couldn't connect|connection (refused|timed out|reset)|network is unreachable|operation timed out/i.test(raw)) {
    return 'The repository host could not be reached.';
  }
  if (/non-fast-forward|fetch first|updates were rejected/i.test(raw)) {
    return 'The branch changed on the repository host and could not be reconciled automatically.';
  }
  return 'The repository host refused the request.';
}
