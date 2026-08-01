import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/state/auth.context';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { pathForTool } from '../routes/library-paths';
import { personalGroupName } from '../utils/personal-group';
import { DetailDialog, type DetailTarget } from './DetailDialog';
import { GroupBreadcrumb, GroupItemSections, PageNote } from './group-page-parts';

/**
 * A person's own space, as a group: `/skills-and-tools/yours`.
 *
 * These are the items in NO group folder — the sign-ins that are yours alone
 * and the skills no group has adopted. They were a filtered gallery ("Yours
 * alone", a heading and a flat grid); now they get the same page every group
 * gets, because from where you stand it is the same kind of thing: a place
 * with your skills and your tools in it.
 *
 * What it does NOT have, and why:
 *  - no Share. There is no folder behind this page, so there is no `access.md`
 *    to show — its members are "you", by construction, and a Share button
 *    would promise an editor that has nothing to edit.
 *  - no Add. Adding here means creating a skill outside every group, which is
 *    what the agent already does when it writes one; there is no folder for a
 *    dialog to write into.
 */
export function PersonalGroupPage() {
  const data = useLibrary();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const name = personalGroupName(user?.name);
  const items = useMemo(() => data.items.filter((i) => i.group === null), [data.items]);
  const skillItems = items.filter((i) => i.kind === 'skill');
  const toolItems = items.filter((i) => i.kind === 'integration');

  /** Identical to the gallery's and the group page's — one behaviour per card. */
  function openItem(item: LibraryItem) {
    if (item.kind === 'integration') {
      navigate(pathForTool(item.id));
      return;
    }
    const skill = data.skills.find((s) => s.name === item.id);
    if (skill) setDetail({ kind: 'skill', skill, owned: item.owned });
  }

  if (items.length === 0 && data.loading) {
    return <PageNote>Loading the library…</PageNote>;
  }

  return (
    <div className="pb-14">
      <GroupBreadcrumb name={name} />

      <h1 className="mt-1.5 text-display font-semibold">{name}</h1>
      <p className="mt-1 text-ui text-ink-muted">
        Your sign-ins, and the skills no group carries. Only you see this.
      </p>

      <GroupItemSections
        skillItems={skillItems}
        toolItems={toolItems}
        onOpen={openItem}
        emptySkills="No skills of your own yet. Anything your agent writes outside a group lands here."
        emptyTools="No sign-ins of your own yet."
      />

      {detail && (
        <DetailDialog
          target={detail}
          tools={data.tools}
          skills={data.skills}
          allowedToolsBySkill={data.allowedToolsBySkill}
          crs={data.crs}
          myCrNumbers={data.myCrNumbers}
          onClose={() => setDetail(null)}
          onDataChanged={data.reload}
        />
      )}
    </div>
  );
}
