/**
 * The route patterns the shell answers itself, besides the settings pages
 * (which come from their menu rows) and the apps (which come from the
 * registry). One definition for two readers: the shell mounts its routes at
 * these (`CoreAppShell.tsx`), and a registry row's settings page is refused
 * at any address one of them answers (`registrySettingsPages`). So a route of
 * the shell cannot be mounted at one pattern and protected at another.
 *
 * The shell's catch-all is not here: it answers what nothing else does, and
 * owns no address in particular.
 *
 * No imports, on purpose: the shell imports the settings module, and the
 * settings module reads these, so this file sits below both.
 */
export const SHELL_PATHS = {
  /** The address the server hands out for "Connect your tools": a redirect into Skills & Tools. */
  connect: '/connect',
  /** The old Connection keys address: a redirect to the Audit log. */
  connectionKeys: '/connection-keys',
  /** The landing route. */
  root: '/',
  /** Where a single sign-on round-trip returns. */
  authReturn: '/auth/*',
  /** The address every change-request link carries. */
  changeRequest: '/change-requests/:number',
  /** The embed a chat host frames, outside the app. */
  embed: '/embed',
  /** The account-link page the embed sends an unlinked viewer to. */
  embedLink: '/embed/link',
} as const;
