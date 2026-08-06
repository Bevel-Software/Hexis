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
}

export interface SaveResult {
  restartRequired: boolean;
  complete: boolean;
  awaitingRestart?: boolean;
  settings: SettingStatus[];
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
  ok: boolean;
  /** The remote answered but has no branches yet — a supported starting point. */
  empty?: boolean;
  branches?: string[];
  /**
   * What the remote calls its own trunk, when it says. The screen pre-fills
   * the version fields from it — the names have to match the repository
   * exactly, and being one character off is a failure nobody can see.
   */
  defaultBranch?: string | null;
  error?: string;
}

/**
 * Try the credentials against the real remote before saving anything. Values
 * are sent as typed so an admin tests what is on screen, not what is stored;
 * omitted fields fall back to what is already in effect.
 */
export async function testConnection(fields: Record<string, string>): Promise<ConnectionTest> {
  const res = await authFetch('/api/setup/test-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as ConnectionTest;
}
