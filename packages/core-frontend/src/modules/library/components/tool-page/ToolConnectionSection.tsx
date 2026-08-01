import { Link, useNavigate } from 'react-router-dom';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { Banner, Button, buttonClasses } from '../../../../shared/components';
import { useWorkspace } from '../../../workspace/state/workspace.context';
import { kbFileUrl } from '../../../workspace/routing/kb-routes';
import type { ToolSecrets } from '../../../secrets-vault/services/tool-secrets.api';
import { pathForTool } from '../../routes/library-paths';
import { ToolVarRow } from './ToolVarRow';

/**
 * "Your connection" — what this tool still needs from you, and (if you own it)
 * from you on everyone's behalf.
 *
 * The setup banner above the rows exists because `oauth-manual` is the one
 * state the rows CANNOT explain on their own: auto-discovery found that the
 * remote server wants a sign-in but couldn't register a client for it, so every
 * row underneath is stuck through no fault of the person reading them. The
 * banner names whose move it is — the owner's — and for the owner it links
 * straight at the file they have to edit.
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

  const setupKind = tool.setup?.kind ?? null;
  // Not just "kind is oauth-manual": once the owner declares the provider and
  // saves its secret, the same tool is a normal sign-in and the banner is noise.
  // No oauth variable at all is the un-started case, so it counts as unfinished.
  const setupUnfinished =
    setupKind === 'oauth-manual' && !tool.variables.some((v) => v.oauth && v.adminConfigured);

  return (
    <section className="mt-8">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-label font-semibold uppercase text-ink-faint">Your connection</h2>
        <Link to="/secrets" className={buttonClasses({ variant: 'quiet', size: 'tiny' })}>
          Open Secrets
        </Link>
      </div>

      {setupUnfinished && (
        <Banner tone="wait" role="status" className="mb-2.5">
          {tool.canWrite ? (
            <>
              Sign-in setup needed — this server needs users to sign in, but Bevel couldn't set
              that up automatically. Declare the OAuth provider in the tool file, then set its
              client secret below.
              {tool.setup?.reason && <em className="mt-1 block">{tool.setup.reason}</em>}
              {kbDirName && (
                <Button
                  variant="quiet"
                  size="tiny"
                  className="mt-1.5"
                  onClick={() => navigate(kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${tool.path}`))}
                >
                  Edit the tool file
                </Button>
              )}
            </>
          ) : (
            <>
              Sign-in setup needed — ask the tool's owner to finish setting this up.
              {tool.setup?.reason && <em className="mt-1 block">{tool.setup.reason}</em>}
            </>
          )}
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
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </div>
      )}
    </section>
  );
}
