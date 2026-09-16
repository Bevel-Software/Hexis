import type { BranchSyncOutcome } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';

/** One configurable setting, as the server describes it. */
export interface SettingStatus {
  key: string;
  /** The environment variable that still wins if it is set. */
  envVar: string;
  section: 'knowledge-base' | 'sign-in';
  source: 'env' | 'stored' | 'unset';
  /** Absent for secrets — the server never sends a stored secret back. */
  value?: string;
  configured: boolean;
  secret: boolean;
  /** The running server cannot pick this one up; it takes a restart. */
  restartToApply: boolean;
}

/** One branch's part in a remote sync, as `POST /api/sync` reports it — the shared union, so this cannot drift from the server. */
export type SyncBranchOutcome = BranchSyncOutcome;

/** The message a failed branch carries, if its outcome has one. */
export function syncOutcomeError(r: SyncBranchOutcome): string | undefined {
  return r.outcome === 'conflict' || r.outcome === 'error' ? r.error : undefined;
}

/** What the most recent remote sync did — from the server's memory, so "none yet" after a restart. */
export interface LastSync {
  /** Epoch ms. */
  at: number;
  /** A credential kind (`bearer`, `github-signature`, …) or an admin's email. */
  by: string;
  status: 'synced' | 'partial';
  results: SyncBranchOutcome[];
}

/** The remote-sync facts shown beside the sync secret. Admins only. */
export interface SyncStatus {
  /** `<backend>/api/sync` — a hook appends `/<branch>`. */
  url: string;
  last: LastSync | null;
}

/**
 * Whether the single sign-on configuration in effect is known to work: proven
 * against the provider (or by a sign-in), configured but unproven, or absent.
 */
export type OidcVerification = 'verified' | 'unverified' | 'not-configured';

export interface SetupStatus {
  /** Reachable knowledge base AND a process that can serve it. */
  complete: boolean;
  /**
   * Answered, but the running process still holds the old branch model. Should
   * be rare — saving applies it — and means a restart, not another answer.
   */
  awaitingRestart?: boolean;
  isAdmin: boolean;
  /** Admins only — nobody else is told what is missing. */
  settings?: SettingStatus[];
  /** Admins only. Absent on a build without the sync module. */
  sync?: SyncStatus;
  /** Admins only. Absent from an older server. */
  oidcVerification?: OidcVerification;
}

export interface SaveResult {
  restartRequired: boolean;
  complete: boolean;
  awaitingRestart?: boolean;
  settings: SettingStatus[];
  oidcVerification?: OidcVerification;
}

/** Field-keyed messages, so the form can mark the input that was wrong. */
export class SettingsProblems extends Error {
  // Declared and assigned rather than a parameter property: this package
  // compiles with `erasableSyntaxOnly`, which forbids the shorthand.
  readonly problems: Record<string, string>;

  constructor(problems: Record<string, string>) {
    super('Some settings need fixing.');
    this.name = 'SettingsProblems';
    this.problems = problems;
  }
}

async function readError(res: Response): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Request failed (${res.status})`);
  }
  const data = body as { error?: string; problems?: Record<string, string> };
  if (data.problems) throw new SettingsProblems(data.problems);
  throw new Error(data.error || `Request failed (${res.status})`);
}

/**
 * The header the sync endpoint stamps on every response it writes, so the
 * client can tell its 503 ("a branch could not be pulled") from a reverse
 * proxy's 503 ("the backend is down"). Mirrors `SYNC_RESPONSE_HEADER` in the
 * backend's `kb-sync.routes.ts`.
 */
const SYNC_RESPONSE_HEADER = 'x-hexis-sync';
const SYNC_RESPONSE_MARKER = 'result';

/** What "Sync now" came back with. A 409 or 503 still carries per-branch results. */
export interface SyncNowResult {
  /** True for 200 — every branch current. */
  ok: boolean;
  status?: 'synced' | 'partial';
  results: SyncBranchOutcome[];
  /** Set when the server answered with an error body instead of results. */
  error?: string;
}

/**
 * Run a sync of every cloned branch with the admin's own session — the same
 * thing a hook does, from the page where the hook is being wired up, so an
 * admin can prove the deployment reaches the repository before trusting the
 * hook to.
 */
export async function syncNow(): Promise<SyncNowResult> {
  // The endpoint answers 503 when a branch could not be pulled — an ordinary
  // result here, not the backend being down. It marks every response it
  // writes with `X-Hexis-Sync: result`, which a reverse proxy answering for a
  // dead backend never sets, so only a 503 carrying that marker is exempted
  // from the maintenance-overlay signal. A proxy 503, a 502/504 or a network
  // failure still signals, as for every other call.
  const res = await authFetch(
    '/api/sync',
    { method: 'POST' },
    { isApplicationResponse: (r) => r.headers.get(SYNC_RESPONSE_HEADER) === SYNC_RESPONSE_MARKER },
  );
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Sync failed (${res.status})`);
  }
  const data = body as { status?: 'synced' | 'partial'; results?: SyncBranchOutcome[]; error?: string };
  if (!Array.isArray(data.results)) {
    return { ok: false, results: [], error: data.error || `Sync failed (${res.status})` };
  }
  return { ok: res.status === 200, status: data.status, results: data.results };
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await authFetch('/api/setup/status');
  if (!res.ok) await readError(res);
  return (await res.json()) as SetupStatus;
}

