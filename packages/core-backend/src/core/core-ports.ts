import type { ISessionSink } from '../modules/workspace/session-sink.js';
import type {
  ISystemNoticeSink,
  RecoveryAgentRunner,
} from '../modules/workflow/pending-commits.worker.js';
import type { ILlmUsageMeter } from '../modules/tool-auth/llm-usage-meter.js';
import type { AuthProviderPlugin } from '../modules/auth/auth.routes.js';
import type { IErasureParticipant } from '../modules/auth/account-erasure.service.js';

/**
 * Every seam the enterprise overlay can fill in the CORE composition
 * (`createCoreServices`). All fields are optional; each has a safe core-only
 * default, so `createCoreServices(config)` with no ports yields a fully
 * working core deployment.
 *
 * Two consumption patterns exist, and they matter for wiring order:
 *
 * - CONSTRUCTION-TIME ports (`recoveryAgent`, `systemNotice`,
 *   `erasureParticipants`): dereferenced while core services are being
 *   constructed. Enterprise implementations of these need core services that
 *   don't exist yet at that point (the background-agent factory, the thread
 *   service, …), so the enterprise root passes FORWARDING DELEGATORS / a
 *   mutable array here and assigns the real targets right after
 *   `createCoreServices` returns. That is safe because core only *calls* these
 *   ports at request/commit/erasure time, long after boot — the same
 *   late-binding pattern the composition root already uses for e.g. the MCP
 *   OAuth revoke closure.
 *
 * - SERVER-TIME seams (`sessionSink`, `usageMeter`, `authProviders`): only
 *   read when `createCoreServer` mounts routes / registers tools. Core seeds
 *   them onto `CoreServices` from these ports (with the defaults below); the
 *   enterprise root overwrites the `CoreServices` fields (or pushes into the
 *   `authProviders` array) after construction, before the server is built.
 *
 * (Commit-time KB validation and the ontology write block are NOT ports:
 * they are workflow lifecycle HOOKS the enterprise root registers on
 * `workflowService.hooks` after construction — see
 * `modules/workflow/workflow-hooks.ts`.)
 */
export interface CorePorts {
  /**
   * Backs the `start_session` tool. Core default: {@link UuidSessionSink}
   * (a bare random id). Enterprise substitutes a sink that mints a real chat
   * thread so the same id works end to end with `ask`.
   */
  sessionSink?: ISessionSink;
  /**
   * Recovery-agent dispatcher for the pending-commits worker. The worker
   * requires one, so the core default is {@link noopRecoveryAgent} — a run
   * that just returns, meaning the row stays pending until the recovery
   * budget is exhausted and the worker escalates via `systemNotice`.
   */
  recoveryAgent?: RecoveryAgentRunner;
  /**
   * Where the pending-commits worker escalates terminal failures. Core
   * default: {@link consoleSystemNoticeSink} (stderr, no dashboard).
   * Enterprise passes its feedback service.
   */
  systemNotice?: ISystemNoticeSink;
  /**
   * Per-connection-key LLM usage metering shown on the connection-key
   * management routes. Core default: {@link unmeteredLlmUsage} (no proxy,
   * nothing to meter). Enterprise passes the LLM proxy's usage service.
   */
  usageMeter?: ILlmUsageMeter;
  /**
   * SSO login plugins the auth router mounts. Core default: `[]` (password
   * login only). The array instance is kept on `CoreServices.authProviders`,
   * so an enterprise root may pass an array it fills after construction.
   */
  authProviders?: AuthProviderPlugin[];
  /**
   * Module-owned GDPR-erasure slices run by `AccountErasureService`. Core
   * default: `[]` (core erases only the rows it owns). The array reference is
   * held — not copied — so an enterprise root may pass an array it fills after
   * construction (participants are only iterated at erasure time).
   */
  erasureParticipants?: IErasureParticipant[];
}

/**
 * Core default recovery agent: does nothing. The worker's retry ladder still
 * works — a stuck row burns its recovery budget on these no-op runs and then
 * escalates to the `systemNotice` sink, which is exactly the "no recovery
 * agent available" behavior a core-only deployment wants.
 */
export const noopRecoveryAgent: RecoveryAgentRunner = {
  async run(): Promise<void> {
    // Intentionally empty — see doc comment.
  },
};
