import { cn } from '../../../lib/utils';
import { SIDEBAR_ROW_INSET } from '../../layout/components/SidebarFrame';

/**
 * "2 integrations need setup. Finish now" — the Library's footer reminder.
 *
 * It used to be the last thing `PluginsSidebar` rendered, below its own
 * `</nav>`, carrying a margin and a hairline of its own. That made it the
 * nav's business where the bottom of the sidebar sits, and it disagreed with
 * the change-request dock underneath it about the answer: two insets, two
 * hairlines, no gap. It is a FOOTER ROW now — the layout passes it into
 * `SidebarFrame`'s `footer` slot beside the dock, and the frame spaces the
 * two of them (see `SIDEBAR_FOOTER_SLOT`). All this row owns is the sidebar's
 * row inset and what it says.
 *
 * Renders nothing when nothing needs setup: a reminder with a zero in it is
 * a row of chrome telling you about work that does not exist.
 */
export function IntegrationsSetupReminder({
  count,
  onFinishSetup,
}: {
  /** Integrations across the catalog that need setup — the amber count. */
  count: number;
  /** Send the user to the Connect page to finish them. */
  onFinishSetup(): void;
}) {
  if (count <= 0) return null;

  const said = `${count} ${count === 1 ? 'integration needs' : 'integrations need'} setup.`;

  return (
    <button
      type="button"
      onClick={onFinishSetup}
      // The whole line, including the tail the ellipsis is about to eat. A
      // sidebar dragged down to 180px cannot hold this sentence, and
      // `truncate` cuts from the END — the count leads the line and survives;
      // "setup." is what goes. The tooltip is where the sentence is still
      // readable whole at that width.
      title={`${said} Finish now`}
      className={cn(
        'flex items-center gap-1 rounded-sm py-1.5 text-left text-meta text-ink-faint transition-colors hover:text-ink',
        SIDEBAR_ROW_INSET,
      )}
    >
      {/* The ellipsis goes on the TEXT, and only on the text: the row is a
          flex container, which clips its children without ever drawing one.
          `min-w-0` is what lets this half shrink at all — a flex item's
          automatic minimum is its content, so without it the sentence pushes
          the link off the row instead of truncating. */}
      <span className="min-w-0 truncate">{said}</span>
      {/* Never truncated. The count is the detail; "Finish now" is the way
          out of the situation it describes, and a reminder that ellipses away
          its own call to action is a row that does nothing. */}
      <span className="flex-none underline underline-offset-2">Finish now</span>
    </button>
  );
}
