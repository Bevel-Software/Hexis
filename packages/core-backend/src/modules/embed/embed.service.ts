import { createHmac, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { AuthUser } from '@bevel-software/platform-shared';
import { suggestionsBranchPrefixFor } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { AuthService } from '../auth/auth.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { GitService } from '../workflow/git/git.service.js';
import { changeRequestLink, changeRequestLinkBase } from '../workflow/git/change-request-link.js';
import type { FileReaderRegistry } from '../workspace/file-readers/file-reader.js';
import type {
  EmbedFileView,
  EmbedLinkedAccount,
  EmbedLockResult,
  EmbedNodeIdResolver,
  EmbedProposalResult,
  EmbedSubject,
  EmbedTokenResult,
  IEmbedService,
} from './embed.interface.js';
import {
  EmbedAccessError,
  EmbedLockedError,
  EmbedNodeNotFoundError,
  EmbedTokenError,
} from './embed.errors.js';
import { parseEmbedRef, EmbedRefParseError, isSafeRepoRelativeEmbedPath } from './embed-link.js';
import type { AccountLinkService } from './account-link.service.js';

const log = logger('embed');

/**
 * Token lifetime — long enough for a view left open in a chat, short enough
 * that a token copied out of a transcript stops working on its own. The
 * token rides in `open_page`'s result, so it sits in the chat transcript, and
 * whoever holds it reads and edits that one file as the token's user until
 * it expires. One hour (Razvan, 2026-10-09; the embed used two before): a
 * page left open in a chat is still covered, and the window is halved. A
 * view older than that shows the expired sentence and the agent opens the
 * page again.
 */
export const EMBED_TOKEN_TTL_SECONDS = 60 * 60;

/** What the embed's config needs from the deployment's. */
export interface EmbedConfig {
  readonly jwtSecret: string;
  readonly embedSharedSecret: string;
  readonly publicFrontendUrl: string;
  readonly kbDirName: string;
}

/**
 * Signed claims carried by an embed token. Deliberately pseudonymous — the
 * token travels as an iframe URL parameter, so it must never carry a direct
 * identifier (an address, a name). An id is the whole of the identity, and
 * everything human-readable is resolved server-side from it.
 */
interface EmbedClaims {
  scope: 'embed';
  /** Which kind of id `sub` is. */
  kind: 'user' | 'atlassian';
  /** A Hexis user id, or an outside account id. */
  sub: string;
  repoRelative: string;
  /** Heading anchor the view should open at; absent = the top of the file. */
  slug?: string;
}

/** Resolved viewer identity for an embed request. */
interface ResolvedIdentity {
  /** Whether the token's id resolved to a user at all. */
  linked: boolean;
  user: AuthUser | null;
  /** Read access on the token's file — always false when unresolved (default-deny). */
  canRead: boolean;
  canWrite: boolean;
}

export class EmbedService implements IEmbedService {
  /**
   * Embed tokens are signed with a key DERIVED from the JWT secret (HMAC with
   * a fixed label) rather than the secret itself — domain separation, so an
   * embed token can never be replayed as a session JWT, nor the reverse. The
   * label is part of the token format: changing it invalidates every live
   * token, so it does not change.
   */
  private readonly signingKey: string;

  constructor(
    private readonly config: EmbedConfig,
    private readonly kb: KbContext,
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly authService: AuthService,
    private readonly workflowService: WorkflowService,
    private readonly gitService: GitService,
    private readonly accountLinks: AccountLinkService,
    private readonly readers: FileReaderRegistry,
    /** See {@link EmbedNodeIdResolver} — core has none, so core refuses an id reference. */
    private readonly resolveNodeId: EmbedNodeIdResolver | null = null,
  ) {
    this.signingKey = createHmac('sha256', config.jwtSecret)
      .update('bevel-embed-token-v1')
      .digest('hex');
  }

  // ── mint ───────────────────────────────────────────────────────────────────

  sharedSecretConfigured(): boolean {
    return this.config.embedSharedSecret.length > 0;
  }

  verifySharedSecret(secret: string | undefined): boolean {
    const expected = this.config.embedSharedSecret;
    if (!expected || !secret) return false;
    const a = Buffer.from(secret, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    const len = Math.max(a.length, b.length);
    const aPadded = Buffer.alloc(len);
    const bPadded = Buffer.alloc(len);
    a.copy(aPadded);
    b.copy(bPadded);
    return timingSafeEqual(aPadded, bPadded) && a.length === b.length;
  }

  async mintForUser(input: { userId: string; reference: string }): Promise<EmbedTokenResult> {
    if (!input.userId) throw new EmbedAccessError('Missing user id');
    return this.mint({ kind: 'user', userId: input.userId }, input.reference);
  }

  async mintToken(input: {
    accountId: string;
    email?: string;
    reference: string;
  }): Promise<EmbedTokenResult> {
    if (!input.accountId) throw new EmbedAccessError('Missing Atlassian account id');
    // The optional allowed-email-domains guard: a viewer whose domain may not
    // reach the knowledge base must not receive a token either. With a guard
    // configured and no email sent we fail CLOSED — we then cannot confirm the
    // viewer is allowed. (Unchanged from the connector's contract.)
    const email = input.email?.trim().toLowerCase() || undefined;
    if (!this.authService.isEmailDomainAllowed(email ?? '')) {
      throw new EmbedAccessError('Your email domain is not permitted to view this content');
    }
    return this.mint({ kind: 'atlassian', accountId: input.accountId }, input.reference);
  }

  /**
   * The one mint. Resolves the reference to a path on the default branch,
   * confirms the FILE EXISTS, and signs the claims.
   *
   * Access is NOT checked here and must not be: the two callers check it
   * their own way — `open_page` has already answered the caller the way
   * `read_file` would (refusal and all) before it asks for a token, and the
   * connector's mint is for an account that may not be linked to anyone yet.
   * The load path gates content on the resolved identity's read access, which
   * is the gate that decides what anybody sees.
   */
  private async mint(subject: EmbedSubject, reference: string): Promise<EmbedTokenResult> {
    const ref = parseEmbedRef(reference, this.config.kbDirName);
    let repoRelative: string;
    if ('nodeId' in ref) {
      // One dot-less segment is an id by the copy-link's shape — and ALSO a
      // legal root-level file name (`readme`, `LICENSE`). A file that is
      // actually there wins: it is what the caller named, and `open_page`
      // has just read it by that very path.
      if (isSafeRepoRelativeEmbedPath(ref.nodeId) && (await this.fileExists(ref.nodeId))) {
        repoRelative = ref.nodeId;
      } else {
        // A bare id is the app's copy-link form. Resolving it needs a node
        // graph, which core does not have; a deployment that does registers a
        // resolver (see `EmbedNodeIdResolver`).
        const resolved = this.resolveNodeId ? await this.resolveNodeId(ref.nodeId) : null;
        if (!resolved) throw new EmbedRefParseError(`No file at the reference '${ref.nodeId}'`);
        repoRelative = resolved;
      }
    } else {
      repoRelative = ref.repoRelative;
    }
    // Existence at mint time, so a dead reference fails where the caller can
    // still say something about it rather than inside a rendered iframe.
    await this.readFileBytes(repoRelative);
    const claims: EmbedClaims = {
      scope: 'embed',
      kind: subject.kind,
      sub: subject.kind === 'user' ? subject.userId : subject.accountId,
      repoRelative,
      slug: ref.slug,
    };
    const token = jwt.sign(claims, this.signingKey, { expiresIn: EMBED_TOKEN_TTL_SECONDS });
    return { token, embedUrl: this.embedUrlFor(token) };
  }

  /** The view's address — what a host frames. */
  embedUrlFor(token: string): string {
    return `${this.config.publicFrontendUrl}/embed?token=${encodeURIComponent(token)}`;
  }

  /** A file's address in the app — what a link opens in a new tab. */
  appUrlFor(repoRelative: string, slug?: string): string {
    const wsPath = [this.config.kbDirName, ...repoRelative.split('/')]
      .map(encodeURIComponent)
      .join('/');
    const branch = encodeURIComponent(this.kb.defaultBranch);
    const anchor = slug ? `#${encodeURIComponent(slug)}` : '';
    return `${this.config.publicFrontendUrl}/workspace/${branch}/${wsPath}${anchor}`;
  }

  // ── read ───────────────────────────────────────────────────────────────────

  async loadFile(token: string): Promise<EmbedFileView> {
    const claims = this.verifyToken(token);
    const { linked, canRead, canWrite } = await this.resolveIdentity(claims);
    const reader = this.readers.readerFor(claims.repoRelative);

    const base: EmbedFileView = {
      nodeName: nodeNameFor(claims.repoRelative),
      repoRelative: claims.repoRelative,
      workspacePath: this.wsPathFor(claims.repoRelative),
      kbDirName: this.config.kbDirName,
      branch: this.kb.defaultBranch,
      appUrl: this.appUrlFor(claims.repoRelative, claims.slug),
      ...(claims.slug ? { heading: claims.slug } : {}),
      content: '',
      contentIsText: reader.textEditable,
      linked,
      canRead,
      canWrite,
      linkUrl: `${this.config.publicFrontendUrl}/embed/link?token=${encodeURIComponent(token)}`,
    };

    // Default-deny, exactly as the app does: no content leaves the backend
    // until the token's identity resolves AND may read this file. The gated
    // view still carries the status so the page can show the right prompt.
    if (!linked || !canRead) return base;
    // A renderer that reads BYTES is handed none here — it fetches them from
    // `/api/embed/raw` under this same token, which keeps a document or an
    // image out of a JSON payload and off the base64 round trip.
    if (!reader.textEditable) return base;
    const bytes = await this.readFileBytes(claims.repoRelative);
    const result = await reader.read(bytes, claims.repoRelative);
    // A refusal IS the file's honest textual answer (unreadable binary under
    // an extension the fallback reader took), and the app shows it as text.
    const content = result.kind === 'text' ? result.text : result.kind === 'refusal' ? result.message : '';
    return { ...base, content };
  }

  async readBytes(token: string, path?: string): Promise<{ bytes: Buffer; path: string }> {
    const claims = this.verifyToken(token);
    const { linked, user } = await this.resolveIdentity(claims);
    if (!linked || !user) throw new EmbedAccessError('This view is not linked to an account');
    // A path beside the embedded file — the pictures a markdown page shows.
    // Resolved relative to the embedded file's own folder, then gated on the
    // viewer's read access for THAT file: the token scopes the view to one
    // page, never to one page's read permissions.
    const target = path ? resolveBeside(claims.repoRelative, path) : claims.repoRelative;
    if (target === null) throw new EmbedAccessError('That path is not inside this knowledge base');
    const workspaceId = this.defaultWorkspaceId();
    if (!(await this.accessControl.canRead(workspaceId, user.email, target))) {
      throw new EmbedAccessError(`You don't have permission to read "${target}".`);
    }
    return { bytes: await this.readFileBytes(target), path: target };
  }

  // ── write ──────────────────────────────────────────────────────────────────

  async acquireLock(token: string): Promise<EmbedLockResult> {
    const { user, wsPath } = await this.requireEditor(token);
    const result = await this.workflowService.acquireLock(
      this.defaultWorkspaceId(),
      this.kb.defaultBranch,
      wsPath,
      user,
    );
    return result.acquired
      ? { acquired: true }
      : { acquired: false, holderName: result.lock.holderName };
  }

  async heartbeat(token: string): Promise<void> {
    const claims = this.verifyToken(token);
    const { user, canWrite } = await this.resolveIdentity(claims);
    if (!user) return; // nothing held — nothing to keep alive
    const workspaceId = this.defaultWorkspaceId();
    const wsPath = this.wsPathFor(claims.repoRelative);
    // Write access is asked again on every renewal: the token outlives the
    // permission it was minted under, and a writer who lost it must not keep
    // a lock alive that shuts out the people who still have it. The lock
    // goes HERE, not only when the view hears the refusal: a frame that is
    // gone, or a host that never delivers the 403, would otherwise leave the
    // file shut to the writers who still have access until the TTL. Letting
    // go takes no access — the workflow releases only a lock this user holds.
    if (!canWrite) {
      await this.workflowService.releaseLockNoCommit(workspaceId, this.kb.defaultBranch, wsPath, user);
      throw new EmbedAccessError();
    }
    await this.workflowService.heartbeatLock(workspaceId, this.kb.defaultBranch, wsPath, user);
  }

  async cancel(token: string): Promise<void> {
    const claims = this.verifyToken(token);
    const { user } = await this.resolveIdentity(claims);
    if (!user) return;
    await this.workflowService.releaseLockNoCommit(
      this.defaultWorkspaceId(),
      this.kb.defaultBranch,
      this.wsPathFor(claims.repoRelative),
      user,
    );
  }

  async save(token: string, content: string): Promise<void> {
    const { user, wsPath } = await this.requireEditor(token);
    const workspaceId = this.defaultWorkspaceId();
    // Bytes reach the disk ONLY under a lock this viewer holds. ASK who holds
    // it rather than acquiring again: `acquire` is strict and refuses a live
    // lock even to its own holder (so an agent sharing the user id cannot
    // steal a human's edit), which turned every Save into a 409 against the
    // writer's own Edit lock. This is the check the app's file routes make
    // (`workspace.routes` `withLock`). A viewer whose lock lapsed — a frame
    // hidden past the TTL — takes it again if it is free, and is refused if
    // somebody else took it: writing first and finding out at the release
    // would leave their text on disk under the other editor's lock.
    await this.ensureHoldsLock(workspaceId, wsPath, user);
    try {
      await this.workspaceService.writeFile(workspaceId, wsPath, content);
      // Release commits + pushes the on-disk bytes through the background
      // queue — the same path the app's file page takes out of edit mode.
      await this.workflowService.releaseLock(workspaceId, this.kb.defaultBranch, wsPath, user);
    } catch (err) {
      await this.workflowService
        .releaseLockNoCommit(workspaceId, this.kb.defaultBranch, wsPath, user)
        .catch((cleanupErr) => {
          // Best-effort cleanup failed — say so, so a stuck lock is
          // diagnosable, then rethrow the save's own error below.
          log.error(
            `releaseLockNoCommit failed during save cleanup ` +
              `(workspace=${workspaceId} path=${wsPath} user=${user.id})`,
            cleanupErr,
          );
          return undefined;
        });
      throw err;
    }
  }

  /**
   * File the edit as a change request authored by the viewer, on their own
   * personal suggestions branch — the same branch and the same one-request
   * bundle the app's "Propose changes" uses, so a reader who proposes from a
   * chat and from the app lands in one place.
   *
   * No lock: nothing touches the default branch, and the suggestions branch
   * is this person's own.
   *
   * The write is COMMITTED here, synchronously, before the request is opened.
   * `workspaceService.writeFile` only puts bytes on disk — the app's file
   * routes commit by releasing the lock they took, which enqueues the commit
   * for the background worker. Neither is usable here: without a commit the
   * branch head never moves, and the request opens against a tree identical
   * to its base — `changedFiles: 0`, and a reviewer told "this pull request
   * has no file changes to approve" about a proposal that is sitting
   * uncommitted on disk. An ENQUEUED commit has the same problem with a race
   * on top of it. `commitChanges` commits and pushes before returning, which
   * is what the one other server-side propose flow (the plugin join request)
   * does for exactly this reason.
   */
  async propose(token: string, content: string): Promise<EmbedProposalResult> {
    const claims = this.verifyToken(token);
    const { user, canRead } = await this.resolveIdentity(claims);
    if (!user) throw new EmbedAccessError('Link your account to propose a change');
    // Read access is the floor for proposing: a change request quotes the
    // file's new text beside its old, so proposing on a file you may not read
    // would publish what you were not allowed to see.
    if (!canRead) throw new EmbedAccessError(`You don't have permission to read "${claims.repoRelative}".`);
    const branch = `${suggestionsBranchPrefixFor({ email: user.email, id: user.id })}knowledge`;
    // Create the branch when it is not there yet; an existing one is reused,
    // which is what bundles a person's proposals into one request.
    await this.gitService
      .createBranch(this.defaultWorkspaceId(), branch, this.kb.defaultBranch)
      .catch((err: unknown) => {
        if (err instanceof Error && /already exists/i.test(err.message)) return;
        throw err;
      });
    const workspace = await this.workspaceService.getOrCreateForBranch(branch);
    const wsPath = this.wsPathFor(claims.repoRelative);
    await this.workspaceService.writeFile(workspace.id, wsPath, content);
    // Scoped to the one path this proposal is about: the suggestions branch
    // is shared by everything this person has proposed, and a bare commit
    // would sweep in another in-flight write of theirs under this message.
    await this.workflowService.commitChanges(
      workspace.id,
      user,
      `Propose changes to ${claims.repoRelative}`,
      [wsPath],
    );
    try {
      const created = await this.workflowService.openChangeRequest(workspace.id, user, {
        sourceBranch: branch,
        targetBranch: this.kb.defaultBranch,
        title: `Changes from ${user.name}. Knowledge`,
      });
      return {
        branch,
        ...(typeof created?.number === 'number'
          ? { number: created.number, url: this.changeRequestUrl(created.number) }
          : {}),
      };
    } catch (err) {
      // The person's one open Knowledge request already covers this branch —
      // which is the state this method is trying to reach, not a failure. The
      // refusal names it, so point at it.
      const existing = duplicateRequestNumber(err);
      if (existing === null) throw err;
      return { branch, number: existing, url: this.changeRequestUrl(existing) };
    }
  }

  // ── account links ──────────────────────────────────────────────────────────

  async linkAccount(token: string, userId: string): Promise<void> {
    const claims = this.verifyToken(token);
    // Only an outside account has anything to link; a token already minted
    // for a Hexis user names its person and must not re-point at another.
    if (claims.kind !== 'atlassian') {
      throw new EmbedAccessError('This view is already signed in');
    }
    await this.accountLinks.link(claims.sub, userId);
  }

  async listLinkedAccounts(userId: string): Promise<EmbedLinkedAccount[]> {
    const rows = await this.accountLinks.listForUser(userId);
    return rows.map((r) => ({
      atlassianAccountId: r.atlassianAccountId,
      createdAt: r.createdAt.getTime(),
    }));
  }

  async unlinkAccount(userId: string, accountId: string): Promise<boolean> {
    return this.accountLinks.unlink(userId, accountId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Make sure `user` holds an EDIT lock on `wsPath` on the default branch:
   * keep it when they already do, take it when nobody does (an expired row
   * reads as none), refuse with the holder's name when somebody else does.
   */
  private async ensureHoldsLock(workspaceId: string, wsPath: string, user: AuthUser): Promise<void> {
    const branch = this.kb.defaultBranch;
    const current = await this.workflowService.getLock(workspaceId, branch, wsPath);
    if (current) {
      // A coordination hold grants no write authority, so it is not "ours"
      // for a save even when the id matches.
      if (current.holderUserId === user.id && current.mode !== 'coordination') return;
      throw new EmbedLockedError(current.holderName);
    }
    const taken = await this.workflowService.acquireLock(workspaceId, branch, wsPath, user);
    if (!taken.acquired) throw new EmbedLockedError(taken.lock.holderName);
  }

  private defaultWorkspaceId(): string {
    return workspaceIdForBranch(this.kb.defaultBranch);
  }

  private wsPathFor(repoRelative: string): string {
    return `${this.config.kbDirName}/${repoRelative}`;
  }

  /**
   * A change request's address, through the same builder the workflow tools
   * use — so a proposal made from a chat and one made by an agent point at
   * the same place, path prefix of a proxied deployment included.
   */
  private changeRequestUrl(number: number): string {
    return changeRequestLink(number, changeRequestLinkBase(this.config.publicFrontendUrl)).url;
  }

  /**
   * Resolve, authorize and locate an edit. Throws `EmbedAccessError` when the
   * identity does not resolve or may not write. Returns the user (for lock
   * attribution) and the workspace-relative path.
   */
  private async requireEditor(
    token: string,
  ): Promise<{ claims: EmbedClaims; user: AuthUser; wsPath: string }> {
    const claims = this.verifyToken(token);
    const { user, canWrite } = await this.resolveIdentity(claims);
    if (!user) throw new EmbedAccessError('Link your account to edit');
    if (!canWrite) throw new EmbedAccessError();
    await this.workspaceService.getOrCreateForBranch(this.kb.defaultBranch);
    return { claims, user, wsPath: this.wsPathFor(claims.repoRelative) };
  }

  /** Resolve the token's identity to a user + read/write verdicts. */
  private async resolveIdentity(claims: EmbedClaims): Promise<ResolvedIdentity> {
    const unresolved: ResolvedIdentity = { linked: false, user: null, canRead: false, canWrite: false };
    const userId =
      claims.kind === 'user' ? claims.sub : await this.accountLinks.getUserId(claims.sub);
    if (!userId) return unresolved;
    const user = await this.authService.getUserById(userId);
    if (!user) return unresolved;
    const workspaceId = this.defaultWorkspaceId();
    const canRead = await this.accessControl.canRead(workspaceId, user.email, claims.repoRelative);
    // Write implies read in the access resolver; the `canRead &&` guard pins
    // that here, so no caller can see canWrite without canRead.
    const canWrite =
      canRead && (await this.accessControl.canWrite(workspaceId, user.email, claims.repoRelative));
    return { linked: true, user, canRead, canWrite };
  }

  /** Read a file's bytes from the default branch's workspace. */
  /** Whether `repoRelative` is a file on the default branch. */
  private async fileExists(repoRelative: string): Promise<boolean> {
    try {
      await this.readFileBytes(repoRelative);
      return true;
    } catch (err) {
      if (err instanceof EmbedNodeNotFoundError) return false;
      throw err;
    }
  }

  private async readFileBytes(repoRelative: string): Promise<Buffer> {
    const workspaceId = this.defaultWorkspaceId();
    await this.workspaceService.getOrCreateForBranch(this.kb.defaultBranch);
    try {
      const read = await this.workspaceService.readFileBinary(workspaceId, this.wsPathFor(repoRelative));
      return Buffer.isBuffer(read) ? read : Buffer.from(read);
    } catch (err) {
      // A missing file is a bad or stale reference, not a server fault —
      // surface it as a typed 404 so the view says what is wrong instead of
      // showing a 500. Everything else (EACCES, EIO, …) stays unexpected.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        throw new EmbedNodeNotFoundError(
          `${repoRelative} doesn't exist on ${this.kb.defaultBranch}`,
        );
      }
      throw err;
    }
  }

  private verifyToken(token: string): EmbedClaims {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.signingKey);
    } catch {
      throw new EmbedTokenError();
    }
    const c = decoded as Partial<EmbedClaims> & { accountId?: unknown };
    if (c?.scope !== 'embed' || typeof c.repoRelative !== 'string' || !c.repoRelative) {
      throw new EmbedTokenError();
    }
    // A token minted by the release BEFORE the subject was generalised keyed
    // the identity on `accountId` alone. Those were minted for two hours, so an upgrade
    // would otherwise expire every open Atlassian panel on the spot; reading
    // the old spelling costs one branch and keeps them working.
    if (typeof c.accountId === 'string' && c.accountId) {
      return { scope: 'embed', kind: 'atlassian', sub: c.accountId, repoRelative: c.repoRelative, slug: c.slug };
    }
    if ((c.kind !== 'user' && c.kind !== 'atlassian') || typeof c.sub !== 'string' || !c.sub) {
      throw new EmbedTokenError();
    }
    return { scope: 'embed', kind: c.kind, sub: c.sub, repoRelative: c.repoRelative, slug: c.slug };
  }
}

