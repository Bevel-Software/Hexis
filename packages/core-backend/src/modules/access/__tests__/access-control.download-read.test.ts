import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { sourceVerbsFor } from '../../access-model/access-grammar.js';

/**
 * `download` folds into `read`, the way `write` does.
 *
 * A download-only grant used to be a DEAD combination: the raw-file route
 * read-gates before it download-gates, so its holder could neither open the
 * file nor save it — and the share dialog let anyone create that pairing.
 * These tests pin the fold across every shape a grant can take (direct user,
 * role, group, plugin token, inherited from an ancestor, a node's own
 * frontmatter) and pin the half that did NOT change: the implication is
 * grant-only, so a `deny download` says nothing about read, and `download`
 * still confers no `write`.
 */

const KB_DIR = 'knowledge-base';

function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
    ensureRemotesFetched: async () => undefined,
  } as unknown as WorkspaceService;
}

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
  Product Manager:
    - pm@x.io
`;

const GROUPS_YAML = `groups:
  Sales Team:
    - sam@x.io
`;

describe('download implies read', () => {
  let root: string;
  const workspaceId = 'ws-download-read';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-download-read-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeService(files: Record<string, string>) {
    const workspaceDir = path.join(root, workspaceId);
    const repo = path.join(workspaceDir, KB_DIR);
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    return new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), KB_DIR, new NodeFs());
  }

  const BASE = {
    'roles.yaml': ROLES_YAML,
    'groups.yaml': GROUPS_YAML,
  };

  describe('the grammar table', () => {
    it('folds download into read, alongside write and owner', () => {
      expect(sourceVerbsFor('read')).toEqual(['read', 'write', 'download', 'owner']);
    });

    it('leaves the other verbs where they were — download is not conferred by write or read', () => {
      expect(sourceVerbsFor('download')).toEqual(['download', 'owner']);
      expect(sourceVerbsFor('write')).toEqual(['write', 'owner']);
      expect(sourceVerbsFor('owner')).toEqual(['owner']);
    });
  });

  describe('a download-only grant confers read', () => {
    it('for a DIRECT user grant', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
      });
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(true);
      // Nobody else: the fold adds no grant that was not written.
      expect(await svc.canRead(workspaceId, 'mallory@x.io', 'Knowledge/Deal.md')).toBe(false);
    });

    it('for a ROLE grant', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Product Manager\n',
      });
      expect(await svc.canRead(workspaceId, 'pm@x.io', 'Knowledge/Deal.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'admin@x.io', 'Knowledge/Deal.md')).toBe(false);
    });

    it('for a GROUP grant', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Sales Team\n',
      });
      expect(await svc.canRead(workspaceId, 'sam@x.io', 'Knowledge/Deal.md')).toBe(true);
    });

    it('for a PLUGIN-token grant', async () => {
      const svc = await makeService({
        ...BASE,
        'Plugins/GTM/plugin.json': '{"name":"gtm"}',
        'Plugins/GTM/access.md': '---\nread:\n  - everyone\n---\nread:\n  - Sales Team\n',
        'Knowledge/access.md': '---\n---\ndownload:\n  - plugin/GTM/read\n',
      });
      expect(await svc.canRead(workspaceId, 'sam@x.io', 'Knowledge/Deal.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'pm@x.io', 'Knowledge/Deal.md')).toBe(false);
    });

    it('for an INHERITED grant, several folders up', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
        'Knowledge/Sales/access.md': '---\n---\nwrite:\n  - Admin\n',
      });
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Sales/Deal.md')).toBe(true);
    });

    it("for a node's OWN frontmatter, on that node alone", async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\nwrite:\n  - Admin\n',
        'Knowledge/Deal.md': '---\ndownload:\n  - Ana <ana@x.io>\n---\n# Deal\n',
        'Knowledge/Other.md': '# Other\n',
      });
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Other.md')).toBe(false);
    });

    it('through the BATCHED read, the file tree resolves every node with', async () => {
      const svc = await makeService({
        ...BASE,
        'Knowledge/access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
      });
      const verdicts = await svc.canReadBatch(workspaceId, 'ana@x.io', [
        'Knowledge/Deal.md',
        'Elsewhere/Other.md',
      ]);
      expect(verdicts.get('Knowledge/Deal.md')).toBe(true);
      expect(verdicts.get('Elsewhere/Other.md')).toBe(false);
    });

    it('for a GROUP lens and the EVERYONE lens', async () => {
      const svc = await makeService({
        ...BASE,
        'Knowledge/access.md': '---\n---\ndownload:\n  - Sales Team\n',
        'Public/access.md': '---\n---\ndownload:\n  - everyone\n',
      });
      const asGroup = await svc.canReadAsGroupBatch(workspaceId, 'Sales Team', ['Knowledge/Deal.md']);
      expect(asGroup?.get('Knowledge/Deal.md')).toBe(true);
      const asEveryone = await svc.canReadAsEveryoneBatch(workspaceId, [
        'Public/Brochure.md',
        'Knowledge/Deal.md',
      ]);
      expect(asEveryone.get('Public/Brochure.md')).toBe(true);
      expect(asEveryone.get('Knowledge/Deal.md')).toBe(false);
    });
  });

  describe('the fold is GRANT-ONLY', () => {
    it('a `deny download` says nothing about read — a separate read grant survives it', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\nread:\n  - Ana <ana@x.io>\n',
        'Knowledge/access.md': '---\n---\ndownload:\n  - deny Ana <ana@x.io>\n',
      });
      // The scenario from the spec: read inherited from the parent, download
      // denied here. She can still open the file; she cannot save it.
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(false);
    });

    it('a `deny download` on its own grants no read', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - deny Ana <ana@x.io>\n',
      });
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(false);
    });

    it('a closer `deny read` beats a farther download grant, and takes download with it', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
        'Knowledge/Secret/access.md': '---\n---\nread:\n  - deny Ana <ana@x.io>\n',
      });
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Secret/Deal.md')).toBe(false);
      // Download presupposes read (`VERB_REQUIRES`): she may not save a copy
      // of what she may not open. The grant is not dead upstream — it still
      // holds where the read denial does not reach.
      expect(await svc.canDownload(workspaceId, 'ana@x.io', 'Knowledge/Secret/Deal.md')).toBe(false);
      expect(await svc.canDownload(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(true);
    });

    it('a same-scope download grant overrides a `deny read` beside it, as a write grant does', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md':
          '---\n---\nread:\n  - deny Ana <ana@x.io>\ndownload:\n  - Ana <ana@x.io>\n',
      });
      expect(await svc.canRead(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(true);
    });

    it('confers no write and no ownership', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
      });
      expect(await svc.canWrite(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(false);
      expect(await svc.canOwner(workspaceId, 'ana@x.io', 'Knowledge/Deal.md')).toBe(false);
    });
  });

  describe('the share surface sees the fold', () => {
    it('eligibleReaders names the downloaders', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Product Manager\n  - Ana <ana@x.io>\n',
      });
      const readers = await svc.eligibleReaders(workspaceId, 'Knowledge/Deal.md');
      expect(readers.roles).toContain('Product Manager');
      // Names are not carried on eligible-holder rows (they never have been).
      expect(readers.users).toEqual([{ name: '', email: 'ana@x.io' }]);
    });

    it('`download: everyone` makes a node public', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - everyone\n',
      });
      const readers = await svc.eligibleReaders(workspaceId, 'Knowledge/Deal.md');
      expect(readers.restricted).toBe(false);
    });

    it('grantSources reports the download grant as the source of the implied read', async () => {
      const svc = await makeService({
        ...BASE,
        'access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
      });
      const sources = await svc.grantSources(
        workspaceId,
        'file',
        'Knowledge/Deal.md',
        { kind: 'user', email: 'ana@x.io' },
      );
      expect(sources.download).toEqual([{ kind: 'ancestor', path: 'access.md' }]);
      expect(sources.read).toEqual([{ kind: 'ancestor', path: 'access.md' }]);
      expect(sources.write).toBeUndefined();
    });
  });
});
