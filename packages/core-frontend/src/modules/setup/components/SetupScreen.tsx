import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Banner, Button, Surface, TextField } from '../../../shared/components';
import { tokenUsernameForHost } from '../utils/git-host';
import {
  saveSettings,
  syncNow,
  testConnection,
  SettingsProblems,
  type ConnectionTest,
  type LastSync,
  type SettingStatus,
  type SyncNowResult,
  type SyncStatus,
} from '../services/setup.api';

/** A value to paste elsewhere, with the one button such a value needs. */
function CopyValue({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    const done = (next: 'copied' | 'failed') => {
      setState(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 1500);
    };
    // The clipboard can be missing (an insecure context) or refuse; say so on
    // the button rather than pretending.
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) return done('failed');
    clipboard.writeText(value).then(() => done('copied'), () => done('failed'));
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 break-all rounded bg-surface px-2 py-1 font-mono text-meta text-ink">
        {value}
      </code>
      <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={label}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}
      </Button>
    </div>
  );
}

/** "main updated, ali/x up to date" — the per-branch outcomes as one phrase. */
function describeOutcomes(results: LastSync['results']): string {
  if (results.length === 0) return 'nothing to sync yet';
  return results
    .map((r) => `${r.branch} ${r.outcome === 'up-to-date' ? 'up to date' : r.outcome.replace('-', ' ')}`)
    .join(', ');
}

/** Copy for each setting: what it is, in the words of someone who has to fill it in. */
const FIELDS: Record<
  string,
  { label: string; help: string; placeholder?: string; advanced?: boolean }
> = {
  kbRepoUrl: {
    label: 'Repository address',
    help: 'Where your knowledge, skills and tools are stored. Copy the address from your repository page: GitHub, GitLab, Bitbucket and Azure DevOps all work. A brand-new empty repository is fine.',
    placeholder: 'https://github.com/acme/knowledge-base.git',
  },
  gitToken: {
    label: 'Access token',
    help: 'Lets this deployment read and write that repository. Create one in your git provider with read and write access to it. Stored encrypted, and never shown again.',
    placeholder: 'Paste the token',
  },
  gitUsername: {
    // NOT a person's username — the previous label said "Token username" and
    // people read it as their own account. It is a fixed string each host
    // expects beside a token, so it is filled in automatically and only
    // surfaces under Advanced for hosts we cannot recognise.
    label: 'Token username',
    help: 'A fixed value the git host expects next to the token, not your account name. Filled in automatically for known hosts; only change it for a self-hosted server.',
    placeholder: 'x-access-token',
    advanced: true,
  },
  kbDirName: {
    label: 'Folder name',
    help: 'What the repository folder is called inside each workspace. Cosmetic; leave it as it is.',
    placeholder: 'knowledge-base',
    advanced: true,
  },
  kbSyncSecret: {
    label: 'Sync secret',
    help: 'Lets your git host tell this deployment when the repository changes, so pushes and merged pull requests show up right away. Add a webhook, action or pipeline step that calls POST /api/sync/<branch> with this value as a bearer token. Optional: without it, only an administrator can trigger a sync. Stored encrypted, and never shown again.',
    placeholder: 'A long random string',
    advanced: true,
  },
  defaultBranch: {
    label: 'Main branch',
    help: 'The version everyone sees. Filled in from your repository when you test the connection.',
    placeholder: 'main',
    advanced: true,
  },
  protectedBranches: {
    label: 'Branches that need approval',
    help: 'Nobody can change these directly; edits arrive as a request someone approves. Separate several with commas. The main branch has to be one of them.',
    placeholder: 'main',
    advanced: true,
  },
  oidcIssuerUrl: {
    label: 'Provider address',
    help: 'From your identity provider. Entra, Okta, Google Workspace, Auth0 and others all publish one.',
    placeholder: 'https://login.microsoftonline.com/<tenant>/v2.0',
  },
  oidcClientId: {
    label: 'Application ID',
    help: 'From the application you registered with the provider.',
  },
  oidcClientSecret: {
    label: 'Application secret',
    help: 'Issued alongside the application ID. Stored encrypted, and never shown again.',
  },
  oidcScopes: {
    label: 'Scopes',
    help: 'Leave blank unless your provider asked for something specific.',
    placeholder: 'openid profile email',
    advanced: true,
  },
  oidcProviderLabel: {
    label: 'Sign-in button text',
    help: 'What the button on the sign-in page says.',
    placeholder: 'Single sign-on',
    advanced: true,
  },
  allowedEmailDomains: {
    label: 'Allowed email domains',
    help: 'Only people with an address at these domains can sign in this way. Separate several with commas. Leave blank to allow any address: safe with a provider that only serves your organisation, risky with one that does not.',
    placeholder: 'example.com',
  },
};

