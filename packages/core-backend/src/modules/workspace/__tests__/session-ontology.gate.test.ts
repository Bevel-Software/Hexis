import { describe, it, expect, beforeEach } from 'vitest';

import {
  recordOntologyRead,
  assertOntologyWriteAllowed,
  assertShellAllowedWithinOntology,
  MissingSessionError,
  type SessionOntologyGate,
} from '../session-ontology.gate.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ISessionOntologyService, OperationDecision } from '../../workflow/session-ontology.service.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ontologyOf } from '../../../shared/kb-layout.js';

const KB = 'knowledge-base';
const P_FILE = 'KnowledgeBase/Product/Knowledge/Foo.md';
const PL_FILE = 'KnowledgeBase/Platform/Knowledge/Bar.md';
const NEUTRAL = 'access.md';
const RECOVERY_EMAIL = 'recovery-bot@bevel.local';

/**
 * In-memory stand-in for the touched-set service — applies the real
 * reads-record / writes-block-once-multi rule against a per-session set, so the
 * gate's interaction with it is exercised end to end without a DB.
 */
function makeFakeService(): ISessionOntologyService {
  const touched = new Map<string, Set<string>>();
  const setFor = (s: string) => touched.get(s) ?? new Set<string>();
  return {
    async checkOperation(sessionId, wsPath, isWrite): Promise<OperationDecision> {
      const ont = ontologyOf(wsPath, KB);
      const set = setFor(sessionId);
      if (ont === null) return { allow: true, touched: [...set].sort() };
      if (isWrite) {
        const spanned = new Set(set).add(ont);
        if (spanned.size > 1) {
          return {
            allow: false,
            reason: set.size >= 2 ? 'multi-ontology' : 'different-ontology',
            touched: [...set].sort(),
            attempted: ont,
          };
        }
      }
      set.add(ont);
      touched.set(sessionId, set);
      return { allow: true, touched: [...set].sort() };
    },
    checkOntology: async () => ({ allow: true, touched: [] }),
    getTouched: async (s) => [...setFor(s)].sort(),
    delete: async (s) => { touched.delete(s); },
    sweepOlderThan: async () => 0,
  };
}

/**
 * Build a gate wired the way the CORE composition wires it: the fake
 * touched-set service plus an EMPTY hooks registry. Core registers no
 * `preWrite` hook, so the gate only TRACKS touches and never blocks — the
 * blocking assertions (the ontology-block hook the enterprise composition
 * root registers) live with that hook in the enterprise repo.
 */
function makeGate(): SessionOntologyGate {
  const service = makeFakeService();
  const hooks = new WorkflowHooks();
  return { service, enabled: true, kbDirName: KB, recoveryBotEmail: RECOVERY_EMAIL, hooks };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    user: { id: 'u1', email: 'dev@bevel.local', name: 'Dev' },
    scope: 'write',
    source: 'internal',
    sessionId: 's1',
    abortSignal: new AbortController().signal,
    workspaceService: {} as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => ({} as never),
    ...overrides,
  };
}

describe('recordOntologyRead', () => {
  let gate: SessionOntologyGate;

  beforeEach(() => {
    gate = makeGate();
  });

  it('does nothing when the flag is disabled', async () => {
    gate.enabled = false;
    await expect(recordOntologyRead(gate, ctx(), P_FILE)).resolves.toBeUndefined();
    expect(await gate.service.getTouched('s1')).toEqual([]);
  });

  it('skips neutral paths (no record)', async () => {
    await expect(recordOntologyRead(gate, ctx(), NEUTRAL)).resolves.toBeUndefined();
    expect(await gate.service.getTouched('s1')).toEqual([]);
  });

  it('skips non-agent (browser session) callers', async () => {
    await expect(
      recordOntologyRead(gate, ctx({ source: 'session', sessionId: undefined }), P_FILE),
    ).resolves.toBeUndefined();
  });

  it('skips the recovery bot by identity', async () => {
    await expect(
      recordOntologyRead(
        gate,
        ctx({ user: { id: 'bot', email: 'Recovery-Bot@Bevel.Local', name: 'bot' }, sessionId: undefined }),
        PL_FILE,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed when an agent read of a named path has no session id', async () => {
    await expect(recordOntologyRead(gate, ctx({ sessionId: undefined }), P_FILE)).rejects.toBeInstanceOf(
      MissingSessionError,
    );
  });

  it('allows a neutral read without a session id', async () => {
    await expect(recordOntologyRead(gate, ctx({ sessionId: undefined }), NEUTRAL)).resolves.toBeUndefined();
  });

  it('records a read and allows it', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    expect(await gate.service.getTouched('s1')).toEqual(['KnowledgeBase/Product']);
  });

  it('allows reads across ontologies (recording both)', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    await expect(recordOntologyRead(gate, ctx(), PL_FILE)).resolves.toBeUndefined();
    expect(await gate.service.getTouched('s1')).toEqual(['KnowledgeBase/Platform', 'KnowledgeBase/Product']);
  });

  it('never blocks — a read into a second ontology still passes (delete_file relies on this)', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    // A delete_file in a different ontology records its touch but never throws.
    await expect(recordOntologyRead(gate, ctx(), PL_FILE)).resolves.toBeUndefined();
  });
});

