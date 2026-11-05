import { GitBranch } from 'lucide-react';
import type { AdminMenuItem } from '../../core/registry';
import {
  askBeforeBranchDelete,
  isBranchDeleteConfirmSkipped,
} from './state/branch-delete-confirm';

/**
 * The way back from the branch delete's "Don't ask again": a profile-menu row
 * that is there exactly while this person's question is off in this browser.
 * Git owns the preference, so git owns the row; the menu only renders it.
 */
export const BRANCH_DELETE_CONFIRM_MENU_ITEM: AdminMenuItem = {
  id: 'ask-before-branch-delete',
  // After Account (90): it undoes a choice rather than going somewhere.
  order: 95,
  icon: <GitBranch size={15} />,
  label: 'Ask before deleting branches',
  isShown: (user) => isBranchDeleteConfirmSkipped(user.email),
  onSelect: ({ user, closeMenu }) => {
    askBeforeBranchDelete(user.email);
    closeMenu();
  },
};
