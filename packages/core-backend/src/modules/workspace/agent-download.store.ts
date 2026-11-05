import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logging.js';

const log = logger('agent-downloads');

/** How long an issued link, and the bytes behind it, stay usable. */
export const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** How often the store looks for links that have expired. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * How long past its expiry a fetch that is still SENDING keeps its bytes.
 *
 * A link fetched a moment before it expires may take longer than the moment
 * to send a large file. Its bytes are being read right now, so the sweep
 * leaves them alone — but only for this long: a response that has neither
 * finished nor failed within it belongs to a process that died, and the
 * record is in memory, so there is no third possibility.
 */
const SEND_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * THE one refusal for every way a download link can fail to be usable: it was
 * never issued, it has already been fetched, it has expired, or it belongs to
 * somebody else. One sentence for all four, for the reason the upload token
 * gives (`UPLOAD_TOKEN_REFUSAL`): the token is the whole credential the route
 * has, and an answer that told the cases apart would let a guesser learn which
 * guesses exist.
 */
export const DOWNLOAD_TOKEN_REFUSAL =
  'That download link cannot be used: it is unknown, already fetched, expired, or was issued to someone else. ' +
  'Call `request_file_download` for a new one.';

/**
 * How many download REQUESTS one user may hold open at once — however many
 * links each carries. A request with forty files and two folders is one.
 *
 * A request is permission to keep up to the whole download limit on the
 * deployment's disk for a TTL; without a bound, one caller asks for a hundred.
 */
export const MAX_OPEN_DOWNLOADS_PER_USER = 10;

/** A refusal with the HTTP status the download route and the tool both answer. */
export class DownloadTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DownloadTokenError';
  }
}

/** One thing a link serves: a file's bytes, or a folder's zip. */
export interface DownloadArtifact {
  /** The bytes, captured when the request was made. */
  data: Buffer;
  /** The `Content-Type` the link answers with. */
  contentType: string;
  /** The name the attachment is saved under. */
  filename: string;
}

/** What the `issue` {@link AgentDownloadStore.withRequestSlot} hands its work answers: one link per artifact, in order, and the terms. */
export interface IssuedDownload {
  /** One absolute URL per artifact, in the order the artifacts were given. */
  downloadUrls: string[];
  /** ISO-8601 instant after which every link of the request, and its bytes, are gone. */
  expiresAt: string;
  /** Seconds from now until `expiresAt`, so a caller need not parse the date. */
  expiresInSeconds: number;
}

/** A link being fetched: what to send, and how. */
export interface ClaimedDownload {
  /** Absolute path of the stored bytes — OUTSIDE every workspace. */
  absolutePath: string;
  contentType: string;
  filename: string;
  bytes: number;
}

interface ArtifactRecord {
  requestId: string;
  /** The file name under the request's directory. Never derived from a path or a name. */
  file: string;
  contentType: string;
  filename: string;
  bytes: number;
  /** Set by the fetch that took it: a link answers once. */
  claimedAt?: number;
}

interface RequestRecord {
  id: string;
  userId: string;
  expiresAt: number;
  /** Token hashes of the artifacts not yet fetched to the end. */
  pending: Set<string>;
}

export interface AgentDownloadStoreOptions {
  /** Directory the bytes are written to. A sibling of `workspacesRoot`, never inside one. */
  root: string;
  /** Absolute base URL of this deployment's API, e.g. `https://core.example.com`. */
  publicBaseUrl: string;
  /** Token prefix, so a leaked credential can be recognised by shape. */
  tokenPrefix?: string;
  ttlMs?: number;
  /** How many requests one user may hold open at once. Defaults to {@link MAX_OPEN_DOWNLOADS_PER_USER}. */
  maxOpenPerUser?: number;
}

/**
 * The download links an agent takes files OUT of the knowledge base by — the
 * twin of the upload store (`agent-upload.store.ts`), and built on the same
 * three properties, because the download route is likewise authenticated by
 * a token alone:
 *
 *  - **Unguessable.** 32 random bytes, base64url, per link.
 *  - **Never stored in the clear.** Records are keyed by the token's SHA-256.
 *  - **Bound and single-use.** A link answers ONE fetch; a second, an expired
 *    one and an unknown one all meet {@link DOWNLOAD_TOKEN_REFUSAL}.
 *
 * The bytes are captured at request time (by `request_file_download`, which
 * judges every file before it gets here) and written under `root/<request>/` —
 * a directory beside the workspaces root, which no file tool can name. A link
 * fetched has its bytes deleted once the response ends, however it ends; a
 * link nobody fetched is deleted when it expires.
 */
/**
 * The download store as its consumers see it — the port the tool, the
 * download routes and the lifecycle depend on, so a deployment may substitute
 * its own keeper of one-time links.
 */
