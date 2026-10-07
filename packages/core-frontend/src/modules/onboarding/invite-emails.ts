import { EMAIL_RE } from '../../lib/email';

/**
 * Split typed or pasted text into addresses. Commas, semicolons and any
 * whitespace separate; a `Name <address>` entry — what a mail client puts on
 * the clipboard when you copy a recipient list — contributes its address.
 * Lower-cased, because the server treats addresses that way and a chip for
 * `Juan@` beside one for `juan@` would be one person invited twice.
 */
export function splitEmails(text: string): string[] {
  return text
    .replace(/[^<>,;]*<([^<>]+)>/g, ' $1 ')
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

export type InviteRole = 'member' | 'admin';

/** The Admin role's canonical name in `roles.yaml` (the backend's `ADMIN_CANONICAL`). */
const ADMIN_ROLE = 'admin';

/** What became of one address. */
export type InviteOutcome =
  | { email: string; status: 'created'; role: InviteRole; roleError?: string }
  | { email: string; status: 'existing' }
  | { email: string; status: 'no-seat'; message: string }
  | { email: string; status: 'error'; message: string };

/** The address now has an account it can sign in to — new or not. */
export function isInvited(outcome: InviteOutcome): boolean {
  return outcome.status === 'created' || outcome.status === 'existing';
}

/**
 * Invite each address: an account with no password, waiting for that
 * person's first single sign-on (`POST /api/admin/accounts`).
 *
 * One at a time, not in parallel. Each create asks the deployment's admission
 * rules for a place, and a host that sells seats answers from a count —
 * concurrent asks would race that count, and the order the admin typed is the
 * order the seats should go in.
 *
 * The create endpoint is an upsert, so it cannot say "this person was already
 * here". The account list read first can, and an address already on it is
 * not created again: re-creating is not free (it asks for a seat again, and
 * a full plan refuses somebody who already HAS one). A list that cannot be
 * read just means every address is treated as new.
 *
 * "Admin" is a role membership, not an account property, so it is a second
 * write after the create, and only for an account this call made — the
 * dialog never promotes somebody who was already here. A refused promotion
 * leaves the account standing as a member and says so on the row.
 */
export async function sendInvites(
  emails: string[],
  role: InviteRole,
  api: {
    listAccounts(): Promise<{ email: string }[]>;
    createAccount(email: string, name: string): Promise<void>;
    addMember(canonical: string, email: string): Promise<unknown>;
  },
): Promise<InviteOutcome[]> {
  let existing: Set<string> | null = null;
  try {
    existing = new Set((await api.listAccounts()).map((a) => a.email.toLowerCase()));
  } catch {
    existing = null;
  }
  const outcomes: InviteOutcome[] = [];
  for (const email of emails) {
    if (existing?.has(email.toLowerCase())) {
      outcomes.push({ email, status: 'existing' });
      continue;
    }
    try {
      await api.createAccount(email, '');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create account';
      const status = (err as { status?: unknown } | null)?.status;
      outcomes.push(
        status === 403 ? { email, status: 'no-seat', message } : { email, status: 'error', message },
      );
      continue;
    }
    if (role !== 'admin') {
      outcomes.push({ email, status: 'created', role });
      continue;
    }
    try {
      await api.addMember(ADMIN_ROLE, email);
      outcomes.push({ email, status: 'created', role: 'admin' });
    } catch (err) {
      const roleError = err instanceof Error ? err.message : 'Could not make them an admin';
      outcomes.push({ email, status: 'created', role: 'member', roleError });
    }
  }
  return outcomes;
}
