import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/state/auth.context';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { pathForSkill, pathForTool } from '../routes/library-paths';
import { personalGroupName } from '../utils/personal-group';
import { GroupBreadcrumb, GroupItemSections, PageNote } from './group-page-parts';
import { PageActions } from './PageActions';
import { PersonalAddDialog } from './PersonalAddDialog';
import { copyToClipboard } from '../utils/clipboard';

/**
 * A person's own space, as a group: `/skills-and-tools/yours`.
 *
 * These are the items in NO group folder — the sign-ins that are yours alone
 * and the skills no group has adopted. They were a filtered gallery ("Yours
 * alone", a heading and a flat grid); now they get the same page every group
 * gets, because from where you stand it is the same kind of thing: a place
 * with your skills and your tools in it.
 *
 * It carries the same actions every group page carries, because it is the same
 * kind of thing — with ONE exception, and it is a real one rather than a
 * decision:
 *
 *  - no Share. Every other action here is a client-side affordance, but sharing
 *    needs a folder to write an `access.md` into, and this page is defined as
 *    the items in NO folder. There is nothing to point the dialog at. The
 *    prototype can share its personal list because there it is a real space
 *    record (`mine:<uid>`, proto:2265); the platform has no such object, and a
 *    Share button that opens an editor over nothing is worse than no button.
 *    Giving a person's own items a home folder is a backend change, and until
 *    that exists this stays absent.
 */
export function PersonalGroupPage() {
  const data = useLibrary();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);

  const name = personalGroupName(user?.name);
  const items = useMemo(() => data.items.filter((i) => i.group === null), [data.items]);
  const skillItems = items.filter((i) => i.kind === 'skill');
  const toolItems = items.filter((i) => i.kind === 'integration');

  /** Identical to the gallery's and the group page's — one behaviour per card. */
  function openItem(item: LibraryItem) {
    navigate(item.kind === 'integration' ? pathForTool(item.id) : pathForSkill(item.id));
  }

  if (items.length === 0 && data.loading) {
    return <PageNote>Loading the library…</PageNote>;
  }

  return (
    <div className="pb-14">
      <GroupBreadcrumb name={name} />

      {/* The same title row every group page has. The description line that
          used to sit under it is gone: "Only you see this" is what the page's
          own name already says, and a subtitle explaining a heading is the
          heading admitting it did not work (proto: the personal list carries
          no lede). */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="mt-1.5 text-display font-semibold">{name}</h1>
        <div className="mt-1.5">
          <PageActions
            onAdd={() => setAddOpen(true)}
            onCopyLink={() => copyToClipboard(window.location.href)}
            addLabel="Add a skill or tool"
          />
        </div>
      </div>

      <GroupItemSections
        skillItems={skillItems}
        toolItems={toolItems}
        onOpen={openItem}
        emptySkills="No skills of your own yet. Anything your agent writes outside a group lands here."
        emptyTools="No sign-ins of your own yet."
      />

      {addOpen && <PersonalAddDialog name={name} onClose={() => setAddOpen(false)} />}
    </div>
  );
}
