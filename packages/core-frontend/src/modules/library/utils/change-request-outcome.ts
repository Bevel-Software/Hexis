import type { ChangeRequestOutcome } from '../../change-requests';

/**
 * What the skill page tells a person once the whole-change dialog settled a
 * request: applied means its changes are on their way in; closed (its last
 * file declined, or the request deleted) means nothing was merged, and saying
 * "being applied" then would claim a change that never lands.
 */
export function changeRequestOutcomeMessage(outcome: ChangeRequestOutcome): string {
  return outcome === 'applied' ? 'Change request is being applied' : 'Change request closed. Nothing was changed.';
}
