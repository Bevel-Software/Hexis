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
 * How long past its expiry a CLAIMED record is pinned against the sweep.
 *
 * An apply holds its claim while it resolves the branch (which may clone),
 * reads the bytes, judges every path and commits — work that can outlast a
 * token whose TTL was nearly up when the apply started. Deleting the source
 * mid-apply would make the commit land short with no refusal naming the
 * reason, so a claim keeps its bytes alive. The grace is what stops that from
 * being forever: an apply that neither consumed nor released within it has
 * died with its process (the record is in memory, so there is no third
 * possibility), and the bytes are reclaimed.
 */
const CLAIM_GRACE_MS = 10 * 60 * 1000; // 10 minutes

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

/**
 * How many tokens one user may hold open at once.
 *
 * A token is permission to put the deployment's whole upload limit on its
 * disk for a TTL, and to hold a connection open while it arrives. Without a
 * bound, one caller asks for a hundred and sends against all of them
 * together. Ten is far more than the route's own use needs — one token carries
 * a zip of any number of files — and a token is given back the moment it is
 * applied or expires.
 */
export const MAX_OPEN_UPLOADS_PER_USER = 10;

/** The refusal an over-limit upload gets, naming the limit that applied. */
export function overLimit(bytes: number, maxBytes: number): string {
  return (
    `That upload is ${bytes} bytes, over this deployment's ${maxBytes} byte upload limit. ` +
    'Send a smaller file, or split it across several uploads.'
  );
}

