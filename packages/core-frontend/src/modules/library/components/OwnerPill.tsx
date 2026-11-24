import { Badge } from '../../../shared/components';
import { VERB_HELP } from '../../access';

/**
 * The Library's Owner pill: the reader is named in the item's `owner:` grant.
 * One component for the cards, the plugin rows and the skill page, so all
 * three say what Owner means, as its tooltip and accessible description.
 */
export function OwnerPill() {
  return (
    <Badge
      tone="outline"
      size="xs"
      className="shrink-0 uppercase"
      title={VERB_HELP.owner}
      aria-description={VERB_HELP.owner}
    >
      Owner
    </Badge>
  );
}
