import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { Banner, Button, buttonClasses } from '../../../../shared/components';
import { useWorkspace } from '../../../workspace/state/workspace.context';
import { useAuth } from '../../../auth/state/auth.context';
import { kbFileUrl } from '../../../workspace/routing/kb-routes';
import { checkToolConnection, type ToolSecrets } from '../../../secrets-vault/services/tool-secrets.api';
import { pathForTool } from '../../routes/library-paths';
import { toolStatus, toolVariableStatuses } from '../../utils/status';
import { ToolVarRow } from './ToolVarRow';
import { queueProbe } from './probe-queue';

/**
 * "Your connection" — what this tool still needs from you, and (if you own it)
 * from you on everyone's behalf.
 *
 * The setup banner above the rows exists because `oauth-manual` is the one
 * state the rows CANNOT explain on their own: the remote server wants a sign-in
 * through an app the OWNER registers, so every row underneath is stuck through
 * no fault of the person reading them. The banner names whose move it is — the
 * owner's — and what the move is: declare the sign-in (the server editor on
 * this page for an mcp.json server, the file itself for a `.tool`), then set
 * its client secret. Once declared, only the secret remains and it says so.
 */

export interface ToolConnectionSectionProps {
  tool: ToolSecrets;
  /** A write landed — the caller refetches so the chips catch up. */
  onChanged(): void;
  onError(message: string): void;
}

