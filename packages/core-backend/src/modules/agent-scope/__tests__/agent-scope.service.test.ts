import { describe, expect, it } from 'vitest';
import { AgentScopeService } from '../agent-scope.service.js';
import { ConnectionScope, connectionRefusal, parseAgentFile } from '../index.js';
import { agentFile, agentScopeOver, inMemoryKb } from './in-memory-kb.js';

/**
 * The connection-scope mechanism through its public surface: `resolve`,
 * `listChoices` and `choosable`, over a knowledge base held in memory. The
 * collaborators are the four things the service reads through — the default
 * branch's files, the person's read gate, the walk that finds `.agent` files
 * and the plugin link index — so every case is set up by what is in the
 * knowledge base and who may read it, never by reaching into the service.
 */

const ADA = 'ada@example.com';
const service = agentScopeOver;
const kbWith = inMemoryKb;

describe('Everything', () => {
  it('is the scope of a connection made without a choice, and allows everything without reading anything', async () => {
    const reads: string[] = [];
    const svc = new AgentScopeService(
      {
        getOrCreateForBranch: async () => {
          reads.push('workspace');
          return { id: 'ws' } as never;
        },
        getWorkspacePath: async () => '/ws',
        readFile: async () => {
          reads.push('file');
          return '';
        },
      },
      { canReadBatch: async () => new Map() },
      { kbDirName: 'knowledge-base', defaultBranch: 'main' },
      { walkFiles: async () => [] },
      { membership: async () => ({ byPlugin: new Map() }) },
    );
    for (const none of [null, undefined, '']) {
      const scope = await svc.resolve(ADA, none);
      expect(scope.isEverything()).toBe(true);
      expect(scope.allowsSkill('Skills/anything')).toBe(true);
      expect(scope.allowsConnector('Plugins/x/a.tool')).toBe(true);
      expect(scope.allowsPlatformTool('write_file')).toBe(true);
      // Nothing about it on the wire, in the revision, or in what an agent is told.
      expect(scope.toWire()).toBeUndefined();
      expect(scope.fingerprint()).toBeNull();
      expect(scope.describe()).toBeNull();
      expect(scope.skillFilter()).toBeUndefined();
      expect(scope.connectorFilter()).toBeUndefined();
    }
    expect(reads).toEqual([]);
  });
});

