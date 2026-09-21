import { SetupCarousel, type CarouselSlide } from './SetupCarousel';
import { connectorSlide } from './claude-connector-slide';
import {
  addMarketplaceShot,
  installPluginsShot,
  pasteUrlShot,
  pluginsAddShot,
  selectRepositoryShot,
} from './claude-setup-shots';

const CLAUDE_CODE_WEB = 'https://claude.ai/code';
const CLAUDE_WEB = 'https://claude.ai';

function slides(host: string): CarouselSlide[] {
  return [
    {
      shortLabel: 'Connect',
      stage: 'Connect your account',
      title: 'Select this deployment in Claude Code',
      instruction: (
        <>
          Open{' '}
          <a
            href={CLAUDE_CODE_WEB}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-ink-muted hover:text-ink"
          >
            Claude Code on the web↗
          </a>
          . You do not need to start a coding task. Choose <b>Select repository</b>, then click{' '}
          <b>Connect to URL</b> and select <b>{host}</b>. Do not use <b>Connect to GitHub</b> — that
          signs you in to github.com instead. Approve the sign-in here and Claude returns you to the
          repository picker.
        </>
      ),
      shots: [selectRepositoryShot],
    },
    {
      shortLabel: 'Plugins',
      stage: 'Add the marketplace',
      title: 'Open the Plugins menu',
      instruction: (
        <>
          Back in Cowork or on{' '}
          <a
            href={CLAUDE_WEB}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-ink-muted hover:text-ink"
          >
            claude.ai↗
          </a>
          , open <b>Customize</b>, select the <b>Plugins</b> tab, then choose <b>Add</b>.
        </>
      ),
      shots: [pluginsAddShot],
    },
    {
      shortLabel: 'Marketplace',
      stage: 'Add the marketplace',
      title: 'Choose Add marketplace',
      instruction: (
        <>
          In the Add menu, choose <b>Add marketplace</b>. This opens the field where Claude can
          fetch this deployment's plugin catalog.
        </>
      ),
      shots: [addMarketplaceShot],
    },
    {
      shortLabel: 'Sync',
      stage: 'Add the marketplace',
      title: 'Paste the URL and sync',
      instruction: (
        <>
          Paste the <b>Marketplace URL</b> copied above into the URL field, then choose <b>Sync</b>.
          Syncing makes the plugins available; it does not install them yet.
        </>
      ),
      shots: [pasteUrlShot],
    },
    {
      shortLabel: 'Install',
      stage: 'Install the plugin',
      title: 'Add Hexis all',
      instruction: (
        <>
          Open <b>Discover</b> and choose the <b>Hexis all</b> row to install every skill you may
          read, plus the knowledge base MCP server. The other rows are smaller subsets if you prefer
          to pick. Use <b>Update</b> in Claude to pull changes later.
        </>
      ),
      shots: [installPluginsShot],
    },
    connectorSlide,
  ];
}

/**
 * The non-admin path: connect the account, add the marketplace, install the
 * plugin, then add the connector the plugin does not add for you. The shell
 * is `SetupCarousel`, shared with the admin's registration steps.
 */
export function ClaudeMarketplaceCarousel({ host }: { host: string }) {
  return <SetupCarousel label="Set up the Claude marketplace" slides={slides(host)} />;
}
