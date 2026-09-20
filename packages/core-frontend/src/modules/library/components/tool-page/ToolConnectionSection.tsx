import { Link, useNavigate } from 'react-router-dom';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { Banner, Button, buttonClasses } from '../../../../shared/components';
import { announceToolCredentialsChanged } from '../../../../core/events';
import { useWorkspace } from '../../../workspace/state/workspace.context';
import { kbFileUrl } from '../../../workspace/routing/kb-routes';
import { useSavedKeyProbe } from '../../../secrets-vault/probe/useSavedKeyProbe';
import { type ToolSecrets } from '../../../secrets-vault/services/tool-secrets.api';
import { pathForTool } from '../../routes/library-paths';
import { toolStatus, toolVariableStatuses } from '../../utils/status';
import { ToolVarRow } from './ToolVarRow';

/**
 * "Your connection" — what this tool still needs from you, and (if you own it)
 * from you on everyone's behalf.
 *
 * A banner here names a CAUSE the rows cannot see; it never summarises them.
 * There used to be a second one that did — "this tool needs 2 things before it
 * works", then every missing label and status, sitting directly on top of rows
 * that already carried those labels, those statuses and the buttons that fix
 * them. What it really added was colour, so colour is what survived it: an
 * unset row is drawn amber (see `ToolVarRow`'s `unset`), and the count is how
 * many of them there are.
 *
 * The setup banner that remains passes that test, because `oauth-manual` is the
 * one state the rows CANNOT explain on their own: the remote server wants a
 * sign-in through an app the OWNER registers, so every row underneath is stuck
 * through no fault of the person reading them. The banner names whose move it
 * is — the owner's — and what the move is: declare the sign-in (the server
 * editor on this page for an mcp.json server, the file itself for a `.tool`),
 * then set its client secret. Once declared, only the secret remains and it
 * says so. The rejected-credential banner passes it too: only a real call
 * could know, so no row can.
 */

export interface ToolConnectionSectionProps {
  tool: ToolSecrets;
  /**
   * Bumped whenever the tool's DEFINITION changes — today, an mcp.json server
   * edit. A verdict describes the endpoint and headers it was probed against,
   * so changing those makes it a statement about a server that is no longer
   * configured; the badge must stop claiming it. Deliberately NOT bumped by a
   * credential write: that path clears and re-probes on its own, and bumping
   * here would discard the answer it is in the middle of fetching.
   */
  configRevision: number;
  /** A write landed — the caller refetches so the chips catch up. */
  onChanged(): void;
  onError(message: string): void;
}

