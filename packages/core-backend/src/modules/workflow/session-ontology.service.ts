/**
 * Ontology-session boundary — the touched-set store (Postgres + cache).
 *
 * Each session accumulates the SET of named ontologies it has touched. The gate
 * calls `checkOperation` for every gated agent tool call:
 *
 *   READ  (isWrite=false) → always allowed; RECORD the touched ontology so it
 *                           can poison later writes.
 *   WRITE (isWrite=true)  → allowed only while the session is confined to a
 *                           single named ontology equal to the target; once the
 *                           session has touched ≥2 ontologies, every write is
 *                           blocked. An allowed write also records its ontology.
 *
 * Neutral operations (`ontologyOf` → null) never record and never block.
 *
 * ┌── checkOperation(sessionId, wsPath, isWrite) ───────────────────────────┐
 * │  ont = ontologyOf(wsPath)                                                │
 * │  ont === null → { allow:true } (neutral; no record)                      │
 * │  touched = loadTouched(sessionId)  (cache, else SELECT)                  │
 * │  WRITE → decideWrite(touched, ont); if blocked, return block (no record) │
 * │  record(sessionId, ont)  (idempotent INSERT; update cache)              │
 * │  return { allow:true }                                                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Postgres is the source of truth so the boundary survives a backend restart.
 * The cache holds each session's touched set; a miss re-reads PG. See
 * `docs/rp4-ontology-boundary-plan-v2.md`.
 *
 * Eviction: `delete(sessionId)` at run end is the PRIMARY reclamation;
 * `sweepOlderThan` is the abandoned-run backstop; the MCP layer also calls
 * `delete` from its `onEvict` hook.
 */

import { eq, lt } from 'drizzle-orm';
import { ontologyOf } from '../../shared/kb-layout.js';

import type { Database } from '../database/connection.js';
import { sessionOntologyTouches } from '../database/schema.js';
import { recordTouch, decideWrite, type WriteDecision } from './session-ontology.policy.js';
import { WorkspaceMutex } from '../kb-fs/mutex.js';

export type OperationDecision =
  | { allow: true; touched: string[] }
  | { allow: false; reason: 'multi-ontology' | 'different-ontology'; touched: string[]; attempted: string };

export interface ISessionOntologyService {
  /**
   * Evaluate and record a gated agent operation. Reads always allow (and
   * record); writes allow only while confined to a single ontology. Neutral
   * paths always allow and record nothing.
   */
  checkOperation(sessionId: string, wsPath: string, isWrite: boolean, kbDirName?: string): Promise<OperationDecision>;
  /** Evaluate/record against an already-resolved ontology (used by graph tools). */
  checkOntology(sessionId: string, ontology: string | null, isWrite: boolean): Promise<OperationDecision>;
  /** The set of ontologies a session has touched. */
  getTouched(sessionId: string): Promise<string[]>;
  /** Reclaim a session's touched set (run end / MCP onEvict). */
  delete(sessionId: string): Promise<void>;
  /** Backstop: drop touch rows older than `cutoff` (abandoned runs). */
  sweepOlderThan(cutoff: Date): Promise<number>;
}

export class SessionOntologyService implements ISessionOntologyService {
  /**
   * Write-through cache of each session's touched-ontology set. A present entry
   * is authoritative for the session (we only ever add to it in-process); a
   * miss re-reads Postgres. Keyed by the agent thread / sessionId.
   */
  private readonly cache = new Map<string, Set<string>>();

  /**
   * Serializes each session's read→decide→record path. Without it, two
   * concurrent same-session writes (parallel tool calls in one turn) could both
   * observe a singleton/empty touched set and both be allowed to different
   * ontologies before either INSERT lands — defeating the boundary. Different
   * sessions never contend.
   */
  private readonly locks = new WorkspaceMutex();

  constructor(private readonly db: Database) {}

  /**
   * Resolve `wsPath` to its ontology and evaluate/record the operation. Thin
   * wrapper over {@link checkOntology} for the common path-based call site.
   */
  async checkOperation(
    sessionId: string,
    wsPath: string,
    isWrite: boolean,
    kbDirName?: string,
  ): Promise<OperationDecision> {
    return this.checkOntology(sessionId, ontologyOf(wsPath, kbDirName), isWrite);
  }

  /**
   * Evaluate (and, when allowed, record) an operation against an
   * already-resolved ontology. Neutral ops always allow and record nothing;
   * reads always allow and record; writes allow only while the session stays
   * confined to the single target ontology (see {@link decideWrite}). A blocked
   * write records nothing.
   */
  async checkOntology(sessionId: string, ontology: string | null, isWrite: boolean): Promise<OperationDecision> {
    // Neutral operation: always allowed, records nothing. No state mutation, so
    // it needs no per-session serialization.
    if (ontology === null) {
      const touched = await this.loadTouched(sessionId);
      return { allow: true, touched: [...touched].sort() };
    }

    // Serialize the decide+record path per session so concurrent same-session
    // operations can't both pass the boundary on a stale touched set.
    return this.locks.run(sessionId, async () => {
      const touched = await this.loadTouched(sessionId);

      if (isWrite) {
        const decision: WriteDecision = decideWrite(touched, ontology);
        if (!decision.allow) {
          return {
            allow: false,
            reason: decision.reason,
            touched: decision.touched,
            attempted: decision.attempted,
          };
        }
      }

      // Allowed (read, or a write confined to one ontology): record the touch.
      await this.record(sessionId, ontology, touched);
      return { allow: true, touched: [...recordTouch(touched, ontology)].sort() };
    });
  }

  /** The sorted set of named ontologies this session has touched so far. */
  async getTouched(sessionId: string): Promise<string[]> {
    return [...(await this.loadTouched(sessionId))].sort();
  }

  /** Reclaim a session's touched set from both the cache and Postgres (run end / MCP onEvict). */
  async delete(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    await this.db.delete(sessionOntologyTouches).where(eq(sessionOntologyTouches.sessionId, sessionId));
  }

  /** Backstop sweep: drop touch rows older than `cutoff` (abandoned runs) and return how many were removed. */
  async sweepOlderThan(cutoff: Date): Promise<number> {
    const removed = await this.db
      .delete(sessionOntologyTouches)
      .where(lt(sessionOntologyTouches.touchedAt, cutoff))
      .returning({ sessionId: sessionOntologyTouches.sessionId });
    // A swept session may have other (newer) rows; drop its cache entry so the
    // next op re-reads the authoritative remaining set from Postgres.
    for (const r of removed) this.cache.delete(r.sessionId);
    return removed.length;
  }

  /** Load a session's touched set from cache, else from Postgres (and cache it). */
  private async loadTouched(sessionId: string): Promise<Set<string>> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const rows = await this.db
      .select({ ontology: sessionOntologyTouches.ontology })
      .from(sessionOntologyTouches)
      .where(eq(sessionOntologyTouches.sessionId, sessionId));
    const set = new Set(rows.map((r) => r.ontology));
    this.cache.set(sessionId, set);
    return set;
  }

  /** Record a touched ontology (idempotent) and update the cache. */
  private async record(sessionId: string, ontology: string, current: Set<string>): Promise<void> {
    if (current.has(ontology)) return; // already recorded; no DB write needed
    await this.db
      .insert(sessionOntologyTouches)
      .values({ sessionId, ontology })
      .onConflictDoNothing({ target: [sessionOntologyTouches.sessionId, sessionOntologyTouches.ontology] });
    current.add(ontology);
  }
}