/** What an upload with no body is told. */
const EMPTY_UPLOAD =
  'That upload carried no bytes. Send the file as the request body — e.g. ' +
  '`curl -X POST --data-binary @<file> "<uploadUrl>?filename=<name>"`.';

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
  /**
   * The token itself — what `apply_file_upload` takes, and the credential the
   * upload route is authenticated by.
   *
   * Named separately from `uploadUrl` for two reasons: the apply needs it on
   * its own, and the route takes it either way round. The bytes can go to
   * `uploadUrl`, which carries the token in its last path segment, or to that
   * address WITHOUT that segment with the token in the `x-upload-token`
   * header — the spelling for a caller that would rather its credential not
   * land in an access log or a shell history on the way.
   */
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
  /**
   * Taken by an upload that is still writing its bytes. Set BEFORE the first
   * `await` in {@link AgentUploadStore.receive}, so two uploads arriving at
   * once cannot both pass the one-file-per-token check and then race each
   * other's bytes onto the same path. Cleared only when a receive fails.
   */
  attaching: boolean;
  /** Held by an apply that is running: a second apply finds the token in use. */
  claimed: boolean;
  /**
   * When the apply holding this record claimed it. An expired record that is
   * CLAIMED is pinned rather than swept — the apply is reading those bytes —
   * until the claim itself looks abandoned (see {@link CLAIM_GRACE_MS}).
   */
  claimedAt?: number;
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
  /** How many tokens one user may hold open at once. Defaults to {@link MAX_OPEN_UPLOADS_PER_USER}. */
  maxOpenPerUser?: number;
  /**
   * How the staging root is listed. Test seam — defaults to `fs.readdir`.
   *
   * The ONE thing about the sweep a suite needs to control. Whether a token
   * issued and uploaded while the sweep is running survives depends on the
   * order of two steps inside {@link AgentUploadStore.sweepNow} — the listing
   * and the live-id set — and the gap between them is a filesystem round-trip
   * no test can otherwise sit inside. Given a listing it can hold open, a test
   * can put a whole upload in that gap and assert the bytes are still there.
   */
  listRoot?: (root: string) => Promise<string[]>;
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
  private readonly listRoot: (root: string) => Promise<string[]>;
  readonly maxBytes: number;
  private readonly maxOpenPerUser: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** The sweep in flight, so a shutdown can wait for it — see {@link drainSweep}. */
  private sweeping: Promise<void> | null = null;
  /** Set by {@link stopSweeping}: no further sweep deletes anything. */
  private stopped = false;

  constructor(options: AgentUploadStoreOptions) {
    this.root = options.root;
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.tokenPrefix = options.tokenPrefix ?? '';
    this.ttlMs = options.ttlMs ?? UPLOAD_TOKEN_TTL_MS;
    this.listRoot = options.listRoot ?? ((root) => fs.readdir(root));
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    this.maxOpenPerUser = options.maxOpenPerUser ?? MAX_OPEN_UPLOADS_PER_USER;
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
    // Counted over what the user still HOLDS: a token that can still be used,
    // and one whose expiry has passed but whose work has not ended — an upload
    // still arriving, an apply still reading. Those keep a connection or a file
    // open exactly as a live token does, so letting them fall out of the count
    // at expiry would let a caller keep ten slow uploads going and ask for ten
    // more. An expired record that is doing nothing is waiting for the sweep,
    // and is not one the user holds.
    const now = Date.now();
    let open = 0;
    for (const record of this.records.values()) {
      if (record.userId !== user.id) continue;
      if (record.expiresAt > now || this.pinned(record, now)) open += 1;
    }
    if (open >= this.maxOpenPerUser) {
      throw new UploadTokenError(
        `You already hold ${open} upload tokens, the most one user may have open at once. Apply one of them with ` +
          '`apply_file_upload`, or wait for one to expire, then ask again. One token carries a zip of any number of files.',
        429,
      );
    }
    const token = this.tokenPrefix + randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.records.set(hash(token), {
      id: `upload-${Date.now()}-${randomBytes(8).toString('hex')}`,
      userId: user.id,
      expiresAt,
      attaching: false,
      claimed: false,
    });
    // AFTER the record exists, not before. The first sweep runs the moment the
    // timer starts, and started from an empty map it would be a sweep that
    // believes nothing is live — this token's own id included.
    this.startSweeping();
    return {
      uploadUrl: this.uploadUrlFor(token),
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: Math.round(this.ttlMs / 1000),
      maxBytes: this.maxBytes,
    };
  }

  /**
   * Store the bytes of `body` against `token` and say what was received. One
   * file per token: a second upload against the same token is refused, so a
   * token cannot be used to keep replacing bytes an apply is about to land.
   *
   * WRITTEN AS THEY ARRIVE, never gathered first. The body is up to the
   * deployment's whole upload limit, and this is the one route a caller can
   * send to without a session: held in memory, a handful of uploads at once
   * cost the process several times that limit each (the chunks, the buffer
   * they were joined into, the archive read over it). Streamed, an upload in
   * flight costs one chunk.
   *
   * A name ending in `.zip` is read as an archive HERE, once the bytes are on
   * disk, so the answer can carry the entry count and so a corrupt archive is
   * refused while the caller is still holding the file — rather than at apply
   * time, when its token would already be spent.
   */
  async receive(
    token: string,
    filename: string,
    body: AsyncIterable<Buffer | string>,
  ): Promise<ReceivedUpload> {
    const record = this.openRecord(token);
    // RESERVED FIRST, before any `await`: two uploads arriving at once would
    // otherwise both find the token open, both write, and the apply would land
    // whichever set of bytes finished last — against a token whose answer
    // described the other one.
    record.attaching = true;
    const stored = path.join(this.root, record.id);
    let bytes = 0;
    const received: ReceivedUpload = { filename, bytes: 0, kind: 'file' };
    try {
      await fs.mkdir(this.root, { recursive: true });
      const file = await fs.open(stored, 'w');
      try {
        for await (const chunk of body) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          bytes += buf.byteLength;
          // The real total, counted as it arrives: a `content-length` is the
          // sender's claim, and a chunked body makes none.
          if (bytes > this.maxBytes) throw new UploadTokenError(overLimit(bytes, this.maxBytes), 413);
          // To the last byte: one `write` may put down only part of what it
          // was handed and say so in `bytesWritten`, and a chunk counted as
          // received while half of it is on disk would land a file shorter
          // than the size the answer names.
          for (let written = 0; written < buf.byteLength; ) {
            written += (await file.write(buf, written, buf.byteLength - written)).bytesWritten;
          }
        }
      } finally {
        await file.close();
      }
      if (bytes === 0) throw new UploadTokenError(EMPTY_UPLOAD, 400);
      received.bytes = bytes;
      if (filename.toLowerCase().endsWith('.zip')) {
        try {
          received.entries = new AdmZip(stored).getEntries().length;
        } catch (err) {
          throw new UploadTokenError(
            `"${filename}" is not a readable .zip archive: ${err instanceof Error ? err.message : String(err)}`,
            422,
          );
        }
        received.kind = 'zip';
      }
    } catch (err) {
      // Nothing was received, so the token is open again: the sender may retry
      // with the same one rather than ask for another. Whatever part of the
      // body reached the disk goes now, rather than at the next sweep.
      await this.remove(record.id);
      record.attaching = false;
      throw err;
    }
    // THE TTL MAY HAVE PASSED while the bytes were arriving — a 40 MB upload
    // over a slow link takes real time, and the token was issued before it
    // started. The record was pinned against the sweep throughout (see
    // {@link pinned}), so neither it nor the file could be deleted under the
    // write; but an expired token cannot be applied, so answering "received"
    // would hand the sender a success it can do nothing with. The refusal is
    // the honest answer, and the bytes go with it rather than waiting for a
    // sweep to notice.
    if (record.expiresAt <= Date.now()) {
      this.records.delete(hash(token));
      await this.remove(record.id);
      throw new UploadTokenError(UPLOAD_TOKEN_REFUSAL, 404);
    }
    record.received = received;
    return received;
  }

  /**
   * Refuse `token` if it cannot accept bytes — unknown, expired, somebody
   * else's doing, or already holding a file — and answer its record if it can.
   *
   * Exists as its own step so the upload route can ask BEFORE it reads the
   * body. The route is the one endpoint here authenticated by a token alone,
   * and buffering up to the deployment's whole upload limit for an invented
   * token would let a handful of concurrent requests spend the process's
   * memory on bytes that were never going to be stored.
   */
  assertOpen(token: string): void {
    this.openRecord(token);
  }

  /** {@link assertOpen}, with the record it found — the store's own view of it. */
  private openRecord(token: string): UploadRecord {
    const record = this.find(token);
    if (record.received !== undefined || record.attaching) {
      throw new UploadTokenError(UPLOAD_TOKEN_REFUSAL, 404);
    }
    return record;
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
    record.claimedAt = Date.now();
    return { ...record.received, absolutePath: path.join(this.root, record.id) };
  }

  /** Give a claimed token back, unused — the apply refused without landing anything. */
  release(token: string): void {
    const record = this.records.get(hash(token));
    if (record) {
      record.claimed = false;
      record.claimedAt = undefined;
    }
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
   * holding — then delete any file in the root that no LIVE record claims and
   * that has outlived every token that could name it.
   *
   * The second half is what makes the first one true. A process killed between
   * the write and the apply leaves a file no map will ever mention again, and
   * sweeping by what the records DON'T name is the honest reading of the
   * promise: an upload nobody applied does not stay. By AGE rather than at
   * once, because a file this map does not name may be another process's (see
   * the loop below).
   *
   * ONE record is kept past its expiry: one an apply has CLAIMED. Those bytes
   * are being read right now, and a sweep that deleted them would make the
   * commit land short of what the answer promised. The pin lasts
   * {@link CLAIM_GRACE_MS}, after which a claim nobody consumed or released
   * belongs to a dead process and is reclaimed.
   */
  async sweepNow(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const [key, record] of [...this.records]) {
      if (record.expiresAt > now) continue;
      if (this.pinned(record, now)) continue;
      this.records.delete(key);
      await this.remove(record.id);
    }
    let names: string[];
    try {
      names = await this.listRoot(this.root);
    } catch {
      return; // root not created yet, or unreadable — nothing to reclaim
    }
    // Every id a live record is holding — including one whose bytes have not
    // arrived yet, so an upload in flight is never swept out from under itself,
    // and one an apply has pinned past its expiry.
    //
    // Read AFTER the directory, never before. The gap between the two is a
    // real one — the readdir is a filesystem round-trip, and this process
    // serves other requests across it — so a token issued and uploaded during
    // that gap would appear in `names` while a set taken earlier had never
    // heard of it, and the sweep would delete bytes somebody had just been
    // told were received. Taken afterwards, the set is a superset of what the
    // listing could possibly name.
    const live = new Set([...this.records.values()].map((r) => r.id));
    for (const name of names) {
      // Asked again per name: a stop (an evicted tenant, a shutdown) that
      // landed while this sweep was reading the directory must not go on to
      // delete files a replacement store may already have issued ids for.
      if (this.stopped) return;
      if (live.has(name)) continue;
      // A file this map does not name is not necessarily nobody's. The records
      // are ONE PROCESS's memory, and two processes share this directory
      // whenever a deployment restarts by starting the new one before the old
      // one has stopped: to each, the other's uploads are files no record
      // names. So such a file goes only once it is older than any token could
      // still be good for — its TTL, and the grace an apply holding it is
      // given. A process that died leaves its files for that long and no
      // longer; a process that is alive never loses one in use.
      if (await this.outlivedEveryToken(name, now)) await this.remove(name);
    }
  }

  /**
   * Whether the stored file `name` is older than any token that could still be
   * naming it, in this process or another. A file that cannot be examined is
   * left for the next sweep rather than judged.
   */
  private async outlivedEveryToken(name: string, now: number): Promise<boolean> {
    try {
      const { mtimeMs } = await fs.stat(path.join(this.root, name));
      return now - mtimeMs > this.ttlMs + CLAIM_GRACE_MS;
    } catch {
      return false;
    }
  }

  /**
   * Whether an expired record is held open by work that is still running:
   * an UPLOAD still writing its bytes, or an APPLY still reading them.
   *
   * Both windows can outlast a TTL — a large upload over a slow link, an apply
   * that clones a branch before it reads — and in both the record's own file is
   * being written or read right now. A sweep that deleted either would leave a
   * file no map mentions (the upload writes after the delete) or an apply
   * reading a path that has gone. The apply's pin has a grace, because a claim
   * can be abandoned by a process that dies; the upload's needs none, because
   * `receive` always ends — it clears `attaching` on failure and sets
   * `received` on success, and one whose TTL passed meanwhile deletes the
   * record itself rather than leaving it pinned.
   */
  private pinned(record: UploadRecord, now: number): boolean {
    if (record.attaching && record.received === undefined) return true;
    return record.claimed && now - (record.claimedAt ?? now) < CLAIM_GRACE_MS;
  }

  /**
   * Sweep now, and keep sweeping. Started by the first {@link issue} rather
   * than at boot, so a deployment nobody uploads to runs no timer; idempotent,
   * and the timer is `unref`'d because nothing here is worth keeping a process
   * alive for — the records are in memory and go with it.
   *
   * The first sweep runs IMMEDIATELY, not one interval later, because the
   * records are in memory: a process that restarted holds no record of what
   * the previous one stored, and what that one left behind long enough ago
   * has no reason to wait a further interval.
   */
  startSweeping(intervalMs: number = SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return;
    this.stopped = false;
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Stop sweeping, for good: the timer is cleared AND a sweep already running
   * abandons the rest of its work.
   *
   * Both halves matter when a graph is stopped — a tenant evicted, the process
   * shutting down. The root is this tenant's, and a reactivation builds a new
   * store over the same directory with an empty record map: a sweep left
   * running from the old store would find the new store's files named by no
   * record of ITS own and delete them, under an apply that is about to read
   * them. {@link drainSweep} is how a caller waits for the abandonment to
   * actually have happened.
   */
  stopSweeping(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Wait for the sweep in flight, if any. Pairs with {@link stopSweeping} on shutdown. */
  async drainSweep(): Promise<void> {
    await this.sweeping;
  }

  /** One sweep, with its failure logged and its promise kept for {@link drainSweep}. */
  private sweep(): void {
    const running = this.sweepNow()
      .catch((err: unknown) => {
        log.warn('could not sweep expired uploads:', { err });
      })
      .finally(() => {
        if (this.sweeping === running) this.sweeping = null;
      });
    this.sweeping = running;
  }

  /** The live record for `token`, or the one refusal. Expiry is judged here. */
  private find(token: string): UploadRecord {
    const key = hash(token);
    const record = this.records.get(key);
    if (!record) throw new UploadTokenError(UPLOAD_TOKEN_REFUSAL, 404);
    const now = Date.now();
    if (record.expiresAt <= now) {
      // Expired either way — but a record an apply is still reading keeps its
      // bytes (and its map entry) until that apply ends, for the reason
      // {@link sweepNow} gives. The refusal is the same; only the deletion waits.
      if (!this.pinned(record, now)) {
        this.records.delete(key);
        void this.remove(record.id);
      }
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

/**
 * Refuse a boot whose upload root is not OUTSIDE every workspace.
 *
 * The whole safety of this route rests on where the bytes land: they are a
 * buffer somebody sent, judged by nothing until `apply_file_upload` judges each
 * path against a branch. A root configured inside `workspacesRoot` would put
 * that unjudged buffer where the file tools read — `read_file`, `grep`, the
 * download route — bypassing the access and platform-file rules the apply
 * exists to apply. The invariant is documented on `AGENT_UPLOADS_ROOT`; this is
 * it checked, at boot, naming the variable, rather than trusted.
 *
 * Both directions and both spellings: equal paths, either containing the
 * other, and the real paths, so a root that is a LINK into the workspaces tree
 * is refused too.
 *
 * `what` names the root being checked, for a boot failure that sends the
 * operator to the right setting: the upload root by default; the download
 * root (derived from it) says so itself.
 */
export async function assertUploadsRootOutsideWorkspaces(
  uploadsRoot: string,
  workspacesRoot: string,
  what: StagingRootDescription = UPLOADS_ROOT_DESCRIPTION,
): Promise<void> {
  for (const [uploads, workspaces] of [
    [path.resolve(uploadsRoot), path.resolve(workspacesRoot)],
    [await realBase(uploadsRoot), await realBase(workspacesRoot)],
  ]) {
    if (uploads === workspaces || contains(workspaces, uploads) || contains(uploads, workspaces)) {
      throw new Error(`${what.name} ("${uploadsRoot}") must be outside WORKSPACES_ROOT ("${workspacesRoot}"): ${what.why}`);
    }
  }
}

/** A staging root {@link assertUploadsRootOutsideWorkspaces} checks: what it is called, and why and how to fix it. */
export interface StagingRootDescription {
  name: string;
  why: string;
}

const UPLOADS_ROOT_DESCRIPTION: StagingRootDescription = {
  name: 'AGENT_UPLOADS_ROOT',
  why:
    'uploaded bytes are staged there before any access or platform-file rule has judged them, so a root inside a ' +
    'workspace would let the file tools read them. Point it at a sibling directory.',
};

/** Whether `child` is inside `parent`. Paths already resolved. */
function contains(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * `dir` with every link on it resolved — as far as it exists. Neither root is
 * required to exist yet (the store makes its own on the first upload), so the
 * deepest existing ancestor is resolved and the missing rest joined back on:
 * a link anywhere along the part that DOES exist is what could redirect the
 * one into the other.
 */
async function realBase(dir: string): Promise<string> {
  let existing = path.resolve(dir);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(existing), ...rest);
    } catch {
      const up = path.dirname(existing);
      if (up === existing) return path.join(existing, ...rest);
      rest.unshift(path.basename(existing));
      existing = up;
    }
  }
}
