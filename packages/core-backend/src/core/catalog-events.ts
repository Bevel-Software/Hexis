import express, { type Request, type RequestHandler } from 'express';
import { logger } from '../shared/logging.js';
import type { ISkillService } from '../modules/skills/skills.contract.js';
import type { IToolManualService } from '../modules/tool-manuals/tool-manuals.contract.js';
import { catalogRevision } from './catalog-revision.js';
import '../modules/tool-auth/tool-auth.middleware.js'; // Express Request augmentation (req.toolAuth)

const log = logger('catalog-events');

/**
 * `GET /agent/catalog-events` — the caller's catalog fingerprint, pushed.
 *
 * The problem this solves is the one `catalog-revision.ts` describes: the
 * local `hexis-mcp` bridge holds a long-lived connection whose toolset was
 * registered ONCE, at startup, and a `.tool` or a `SKILL.md` committed on the
 * default branch is invisible there until something tells it otherwise. That
 * route answers the question; this one volunteers the answer.
 *
 * WHY A STREAM RATHER THAN A POLL. Asking costs the deployment a per-caller
 * ACL walk over every manual and every skill, and a bridge that asks on a
 * timer pays it forever: at two seconds, fifty connected laptops are
 * twenty-five of those walks a second, all day, for a catalog that changes a
 * few times a week. That cost is why the timer was taken out again, and
 * without a timer an idle connection learned nothing until its next use. A
 * stream settles both: an idle laptop holds one open socket and asks NOTHING,
 * the deployment computes a fingerprint only when a default-branch write
 * actually moved the tree, and the bridge hears about it in the same
 * millisecond instead of at its next listing.
 *
 * WHAT IT SENDS. One `revision` event when the stream opens — which is also
 * what closes the race between the bridge's startup discovery and its
 * subscription — and one more each time the caller's catalog fingerprint
 * changes. Never two in a row with the same fingerprint: the invalidation
 * signal behind it fires on ANY default-branch write (it carries no paths, by
 * design), and an ordinary note would otherwise re-register every connected
 * bridge. Same digest as `/agent/catalog-revision`, from the same two
 * services, so a client may compare the two freely.
 *
 * AUTH. Behind the same `manualAuth` as the rest of the agent surface, and it
 * tells the caller nothing `/agent/catalog-revision` does not: a digest of
 * what they may read, per-caller, ACL-filtered by the two services. Unlike
 * `/api/events`, no cookie fallback — this stream is opened by a process that
 * sets its own headers, not by a browser's `EventSource`.
 */

/** Interval between SSE keep-alive comments (ms). Same 25 s as `/api/events`,
 * for the same reason: it sits under the typical 30–100 s proxy idle timeout,
 * and ~15 bytes a minute per connection is nothing against a whole class of
 * connections silently dying behind Traefik or Cloudflare. */
export const CATALOG_EVENTS_HEARTBEAT_MS = 25_000;

/**
 * "A released catalog may have changed." One fan-out point, so the thing that
 * DROPS the catalog caches and the thing that TELLS connected bridges are the
 * same event rather than two enumerations of the same occasions that drift
 * apart. Registered by `registerCatalogCacheInvalidation`, which already owns
 * every road to that fact.
 *
 * Deliberately says nothing about WHAT changed — neither do the caches, and a
 * subscriber that needs to know re-reads its own fingerprint.
 */
export interface CatalogChangeSignal {
  /** Tell every subscriber. Never throws: a listener that does is logged and the rest still run. */
  notify(): void;
  /** Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createCatalogChangeSignal(): CatalogChangeSignal {
  const listeners = new Set<() => void>();
  return {
    notify(): void {
      // Copied before iterating: a listener that unsubscribes itself while
      // being called would otherwise mutate the set mid-walk.
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (err) {
          // One bridge's stream must not cost every other subscriber — or the
          // write that emitted the event — its notification.
          log.error('a catalog-change listener threw:', { err });
        }
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createCatalogEventsRoutes(deps: {
  toolManuals: Pick<IToolManualService, 'catalogFingerprints'>;
  skills: Pick<ISkillService, 'listSkills'>;
  manualAuth: RequestHandler;
  /** Connection-key/internal-token user id → email, for the per-caller ACL. */
  resolveUserEmail: (userId: string) => Promise<string | undefined>;
  changes: Pick<CatalogChangeSignal, 'subscribe'>;
  /** Overridable so a test does not wait 25 s to see a keep-alive. */
  heartbeatMs?: number;
}): express.Router {
  const router = express.Router();
  const heartbeatMs = deps.heartbeatMs ?? CATALOG_EVENTS_HEARTBEAT_MS;

  router.get('/agent/catalog-events', deps.manualAuth, (req: Request, res) => {
    const userId = req.toolAuth?.userId;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx would otherwise batch the writes behind a flush boundary, which
    // is the whole latency this route exists to remove.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    /** The last fingerprint written, so an unchanged catalog sends nothing. */
    let sent: string | null = null;
    /** A read is in flight; `again` collapses the burst behind it onto one re-read. */
    let reading = false;
    let again = false;

    const readRevision = async (): Promise<string> => {
      // No resolvable caller is an EMPTY catalog, not a failure — exactly as
      // `/agent/catalog-revision` answers one, so the two never disagree.
      const email = userId ? await deps.resolveUserEmail(userId).catch(() => undefined) : undefined;
      const [manuals, skills] = email
        ? await Promise.all([deps.toolManuals.catalogFingerprints(email), deps.skills.listSkills(email)])
        : [[], []];
      return catalogRevision(manuals, skills);
    };

    /**
     * Read the caller's fingerprint and write it if it moved.
     *
     * Collapsed, because one landing change is several signals: a merge
     * emits `fs-tree-changed` per workspace it rewrote, a bulk write emits
     * one per batch, and a per-caller ACL walk per signal is precisely the
     * cost this route was built to avoid. A signal arriving while a read is
     * in flight sets `again` and the loop re-reads once — never a queue of
     * reads, however long the burst.
     */
    const publish = async (): Promise<void> => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          if (closed) return;
          let revision: string;
          try {
            revision = await readRevision();
          } catch (err) {
            // Survivable: the subscription stays, and the next signal — or
            // the client's own `/agent/catalog-revision` read on its next
            // activity — settles what this attempt could not.
            log.error('catalog-events could not read the catalog:', { err });
            return;
          }
          if (closed || revision === sent) continue;
          sent = revision;
          res.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
        } while (again);
      } catch (err) {
        // A write into a response whose socket has just gone is the case this
        // is for. Unhandled it would be a process-level rejection raised by a
        // laptop closing its lid.
        log.error('catalog-events could not write to a stream:', { err });
      } finally {
        reading = false;
      }
    };

    const off = deps.changes.subscribe(() => {
      void publish();
    });
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(':\n\n');
      } catch {
        // Same reason as above: a socket that went away between the close
        // handler and this tick must not throw out of a timer callback, which
        // is an uncaught exception rather than a rejected promise.
      }
    }, heartbeatMs);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      off();
      clearInterval(heartbeat);
    };
    // Both, because which one fires first depends on how the peer went away
    // (a clean hang-up, a dropped socket, a proxy timing it out) and a
    // subscription left behind would write to a dead response forever.
    req.on('close', cleanup);
    res.on('close', cleanup);

    // The OPENING revision, sent before anything can have changed: a bridge
    // that discovered its toolset a moment ago compares this against what it
    // registered, so a commit that landed inside that gap is picked up here
    // rather than waiting for the NEXT commit to move the catalog again.
    void publish();
  });

  return router;
}
