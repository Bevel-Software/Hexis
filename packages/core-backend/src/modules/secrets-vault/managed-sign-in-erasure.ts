import type { ISecretsVaultService } from './secrets-vault.contract.js';

/**
 * The vault's slice of account erasure (an `IErasureParticipant`, see the
 * auth module): a managed sign-in's tokens are told to their provider before
 * the user row goes and the vault rows cascade away with it. Switching an
 * account off reaches the same call through `onAccountDeactivated`; erasing
 * an account that was never switched off would otherwise drop its rows with
 * the grant still live at the provider, which is the one leak the revoker
 * exists to close.
 *
 * `before`, outside the transaction: revocation is best effort and idempotent
 * (a revoked token is deleted here either way, and a second run finds no
 * managed row), and the delete it precedes is the erasure's own. A row the
 * vault could not settle (its tokens kept changing under the revoke) makes
 * the vault throw, and the erasure is refused with it: nothing has been
 * erased, the admin retries, and no row cascades away unrevoked.
 */
export function managedSignInErasure(vault: Pick<ISecretsVaultService, 'removeManagedRowsOfUser'>): {
  before(target: { userId: string }): Promise<void>;
} {
  return {
    async before(target) {
      await vault.removeManagedRowsOfUser(target.userId);
    },
  };
}