export async function saveSettings(settings: Record<string, string>): Promise<SaveResult> {
  const res = await authFetch('/api/setup/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as SaveResult;
}

export interface ConnectionTest {
  /** True only for a connection the host accepts for reading AND writing. */
  ok: boolean;
  /**
   * Which of the three answers this is: read and write; reads but may not
   * push (`error` names the permission to grant); or turned down before it
   * could read — bad credentials, no repository, unreachable host.
   */
  outcome?: 'connected' | 'read-only' | 'rejected';
  /** The field a failure is about, when the server says. */
  field?: string;
  /** The remote answered but has no branches yet — a supported starting point. */
  empty?: boolean;
  branches?: string[];
  /**
   * What the remote calls its own trunk, when it says. The screen pre-fills
   * the version fields from it — the names have to match the repository
   * exactly, and being one character off is a failure nobody can see.
   */
  defaultBranch?: string | null;
  /**
   * The repository's top-level folder names on that branch — empty for an
   * empty repository, null (or absent, from an older server) when they could
   * not be listed. The screen checks the three root folder fields against it.
   */
  rootFolders?: string[] | null;
  error?: string;
}

/**
 * Try the credentials against the real remote before saving anything. Values
 * are sent as typed so an admin tests what is on screen, not what is stored;
 * omitted fields fall back to what is already in effect.
 *
 * A 400 is an ANSWER, not a failure to ask: the server looked at these values
 * and refused them ("enter the access token for that repository", "the URL
 * must start with https://"). It comes back as the rejection it is, so no
 * caller can mistake it for "could not check" and carry on past it. Any other
 * failure throws — a 401/403 is about the session, not the repository, and
 * must not be shown as the host refusing these values.
 */
export async function testConnection(fields: Record<string, string>): Promise<ConnectionTest> {
  const res = await authFetch('/api/setup/test-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (res.status === 400) {
    let data: { error?: string; field?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // No body worth reading — the status alone still says "refused".
    }
    return {
      ok: false,
      outcome: 'rejected',
      field: data.field,
      error: data.error || `The connection check was refused (${res.status}).`,
    };
  }
  if (!res.ok) await readError(res);
  return (await res.json()) as ConnectionTest;
}

export interface OidcTest {
  /** True for credentials the provider accepted, or an issuer checked on its own. */
  ok: boolean;
  /**
   * `verified`: the provider accepted the application ID and secret.
   * `issuer-verified`: the address is a sign-in provider; no credentials to try yet.
   * `unverified`: the provider is fine, but its answer said nothing definite
   * about the credentials — saving is allowed and shows as Unverified.
   * `rejected`: the address or the credentials were turned down (`field` says which).
   */
  outcome?: 'verified' | 'issuer-verified' | 'unverified' | 'rejected';
  field?: string;
  error?: string;
  /** The configuration in effect, after this test. */
  oidcVerification?: OidcVerification;
}

/**
 * Try the single sign-on values against the provider before saving them. As
 * with {@link testConnection}, a 400 is the server refusing these values and
 * comes back as a rejection; any other failure throws.
 */
export async function testOidc(fields: Record<string, string>): Promise<OidcTest> {
  const res = await authFetch('/api/setup/test-oidc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (res.status === 400) {
    let data: { error?: string; field?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // The status alone still says "refused".
    }
    return {
      ok: false,
      outcome: 'rejected',
      field: data.field,
      error: data.error || `The sign-in check was refused (${res.status}).`,
    };
  }
  if (!res.ok) await readError(res);
  return (await res.json()) as OidcTest;
}
