import { describe, it, expect } from 'vitest';
import {
  isRolesYamlPath,
  assertRolesYamlParsable,
  makeRolesYamlWriteValidator,
  makeAgentAccessYamlWriteValidator,
  NEW_ROLE_GUIDANCE,
  RolesYamlInvalidError,
  RolesYamlNewRoleError,
  RolesYamlUnknownGroupError,
  assertKnownGroups,
  GroupsYamlDuplicateGroupError,
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

  describe('makeAgentAccessYamlWriteValidator', () => {
    const CURRENT = `roles:
  Admin:
    - a@x.eu
  Sales:
    - s@x.eu
    - t@x.eu
`;

    /** Run the agent validator against `current` (null = no file), as a promise either way. */
    const run = (content: string | Uint8Array, current: string | null = CURRENT, path = `${KB}/roles.yaml`) =>
      Promise.resolve().then(() => makeAgentAccessYamlWriteValidator(KB, async () => current)(path, content));

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

    describe('group entries', () => {
      const GROUPS = new Map([['platform team', { displayName: 'Platform Team', emails: new Set(['p@x.eu']) }]]);
      const active = { groups: GROUPS, sourceFile: 'groups.yaml' };
      const runWithGroups = (content: string, groups: typeof active | null = active, current: string | null = CURRENT) =>
        Promise.resolve().then(() =>
          makeAgentAccessYamlWriteValidator(KB, async () => current, async () => groups)(`${KB}/roles.yaml`, content),
        );

      it('passes an entry naming a known group, in any case or spacing', async () => {
        await expect(runWithGroups(`${CURRENT}    - group:Platform Team\n`)).resolves.toBeUndefined();
        await expect(runWithGroups(`${CURRENT}    - group:platform   TEAM\n`)).resolves.toBeUndefined();
      });

      it('refuses an unknown group with a 422 naming the entry and its role; nothing else is named', async () => {
        const err = await runWithGroups(`${CURRENT}    - group:Platfrom Team\n    - group:Platform Team\n`).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RolesYamlUnknownGroupError);
        const refusal = err as RolesYamlUnknownGroupError;
        expect(refusal.status).toBe(422);
        expect(refusal.payload).toEqual({
          kind: 'roles-yaml-unknown-group',
          entries: [{ role: 'Sales', entry: 'group:Platfrom Team' }],
          sourceFile: 'groups.yaml',
        });
        expect(refusal.message).toContain("'- group:Platfrom Team' under role 'Sales'");
        expect(refusal.message).toContain('groups.yaml does not declare');
      });

      it('leaves an entry already in the file alone, so a retired group cannot block a membership edit', async () => {
        const current = `${CURRENT}    - group:Retired\n`;
        await expect(runWithGroups(`${current}    - u@x.eu\n`, active, current)).resolves.toBeUndefined();
        // The same group added under ANOTHER role is a new entry, and is checked.
        await expect(
          runWithGroups('roles:\n  Admin:\n    - a@x.eu\n    - group:Retired\n  Sales:\n    - group:Retired\n', active, current),
        ).rejects.toMatchObject({ entries: [{ role: 'Admin', entry: 'group:Retired' }] });
      });

      it('checks nothing when the group source cannot be read', async () => {
        await expect(runWithGroups(`${CURRENT}    - group:Anything\n`, null)).resolves.toBeUndefined();
      });

      it('assertKnownGroups is the same check, callable on its own', () => {
        expect(() => assertKnownGroups(CURRENT, `${CURRENT}    - group:Nope\n`, active)).toThrow(RolesYamlUnknownGroupError);
      });
    });

    it('leaves every other path alone', async () => {
      await expect(run(`${CURRENT}  Phoenix:\n    - p@x.eu\n`, CURRENT, `${KB}/KnowledgeBase/roles.yaml`)).resolves.toBeUndefined();
    });
  });
  describe('makeAgentAccessYamlWriteValidator on groups.yaml', () => {
    const GROUPS = 'groups:\n  Product:\n    - f@x.eu\n    - g@x.eu\n  GTM Team:\n    - s@x.eu\n';
    const ROLES = 'roles:\n  Admin:\n    - a@x.eu\n';
    const DUP = '  PRODUCT:\n    - qa.dup@x.eu\n';
    const ABOVE = GROUPS.replace('groups:\n', `groups:\n${DUP}`);

    /** Run the agent validator on `path` against root files `files` (absent = null), recording which it read. */
    const runOn = (content: string | Uint8Array, current: string | null = GROUPS, path = `${KB}/groups.yaml`) => {
      const read: string[] = [];
      const files: Record<string, string | null> = { 'groups.yaml': current, 'roles.yaml': ROLES };
      const result = Promise.resolve().then(() =>
        makeAgentAccessYamlWriteValidator(KB, async (file) => {
          read.push(file);
          return files[file] ?? null;
        })(path, content),
      );
      return { result, read };
    };

    it('refuses PRODUCT added above Product with a 422 naming both, judged against groups.yaml', async () => {
      const { result, read } = runOn(ABOVE);
      const err = await result.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GroupsYamlDuplicateGroupError);
      const refusal = err as GroupsYamlDuplicateGroupError;
      expect(refusal.status).toBe(422);
      expect(refusal.payload).toEqual({
        kind: 'groups-yaml-duplicate-group',
        duplicates: [{ group: 'PRODUCT', existing: 'Product' }],
      });
      expect(refusal.message).toContain("'PRODUCT' (a group named 'Product' already exists)");
      expect(read).toEqual(['groups.yaml']);
    });

    it('refuses the reverse order, a whitespace respelling, and bytes, all the same way', async () => {
      const refused = { name: 'GroupsYamlDuplicateGroupError', duplicates: [{ group: 'PRODUCT', existing: 'Product' }] };
      await expect(runOn(`${GROUPS}${DUP}`).result).rejects.toMatchObject(refused);
      await expect(runOn(new TextEncoder().encode(ABOVE)).result).rejects.toMatchObject(refused);
      await expect(runOn(`${GROUPS}  gtm   TEAM:\n    - t@x.eu\n`).result).rejects.toMatchObject({
        duplicates: [{ group: 'gtm   TEAM', existing: 'GTM Team' }],
      });
    });

    it('refuses two spellings of one new group in the same write, and in a file that does not exist yet', async () => {
      const both = `${GROUPS}  Phoenix:\n    - p@x.eu\n  phoenix:\n    - q@x.eu\n`;
      await expect(runOn(both).result).rejects.toMatchObject({ duplicates: [{ group: 'phoenix', existing: 'Phoenix' }] });
      await expect(runOn(ABOVE, null).result).rejects.toMatchObject({ duplicates: [{ group: 'Product', existing: 'PRODUCT' }] });
    });

    it('refuses a candidate the resolver cannot parse — an exact repeat included — before reading the current file', async () => {
      const exact = runOn(`${GROUPS}  Product:\n    - z@x.eu\n`);
      await expect(exact.result).rejects.toMatchObject({
        status: 422,
        payload: { kind: 'groups-yaml-invalid', groupsYamlErrors: [expect.stringContaining("duplicate key 'Product'")] },
      });
      expect(exact.read).toEqual([]);
      await expect(runOn('groups:\n  - Product\n').result).rejects.toMatchObject({
        status: 422,
        payload: { kind: 'groups-yaml-invalid' },
      });
      // Even when the current file is already broken the same way: the write must mend it, not keep it.
      const broken = `${GROUPS}  Product: []\n`;
      await expect(runOn(`${broken}  Phoenix: []\n`, broken).result).rejects.toMatchObject({
        payload: { kind: 'groups-yaml-invalid' },
      });
      await expect(runOn('', broken).result).resolves.toBeUndefined();
    });

    it('passes membership edits, a new distinct group and a respelling that replaces the old block', async () => {
      await expect(runOn(GROUPS.replace('    - g@x.eu\n', '    - g@x.eu\n    - h@x.eu\n')).result).resolves.toBeUndefined();
      await expect(runOn(`${GROUPS}  Phoenix:\n    - p@x.eu\n`).result).resolves.toBeUndefined();
      await expect(runOn(GROUPS.replace('  Product:', '  PRODUCT:')).result).resolves.toBeUndefined();
    });

    it('leaves a case-duplicate the file already holds alone, so it cannot block an unrelated edit', async () => {
      await expect(runOn(`${ABOVE}  Phoenix: []\n`, ABOVE).result).resolves.toBeUndefined();
      // A third spelling of that name is new, and is refused.
      await expect(runOn(`${ABOVE}  product:\n    - z@x.eu\n`, ABOVE).result).rejects.toBeInstanceOf(
        GroupsYamlDuplicateGroupError,
      );
    });

    it('claims the root groups.yaml only, and still judges roles.yaml against roles.yaml', async () => {
      const validate = makeAgentAccessYamlWriteValidator(KB, async () => null);
      expect(validate.appliesTo?.(`${KB}/groups.yaml`)).toBe(true);
      expect(validate.appliesTo?.(`${KB}/roles.yaml`)).toBe(true);
      expect(validate.appliesTo?.(`${KB}/KnowledgeBase/groups.yaml`)).toBe(false);
      expect(validate.appliesTo?.(`${KB}/synced-groups.yaml`)).toBe(false);
      await expect(runOn(ABOVE, GROUPS, `${KB}/KnowledgeBase/groups.yaml`).result).resolves.toBeUndefined();
      const roles = runOn(`${ROLES}    - b@x.eu\n`, GROUPS, `${KB}/roles.yaml`);
      await expect(roles.result).resolves.toBeUndefined();
      expect(roles.read).toEqual(['roles.yaml']);
    });
  });
});
