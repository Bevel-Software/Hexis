/**
 * Auth's contract for a write that must not land on a switched-off account:
 * `whileSwitchedOn` runs `write` only while `email` is not switched off, and
 * keeps it so until `write` has finished. A switch-off either committed
 * before the check (`write` is refused with a 409 `deactivated` and never
 * runs) or waits until `write` is done. An address with no account yet counts
 * as switched on.
 *
 * Implemented by `AuthService`; other modules take this contract, not the
 * service, so how auth coordinates switch-offs stays its own.
 */
export interface IAccountSwitchGuard {
  whileSwitchedOn(email: string, write: () => Promise<void>): Promise<void>;
}
