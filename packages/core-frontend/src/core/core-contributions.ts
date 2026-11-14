import { GIT_MENU_ITEMS } from '../modules/git';
import type { AppRegistry } from './registry';

/**
 * Core modules' own contributions to the registry, merged AHEAD of
 * registry-contributed ones so a downstream build adds to the app rather than
 * reordering what core already put there. Each module offers them through its
 * public surface (git's {@link GIT_MENU_ITEMS}); the settings list never
 * imports another module's rows. The core apps are merged by `CoreAppShell`
 * itself, since they are its own surfaces.
 */
export function withCoreModuleContributions(registry: AppRegistry): AppRegistry {
  return {
    ...registry,
    adminMenuItems: [...GIT_MENU_ITEMS, ...registry.adminMenuItems],
  };
}
