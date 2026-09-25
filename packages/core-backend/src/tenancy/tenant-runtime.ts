import type { Express } from 'express';
import { createCoreServices, type CoreServices } from '../core/create-core-services.js';
import { createCoreServer } from '../core/create-core-server.js';
import { stopCore } from '../core/lifecycle.js';
import { logger } from '../shared/logging.js';
import type { TenantDescriptor } from './tenant-source.contract.js';

const log = logger('tenancy');

/** A tenant's running graph: its services and the Express app that serves them. */
export interface TenantGraph {
  core: CoreServices;
  app: Express;
}

export type TenantState = 'idle' | 'activating' | 'active' | 'evicting';

/** The lifecycle seams, so a suite can drive a runtime without a database. */
export interface TenantRuntimeDeps {
  /** Build and start the graph. Default: `createCoreServices` + `createCoreServer`. */
  activate?: (descriptor: TenantDescriptor) => Promise<TenantGraph>;
  /** Stop a graph. Default: `stopCore`. */
  stop?: (graph: TenantGraph) => Promise<void>;
  /** Whether the graph has work in flight that an eviction would strand. Default: queued commits. */
  busy?: (graph: TenantGraph) => Promise<boolean>;
  now?: () => number;
}

/**
 * How a tenant's graph is built with the composition root as a distribution
 * calls it, plus the one thing a host must say: no mirroring onto the shared
 * package's process-wide bindings, since this process has several graphs and
 * no single value to put there.
 */
async function activateWithCore(descriptor: TenantDescriptor): Promise<TenantGraph> {
  const core = await createCoreServices(descriptor.config, { ...descriptor.ports, mirrorSharedBindings: false });
  try {
    // No static dir: the host serves the SPA once, for every tenant.
    const app = await createCoreServer(core, descriptor.extensions ?? {}, {});
    return { core, app };
  } catch (err) {
    // A graph whose boot failed still holds a pool and a lease.
    await stopCore(core).catch(() => undefined);
    throw err;
  }
}

async function queuedCommits(graph: TenantGraph): Promise<boolean> {
  return (await graph.core.pendingCommitsService.oldestQueuedAt()) !== null;
}

/**
 * One tenant's graph, brought up on first use and stopped when the host
 * says so: `idle → activating → active → evicting → idle`.
 *
 * ACTIVATE ONCE. Requests arriving while the graph is being built all await
 * the one activation in flight; a failed activation is forgotten, so the
 * next request tries again rather than serving the failure forever (the
 * remote may be back, the schema may have been created). An eviction that
 * lands mid-activation waits for the activation and then stops what it
 * produced, so a graph is never left running behind an evicted runtime.
 */
export class TenantRuntime {
  private graph: TenantGraph | null = null;
  private activation: Promise<TenantGraph> | null = null;
  private eviction: Promise<void> | null = null;
  private lastUsedAt: number;
  private readonly activate: (descriptor: TenantDescriptor) => Promise<TenantGraph>;
  private readonly stopGraph: (graph: TenantGraph) => Promise<void>;
  private readonly isBusy: (graph: TenantGraph) => Promise<boolean>;
  private readonly now: () => number;

  constructor(
    readonly descriptor: TenantDescriptor,
    deps: TenantRuntimeDeps = {},
  ) {
    this.activate = deps.activate ?? activateWithCore;
    this.stopGraph = deps.stop ?? ((graph) => stopCore(graph.core));
    this.isBusy = deps.busy ?? queuedCommits;
    this.now = deps.now ?? Date.now;
    this.lastUsedAt = this.now();
  }

  get slug(): string {
    return this.descriptor.slug;
  }

  get state(): TenantState {
    if (this.eviction) return 'evicting';
    if (this.graph) return 'active';
    if (this.activation) return 'activating';
    return 'idle';
  }

  /** Milliseconds since a request last touched this tenant. */
  idleFor(): number {
    return this.now() - this.lastUsedAt;
  }

  /**
   * The graph, built if it is not running. Every caller of a concurrent
   * first burst gets the same promise; a caller that arrives during an
   * eviction waits for it, then starts the graph afresh.
   */
  async handle(): Promise<TenantGraph> {
    this.lastUsedAt = this.now();
    if (this.eviction) await this.eviction;
    if (this.graph) return this.graph;
    this.activation ??= this.activate(this.descriptor).then(
      (graph) => {
        this.graph = graph;
        this.activation = null;
        log.info(`tenant "${this.slug}" activated`);
        return graph;
      },
      (err: unknown) => {
        this.activation = null;
        log.error(`tenant "${this.slug}" failed to activate:`, { err });
        throw err;
      },
    );
    return this.activation;
  }

  /** Whether the graph has work an eviction would strand. False when nothing runs. */
  async busy(): Promise<boolean> {
    return this.graph ? this.isBusy(this.graph) : false;
  }

  /**
   * Stop the graph, if one runs or is being built. Idempotent: a second call
   * joins the eviction under way. Afterwards the runtime is idle and the
   * next {@link handle} builds a fresh graph.
   */
  evict(): Promise<void> {
    if (this.eviction) return this.eviction;
    const eviction = (async () => {
      if (this.activation) {
        // Whatever the build produces is stopped; a build that fails has
        // stopped its own graph already.
        await this.activation.catch(() => undefined);
      }
      const graph = this.graph;
      this.graph = null;
      if (graph) {
        await this.stopGraph(graph);
        log.info(`tenant "${this.slug}" evicted`);
      }
    })();
    // Assigned, then cleared by identity: an eviction with nothing to stop
    // settles before this line runs, and a `finally` inside it would have
    // cleared a field that was not yet set — leaving the settled promise
    // in place as an eviction forever under way.
    this.eviction = eviction;
    void eviction.finally(() => {
      if (this.eviction === eviction) this.eviction = null;
    });
    return eviction;
  }
}
