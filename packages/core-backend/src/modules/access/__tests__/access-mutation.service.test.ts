import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { AccessMutationService, AccessMutationError } from '../access-mutation.service.js';
import type { Principal } from '../../access-model/access-splice.js';

const KB = 'knowledge-base';
const WS = 'ws-mut-1';

const ROLES_YAML = `roles:
  Admin:
    - razvan@bevel.software
  Product Team:
    - felix@example.com
`;

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-mut-'));
}

/** Stub WorkspaceService backed by a real temp repo: path/read/write only. */
function stubWorkspace(workspaceDir: string): WorkspaceService {
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
    readFileBinary: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel)),
    writeFile: async (_id: string, wsRel: string, content: string) => {
      const abs = resolve(wsRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    },
  } as unknown as WorkspaceService;
}

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

describe('AccessMutationService', () => {
  let root: string;
  let repo: string;
  let access: AccessControlService;
  let mutation: AccessMutationService;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(repo, { recursive: true });
    await write(repo, 'roles.yaml', ROLES_YAML);
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n# Root\n');
    const ws = stubWorkspace(workspaceDir);
    access = new AccessControlService(ws, KB, new NodeFs());
    mutation = new AccessMutationService(ws, access, KB);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const felix: Principal = { kind: 'user', email: 'newbie@example.com', displayName: 'Newbie' };

  it('grant on a folder makes the grantee canWrite there (end-to-end)', async () => {
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Admin\n---\n# Sales folder\n');
    expect(await access.canWrite(WS, 'newbie@example.com', 'Sales/Deal.md')).toBe(false);

    await mutation.grant(WS, 'folder', 'Sales', 'write', felix);
    access.invalidate(WS);

    expect(await access.canWrite(WS, 'newbie@example.com', 'Sales/Deal.md')).toBe(true);
    // The Sales folder body survived.
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).toContain('# Sales folder');
  });

  it('kbPrincipals (REAL service): roles lists ROLE principals only, groups separately', async () => {
    // Through the real resolver — the route-level tests stub this method,
    // which is exactly how the every-group-listed-as-a-role bug hid.
    await write(repo, 'groups.yaml', 'groups:\n  GTM Team:\n    - pat@x.io\n  Admin:\n    - shadow@x.io\n');
    access.invalidate(WS);
    const { roles, groups } = await access.kbPrincipals(WS);
    expect(roles).toContain('Everyone');
    expect(roles).toContain('Admin');
    expect(roles).toContain('Product Team');
    // NO group ever appears under roles — not even one shadowing a role name;
    // and each role appears exactly once (the alias key must not double it).
    expect(roles).not.toContain('GTM Team');
    expect(roles.filter((r) => r === 'Admin')).toHaveLength(1);
    expect(roles.filter((r) => r === 'Product Team')).toHaveLength(1);
    expect(groups.sort()).toEqual(['Admin', 'GTM Team']);
  });

  it('grant everyone read makes the folder publicly readable (read: everyone)', async () => {
    await write(repo, 'Open/access.md', '---\nwrite:\n  - Admin\n---\n# Open folder\n');
    const stranger = 'stranger@nowhere.test';
    expect(await access.canRead(WS, stranger, 'Open/Doc.md')).toBe(false);

    await mutation.grant(WS, 'folder', 'Open', 'read', { kind: 'role', role: 'everyone' });
    access.invalidate(WS);

    expect(await access.canRead(WS, stranger, 'Open/Doc.md')).toBe(true);
    const text = await fs.readFile(path.join(repo, 'Open/access.md'), 'utf-8');
    expect(text).toContain('read:');
    expect(text).toContain('everyone');
    expect(text).toContain('# Open folder'); // body preserved
  });

  it('creates a folder access.md when absent', async () => {
    await fs.mkdir(path.join(repo, 'New'), { recursive: true });
    const r = await mutation.grant(WS, 'folder', 'New', 'owner', felix);
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(repo, 'New/access.md'), 'utf-8');
    expect(text).toContain('owner:');
    expect(text).toContain('Newbie <newbie@example.com>');
  });

  it("a skill folder's first grant creates its access.md beside the plugin's, and both rules resolve", async () => {
    // The skill page's Share opens the dialog on the SKILL folder — the same
    // folder-grant path as anywhere else. The plugin's own rule is untouched,
    // and the resolver reads the two at their depths as it does any nesting.
    await write(repo, 'Plugins/newsroom/access.md', '---\nread:\n  - Product Team\n---\n# Newsroom\n');
    await write(repo, 'Plugins/newsroom/skills/newsletter/SKILL.md', '# Newsletter\n');
    const skillAccess = path.join(repo, 'Plugins/newsroom/skills/newsletter/access.md');
    await expect(fs.readFile(skillAccess, 'utf-8')).rejects.toThrow();

    // The folder rules (the access.md BODY, after the frontmatter) as a
    // verb → entries map, so each grant is checked under its own verb rather
    // than anywhere in the file.
    const skillRules = async (): Promise<Record<string, string[]>> => {
      const text = await fs.readFile(skillAccess, 'utf-8');
      const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text);
      expect(m).not.toBeNull();
      return parseYaml(m![1]) as Record<string, string[]>;
    };

    const r = await mutation.grant(WS, 'folder', 'Plugins/newsroom/skills/newsletter', 'write', felix);
    access.invalidate(WS);

    expect(r).toEqual({ changed: true, editPath: 'Plugins/newsroom/skills/newsletter/access.md' });
    expect((await skillRules()).write).toEqual(['Newbie <newbie@example.com>']);
    expect(await fs.readFile(path.join(repo, 'Plugins/newsroom/access.md'), 'utf-8')).not.toContain(
      'newbie@example.com',
    );
    // The skill-level grant holds on the skill, not on the rest of the plugin…
    const skillMd = 'Plugins/newsroom/skills/newsletter/SKILL.md';
    expect(await access.canWrite(WS, 'newbie@example.com', skillMd)).toBe(true);
    expect(await access.canWrite(WS, 'newbie@example.com', 'Plugins/newsroom/README.md')).toBe(false);
    // …and the plugin-level rule still reaches into the skill folder.
    expect(await access.canRead(WS, 'felix@example.com', skillMd)).toBe(true);

    // A second grant edits the file it created rather than starting another.
    const second = await mutation.grant(WS, 'folder', 'Plugins/newsroom/skills/newsletter', 'download', felix);
    expect(second).toEqual({ changed: true, editPath: 'Plugins/newsroom/skills/newsletter/access.md' });
    const rules = await skillRules();
    expect(rules.write).toEqual(['Newbie <newbie@example.com>']);
    expect(rules.download).toEqual(['Newbie <newbie@example.com>']);
  });

  it('grant on a FILE edits the node frontmatter, NOT the folder (no sibling leak)', async () => {
    await write(
      repo,
      'Sales/Deal.md',
      '---\nnodeType: "[Process](../NodeTypes/Process.md)"\n---\n# Deal body\n',
    );
    await write(repo, 'Sales/Other.md', '---\nnodeType: "x"\n---\n# Other\n');

    await mutation.grant(WS, 'file', 'Sales/Deal.md', 'write', felix);
    access.invalidate(WS);

    // Deal.md grants the newbie...
    expect(await access.canWrite(WS, 'newbie@example.com', 'Sales/Deal.md')).toBe(true);
    // ...but the sibling does NOT (no folder access.md was written).
    expect(await access.canWrite(WS, 'newbie@example.com', 'Sales/Other.md')).toBe(false);
    // No Sales/access.md was created.
    await expect(fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8')).rejects.toThrow();
    // The node body + nodeType survived.
    const text = await fs.readFile(path.join(repo, 'Sales/Deal.md'), 'utf-8');
    expect(text).toContain('# Deal body');
    expect(text).toContain('nodeType:');
  });

  it('grants a second verb without removing the first (verbs are independent)', async () => {
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Admin\n---\n');
    await mutation.grant(WS, 'folder', 'Sales', 'write', felix);
    await mutation.grant(WS, 'folder', 'Sales', 'download', felix);

    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    // Newbie appears under BOTH write and download — no collapse.
    const writeBlock = text.slice(text.indexOf('write:'), text.indexOf('download:'));
    expect(writeBlock).toContain('newbie@example.com');
    const downloadBlock = text.slice(text.indexOf('download:'));
    expect(downloadBlock).toContain('newbie@example.com');
  });

  it('revoke with a single verb strips only that verb (keeps the others)', async () => {
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Admin\n---\n');
    await mutation.grant(WS, 'folder', 'Sales', 'write', felix);
    await mutation.grant(WS, 'folder', 'Sales', 'download', felix);

    // Drop only download; write must survive.
    const r = await mutation.revoke(WS, 'folder', 'Sales', felix, 'razvan@bevel.software', 'download');
    expect(r.changed).toBe(true);

    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    const writeBlock = text.slice(text.indexOf('write:'), text.indexOf('download:') >= 0 ? text.indexOf('download:') : undefined);
    expect(writeBlock).toContain('newbie@example.com');
    const downloadBlock = text.indexOf('download:') >= 0 ? text.slice(text.indexOf('download:')) : '';
    expect(downloadBlock).not.toContain('newbie@example.com');
  });

  it('revoke with no verb strips the principal from every verb (back-compat)', async () => {
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Admin\n---\n');
    await mutation.grant(WS, 'folder', 'Sales', 'write', felix);
    await mutation.grant(WS, 'folder', 'Sales', 'download', felix);

    const r = await mutation.revoke(WS, 'folder', 'Sales', felix, 'razvan@bevel.software');
    expect(r.changed).toBe(true);

    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).not.toContain('newbie@example.com');
  });

  it('revoke of the last owner is allowed (no last-owner guard)', async () => {
    // `owner` is not a privilege tier — it names who validates a folder. Removing
    // the sole owner creates no lockout, so the revoke goes through unconditionally
    // (whole-principal or single-verb).
    await write(
      repo,
      'Owned/access.md',
      '---\nowner:\n  - Felix <felix@example.com>\ndownload:\n  - Felix <felix@example.com>\n---\n',
    );
    access.invalidate(WS);
    const onlyOwner: Principal = { kind: 'user', email: 'felix@example.com', displayName: 'Felix' };

    // Single-verb revoke of `owner` removes only the owner entry.
    const r = await mutation.revoke(WS, 'folder', 'Owned', onlyOwner, 'razvan@bevel.software', 'owner');
    expect(r.changed).toBe(true);

    const text = await fs.readFile(path.join(repo, 'Owned/access.md'), 'utf-8');
    expect(text.slice(text.indexOf('owner:'), text.indexOf('download:'))).not.toContain('felix@example.com');
    // The download entry is untouched (only the owner verb was revoked).
    expect(text.slice(text.indexOf('download:'))).toContain('felix@example.com');
  });

  it('lets a user revoke their OWN write (no self-lockout guard)', async () => {
    // A non-admin (newbie) holds inline write. They revoke themselves and it goes
    // through, removing their effective write — no self-lockout refusal.
    await write(
      repo,
      'Team/access.md',
      '---\nowner:\n  - Felix <felix@example.com>\nwrite:\n  - Newbie <newbie@example.com>\n---\n',
    );
    access.invalidate(WS);
    expect(await access.canWrite(WS, 'newbie@example.com', 'Team/Doc.md')).toBe(true);

    const self: Principal = { kind: 'user', email: 'newbie@example.com', displayName: 'Newbie' };
    const r = await mutation.revoke(WS, 'folder', 'Team', self, 'newbie@example.com');
    expect(r.changed).toBe(true);

    access.invalidate(WS);
    expect(await access.canWrite(WS, 'newbie@example.com', 'Team/Doc.md')).toBe(false);
  });

  it('rejects an injection-shaped principal', async () => {
    const evil: Principal = {
      kind: 'user',
      email: 'x@y.com\nwrite:\n  - everyone',
      displayName: 'X',
    };
    await expect(mutation.grant(WS, 'folder', 'Sales', 'write', evil)).rejects.toBeInstanceOf(
      AccessMutationError,
    );
  });

  describe('denyHere — the per-item override', () => {
    const alice: Principal = { kind: 'user', email: 'alice@example.com', displayName: 'Alice' };

    it('excludes the target subtree without touching the granting ancestor', async () => {
      // Alice is granted write on the Sales FOLDER; she inherits write on a file under it.
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      // The file target must exist — a file deny edits the node's own frontmatter.
      await write(repo, 'Sales/Deal.md', '---\nnodeType: process\n---\n# Deal\n');
      await write(repo, 'Sales/Other.md', '---\nnodeType: process\n---\n# Other\n');
      access.invalidate(WS);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(true);

      // Deny her at the file (the per-item override).
      const r = await mutation.denyHere(WS, 'file', 'Sales/Deal.md', alice);
      expect(r.changed).toBe(true);
      access.invalidate(WS);

      // She loses access on the file...
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(false);
      // ...but keeps it on the folder and its other items (ancestor untouched).
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Other.md')).toBe(true);
    });

    it('strips a same-scope grant first so the deny is not silently discarded', async () => {
      // Alice has a DIRECT grant on the folder AND we deny her there. Without the
      // strip-then-deny, the resolver's grant-beats-deny would keep her granted.
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      access.invalidate(WS);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales')).toBe(true);

      const r = await mutation.denyHere(WS, 'folder', 'Sales', alice);
      expect(r.changed).toBe(true);
      access.invalidate(WS);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales')).toBe(false);
    });

    it('VERB-SCOPED deny restricts only that verb and leaves the others (e.g. keeps direct download)', async () => {
      // Alice is direct on `download` on the file AND inherits `write` from Sales.
      // Restrict ONLY her write on this file → she loses write here but KEEPS the
      // direct download (the per-checkbox "restrict just this verb on this item").
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      await write(
        repo,
        'Sales/Deal.md',
        '---\nnodeType: process\ndownload:\n  - Alice <alice@example.com>\n---\n# Deal\n',
      );
      access.invalidate(WS);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(true);
      expect(await access.canDownload(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(true);

      const r = await mutation.denyHere(WS, 'file', 'Sales/Deal.md', alice, 'write');
      expect(r.changed).toBe(true);
      access.invalidate(WS);

      // write is gone on this file; download SURVIVES.
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(false);
      expect(await access.canDownload(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(true);
      // The file frontmatter still grants download (only write got a deny).
      const text = await fs.readFile(path.join(repo, 'Sales/Deal.md'), 'utf-8');
      expect(text).toContain('download:');
      expect(text.slice(text.indexOf('download:'))).toContain('alice@example.com');
    });

    it('rolls back + errors when the deny would have no effect (admin-rescue write)', async () => {
      // Admin write on an access.md comes from the hardcoded rescue, which a
      // `deny` entry cannot shadow. denyHere must detect the deny had no effect,
      // roll the file back, and refuse — never report a no-op success.
      // (A subfolder's access.md: at the root the Admin write floor refuses the
      // deny up front instead — see access-control.admin-root-floor.test.ts.)
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Admin\n---\n# Sales folder\n');
      const admin: Principal = { kind: 'user', email: 'razvan@bevel.software', displayName: 'Razvan' };
      await expect(mutation.denyHere(WS, 'file', 'Sales/access.md', admin)).rejects.toMatchObject({
        status: 409,
      });
      // The access.md is unchanged (rolled back) — admin still writes it.
      access.invalidate(WS);
      expect(await access.canWrite(WS, 'razvan@bevel.software', 'Sales/access.md')).toBe(true);
    });

    it('GROUP deny with a VANISHED group succeeds even when a same-named ROLE keeps its grants', async () => {
      // The false-negative this pins: a role named Product Team exists, so the
      // service matches the GROUP's revoke/deny 'exact' — it strips and denies
      // only `group/Product Team`. The post-write effectiveness assert must
      // judge the SAME exact identity: with the group vanished, an
      // alias-tolerant check would read the role's surviving bare and role/
      // grants as the group still having access, roll back a fully effective
      // deny, and answer 409 deny-ineffective.
      await write(
        repo,
        'Sales/access.md',
        // The group/ grant is the (now vanished) GROUP's; the bare and role/
        // grants are the same-named ROLE's. No groups.yaml — the group is gone.
        '---\nwrite:\n  - group/Product Team\n  - Product Team\n  - role/Product Team\n---\n# Sales folder\n',
      );
      access.invalidate(WS);

      const r = await mutation.denyHere(WS, 'folder', 'Sales', { kind: 'role', role: 'group/Product Team' });
      expect(r.changed).toBe(true);
      access.invalidate(WS);

      const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
      // The group's grant became a deny...
      expect(text).toContain('deny group/Product Team');
      // ...and the ROLE's own grants were never touched.
      expect(text).toMatch(/^ {2}- Product Team$/m);
      expect(text).toContain('role/Product Team');
      expect(text).not.toContain('deny Product Team');
      expect(text).not.toContain('deny role/Product Team');
      // The role still resolves its grant.
      const roleSources = await access.grantSources(WS, 'folder', 'Sales', {
        kind: 'role',
        role: 'role/Product Team',
      });
      expect(roleSources.write).toEqual([{ kind: 'direct' }]);
      // The group's exact token holds nothing anymore.
      const groupSources = await access.grantSources(
        WS,
        'folder',
        'Sales',
        { kind: 'role', role: 'group/Product Team' },
        { tokenMatch: 'exact' },
      );
      expect(groupSources).toEqual({});
    });

    it('is a no-op (changed:false) when the principal is already fully denied here', async () => {
      await write(
        repo,
        'Sales/access.md',
        '---\nwrite:\n  - deny Alice <alice@example.com>\n  - deny Alice <alice@example.com>\n---\n',
      );
      // First denyHere normalises; a second is a no-op.
      await mutation.denyHere(WS, 'folder', 'Sales', alice);
      access.invalidate(WS);
      const again = await mutation.denyHere(WS, 'folder', 'Sales', alice);
      expect(again.changed).toBe(false);
    });
  });

  // The route classifies a revoke by combining `revoke().changed` with
  // `grantSources`. These assert the exact signals the route wires:
  //   changed=true            → direct revoke, 200.
  //   changed=false + ancestor → inherited, 409 { sources }.
  //   changed=false + empty    → no access, 200 no-op.
  describe('revoke classification signals (what the route keys on)', () => {
    const alice: Principal = { kind: 'user', email: 'alice@example.com', displayName: 'Alice' };

    it('direct grant → revoke changes the target (200 path)', async () => {
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      access.invalidate(WS);
      const r = await mutation.revoke(WS, 'folder', 'Sales', alice, 'admin@x');
      expect(r.changed).toBe(true);
    });

    it('inherited grant → target revoke no-ops but grantSources shows the ancestor (409 path)', async () => {
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      await write(repo, 'Sales/Deal.md', '---\nnodeType: process\n---\n# Deal\n');
      access.invalidate(WS);
      // Revoking Alice on the FILE finds nothing to splice there.
      const r = await mutation.revoke(WS, 'file', 'Sales/Deal.md', alice, 'admin@x');
      expect(r.changed).toBe(false);
      // But she still resolves via the Sales ancestor — the route returns 409.
      const sources = await access.grantSources(WS, 'file', 'Sales/Deal.md', {
        kind: 'user',
        email: 'alice@example.com',
      });
      expect(sources.write).toEqual([{ kind: 'ancestor', path: 'Sales/access.md' }]);
    });

    it('direct download on the file + inherited write from the parent → verbless revoke CHANGES the file (200 path, not 409)', async () => {
      // Alice has a DIRECT download grant on the file's own frontmatter AND
      // inherits write from the Sales folder. A whole-principal (verbless) revoke
      // strips her direct download from the file → changed:true → the route takes
      // the 200 path (and the fresh view shows her remaining inherited write,
      // which the dialog turns into "Remove from parent?").
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      await write(
        repo,
        'Sales/Deal.md',
        '---\nnodeType: process\ndownload:\n  - Alice <alice@example.com>\n---\n# Deal\n',
      );
      access.invalidate(WS);
      // She's direct on download, inherited on write.
      const before = await access.grantSources(WS, 'file', 'Sales/Deal.md', {
        kind: 'user',
        email: 'alice@example.com',
      });
      expect(before.download).toEqual([{ kind: 'direct' }]);
      expect(before.write).toEqual([{ kind: 'ancestor', path: 'Sales/access.md' }]);

      const r = await mutation.revoke(WS, 'file', 'Sales/Deal.md', alice, 'admin@x');
      expect(r.changed).toBe(true); // the direct download entry was removed → 200, NOT 409

      // After: download is gone, write is still inherited from the parent.
      access.invalidate(WS);
      const after = await access.grantSources(WS, 'file', 'Sales/Deal.md', {
        kind: 'user',
        email: 'alice@example.com',
      });
      expect(after.download).toBeUndefined();
      expect(after.write).toEqual([{ kind: 'ancestor', path: 'Sales/access.md' }]);
    });

    it('no access anywhere → revoke no-ops and grantSources is empty (200 no-op path)', async () => {
      await write(repo, 'Sales/Deal.md', '---\nnodeType: process\n---\n# Deal\n');
      access.invalidate(WS);
      const r = await mutation.revoke(WS, 'file', 'Sales/Deal.md', alice, 'admin@x');
      expect(r.changed).toBe(false);
      const sources = await access.grantSources(WS, 'file', 'Sales/Deal.md', {
        kind: 'user',
        email: 'alice@example.com',
      });
      expect(sources).toEqual({});
    });

    it('remove-from-parent on the ancestor folder removes inherited access on the target + siblings', async () => {
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      await write(repo, 'Sales/Deal.md', '---\nnodeType: process\n---\n# Deal\n');
      access.invalidate(WS);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(true);

      // What the route's remove-from-parent does: revoke on the ancestor folder.
      await mutation.revoke(WS, 'folder', 'Sales', alice, 'admin@x');
      access.invalidate(WS);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(false);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Other.md')).toBe(false);
    });

    it('remove-from-parent leaves a DIRECT grant on a subfolder intact (only the named ancestor is edited)', async () => {
      // Alice is granted on the Sales parent AND directly on the Sales/Q1 subfolder.
      await write(repo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      await write(repo, 'Sales/Q1/access.md', '---\nwrite:\n  - Alice <alice@example.com>\n---\n');
      await write(repo, 'Sales/Deal.md', '---\nnodeType: process\n---\n# Deal\n');
      await write(repo, 'Sales/Q1/Bid.md', '---\nnodeType: process\n---\n# Bid\n');
      access.invalidate(WS);
      // Baseline: she can write everywhere under Sales.
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(true);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Q1/Bid.md')).toBe(true);

      // Remove her from the Sales PARENT only.
      await mutation.revoke(WS, 'folder', 'Sales', alice, 'admin@x');
      access.invalidate(WS);

      // Parent + its directly-held files lose her...
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales')).toBe(false);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Deal.md')).toBe(false);
      // ...but her DIRECT grant on the Q1 subfolder (a different access.md, never
      // touched) survives — she keeps Q1 and everything under it.
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Q1')).toBe(true);
      expect(await access.canWrite(WS, 'alice@example.com', 'Sales/Q1/Bid.md')).toBe(true);
      // The subfolder access.md was not edited (her entry is still on disk there).
      const q1 = await fs.readFile(path.join(repo, 'Sales/Q1/access.md'), 'utf-8');
      expect(q1).toContain('alice@example.com');
      // The parent access.md no longer names her.
      const parent = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
      expect(parent).not.toContain('alice@example.com');
    });
  });
});


// The grant/revoke x collided/uncollided cases, end-to-end through the REAL
// resolver (kbPrincipals decides who owns the bare name) — the token-kind family.
describe('token-kind family — role-first revoke, exact-token grant (real resolver)', () => {
  let root: string;
  let repo: string;
  let access: AccessControlService;
  let mutation: AccessMutationService;

  const roleP: Principal = { kind: 'role', role: 'role/Product Team' }; // the ROLE, explicit
  const bareP: Principal = { kind: 'role', role: 'Product Team' }; // the bare name (always the role here)
  const groupP: Principal = { kind: 'role', role: 'group/Product Team' }; // the GROUP, explicit

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(repo, { recursive: true });
    await write(repo, 'roles.yaml', ROLES_YAML);
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    const ws = stubWorkspace(workspaceDir);
    access = new AccessControlService(ws, KB, new NodeFs());
    mutation = new AccessMutationService(ws, access, KB);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Collision on = a GROUP named "Product Team" exists beside the role. */
  async function collide(on: boolean): Promise<void> {
    if (on) {
      await write(repo, 'groups.yaml', 'groups:\n  Product Team:\n    - pat@x.io\n  Design:\n    - dee@x.io\n');
    }
    access.invalidate(WS);
  }

  it('GRANT collided: the group grant lands even though the role is already granted', async () => {
    await collide(true);
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Product Team\n  - role/Product Team\n---\n');
    const r = await mutation.grant(WS, 'folder', 'Sales', 'write', groupP);
    expect(r.changed).toBe(true); // exact-token idempotency: group/ is a different principal
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text.split('\n')).toContain('  - group/Product Team');
    // The group member now resolves write through group/.
    access.invalidate(WS);
    expect(await access.canWrite(WS, 'pat@x.io', 'Sales/Deal.md')).toBe(true);
  });

  it('GRANT uncollided: same-spelling grants stay idempotent', async () => {
    await collide(false);
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - role/Product Team\n---\n');
    const r = await mutation.grant(WS, 'folder', 'Sales', 'write', roleP);
    expect(r.changed).toBe(false);
  });

  it("REVOKE on a model-load failure: a ROLE revoke stays exact and keeps the bare token", async () => {
    await collide(true);
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Product Team\n  - role/Product Team\n---\n');
    // A failed load answers empty principal lists: nothing says who owns the bare name.
    vi.spyOn(access, 'kbPrincipals').mockResolvedValue({ roles: [], groups: [], plugins: [] } as never);
    const r = await mutation.revoke(WS, 'folder', 'Sales', roleP, 'admin@x');
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).not.toContain('role/Product Team');
    expect(text.split('\n')).toContain('  - Product Team');
  });

  it("REVOKE collided: revoking the ROLE strips its bare and role/ spellings, never the group's", async () => {
    await collide(true);
    await write(
      repo,
      'Sales/access.md',
      '---\nwrite:\n  - Product Team\n  - role/Product Team\n  - group/Product Team\n---\n',
    );
    const r = await mutation.revoke(WS, 'folder', 'Sales', roleP, 'admin@x');
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).not.toContain('role/Product Team');
    expect(text.split('\n')).not.toContain('  - Product Team');
    expect(text.split('\n')).toContain('  - group/Product Team'); // the GROUP's token survives
    access.invalidate(WS);
    expect(await access.canWrite(WS, 'pat@x.io', 'Sales/Deal.md')).toBe(true);
    expect(await access.canWrite(WS, 'felix@example.com', 'Sales/Deal.md')).toBe(false);
  });

  it("REVOKE collided: revoking the GROUP strips group/ only — the bare name is the role's", async () => {
    await collide(true);
    await write(
      repo,
      'Sales/access.md',
      '---\nwrite:\n  - Product Team\n  - role/Product Team\n  - group/Product Team\n---\n',
    );
    const r = await mutation.revoke(WS, 'folder', 'Sales', groupP, 'admin@x');
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).not.toContain('group/Product Team');
    expect(text.split('\n')).toContain('  - Product Team');
    expect(text).toContain('- role/Product Team');
    access.invalidate(WS);
    expect(await access.canWrite(WS, 'felix@example.com', 'Sales/Deal.md')).toBe(true);
    expect(await access.canWrite(WS, 'pat@x.io', 'Sales/Deal.md')).toBe(false);
  });

  it('REVOKE: a group no role shares a name with strips group/ AND its legacy bare spelling', async () => {
    await collide(true);
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Design\n  - group/Design\n---\n');
    const r = await mutation.revoke(WS, 'folder', 'Sales', { kind: 'role', role: 'group/Design' }, 'admin@x');
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).not.toContain('Design');
    access.invalidate(WS);
    expect(await access.canWrite(WS, 'dee@x.io', 'Sales/Deal.md')).toBe(false);
  });

  it('REVOKE uncollided: revoking the role strips BOTH spellings (legacy bare cleanup)', async () => {
    await collide(false);
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Product Team\n  - role/Product Team\n---\n');
    const r = await mutation.revoke(WS, 'folder', 'Sales', roleP, 'admin@x');
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).not.toContain('Product Team');
    access.invalidate(WS);
    expect(await access.canWrite(WS, 'felix@example.com', 'Sales/Deal.md')).toBe(false);
  });

  it('REVOKE uncollided: a bare revoke also strips both spellings', async () => {
    await collide(false);
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Product Team\n  - role/Product Team\n---\n');
    const r = await mutation.revoke(WS, 'folder', 'Sales', bareP, 'admin@x');
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8');
    expect(text).not.toContain('Product Team'); // both spellings are the role
  });
});
