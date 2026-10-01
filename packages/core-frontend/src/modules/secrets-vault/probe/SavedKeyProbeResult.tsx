import { Banner } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { PROBE_UNREACHABLE_LEAD, probeWords } from './probe-verdict';
import type { SavedKeyProbe } from './useSavedKeyProbe';

/**
 * What the probe found, next to the key that was just saved.
 *
 * Renders for the two surfaces whose unit is a ROW — "Connect your tools" and
 * the vault. The tool page draws the same answer at tool scale (a health line
 * beside its Test button, a banner above its rows), so it keeps its own
 * layout; what both share is `probeWords`, which is why the sentence a person
 * meets is identical wherever they saved the key.
 *
 * The loudness follows who has to act:
 *  - REJECTED is the one state that needs a person — the provider looked at
 *    this key and refused it, no other banner covers that, and the key is
 *    still to hand. It gets a danger banner and `role="alert"`, exactly as the
 *    tool page does. This case is the reason the feature exists.
 *  - UNREACHABLE needs nobody yet: our own network failed, the key may well be
 *    fine. It says the check could not run — never that the key is wrong.
 *  - CONNECTED and UNVERIFIED stay quiet lines. Both describe a tool that
 *    needs nothing from anybody, and a warning on every untestable integration
 *    teaches people to ignore warnings.
 *
 * Nothing here is handed the submitted secret. The component sees a verdict
 * and a transport message, neither of which the client composes from the value
 * it sent — so there is no path by which a key reaches this text.
 */
export function SavedKeyProbeResult({
  probe,
  className,
}: {
  probe: SavedKeyProbe;
  className?: string;
}) {
  const { result, checking } = probe;

  // Only while there is nothing better to show. A re-test over an existing
  // answer keeps the answer up and lets the row say it is checking again,
  // rather than blanking to "Testing…" and looking like it forgot.
  if (!result) {
    return checking ? (
      <p
        className={cn('text-detail text-ink-faint', className)}
        data-testid="saved-key-probe"
        data-probe-state="checking"
      >
        Testing this key…
      </p>
    ) : null;
  }

  if (result.kind === 'unreachable') {
    return (
      <Banner
        tone="wait"
        role="status"
        className={className}
        data-testid="saved-key-probe"
        data-probe-state="unreachable"
      >
        <span className="font-semibold">{PROBE_UNREACHABLE_LEAD}</span>{' '}
        <span>{result.message}</span>
      </Banner>
    );
  }

  const { tone, text, hint } = probeWords(result.verdict);

  if (tone === 'err') {
    return (
      <Banner
        tone="danger"
        role="alert"
        className={className}
        data-testid="saved-key-probe"
        data-probe-state="rejected"
      >
        <span className="font-semibold">{text}.</span> <span>{hint}</span>
      </Banner>
    );
  }

  return (
    <p
      className={cn('text-detail text-ink-muted', className)}
      data-testid="saved-key-probe"
      data-probe-state={result.verdict.status === 'ok' ? 'connected' : 'unverified'}
    >
      {/* The word and the line behind it, both VISIBLE — not a tooltip. A row
          that says "Unverified" and hides why has only moved the question. */}
      <span className="font-semibold text-ink">{text}</span>
      {' — '}
      {hint}
    </p>
  );
}
