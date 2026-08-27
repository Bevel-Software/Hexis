/**
 * Connection health — whether a tool's credential actually WORKS, as opposed to
 * whether one is stored.
 *
 * The Secrets Vault answers "is there a value here". That is the only question
 * it can answer, and for a long time the UI treated the answer as if it were
 * "is this connection working" — which is how a mistyped API key came to render
 * as `Connected`. This module answers the second question by making a real
 * authenticated call and recording what came back, so the badge reports
 * evidence rather than inference.
 *
 * Deliberately a SEPARATE module from the vault: the vault must never depend on
 * the tool catalog (it is the swap seam for an external secret manager), and a
 * probe needs the catalog to know what to call. Routes compose the two.
 */

/**
 * The verdict of one probe.
 *
 *  - `ok`           — we called the provider and it accepted the credential.
 *  - `failed`       — the provider DEFINITIVELY rejected it (401/403 and the
 *                     like). This is the only status that accuses the
 *                     credential, so it is only ever set on evidence.
 *  - `unverifiable` — we do not know. Either the tool declares no way to test
 *                     it, or the attempt could not reach a verdict (provider
 *                     down, network error, an unexpected status). `detail` says
 *                     which.
 *
 * The third value is load-bearing. Collapsing "checked, fine" into "can't
 * check" would resurrect the original bug in a new shape; collapsing "can't
 * check" into "failed" would make the badge cry wolf during someone else's
 * outage, which trains people to ignore it — the same end state by a different
 * road. An honest UI needs all three.
 */
export type ConnectionHealthStatus = 'ok' | 'failed' | 'unverifiable';

export interface ConnectionHealthRecord {
  /** The UTCP manual name the verdict is about. */
  manualName: string;
  status: ConnectionHealthStatus;
  /**
   * Why, in the provider's own words where there are any: the rejection message
   * for `failed`, the reason we could not conclude for `unverifiable`. Null for
   * `ok` — a working connection has nothing to explain.
   */
  detail: string | null;
  checkedAt: Date;
}

export interface IConnectionHealthService {
  /**
   * Probe one manual's credential AS `userId`, persist the verdict, return it.
   *
   * Runs as a specific person because that is the only question the badge asks:
   * a probe resolves whatever mix of shared (admin) and personal values that
   * person actually gets, so an admin's successful probe can never mark other
   * users healthy on a shared key they may not have.
   *
   * Never throws for a probe outcome — a provider rejection and an unreachable
   * host are both RESULTS here, not errors. It throws only when the manual
   * itself can't be found or read.
   */
  probe(userId: string, userEmail: string, manualName: string): Promise<ConnectionHealthRecord>;

  /**
   * The stored verdicts for `manualNames`, for the caller. Manuals never probed
   * are simply absent from the result — the caller decides what an absent
   * verdict means (the status route reads it as "not checked yet", which the UI
   * renders the same as unverifiable: we do not know).
   */
  statusFor(userId: string, manualNames: string[]): Promise<ConnectionHealthRecord[]>;

  /**
   * Drop the caller's stored verdict for a manual — called when their secret
   * for it changes, so a stale `failed` from the OLD key never outlives it.
   * A fresh probe replaces it; until that lands, "we don't know" is the honest
   * state, and it is strictly better than showing a verdict about a value the
   * user has already replaced.
   */
  forget(userId: string, manualName: string): Promise<void>;

  /**
   * Drop EVERY user's stored verdict for a manual — called when its SHARED
   * (admin) value changes, which invalidates the verdict for everyone at once,
   * not just the admin who typed it. Without this, a rotated shared key would
   * leave every other user's badge asserting a result about the value it
   * replaced, which is the same lie this module exists to remove.
   */
  forgetAll(manualName: string): Promise<void>;
}
