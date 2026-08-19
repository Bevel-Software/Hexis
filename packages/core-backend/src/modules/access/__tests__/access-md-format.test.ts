import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import {
  accessMdDeclaresBodyRules,
  accessMdSelfEntries,
  parseAccessFile,
} from '../../access-model/access-grammar.js';
import { spliceGrant, spliceRevoke } from '../../access-model/access-splice.js';

/**
 * The two-format `access.md` story:
 *
 *  - LEGACY: the frontmatter carries the FOLDER's rules; the file cannot
 *    govern itself (its readability follows the folder chain).
 *  - NEW: the body carries the folder's rules; the frontmatter — like every
 *    other file's — is about the FILE itself. `read: everyone` there makes
 *    the plugin discoverable (anyone may open the access.md and see who runs
 *    the folder) while the folder's contents stay locked.
 *
 * Compat rule under test: a file whose body is NOT parsable as rules resolves
 * its frontmatter for the folder, exactly as before.
 */

const KB = 'knowledge-base';

const ROLES_YAML = `roles:
  Admin:
    - razvan@bevel.software
  GTM Team:
    - felix@example.com
`;

/** New-format plugin access.md: discoverable by everyone, readable by GTM Team. */
const NEW_FORMAT = `---
read:
  - everyone
---
read:
  - GTM Team
write:
  - GTM Team
`;

const LEGACY_FORMAT = `---
read:
  - GTM Team
write:
  - GTM Team
---
Some prose explaining this folder.
`;

describe('access.md format detection + parsing', () => {
  it('detects body rules (new format) and parses the BODY for the folder', () => {
    expect(accessMdDeclaresBodyRules(NEW_FORMAT)).toBe(true);
    const parsed = parseAccessFile(NEW_FORMAT, 'Plugins/GTM/access.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.entries.read).toEqual([
      { kind: 'role', role: 'gtm team', displayRole: 'GTM Team', deny: false },
    ]);
    // The frontmatter's `everyone` grant is NOT a folder rule.
    expect(parsed.file.entries.read.some((e) => e.kind === 'role' && e.role === 'everyone')).toBe(
      false,
    );
  });

  it('a prose body stays legacy: the frontmatter governs the folder', () => {
    expect(accessMdDeclaresBodyRules(LEGACY_FORMAT)).toBe(false);
    const parsed = parseAccessFile(LEGACY_FORMAT, 'access.md');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.entries.read).toEqual([
      { kind: 'role', role: 'gtm team', displayRole: 'GTM Team', deny: false },
    ]);
  });

  it('an empty body stays legacy', () => {
    expect(accessMdDeclaresBodyRules('---\nread:\n  - GTM Team\n---\n')).toBe(false);
  });

  it('a body that names a verb but is malformed is a hard ERROR, never a silent fallback', () => {
    // Falling back to the frontmatter here would hand the folder to the
    // (possibly `read: everyone`) self-rules — a typo must fail loudly.
    const typo = '---\nread:\n  - everyone\n---\nread: GTM Team\n';
    expect(accessMdDeclaresBodyRules(typo)).toBe(true);
    const parsed = parseAccessFile(typo, 'Plugins/GTM/access.md');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(' ')).toContain("'read:' must be a list");
  });

  it('self entries: frontmatter in the new format, null for legacy', () => {
    const self = accessMdSelfEntries(NEW_FORMAT);
    expect(self?.read).toEqual([
      { kind: 'role', role: 'everyone', displayRole: 'everyone', deny: false },
    ]);
    expect(accessMdSelfEntries(LEGACY_FORMAT)).toBeNull();
  });
});

