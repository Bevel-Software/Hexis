import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useActiveAppId, useAppRegistry } from '../../../core/registry';
import { useAdmin } from '../../admin/state/admin.context';
import { useAuth } from '../../auth/state/auth.context';
import { useMenuSections } from '../../settings/settings-nav-items';
import { useInviteDialog } from '../../onboarding/state/invite-dialog.context';
import { useOnboarding } from '../../onboarding/state/onboarding';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useEditablePage } from '../../workspace/state/editable-page';
import { useFileNav } from '../../workspace/routing/kb-routes';
import { useCreatePage } from '../../workspace/hooks/useCreatePage';
import {
  coreCommandActions,
  mergeCommandActions,
  visibleActions,
  type CommandAction,
  type CommandContext,
} from './actions';

/** The one {@link CommandContext}, read off the app's own hooks. */
export function useCommandContext(): CommandContext {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isAdmin } = useAdmin();
  const activeAppId = useActiveAppId();
  const { openFilePath } = useWorkspace();
  const editablePage = useEditablePage();
  const { openWorkspacePath } = useFileNav();
  const invite = useInviteDialog();
  const { knowledgeRoot, createPage } = useCreatePage();
  const { showPill } = useOnboarding();
  return useMemo(
    () => ({
      navigate: (to: string) => navigate(to),
      user,
      isAdmin,
      activeAppId,
      openFilePath,
      editablePage,
      openWorkspacePath,
      invite,
      createPage: knowledgeRoot ? createPage : null,
      onboardingPending: showPill,
    }),
    [navigate, user, isAdmin, activeAppId, openFilePath, editablePage, openWorkspacePath, invite, knowledgeRoot, createPage, showPill],
  );
}

/**
 * The commands to offer right now — core's, then the registry's — and the
 * context to run them with.
 */
export function useCommandActions(): { actions: CommandAction[]; ctx: CommandContext } {
  const registry = useAppRegistry();
  const settings = useMenuSections();
  const ctx = useCommandContext();
  const all = useMemo(
    () => mergeCommandActions(coreCommandActions({ apps: registry.apps, settings }), registry.commandActions ?? []),
    [registry, settings],
  );
  // Asked on every render rather than memoized on `ctx`: a settings row's
  // `isShown` can follow state the menu does not own (a preference in
  // storage), and the profile menu asks it each time its panel renders.
  // Opening the palette is a render, so a row a command just switched off is
  // gone by the next open.
  const actions = visibleActions(all, ctx);
  return { actions, ctx };
}
