/**
 * Git's public surface for the shell: what git contributes to the app outside
 * its own components. Other modules compose these through the shell rather
 * than reaching into git's files.
 */
import type { AdminMenuItem } from '../../core/registry';
import { BRANCH_DELETE_CONFIRM_MENU_ITEM } from './branch-delete-menu-item';

/**
 * Git's profile-menu rows, merged into the registry by the shell
 * (`withCoreModuleContributions`) ahead of registry-contributed rows. Today
 * only "Ask before deleting branches", shown while this person's
 * branch-delete question is off.
 */
export const GIT_MENU_ITEMS: readonly AdminMenuItem[] = [BRANCH_DELETE_CONFIRM_MENU_ITEM];

/**
 * What a change request needs from git to call the API and explain a failed
 * git operation: the shared response handler, its error type, the friendly
 * wording of a git failure, and the banner a failed sync shows.
 */
export { GitApiError, handleApiResponse } from './services/git.api';
export { friendlyGitError, friendlyGitMessage } from './services/error-messages';
export { GitSyncFailedBanner } from './components/GitSyncFailedBanner';

/** The branch state a page reads (`useGit`), and the context a test provides it through. */
export { GitContext, useGit, type GitContextValue } from './state/git.context';
