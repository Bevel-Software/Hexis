import { describe, test, expect } from 'vitest';
import { utcpNamespacedKey, utcpNamespacePrefix } from '../utcp-namespace.js';

describe('utcp-namespace', () => {
  test('alphanumeric name → plain `<name>_<VAR>` (existing tools unaffected)', () => {
    expect(utcpNamespacedKey('weather', 'API_KEY')).toBe('weather_API_KEY');
    expect(utcpNamespacePrefix('weather')).toBe('weather_');
  });
  test('snake_case name → underscores doubled (UTCP convention)', () => {
    expect(utcpNamespacedKey('my_tool', 'KEY')).toBe('my__tool_KEY');
    expect(utcpNamespacePrefix('my_tool')).toBe('my__tool_');
    expect(utcpNamespacedKey('a_b_c', 'X')).toBe('a__b__c_X');
  });
  test('non-word chars sanitized to `_` BEFORE doubling (mirrors `@utcp/sdk`\'s `name.replace(/[^\\w]/g,"_")`)', () => {
    expect(utcpNamespacedKey('my-tool', 'KEY')).toBe('my__tool_KEY'); // same key as `my_tool`
    expect(utcpNamespacePrefix('my-tool')).toBe('my__tool_');
    expect(utcpNamespacedKey('acme.api', 'TOKEN')).toBe('acme__api_TOKEN');
  });
});
