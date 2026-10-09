import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Eye, EyeOff, KeyRound, RotateCw } from 'lucide-react';
import { Badge, Banner, Button, Dialog, TextField, type BadgeTone } from '../../../shared/components';
import { SlotBoundary } from '../../../shared/components/SlotBoundary';
import { useAppRegistry } from '../../../core/registry';
import { useAuth } from '../../auth/state/auth.context';
import { useSignInMethods } from '../../auth/state/use-sign-in-methods';
import type { LoginProviders } from '../../auth/services/sso';
import { createAccount, listAccounts } from '../../auth/services/account.api';
import { addMember, fetchRoles } from '../../admin/services/roles.api';
import { copyToClipboard } from '../../library/utils/clipboard';
import { initials } from '../../../lib/email';
import { EmailChipsInput } from './EmailChipsInput';
import {
  gotPassword,
  isInvited,
  isValidEmail,
  sendInvites,
  splitEmails,
  type InviteOutcome,
  type InviteRole,
} from '../invite-emails';

/** The platform's shortest accepted password (the server's `MIN_PASSWORD_LENGTH`). */
const MIN_PASSWORD_LENGTH = 8;

/** "1 person" / "3 people" — the one plural this dialog needs. */
function people(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** "A", "A or B", "A, B or C": the single sign-on providers, by their labels. */
function either(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/**
 * What the form asks for, from how the deployment signs people in:
 * - `password`: password sign-in and no single sign-on — a starting password
 *   is required, or nobody invited could sign in;
 * - `sso`: single sign-on and password sign-in — a password is an option;
 * - `sso-only`: password sign-in is off — no password at all;
 * - `unknown`: not known yet, or the check failed — nothing can be sent.
 */
type FormMode = 'password' | 'sso' | 'sso-only' | 'unknown';

function formMode(methods: LoginProviders | null): FormMode {
  if (!methods) return 'unknown';
  if (!methods.password) return 'sso-only';
  return methods.sso.length > 0 ? 'sso' : 'password';
}

interface InviteDialogProps {
  open: boolean;
  onClose(): void;
  /** Called after a send that created or changed at least one account. */
  onInvited?(): void;
  /** Addresses already in the field when it opens (Manage access's Invite). */
  initialEmails?: string[];
}

/**
 * Invite your team: addresses in, accounts out, under the same access rules
 * as everything else (Share → Manage access decides what they then see).
 *
 * How the invited people get in depends on the deployment, so the dialog
 * asks it first (`GET /api/auth/providers`) and lets nothing be sent until it
 * knows. Without single sign-on it requires a starting password, given to
 * every account the send creates or that has none yet; with single sign-on
 * the password is an option. An account that has its own password keeps it.
 *
 * Two views in one dialog. The form; then, after sending, who is invited,
 * how each of them signs in, and how to tell them. The second view exists
 * because creating an account sends nobody anything — core has no mail — so
 * the admin leaves with the sign-in address and a message to forward, not
 * with an assumption that people were notified.
 *
 * The starting password lives in this component's state only. It is never in
 * the message or anything else a copy button copies, never shown again after
 * the send, and gone with the dialog.
 *
 * Feedback stays INSIDE the dialog: the Library's toasts only exist under its
 * own routes, and this opens from Knowledge too.
 */
export function InviteDialog({ open, onClose, onInvited, initialEmails }: InviteDialogProps) {
  const { user } = useAuth();
  const signIn = useSignInMethods();
  const methods = signIn.status === 'ready' ? signIn.methods : null;
  const mode = formMode(methods);
  const [emails, setEmails] = useState<string[]>(() => initialEmails ?? []);
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [password, setPassword] = useState('');
  const [alsoPassword, setAlsoPassword] = useState(false);
  const [sending, setSending] = useState(false);
  // A send with a password stopped before any write: the account list could not be read.
  const [accountsUnreadable, setAccountsUnreadable] = useState(false);
  const [outcomes, setOutcomes] = useState<InviteOutcome[] | null>(null);
  const emailsId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);

  // The address field, not the header's close button, is where an invite
  // starts: on open and again after "Invite more people". A frame late on
  // purpose — the dialog moves focus to its first control as it opens, and
  // that runs after this component's own effects.
  useEffect(() => {
    if (!open || outcomes) return;
    const frame = requestAnimationFrame(() => document.getElementById(emailsId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, outcomes, emailsId]);

  // The button that sent is gone once the result shows; focus goes to the
  // way out rather than falling to the page behind the dialog.
  useEffect(() => {
    if (outcomes) doneRef.current?.focus();
  }, [outcomes]);

  // What a send would include: the chips plus anything still in the field,
  // so typing one address and clicking Invite does what it says.
  const pending = [...emails];
  for (const email of splitEmails(draft)) if (!pending.includes(email)) pending.push(email);
  const valid = pending.filter(isValidEmail);
  const wantsPassword = mode === 'password' || (mode === 'sso' && alsoPassword);
  const passwordOk = !wantsPassword || password.length >= MIN_PASSWORD_LENGTH;
  const canSend = mode !== 'unknown' && valid.length > 0 && passwordOk && !sending;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setAccountsUnreadable(false);
    try {
      const result = await sendInvites(
        valid,
        role,
        { listAccounts, createAccount, addMember, fetchRoles },
        { password: wantsPassword ? password : undefined },
      );
      if (result.status === 'accounts-unreadable') {
        // Nothing was written; the form keeps what the admin typed.
        setAccountsUnreadable(true);
        return;
      }
      setEmails([]);
      setDraft('');
      setPassword('');
      setOutcomes(result.outcomes);
      if (result.outcomes.some((o) => o.status === 'created' || gotPassword(o) || (o.status === 'existing' && o.promoted))) {
        onInvited?.();
      }
    } finally {
      setSending(false);
    }
  }

  function inviteMore() {
    setEmails([]);
    setDraft('');
    setRole('member');
    setPassword('');
    setAlsoPassword(false);
    setOutcomes(null);
  }

  if (outcomes) {
    const invited = outcomes.filter(isInvited).length;
    return (
      <Dialog
        open={open}
        onClose={onClose}
        size="lg"
        title={
          invited === 0
            ? 'Nobody was invited'
            : `${people(invited)} ${invited === 1 ? 'is' : 'are'} invited`
        }
        footer={
          <>
            <Button variant="quiet" size="sm" className="mr-auto" onClick={inviteMore}>
              Invite more people
            </Button>
            <Button ref={doneRef} variant="primary" size="sm" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <InvitedBody outcomes={outcomes} invited={invited} methods={methods} />
      </Dialog>
    );
  }

  const domain = user?.email.split('@')[1];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={sending}
      size="lg"
      title="Invite your team"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void send()} disabled={!canSend}>
            {sending
              ? 'Inviting…'
              : valid.length > 0
                ? `Invite ${people(valid.length)}`
                : 'Invite people'}
          </Button>
        </>
      }
    >
      <InviteFormBody
        mode={mode}
        alert={
          signIn.status === 'failed' ? (
            <RetryAlert text="Couldn’t check how people sign in here." onRetry={signIn.retry} />
          ) : accountsUnreadable ? (
            <RetryAlert
              text="Nothing was sent: couldn’t check who already has an account."
              onRetry={() => void send()}
              disabled={!canSend}
            />
          ) : null
        }
        ssoLabels={methods?.sso.map((p) => p.label) ?? []}
        emailsId={emailsId}
        emails={emails}
        onEmailsChange={setEmails}
        draft={draft}
        onDraftChange={setDraft}
        role={role}
        onRoleChange={setRole}
        password={password}
        onPasswordChange={setPassword}
        alsoPassword={alsoPassword}
        onAlsoPasswordChange={setAlsoPassword}
        validCount={valid.length}
        invalidCount={pending.length - valid.length}
        sending={sending}
        placeholder={domain ? `name@${domain}` : 'name@company.com'}
      />
    </Dialog>
  );
}

