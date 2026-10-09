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