/**
 * What the deployment cannot start without — the same four the server's
 * `isComplete` checks. Named here so a save that lands but leaves setup
 * unfinished can say WHICH answer is still missing, rather than returning a
 * blank form and letting the reader guess.
 */
const REQUIRED_KEYS = ['kbRepoUrl', 'gitToken', 'defaultBranch', 'protectedBranches'];

/**
 * The answers a connection test actually proves — the address, the credential
 * and the name that goes beside it.
 *
 * Editing one invalidates the result on screen, because it described the old
 * ones. Editing anything ELSE leaves it standing: whether a repository is
 * reachable has nothing to do with an identity provider's scopes, and clearing
 * it there would ask an admin to prove the same repository twice.
 */
const CONNECTION_KEYS = ['kbRepoUrl', 'gitToken', 'gitUsername'];

/** The blocks, in the order they are worked through. */
const SECTIONS: { id: SettingStatus['section']; title: string; blurb: string }[] = [
  {
    id: 'knowledge-base',
    title: 'Knowledge, skills & tools',
    blurb:
      'Where everything lives, together in one git repository: knowledge, skills and tools. Connect one (an empty repository is fine, it will be set up for you) and test it; the rest fills itself in.',
  },
  {
    id: 'sign-in',
    title: 'Single sign-on',
    blurb:
      'Optional, and you can add it later. Lets people sign in with the account they already have instead of a password.',
  },
];

interface Props {
  settings: SettingStatus[];
  /** Re-read the status after a save, so the gate can let the app through. */
  onSaved(): void;
  /**
   * Where the screen is standing. `setup` (the default) is the first-run
   * gate: full-page chrome, its own heading. `settings` is the SAME form
   * embedded in the admin Deployment page — the host owns the chrome and the
   * words around it, so the wrapper and heading stay out of the way. One
   * component on purpose: the fields, the env-lock rule, the connection test
   * and the restart banners must never drift between first run and later.
   */
  variant?: 'setup' | 'settings';
  /**
   * The remote-sync facts to show beside the sync secret: the address a hook
   * calls, and what the last call did. Absent on a build without the module.
   */
  sync?: SyncStatus;
}

/**
 * First-run setup: the one screen standing between a fresh deployment and a
 * working one.
 *
 * WHY IT EXISTS AT ALL. Every value here used to be an environment variable
 * that had to be right before the server would start — which meant the first
 * feedback on a wrong token was a failed clone some minutes later, in a log.
 * A form can do the thing an environment variable never can: ask the remote
 * whether the answer is right, and say which part was wrong.
 *
 * WHAT IT DOES NOT DO. It never displays a stored secret, and it does not let
 * anyone overwrite a value the environment supplies — those fields render as
 * locked, naming the variable to change instead. That keeps a browser from
 * silently outranking the infrastructure config someone is reviewing in a
 * repo, which is the same rule the server enforces.
 */
