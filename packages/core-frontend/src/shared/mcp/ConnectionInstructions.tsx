import { CopyBlock } from './CopyBlock';
import { ClaudeInstallLink } from './ClaudeInstallLink';
import { claudeCodeCommand, jsonConfigSnippet } from './connect-snippets';

/**
 * How to point an interactive agent at this workspace: the three
 * no-key connection configs, plus the one-click Claude install link when the
 * deployment is reachable enough for it to work.
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
        <div className="text-xs font-medium text-ink mb-1">claude.ai / Claude Desktop</div>
        {/* The button first, then the manual route underneath — the fallback
            has to stay visible, because one-click is unavailable on any
            deployment Claude cannot reach and the copy-paste URL is the only
            thing that always works. */}
        <div className="mb-1.5">
          <ClaudeInstallLink mcpUrl={mcpUrl} showHint />
        </div>
        <p className="text-[11px] text-ink-muted mb-1 leading-snug">
          Or add it by hand: Settings → Connectors → Add custom connector, then paste this
          URL. When asked to authorize, your browser opens this app to finish connecting.
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
