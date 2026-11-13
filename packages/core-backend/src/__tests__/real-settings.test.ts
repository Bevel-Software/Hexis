import { describe, expect, it } from 'vitest';
import { realDeploymentSettings } from './real-settings.js';

/**
 * The fixture's table answers each statement the settings service sends, so a
 * suite that takes settings from it sees what a deployment would. Each case
 * drives one statement through the service's own methods.
 */
describe('realDeploymentSettings', () => {
  const OIDC = { issuerUrl: 'https://idp.example.com', clientId: 'client-1', clientSecret: 'secret-1' };

  it("reads one key's row, not another's", async () => {
    const settings = realDeploymentSettings();
    await settings.save({ oidcProviderLabel: 'Company SSO', oidcScopes: 'openid email' }, null);
    expect(await settings.reload('oidcProviderLabel')).toBe('Company SSO');
    expect(await settings.reload('oidcScopes')).toBe('openid email');
  });

  it('reads every row back, sealed values included', async () => {
    const settings = realDeploymentSettings();
    await settings.save({ oidcProviderLabel: 'Company SSO', oidcClientSecret: 'secret-1' }, null);
    await settings.clear('oidcScopes');
    // `load` replaces the cache with what the table holds.
    await settings.load();
    expect(settings.resolve('oidcProviderLabel')).toBe('Company SSO');
    expect(settings.resolve('oidcClientSecret')).toBe('secret-1');
  });

  it('a cleared setting is gone from the table, not only from the cache', async () => {
    const settings = realDeploymentSettings();
    await settings.save({ oidcProviderLabel: 'Company SSO', oidcScopes: 'openid email' }, null);
    await settings.clear('oidcProviderLabel');
    // `reload` asks the table again.
    expect(await settings.reload('oidcProviderLabel')).toBe('');
    expect(await settings.reload('oidcScopes')).toBe('openid email');
  });

  it('claims a value once: the second claim yields to the row already there', async () => {
    const settings = realDeploymentSettings();
    expect(await settings.recordIfAbsent('oidcProviderLabel', 'first', null)).toBe(true);
    expect(await settings.recordIfAbsent('oidcProviderLabel', 'second', null)).toBe(false);
    expect(await settings.reload('oidcProviderLabel')).toBe('first');
  });

  it('swaps a value only while it still reads what was expected', async () => {
    const settings = realDeploymentSettings();
    await settings.save({ oidcProviderLabel: 'first' }, null);
    expect(await settings.swapIfValue('oidcProviderLabel', 'not this', 'second', null)).toBe(false);
    expect(await settings.reload('oidcProviderLabel')).toBe('first');
    expect(await settings.swapIfValue('oidcProviderLabel', 'first', 'second', null)).toBe(true);
    expect(await settings.reload('oidcProviderLabel')).toBe('second');
  });

  it('releases a value only while it still reads what was expected', async () => {
    const settings = realDeploymentSettings();
    await settings.save({ oidcProviderLabel: 'first' }, null);
    expect(await settings.swapIfValue('oidcProviderLabel', 'not this', null, null)).toBe(false);
    expect(await settings.reload('oidcProviderLabel')).toBe('first');
    expect(await settings.swapIfValue('oidcProviderLabel', 'first', null, null)).toBe(true);
    expect(await settings.reload('oidcProviderLabel')).toBe('');
  });

  it('records a sign-in as verified, and a later "unverified" does not undo it', async () => {
    const settings = realDeploymentSettings();
    expect(await settings.oidcVerificationOf(OIDC)).toBe('unverified');
    await settings.recordOidcVerification('verified', OIDC);
    expect(await settings.oidcVerificationOf(OIDC)).toBe('verified');
    await settings.recordOidcVerification('unverified', OIDC);
    expect(await settings.oidcVerificationOf(OIDC)).toBe('verified');
    // Another set of values has its own record.
    expect(await settings.oidcVerificationOf({ ...OIDC, clientId: 'client-2' })).toBe('unverified');
  });
});
