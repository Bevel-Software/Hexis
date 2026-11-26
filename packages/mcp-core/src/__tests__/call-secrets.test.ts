import { describe, expect, it } from 'vitest';
import { DefaultVariableSubstitutor } from '@utcp/sdk';

/*
 * What the capture records is tested through `registerManual` and
 * `dispatchToolCall`, in `downstream-tool-errors.test.ts`. This file only
 * watches the library seam it depends on.
 */
describe('substitution capture', () => {
  it('finds the lookup it wraps in the installed @utcp/sdk (fails when a release renames it)', () => {
    const substitutor = new DefaultVariableSubstitutor() as unknown as { _getVariable?: unknown };
    expect(typeof substitutor._getVariable).toBe('function');
  });
});
