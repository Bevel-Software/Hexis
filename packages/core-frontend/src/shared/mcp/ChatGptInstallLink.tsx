import { ExternalLink } from 'lucide-react';
import { buttonClasses } from '../components';
import { canDeepLink, chatgptInstallUrl } from './connect-snippets';

/**
 * The ChatGPT counterpart of {@link ClaudeInstallLink} — with one honest
 * difference. Claude's link PREFILLS the connector; ChatGPT publishes no
 * such link, so this one only opens the settings pane where a custom MCP
 * server is created. The person still turns on Developer mode, presses
 * Create, types the name and pastes the URL. It is a shortcut through a menu
 * nobody finds on the first try, not a grant of anything — which is why it
 * carries no warning, and why every surface that shows it also shows the
 * name and the URL to paste.
 *
 * Same gate as the Claude link: ChatGPT fetches the server from OpenAI's
 * infrastructure, so an endpoint Anthropic could not reach (plain http,
 * localhost, private ranges — see `canDeepLink`) is one OpenAI cannot reach
 * either, and a button that opens a dialog you cannot complete is worse than
 * none. No `showHint` variant: on the one surface that wants the operator
 * hint, this renders next to the Claude link, whose hint already names both
 * products and the variable that fixes them.
 */
export function ChatGptInstallLink({
  mcpUrl,
  className,
}: {
  mcpUrl: string;
  /** Spacing belongs to the caller, ON the element — see `ClaudeInstallLink`. */
  className?: string;
}) {
  if (!canDeepLink(mcpUrl)) return null;

  return (
    <a
      href={chatgptInstallUrl()}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClasses({ variant: 'outline', size: 'sm', className })}
    >
      Add to ChatGPT
      {/* Decoration: the link's own text is its accessible name. */}
      <ExternalLink size={12} className="opacity-70" aria-hidden="true" />
    </a>
  );
}
