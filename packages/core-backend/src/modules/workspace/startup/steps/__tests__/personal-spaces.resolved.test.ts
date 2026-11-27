import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceService } from '../../../index.js';
import { closePersonalSpaceRules } from '../personal-spaces.step.js';
import { realDisk } from '../../../../../__tests__/real-disk.js';
import { realAccessControl } from '../../../../../__tests__/real-access.js';

/**
 * What a personal space the boot step closed resolves to, through the real
 * access resolver over a real tree: proven by what it MEANS, not only by
 * what the file says.
 */

const KB_DIR = 'knowledge-base';
const workspaceId = 'ws-personal-spaces';
const OWNER = { name: 'Ali Vega', email: 'ali@x.io' };

describe('a personal space the boot step closed, resolved', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-personal-spaces-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('one seeded by the previous template, once closed, resolves like a new one', async () => {
    // The old seed: the owner's grants in the legacy single-block shape.
    const legacy =
      '---\nread:\n  - Ali Vega <ali@x.io>\nwrite:\n  - Ali Vega <ali@x.io>\nowner:\n  - Ali Vega <ali@x.io>\n---\nread: []\n';
    const closed = closePersonalSpaceRules(legacy, 'Plugins/personal-ali/access.md');
    expect(closed).not.toBeNull();
    // Closing it again changes nothing: the step is idempotent by parse, not by text.
    expect(closePersonalSpaceRules(closed!, 'Plugins/personal-ali/access.md')).toBeNull();

    const files: Record<string, string> = {
      'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n',
      'access.md': '---\nowner:\n  - Admin\n---\nread:\n  - everyone\nwrite:\n  - Admin\n',
      'Plugins/personal-ali/plugin.json': '{"name":"personal-ali"}',
      'Plugins/personal-ali/access.md': closed!,
      'Plugins/personal-ali/skills/weekly/SKILL.md': '# Weekly\n',
    };
    const workspaceDir = path.join(root, workspaceId);
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(workspaceDir, KB_DIR, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    const workspace = {
      getWorkspacePath: async () => workspaceDir,
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const svc = realAccessControl(workspace, KB_DIR, realDisk());

    const skill = 'Plugins/personal-ali/skills/weekly/SKILL.md';
    expect(await svc.canRead(workspaceId, 'bob@x.io', skill)).toBe(false);
    expect(await svc.canRead(workspaceId, OWNER.email, skill)).toBe(true);
    expect(await svc.canWrite(workspaceId, OWNER.email, skill)).toBe(true);
    expect(await svc.canRead(workspaceId, 'admin@x.io', skill)).toBe(false);
  });
});
