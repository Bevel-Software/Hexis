import { useParams } from 'react-router-dom';
import { decodePluginSegment } from '../routes/library-paths';
import { LibraryPage } from './LibraryPage';

/**
 * `teams/:group` — one team's lens on the catalog. The name comes in RAW
 * from the router and is decoded here, the way the plugin page decodes its
 * own segment; the page then slices the catalog by the server's answer for
 * that team (`TeamAccess`), and says so when there is no such team.
 */
export function TeamRoute() {
  const { group = '' } = useParams<{ group: string }>();
  const name = decodePluginSegment(group);
  return <LibraryPage key={name} filter={{ kind: 'team', group: name }} />;
}