/** A red bar saying what went wrong, with a Retry beside it. */
function RetryAlert({ text, onRetry, disabled = false }: { text: string; onRetry(): void; disabled?: boolean }) {
  return (
    <Banner tone="danger" role="alert">
      <div className="flex items-center gap-3">
        <span className="flex-1">{text}</span>
        <Button size="sm" leadingIcon={<RotateCw size={14} aria-hidden />} onClick={onRetry} disabled={disabled}>
          Retry
        </Button>
      </div>
    </Banner>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-detail font-medium text-ink">
      {children}
    </label>
  );
}

function InviteFormBody({
  mode,
  alert,
  ssoLabels,
  emailsId,
  emails,
  onEmailsChange,
  draft,
  onDraftChange,
  role,
  onRoleChange,
  password,
  onPasswordChange,
  alsoPassword,
  onAlsoPasswordChange,
  validCount,
  invalidCount,
  sending,
  placeholder,
}: {
  mode: FormMode;
  alert: ReactNode;
  ssoLabels: string[];
  emailsId: string;
  emails: string[];
  onEmailsChange(next: string[]): void;
  draft: string;
  onDraftChange(next: string): void;
  role: InviteRole;
  onRoleChange(next: InviteRole): void;
  password: string;
  onPasswordChange(next: string): void;
  alsoPassword: boolean;
  onAlsoPasswordChange(next: boolean): void;
  validCount: number;
  /**
   * Addresses a send would leave out — chips and text still in the field
   * alike, since a send clears both and the field's would otherwise go
   * without a word.
   */
  invalidCount: number;
  sending: boolean;
  placeholder: string;
}) {
  const Extras = useAppRegistry().inviteExtras;
  const invalidId = useId();
  const roleId = useId();
  const passwordId = useId();
  const helpId = useId();

  const showPassword = mode === 'password' || (mode === 'sso' && alsoPassword);
  const tooShort = showPassword && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const idp = either(ssoLabels);
  const help =
    mode === 'password'
      ? 'They sign in with their email and the password you set.'
      : (mode === 'sso' || mode === 'sso-only') && idp
        ? showPassword
          ? `They sign in with ${idp}, or with their email and the password you set.`
          : `They sign in with ${idp}.`
        : null;

  const passwordField = (
    <PasswordField
      id={passwordId}
      value={password}
      onChange={onPasswordChange}
      invalid={tooShort}
      disabled={sending}
      describedBy={helpId}
    />
  );

  return (
    <div className="flex flex-col gap-5 py-2">
      {alert}
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={emailsId}>Emails</FieldLabel>
        <EmailChipsInput
          id={emailsId}
          emails={emails}
          onEmailsChange={onEmailsChange}
          draft={draft}
          onDraftChange={onDraftChange}
          placeholder={placeholder}
          aria-describedby={invalidCount > 0 ? invalidId : undefined}
          disabled={sending}
        />
        {invalidCount > 0 && (
          <span id={invalidId} className="text-meta text-danger">
            {invalidCount === 1 ? 'One address isn’t' : `${invalidCount} addresses aren’t`} valid and won’t be
            invited.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className={`grid grid-cols-[9rem_1fr] gap-3 ${mode === 'password' ? '' : 'items-end'}`}>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={roleId}>Role</FieldLabel>
            <div className="relative">
              <select
                id={roleId}
                value={role}
                disabled={sending}
                onChange={(e) => onRoleChange(e.target.value as InviteRole)}
                className="w-full appearance-none rounded-md border border-line-strong bg-surface py-2 pl-2.5 pr-8 text-ui text-ink"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <ChevronDown
                size={14}
                aria-hidden
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
              />
            </div>
          </div>
          {mode === 'password' && passwordField}
          {mode === 'sso' && (
            <label className="flex h-[38px] items-center gap-2 text-ui text-ink">
              <input
                type="checkbox"
                checked={alsoPassword}
                disabled={sending}
                onChange={(e) => onAlsoPasswordChange(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Also give them a password
            </label>
          )}
        </div>
        {mode === 'sso' && alsoPassword && <div className="mt-3">{passwordField}</div>}
        {tooShort ? (
          <p id={helpId} className="text-meta text-danger">
            The password needs at least {MIN_PASSWORD_LENGTH} characters.
          </p>
        ) : (
          help && (
            <p id={helpId} className="text-meta text-ink-faint">
              {help}
            </p>
          )
        )}
      </div>
      {Extras && (
        <SlotBoundary label="invite panel">
          <Extras inviting={validCount} />
        </SlotBoundary>
      )}
    </div>
  );
}

/**
 * The starting password: masked, with an eye button to check what was typed.
 * `new-password` so the browser offers to generate one rather than filling
 * in the admin's own.
 */
function PasswordField({
  id,
  value,
  onChange,
  invalid,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange(next: string): void;
  invalid: boolean;
  disabled: boolean;
  describedBy: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id}>Starting password</FieldLabel>
      <div className="relative">
        <TextField
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          required
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={`pr-10 ${invalid ? 'border-danger' : ''}`}
        />
        <button
          type="button"
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-faint hover:text-ink"
        >
          {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      </div>
    </div>
  );
}

/** How each outcome reads on its row. */
const OUTCOME_BADGE: Record<InviteOutcome['status'], { tone: BadgeTone; label: string }> = {
  created: { tone: 'neutral', label: 'Hasn’t signed in yet' },
  existing: { tone: 'outline', label: 'Already had an account' },
  'no-seat': { tone: 'wait', label: 'Not invited: no seat left' },
  error: { tone: 'danger', label: 'Not invited' },
};

/**
 * A switched-off account is on the list but cannot sign in: its row says so,
 * in the waiting tone, rather than "Already had an account" beside a claim
 * that it is ready. One whose password could not be set says that.
 */
function outcomeBadge(outcome: InviteOutcome): { tone: BadgeTone; label: string } {
  if (outcome.status === 'existing' && outcome.deactivated) return { tone: 'wait', label: 'Account switched off' };
  if (outcome.status === 'existing' && outcome.passwordError) return { tone: 'danger', label: 'Password not set' };
  return OUTCOME_BADGE[outcome.status];
}

/** How the person on one row signs in — or why they can't. */
function outcomeDetail(outcome: InviteOutcome, idp: string, passwordGiven: boolean): string {
  switch (outcome.status) {
    case 'created': {
      const as = outcome.roleError
        ? `Member: couldn’t make them an admin (${outcome.roleError})`
        : outcome.role === 'admin'
          ? 'Admin'
          : 'Member';
      const how = outcome.passwordSet
        ? idp
          ? `signs in with ${idp} or password`
          : 'signs in with the password you set'
        : idp
          ? `signs in with ${idp}`
          : null;
      return how ? `${as} · ${how}` : as;
    }
    case 'existing': {
      if (outcome.passwordError) return `Couldn’t set the password: ${outcome.passwordError}`;
      const access = outcome.deactivated
        ? 'Can’t sign in until it’s switched on in User accounts'
        : outcome.passwordSet
          ? idp
            ? `Had no password: now signs in with ${idp} or the one you set`
            : 'Had no password: now uses the one you set'
          : outcome.hasOwnPassword
            ? passwordGiven
              ? 'Signs in with their own password (unchanged)'
              : 'Signs in with their own password'
            : idp
              ? `Signs in with ${idp}`
              : 'Can sign in already';
      if (outcome.roleError) return `${access}: couldn’t make them an admin (${outcome.roleError})`;
      if (outcome.promoted) return `${access}, now an admin`;
      if (outcome.alreadyAdmin) return `${access}, already an admin`;
      return access;
    }
    case 'no-seat':
    case 'error':
      return outcome.message;
  }
}

const INTRO = 'I’ve added you to our workspace, where we keep what our AI agents should know about the company.';

/**
 * The message to forward, saying how to sign in on this deployment. Never
 * the password: when one was set, it tells them it comes separately.
 */
function inviteMessage(origin: string, how: { idp: string; passwordSet: boolean; passwordSignIn: boolean }): string {
  const { idp, passwordSet, passwordSignIn } = how;
  if (passwordSet && idp) {
    return `${INTRO} Sign in at ${origin} with ${idp}, or with your work email and the password I’ll send you separately (change it on your Account page). Then connect your agent from the welcome page.`;
  }
  if (passwordSet) {
    return `${INTRO} Sign in at ${origin} with your work email and the password I’ll send you separately. Then change it on your Account page and connect your agent from the welcome page.`;
  }
  if (idp) return `${INTRO} Sign in at ${origin} with ${idp}, then connect your agent from the welcome page.`;
  if (passwordSignIn) {
    return `${INTRO} Sign in at ${origin} with your work email and your password, then connect your agent from the welcome page.`;
  }
  return `${INTRO} Sign in with your work account at ${origin}, then connect your agent from the welcome page.`;
}

function InvitedBody({
  outcomes,
  invited,
  methods,
}: {
  outcomes: InviteOutcome[];
  invited: number;
  methods: LoginProviders | null;
}) {
  const { user } = useAuth();
  const origin = window.location.origin;
  const idp = either(methods?.sso.map((p) => p.label) ?? []);
  // Some account was given the starting password in this send.
  const passwordSet = outcomes.some(gotPassword);
  // The send carried a password, whoever ended up with it.
  const passwordGiven = passwordSet || outcomes.some((o) => o.status === 'existing' && o.passwordError);
  const message = inviteMessage(origin, { idp, passwordSet, passwordSignIn: Boolean(methods?.password) });

  return (
    <div className="flex flex-col gap-4 py-1">
      <p className="text-detail text-ink-muted">
        {invited === 0
          ? 'No accounts were created. The reason is on each row.'
          : passwordSet
            ? 'They can sign in now. Send them the link and the password.'
            : idp
              ? `They can sign in now with ${idp}. Send them the link.`
              : 'Their accounts are ready. Send them the link so they know to sign in.'}
      </p>
      <ul aria-label="People" className="flex flex-col divide-y divide-line">
        {user && (
          <PersonRow
            label={`${user.name} (you)`}
            detail={user.email}
            badge={<Badge>Admin</Badge>}
            strong
          />
        )}
        {outcomes.map((outcome) => {
          const badge = outcomeBadge(outcome);
          return (
            <PersonRow
              key={outcome.email}
              label={outcome.email}
              detail={outcomeDetail(outcome, idp, passwordGiven)}
              badge={<Badge tone={badge.tone}>{badge.label}</Badge>}
            />
          );
        })}
      </ul>
      {invited > 0 && (
        <>
          {passwordSet && (
            <Banner tone="wait" role="status" icon={<KeyRound size={16} aria-hidden />}>
              <span className="font-semibold">Send them the password you set, separately.</span> It isn’t in the
              message below, so the message is safe to post in a shared channel.
            </Banner>
          )}
          <CopyRow label="Where they sign in" text={origin} copyLabel="Copy link" mono />
          <CopyRow label="Or send this message" text={message} copyLabel="Copy message" />
        </>
      )}
    </div>
  );
}

function PersonRow({
  label,
  detail,
  badge,
  strong = false,
}: {
  label: string;
  detail: string;
  badge: ReactNode;
  strong?: boolean;
}) {
  return (
    <li className="flex items-center gap-2.5 py-2">
      <span
        aria-hidden
        className="flex size-[26px] flex-none items-center justify-center rounded-full border border-line bg-sunken text-micro font-bold text-ink-muted"
      >
        {initials(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-ui text-ink ${strong ? 'font-semibold' : ''}`}>
          {label}
        </span>
        <span className="block truncate text-meta text-ink-faint" title={detail}>
          {detail}
        </span>
      </span>
      {badge}
    </li>
  );
}

/**
 * Text to hand on, with its own copy button. The result is said on the
 * button, and a failed copy says what to do instead — the text is on screen
 * to select by hand.
 */
function CopyRow({
  label,
  text,
  copyLabel,
  mono = false,
}: {
  label: string;
  text: string;
  copyLabel: string;
  mono?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-detail font-medium text-ink">
        {label}
      </span>
      <div className="flex items-stretch overflow-hidden rounded-md border border-line bg-sunken">
        <p
          aria-labelledby={labelId}
          className={`min-w-0 flex-1 px-3 py-2 text-detail text-ink ${mono ? 'truncate font-mono' : 'whitespace-pre-wrap'}`}
        >
          {text}
        </p>
        <button
          type="button"
          onClick={() => {
            void copyToClipboard(text).then((ok) => setState(ok ? 'copied' : 'failed'));
          }}
          className="flex-none border-l border-line bg-surface px-3 text-detail font-medium text-ink hover:bg-hover"
        >
          {state === 'copied' ? 'Copied' : copyLabel}
        </button>
      </div>
      <span role="status" aria-live="polite" className="text-meta text-ink-faint empty:hidden">
        {state === 'failed' ? 'Couldn’t copy: select the text and copy it yourself.' : ''}
      </span>
    </div>
  );
}
