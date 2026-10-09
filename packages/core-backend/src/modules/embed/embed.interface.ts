import type { AuthUser } from '@bevel-software/platform-shared';

/**
 * WHO an embed token was minted for.
 *
 * Two kinds, and the difference is only how the identity is spelled:
 *
 *  - `user` — a Hexis user id. What the MCP `open_page` tool mints: the MCP
 *    session already authenticated somebody (a signed-in user, or the owner
 *    of the connection key the agent carries), so the token names them
 *    outright and there is nothing to link.
 *  - `atlassian` — an outside account id, resolved to a Hexis user through
 *    the account-link table. What the Atlassian connector's mint produces,
 *    and the reason that table exists.
 *
 * Both resolve to one user, whose read and write access the view then obeys.
 * Claims stay PSEUDONYMOUS whichever kind it is — a token travels as an
 * iframe URL parameter, so it carries an id and never an address or a name.
 */
export type EmbedSubject =
  | { kind: 'user'; userId: string }
  | { kind: 'atlassian'; accountId: string };

/** Result of minting an embed token for one file. */
export interface EmbedTokenResult {
  /** Signed, short-lived token scoping the bearer to one file + heading + identity. */
  token: string;
  /** Ready-to-iframe URL: `<frontend>/embed?token=…` (the SPA embed route). */
  embedUrl: string;
}

/** How the embed should render a file: with the app's renderer for its type. */
export interface EmbedFileView {
  /** Display name — file basename without its extension. */
  nodeName: string;
  /** Repo-relative path of the embedded file. */
  repoRelative: string;
  /** Workspace-relative path (`<kbDir>/<repoRelative>`) — what the app's renderers take. */
  workspacePath: string;
  /** The knowledge-base directory name, so the view can build app URLs. */
  kbDirName: string;
  /** The branch rendered. Always the deployment's default branch. */
  branch: string;
  /** The file's address in the app, absolute. */
  appUrl: string;
  /** Heading slug this embed is scoped to; absent for a whole file. */
  heading?: string;
  /**
   * The file's TEXT, for a renderer that takes text (markdown, HTML source,
   * plain text, CSV, a `.tool`). Empty for a file whose renderer fetches its
   * own bytes — an image, a PDF, a Word document — which read them from
   * `GET /api/embed/raw` under this same token.
   */
  content: string;
  /**
   * Whether `content` carries the file's text at all. False says "this
   * renderer reads bytes": the difference between an empty file and a
   * picture, which the view must not confuse.
   */
  contentIsText: boolean;
  /** Whether the token's identity resolved to a Hexis user at all. */
  linked: boolean;
  /** Whether that user may READ this file. Always false when unlinked. */
  canRead: boolean;
  /** Whether that user may WRITE this file on the default branch. */
  canWrite: boolean;
  /** Where to send an unlinked viewer to link their account. */
  linkUrl: string;
}

/** Outcome of an Edit-time lock acquisition. */
export interface EmbedLockResult {
  acquired: boolean;
  /** Current holder's display name when `acquired` is false. */
  holderName?: string;
}

/** Where a proposal landed, so the view can point at it. */
export interface EmbedProposalResult {
  /** The suggestions branch the proposal was committed to. */
  branch: string;
  /** The change request number, when one could be read back. */
  number?: number;
  /** The change request's address in the app, when its number is known. */
  url?: string;
}

/** One outside account linked to a Hexis user (the Connected apps screen). */
export interface EmbedLinkedAccount {
  atlassianAccountId: string;
  /** Epoch ms of when the link was created. */
  createdAt: number;
}

/**
 * Resolve a bare node id (the copy-link form `/workspace/<branch>/<id>`) to
 * its repo-relative path, or null when no node has that id.
 *
 * Core has no node graph, so core refuses an id reference. A deployment that
 * does keeps the Atlassian connector's id references working by registering
 * one of these — the mint's only extension point, and the reason the connector
 * needs no change when the embed moves into Hexis.
 */
export type EmbedNodeIdResolver = (nodeId: string) => Promise<string | null>;

/**
 * What the embed service needs of the workspace: the clone of a branch, and
 * four verbs on one file of it. A port rather than the workspace service
 * itself, so a deployment (or a test) hands in whatever answers these.
 */
