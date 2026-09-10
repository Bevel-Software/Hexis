import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Banner } from '../../../shared/components';
import { CopyBlock } from '../../../shared/mcp';
import { marketplaceGitUrl } from '../../../shared/marketplace-url';
import { ClaudeConnectionFields } from '../../settings/components/ClaudeConnectionFields';
import {
  fetchGitHubFacade,
  type GitHubFacadeCredentials,
} from '../../settings/services/github-facade.api';
import { ClaudeMarketplaceCarousel } from './ClaudeMarketplaceCarousel';
import { ScreenshotStep } from './ScreenshotStep';
import {
  addConfigurationShot,
  addManuallyShot,
  addMarketplaceShot,
  connectAccountShot,
  installPluginsShot,
  pasteUrlShot,
  pickInstanceShot,
  pluginsAddShot,
} from './claude-setup-shots';

/** Where an Owner registers a GitHub Enterprise Server with the organization. */
const CLAUDE_CODE_ADMIN = 'https://claude.ai/admin-settings/claude-code';
/** Where an Owner connects their own account to a registered instance. */
const GITHUB_ADMIN = 'https://claude.ai/admin-settings/github';
/** The repository picker, which offers the same connection to everyone else. */
const CLAUDE_CODE_WEB = 'https://claude.ai/code';
const CLAUDE_WEB = 'https://claude.ai';

/**
 * A link out of the app, marked as one.
 *
 * The marker is a GLYPH, not the lucide icon the buttons use: an inline SVG
 * is an atomic box, and a line may break after it, which left the comma in
 * "Admin settings → Claude Code, scroll to…" stranded at the start of the
 * next line. Text has no break opportunity there.
 */
function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline text-ink-muted hover:text-ink"
    >
      {children}
      <span aria-hidden="true" className="opacity-60">
        ↗
      </span>
    </a>
  );
}

/**
 * The registration credentials, in the step that asks for them.
 *
 * They also live on the Deployment page, which is where they are rotated.
 * Here they are read-only: an Owner filling in Claude's form should not have
 * to leave this page, find a card and come back with six values.
 *
 * Mounted only inside the admin branch, so the admin-only endpoint is only
 * ever called by someone this deployment already resolved as an admin. The
 * server enforces that too; this just avoids a pointless 403 for everyone
 * else.
 *
 * And only once the drawer is OPEN. A closed <details> still mounts its
 * children, so without that gate every admin who opened the Marketplaces tab
 * for the git remote fetched a client secret and a private key into a drawer
 * they never looked at, once per visit. Secrets load when someone is reading
 * the step that asks for them, not before.
 */
