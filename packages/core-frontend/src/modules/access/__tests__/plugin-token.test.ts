import { describe, it, expect } from 'vitest';
import { parsePluginPrincipalToken, pluginPrincipalToken } from '../api';

/**
 * The client's reading of a plugin token matches the grammar's: one name,
 * one verb. A nested name is not a plugin, and must not be shown as one and
 * then re-submitted as a different canonical principal.
 */
describe('parsePluginPrincipalToken', () => {
  it('round-trips a token the client itself spells', () => {
    expect(parsePluginPrincipalToken(pluginPrincipalToken('GTM', 'read'))).toEqual({ plugin: 'GTM', verb: 'read' });
    expect(parsePluginPrincipalToken('Plugin/Sales Team/WRITE')).toEqual({ plugin: 'Sales Team', verb: 'write' });
  });

  it('rejects a nested name, a missing name, and an unknown verb', () => {
    expect(parsePluginPrincipalToken('plugin/foo/bar/read')).toBeNull();
    expect(parsePluginPrincipalToken('plugin//read')).toBeNull();
    expect(parsePluginPrincipalToken('plugin/GTM/delete')).toBeNull();
    expect(parsePluginPrincipalToken('role/GTM')).toBeNull();
  });
});
