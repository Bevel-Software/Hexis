import type { AuthUser } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { ListenerSeam, type NotifyingListener } from '../../shared/listener-seam.js';

const log = logger('cr');

/** Somebody a listener can write to: an account's id, address and name. */
export type ChangeRequestPerson = Pick<AuthUser, 'id' | 'email' | 'name'>;

/**
 * A change request was OPENED — by a person in the app or by an agent through
 * its tool, which take the one road (`VersionControlService.openChangeRequest`).
 * Raised once per request, after its row exists and its source branch was
 * pushed, or the push was refused: the request exists either way, and the
 * branch's next push carries the commits. Never raised for a request that is
 * reopened after a failed branch deletion — it was opened once already — nor
 * for one updated from its target.
 */
export interface ChangeRequestOpenedEvent {
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  /** Who opened it: the person, or the person the agent acted for. */
  openedBy: ChangeRequestPerson;
  /**
   * The distinct people eligible to approve some changed path, as accounts —
   * the eligibility the request's per-file approvals show, with the
   * roles and groups expanded to their members, each person once however
   * many paths or roles name them. Only a person with an account is here: a
   * listener writes to accounts. The author is not left out; a listener that
   * will not tell people of their own request reads `openedBy`.
   */
  approvers: ChangeRequestPerson[];
  /**
   * Eligible approvers the event cannot hand over as accounts, each counted
   * once: a person the access model names who has no account yet, and the
   * built-in `everyone` (anyone signed in may approve, and nobody can be
   * listed for that). Zero when every approver is in `approvers`.
   */
  unresolvedApprovers: number;
  /**
   * The request's address, when the deployment has a public address
   * configured (`PUBLIC_FRONTEND_URL`). Absent otherwise: a listener that
   * knows where the app is builds the link to `/change-requests/<number>`
   * itself.
   */
  url?: string;
  /**
   * Whether the source branch's push was refused by the host as the request
   * was opened: the request exists, but its commits reach the host only when
   * an agent has reconciled the branch and pushed again, which is seconds
   * usually and may fail. A listener decides what that is worth — a mail
   * worded for it, a delay, or none — because a reviewer sent to the
   * request before then opens one whose changes are not there yet. False
   * when the push landed.
   */
  pushPending: boolean;
}

/**
 * A listener answers how it reached the approvers — a non-empty channel name,
 * `'email'` say — or null when it did not; the rule is {@link NotifyingListener}'s:
 * awaited, a throw logged and counted as null, never failing the open.
 */
export type ChangeRequestOpenedHook = NotifyingListener<ChangeRequestOpenedEvent>;

/**
 * Core's seam for "a change request was opened": a deployment (the cloud
 * with its mail, an enterprise overlay) registers how to tell the reviewers,
 * and core says in its answer whether somebody did. Core registers nothing,
 * so a core-only deployment notifies nobody and the request waits to be
 * found in the app, as before.
 */
export interface IChangeRequestHooks {
  onChangeRequestOpened(hook: ChangeRequestOpenedHook): void;
  /** Run every listener in registration order; the channels that reached the approvers, in that order. */
  runChangeRequestOpened(event: ChangeRequestOpenedEvent): Promise<string[]>;
}

export class ChangeRequestHooks implements IChangeRequestHooks {
  // The request exists whether or not the reviewers were told: the opener's
  // answer says they were not, and the request is found in the app as before.
  private readonly opened = new ListenerSeam<ChangeRequestOpenedEvent>(
    log,
    'a change-request-opened listener failed; the reviewers were not notified by it:',
  );

  onChangeRequestOpened(hook: ChangeRequestOpenedHook): void {
    this.opened.add(hook);
  }

  runChangeRequestOpened(event: ChangeRequestOpenedEvent): Promise<string[]> {
    return this.opened.run(event);
  }
}