export interface IAgentDownloadStore {
  /** The absolute address a token's link is fetched at. */
  downloadUrlFor(token: string): string;
  /** Refuse, with the cap's sentence, when `user` holds the most requests allowed. */
  assertCanIssue(user: { id: string }): void;
  /** Take one of `user`'s request slots and run `work` in their turn — see the class. */
  withRequestSlot<T>(
    user: { id: string },
    work: (issue: (items: DownloadArtifact[]) => Promise<IssuedDownload>) => Promise<T>,
  ): Promise<T>;
  /** Take `token`'s link for ONE fetch and answer what to send. */
  claim(token: string, fetcherIds?: readonly string[]): ClaimedDownload;
  /** A fetch is over: the link's bytes are gone. Idempotent. */
  finish(token: string): Promise<void>;
  /** How many requests `userId` holds open. */
  openRequestsOf(userId: string): number;
  /** Delete every expired request and every orphaned directory, once. */
  sweepNow(): Promise<void>;
  /** Sweep now, and keep sweeping. */
  startSweeping(intervalMs?: number): void;
  /** Stop the sweeps. */
  stopSweeping(): void;
  /** Wait for a sweep in flight, so a root can be torn down after it. */
  drainSweep(): Promise<void>;
}

export class AgentDownloadStore implements IAgentDownloadStore {
  /** Token hash → the one artifact that link serves. */
  private readonly artifacts = new Map<string, ArtifactRecord>();
  /** Request id → the request its links belong to. */
  private readonly requests = new Map<string, RequestRecord>();
  /** Per user, the request in flight — see {@link withRequestSlot}. */
  private readonly building = new Map<string, Promise<unknown>>();
  /** Per user, slots held by calls still waiting, building or writing — counted as open. */
  private readonly reserved = new Map<string, number>();
  /**
   * Request ids whose bytes are being written right now: named in no map yet,
   * and not the sweep's to reclaim. Entered before the first write and left
   * once the request is recorded or its directory removed.
   */
  private readonly writing = new Set<string>();
  /** The users whose turn the current async context is running in — see {@link withRequestSlot}. */
  private readonly inTurn = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly root: string;
  private readonly publicBaseUrl: string;
  private readonly tokenPrefix: string;
  private readonly ttlMs: number;
  private readonly maxOpenPerUser: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<void> | null = null;
  private stopped = false;

  constructor(options: AgentDownloadStoreOptions) {
    this.root = options.root;
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.tokenPrefix = options.tokenPrefix ?? '';
    this.ttlMs = options.ttlMs ?? DOWNLOAD_TOKEN_TTL_MS;
    this.maxOpenPerUser = options.maxOpenPerUser ?? MAX_OPEN_DOWNLOADS_PER_USER;
  }

  /** The URL a link's bytes are fetched from. The one spelling of this route's address. */
  downloadUrlFor(token: string): string {
    return `${this.publicBaseUrl}/api/agent/downloads/${encodeURIComponent(token)}`;
  }

  /**
   * Refuse `user` a new request when they already hold the most one user may
   * — issued requests and slots still being filled alike.
   */
  assertCanIssue(user: { id: string }): void {
    const open = this.openRequestsOf(user.id);
    if (open >= this.maxOpenPerUser) {
      throw new DownloadTokenError(
        `You already hold ${open} open download requests, the most one user may have at once. Fetch their links, ` +
          'or wait for them to expire, then ask again. One request carries any number of files and folders.',
        429,
      );
    }
  }

  /**
   * Take one of `user`'s request slots, then run `work` after any request of
   * theirs already running; `work` is handed the `issue` that fills the slot.
   *
   * The slot is taken AT ONCE, before the turn is waited for, and counts as an
   * open request until `work` ends: a caller at the cap is refused before the
   * server spends a zip's worth of work on it, and ten calls in parallel cannot
   * all pass the count and then all build. A call that ends without issuing
   * (nothing included, a refusal, a failure) gives its slot back.
   *
   * The build AND the write of its bytes run in the turn: a build reads every
   * included file into memory and may zip up to the download limit, so one
   * request at a time per user bounds what one caller can make the process
   * hold or the disk stage. Different users do not wait on each other.
   *
   * The ONE way a request is issued: there is no public `issue` to call on
   * the side. `work`'s `issue` fills the slot once — a second call would be
   * a second request on one slot, past the cap — and a `withRequestSlot` for
   * the same user from inside `work` throws rather than wait for the turn it
   * is itself holding, which would never come.
   */
  async withRequestSlot<T>(
    user: { id: string },
    work: (issue: (items: DownloadArtifact[]) => Promise<IssuedDownload>) => Promise<T>,
  ): Promise<T> {
    const held = this.inTurn.getStore();
    if (held?.has(user.id)) {
      throw new Error('A download request slot was asked for inside one already held for the same user.');
    }
    this.assertCanIssue(user);
    this.reserved.set(user.id, (this.reserved.get(user.id) ?? 0) + 1);
    // Once the request is recorded, the record is what counts as open and the
    // reservation is given back by `write` — not here as well, which would
    // count the request twice while `work` finishes.
    let issued = false;
    try {
      const issue = (items: DownloadArtifact[]): Promise<IssuedDownload> => {
        if (issued) return Promise.reject(new Error('A download request slot issues once.'));
        issued = true;
        return this.write(user, items);
      };
      const turn = new Set(held ?? []).add(user.id);
      const before = this.building.get(user.id) ?? Promise.resolve();
      const mine = before.catch(() => undefined).then(() => this.inTurn.run(turn, () => work(issue)));
      this.building.set(user.id, mine);
      try {
        return await mine;
      } finally {
        if (this.building.get(user.id) === mine) this.building.delete(user.id);
      }
    } finally {
      if (!issued) this.releaseReservation(user.id);
    }
  }

