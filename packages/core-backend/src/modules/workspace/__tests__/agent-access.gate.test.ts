import { describe, expect, it, beforeEach } from 'vitest';
import {
  notifyAgentRead,
  assertAgentWriteAllowed,
  SESSION_ID_DESCRIPTION,
  SESSION_ID_INPUT,
  ToolDescriptionNotes,
  type AgentAccessGate,
} from '../agent-access.gate.js';
import { WorkflowHooks, type AgentOperationContext } from '../../workflow/workflow-hooks.js';
import { ToolError, type ToolContext } from '../../tool-helpers/tool.contract.js';

const RECOVERY_EMAIL = 'recovery-bot@bevel.local';
const P_FILE = 'knowledge-base/KnowledgeBase/Product/Knowledge/Roadmap.md';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A' },
    scope: 'write',
    source: 'external',
    sessionId: 's1',
    abortSignal: new AbortController().signal,
    workspaceService: {} as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => ({}) as never,
    ...over,
  } as ToolContext;
}

/** A gate with a fresh hook registry, plus the two lists of what the hooks saw. */
function makeGate(): { gate: AgentAccessGate; reads: AgentOperationContext[]; writes: AgentOperationContext[] } {
  const hooks = new WorkflowHooks();
  const reads: AgentOperationContext[] = [];
  const writes: AgentOperationContext[] = [];
  hooks.onAgentRead(async (op) => {
    reads.push(op);
  });
  hooks.onPreWrite(async (op) => {
    writes.push(op);
  });
  return { gate: { recoveryBotEmail: RECOVERY_EMAIL, hooks, notes: new ToolDescriptionNotes() }, reads, writes };
}

describe('notifyAgentRead', () => {
  it('calls the read hook once with the session, path, branch, user and source', async () => {
    const { gate, reads, writes } = makeGate();
    await notifyAgentRead(gate, ctx(), 'draft-1', P_FILE);
    expect(reads).toEqual([
      {
        sessionId: 's1',
        wsPath: P_FILE,
        branch: 'draft-1',
        user: { id: 'u1', email: 'a@b.c', name: 'A' },
        source: 'external',
      },
    ]);
    expect(writes).toEqual([]);
  });

  it('carries the in-app agent as source `internal`', async () => {
    const { gate, reads } = makeGate();
    await notifyAgentRead(gate, ctx({ source: 'internal' }), 'main', P_FILE);
    expect(reads[0].source).toBe('internal');
  });

  it('calls the hook with no session id when the call carried none — the hook decides', async () => {
    const { gate, reads } = makeGate();
    await notifyAgentRead(gate, ctx({ sessionId: undefined }), 'main', P_FILE);
    expect(reads).toHaveLength(1);
    expect(reads[0].sessionId).toBeUndefined();
  });

  it('never reaches the hooks for a caller that is not an agent', async () => {
    const { gate, reads } = makeGate();
    await notifyAgentRead(gate, ctx({ source: 'session' }), 'main', P_FILE);
    expect(reads).toEqual([]);
  });

  it('never reaches the hooks for the recovery bot, whatever the case of its address', async () => {
    const { gate, reads } = makeGate();
    await notifyAgentRead(gate, ctx({ user: { id: 'bot', email: 'Recovery-Bot@Bevel.local', name: 'bot' } }), 'main', P_FILE);
    expect(reads).toEqual([]);
  });

  it('refuses the read with the hook\'s own message and status', async () => {
    const hooks = new WorkflowHooks();
    hooks.onAgentRead(async () => {
      throw new ToolError('Not in this conversation.', 403);
    });
    const gate: AgentAccessGate = { recoveryBotEmail: RECOVERY_EMAIL, hooks, notes: new ToolDescriptionNotes() };
    await expect(notifyAgentRead(gate, ctx(), 'main', P_FILE)).rejects.toMatchObject({
      message: 'Not in this conversation.',
      status: 403,
    });
  });

  it('is a no-op with no hook registered', async () => {
    const gate: AgentAccessGate = {
      recoveryBotEmail: RECOVERY_EMAIL,
      hooks: new WorkflowHooks(),
      notes: new ToolDescriptionNotes(),
    };
    await expect(notifyAgentRead(gate, ctx({ sessionId: undefined }), 'main', P_FILE)).resolves.toBeUndefined();
  });
});

