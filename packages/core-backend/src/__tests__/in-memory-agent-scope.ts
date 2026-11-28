/**
 * The in-memory agent-scope stand-in (a distribution's `.agent` files held in
 * memory and resolved the way a deployment resolves them), for a suite
 * outside agent-scope that drives a tool surface through the real
 * `ConnectionScope`. The stand-in itself stays in agent-scope's own
 * `__tests__` folder, where that module's suites and the mcp suites already
 * import it; this root fixture re-exports it, as `tool-wiring.ts` re-exports
 * the pieces the root composes, so a suite of another module can import it
 * from here instead of from agent-scope's test folder.
 */
export { agentFile, agentScopeOver, inMemoryKb, type InMemoryKb } from '../modules/agent-scope/__tests__/in-memory-kb.js';
