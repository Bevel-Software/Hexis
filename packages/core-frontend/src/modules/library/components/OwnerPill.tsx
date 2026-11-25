import { Badge } from '../../../shared/components';
import { VERB_HELP } from '../../access';

/**
 * What Owner lets someone do on a plugin: the general line, plus deleting it,
 * which only an owner of the plugin may do (`DELETE /api/plugins/:name` asks
 * the `owner:` lists alone). Eight words or fewer, like the verb lines.
 */
const PLUGIN_OWNER_HELP = 'Edit, download, delete it, and be its contact';

/**
 * The Library's Owner pill: the reader is named in the item's `owner:` grant.
 * One component for the cards, the plugin rows and the skill page. It carries
 * what Owner means as its tooltip and accessible description.
 *
 * Inside a card or a row the pill is part of a button, whose children
 * assistive tech does not describe. There the caller passes `lineId` and
 * points the button's `aria-describedby` at it: the line is rendered once
 * more, hidden, under that id.
 */
export function OwnerPill({ lineId, plugin = false }: { lineId?: string; plugin?: boolean }) {
  const line = plugin ? PLUGIN_OWNER_HELP : VERB_HELP.owner;
  return (
    <>
      <Badge
        tone="outline"
        size="xs"
        className="shrink-0 uppercase"
        title={line}
        aria-description={line}
      >
        Owner
      </Badge>
      {lineId && (
        <span id={lineId} hidden>
          {line}
        </span>
      )}
    </>
  );
}
