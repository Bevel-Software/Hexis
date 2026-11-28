import { OidcAuthProvider, oidcSettingsFrom } from '../modules/auth/oidc-auth-provider.js';

type ProviderOptions = ConstructorParameters<typeof OidcAuthProvider>[0];

/**
 * The single sign-on provider, constructed the way the composition root
 * constructs it (`core/create-core-services.ts`): registered once, reading
 * its configuration from deployment settings on every use. A suite outside
 * auth that walks a real sign-in takes it from HERE rather than constructing
 * auth's implementation itself, as `real-auth.ts` does for the auth service.
 */
export function realOidcProvider(
  settings: { resolve(key: string): string },
  options: Omit<ProviderOptions, 'settings'>,
): OidcAuthProvider {
  return new OidcAuthProvider({ settings: () => oidcSettingsFrom(settings), ...options });
}
