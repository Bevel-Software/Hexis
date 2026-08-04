import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button } from '../../../shared/components';
import { attentionOf, useLibrary, type LibraryItem } from '../state/library-data';
import {
  decodeGroupSegment,
  pathForGroupsIndex,
  pathForPropose,
  pathForTool,
} from '../routes/library-paths';
import { primaryFolderOf } from '../utils/group-summary';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { DetailDialog, type DetailTarget } from './DetailDialog';
import { AddToGroupDialog } from './AddToGroupDialog';
import { GroupBreadcrumb, GroupItemSections, PageNote, ShareGlyph } from './group-page-parts';

/**
 * One group, as a place: `/skills-and-tools/groups/:group`.
 *
 * A group is a KB folder, so this page is the folder made legible — its skills
 * and the tools those skills need, side by side, with who runs it and who it is
 * shared with in one line above them. The sidebar and the gallery could already
 * FILTER to a group; what they could not do is be linked to, bookmarked, or
 * handed to somebody. That is the whole difference this page makes.
 *
 * Fail-closed like the rest of the platform: a group the caller cannot access
 * never reaches this page's data (the groups endpoint omits it and the catalog
 * has none of its items), so an inaccessible group renders exactly like one
 * that does not exist.
 */
export function GroupPage() {
  const params = useParams();
  const group = decodeGroupSegment(params.group ?? '');
  const data = useLibrary();
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  /** Repo-relative folder whose `access.md` the Manage-access dialog is on. */
  const [manageFolder, setManageFolder] = useState<string | null>(null);

  const summary = useMemo(
    () => data.groupSummaries.find((g) => g.name === group) ?? null,
    [data.groupSummaries, group],
  );
  const groupItems = useMemo(
    () => data.items.filter((i) => i.group === group),
    [data.items, group],
  );

  const skillItems = groupItems.filter((i) => i.kind === 'skill');
  const toolItems = groupItems.filter((i) => i.kind === 'integration');
  const attention = attentionOf(data.items, group);

  /**
   * Same split as the gallery: a tool opens its PAGE, a skill still opens the
   * dialog. Kept identical to `LibraryPage.openItem` on purpose — a card must
   * do the same thing wherever you clicked it.
   *
   * CONTRACT (Ali): when `skills/:name` lands, the second half becomes
   * `navigate(pathForSkill(item.id))` and the dialog below goes away.
   */
  function openItem(item: LibraryItem) {
    if (item.kind === 'integration') {
      navigate(pathForTool(item.id));
      return;
    }
    const skill = data.skills.find((s) => s.name === item.id);
    if (skill) setDetail({ kind: 'skill', skill, owned: item.owned });
  }

  /**
   * THE access surface — one dialog, two openers: the title row's `Share` and
   * the Manage-access affordances. There is deliberately no read-only sibling:
   * the dialog itself degrades to read-only when the resolved verdict says the
   * caller cannot write, so a second "view access" panel would be the same
   * information twice.
   *
   * `kbDirName` gates it because the resolver addresses files repo-relative and
   * the dialog strips that prefix — without it the path we would hand over is
   * not the path we mean. Same guard the skill dialog uses.
   */
  const manageDialog =
    manageFolder && kbDirName ? (
      <ManageAccessDialog
        entry={{
          name: manageFolder.split('/').pop() ?? manageFolder,
          relativePath: `${kbDirName}/${manageFolder}`,
          type: 'directory',
        }}
        onClose={() => {
          setManageFolder(null);
          data.reloadGroups();
        }}
      />
    ) : null;

  // Nothing has spoken yet: the catalog is still loading, the group index is
  // still loading, and no item has proven the group exists. Deciding now would
  // flash "doesn't exist" at somebody who is simply early.
  if (groupItems.length === 0 && (data.loading || data.groupsLoading)) {
    return <PageNote>Loading the library…</PageNote>;
  }

  // No summary, no items, and the endpoint did NOT fail — the group really is
  // not there. With a failed endpoint the honest answer is the degraded member
  // view below, because "we couldn't ask" is not "it doesn't exist".
  if (!summary && groupItems.length === 0 && !data.groupsError) {
    return (
      <div className="py-16 text-center">
        <p className="text-ui text-ink-faint">{"This group doesn't exist yet."}</p>
        <Link
          to={pathForGroupsIndex()}
          className="mt-2 inline-block rounded-xs text-ui font-semibold text-ink underline"
        >
          All groups
        </Link>
      </div>
    );
  }

  const primaryFolder = summary ? primaryFolderOf(summary) : null;

  return (
    <div className="pb-14">
      <GroupBreadcrumb name={group} />

      {/* The title row carries the page's one persistent action. `Share` IS
          the manage-access dialog — not a doorway to it. It stays un-gated:
          for a non-writer the dialog renders read-only (its own `canWrite`
          verdict decides), which is exactly what "who is this shared with?"
          should answer. Hidden only when no folder is known to manage. */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="mt-1.5 text-display font-semibold">{group}</h1>
        {primaryFolder && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1.5 shrink-0"
            onClick={() => setManageFolder(primaryFolder)}
          >
            <ShareGlyph className="size-3.5" />
            Share
          </Button>
        )}
      </div>

      {attention > 0 && (
        <Banner role="status" tone="wait" className="mt-4">
          <span>
            {`${attention} ${
              attention === 1 ? 'integration needs' : 'integrations need'
            } setup — connect them to unblock this group's skills.`}
          </span>{' '}
          <Button variant="outline" size="tiny" onClick={() => navigate('/connect')}>
            Finish setup
          </Button>
        </Banner>
      )}

      {/* Exactly one action, and it is the honest one. `canWrite` unknown (no
          summary) falls to Propose: claiming write access we could not verify
          would send somebody into a dialog whose button 403s. */}
      <div className="mt-4">
        {summary?.canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
            Add skills or tools
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => navigate(pathForPropose(group))}>
            Propose a skill or tool
          </Button>
        )}
      </div>

      <GroupItemSections
        skillItems={skillItems}
        toolItems={toolItems}
        onOpen={openItem}
        emptySkills={`No skills yet. Add one, or ask your agent to write one for ${group}.`}
      />

      {addOpen && summary && primaryFolder && (
        <AddToGroupDialog
          name={group}
          primaryPath={primaryFolder}
          onClose={() => setAddOpen(false)}
        />
      )}

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

      {manageDialog}
    </div>
  );
}




