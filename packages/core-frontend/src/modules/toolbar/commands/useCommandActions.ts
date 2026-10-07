import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useActiveAppId, useAppRegistry } from '../../../core/registry';
import { useAdmin } from '../../admin/state/admin.context';
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
      isAdmin,
      activeAppId,
      openFilePath,
      editablePage,
      openWorkspacePath,
      invite,
      createPage: knowledgeRoot ? createPage : null,
      onboardingPending: showPill,
    }),
    [navigate, isAdmin, activeAppId, openFilePath, editablePage, openWorkspacePath, invite, knowledgeRoot, createPage, showPill],
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
  const actions = useMemo(() => visibleActions(all, ctx), [all, ctx]);
  return { actions, ctx };
}