export function ToolConnectionSection({
  tool,
  configRevision,
  onChanged,
  onError,
}: ToolConnectionSectionProps) {
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();

  /**
   * The probe, and the ONLY place its answer exists.
   *
   * Nothing persists a verdict, so this state IS the evidence behind the word
   * "Connected" — which is why the claim can be trusted: it cannot outlive the
   * page that watched the call succeed. Section state, not page state: a probe
   * of the PREVIOUS tool (this section is keyed by slug) could otherwise raise
   * or clear a page-level banner after unmount.
   *
   * The revision is passed through as the hook's stamp, so an answer is read
   * back only while it still describes the server definition on screen.
   */
  const probe = useSavedKeyProbe(tool.slug, configRevision);
  const { checking, verdict } = probe;
  const shownProbeError = probe.result?.kind === 'unreachable' ? probe.result.message : null;


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
   * The CONFIGURATION this tool is still missing, by variable name.
   *
   * This list used to be prose in an amber banner above the rows — "needs 2
   * things", then every label and status again — directly above rows already
   * carrying the same labels, the same statuses and the buttons that fix
   * them. The rows won: each one named here is drawn amber, and the count the
   * banner gave is how many amber rows there are.
   *
   * Only configuration gaps qualify: keys nobody has entered, owner-side setup
   * nobody has finished. A pending sign-in on a fully configured provider is
   * deliberately NOT here — configuration is the state of the TOOL, while
   * signing in is a step each PERSON takes, and its row already offers the
   * Sign in button without needing to be flagged as unfinished setup.
   */
  const unset = new Set(
    toolVariableStatuses(tool)
      .filter(({ v, status }) => status.state !== 'ok' && !(v.oauth && v.adminConfigured))
      .map(({ v }) => v.name),
  );

  /**
   * The health line, shown only once every variable is provided.
   *
   * While something is still missing, the amber rows below already name it,
   * and a second line saying the connection is untested would be answering a
   * question nobody has reached yet. Once nothing is missing, this is the only
   * remaining question — and the one the badge used to answer by guessing.
   */
  const health = toolStatus(tool, verdict);
  // Every variable genuinely provided — NOT merely `unset.size === 0`, which
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
   * A credential write LANDED (save or delete, from a row's editor).
   * Everything a pending probe could still say is about a credential
   * that no longer exists in that form, so the write ORPHANS it outright —
   * the sequence bump takes its voice (a delete starts no replacement probe,
   * so nothing else would), the in-flight slot is released, and the old
   * transport alert goes with them.
   */
  function changed() {
    // The VERDICT goes too: after a delete, “Connected” would otherwise keep
    // describing a credential that no longer exists while the refetch is
    // still in flight.
    probe.forget();
    // And the rest of the Library, which derives "needs setup" from a catalog
    // loaded before this write: the card, the plugin banner and the sidebar
    // count all keep the old answer otherwise, and the reader meets it the
    // moment they press back. Announced HERE, on the landing, rather than
    // after the probe — what the catalog believes about a stored key does not
    // depend on whether the provider likes it, and making the reload wait for
    // a round-trip nobody is watching only widens the stale window.
    announceToolCredentialsChanged();
    onChanged();
  }

  /**
   * A credential was just SAVED: whatever the last probe concluded was about
   * the key it replaced, so drop it and test the new one straight away —
   * while the user still has it to hand, which is when a wrong key is
   * cheapest to fix. (The row calls `changed` too, which orphans the old
   * probe; the fresh probe claims the sequence for the new key.)
   */
  function onSaved() {
    probe.probeSaved();
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
              size="sm"
              disabled={checking}
              onClick={() => void probe.run()}
              aria-label={`Test connection: ${tool.name}`}
            >
              {checking ? 'Testing…' : 'Test connection'}
            </Button>
          )}
          <Link to="/secrets" className={buttonClasses({ variant: 'quiet', size: 'sm' })}>
            Open Secrets
          </Link>
        </div>
      </div>

      {shownProbeError && (
        <Banner tone="danger" role="alert" className="mb-2.5" data-testid="tool-probe-error">
          {shownProbeError}
        </Banner>
      )}

      {/* Why the word above says "Unverified" — the manual defines no health
          check, so there was nothing to call. A quiet LINE, not a banner: the
          key is saved, nothing is broken and nobody has to act, but a word
          that hides its reason has only moved the question. The tooltip alone
          is not enough — it is unreachable on touch and to a screen reader. */}
      {settled && verdict?.status === 'unverifiable' && (
        <p className="mb-2.5 text-detail text-ink-muted" data-testid="tool-health-unverified">
          {health.hint}
        </p>
      )}

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
                  size="sm"
                  className="mt-1.5"
                  // `rawFile` asks the item route for the raw editor: this
                  // URL is the tool page's own canonical address, and the
                  // button wants the file behind it — still in this app.
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
              unset={unset.has(variable.name)}
              onChanged={changed}
              // Test the moment a key is entered — while the user still has it
              // to hand, which is when a typo is cheapest to fix. Waiting for
              // an agent to trip over it is how the wrong key got to look
              // connected in the first place.
              onSaved={onSaved}
              onError={onError}
            />
          ))}
        </div>
      )}
    </section>
  );
}
