import { ExternalLink } from 'lucide-react';
import { cn } from '../../lib/utils';
import { buttonClasses } from '../components';
import { canDeepLink, claudeInstallUrl, connectorName } from './connect-snippets';

/**
 * One click instead of "copy this, open claude.ai, find Settings, find
 * Connectors, find Add custom connector, paste".
 *
 * Anthropic publishes an install link that opens the add-custom-connector
 * dialog with the name and URL prefilled. It only PREFILLS — the person still
 * reviews and confirms, and Claude marks the values as having come from an
 * external link. So this is a shortcut through a menu, not a grant of
 * anything, which is why it needs no warning of its own.
 *
 * It renders nothing when the endpoint cannot possibly be reached from
 * Anthropic's side (see `canDeepLink` — plain http, localhost, private
 * ranges). That is the default configuration, not an edge case, and a bright
 * button that always fails is worse on a first-run screen than no button.
 *
 * `showHint` is for the surface whose audience can DO something about it. On
 * the settings page the reader is plausibly the person holding the env file,
 * so the dead state names the variable to set. On the welcome page the reader
 * is an employee who cannot change deployment config, and telling them about
 * `PUBLIC_BACKEND_URL` is noise — they just get the copy-paste URL, which
 * works regardless.
 */
/**
 * The address with any userinfo removed, for rendering. `configureMcpUrl`
 * strips credentials at the boot boundary, but this component is exported and
 * takes `mcpUrl` as a prop — a caller that bypasses that door must not get a
 * password printed into the hint. An unparseable value passes through: it is
 * not a URL, so it has no userinfo component to strip.
 */
function withoutCredentials(mcpUrl: string): string {
  try {
    const parsed = new URL(mcpUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return mcpUrl;
  }
}

export function ClaudeInstallLink({
  mcpUrl,
  showHint = false,
  className,
}: {
  mcpUrl: string;
  showHint?: boolean;
  /**
   * Spacing belongs to the caller, ON the element — a wrapping `<div>` with a
   * margin would leave a gap behind on the surface where this renders
   * nothing.
   */
  className?: string;
}) {
  if (!canDeepLink(mcpUrl)) {
    if (!showHint) return null;
    return (
      /* `text-meta`, not the arbitrary pixel size its neighbours use: those
         predate the token scale and the ratchet counts every one of them, so
         new copy goes on-scale even when it sits beside copy that is not. */
      <p className={cn('text-meta text-ink-muted leading-snug', className)}>
        One-click connect is off because this deployment&rsquo;s public address is{' '}
        <code className="font-mono">{withoutCredentials(mcpUrl)}</code>, which Claude cannot reach from the
        internet. Set <code className="font-mono">PUBLIC_BACKEND_URL</code> to the https
        address people actually use to turn it on. The URL below works either way.
      </p>
    );
  }

  return (
    <a
      href={claudeInstallUrl(mcpUrl, connectorName(mcpUrl))}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClasses({ variant: 'primary', size: 'sm', className })}
    >
      Add to Claude
      {/* Decoration: the link's own text is its accessible name, and a second
          reading of "external link" adds nothing for a screen reader. */}
      <ExternalLink size={12} className="opacity-70" aria-hidden="true" />
    </a>
  );
}