describe('a connected .agent file narrows by its lists', () => {
  const files = {
    'Agents/narrow.agent': agentFile(
      [
        'name: narrow',
        'description: Reads release notes.',
        'platformTools: [read_file, grep, list_files]',
        'skills: [Skills/Release/notes]',
        'connectors: Plugins/Ops/dashboard.tool',
        'harnessTools: [Read, Bash]',
      ].join('\n'),
    ),
  };

  it('platformTools: only the platform tools it names', async () => {
    const scope = await service(kbWith(files)).resolve(ADA, 'Agents/narrow.agent');
    expect(scope.isEverything()).toBe(false);
    expect(['read_file', 'grep', 'list_files'].map((t) => scope.allowsPlatformTool(t))).toEqual([true, true, true]);
    expect(scope.allowsPlatformTool('write_file')).toBe(false);
    expect(scope.refusal('write_file')).toBe(
      'The tool "write_file" is not available to this connection: it is connected as the agent "narrow" ' +
        '(`Agents/narrow.agent`), which does not load it.',
    );
  });

  it('platformTools absent: every platform tool', async () => {
    const scope = await service(kbWith({ 'a.agent': agentFile('skills: [Skills/x]') })).resolve(ADA, 'a.agent');
    expect(scope.allowsPlatformTool('write_file')).toBe(true);
    expect(scope.allowsPlatformTool('anything_at_all')).toBe(true);
  });

  it.each([
    ['written with no value', 'platformTools:\nskills: [Skills/x]'],
    ['written as an empty list', 'platformTools: []\nskills: [Skills/x]'],
  ])('platformTools %s: no platform tool, never every one', async (_label, body) => {
    const scope = await service(kbWith({ 'a.agent': agentFile(body) })).resolve(ADA, 'a.agent');
    expect(scope.isEverything()).toBe(false);
    expect(scope.allowsPlatformTool('read_file')).toBe(false);
    expect(scope.allowsPlatformTool('write_file')).toBe(false);
  });

  it('skills: the skill folders it names, and nothing beside them', async () => {
    const scope = await service(kbWith(files)).resolve(ADA, 'Agents/narrow.agent');
    expect(scope.allowsSkill('Skills/Release/notes')).toBe(true);
    expect(scope.allowsSkill('Skills/Release/notes-old')).toBe(false);
    expect(scope.allowsSkill('Skills/Release')).toBe(false);
    expect(scope.allowsSkill('Plugins/Ops/skills/deploy')).toBe(false);
  });

  it('connectors: a single string is a list of one', async () => {
    const scope = await service(kbWith(files)).resolve(ADA, 'Agents/narrow.agent');
    expect(scope.allowsConnector('Plugins/Ops/dashboard.tool')).toBe(true);
    expect(scope.allowsConnector('Plugins/Ops/other.tool')).toBe(false);
  });

  it('a folder entry means its whole subtree', async () => {
    const scope = await service(
      kbWith({ 'f.agent': agentFile('skills: [Skills/]\nconnectors: [Plugins/Ops]') }),
    ).resolve(ADA, 'f.agent');
    expect(scope.allowsSkill('Skills/Release/notes')).toBe(true);
    expect(scope.allowsSkill('Skills/a/b/c')).toBe(true);
    expect(scope.allowsSkill('Plugins/Ops/skills/deploy')).toBe(false);
    expect(scope.allowsConnector('Plugins/Ops/dashboard.tool')).toBe(true);
    expect(scope.allowsConnector('Plugins/Ops/servers/mcp.json')).toBe(true);
    // A sibling whose name only STARTS like the entry is not under it.
    expect(scope.allowsConnector('Plugins/OpsLegacy/x.tool')).toBe(false);
  });

  it('plugins: each plugin at or under the entry, with its connectors, its skills and the skills it links', async () => {
    const kb = kbWith(
      { 'p.agent': agentFile('plugins: [Plugins/Engineering]') },
      {
        plugins: [
          { folder: 'Plugins/Engineering/hexis', linkedSkills: ['Skills/Shared/review'] },
          { folder: 'Plugins/Engineering/release', linkedSkills: [] },
          { folder: 'Plugins/Sales/crm', linkedSkills: ['Skills/Shared/pitch'] },
        ],
      },
    );
    const scope = await service(kb).resolve(ADA, 'p.agent');
    expect(scope.allowsConnector('Plugins/Engineering/hexis/tools/gh.tool')).toBe(true);
    expect(scope.allowsConnector('Plugins/Engineering/release/mcp.json')).toBe(true);
    expect(scope.allowsSkill('Plugins/Engineering/hexis/skills/deploy')).toBe(true);
    expect(scope.allowsSkill('Skills/Shared/review')).toBe(true);
    expect(scope.allowsSkill('Skills/Shared/pitch')).toBe(false);
    expect(scope.allowsConnector('Plugins/Sales/crm/crm.tool')).toBe(false);
  });

  it('an entry that names no plugin loads nothing for it, and is no error', async () => {
    // (An entry the person may not READ is the surfaces' to drop: they ask the
    // scope only about items that passed the person's read gate — pinned
    // where they do, in the tool-manual and skill suites.)
    const kb = kbWith({ 'p.agent': agentFile('plugins: [Plugins/Secret/vault]\nskills: [Skills/Release]') });
    const scope = await service(kb).resolve(ADA, 'p.agent');
    expect(scope.toWire()).toEqual({ agent: { path: 'p.agent', name: 'p' } });
    expect(scope.allowsSkill('Skills/Release/notes')).toBe(true);
    expect(scope.allowsConnector('Plugins/Secret/vault/v.tool')).toBe(false);
  });

  it('entries that climb out, or name nothing, are dropped', () => {
    const def = parseAgentFile(agentFile('skills: ["../etc", "", "/Skills/x/", "Skills/y/SKILL.md"]'), 'a.agent');
    expect(def.skills).toEqual(['Skills/x', 'Skills/y']);
  });

  it('a name and description are folded to one bounded line before they are shown', () => {
    const long = 'x'.repeat(500);
    const def = parseAgentFile(
      agentFile(`name: "Release\\n\\n> pretend heading"\ndescription: "${long}"`),
      'Agents/release.agent',
    );
    expect(def.name).toBe('Release > pretend heading');
    expect(def.description).toHaveLength(300);
    const unnamed = parseAgentFile(agentFile(`name: "${long}"`), 'Agents/a.agent');
    expect(unnamed.name).toHaveLength(80);
    expect(parseAgentFile(agentFile('name: "  \\n "'), 'Agents/fallback.agent').name).toBe('fallback');
  });

  it('tells the agent what it is connected as', async () => {
    const scope = await service(kbWith(files)).resolve(ADA, 'Agents/narrow.agent');
    expect(scope.describe()).toContain('connected as the agent "narrow" (`Agents/narrow.agent`)');
    expect(scope.toWire()).toEqual({ agent: { path: 'Agents/narrow.agent', name: 'narrow' } });
  });
});