describe('assertOntologyWriteAllowed', () => {
  let gate: SessionOntologyGate;

  beforeEach(() => {
    gate = makeGate();
  });

  it('does nothing when the flag is disabled', async () => {
    gate.enabled = false;
    // Even a cross-ontology write must pass when disabled.
    await recordOntologyRead(gate, ctx(), P_FILE);
    await expect(assertOntologyWriteAllowed(gate, ctx(), PL_FILE)).resolves.toBeUndefined();
  });

  it('skips neutral paths (no record, no block)', async () => {
    await expect(assertOntologyWriteAllowed(gate, ctx(), NEUTRAL)).resolves.toBeUndefined();
    expect(await gate.service.getTouched('s1')).toEqual([]);
  });

  it('fails closed when an agent write of a named path has no session id', async () => {
    await expect(assertOntologyWriteAllowed(gate, ctx({ sessionId: undefined }), P_FILE)).rejects.toBeInstanceOf(
      MissingSessionError,
    );
  });

  it('allows a write confined to the one touched ontology', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    await expect(assertOntologyWriteAllowed(gate, ctx(), P_FILE)).resolves.toBeUndefined();
  });

  // NOTE (core split): the "blocks a write to a different ontology" and
  // "blocks ALL writes once the session has read across two ontologies" cases
  // moved with the ontology-block hook (`registerOntologyBlockHook`) to the
  // enterprise repo — core registers no preWrite hook, so a core-only
  // deployment TRACKS but never blocks. The tests below pin exactly that.

  it('core: allows a write to a different ontology (tracking only, no block hook)', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    await expect(assertOntologyWriteAllowed(gate, ctx(), PL_FILE)).resolves.toBeUndefined();
  });

  it('core: still allows writes after reading across two ontologies (no block hook)', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    await recordOntologyRead(gate, ctx(), PL_FILE);
    await expect(assertOntologyWriteAllowed(gate, ctx(), P_FILE)).resolves.toBeUndefined();
  });
});

describe('assertShellAllowedWithinOntology (shell / no-path tools)', () => {
  let gate: SessionOntologyGate;

  beforeEach(() => {
    gate = makeGate();
  });

  it('allows a fresh session (nothing touched)', async () => {
    await expect(assertShellAllowedWithinOntology(gate, ctx())).resolves.toBeUndefined();
  });

  it('allows a session confined to a single ontology', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    await expect(assertShellAllowedWithinOntology(gate, ctx())).resolves.toBeUndefined();
  });

  // NOTE (core split): the "blocks once the session has crossed into two
  // ontologies" case moved with the enterprise ontology-block hook. Core
  // registers no preWrite hook, so shell is never refused here.
  it('core: allows shell even after crossing into two ontologies (no block hook)', async () => {
    await recordOntologyRead(gate, ctx(), P_FILE);
    await recordOntologyRead(gate, ctx(), PL_FILE);
    await expect(assertShellAllowedWithinOntology(gate, ctx())).resolves.toBeUndefined();
  });

  it('does nothing when the flag is disabled', async () => {
    gate.enabled = false;
    await gate.service.checkOperation('s1', P_FILE, false);
    await gate.service.checkOperation('s1', PL_FILE, false);
    await expect(assertShellAllowedWithinOntology(gate, ctx())).resolves.toBeUndefined();
  });

  it('exempts the recovery bot', async () => {
    await gate.service.checkOperation('s1', P_FILE, false);
    await gate.service.checkOperation('s1', PL_FILE, false);
    await expect(
      assertShellAllowedWithinOntology(gate, ctx({ user: { id: 'bot', email: RECOVERY_EMAIL, name: 'bot' } })),
    ).resolves.toBeUndefined();
  });

  it('allows when there is no session id (nothing to evaluate)', async () => {
    await expect(assertShellAllowedWithinOntology(gate, ctx({ sessionId: undefined }))).resolves.toBeUndefined();
  });
});
