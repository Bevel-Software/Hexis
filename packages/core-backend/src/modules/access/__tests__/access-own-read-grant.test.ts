import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { registerAccessFrontmatterExtensions } from '../../access-model/access-grammar.js';

const KB = 'knowledge-base';

const ROLES_YAML = `roles:
  Admin:
    - razvan@bevel.software
  Developer:
    - coding-agent@bevel.software
  Agent:
    - coding-agent@bevel.software
`;

// Shaped like the real files: folded descriptions, literal blocks, nested
// maps, comments — everything the access grammar's subset parser stops at.
const PIPELINE = `---
apiVersion: bevel.software/v1
kind: Pipeline
id: coding-delivery-process
name: Coding Delivery
description: >-
  End-to-end delivery of one coding ticket: workspace preparation, coding, local
  testing, a two-check review gate, staged rollout, and production verification.
# Which tickets this runner works.
queue:
  trigger: dataStatus
  projects:
    - KnowledgeBase/Engineering/Knowledge/Bevel-Platform.md
do:
  - name: Coding
    kind: agent
    instructions: |
      Implement the ticket in the workspace.
      Commit locally; never push.
owner: razvan.radulescu <razvan@bevel.software>
read: coding-agent <coding-agent@bevel.software>
write: Developer
---
`;

const AGENT = `---
apiVersion: bevel.software/v1
kind: Agent
id: delivery_coder
name: delivery-coder
description: >-
  Writes and verifies the code for one delivery ticket.
systemPrompt:
  extend: |
    You are executing exactly ONE step of a pipeline.
env:
  - { name: STAGING_URL, from: params, param: stagingUrl }
owner: razvan.radulescu <razvan@bevel.software>
read: coding-agent <coding-agent@bevel.software>
write: Developer
---

# delivery-coder
`;

describe('a file-own read grant on a whole-document configuration file', () => {
  let root: string;
  let repo: string;
  const ws = 'ws-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'own-read-'));
    repo = path.join(root, ws, KB);
    await fs.mkdir(path.join(repo, 'Pipelines'), { recursive: true });
    await fs.mkdir(path.join(repo, 'Agents'), { recursive: true });
    await fs.writeFile(path.join(repo, 'roles.yaml'), ROLES_YAML);
    await fs.writeFile(path.join(repo, 'access.md'), '---\nwrite:\n  - Admin\ndownload:\n  - Admin\nowner: []\n---\n');
    await fs.writeFile(path.join(repo, 'Pipelines', 'access.md'), '---\nwrite: []\n---\n');
    await fs.writeFile(path.join(repo, 'Pipelines', 'Coding-Delivery.pipeline'), PIPELINE);
    await fs.writeFile(path.join(repo, 'Agents', 'access.md'), '---\nwrite: []\n---\n');
    await fs.writeFile(path.join(repo, 'Agents', 'delivery-coder.agent'), AGENT);
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  const svc = () =>
    new AccessControlService(
      { getWorkspacePath: async () => path.join(root, ws) } as unknown as WorkspaceService,
      KB,
    );

  it('the grantee reads the file (registered kinds)', async () => {
    registerAccessFrontmatterExtensions(['.pipeline', '.agent']);
    const s = svc();
    expect(await s.canRead(ws, 'coding-agent@bevel.software', 'Pipelines/Coding-Delivery.pipeline')).toBe(true);
    expect(await s.canRead(ws, 'coding-agent@bevel.software', 'Agents/delivery-coder.agent')).toBe(true);
    expect(await s.canWrite(ws, 'coding-agent@bevel.software', 'Pipelines/Coding-Delivery.pipeline')).toBe(true);
    // Batch path, which the explorer and the tool catalog use.
    const batch = await s.canReadBatch(ws, 'coding-agent@bevel.software', [
      'Pipelines/Coding-Delivery.pipeline',
      'Agents/delivery-coder.agent',
      'Pipelines/README.md',
    ]);
    expect([...batch.entries()]).toEqual([
      ['Pipelines/Coding-Delivery.pipeline', true],
      ['Agents/delivery-coder.agent', true],
      ['Pipelines/README.md', false],
    ]);
  });

  it('a stranger does not', async () => {
    registerAccessFrontmatterExtensions(['.pipeline', '.agent']);
    expect(await svc().canRead(ws, 'someone@else.io', 'Pipelines/Coding-Delivery.pipeline')).toBe(false);
  });
});
