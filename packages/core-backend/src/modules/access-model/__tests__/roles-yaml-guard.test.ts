import { describe, it, expect } from 'vitest';
import {
  isRolesYamlPath,
  assertRolesYamlParsable,
  makeRolesYamlWriteValidator,
  RolesYamlInvalidError,
} from '../roles-yaml-guard.js';

const KB = 'knowledge-base';

const VALID = `roles:
  Admin:
    - a@x.eu
`;

describe('roles-yaml-guard', () => {
  describe('isRolesYamlPath', () => {
    it('matches the KB roles.yaml (workspace-relative, incl. backslashes / leading ./)', () => {
      expect(isRolesYamlPath(`${KB}/roles.yaml`, KB)).toBe(true);
      expect(isRolesYamlPath(`${KB}\\roles.yaml`, KB)).toBe(true);
      expect(isRolesYamlPath(`./${KB}/roles.yaml`, KB)).toBe(true);
      // A bare repo-relative roles.yaml is accepted defensively.
      expect(isRolesYamlPath('roles.yaml', KB)).toBe(true);
    });

    it('does not match other files or a roles.yaml in a different dir', () => {
      expect(isRolesYamlPath(`${KB}/access.md`, KB)).toBe(false);
      expect(isRolesYamlPath(`${KB}/old-roles.yaml`, KB)).toBe(false);
      expect(isRolesYamlPath(`${KB}/Knowledge/roles.yaml`, KB)).toBe(false);
      expect(isRolesYamlPath('other-kb/roles.yaml', KB)).toBe(false);
    });
  });

  describe('assertRolesYamlParsable', () => {
    it('accepts a valid roles.yaml', () => {
      expect(() => assertRolesYamlParsable(VALID)).not.toThrow();
    });

    it('throws a 422 RolesYamlInvalidError on a duplicate key (the reported bug)', () => {
      const dup = `roles:
  Admin:
    - a@x.eu
  Admin:
    - b@x.eu
`;
      try {
        assertRolesYamlParsable(dup);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RolesYamlInvalidError);
        expect((err as RolesYamlInvalidError).status).toBe(422);
        expect((err as RolesYamlInvalidError).errors.join(' ')).toMatch(/duplicate/i);
      }
    });
  });

  describe('makeRolesYamlWriteValidator', () => {
    const validate = makeRolesYamlWriteValidator(KB);

    it('rejects an invalid roles.yaml write', () => {
      expect(() => validate(`${KB}/roles.yaml`, 'roles: [oops')).toThrow(RolesYamlInvalidError);
    });

    it('ignores non-roles.yaml paths and non-string content', () => {
      expect(() => validate(`${KB}/access.md`, 'anything')).not.toThrow();
      // Binary write to the roles path is nonsensical → left alone, not parsed.
      expect(() => validate(`${KB}/roles.yaml`, new Uint8Array([1, 2, 3]))).not.toThrow();
    });
  });
});
