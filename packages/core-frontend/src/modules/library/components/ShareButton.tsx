import { Users } from 'lucide-react';
import { Button } from '../../../shared/components';

/**
 * The Library's Share button: bounded, because it is the one action beside a
 * title with a consequence for other people. It IS the manage-access dialog —
 * not a doorway to it — for a plugin (`PageActions`) and a skill alike, so the
 * two pages cannot drift into two looks for the same verb.
 */
export function ShareButton({ onClick }: { onClick(): void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Users size={13} />
      Share
    </Button>
  );
}