export function ToolConnectionSection({ tool, onChanged, onError }: ToolConnectionSectionProps) {
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();
  const { user } = useAuth();
  /** `{varName, n}` — bumping `n` opens that variable's editor from the banner. */
  const [edit, setEdit] = useState<{ name: string; n: number }>({ name: '', n: 0 });
  const [checking, setChecking] = useState(false);

  const setupKind = tool.setup?.kind ?? null;
  // Not just "kind is oauth-manual": once the owner declares the provider and
  // saves its secret, the same tool is a normal sign-in and the banner is noise.
  // No oauth variable at all is the un-started case, so it counts as unfinished.
  const setupUnfinished =
    setupKind === 'oauth-manual' && !tool.variables.some((v) => v.oauth && v.adminConfigured);
  // Declared but not yet finished: the client id is in the file, the secret
  // isn't in the vault. Different sentence — "set the secret", not "declare".
  const signInDeclared = tool.variables.some((v) => v.oauth);
  // An mcp.json server is edited in the server section of THIS page; only a
  // `.tool` manual sends the owner to a file.
  const isMcpJsonServer = tool.path.endsWith('/mcp.json');

  /**
   * The CONFIGURATION this tool is still missing, named.
   *
   * Only configuration gaps earn the amber banner: keys nobody has entered,
   * owner-side setup nobody has finished. A pending sign-in on a fully
   * configured provider is deliberately NOT here — the row right below says
   * "Needs your sign-in" with its own Sign in button, and a banner repeating
   * both is the same sentence twice with two identical buttons. Configuration
   * is the state of the TOOL; signing in is a step each PERSON takes, and the
   * row is where personal steps live.
   */
  const missing = toolVariableStatuses(tool).filter(
    ({ v, status }) => status.state !== 'ok' && !(v.oauth && v.adminConfigured),
  );

  /**
   * The banner's one action — the first missing key the READER can enter.
   *
   * Saying "Needs a key from you" and making the reader hunt for where to put
   * it is a treasure map; the banner carries the shovel: the button opens (and
   * scrolls to) the row's editor. An admin-scope gap for a non-writer yields
   * no button, because the honest button would be "go ask someone else" —
   * and an unconfigured sign-in provider is exactly that case too.
   */
  const actionable = missing.find(
    ({ v }) => !v.oauth && (v.scope === 'user' || tool.canWrite),
  );

  // The aria-label carries the variable so the banner's button and the row's
  // never share an accessible name — same words to the eye, distinct to a
  // screen reader and to the tests.
  const bannerAction = actionable ? (
    <Button
      variant="primary"
      size="sm"
      aria-label={`${actionable.v.scope === 'user' ? 'Add key' : 'Set key'}: ${
        actionable.v.label ?? actionable.v.name
      }`}
      onClick={() => setEdit((e) => ({ name: actionable.v.name, n: e.n + 1 }))}
    >
      {actionable.v.scope === 'user' ? 'Add key' : 'Set key'}
    </Button>
  ) : null;

  /**
   * The health line, shown only once every variable is provided.
   *
   * While something is still missing, the amber banner above already names it,
   * and a second line saying the connection is untested would be answering a
   * question nobody has reached yet. Once nothing is missing, this is the only
   * remaining question — and the one the badge used to answer by guessing.
   */
  const health = toolStatus(tool);
  // Every variable genuinely provided — NOT merely `missing.length === 0`, which
  // excludes a pending sign-in on a configured provider. A tool nobody has
  // signed into yet has no credential to test, and saying so would put a health
  // line above a row that already says "Needs your sign-in".
  // Vacuously true for a tool that declares no variables: a no-auth MCP server
  // has nothing to set up and is still worth probing — its handshake is exactly
  // the kind of thing that can be reachable one day and not the next.
  //
  // But `!setupUnfinished` first: an `oauth-manual` server whose sign-in nobody
  // has declared YET also has no variables, and `every([])` would call that
  // settled — offering Test connection and the words "No key needed" directly
  // above a banner telling the owner to go configure OAuth.
  const settled =
    !setupUnfinished && toolVariableStatuses(tool).every(({ status }) => status.state === 'ok');

  /**
   * Scoped to the viewer, not just the tool. The queue outlives this component
   * by design, and logging out only clears auth state — it does not reload the
   * page — so a bare slug key would make the next person to sign in wait behind
   * the previous one's pending probe.
   */
  const queueKey = `${user?.email ?? 'anon'}:${tool.slug}`;

  async function runCheck() {
    // Set BEFORE enqueueing, not inside the probe: while this call is waiting
    // its turn behind an earlier probe, nothing has started yet — and an
    // enabled "Test connection" button during that wait invites a second one.
    setChecking(true);
    try {
      await queueProbe(queueKey, doCheck);
    } finally {
      setChecking(false);
    }
  }

  async function doCheck() {
    try {
      await checkToolConnection(tool.slug);
      // Refetch rather than patching local state: the verdict belongs to the
      // tool record the whole page reads from, so one source stays one source.
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't test this connection.");
    }
  }

  return (
    <section className="mt-8">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-label font-semibold uppercase text-ink-faint">Your connection</h2>
        <div className="flex items-center gap-2">
          {/* A healthy connection stays QUIET — this section's rule is that only
              things needing a person get a banner, and a working tool needs
              nobody. But it still has to be sayable: the word plus its evidence
              on hover is how "Connected" stops being an assumption, and the
              button is the only way to ask the question on demand. A REJECTED
              credential does need a person, so it escalates to a banner below. */}
          {settled && health.state !== 'err' && (
            <span className="text-meta text-ink-faint" title={health.hint} data-testid="tool-health">
              {health.text}
            </span>
          )}
          {settled && (
            <Button
              variant="quiet"
              size="tiny"
              disabled={checking}
              onClick={() => void runCheck()}
              aria-label={`Test connection: ${tool.name}`}
            >
              {checking ? 'Testing…' : 'Test connection'}
            </Button>
          )}
          <Link to="/secrets" className={buttonClasses({ variant: 'quiet', size: 'tiny' })}>
            Open Secrets
          </Link>
        </div>
      </div>

      {setupUnfinished && (
        <Banner tone="wait" role="status" className="mb-2.5">
          {tool.canWrite && signInDeclared ? (
            <>
              Sign-in setup needed: the sign-in is declared — set its client secret below to
              finish.
              {tool.setup?.reason && <em className="mt-1 block">{tool.setup.reason}</em>}
            </>
          ) : tool.canWrite ? (
            <>
              Sign-in setup needed: this server needs users to sign in, but Bevel couldn't set
              that up automatically. Register an OAuth app with the provider, then{' '}
              {isMcpJsonServer
                ? 'add a user-scoped variable with an OAuth sign-in under "Edit server" below'
                : 'declare the sign-in on a user-scoped variable in the tool file'}
              , and set its client secret here.
              {tool.setup?.reason && <em className="mt-1 block">{tool.setup.reason}</em>}
              {kbDirName && !isMcpJsonServer && (
                <Button
                  variant="quiet"
                  size="tiny"
                  className="mt-1.5"
                  // `rawFile` steps past the WorkspaceItemGate: this URL is
                  // the tool page's own canonical address, and the button
                  // wants the raw editor behind it.
                  onClick={() =>
                    navigate(kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${tool.path}`), {
                      state: { rawFile: true },
                    })
                  }
                >
                  Edit the tool file
                </Button>
              )}
            </>
          ) : (
            <>
              Sign-in setup needed: ask the tool's owner to finish setting this up.
              {tool.setup?.reason && <em className="mt-1 block">{tool.setup.reason}</em>}
            </>
          )}
        </Banner>
      )}

      {/* Suppressed while the sign-in setup banner is up: that one names a
          cause, this one would only re-list its symptoms. */}
      {missing.length > 0 && !setupUnfinished && (
        <Banner tone="wait" role="status" className="mb-2.5">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="font-semibold">
                {missing.length === 1
                  ? 'This tool is not connected yet.'
                  : `This tool needs ${missing.length} things before it works.`}
              </span>{' '}
              <span>
                {missing
                  .map(({ v, status }) => `${v.label ?? v.name}: ${status.text}`)
                  .join(' · ')}
              </span>
            </span>
            {bannerAction && <span className="shrink-0">{bannerAction}</span>}
          </div>
        </Banner>
      )}

      {/* The one health state that needs a person: the provider tested this
          credential and refused it. Everything is configured, so no other
          banner covers it, and the row below cannot know — only a real call
          could tell us. `alert`, not `status`: this is the case the whole
          feature exists to surface. */}
      {settled && health.state === 'err' && (
        <Banner tone="danger" role="alert" className="mb-2.5" data-testid="tool-health-failed">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{health.text}.</span>
              {health.hint && <span> {health.hint}</span>}
            </span>
          </div>
        </Banner>
      )}

      {tool.variables.length === 0 ? (
        <p className="text-body text-ink-muted">Nothing to set up</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {tool.variables.map((variable) => (
            <ToolVarRow
              key={variable.name}
              slug={tool.slug}
              variable={variable}
              canWrite={tool.canWrite}
              setupKind={setupKind}
              returnTo={pathForTool(tool.slug)}
              editSignal={edit.name === variable.name ? edit.n : undefined}
              onChanged={onChanged}
              // Test the moment a key is entered — while the user still has it
              // to hand, which is when a typo is cheapest to fix. Waiting for
              // an agent to trip over it is how the wrong key got to look
              // connected in the first place.
              onSaved={() => void runCheck()}
              onError={onError}
            />
          ))}
        </div>
      )}
    </section>
  );
}
