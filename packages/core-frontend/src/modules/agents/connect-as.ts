/** The agents could not be loaded; Everything waits for the person to confirm it. */
export interface UnavailableChoice {
  confirmed: boolean;
  onConfirm: (confirmed: boolean) => void;
}

/**
 * Whether a connection may be made with the "Connect as" choice as it
 * stands: always, unless the agents failed to load and Everything is not yet
 * confirmed.
 */
export function canConnectAs(unavailable: UnavailableChoice | undefined): boolean {
  return !unavailable || unavailable.confirmed;
}
