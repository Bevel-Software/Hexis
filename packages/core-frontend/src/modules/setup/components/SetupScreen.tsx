import { useRef, useState, type FormEvent } from 'react';
import { Banner, Button, Surface, TextField } from '../../../shared/components';
import { tokenUsernameForHost } from '../utils/git-host';
import {
  saveSettings,
  testConnection,
  SettingsProblems,
  type ConnectionTest,
  type SettingStatus,
} from '../services/setup.api';

/** Copy for each setting: what it is, in the words of someone who has to fill it in. */
const FIELDS: Record<
  string,
  { label: string; help: string; placeholder?: string; advanced?: boolean }
> = {
  kbRepoUrl: {
    label: 'Repository address',
    help: 'Where your knowledge base is stored. Copy the address from your repository page — GitHub, GitLab, Bitbucket and Azure DevOps all work. A brand-new empty repository is fine.',
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
    help: 'A fixed value the git host expects next to the token — not your account name. Filled in automatically for known hosts; only change it for a self-hosted server.',
    placeholder: 'x-access-token',
    advanced: true,
  },
  kbDirName: {
    label: 'Folder name',
    help: 'What the knowledge base folder is called. Cosmetic — leave it as it is.',
    placeholder: 'knowledge-base',
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
    help: 'Nobody can change these directly — edits arrive as a request someone approves. Separate several with commas. The main branch has to be one of them.',
    placeholder: 'main',
    advanced: true,
  },
  oidcIssuerUrl: {
    label: 'Provider address',
    help: 'From your identity provider — Entra, Okta, Google Workspace, Auth0 and others all publish one.',
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
    help: 'Only people with an address at these domains can sign in this way. Separate several with commas. Leave blank to allow any address — safe with a provider that only serves your organisation, risky with one that does not.',
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

/** The blocks, in the order they are worked through. */
const SECTIONS: { id: SettingStatus['section']; title: string; blurb: string }[] = [
  {
    id: 'knowledge-base',
    title: 'Knowledge base',
    blurb:
      'Where everything is stored. Connect a git repository — an empty one is fine, it will be set up for you — and test it; the rest fills itself in.',
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
export function SetupScreen({ settings, onSaved, variant = 'setup' }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
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

  /** What a field would save as: what was typed, else what is already stored. */
  const resolved = (key: string) =>
    (draft[key] ?? settings.find((s) => s.key === key)?.value ?? '').trim();

  const editable = settings.filter((s) => s.source !== 'env');
  const fromEnv = settings.filter((s) => s.source === 'env');

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
    setTest(null);
  }

  async function runTest() {
    setTesting(true);
    setError(null);
    try {
      const result = await testConnection(draft);
      setTest(result);
      // The repository has just said what it calls its trunk and which
      // branches it has. Filling those in beats asking someone to remember —
      // and beats the silent failure of a name that is one character off.
      // Only into fields nobody has typed in.
      // Prefer what the remote calls its trunk. Not every host advertises it —
      // older servers answer `ls-remote` without the symref line — so fall back
      // to the conventional names before the first branch it did list. Leaving
      // these blank is the one way a save can succeed and still not finish
      // setup, which is worth a guess the reader can see and correct.
      const suggested =
        result.defaultBranch ||
        ['main', 'master', 'trunk'].find((name) => result.branches?.includes(name)) ||
        result.branches?.[0] ||
        null;
      if (result.ok && suggested) {
        setDraft((d) => ({
          ...d,
          defaultBranch: d.defaultBranch || suggested,
          protectedBranches: d.protectedBranches || suggested,
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not test the connection.');
    } finally {
      setTesting(false);
    }
  }

  /**
   * Ask the repository which branch to use, for someone who pressed Save
   * without pressing Test. They have supplied everything they can be expected
   * to know; a branch name is something we can look up, so refusing over it
   * asks a question with a knowable answer. Only when the lookup ALSO comes
   * back empty is the message worth showing.
   */
  async function deriveVersions(): Promise<Record<string, string> | null> {
    try {
      const result = await testConnection(draft);
      if (!result.ok) return null;
      const suggested =
        result.defaultBranch ||
        ['main', 'master', 'trunk'].find((name) => result.branches?.includes(name)) ||
        result.branches?.[0];
      if (!suggested) return null;
      setTest(result);
      const derived: Record<string, string> = {};
      if (!resolved('defaultBranch')) derived.defaultBranch = suggested;
      if (!resolved('protectedBranches')) derived.protectedBranches = suggested;
      setDraft((d) => ({ ...d, ...derived }));
      return derived;
    } catch {
      // The save carries on and the server says what is missing — a failed
      // lookup is not itself an error the reader can act on.
      return null;
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setProblems({});
    try {
      let payload = draft;
      if (!resolved('defaultBranch') || !resolved('protectedBranches')) {
        const derived = await deriveVersions();
        if (derived) payload = { ...draft, ...derived };
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
        return;
      }
      if (result.complete) {
        // A FULL RELOAD, not just re-rendering the gate. The branch model the
        // browser holds was fetched before any of this existed, and every
        // module that reads it took its value then — so the app behind the
        // gate would build URLs for a branch called nothing. Reloading is the
        // one thing guaranteed to re-fetch it everywhere.
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
              setting.secret && setting.configured ? 'Saved — type to replace' : copy.placeholder
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
              One thing is needed before anyone can use it: somewhere to keep the knowledge base.
              Connect a repository below, test it, and the rest fills itself in. Single sign-on is
              optional and can wait.
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
              Saved. This deployment needs a restart to pick the branch settings up — everything
              else is in place.
            </Banner>
          )}

          {stillMissing.length > 0 && (
            <Banner tone="wait" role="status" className="mt-6">
              Saved what you filled in — but this deployment still needs{' '}
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
                        disabled={testing}
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
                            ? 'Connected. The repository is empty — it will be set up for you on first use.'
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
                        — sensible defaults; open only if you need to change one
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


          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save and continue'}
            </Button>
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