describe('assertAgentWriteAllowed', () => {
  it('calls the write hook with the path, and never the read hook', async () => {
    const { gate, reads, writes } = makeGate();
    await assertAgentWriteAllowed(gate, ctx(), 'draft-1', P_FILE);
    expect(reads).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ sessionId: 's1', wsPath: P_FILE, branch: 'draft-1', source: 'external' });
  });

  it('calls the write hook with NO path for a write-capable call that has none', async () => {
    const { gate, writes } = makeGate();
    await assertAgentWriteAllowed(gate, ctx(), 'main');
    expect(writes).toHaveLength(1);
    expect(writes[0].wsPath).toBeUndefined();
    expect(writes[0].branch).toBe('main');
  });

  it('refuses the write with the hook\'s own message and status', async () => {
    const hooks = new WorkflowHooks();
    hooks.onPreWrite(async () => {
      throw new ToolError('Not in this conversation.', 403);
    });
    const gate: AgentAccessGate = { recoveryBotEmail: RECOVERY_EMAIL, hooks, notes: new ToolDescriptionNotes() };
    await expect(assertAgentWriteAllowed(gate, ctx(), 'main', P_FILE)).rejects.toMatchObject({
      message: 'Not in this conversation.',
      status: 403,
    });
  });

  it('runs every registered write hook, in registration order, until one throws', async () => {
    const hooks = new WorkflowHooks();
    const seen: string[] = [];
    hooks.onPreWrite(async () => {
      seen.push('first');
    });
    hooks.onPreWrite(async () => {
      seen.push('second');
      throw new ToolError('no', 403);
    });
    hooks.onPreWrite(async () => {
      seen.push('third');
    });
    const gate: AgentAccessGate = { recoveryBotEmail: RECOVERY_EMAIL, hooks, notes: new ToolDescriptionNotes() };
    await expect(assertAgentWriteAllowed(gate, ctx(), 'main', P_FILE)).rejects.toThrow('no');
    expect(seen).toEqual(['first', 'second']);
  });

  it('never reaches the hooks for a person in the app or for the recovery bot', async () => {
    const { gate, writes } = makeGate();
    await assertAgentWriteAllowed(gate, ctx({ source: 'session' }), 'main', P_FILE);
    await assertAgentWriteAllowed(gate, ctx({ user: { id: 'bot', email: RECOVERY_EMAIL, name: 'bot' } }), 'main', P_FILE);
    expect(writes).toEqual([]);
  });

  it('is a no-op with no hook registered, with or without a session id', async () => {
    const gate: AgentAccessGate = {
      recoveryBotEmail: RECOVERY_EMAIL,
      hooks: new WorkflowHooks(),
      notes: new ToolDescriptionNotes(),
    };
    await expect(assertAgentWriteAllowed(gate, ctx(), 'main', P_FILE)).resolves.toBeUndefined();
    await expect(assertAgentWriteAllowed(gate, ctx({ sessionId: undefined }), 'main', P_FILE)).resolves.toBeUndefined();
  });
});

describe('ToolDescriptionNotes', () => {
  let notes: ToolDescriptionNotes;
  beforeEach(() => {
    notes = new ToolDescriptionNotes();
  });

  it('has no note registered by default, which is every Hexis-only deployment', () => {
    expect(notes.gatedToolNote()).toBe('');
    expect(notes.sessionIdDescription()).toBe(SESSION_ID_DESCRIPTION);
  });

  it('appends a registered gated-tool note and a registered sessionId note', () => {
    notes.registerGatedToolNote(' Stay put.');
    notes.registerSessionIdNote(' It also pins the boundary.');
    expect(notes.gatedToolNote()).toBe(' Stay put.');
    expect(notes.sessionIdDescription()).toBe(`${SESSION_ID_DESCRIPTION} It also pins the boundary.`);
  });

  it('tells its subscribers on every registration, so mounted tools re-describe', () => {
    let calls = 0;
    notes.onChange(() => {
      calls++;
    });
    notes.registerGatedToolNote(' a');
    notes.registerSessionIdNote(' b');
    expect(calls).toBe(2);
  });

  it('the default sessionId input says what the id is, and mentions no ontology', () => {
    expect(SESSION_ID_INPUT.description).toBe(SESSION_ID_DESCRIPTION);
    expect(SESSION_ID_DESCRIPTION).toMatch(/conversation/i);
    expect(SESSION_ID_DESCRIPTION).toMatch(/start_session/);
    expect(SESSION_ID_DESCRIPTION).toMatch(/ask/);
    expect(SESSION_ID_DESCRIPTION.toLowerCase()).not.toContain('ontolog');
  });
});
