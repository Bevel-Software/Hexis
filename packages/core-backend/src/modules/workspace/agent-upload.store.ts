import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { logger } from '../../shared/logging.js';
import { MAX_UPLOAD_BYTES } from './upload-limits.js';

const log = logger('agent-uploads');

/** How long an issued token, and the bytes sent against it, stay usable. */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** How often the store looks for tokens that have expired. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * THE one refusal for every way a token can fail to be usable: it was never
 * issued, it has already been applied, it has expired, or it belongs to
 * somebody else. One sentence for all four, deliberately — an answer that
 * distinguished "no such token" from "not yours" would let anyone holding a
 * guess learn which guesses exist, and the token is the whole credential this
 * route has.
 */
export const UPLOAD_TOKEN_REFUSAL =
  'That upload token cannot be used: it is unknown, already applied, expired, or was issued to someone else. ' +
  'Call `request_file_upload` for a new one.';

/** A refusal with the HTTP status the upload route and the apply tool both answer. */
export class UploadTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UploadTokenError';
  }
}

/** What `request_file_upload` answers: where to send the bytes, and the terms. */
export interface IssuedUpload {
  /** The absolute URL the bytes are POSTed to. Carries the token in its path. */
  uploadUrl: string;
  /** The token itself, for a caller that would rather send it as a header. */
  token: string;
  /** ISO-8601 instant after which the token and any bytes sent with it are gone. */
  expiresAt: string;
  /** Seconds from now until `expiresAt`, so a caller need not parse the date. */
  expiresInSeconds: number;
  /** The largest upload this deployment accepts, in bytes. */
  maxBytes: number;
}

/** What the upload route answers, and what `apply_file_upload` reads back. */
export interface ReceivedUpload {
  /** The name the sender gave the file. For a single file, the name it lands under. */
  filename: string;
  bytes: number;
  /** `zip` when the name ends in `.zip` and the bytes parse as an archive. */
  kind: 'file' | 'zip';
  /** Present for a zip: how many members the archive holds. */
  entries?: number;
}

/** A received upload, with the bytes on disk, as `apply_file_upload` claims it. */
export interface ClaimedUpload extends ReceivedUpload {
  /** Absolute path of the stored bytes — OUTSIDE every workspace. */
  absolutePath: string;
}

interface UploadRecord {
  /** The file name under the store's root. Never derived from the sender's name. */
  id: string;
  userId: string;
  expiresAt: number;
  received?: ReceivedUpload;
  /** Held by an apply that is running: a second apply finds the token in use. */
  claimed: boolean;
}

export interface AgentUploadStoreOptions {
  /** Directory the bytes are written to. A sibling of `workspacesRoot`, never inside one. */
  root: string;
  /** Absolute base URL of this deployment's API, e.g. `https://core.example.com`. */
  publicBaseUrl: string;
  /** Token prefix, so a leaked credential can be recognised by shape. */
  tokenPrefix?: string;
  ttlMs?: number;
  maxBytes?: number;
}

/**
 * The upload tokens an agent lands files with, and the bytes sent against
 * them.
 *
 * An agent that wants to put 27 files on a branch has no way to do it through
 * a tool argument: the content would have to pass through the model, which
 * truncates, mangles escape characters and cannot carry a PNG at all. So the
 * bytes take a route of their own — this store issues a one-time token, the
 * upload route attaches bytes to it, and `apply_file_upload` lands them.
 *
 * Three properties the whole design rests on, because the upload route is the
 * one endpoint on this server that authenticates by a token alone:
 *
 *  - **Unguessable.** 32 random bytes, base64url. Nothing about the token is
 *    derived from the user, the time or a counter.
 *  - **Never stored in the clear.** Records are keyed by the token's SHA-256,
 *    so the store's own memory (and anything that dumps it) holds no usable
 *    credential.
 *  - **Bound and single-use.** A record carries the id of the user it was
 *    issued to and is consumed by the apply that lands it; a second apply, an
 *    apply by anyone else, and an apply after the expiry all meet
 *    {@link UPLOAD_TOKEN_REFUSAL}.
 *
 * And the bytes land in `root` — a directory beside the workspaces root, not
 * inside one. No file tool can reach it: every workspace path is resolved
 * against a branch's checkout, so there is no spelling of a tool argument that
 * names a file in here. An upload nobody applies is deleted when its token
 * expires (see {@link startSweeping}), so an abandoned drop costs disk for at
 * most one TTL.
 */
