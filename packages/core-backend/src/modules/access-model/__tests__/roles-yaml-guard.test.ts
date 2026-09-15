import { describe, it, expect } from 'vitest';
import {
  isRolesYamlPath,
  assertRolesYamlParsable,
  makeRolesYamlWriteValidator,
  makeAgentRolesYamlWriteValidator,
  NEW_ROLE_GUIDANCE,
  RolesYamlInvalidError,
  RolesYamlNewRoleError,
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

    it('lets a role be created — the editor and the App roles service are not held to the agent rule', () => {
      expect(() => validate(`${KB}/roles.yaml`, `${VALID}  Project Phoenix:\n    - p@x.eu\n`)).not.toThrow();
    });

    it('claims only the roles.yaml path', () => {
      expect(validate.appliesTo?.(`${KB}/roles.yaml`)).toBe(true);
      expect(validate.appliesTo?.(`${KB}/access.md`)).toBe(false);
    });
  });

  describe('makeAgentRolesYamlWriteValidator', () => {
    const CURRENT = `roles:
  Admin:
    - a@x.eu
  Sales:
    - s@x.eu
    - t@x.eu
`;

    /** Run the agent validator against `current` (null = no file), as a promise either way. */
    const run = (content: string | Uint8Array, current: string | null = CURRENT, path = `${KB}/roles.yaml`) =>
      Promise.resolve().then(() => makeAgentRolesYamlWriteValidator(KB, async () => current)(path, content));

    it('refuses a role absent from the current file, naming it and redirecting to a group', async () => {
      const err = await run(`${CURRENT}  Project Phoenix:\n    - p@x.eu\n`).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RolesYamlNewRoleError);
      const refusal = err as RolesYamlNewRoleError;
      expect(refusal.status).toBe(422);
      expect(refusal.payload).toEqual({ kind: 'roles-yaml-new-role', roleNames: ['Project Phoenix'] });
      expect(refusal.message).toContain("'Project Phoenix' is not an existing role");
      expect(refusal.message).toContain(NEW_ROLE_GUIDANCE);
      expect(NEW_ROLE_GUIDANCE).toMatch(/add people to existing roles, and use a GROUP for a task- or team-scoped set of people/);
    });

    it('names every created role', async () => {
      await expect(run(`${CURRENT}  Phoenix:\n    - p@x.eu\n  Onboarding:\n    - o@x.eu\n`)).rejects.toMatchObject({
        roleNames: ['Phoenix', 'Onboarding'],
        message: expect.stringContaining("'Phoenix', 'Onboarding' are not existing roles"),
      });
    });

    it('passes a write that only changes membership: add, remove, reorder, respell', async () => {
      await expect(run(`${CURRENT}    - u@x.eu\n`)).resolves.toBeUndefined();
      await expect(run('roles:\n  Admin:\n    - a@x.eu\n  Sales:\n    - t@x.eu\n')).resolves.toBeUndefined();
      await expect(run('roles:\n  Sales:\n    - t@x.eu\n    - s@x.eu\n  Admin:\n    - a@x.eu\n')).resolves.toBeUndefined();
      // Role names are case- and whitespace-insensitive: a respelling is the same role.
      await expect(run('roles:\n  ADMIN:\n    - a@x.eu\n  sales:\n    - s@x.eu\n')).resolves.toBeUndefined();
    });

    it('refuses a rename for the created name — a delete plus a create, no special case', async () => {
      await expect(run('roles:\n  Admin:\n    - a@x.eu\n  Marketing:\n    - s@x.eu\n')).rejects.toMatchObject({
        name: 'RolesYamlNewRoleError',
        roleNames: ['Marketing'],
      });
    });

    it('still refuses an unparseable candidate first, with the invalid-file error', async () => {
      await expect(run('roles: [oops')).rejects.toBeInstanceOf(RolesYamlInvalidError);
    });

    it('fails closed when the current file vouches for no roles (absent, or not a roles mapping)', async () => {
      await expect(run(VALID, null)).rejects.toMatchObject({ roleNames: ['Admin'] });
      await expect(run(VALID, 'roles: oops\n')).rejects.toMatchObject({ roleNames: ['Admin'] });
    });

    it('checks bytes as text, so a binary write cannot carry a role past it', async () => {
      await expect(run(new TextEncoder().encode(`${CURRENT}  Phoenix:\n    - p@x.eu\n`))).rejects.toBeInstanceOf(
        RolesYamlNewRoleError,
      );
    });

    it('leaves every other path alone', async () => {
      await expect(run(`${CURRENT}  Phoenix:\n    - p@x.eu\n`, CURRENT, `${KB}/KnowledgeBase/roles.yaml`)).resolves.toBeUndefined();
    });
  });
});
