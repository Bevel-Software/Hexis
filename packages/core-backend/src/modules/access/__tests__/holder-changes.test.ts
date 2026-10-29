import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

/**
 * `prospectiveHolderChanges`: who loses and who gains opening or editing a
 * file or folder in a move, over a real on-disk tree. The holder lists name
 * grants, so these tests are about the cases a list comparison gets wrong: a
 * group still covered by `everyone` where it lands, and someone a rule there
 * denies by name, even when their only access before was `everyone`.
 */

const KB_DIR = 'knowledge-base';
const rules = (body: string) => `---\n${body}---\n`;

describe('AccessControlService.prospectiveHolderChanges', () => {
  let root: string;
  let repo: string;
  const workspaceId = 'ws-holder-changes';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-holder-changes-'));
    repo = path.join(root, workspaceId, KB_DIR);
  });
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function write(files: Record<string, string>): Promise<void> {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
  }

  const service = () =>
    new AccessControlService(
      {
        getWorkspacePath: async () => path.join(root, workspaceId),
        ensureRemotesFetched: async () => undefined,
      } as unknown as WorkspaceService,
      KB_DIR,
      new NodeFs(),
    );

  /** Everyone reads; Support and Operations each edit their own folder. */
  const BASE = {
    'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n',
    'groups.yaml': 'groups:\n  Support:\n    - bea@x.io\n  Operations:\n    - jonas@x.io\n',
    'access.md': rules('read:\n  - everyone\n'),
    'Support/access.md': rules('write:\n  - Support\n'),
    'Support/Runbooks/Warranty claim.md': '# Warranty claim\n',
    'Operations/access.md': rules('write:\n  - Operations\n'),
  };

  it('a folder handed to another team: the old team loses editing, the new one gains it, and nobody loses opening it', async () => {
    await write(BASE);
    const changes = await service().prospectiveHolderChanges(workspaceId, 'Support/Runbooks', 'Operations/Runbooks');
    expect(changes).toEqual({
      lose: [{ kind: 'group', name: 'Support', verb: 'write' }],
      gain: [{ kind: 'group', name: 'Operations', verb: 'write' }],
    });
  });

  it('a person the destination denies by name loses access, though everyone may still read there', async () => {
    await write({
      ...BASE,
      'Team/access.md': rules('write:\n  - Ana <ana@x.io>\n'),
      'Team/plan.md': '# Plan\n',
      'Closed/access.md': rules('read:\n  - everyone\n  - deny Ana <ana@x.io>\n'),
    });
    const changes = await service().prospectiveHolderChanges(workspaceId, 'Team/plan.md', 'Closed/plan.md');
    expect(changes.lose).toEqual(
      expect.arrayContaining([
        { kind: 'person', name: 'ana@x.io', email: 'ana@x.io', verb: 'read' },
        { kind: 'person', name: 'ana@x.io', email: 'ana@x.io', verb: 'write' },
      ]),
    );
  });

  it('a person whose only access was everyone, and whom the destination denies by name, loses it', async () => {
    await write({
      ...BASE,
      'Closed/access.md': rules('read:\n  - everyone\n  - deny Leo <leo@x.io>\n'),
    });
    const changes = await service().prospectiveHolderChanges(workspaceId, 'Support/Runbooks', 'Closed/Runbooks');
    expect(changes.lose).toContainEqual({ kind: 'person', name: 'leo@x.io', email: 'leo@x.io', verb: 'read' });
  });

  it('a group whose only read was everyone, and which the destination denies, loses it', async () => {
    await write({
      ...BASE,
      'Closed/access.md': rules('read:\n  - everyone\n  - deny Operations\n'),
    });
    const changes = await service().prospectiveHolderChanges(workspaceId, 'Support/Runbooks', 'Closed/Runbooks');
    expect(changes.lose).toContainEqual({ kind: 'group', name: 'Operations', verb: 'read' });
  });

  it('a group the destination denies loses opening it, though everyone may still read there', async () => {
    await write({
      ...BASE,
      'Closed/access.md': rules('read:\n  - everyone\n  - deny Support\n'),
    });
    const changes = await service().prospectiveHolderChanges(workspaceId, 'Support/Runbooks', 'Closed/Runbooks');
    expect(changes.lose).toEqual(
      expect.arrayContaining([
        { kind: 'group', name: 'Support', verb: 'read' },
        { kind: 'group', name: 'Support', verb: 'write' },
      ]),
    );
  });

  it('a rename that carries its own rules changes nobody', async () => {
    await write({
      ...BASE,
      'Sales/access.md': rules('read:\n  - Support\nwrite:\n  - Support\n'),
      'Sales/deal.md': '# Deal\n',
    });
    expect(await service().prospectiveHolderChanges(workspaceId, 'Sales', 'Revenue')).toEqual({ lose: [], gain: [] });
  });
});