export function SetupScreen({ settings, onSaved, variant = 'setup', sync }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  /** What the last "Sync now" from THIS page came back with (a failure to ask is `error`). */
  const [syncResult, setSyncResult] = useState<SyncNowResult | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  /** Required answers still missing after a save that otherwise succeeded. */
  const [stillMissing, setStillMissing] = useState<string[]>([]);
  /** Answered, yet this process is still running on the old branch model. */
  const [needsRestart, setNeedsRestart] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  /**
   * Which set of connection answers the screen is showing, bumped on every
   * edit to one of them. A test result describes the answers as they were when
   * the request left; if they changed while it was in flight, the result that
   * comes back is evidence about values no longer on screen and must not be
   * shown as if it were about the new ones.
   */
  const connectionEpoch = useRef(0);

  /**
   * What a field would save as, given a set of typed answers: what is in them,
   * else what is already stored. Taken over a payload rather than the draft
   * alone so a submit can ask about values it has just derived, which `draft`
   * will not hold until the next render.
   */
  const resolvedIn = (typed: Record<string, string>, key: string) =>
    (typed[key] ?? settings.find((s) => s.key === key)?.value ?? '').trim();

  /** What a field would save as: what was typed, else what is already stored. */
  const resolved = (key: string) => resolvedIn(draft, key);

  const editable = settings.filter((s) => s.source !== 'env');
  const fromEnv = settings.filter((s) => s.source === 'env');

  /**
   * Whether saving now would actually change this connection field: something
   * non-blank was typed, and it is not the stored value typed back in. Secrets
   * have no stored value to show, so any non-blank entry counts as a change —
   * which is right, because it replaces the stored one.
   */
  const connectionKeyChanged = (key: string) => {
    const typed = draft[key]?.trim();
    if (!typed) return false;
    return typed !== (settings.find((s) => s.key === key)?.value ?? '').trim();
  };

  /**
   * Whether THIS save has to stand behind the repository connection.
   *
   * On first run it always does: everything behind the gate reads from a
   * repository that has to be reachable, and the save that finishes setup is
   * what opens that gate. On the Deployment page only a save that CHANGES the
   * connection does — an admin editing single sign-on has no repository to
   * re-prove, and refusing them over a token that expired somewhere else helps
   * nobody.
   *
   * "Changes" means the value the save would store differs from the stored
   * one — a field someone touched and then restored changes nothing, and a
   * blank field means "leave it alone", not "clear it". Judging by "was it
   * typed in" held saves hostage to edits that no longer exist.
   *
   * There is nothing to prove until there is an address to prove it against; a
   * blank form is the server's to complain about, field by field.
   */
  const mustProveConnection =
    !!resolved('kbRepoUrl') &&
    (variant === 'setup' || CONNECTION_KEYS.some((key) => connectionKeyChanged(key)));

  /**
   * The host was asked about the answers currently on screen, and said no.
   * Editing any of them clears the result, so this is never about a value the
   * reader has already changed.
   */
  const connectionRejected = mustProveConnection && test?.ok === false;

  function set(key: string, value: string) {
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // Typing the repository address answers the token-username question, so
      // it is not asked. Only filled while the operator has not set one
      // themselves — a self-hosted server they typed a value for must not be
      // overwritten by a guess from its domain.
      if (key === 'kbRepoUrl' && !d.gitUsername) {
        const known = tokenUsernameForHost(value);
        if (known) next.gitUsername = known.username;
      }
      return next;
    });
    // The message described the old value; keeping it beside a new one would
    // be a complaint about something the reader already fixed.
    setProblems((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (CONNECTION_KEYS.includes(key)) {
      // Any in-flight test is now asking about values that are gone; the epoch
      // bump makes its answer land as stale rather than as evidence.
      connectionEpoch.current++;
      setTest(null);
    }
  }

  /**
   * Which branch the repository just named, or the best conventional stand-in.
   *
   * Prefer what the remote calls its trunk. Not every host advertises it —
   * older servers answer `ls-remote` without the symref line — so fall back to
   * the conventional names before the first branch it did list. Leaving these
   * blank is the one way a save can succeed and still not finish setup, which
   * is worth a guess the reader can see and correct.
   */
  function suggestedBranch(result: ConnectionTest): string | null {
    return (
      result.defaultBranch ||
      ['main', 'master', 'trunk'].find((name) => result.branches?.includes(name)) ||
      result.branches?.[0] ||
      // An EMPTY repository has no branch to report, but it will be seeded
      // with whatever is configured here, so the conventional name is the
      // right suggestion. Suggesting nothing was the one way "Connected"
      // could still end, silently, in a save that did not finish setup.
      (result.empty ? 'main' : null)
    );
  }

  /**
   * Ask the remote, record what it said, and fill the version fields in from
   * it. The repository has just said what it calls its trunk and which
   * branches it has; filling those in beats asking someone to remember, and
   * beats the silent failure of a name that is one character off. Only into
   * fields nobody has answered — never over a name somebody typed.
   *
   * ONE function for both callers — the Test button, and a Save that has to
   * prove the connection before storing it — because two copies of "which
   * branch did it name?" is how the two answers drift apart. It returns what
   * it derived as well as the result, so a submit can use both without waiting
   * for a re-render.
   */
  async function probeConnection(): Promise<{
    result: ConnectionTest;
    derived: Record<string, string>;
  }> {
    const epoch = connectionEpoch.current;
    const result = await testConnection(draft);
    // Read the answer BEFORE storing it, so a response that is not one at all
    // throws to the caller (which treats that as "could not ask") instead of
    // parking a value in state that every reader downstream has to defend
    // against.
    const suggested = result.ok ? suggestedBranch(result) : null;
    // The result describes the connection values captured above. If they were
    // edited while the request was in flight, showing it would let the OLD
    // values' success (or failure) stand in for the new ones — so it is
    // returned to the caller, whose payload is the same snapshot, but never
    // shown. `derived` is likewise computed against that snapshot, because it
    // travels with the payload.
    const stale = epoch !== connectionEpoch.current;
    if (!stale) setTest(result);
    const derived: Record<string, string> = {};
    if (suggested) {
      if (!resolved('defaultBranch')) derived.defaultBranch = suggested;
      if (!resolved('protectedBranches')) derived.protectedBranches = suggested;
    }
    if (!stale && suggested) {
      // Re-check against the LATEST draft, not the snapshot: a branch name
      // typed while the request was in flight is an answer, and a suggestion
      // must never overwrite an answer.
      setDraft((d) => {
        const next = { ...d };
        if (!resolvedIn(d, 'defaultBranch')) next.defaultBranch = suggested;
        if (!resolvedIn(d, 'protectedBranches')) next.protectedBranches = suggested;
        return next;
      });
    }
    return { result, derived };
  }

  async function runTest() {
    setTesting(true);
    setError(null);
    const epoch = connectionEpoch.current;
    try {
      await probeConnection();
    } catch (err) {
      // A FAILURE goes stale the same way a success does: if the connection
      // was edited while this request was out, the error describes values no
      // longer on screen, and showing it would complain about something the
      // reader already changed.
      if (epoch === connectionEpoch.current) {
        setError(err instanceof Error ? err.message : 'Could not test the connection.');
      }
    } finally {
      setTesting(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      setSyncResult(await syncNow());
      // The status carries the last-sync record; refetch so it shows this one.
      onSaved();
    } catch (err) {
      setSyncResult({
        ok: false,
        results: [],
        error: err instanceof Error ? err.message : 'Could not sync.',
      });
    } finally {
      setSyncing(false);
    }
  }

  /**
   * Beside the sync secret: the address a hook calls (in both variants — an
   * admin wiring a hook needs it before first run too), and once the
   * deployment is live, what the last call did plus a button to make one.
   */
  function renderSyncPanel() {
    if (!sync) return null;
    const last = sync.last;
    return (
      <Surface tone="surface" radius="md" className="mt-3 space-y-3 border border-line p-3">
        <div className="space-y-1.5">
          <span className="text-meta font-medium text-ink">Address for the hook</span>
          <CopyValue value={`${sync.url}/<branch>`} label="Copy the sync address" />
          <p className="text-meta text-ink-faint">
            Replace <code className="font-mono">&lt;branch&gt;</code> with the branch that changed;
            send the secret as a bearer token.
          </p>
        </div>
        {variant === 'settings' && (
          <div className="space-y-2">
            <p role="status" className="text-meta text-ink-muted">
              {last
                ? `Last sync ${new Date(last.at).toLocaleString()} by ${last.by}: ${describeOutcomes(last.results)}.`
                : 'No sync since this server started.'}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runSync()}
                disabled={syncing}
              >
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
              <span className="text-meta text-ink-faint">
                Pulls every branch from the repository with your own session — the same thing the
                hook does.
              </span>
            </div>
            {syncResult && (
              <p role="status" className={`text-detail ${syncResult.ok ? 'text-ok' : 'text-danger'}`}>
                {syncResult.error
                  ? syncResult.error
                  : syncResult.ok
                    ? `Synced: ${describeOutcomes(syncResult.results)}.`
                    : (syncResult.results.find((r) => r.error)?.error ??
                      `Not fully synced: ${describeOutcomes(syncResult.results)}.`)}
              </p>
            )}
          </div>
        )}
      </Surface>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setProblems({});
    // The list describes what the LAST completed save left unanswered. A new
    // attempt supersedes it — leaving it up put "Saved what you filled in, but
    // this deployment still needs…" directly above this attempt's "Not saved."
    setStillMissing([]);
    try {
      let payload = draft;
      /** What the host said this time, or null when it could not be asked. */
      let proven: ConnectionTest | null = test;
      let probed = false;
      const probe = async () => {
        probed = true;
        try {
          const { result, derived } = await probeConnection();
          proven = result;
          payload = { ...payload, ...derived };
        } catch {
          // The lookup itself failed — the endpoint is down, the request threw.
          // That is not evidence about the credentials, so nothing is concluded
          // from it and the save carries on: the server has the last word, and
          // a failed lookup is not an error the reader can act on.
          proven = null;
        }
      };

      if (mustProveConnection && !test?.ok) {
        // PROVE THE CONNECTION BEFORE STORING IT. The server's completeness
        // check asks only whether the answers are PRESENT — so a token the
        // host rejects finishes setup just as well as one it accepts, and the
        // gate opens onto an app whose every call fails against a repository
        // it cannot clone. This is the one moment that can tell the two apart.
        setTesting(true);
        await probe();
        setTesting(false);
        if (proven && !proven.ok) {
          setError(
            variant === 'setup'
              ? 'Not saved. Nothing behind this screen works until the repository answers, and it did not — fix the connection above and test it again.'
              : 'Not saved. The repository did not answer with those details — fix the connection above and test it again.',
          );
          return;
        }
      }

      // Someone who pressed Save without pressing Test has supplied everything
      // they can be expected to know; a branch name is something we can look
      // up, so refusing over it asks a question with a knowable answer. Only
      // when the remote has not already been asked this time round — the probe
      // above fills the same fields from the same answer.
      if (
        !probed &&
        (!resolvedIn(payload, 'defaultBranch') || !resolvedIn(payload, 'protectedBranches'))
      ) {
        await probe();
      }
      const result = await saveSettings(payload);
      setRestartRequired(result.restartRequired);
      setDraft({});
      // A save can succeed and STILL leave the deployment unusable: a blank
      // field means "leave it alone", not "this is wrong", so the server
      // accepts a batch that answers only some of what it needs. Saying so is
      // the difference between a form that looks broken and one that tells you
      // what is left.
      const missing = result.settings
        .filter((setting) => REQUIRED_KEYS.includes(setting.key) && !setting.configured)
        .map((setting) => FIELDS[setting.key]?.label ?? setting.key);
      setStillMissing(result.complete || result.awaitingRestart ? [] : missing);
      if (result.awaitingRestart) {
        setNeedsRestart(true);
        // The settings page still wants fresh status — the notice above says
        // what the restart is for; the form should show what was saved.
        if (variant === 'settings') onSaved();
        return;
      }
      if (result.complete && variant === 'setup') {
        // A FULL RELOAD, not just re-rendering the gate. The branch model the
        // browser holds was fetched before any of this existed, and every
        // module that reads it took its value then — so the app behind the
        // gate would build URLs for a branch called nothing. Reloading is the
        // one thing guaranteed to re-fetch it everywhere.
        //
        // SETUP MODE ONLY: on the settings page the app around the form is
        // already running against a fetched branch model, and yanking the
        // whole document out from under an admin who just pressed Save is
        // not a refresh, it is a punishment. Rare branch-model edits there
        // arrive with `restartRequired`, which the notice explains.
        window.location.reload();
        return;
      }
      onSaved();
    } catch (err) {
      if (err instanceof SettingsProblems) setProblems(err.problems);
      else setError(err instanceof Error ? err.message : 'Could not save these settings.');
    } finally {
      setSaving(false);
      // The page scrolls now, and every message lands at the top of it while
      // the button that produced them is at the bottom. Without this, pressing
      // Save on a long form looks like pressing Save did nothing.
      requestAnimationFrame(() => noticeRef.current?.scrollIntoView({ block: 'nearest' }));
    }
  }

  /**
   * Branch names the connection test found on the remote. Offered as
   * suggestions on the branch fields: these have to match the repository
   * EXACTLY, and a typo produces a deployment pointing at a branch nobody has —
   * which is precisely what a form can prevent and an environment variable
   * cannot.
   */
  const remoteBranches = test?.ok ? (test.branches ?? []) : [];

  function renderField(setting: SettingStatus) {
    const copy = FIELDS[setting.key];
    if (!copy) return null;
    const isBranchField = setting.key === 'defaultBranch' || setting.key === 'protectedBranches';
    const listId = isBranchField && remoteBranches.length > 0 ? `${setting.key}-options` : undefined;
    return (
      <div key={setting.key}>
        <label className="block space-y-1.5">
          <span className="text-detail font-medium text-ink">{copy.label}</span>
          <TextField
            type={setting.secret ? 'password' : 'text'}
            autoComplete={setting.secret ? 'new-password' : 'off'}
            placeholder={
              // A configured secret has no value to show, so the field says
              // what leaving it blank means instead.
              setting.secret && setting.configured ? 'Saved. Type to replace' : copy.placeholder
            }
            value={draft[setting.key] ?? (setting.secret ? '' : (setting.value ?? ''))}
            onChange={(e) => set(setting.key, e.target.value)}
            list={listId}
            aria-invalid={problems[setting.key] ? true : undefined}
            aria-describedby={problems[setting.key] ? `${setting.key}-problem` : undefined}
          />
        </label>
        {listId && (
          <datalist id={listId}>
            {remoteBranches.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        )}
        <p className="mt-1 text-meta text-ink-faint">{copy.help}</p>
        {setting.key === 'kbSyncSecret' && renderSyncPanel()}
        {/* Only AFTER setup: on first run there is nothing yet to lose, so
            the caution would be noise. Once a deployment is live, this field
            is the one whose careless edit strands everything. */}
        {variant === 'settings' && setting.key === 'kbRepoUrl' && (
          <p className="mt-1.5 text-meta text-ink-muted">
            <b className="font-semibold">
              Only change this if the same repository was moved or renamed.
            </b>{' '}
            Pointing it at a different repository does not carry anything over: the knowledge,
            skills and tools stay in the old one, and open change requests will stop working.
          </p>
        )}
        {problems[setting.key] && (
          <p id={`${setting.key}-problem`} role="alert" className="mt-1 text-meta text-danger">
            {problems[setting.key]}
          </p>
        )}
      </div>
    );
  }

  // `h-full`, NOT `min-h-full`. `#root` is `height: 100%; overflow: hidden`, so
  // a MINIMUM height lets this box grow past the viewport and be clipped there
  // — `overflow-y-auto` then scrolls nothing, because nothing bounds the height
  // it would scroll within. Being exactly the height of the root is what makes
  // the overflow this element's own to handle.
  return (
    <div className={variant === 'setup' ? 'h-full overflow-y-auto bg-sunken px-6 py-12' : ''}>
      <div className={variant === 'setup' ? 'mx-auto w-full max-w-2xl' : 'w-full max-w-2xl'}>
        {variant === 'setup' && (
          <>
            <h1 className="text-display font-semibold text-ink">Set up this deployment</h1>
            <p className="mt-2 max-w-[62ch] text-lede text-ink-muted">
              One thing is needed before anyone can use it: somewhere to keep your knowledge,
              skills and tools. Connect a repository below, test it, and the rest fills itself in.
              Single sign-on is optional and can wait.
            </p>
          </>
        )}

        <div ref={noticeRef}>
          {error && (
            <Banner tone="danger" role="alert" className="mt-6">
              {error}
            </Banner>
          )}

          {/* Saved, and still not usable. Without this the form empties itself
              and comes back looking untouched — indistinguishable from a save
              that silently failed. */}
          {needsRestart && (
            <Banner tone="wait" role="status" className="mt-6">
              Saved. This deployment needs a restart to pick the branch settings up; everything
              else is in place.
            </Banner>
          )}

          {stillMissing.length > 0 && (
            <Banner tone="wait" role="status" className="mt-6">
              Saved what you filled in, but this deployment still needs{' '}
              <b className="font-semibold">{stillMissing.join(', ')}</b> before anyone can use it.
              Test the connection and the version fields fill themselves in.
            </Banner>
          )}
        </div>

        {/* Only when setup is otherwise DONE. While it is not, the banner
            above is already asking for a restart for the same reason, and two
            notices saying "restart" differ only in urgency — which is exactly
            the distinction a reader would miss. */}
        {restartRequired && !needsRestart && (
          <Banner tone="wait" role="status" className="mt-6">
            Saved. One of those settings only takes effect when the server starts, so restart it
            when convenient.
          </Banner>
        )}

        <form onSubmit={submit} className="mt-8 space-y-10">
          {SECTIONS.map((section) => {
            const fields = editable.filter((s) => s.section === section.id);
            // A section whose every field comes from the environment has
            // nothing to offer — the locked list at the bottom already names
            // them, and an empty heading would read as something missing.
            if (fields.length === 0) return null;
            return (
              <Surface
                key={section.id}
                as="section"
                tone="surface"
                radius="lg"
                elevation="card"
                className="p-6 space-y-6"
              >
                <div>
                  <div className="flex items-baseline gap-2.5">
                    <h2 className="text-title font-semibold text-ink">{section.title}</h2>
                    {/* Says outright that a whole section can be skipped. The
                        gate only blocks on the knowledge base and the
                        versions, and someone who does not know that will fill
                        in an identity provider they do not have. */}
                    {section.id === 'sign-in' && (
                      <span className="text-meta text-ink-faint">Optional</span>
                    )}
                  </div>
                  <p className="mt-1 max-w-[60ch] text-detail text-ink-muted">{section.blurb}</p>
                  {section.id === 'sign-in' && (
                    <p className="mt-1.5 text-meta text-ink-faint">
                      Redirect URI:{' '}
                      <code className="font-mono">{`${window.location.origin}/api/auth/oidc/callback`}</code>
                    </p>
                  )}
                </div>
                {fields.filter((f) => !FIELDS[f.key]?.advanced).map((f) => renderField(f))}

                {/* Immediately under the two fields it proves, and above the
                    Advanced block it fills in — the middle of the sequence
                    someone actually performs. It used to sit after every
                    section, so the answer to "did I type the token right?"
                    was below the identity-provider questions and, once the
                    page grew, below the fold entirely. */}
                {section.id === 'knowledge-base' && (
                  <Surface tone="sunken" radius="md" className="p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void runTest()}
                        // Also while SAVING: a save may be asking the remote
                        // itself, and a second test racing it would overwrite
                        // both the result and the versions derived from it.
                        disabled={testing || saving}
                      >
                        {testing ? 'Checking…' : 'Test connection'}
                      </Button>
                      <span className="text-meta text-ink-faint">
                        Checks the address and token against the host, and fills in the versions
                        below.
                      </span>
                    </div>
                    {test && (
                      <p
                        role="status"
                        className={`mt-3 text-detail ${test.ok ? 'text-ok' : 'text-danger'}`}
                      >
                        {test.ok
                          ? test.empty
                            ? 'Connected. The repository is empty; it will be set up for you on first use, and the version fields below are filled in with the standard name.'
                            : `Connected. Found ${test.branches?.length ?? 0} branch${
                                test.branches?.length === 1 ? '' : 'es'
                              }.`
                          : test.error}
                      </p>
                    )}
                  </Surface>
                )}

                {/* Everything a normal setup never touches, out of the way but
                    not hidden: a self-hosted git server does need the token
                    username, and a provider with unusual scopes does need
                    those. Closed by default, because leaving them open makes a
                    two-field form look like a seven-field one. */}
                {fields.some((f) => FIELDS[f.key]?.advanced) && (
                  <details
                    // Forced open when something inside it is wrong. The branch
                    // pair lives here and the server validates it as a pair, so
                    // a message about it could otherwise land in a box the
                    // reader has no reason to open — a form that refuses to
                    // save and will not say why.
                    open={fields.some(
                      (f) =>
                        FIELDS[f.key]?.advanced &&
                        (problems[f.key] || stillMissing.includes(FIELDS[f.key]?.label ?? '')),
                    )}
                    className="group rounded-md border border-line bg-sunken px-3.5 py-2.5"
                  >
                    <summary className="cursor-pointer list-none text-detail font-medium text-ink-muted marker:hidden hover:text-ink">
                      Advanced
                      <span className="ml-1.5 text-meta text-ink-faint">
                        (sensible defaults; open only if you need to change one)
                      </span>
                    </summary>
                    <div className="mt-4 space-y-6">
                      {fields.filter((f) => FIELDS[f.key]?.advanced).map((f) => renderField(f))}
                    </div>
                  </details>
                )}
              </Surface>
            );
          })}


          {/* A rejected connection stops here rather than at the far side of
              it. Saving these answers would finish setup — the server checks
              that they are present, not that they work — and open the app onto
              a repository it cannot reach, which reads as a broken product
              rather than a wrong token. */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              disabled={saving || testing || connectionRejected}
              // Described by the refusal, so a reader who lands on a button
              // that will not move is told why rather than left guessing.
              aria-describedby={connectionRejected ? 'connection-refusal' : undefined}
            >
              {saving ? 'Saving…' : 'Save and continue'}
            </Button>
            {connectionRejected && (
              // Not a live region: the test panel above already announced the
              // host's own words, and the save banner announces a blocked
              // attempt. This is the label for a button that will not move.
              <span id="connection-refusal" className="text-meta text-danger">
                The repository turned that connection down. Fix it above and test again.
              </span>
            )}
          </div>
        </form>

        {fromEnv.length > 0 && (
          <Surface tone="sunken" radius="md" className="mt-10 p-4">
            <h2 className="text-label font-semibold uppercase text-ink-faint">
              Set by the environment
            </h2>
            <p className="mt-1.5 text-meta text-ink-muted">
              These already have a value from this deployment&apos;s configuration, which takes
              precedence over anything saved here. Change them where they are set.
            </p>
            <ul className="mt-3 space-y-1">
              {fromEnv.map((s) => (
                <li key={s.key} className="font-mono text-meta text-ink-muted">
                  {s.envVar}
                </li>
              ))}
            </ul>
          </Surface>
        )}
      </div>
    </div>
  );
}