export class AgentUploadStore {
  private readonly records = new Map<string, UploadRecord>();
  private readonly root: string;
  private readonly publicBaseUrl: string;
  private readonly tokenPrefix: string;
  private readonly ttlMs: number;
  readonly maxBytes: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgentUploadStoreOptions) {
    this.root = options.root;
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.tokenPrefix = options.tokenPrefix ?? '';
    this.ttlMs = options.ttlMs ?? UPLOAD_TOKEN_TTL_MS;
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  }

  /** The URL a token's bytes are sent to. The one spelling of this route's address. */
  uploadUrlFor(token: string): string {
    return `${this.publicBaseUrl}/api/agent/uploads/${encodeURIComponent(token)}`;
  }

  /**
   * Mint a token for `user` and answer the terms it is good for. Nothing is
   * written to disk yet — a token nobody uploads against costs one map entry
   * until the sweep drops it.
   */
  issue(user: { id: string }): IssuedUpload {
    this.startSweeping();
    const token = this.tokenPrefix + randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.records.set(hash(token), {
      id: `upload-${Date.now()}-${randomBytes(8).toString('hex')}`,
      userId: user.id,
      expiresAt,
      claimed: false,
    });
    return {
      uploadUrl: this.uploadUrlFor(token),
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: Math.round(this.ttlMs / 1000),
      maxBytes: this.maxBytes,
    };
  }

  /**
   * Store `data` against `token` and say what was received. One file per
   * token: a second upload against the same token is refused, so a token
   * cannot be used to keep replacing bytes an apply is about to land.
   *
   * A name ending in `.zip` is read as an archive HERE, at upload time, so the
   * answer can carry the entry count and so a corrupt archive is refused while
   * the caller is still holding the file — rather than at apply time, when its
   * token would already be spent.
   */
  async attach(token: string, filename: string, data: Buffer): Promise<ReceivedUpload> {
    const record = this.find(token);
    if (record.received !== undefined) throw new UploadTokenError(UPLOAD_TOKEN_REFUSAL, 404);
    if (data.byteLength > this.maxBytes) {
      throw new UploadTokenError(
        `That upload is ${data.byteLength} bytes, over this deployment's ${this.maxBytes} byte limit. ` +
          'Send a smaller file, or split it across several uploads.',
        413,
      );
    }
    const received: ReceivedUpload = { filename, bytes: data.byteLength, kind: 'file' };
    if (filename.toLowerCase().endsWith('.zip')) {
      let zip: AdmZip;
      try {
        zip = new AdmZip(data);
        received.entries = zip.getEntries().length;
      } catch (err) {
        throw new UploadTokenError(
          `"${filename}" is not a readable .zip archive: ${err instanceof Error ? err.message : String(err)}`,
          422,
        );
      }
      received.kind = 'zip';
    }
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, record.id), data);
    record.received = received;
    return received;
  }

  /**
   * Hold `token` for an apply by `userId`, and answer where its bytes are.
   *
   * A CLAIM rather than a consume, because an apply can be refused whole —
   * the destination is on a protected branch the caller may not write, the
   * archive turned out unreadable — and a token spent on a refusal would make
   * the agent send the same 40 MB again to try a different destination. The
   * claim is what keeps it single-use meanwhile: a second apply arriving while
   * the first runs finds the token in use and is refused. The caller
   * {@link consume}s it once an answer exists, or {@link release}s it on a
   * refusal that landed nothing.
   */
  claim(token: string, userId: string): ClaimedUpload {
    const record = this.find(token);
    if (record.userId !== userId || record.claimed || record.received === undefined) {
      throw new UploadTokenError(UPLOAD_TOKEN_REFUSAL, 404);
    }
    record.claimed = true;
    return { ...record.received, absolutePath: path.join(this.root, record.id) };
  }

  /** Give a claimed token back, unused — the apply refused without landing anything. */
  release(token: string): void {
    const record = this.records.get(hash(token));
    if (record) record.claimed = false;
  }

  /** Spend the token and delete its bytes. Idempotent. */
  async consume(token: string): Promise<void> {
    const key = hash(token);
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    await this.remove(record.id);
  }

  /**
   * Delete every record whose token has expired, with the bytes it was
   * holding — then delete any file in the root that no LIVE record claims.
   *
   * The second half is what makes the first one true. A record can leave the
   * map without its file being gone yet: `find` drops an expired record on the
   * spot (so the refusal is immediate) and removes its bytes without waiting,
   * and a process killed between the write and the apply leaves a file no map
   * will ever mention again. Sweeping by what the records DON'T name closes
   * both, and is the honest reading of the promise: an upload nobody applied
   * is gone once its token has expired.
   */
  async sweepNow(): Promise<void> {
    const now = Date.now();
    for (const [key, record] of [...this.records]) {
      if (record.expiresAt > now) continue;
      this.records.delete(key);
      await this.remove(record.id);
    }
    // Every id a live record is holding — including one whose bytes have not
    // arrived yet, so an upload in flight is never swept out from under itself.
    const live = new Set([...this.records.values()].map((r) => r.id));
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return; // root not created yet, or unreadable — nothing to reclaim
    }
    for (const name of names) {
      if (!live.has(name)) await this.remove(name);
    }
  }

  /**
   * Sweep now, and keep sweeping. Started by the first {@link issue} rather
   * than at boot, so a deployment nobody uploads to runs no timer; idempotent,
   * and the timer is `unref`'d because nothing here is worth keeping a process
   * alive for — the records are in memory and go with it.
   */
  startSweeping(intervalMs: number = SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepNow().catch((err: unknown) => {
        log.warn('could not sweep expired uploads:', { err });
      });
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stop the periodic sweep. For shutdown and for tests. */
  stopSweeping(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** The live record for `token`, or the one refusal. Expiry is judged here. */
  private find(token: string): UploadRecord {
    const key = hash(token);
    const record = this.records.get(key);
    if (!record) throw new UploadTokenError(UPLOAD_TOKEN_REFUSAL, 404);
    if (record.expiresAt <= Date.now()) {
      this.records.delete(key);
      void this.remove(record.id);
      throw new UploadTokenError(UPLOAD_TOKEN_REFUSAL, 404);
    }
    return record;
  }

  /** Best-effort delete of one stored upload. Never throws. */
  private async remove(id: string): Promise<void> {
    try {
      await fs.rm(path.join(this.root, id), { force: true });
    } catch (err) {
      log.warn(`could not delete the stored upload "${id}":`, { err });
    }
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