/** Display name = file basename without its extension. */
function nodeNameFor(repoRelative: string): string {
  const base = repoRelative.split('/').pop() ?? repoRelative;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * A path written relative to `from`'s folder, resolved to a repo-relative
 * path — or null when it escapes the repository or is otherwise unsafe.
 * A path with a leading slash (`/x`) is taken from the repository root:
 * that is the form the embed view sends, translating the workspace path a
 * renderer hands it.
 */
export function resolveBeside(from: string, path: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return null;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const absolute = decoded.startsWith('/');
  const base = absolute ? [] : from.split('/').slice(0, -1);
  const parts = [...base];
  for (const seg of decoded.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Out of the repository — never a path this view may serve.
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * The number of the open request the server says already covers this branch
 * pair, or null when the failure was something else. The refusal carries the
 * number precisely so a caller can point at the request instead of treating
 * the state as broken.
 */
function duplicateRequestNumber(err: unknown): number | null {
  const detail = (err as { details?: { existingNumber?: unknown }; existingNumber?: unknown } | null) ?? null;
  const candidate = detail?.details?.existingNumber ?? detail?.existingNumber;
  if (typeof candidate === 'number') return candidate;
  if (err instanceof Error) {
    const match = /already\D+(\d+)/i.exec(err.message);
    if (match) return Number(match[1]);
  }
  return null;
}