function ClaudeConnection() {
  const [creds, setCreds] = useState<GitHubFacadeCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchGitHubFacade()
      .then((c) => {
        if (live) setCreds(c);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <Banner tone="danger" role="alert">
        {error} The same fields are on the{' '}
        <Link to="/deployment" className="underline">
          Deployment
        </Link>{' '}
        page.
      </Banner>
    );
  }
  if (!creds) return <div className="text-meta text-ink-muted">Loading the credentials…</div>;

  return (
    <div className="border border-line rounded-md p-3 space-y-3">
      <ClaudeConnectionFields creds={creds} />
      <p className="text-meta text-ink-muted leading-snug">
        Rotate these on the{' '}
        <Link to="/deployment" className="underline text-ink-muted hover:text-ink">
          Deployment
        </Link>{' '}
        page if they are ever exposed. An Owner then re-enters them in Claude.
      </p>
    </div>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="space-y-2 pl-1">
      <div className="text-xs font-medium text-ink">{title}</div>
      {children}
    </li>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return <p className="text-meta text-ink-muted leading-snug">{children}</p>;
}

/** The final two steps in the admin route. Non-admins see these screens in the carousel. */
function MarketplaceSteps() {
  return (
    <>
      {/* The URL leads the step: it is the thing to carry into Claude, and a
          reader who has copied it first can follow the three screens without
          coming back for it. */}
      <Step title="Add the marketplace">
        <CopyBlock label="Marketplace URL" value={marketplaceGitUrl()} rows={2} />
        <Prose>
          Copy it, then in Cowork, or on <Out href={CLAUDE_WEB}>claude.ai</Out>, open Customize.
        </Prose>
        <ScreenshotStep shot={pluginsAddShot} />
        <Prose>
          Open the <b>Plugins</b> tab, then choose <b>Add</b>.
        </Prose>
        <ScreenshotStep shot={addMarketplaceShot} />
        <Prose>
          Choose <b>Add marketplace</b> from the menu.
        </Prose>
        <ScreenshotStep shot={pasteUrlShot} />
        <Prose>
          Paste the marketplace URL into the URL field and choose <b>Sync</b>.
        </Prose>
      </Step>

      <Step title="Install the plugins you want">
        <Prose>
          Syncing lists the plugins, it installs none of them. Open Discover and choose <b>Add</b>{' '}
          on <b>Hexis all</b>: one plugin holding every skill you may read, plus the knowledge base
          as an MCP server. The other rows are subsets of it, if you would rather pick.{' '}
          <b>Update</b> in Claude pulls what changed later.
        </Prose>
        <ScreenshotStep shot={installPluginsShot} />
      </Step>
    </>
  );
}

/**
 * How to install this deployment's skills as plugins in Cowork and on
 * claude.ai, in the order the screens actually happen.
 *
 * Two versions of the same route, split on `isAdmin`, because the first two
 * steps happen on pages a non-admin cannot open. Showing them anyway would
 * be four screenshots of a door they have no key to, so they get a focused
 * five-slide walkthrough of only the actions they can take.
 *
 * `isAdmin` is admin HERE, which is not the same authority as Owner of the
 * Claude organization: the copy names the Claude side explicitly so an admin
 * without it knows who to hand step 1 to.
 */
export function CoworkSetupSteps({ isAdmin, opened }: { isAdmin: boolean; opened: boolean }) {
  const host = deploymentHost();

  if (!isAdmin) {
    return (
      <div className="space-y-3">
        <Prose>
          Cowork and claude.ai install marketplaces only from GitHub, or from a GitHub Enterprise
          Server your Claude organization has registered. This deployment answers as one. An admin
          here registers it once. If the first step does not list this deployment, ask an admin to
          register it.
        </Prose>
        <CopyBlock label="Marketplace URL" value={marketplaceGitUrl()} rows={2} />
        <ClaudeMarketplaceCarousel host={host} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Prose>
        Cowork and claude.ai install marketplaces only from GitHub, or from a GitHub Enterprise
        Server your Claude organization has registered. This deployment answers as one. Steps 1 and
        2 are yours. Steps 3 and 4 are what every person here does.
      </Prose>

      <ol className="list-decimal space-y-4 pl-4 marker:text-ink-faint marker:text-meta">
        <>
            <Step title="Register this deployment with your Claude organization">
              <Prose>
                An Owner of your Claude organization does this once, on a Team or Enterprise
                plan. Open{' '}
                <Out href={CLAUDE_CODE_ADMIN}>Admin settings → Claude Code</Out>, scroll to
                Self-hosted infrastructure, and choose <b>Add manually</b> beside GitHub
                Enterprise.
              </Prose>
              <ScreenshotStep shot={addManuallyShot} />
              <Prose>
                Fill it from the fields below, which this deployment generated for exactly this
                form. Any display name will do, the port is {deploymentPort()}, and read replicas
                stay empty.
                Choose <b>Add configuration</b>. The webhook URL Claude shows afterwards can be
                ignored: nothing here sends webhooks yet, and the private key is required by the
                form but unused by this flow.
              </Prose>
              {opened && <ClaudeConnection />}
              <ScreenshotStep shot={addConfigurationShot} />
            </Step>

            <Step title="Connect your own Claude account to it">
              <Prose>
                Registering the instance signs nobody in, and Claude never prompts for this. Open{' '}
                <Out href={GITHUB_ADMIN}>Admin settings → GitHub</Out> and choose <b>Connect</b>.
              </Prose>
              <ScreenshotStep shot={connectAccountShot} />
              <Prose>
                Under GitHub instance, pick {host} instead of github.com, then continue. You land
                on the sign-in here: approve, and you are back in Claude.
              </Prose>
              <ScreenshotStep shot={pickInstanceShot} />
              <Prose>
                Everyone else does the same from the repository picker on{' '}
                <Out href={CLAUDE_CODE_WEB}>claude.ai/code</Out>, which offers the same instance.
              </Prose>
            </Step>
        </>

        <MarketplaceSteps />
      </ol>
    </div>
  );
}

/**
 * The address Claude has registered, which is this deployment's own: the
 * marketplace remote is served from it. Named rather than described so the
 * reader can match it against the row Claude shows them.
 */
function deploymentHost(): string {
  try {
    return new URL(marketplaceGitUrl()).host;
  } catch {
    return 'this deployment';
  }
}

/**
 * The port Claude must register for it — the one this deployment is
 * actually reached on. The scheme's default when the address names none;
 * a deployment exposed on another port must be registered on that port,
 * or Claude's calls never arrive.
 */
function deploymentPort(): string {
  try {
    const url = new URL(marketplaceGitUrl());
    return url.port || (url.protocol === 'http:' ? '80' : '443');
  } catch {
    return '443';
  }
}
