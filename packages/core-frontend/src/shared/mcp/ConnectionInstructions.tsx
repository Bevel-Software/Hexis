import { CopyBlock } from './CopyBlock';
import { ClaudeInstallLink } from './ClaudeInstallLink';
import { ChatGptInstallLink } from './ChatGptInstallLink';
import { MCP_DISPLAY_NAME, claudeCodeCommand, jsonConfigSnippet } from './connect-snippets';

/**
 * How to point an interactive agent at this workspace: the three
 * no-key connection configs, plus the Claude and ChatGPT install links when
 * the deployment is reachable enough for them to work.
 *
 * Its own component rather than a block inside `ExternalAgentAccessPage`
 * because that page fetches external API keys on mount. Testing "does the
 * install button appear" by rendering the whole page meant mocking the
 * credential API first — a test coupled to code it does not care about, which
 * breaks whenever that API changes. This takes a URL and renders; there is
 * nothing to mock.
 *
 * Every URL here comes from the one `mcpUrl` prop. That is the point: the
 * six sites this replaced each rebuilt the address from
 * `window.location.origin`, which is the browser's idea of where we are
 * rather than the deployment's.
 */
export function ConnectionInstructions({ mcpUrl }: { mcpUrl: string }) {
  return (
    <>
      <CopyBlock label="Connect Claude Code" value={claudeCodeCommand(mcpUrl)} rows={2} />
      <div>
        <div className="text-xs font-medium text-ink mb-1">claude.ai, Claude Desktop and ChatGPT</div>
        {/* The buttons first, then the manual routes underneath — the fallback
            has to stay visible, because the buttons are unavailable on any
            deployment the assistants cannot reach, and the copy-paste URL is
            the only thing that always works. ChatGPT's button only opens the
            settings pane (no prefill exists), so the name and URL to type sit
            right below it. */}
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <ClaudeInstallLink mcpUrl={mcpUrl} showHint />
          <ChatGptInstallLink mcpUrl={mcpUrl} />
        </div>
        <p className="text-[11px] text-ink-muted mb-1 leading-snug">
          Or add it by hand — Claude: Settings → Connectors → Add custom connector. ChatGPT:
          Settings → Apps &amp; Connectors → Advanced → turn on Developer mode, then Create.
          Name it <span className="font-medium">{MCP_DISPLAY_NAME}</span> and paste this URL.
          When asked to authorize, your browser opens this app to finish connecting.
        </p>
        <CopyBlock label={null} value={mcpUrl} rows={1} />
      </div>
      <div>
        <div className="text-xs font-medium text-ink mb-1">Other agents (JSON config)</div>
        <p className="text-[11px] text-ink-muted mb-1 leading-snug">
          Works with Cursor, Windsurf, Cline, and most clients that load servers from a JSON
          config and support signing in.
        </p>
        <CopyBlock label={null} value={jsonConfigSnippet(mcpUrl)} rows={9} />
      </div>
    </>
  );
}
