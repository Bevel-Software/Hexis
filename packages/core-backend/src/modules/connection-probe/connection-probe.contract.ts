/**
 * Does this tool's stored credential actually WORK?
 *
 * The Secrets Vault can only answer "is there a value here", and the UI read
 * that as "is this working" — so a mistyped key rendered as **Connected** while
 * the provider's rejection reached nothing but a `console.warn`. A probe makes
 * a real authenticated call and reports what the provider said.
 *
 * The verdict is deliberately NOT persisted. A stored verdict is evidence with
 * a date on it, and evidence from yesterday is precisely the stale claim this
 * feature exists to stop the badge from making: the credential can be revoked,
 * rotated, or expire between the check and the render, and a row in a table
 * cannot know that. So a verdict lives exactly as long as the page that asked
 * for it, and "Connected" means "a call succeeded moments ago", not "a call
 * succeeded once".
 */
export type ProbeStatus = 'ok' | 'failed' | 'unverifiable';

/** One probe's answer. */
export interface ProbeVerdict {
  status: ProbeStatus;
  /**
   * The provider's own words when it rejected the credential, or why we
   * couldn't tell. `null` only when the status is `ok`.
   */
  detail: string | null;
  /** When the call was made — the "checked just now" the UI shows. */
  checkedAt: Date;
}

export interface IConnectionProbeService {
  /**
   * Test one tool's credential for one user and return the verdict.
   *
   * `null` when no tool has that slug OR the caller can't read it — the same
   * fail-closed pair the tool contract uses everywhere, so a 404 never confirms
   * that a tool the caller can't see exists.
   *
   * Everything else — an unreachable provider, a tool with nothing to call, a
   * variable that isn't set — comes back as a verdict rather than an error,
   * because "we couldn't tell" is an answer the UI has to render.
   */
  probe(userId: string, userEmail: string, slug: string): Promise<ProbeVerdict | null>;
}