export interface EmbedWorkspacePort {
  getOrCreateForBranch(branch: string): Promise<{ id: string }>;
  isFile(workspaceId: string, wsPath: string): Promise<boolean>;
  readFileBinary(workspaceId: string, wsPath: string): Promise<Buffer>;
  writeFile(workspaceId: string, wsPath: string, content: string): Promise<void>;
  /** One mutation at a time per resolved path, in this process: `op` runs after every turn already taken for `wsPath`. */
  withPathTurn<T>(workspaceId: string, wsPath: string, op: () => Promise<T>): Promise<T>;
}

/** What the embed service needs of authentication: a user by id, and the email-domain rule. */
export interface EmbedAuthPort {
  getUserById(userId: string): Promise<AuthUser | null>;
  isEmailDomainAllowed(email: string): boolean;
}

/**
 * Mints and consumes embed tokens that let a host — an MCP App's sandbox, an
 * Atlassian panel — display and edit one knowledge-base file inside itself.
 *
 * The file is the source of truth: editing acquires the platform's file lock,
 * saving writes to the default branch and releases it (which commits), and a
 * viewer who may not write proposes instead, exactly as the app's file page
 * does. The framed data methods — load, raw bytes, lock, heartbeat, cancel,
 * save, propose — authenticate by the TOKEN and nothing else: no session is
 * consulted, and a request that carries one without a token is refused. The
 * account-management methods (`linkAccount`, `listLinkedAccounts`,
 * `unlinkAccount`) are the exception, called from session-authenticated
 * routes on a page no host may frame.
 */
export interface IEmbedService {
  /**
   * Whether the SHARED-SECRET mint (`POST /api/embed/token`) is configured.
   *
   * Only that one route: the embed surface itself is part of every deployment
   * now, because the MCP App is, and its mint authenticates by the MCP
   * session rather than by a secret. A deployment with no
   * `EMBED_SHARED_SECRET` simply has no Atlassian connector pointed at it.
   */
  sharedSecretConfigured(): boolean;
  /** Constant-time check of the connector→backend shared secret. */
  verifySharedSecret(secret: string | undefined): boolean;

  /** Mint for a Hexis user — the MCP path. `reference` is a path or an app URL. */
  mintForUser(input: { userId: string; reference: string }): Promise<EmbedTokenResult>;

  /**
   * Mint for an outside account — the Atlassian connector's path, unchanged.
   * `email` is consulted only by the allowed-email-domains gate and never
   * enters the token.
   */
  mintToken(input: { accountId: string; email?: string; reference: string }): Promise<EmbedTokenResult>;

  /** Load the file the token is scoped to, with the viewer's read/write status. */
  loadFile(token: string): Promise<EmbedFileView>;

  /**
   * The raw bytes of the embedded file, or of one asset `path` beside it (an
   * image a markdown page shows — a file no reader edits as text), for the
   * app renderers that read bytes rather than the text buffer. Gated on the
   * token identity's read access, per file. A text page other than the
   * embedded one is refused: the token scopes the view to ONE page, and
   * another page opens in the app, never through this view's token.
   */
  readBytes(token: string, path?: string): Promise<{ bytes: Buffer; path: string }>;

  /** Acquire the edit lock (Edit clicked). Requires write access. */
  acquireLock(token: string): Promise<EmbedLockResult>;
  /** Keep a held lock alive while editing. */
  heartbeat(token: string): Promise<void>;
  /** Drop the lock without committing (Cancel / view closed). */
  cancel(token: string): Promise<void>;
  /** Write `content` to the default branch, then release the lock (commits). */
  save(token: string, content: string): Promise<void>;
  /**
   * File `content` as a change request authored by the token's identity, on
   * that person's own suggestions branch. What a viewer without write access
   * does instead of saving; nothing lands on the default branch.
   */
  propose(token: string, content: string): Promise<EmbedProposalResult>;

  /** Link the token's outside account to `userId` (called after sign-in). */
  linkAccount(token: string, userId: string): Promise<void>;
  /** The outside accounts linked to `userId`, for the Connected apps screen. */
  listLinkedAccounts(userId: string): Promise<EmbedLinkedAccount[]>;
  /**
   * Remove one of `userId`'s links (self-service disconnect / erasure).
   * False when the account isn't linked to this user.
   */
  unlinkAccount(userId: string, accountId: string): Promise<boolean>;
}
