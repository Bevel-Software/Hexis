/** The bots could not be loaded; Myself waits for the person to confirm it. */
export interface UnavailableChoice {
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
}

/**
 * Whether a connection may be made with the "Connect as" choice as it
 * stands: once the bots on offer have answered — before that, the default
 * Myself is not yet a choice anyone made — and then always, unless they
 * failed to load and Myself is not yet confirmed.
 */
export function canConnectAs(choices: { settled: boolean; unavailable: UnavailableChoice | undefined }): boolean {
  return choices.settled && (!choices.unavailable || choices.unavailable.confirmed);
}
