import { EMAIL_RE } from '../../lib/email';

/** Commas, semicolons and any whitespace separate; lower-cased, empty parts dropped. */
function tokens(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Split typed or pasted text into addresses. Commas, semicolons and any
 * whitespace separate; a `Name <address>` entry — what a mail client puts on
 * the clipboard when you copy a recipient list — contributes its address.
 * Lower-cased, because the server treats addresses that way and a chip for
 * `Juan@` beside one for `juan@` would be one person invited twice.
 *
 * A display name can hold the very separators the list uses: Outlook copies
 * `Doe, Jane <jane@example.com>`, others quote it (`"Doe, Jane" <…>`). So a
 * quoted name goes first, and the text before an angle-bracketed address is
 * read as its name — only the parts of it that are addresses themselves (a
 * bare one earlier in the list) survive. Text after the last bracketed entry
 * names nothing, so it splits as typed, a mistyped address included, and
 * shows as the invalid chip it is.
 */
export function splitEmails(text: string): string[] {
  const unquoted = text.replace(/"[^"]*"/g, ' ');
  const out: string[] = [];
  let rest = 0;
  for (const entry of unquoted.matchAll(/<([^<>]*)>/g)) {
    out.push(...tokens(unquoted.slice(rest, entry.index)).filter((part) => part.includes('@')));
    out.push(...tokens(entry[1] ?? ''));
    rest = entry.index + entry[0].length;
  }
  out.push(...tokens(unquoted.slice(rest)));
  return out;
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

export type InviteRole = 'member' | 'admin';

/** The Admin role's canonical name in `roles.yaml` (the backend's `ADMIN_CANONICAL`). */
const ADMIN_ROLE = 'admin';

/** What became of one address. */
export type InviteOutcome =
  /** `passwordSet`: the account was created with the starting password. */
  | { email: string; status: 'created'; role: InviteRole; roleError?: string; passwordSet?: boolean }
  /**
   * Already had an account. Invited as Admin, they are made one too:
   * `promoted` when this call did it, `alreadyAdmin` when they were one.
   * `deactivated`: the account is switched off and cannot sign in until an
   * admin switches it back on. Inviting does not do that — switching on asks
   * the deployment for a seat, and is the User accounts page's decision.
   *
   * With a starting password: `passwordSet` when the account had none and
   * now has it, `hasOwnPassword` when it already had one (never replaced),
   * `passwordError` when setting it failed — the account is then left
   * exactly as it was, Admin promotion included.
   */
  | {
      email: string;
      status: 'existing';
      promoted?: boolean;
      alreadyAdmin?: boolean;
      roleError?: string;
      deactivated?: boolean;
      passwordSet?: boolean;
      hasOwnPassword?: boolean;
      passwordError?: string;
    }
  /** The deployment's admission rules had no place for the account (a seat limit, say). */
  | { email: string; status: 'no-seat'; message: string }
  | { email: string; status: 'error'; message: string };

/**
 * What a send came to: one outcome per address, or — when a starting
 * password was given and the account list could not be read — nothing sent
 * at all (see {@link sendInvites}).
 */
export type InviteResult =
  | { status: 'sent'; outcomes: InviteOutcome[] }
  | { status: 'accounts-unreadable' };

/**
 * The address now has an account it can sign in to — new, or already there
 * and switched on. One whose starting password could not be set still can
 * when the deployment has single sign-on (`sso`).
 */
export function isInvited(outcome: InviteOutcome, sso = false): boolean {
  return (
    outcome.status === 'created' ||
    (outcome.status === 'existing' && !outcome.deactivated && (!outcome.passwordError || sso))
  );
}

/** The account now signs in with the starting password the admin typed. */
export function gotPassword(outcome: InviteOutcome): boolean {
  return (outcome.status === 'created' || outcome.status === 'existing') && Boolean(outcome.passwordSet);
}

/** One row of the account list, as much of it as inviting needs. */
interface ListedAccount {
  email: string;
  deactivatedAt?: string | null;
  hasPassword?: boolean;
  /** The deployment admin signs in with the environment password, hash or not. */
  isEnvAdmin?: boolean;
}

/**
 * Invite each address (`POST /api/admin/accounts`): an account with the
 * starting password when the admin gave one, and otherwise with none — then
 * the person signs in with single sign-on, or not at all until someone sets
 * a password, which is why the dialog asks for one on a deployment without
 * single sign-on.
 *
 * One at a time, not in parallel. Each create asks the deployment's admission
 * rules for a place, and a host that sells seats answers from a count —
 * concurrent asks would race that count, and the order the admin typed is the
 * order the seats should go in.
 *
 * The create endpoint is an upsert, so it cannot say "this person was already
 * here". The account list read first can, and an address already on it is
 * not created again: re-creating is not free (it asks for a seat again, and
 * a full plan refuses somebody who already HAS one). The list holds
 * switched-off accounts too, and those are reported as such rather than as
 * able to sign in, and never written.
 *
 * A starting password is sent with `keepExistingPassword`: the server gives
 * it only to a new account or a switched-on one with no password, testing
 * and writing in one statement, and says whether it did. So someone's own
 * password is never replaced, even one set after the list was read. The list
 * still decides what each row says, and an account it shows with a password
 * (or the deployment admin, who signs in with the environment's) is not
 * written at all. A list that cannot be read stops a send with a password
 * before any write: the rows could not say who already had an account.
 * Without a password an unreadable list just means every address is treated
 * as new, as before.
 *
 * Only a refusal the server marks as an admission refusal
 * (`kind: 'admission'`) is "no seat left". Any other is an error in the
 * server's own words — the route's admin check answers 403 as well, for an
 * admin verdict gone stale in another tab.
 *
 * "Admin" is a role membership, not an account property, so it is a second
 * write after the account's. Somebody who already had an account is made an
 * Admin too when invited as one: the admin asked for that person to be an
 * Admin, and that they could already sign in does not change the request.
 * The roster is read first so an existing Admin (including one the server
 * configuration fixes) is reported as such rather than written again. A
 * refused promotion leaves the account standing as it was and says so on
 * the row.
 *
 * The password goes to the server and nowhere else: no outcome carries it.
 */
export async function sendInvites(
  emails: string[],
  role: InviteRole,
  api: {
    listAccounts(): Promise<ListedAccount[]>;
    createAccount(
      email: string,
      name: string,
      password?: string,
      options?: { keepExistingPassword?: boolean },
    ): Promise<{ passwordSet?: boolean } | void>;
    addMember(canonical: string, email: string): Promise<unknown>;
    fetchRoles(): Promise<{ canonical: string; members: string[]; fixedMembers?: string[] }[]>;
  },
  options: { password?: string } = {},
): Promise<InviteResult> {
  const password = options.password || undefined;
  /** Every address with an account. Unreadable means none known. */
  let existing: Map<string, ListedAccount> | null = null;
  try {
    existing = new Map((await api.listAccounts()).map((a) => [a.email.toLowerCase(), a]));
  } catch {
    existing = null;
  }
  if (!existing && password) return { status: 'accounts-unreadable' };
  /** Who is an Admin already; asked only when someone is to be made one. Unreadable means unknown. */
  let admins: Set<string> | null = null;
  if (role === 'admin') {
    try {
      const entry = (await api.fetchRoles()).find((r) => r.canonical === ADMIN_ROLE);
      admins = new Set([...(entry?.members ?? []), ...(entry?.fixedMembers ?? [])].map((e) => e.toLowerCase()));
    } catch {
      admins = null;
    }
  }
  const outcomes: InviteOutcome[] = [];
  for (const email of emails) {
    const account = existing?.get(email.toLowerCase());
    if (account) {
      const off = account.deactivatedAt ? { deactivated: true } : {};
      const ownPassword = Boolean(account.hasPassword || account.isEnvAdmin);
      let passwordFlags: { passwordSet?: boolean; hasOwnPassword?: boolean } = {};
      if (password && !account.deactivatedAt) {
        if (ownPassword) {
          passwordFlags = { hasOwnPassword: true };
        } else {
          try {
            const reply = await api.createAccount(email, '', password, { keepExistingPassword: true });
            // Not set: it got a password of its own since the list was read.
            passwordFlags = reply?.passwordSet === false ? { hasOwnPassword: true } : { passwordSet: true };
          } catch (err) {
            const passwordError = err instanceof Error ? err.message : 'Could not set the password';
            outcomes.push({ email, status: 'existing', passwordError });
            continue;
          }
        }
      } else if (ownPassword && !account.deactivatedAt) {
        passwordFlags = { hasOwnPassword: true };
      }
      const base = { email, status: 'existing' as const, ...off, ...passwordFlags };
      if (role !== 'admin') {
        outcomes.push(base);
      } else if (admins?.has(email.toLowerCase())) {
        outcomes.push({ ...base, alreadyAdmin: true });
      } else {
        try {
          await api.addMember(ADMIN_ROLE, email);
          outcomes.push({ ...base, promoted: true });
        } catch (err) {
          const roleError = err instanceof Error ? err.message : 'Could not make them an admin';
          outcomes.push({ ...base, roleError });
        }
      }
      continue;
    }
    let created: { passwordSet?: boolean } = {};
    /** Not on the list, but there by the time of the write, with its own password (left as it was). */
    let appeared = false;
    try {
      if (password) {
        const reply = await api.createAccount(email, '', password, { keepExistingPassword: true });
        if (reply?.passwordSet === false) appeared = true;
        else created = { passwordSet: true };
      } else {
        await api.createAccount(email, '');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create account';
      const kind = (err as { kind?: unknown } | null)?.kind;
      outcomes.push(
        kind === 'admission' ? { email, status: 'no-seat', message } : { email, status: 'error', message },
      );
      continue;
    }
    if (role !== 'admin') {
      outcomes.push(
        appeared ? { email, status: 'existing', hasOwnPassword: true } : { email, status: 'created', role, ...created },
      );
      continue;
    }
    try {
      await api.addMember(ADMIN_ROLE, email);
      outcomes.push(
        appeared
          ? { email, status: 'existing', hasOwnPassword: true, promoted: true }
          : { email, status: 'created', role: 'admin', ...created },
      );
    } catch (err) {
      const roleError = err instanceof Error ? err.message : 'Could not make them an admin';
      outcomes.push(
        appeared
          ? { email, status: 'existing', hasOwnPassword: true, roleError }
          : { email, status: 'created', role: 'member', roleError, ...created },
      );
    }
  }
  return { status: 'sent', outcomes };
}
