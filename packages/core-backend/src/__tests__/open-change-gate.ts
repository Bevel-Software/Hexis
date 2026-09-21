import type { IChangeReadGate } from '../modules/access-model/change-gate.js';

/**
 * A read-before-write gate that lets every change through — for tests whose
 * subject is something else. `WorkflowService` refuses to exist without a
 * gate (see its constructor), so a harness that only exercises branches,
 * change requests or commits passes this one. Never wired in production: the
 * composition root builds the real `ChangeReadGate`.
 */
export function openChangeGate(): IChangeReadGate {
  return {
    judge: async () => ({ allowed: true, via: 'readable' }),
    assertMayChange: async () => undefined,
  };
}
