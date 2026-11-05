import { describe, test, expect } from 'vitest';
import { UtcpClientConfigSerializer } from '@utcp/sdk';
import {
  BevelSecretsVariableLoader,
  DEFAULT_SECRETS_SCOPE,
  bevelSecretsLoaderConfig,
  registerBevelSecretsVariableLoader,
  unregisterBevelSecretsVariableLoader,
} from '../secrets-variable-loader.js';
import type { ISecretsVaultService } from '../secrets-vault.contract.js';

describe('BevelSecretsVariableLoader', () => {
  // Binds the user id the loader is EXPECTED to forward; the fake fails the test
  // if `resolve` is ever called with a different (or missing) user, so the loader
  // can't silently switch to a global / other-user secret lookup.
  const fakeVault = (expectedUserId: string, secrets: Record<string, string>): ISecretsVaultService =>
    ({
      resolve: async (userId: string, key: string) => {
        expect(userId).toBe(expectedUserId);
        return secrets[key] ?? null;
      },
    }) as unknown as ISecretsVaultService;

  test('resolves the UTCP-namespaced key against the vault verbatim, as the active user', async () => {
    // The vault is keyed by the full `<manual>_<VAR>` namespace, so a secret is
    // bound to ONE manual — and it is looked up for the loader's own user.
    registerBevelSecretsVariableLoader(fakeVault('user-1', { weather_WEATHER_KEY: 'sk-123' }));
    const loader = new BevelSecretsVariableLoader('user-1');
    expect(await loader.get('weather_WEATHER_KEY')).toBe('sk-123');
  });

  test("does not resolve another manual's namespace (isolation)", async () => {
    // `weather` configured its secret; an `evil` manual referencing the same
    // bare `${WEATHER_KEY}` looks up `evil_WEATHER_KEY` and misses — it cannot
    // harvest a secret bound to a different manual.
    registerBevelSecretsVariableLoader(fakeVault('user-1', { weather_WEATHER_KEY: 'sk-123' }));
    const loader = new BevelSecretsVariableLoader('user-1');
    expect(await loader.get('evil_WEATHER_KEY')).toBeNull();
  });

  test('resolves for the correct user (distinct users do not share the lookup)', async () => {
    registerBevelSecretsVariableLoader(fakeVault('user-2', { weather_WEATHER_KEY: 'sk-2' }));
    const loader = new BevelSecretsVariableLoader('user-2');
    expect(await loader.get('weather_WEATHER_KEY')).toBe('sk-2');
  });

  test('returns null for an unknown secret', async () => {
    registerBevelSecretsVariableLoader(fakeVault('user-1', {}));
    const loader = new BevelSecretsVariableLoader('user-1');
    expect(await loader.get('weather_MISSING')).toBeNull();
  });

  test('returns null when the loader has no bound user (never calls resolve)', async () => {
    registerBevelSecretsVariableLoader(fakeVault('unreachable', { m_X: 'y' }));
    const loader = new BevelSecretsVariableLoader('');
    expect(await loader.get('m_X')).toBeNull();
  });

  test('two knowledge bases in one process resolve the same user and key from their own vaults', async () => {
    // One process, two vaults, one user id in each (ids are only unique
    // within a knowledge base): a loader reads the vault registered under
    // ITS scope, and a scope nobody registered resolves nothing.
    registerBevelSecretsVariableLoader(fakeVault('user-1', { weather_WEATHER_KEY: 'sk-acme' }), 'acme');
    registerBevelSecretsVariableLoader(fakeVault('user-1', { weather_WEATHER_KEY: 'sk-globex' }), 'globex');
    expect(await new BevelSecretsVariableLoader('user-1', 'acme').get('weather_WEATHER_KEY')).toBe('sk-acme');
    expect(await new BevelSecretsVariableLoader('user-1', 'globex').get('weather_WEATHER_KEY')).toBe('sk-globex');
    expect(await new BevelSecretsVariableLoader('user-1', 'nobody').get('weather_WEATHER_KEY')).toBeNull();
  });

  test('the descriptor round-trips the scope through the serializer registry', async () => {
    registerBevelSecretsVariableLoader(fakeVault('user-1', { weather_WEATHER_KEY: 'sk-acme' }), 'acme');
    const config = new UtcpClientConfigSerializer().validateDict({
      variables: {},
      load_variables_from: [bevelSecretsLoaderConfig('user-1', 'acme')],
    });
    const [loader] = config.load_variables_from as BevelSecretsVariableLoader[];
    expect(loader.scope).toBe('acme');
    expect(await loader.get('weather_WEATHER_KEY')).toBe('sk-acme');
    // Without a scope the descriptor names the single knowledge base's.
    const [plain] = new UtcpClientConfigSerializer().validateDict({
      variables: {},
      load_variables_from: [bevelSecretsLoaderConfig('user-1')],
    }).load_variables_from as BevelSecretsVariableLoader[];
    expect(plain.scope).toBe(DEFAULT_SECRETS_SCOPE);
  });

  test('unregistering a scope makes its loaders resolve nothing', async () => {
    registerBevelSecretsVariableLoader(fakeVault('user-1', { weather_WEATHER_KEY: 'sk-acme' }), 'evicted');
    const loader = new BevelSecretsVariableLoader('user-1', 'evicted');
    expect(await loader.get('weather_WEATHER_KEY')).toBe('sk-acme');
    unregisterBevelSecretsVariableLoader('evicted');
    expect(await loader.get('weather_WEATHER_KEY')).toBeNull();
  });
});