describe('access.md splice targeting', () => {
  const FELIX = { kind: 'user' as const, email: 'ali@x.eu', displayName: 'Ali Baba' };

  it("target 'folder' on a new-format file lands the grant in the BODY", () => {
    const r = spliceGrant(NEW_FORMAT, 'read', FELIX, { target: 'folder' });
    expect(r.changed).toBe(true);
    const parsed = parseAccessFile(r.text, 'Plugins/GTM/access.md');
    expect(parsed.ok && parsed.file.entries.read.some((e) => e.kind === 'user' && e.email === 'ali@x.eu')).toBe(true);
    // The self-frontmatter is untouched.
    expect(accessMdSelfEntries(r.text)?.read).toEqual([
      { kind: 'role', role: 'everyone', displayRole: 'everyone', deny: false },
    ]);
  });

  it("target 'folder' on a legacy file lands the grant in the frontmatter (as before)", () => {
    const r = spliceGrant(LEGACY_FORMAT, 'read', FELIX, { target: 'folder' });
    expect(r.changed).toBe(true);
    const parsed = parseAccessFile(r.text, 'access.md');
    expect(parsed.ok && parsed.file.entries.read.some((e) => e.kind === 'user' && e.email === 'ali@x.eu')).toBe(true);
    // Still legacy — the prose body did not become rules.
    expect(accessMdDeclaresBodyRules(r.text)).toBe(false);
  });

  it("default target ('node') on a new-format file edits the SELF frontmatter", () => {
    const r = spliceGrant(NEW_FORMAT, 'read', FELIX);
    expect(r.changed).toBe(true);
    expect(accessMdSelfEntries(r.text)?.read.some((e) => e.kind === 'user' && e.email === 'ali@x.eu')).toBe(true);
    // Folder rules untouched.
    const parsed = parseAccessFile(r.text, 'Plugins/GTM/access.md');
    expect(parsed.ok && parsed.file.entries.read.some((e) => e.kind === 'user')).toBe(false);
  });

  it("revoke with target 'folder' removes from the body and round-trips", () => {
    const granted = spliceGrant(NEW_FORMAT, 'read', FELIX, { target: 'folder' }).text;
    const revoked = spliceRevoke(granted, 'read', FELIX, { target: 'folder' });
    expect(revoked.changed).toBe(true);
    const parsed = parseAccessFile(revoked.text, 'Plugins/GTM/access.md');
    expect(parsed.ok && parsed.file.entries.read.some((e) => e.kind === 'user')).toBe(false);
  });
});

describe('end-to-end resolution over a new-format plugin', () => {
  let root: string;
  const workspaceId = 'ws-plugins-fmt';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-accessfmt-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(): Promise<AccessControlService> {
    const workspaceDir = path.join(root, workspaceId);
    const repo = path.join(workspaceDir, KB);
    await fs.mkdir(path.join(repo, 'Plugins', 'GTM'), { recursive: true });
    await fs.writeFile(path.join(repo, 'roles.yaml'), ROLES_YAML);
    await fs.writeFile(path.join(repo, 'access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(repo, 'Plugins', 'GTM', 'access.md'), NEW_FORMAT);
    await fs.mkdir(path.join(repo, 'Plugins', 'GTM', 'outreach'), { recursive: true });
    await fs.writeFile(path.join(repo, 'Plugins', 'GTM', 'outreach', 'SKILL.md'), '# outreach\n');
    const stub = {
      getWorkspacePath: async (id: string) => {
        if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
        return workspaceDir;
      },
    } as unknown as WorkspaceService;
    return new AccessControlService(stub, KB);
  }

  it('a NON-member can read the access.md itself (discovery) but nothing inside the folder', async () => {
    const svc = await seed();
    const outsider = 'sara@example.com';
    expect(await svc.canRead(workspaceId, outsider, 'Plugins/GTM/access.md')).toBe(true);
    expect(await svc.canRead(workspaceId, outsider, 'Plugins/GTM/outreach/SKILL.md')).toBe(false);
  });

  it('a member reads both; body rules (not frontmatter) decide the folder', async () => {
    const svc = await seed();
    const member = 'felix@example.com';
    expect(await svc.canRead(workspaceId, member, 'Plugins/GTM/access.md')).toBe(true);
    expect(await svc.canRead(workspaceId, member, 'Plugins/GTM/outreach/SKILL.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, member, 'Plugins/GTM/outreach/SKILL.md')).toBe(true);
  });
});
