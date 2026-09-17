import { CopyBlock } from './CopyBlock';
import { ClaudeInstallLink } from './ClaudeInstallLink';
import { ChatGptInstallLink } from './ChatGptInstallLink';
import { MCP_DISPLAY_NAME, claudeCodeCommand, jsonConfigSnippet } from './connect-snippets';

/*
 * How to point an interactive agent at this workspace's HOSTED endpoint, in
 * two parts, because the External agent access page shows them in two
 * drawers: Claude and ChatGPT lead the page, and the configs for every other
 * agent sit two drawers further down.
 *
 * Their own components rather than blocks inside `ExternalAgentAccessPage`
 * because that page fetches external API keys on mount. Testing "does the
 * install button appear" by rendering the whole page meant mocking the
 * credential API first — a test coupled to code it does not care about, which
 * breaks whenever that API changes. These take a URL and render; there is
 * nothing to mock.
 *
 * Every URL here comes from the one `mcpUrl` prop. That is the point: the
 * six sites this replaced each rebuilt the address from
 * `window.location.origin`, which is the browser's idea of where we are
 * rather than the deployment's.
 */

/**
 * Claude and ChatGPT: the install links when the deployment is reachable
 * enough for them to work, and the address to paste by hand either way.
 */
export function AssistantConnectionInstructions({ mcpUrl }: { mcpUrl: string }) {
  return (
    <div>
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
        Or add it by hand and paste this URL — Claude: Settings → Connectors → Add custom
        connector. ChatGPT: Settings → Plugins (or Apps &amp; Connectors) → turn on Developer
        Mode, go back and choose Create (or Add), and name it <span className="font-medium">{MCP_DISPLAY_NAME}</span>.
        When asked to authorize, your browser opens this app to finish connecting.
      </p>
      <CopyBlock label={null} value={mcpUrl} rows={1} />
    </div>
  );
}

/** Every other agent on the hosted endpoint: Claude Code's one-liner and the JSON config. */
export function OtherAgentConnectionInstructions({ mcpUrl }: { mcpUrl: string }) {
  return (
    <>
      <CopyBlock label="Connect Claude Code" value={claudeCodeCommand(mcpUrl)} rows={2} />
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
