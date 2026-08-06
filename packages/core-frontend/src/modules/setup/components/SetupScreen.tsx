import { useState, type FormEvent } from 'react';
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
export function SetupScreen({ settings, onSaved }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

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
      if (result.ok && result.defaultBranch) {
        setDraft((d) => ({
          ...d,
          defaultBranch: d.defaultBranch || result.defaultBranch!,
          protectedBranches: d.protectedBranches || result.defaultBranch!,
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not test the connection.');
    } finally {
      setTesting(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setProblems({});
    try {
      const result = await saveSettings(draft);
      setRestartRequired(result.restartRequired);
      setDraft({});
      onSaved();
    } catch (err) {
      if (err instanceof SettingsProblems) setProblems(err.problems);
      else setError(err instanceof Error ? err.message : 'Could not save these settings.');
    } finally {
      setSaving(false);
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
    <div className="h-full overflow-y-auto bg-sunken px-6 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-display font-semibold text-ink">Set up this deployment</h1>
        <p className="mt-2 max-w-[62ch] text-lede text-ink-muted">
          One thing is needed before anyone can use it: somewhere to keep the knowledge base.
          Connect a repository below, test it, and the rest fills itself in. Single sign-on is
          optional and can wait.
        </p>

        {error && (
          <Banner tone="danger" role="alert" className="mt-6">
            {error}
          </Banner>
        )}

        {restartRequired && (
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
                    open={fields.some((f) => FIELDS[f.key]?.advanced && problems[f.key])}
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

          {/* The point of the screen: prove the answer before committing to it. */}
          <Surface tone="surface" radius="md" className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => void runTest()} disabled={testing}>
                {testing ? 'Checking…' : 'Test connection'}
              </Button>
              <span className="text-meta text-ink-faint">
                Asks the host whether the URL, token and username work together.
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
