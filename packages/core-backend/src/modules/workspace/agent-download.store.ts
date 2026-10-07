import { createHash, randomBytes } from 'node:crypto';
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

/** What {@link AgentDownloadStore.issue} answers: one link per artifact, in order, and the terms. */
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
export class AgentDownloadStore {
  /** Token hash → the one artifact that link serves. */
  private readonly artifacts = new Map<string, ArtifactRecord>();
  /** Request id → the request its links belong to. */
  private readonly requests = new Map<string, RequestRecord>();
  /** Per user, the build in flight — see {@link withBuildTurn}. */
  private readonly building = new Map<string, Promise<unknown>>();
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
   * Refuse `user` a new request when they already hold the most one user may.
   * Asked BEFORE anything is read or built, so a caller at the cap is told so
   * without the server spending a zip's worth of work on an answer it would
   * then throw away; {@link issue} asks again, because builds take time.
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
   * Run `build` for `userId` after any build of theirs already running.
   *
   * A build reads every included file into memory and may zip up to the whole
   * download limit; ten requests in parallel from one caller would be ten
   * such builds at once. One at a time per user bounds what one caller can
   * make the process hold; different users do not wait on each other.
   */
  async withBuildTurn<T>(userId: string, build: () => Promise<T>): Promise<T> {
    const before = this.building.get(userId) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(build);
    this.building.set(userId, mine);
    try {
      return await mine;
    } finally {
      if (this.building.get(userId) === mine) this.building.delete(userId);
    }
  }

  /**
   * Store every artifact of one request and answer a link per artifact, all
   * sharing the request's expiry. Nothing is issued unless every artifact is
   * on disk: a request whose bytes could not all be written leaves nothing.
   */
  async issue(user: { id: string }, items: DownloadArtifact[]): Promise<IssuedDownload> {
    if (items.length === 0) throw new Error('A download request must carry at least one artifact.');
    this.assertCanIssue(user);
    const requestId = `download-${Date.now()}-${randomBytes(8).toString('hex')}`;
    const dir = path.join(this.root, requestId);
    const minted: { key: string; token: string; record: ArtifactRecord }[] = [];
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
      await this.removeDir(requestId);
      throw err;
    }
    // Counted again, now that the bytes are down: another request of this
    // user's may have been issued while these were written.
    try {
      this.assertCanIssue(user);
    } catch (err) {
      await this.removeDir(requestId);
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
    // AFTER the records exist: the first sweep runs at once and would
    // otherwise take this request's directory for an orphan.
    this.startSweeping();
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
   * `fetcherId` is the user the fetch identified itself as, when it carried a
   * credential at all. The link works for anyone holding it — an agent's
   * `curl` carries no session — but a fetch that says it is SOMEONE ELSE is
   * refused: that user holds a link issued to another.
   */
  claim(token: string, fetcherId?: string | null): ClaimedDownload {
    const key = hash(token);
    const record = this.artifacts.get(key);
    if (!record || record.claimedAt !== undefined) throw refusal();
    const request = this.requests.get(record.requestId);
    if (!request) throw refusal();
    if (request.expiresAt <= Date.now()) {
      void this.forget(key);
      throw refusal();
    }
    if (fetcherId && fetcherId !== request.userId) throw refusal();
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

  /** How many requests `userId` holds open: unexpired with a link unfetched, or with a fetch still sending. */
  openRequestsOf(userId: string): number {
    const now = Date.now();
    let open = 0;
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
      if (live.has(name)) continue;
      if (await this.outlivedEveryLink(name, now)) await this.removeDir(name);
    }
  }

  /** Sweep now, and keep sweeping. Started by the first {@link issue}; idempotent; `unref`'d. */
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