  /** Give back one of `userId`'s reserved slots. */
  private releaseReservation(userId: string): void {
    const left = (this.reserved.get(userId) ?? 1) - 1;
    if (left > 0) this.reserved.set(userId, left);
    else this.reserved.delete(userId);
  }

  /**
   * Store every artifact of one request and answer a link per artifact, all
   * sharing the request's expiry, within a slot already held: the slot is the
   * capacity check. Nothing is issued unless every artifact is on disk: a
   * request whose bytes could not all be written leaves nothing.
   */
  private async write(user: { id: string }, items: DownloadArtifact[]): Promise<IssuedDownload> {
    if (items.length === 0) throw new Error('A download request must carry at least one artifact.');
    const requestId = `download-${Date.now()}-${randomBytes(8).toString('hex')}`;
    const dir = path.join(this.root, requestId);
    const minted: { key: string; token: string; record: ArtifactRecord }[] = [];
    // Reserved BEFORE the first filesystem await: a sweep running while a slow
    // disk takes these writes would otherwise find a directory no request
    // names and, past the age bound, reclaim it under the write.
    this.writing.add(requestId);
    try {
      await fs.mkdir(dir, { recursive: true });
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const file = String(i);
        await fs.writeFile(path.join(dir, file), item.data);
        const token = this.tokenPrefix + randomBytes(32).toString('base64url');
        minted.push({
          key: hash(token),
          token,
          record: {
            requestId,
            file,
            contentType: item.contentType,
            filename: item.filename,
            bytes: item.data.byteLength,
          },
        });
      }
    } catch (err) {
      try {
        await this.removeDir(requestId);
      } finally {
        this.writing.delete(requestId);
        // Nothing issued: the slot goes back here, since `withRequestSlot`
        // treats an `issue` that was called as one that filled its slot.
        this.releaseReservation(user.id);
      }
      throw err;
    }
    // The TTL runs from the moment the links exist, not from when the build
    // started: a 500 MB build must not hand out links with minutes already gone.
    const expiresAt = Date.now() + this.ttlMs;
    const request: RequestRecord = { id: requestId, userId: user.id, expiresAt, pending: new Set() };
    for (const { key, record } of minted) {
      this.artifacts.set(key, record);
      request.pending.add(key);
    }
    this.requests.set(requestId, request);
    this.writing.delete(requestId);
    // The record counts as open from here; the reservation that held the
    // place until now is given back, so the request is counted once.
    this.releaseReservation(user.id);
    // AFTER the records exist: the first sweep runs at once and would
    // otherwise take this request's directory for an orphan. And never once
    // the store is stopped: a request finishing after shutdown's
    // `stopSweeping` must not re-arm the sweeper that was stopped for good.
    if (!this.stopped) this.startSweeping();
    return {
      downloadUrls: minted.map((m) => this.downloadUrlFor(m.token)),
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: Math.round(this.ttlMs / 1000),
    };
  }

  /**
   * Take `token`'s link for ONE fetch and answer what to send. Spent the
   * moment it is claimed, before a byte goes out: a second fetch arriving
   * while the first is still sending is refused, not served twice.
   *
   * `fetcherIds` are the users the fetch identified itself as, by every
   * credential it carried — usually none. The link works for anyone holding
   * it — an agent's `curl` carries no session — but a fetch that says it is
   * SOMEONE ELSE, by any of its credentials, is refused: that user holds a
   * link issued to another.
   */
  claim(token: string, fetcherIds: readonly string[] = []): ClaimedDownload {
    const key = hash(token);
    const record = this.artifacts.get(key);
    if (!record || record.claimedAt !== undefined) throw refusal();
    const request = this.requests.get(record.requestId);
    if (!request) throw refusal();
    if (request.expiresAt <= Date.now()) {
      void this.forget(key);
      throw refusal();
    }
    if (fetcherIds.some((id) => id !== request.userId)) throw refusal();
    record.claimedAt = Date.now();
    return {
      absolutePath: path.join(this.root, record.requestId, record.file),
      contentType: record.contentType,
      filename: record.filename,
      bytes: record.bytes,
    };
  }

  /**
   * The fetch of `token` has ended — sent in full, failed, or the client went
   * away. The bytes go either way: a link answers once, so nothing will ever
   * read them again. Idempotent.
   */
  async finish(token: string): Promise<void> {
    const key = hash(token);
    const record = this.artifacts.get(key);
    if (!record) return;
    await this.forget(key);
  }

  /**
   * How many requests `userId` holds open: unexpired with a link unfetched, or
   * with a fetch still sending — and the slots of calls still under way.
   */
  openRequestsOf(userId: string): number {
    const now = Date.now();
    let open = this.reserved.get(userId) ?? 0;
    for (const request of this.requests.values()) {
      if (request.userId !== userId) continue;
      if (request.expiresAt > now || this.sending(request, now)) open += 1;
    }
    return open;
  }

  /**
   * Delete every request whose links have expired, with its bytes — then any
   * directory in the root that no live request names and that has outlived
   * every link that could name it (a process killed between issue and fetch
   * leaves one no map will ever mention again; by AGE, because during a
   * restart two processes share the root, as the upload store explains).
   */
  async sweepNow(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const request of [...this.requests.values()]) {
      if (request.expiresAt > now) continue;
      if (this.sending(request, now)) continue;
      await this.dropRequest(request);
    }
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return; // root not created yet — nothing to reclaim
    }
    // Read AFTER the listing, so a request issued while it was read is named.
    const live = new Set(this.requests.keys());
    for (const name of names) {
      if (this.stopped) return;
      if (live.has(name) || this.writing.has(name)) continue;
      if (await this.outlivedEveryLink(name, now)) await this.removeDir(name);
    }
  }

  /** Sweep now, and keep sweeping. Started by the first request issued; idempotent; `unref`'d. */
  startSweeping(intervalMs: number = SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.stopped = false;
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stop sweeping for good — see `AgentUploadStore.stopSweeping` for why a stopped graph must. */
  stopSweeping(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Wait for the sweep in flight, if any. Pairs with {@link stopSweeping} on shutdown. */
  async drainSweep(): Promise<void> {
    await this.sweeping;
  }

  private sweep(): void {
    // One sweep at a time: a second starting while the first still deletes
    // would make `drainSweep` wait for the newer and miss the older.
    if (this.sweeping) return;
    const running = this.sweepNow()
      .catch((err: unknown) => {
        log.warn('could not sweep expired downloads:', { err });
      })
      .finally(() => {
        if (this.sweeping === running) this.sweeping = null;
      });
    this.sweeping = running;
  }

  /** Whether a fetch of one of `request`'s links is still sending, within its grace. */
  private sending(request: RequestRecord, now: number): boolean {
    for (const key of request.pending) {
      const claimedAt = this.artifacts.get(key)?.claimedAt;
      if (claimedAt !== undefined && now - claimedAt < SEND_GRACE_MS) return true;
    }
    return false;
  }

  /** Drop one artifact's link and bytes; the request goes with its last one. */
  private async forget(key: string): Promise<void> {
    const record = this.artifacts.get(key);
    if (!record) return;
    this.artifacts.delete(key);
    const request = this.requests.get(record.requestId);
    request?.pending.delete(key);
    if (request && request.pending.size === 0) {
      this.requests.delete(request.id);
      await this.removeDir(request.id);
      return;
    }
    try {
      await fs.rm(path.join(this.root, record.requestId, record.file), { force: true });
    } catch (err) {
      log.warn(`could not delete a fetched download of "${record.requestId}":`, { err });
    }
  }

  private async dropRequest(request: RequestRecord): Promise<void> {
    for (const key of request.pending) this.artifacts.delete(key);
    this.requests.delete(request.id);
    await this.removeDir(request.id);
  }

  private async outlivedEveryLink(name: string, now: number): Promise<boolean> {
    try {
      const { mtimeMs } = await fs.stat(path.join(this.root, name));
      return now - mtimeMs > this.ttlMs + SEND_GRACE_MS;
    } catch {
      return false;
    }
  }

  /** Best-effort delete of one request's directory. Never throws. */
  private async removeDir(id: string): Promise<void> {
    try {
      await fs.rm(path.join(this.root, id), { recursive: true, force: true });
    } catch (err) {
      log.warn(`could not delete the stored download "${id}":`, { err });
    }
  }
}

function refusal(): DownloadTokenError {
  return new DownloadTokenError(DOWNLOAD_TOKEN_REFUSAL, 404);
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
