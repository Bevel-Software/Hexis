import { useState } from 'react';
import { AGENT_CLIENTS, type AgentClient } from './agent-clients';
import { ChatGptInstallLink } from './ChatGptInstallLink';
import { ClaudeInstallLink } from './ClaudeInstallLink';
import { canDeepLink } from './connect-snippets';
import { CopyPromptButton } from './CopyPromptButton';
import { MoreRow } from './MoreRow';
import { SegmentedChoice } from './SegmentedChoice';
import { SnippetBlock } from './SnippetBlock';

/** Instructions are read to act on, so they get the reading size and colour, not the size of a date. */
const HINT = 'text-detail leading-normal text-ink-muted';

/**
 * "Which agent do you use?", and the ONE thing to do for the one you picked.
 *
 * A reader meets a choice, then a single action: a button where the agent can
 * be connected in one click, otherwise one short line and one thing to copy.
 * Every other way in, and every "if it fails", is a closed row underneath.
 * The page never shows two things to copy at once.
 *
 * The welcome page and the External agent access page both render THIS, so
 * connecting an agent looks and reads the same wherever it is offered.
 */
export function AgentClientPicker({
  mcpUrl,
  onCopyFailed,
  onAct,
  className,
}: {
  /** The deployment's own MCP address: see `mcpEndpointUrl`. */
  mcpUrl: string;
  onCopyFailed?: () => void;
  /**
   * The reader did the thing: followed the link or copied the snippet. A page
   * starts waiting for the agent from here, not from the moment it was opened.
   */
  onAct?: () => void;
  className?: string;
}) {
  // Claude and ChatGPT connect from their own servers, so they need an
  // address the internet can reach. Where this deployment has none, they say
  // so in one line and the page opens on what does work: an agent on the
  // reader's own machine.
  const reachable = canDeepLink(mcpUrl);
  const [clientId, setClientId] = useState<AgentClient['id']>(reachable ? 'claude' : 'local');
  const client = AGENT_CLIENTS.find((c) => c.id === clientId) ?? AGENT_CLIENTS[0]!;
  const hosted = client.id === 'claude' || client.id === 'chatgpt';

  const hint = Array.isArray(client.hint) ? (
    <ol className={`list-decimal space-y-0.5 pl-5 ${HINT}`}>
      {client.hint.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  ) : (
    <p className={HINT}>{client.hint}</p>
  );
  const snippet = (
    <SnippetBlock value={client.snip(mcpUrl)} copyLabel="Copy" onCopyFailed={onCopyFailed} />
  );

  return (
    <div className={className}>
      <SegmentedChoice label="Your agent" options={AGENT_CLIENTS} value={client.id} onChange={setClientId} />

      {/* Keyed by client as a whole, so nothing earned on one option (a copy
          tick, an opened row) lingers under the next. */}
      <div
        key={client.id}
        className="mt-3.5 space-y-3"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a,button')) onAct?.();
        }}
      >
        {hosted && !reachable ? (
          <p className={HINT}>
            {client.label} connects over the internet, and this deployment has no public https address. Coding agents
            work.
          </p>
        ) : client.id === 'claude' ? (
          <>
            <div>
              <ClaudeInstallLink mcpUrl={mcpUrl} />
            </div>
            <MoreRow summary="Or add it by hand" group="agent-more">
              {hint}
              {snippet}
            </MoreRow>
          </>
        ) : client.prompt ? (
          <>
            {/* The agent sets itself up: one prompt to paste, nothing to configure. */}
            <div>
              <CopyPromptButton value={client.prompt(mcpUrl)} onCopyFailed={onCopyFailed} />
            </div>
            <p className={HINT}>Paste it into Claude Code, Cursor, Windsurf or Cline. The agent connects itself.</p>
            <MoreRow summary="Or add it by hand" group="agent-more">
              {hint}
              {snippet}
            </MoreRow>
          </>
        ) : (
          <>
            {hint}
            {snippet}
            {/* After the address: the link only opens ChatGPT, where the address is pasted. */}
            {client.id === 'chatgpt' && (
              <div>
                <ChatGptInstallLink mcpUrl={mcpUrl} />
              </div>
            )}
          </>
        )}

        {!(hosted && !reachable) &&
          client.more?.(mcpUrl).map((more) => (
          <MoreRow key={more.summary} summary={more.summary} group="agent-more">
            {more.text && <p className="leading-normal">{more.text}</p>}
            {more.value && (
              <SnippetBlock value={more.value} copyLabel={`Copy: ${more.summary}`} onCopyFailed={onCopyFailed} />
            )}
          </MoreRow>
        ))}
      </div>
    </div>
  );
}