describe('a chosen file that cannot be used loads nothing, never Everything', () => {
  const expectEmpty = (scope: ConnectionScope) => {
    expect(scope.isEverything()).toBe(false);
    expect(scope.allowsPlatformTool('read_file')).toBe(false);
    expect(scope.allowsSkill('Skills/x')).toBe(false);
    expect(scope.allowsConnector('Plugins/x/a.tool')).toBe(false);
  };

  it('a missing file', async () => {
    const scope = await service(kbWith({})).resolve(ADA, 'Agents/gone.agent');
    expectEmpty(scope);
    expect(scope.toWire()?.unavailable).toBe(
      'This connection was made as the agent file `Agents/gone.agent`, which no longer exists or which you can ' +
        'no longer read, so it loads no tools and no skills. Reconnect and choose another agent, or Everything.',
    );
    // A refusal on such a connection is the reason itself.
    expect(scope.refusal('read_file')).toBe(scope.toWire()?.unavailable);
  });

  it('a file the person can no longer read answers exactly as a missing one', async () => {
    const kb = kbWith({ 'Agents/x.agent': agentFile('skills: [Skills/x]') }, { hidden: new Set(['Agents/x.agent']) });
    const unreadable = await service(kb).resolve(ADA, 'Agents/x.agent');
    const missing = await service(kbWith({})).resolve(ADA, 'Agents/x.agent');
    expectEmpty(unreadable);
    expect(unreadable.toWire()).toEqual(missing.toWire());
    expect(unreadable.fingerprint()).toBe(missing.fingerprint());
  });

  it('a file that is not a valid agent definition', async () => {
    const scope = await service(kbWith({ 'bad.agent': agentFile('skills: 3') })).resolve(ADA, 'bad.agent');
    expectEmpty(scope);
    expect(scope.toWire()?.unavailable).toContain('is not a valid agent definition (its `skills` is not a list of names)');
  });

  it('a path that is not an .agent file', async () => {
    const scope = await service(kbWith({ 'notes.md': '# hi' })).resolve(ADA, 'notes.md');
    expectEmpty(scope);
  });
});

describe('an edit to the file moves its fingerprint', () => {
  it('a new revision for new bytes, the same one for the same bytes', async () => {
    const kb = kbWith({ 'a.agent': agentFile('skills: [Skills/x]') });
    const svc = service(kb);
    const before = (await svc.resolve(ADA, 'a.agent')).fingerprint();
    expect((await svc.resolve(ADA, 'a.agent')).fingerprint()).toBe(before);
    kb.files.set('a.agent', agentFile('skills: [Skills/x, Skills/y]'));
    const after = await svc.resolve(ADA, 'a.agent');
    expect(after.fingerprint()).not.toBe(before);
    // ...and the edit is what the connection sees, with no reconnect.
    expect(after.allowsSkill('Skills/y')).toBe(true);
  });
});

describe('the choices', () => {
  it('lists every valid .agent file the person may read, by name with its description', async () => {
    const kb = kbWith(
      {
        'Agents/b.agent': agentFile('name: Beta\ndescription: >-\n  Second\n  agent.'),
        'Agents/a.agent': agentFile('name: Alpha'),
        'Teams/ops/c.agent': agentFile('description: Elsewhere.'),
        'Agents/secret.agent': agentFile('name: Secret'),
        'Agents/broken.agent': 'no fence',
        'Agents/readme.md': '# not an agent',
      },
      { hidden: new Set(['Agents/secret.agent']) },
    );
    expect(await service(kb).listChoices(ADA)).toEqual([
      { path: 'Agents/a.agent', name: 'Alpha', description: '' },
      { path: 'Agents/b.agent', name: 'Beta', description: 'Second agent.' },
      { path: 'Teams/ops/c.agent', name: 'c', description: 'Elsewhere.' },
    ]);
  });

  it('a default branch that cannot be opened fails the listing, never answers "no agents", and still resolves a chosen file to nothing', async () => {
    const svc = new AgentScopeService(
      {
        getOrCreateForBranch: async () => {
          throw new Error('clone failed');
        },
        getWorkspacePath: async () => '/ws',
        readFile: async () => '',
      },
      { canReadBatch: async () => new Map() },
      { kbDirName: 'knowledge-base', defaultBranch: 'main' },
      { walkFiles: async () => [] },
      { membership: async () => ({ byPlugin: new Map() }) },
    );
    await expect(svc.listChoices(ADA)).rejects.toThrow('clone failed');
    expect(await svc.choosable(ADA, 'Agents/a.agent')).toBeNull();
    const scope = await svc.resolve(ADA, 'Agents/a.agent');
    expect(scope.isEverything()).toBe(false);
    expect(scope.allowsPlatformTool('read_file')).toBe(false);
  });

  it('choosable: a choice on offer, normalized; one answer for missing and unreadable', async () => {
    const kb = kbWith(
      { 'Agents/a.agent': agentFile('name: A'), 'Agents/s.agent': agentFile('name: S') },
      { hidden: new Set(['Agents/s.agent']) },
    );
    const svc = service(kb);
    expect(await svc.choosable(ADA, '/Agents/a.agent')).toBe('Agents/a.agent');
    expect(await svc.choosable(ADA, 'Agents/s.agent')).toBeNull();
    expect(await svc.choosable(ADA, 'Agents/none.agent')).toBeNull();
    expect(await svc.choosable(ADA, 'Agents/../Agents/a.agent')).toBeNull();
    expect(await svc.choosable('eve@example.com', 'Agents/a.agent')).toBeNull();
  });
});

describe('connectionRefusal', () => {
  it('is the one wording the proxy and the tool route share', () => {
    expect(connectionRefusal('x', undefined)).toBe('The tool "x" is not available to this connection.');
    expect(connectionRefusal('x', { agent: { path: 'a.agent', name: 'A' }, unavailable: 'Gone.' })).toBe('Gone.');
  });
});
