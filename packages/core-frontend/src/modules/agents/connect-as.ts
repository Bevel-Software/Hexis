/** The agents could not be loaded; Everything waits for the person to confirm it. */
export interface UnavailableChoice {
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
}

/**
 * Whether a connection may be made with the "Connect as" choice as it
 * stands: once the agents on offer have answered — before that, the default
 * Everything is not yet a choice anyone made — and then always, unless they
 * failed to load and Everything is not yet confirmed.
 */
export function canConnectAs(choices: { settled: boolean; unavailable: UnavailableChoice | undefined }): boolean {
  return choices.settled && (!choices.unavailable || choices.unavailable.confirmed);
}
