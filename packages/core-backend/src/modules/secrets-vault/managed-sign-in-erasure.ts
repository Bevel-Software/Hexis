import type { ISecretsVaultService, ManagedRowsWriter } from './secrets-vault.contract.js';

/**
 * The vault's slice of account erasure (an `IErasureParticipant`, see the
 * auth module): a managed sign-in's tokens are told to their provider before
 * the user row goes and the vault rows cascade away with it. Switching an
 * account off reaches the same call through `onAccountDeactivated`; erasing
 * an account that was never switched off would otherwise drop its rows with
 * the grant still live at the provider, which is the one leak the revoker
 * exists to close.
 *
 * Two passes, because a sign-in can land while an erasure runs:
 *
 * - `before`, outside the transaction: revocation is best effort and
 *   idempotent (a revoked token is deleted here either way, and a second run
 *   finds no managed row). A row the vault could not settle (its tokens kept
 *   changing under the revoke) makes the vault throw, and the erasure is
 *   refused with it: the account itself is not erased, the rows already
 *   revoked and deleted in this pass stay deleted (each was told to its
 *   provider first), the admin retries, and the retry finds only what is
 *   still to settle.
 * - `inTransaction`, beside the user row's deletion: whatever managed row
 *   landed since (a reconnect, a broker handoff) is locked, revoked and
 *   deleted in the same transaction, so a handoff arriving after the lock
 *   waits and then finds no row, and nothing cascades away unrevoked. A
 *   sign-in begun after the lock inserts a row holding a nonce and no grant,
 *   which the cascade removes harmlessly.
 */
export function managedSignInErasure(vault: Pick<ISecretsVaultService, 'removeManagedRowsOfUser'>): {
  before(target: { userId: string }): Promise<void>;
  inTransaction(tx: ManagedRowsWriter, target: { userId: string }): Promise<void>;
} {
  return {
    async before(target) {
      await vault.removeManagedRowsOfUser(target.userId);
    },
    async inTransaction(tx, target) {
      await vault.removeManagedRowsOfUser(target.userId, tx);
    },
  };
}
